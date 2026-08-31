use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::fs_util::atomic_write_private_with_parent as atomic_write;
use crate::model_id;

pub(crate) const LEGACY_CODEX_CATALOG_RELATIVE_PATH: &str = "model-catalogs/codey-official.json";
pub(crate) const DERIVED_CATALOG_FILE_NAME: &str = "codey-derived.json";

#[derive(Debug)]
pub(crate) struct CatalogSnapshot {
    path: PathBuf,
    contents: Option<Vec<u8>>,
}

pub(crate) fn derived_catalog_path(catalog_dir: &Path) -> PathBuf {
    catalog_dir.join(DERIVED_CATALOG_FILE_NAME)
}

pub(crate) fn legacy_codex_catalog_path(codex_home: &Path) -> PathBuf {
    codex_home.join(LEGACY_CODEX_CATALOG_RELATIVE_PATH)
}

pub(crate) fn paths_refer_to_same_catalog(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

pub(crate) fn is_codey_owned_model_catalog_path(
    path: &str,
    codex_home: &Path,
    catalog_dir: &Path,
) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let normalized = normalize_path(Path::new(trimmed));
    let legacy_relative = normalize_path(Path::new(LEGACY_CODEX_CATALOG_RELATIVE_PATH));
    let legacy_absolute = normalize_path(&legacy_codex_catalog_path(codex_home));
    let derived_absolute = normalize_path(&derived_catalog_path(catalog_dir));
    normalized == legacy_relative
        || normalized == legacy_absolute
        || normalized.ends_with(&format!("/{legacy_relative}"))
        || normalized == derived_absolute
}

pub(crate) fn snapshot(catalog_dir: &Path) -> Result<CatalogSnapshot> {
    let path = derived_catalog_path(catalog_dir);
    let contents = match fs::read(&path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("读取现有 Codey 模型目录失败：{}", path.display()));
        }
    };
    Ok(CatalogSnapshot { path, contents })
}

pub(crate) fn restore_snapshot(snapshot: CatalogSnapshot) -> Result<()> {
    match snapshot.contents {
        Some(contents) => atomic_write(&snapshot.path, &contents),
        None => match fs::remove_file(&snapshot.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| {
                format!("移除新建的 Codey 模型目录失败：{}", snapshot.path.display())
            }),
        },
    }
}

pub(crate) fn migrate_legacy_catalog_if_needed(
    codex_home: &Path,
    catalog_dir: &Path,
) -> Result<bool> {
    let derived = derived_catalog_path(catalog_dir);
    if derived.exists() {
        return Ok(false);
    }
    let legacy = legacy_codex_catalog_path(codex_home);
    let bytes = match fs::read(&legacy) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("读取旧版 Codey 模型目录失败：{}", legacy.display()));
        }
    };
    atomic_write(&derived, &bytes)?;
    Ok(true)
}

pub(crate) fn load_user_catalog(path: &Path) -> Result<Value> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            bail!("用户模型目录不存在：{}", path.display());
        }
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            bail!("没有权限读取用户模型目录：{}", path.display());
        }
        Err(error) => {
            return Err(error).with_context(|| format!("读取用户模型目录失败：{}", path.display()));
        }
    };
    let value: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("用户模型目录不是合法 JSON：{}", path.display()))?;
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        bail!("用户模型目录缺少 models 数组：{}", path.display());
    };
    if models.iter().any(|model| !model.is_object()) {
        bail!("用户模型目录含有无效模型条目：{}", path.display());
    }
    Ok(value)
}

pub(crate) fn merge_user_catalog(user: Value, generated_models: &[Value]) -> Value {
    let generated_by_slug = generated_models
        .iter()
        .filter_map(|model| {
            model
                .get("slug")
                .and_then(Value::as_str)
                .map(|slug| (model_id::key(slug), model))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut derived = user;
    let models = derived
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let merged = models
        .into_iter()
        .map(|model| {
            let mut merged = model;
            if let Some(source) = merged
                .get("slug")
                .and_then(Value::as_str)
                .and_then(|slug| generated_by_slug.get(&model_id::key(slug)).copied())
            {
                fill_missing_fields(&mut merged, source);
            }
            merged
        })
        .collect::<Vec<_>>();
    derived["models"] = Value::Array(merged);
    derived
}

pub(crate) fn materialize_derived_catalog(
    catalog_dir: &Path,
    codex_home: &Path,
    generated_models: &[Value],
    user_catalog_path: Option<&Path>,
) -> Result<PathBuf> {
    let catalog = if let Some(user_path) = user_catalog_path {
        let user = load_user_catalog(user_path)?;
        merge_user_catalog(user, generated_models)
    } else {
        json!({ "models": generated_models })
    };
    let path = write_derived_catalog(catalog_dir, &catalog)?;
    remove_legacy_codex_catalog(codex_home)?;
    Ok(path)
}

pub(crate) fn write_derived_catalog(catalog_dir: &Path, catalog: &Value) -> Result<PathBuf> {
    let mut bytes = serde_json::to_vec_pretty(catalog).context("序列化 Codey 模型目录失败")?;
    bytes.push(b'\n');
    let path = derived_catalog_path(catalog_dir);
    if fs::read(&path).is_ok_and(|current| current == bytes) {
        protect_catalog_file(&path)?;
        gc_stale_derived_copies(catalog_dir, &path)?;
        return Ok(path);
    }
    atomic_write(&path, &bytes)?;
    gc_stale_derived_copies(catalog_dir, &path)?;
    Ok(path)
}

pub(crate) fn read_derived_catalog(catalog_dir: &Path) -> Option<Value> {
    read_catalog_value(&derived_catalog_path(catalog_dir))
}

pub(crate) fn remove_legacy_codex_catalog(codex_home: &Path) -> Result<()> {
    let path = legacy_codex_catalog_path(codex_home);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("移除旧版 Codey 模型目录失败：{}", path.display()))
        }
    }
}

fn fill_missing_fields(target: &mut Value, source: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(source_object) = source.as_object() else {
        return;
    };
    for (key, source_value) in source_object {
        match target_object.get_mut(key) {
            None => {
                target_object.insert(key.clone(), source_value.clone());
            }
            Some(target_value) if target_value.is_object() && source_value.is_object() => {
                fill_missing_fields(target_value, source_value);
            }
            Some(_) => {}
        }
    }
}

fn gc_stale_derived_copies(catalog_dir: &Path, live: &Path) -> Result<()> {
    let entries = match fs::read_dir(catalog_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("枚举 Codey 模型目录失败：{}", catalog_dir.display()));
        }
    };
    for entry in entries {
        let entry =
            entry.with_context(|| format!("枚举 Codey 模型目录失败：{}", catalog_dir.display()))?;
        let path = entry.path();
        if paths_refer_to_same_catalog(&path, live) {
            continue;
        }
        if is_stale_derived_copy(&path) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("清理过期的 Codey 模型目录失败：{}", path.display())
                    });
                }
            }
        }
    }
    Ok(())
}

fn is_stale_derived_copy(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    (name.starts_with("codey-derived")
        && name.ends_with(".json")
        && name != DERIVED_CATALOG_FILE_NAME)
        || (name.starts_with(".codey-derived.json.codey-") && name.ends_with(".tmp"))
}

fn read_catalog_value(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
}

fn protect_catalog_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("保护本地模型目录失败：{}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generated_models() -> Vec<Value> {
        vec![
            json!({
                "slug": "gpt-5.6-sol",
                "display_name": "GPT-5.6-Sol",
                "description": "Codey description",
                "visibility": "list",
                "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]
            }),
            json!({
                "slug": "codey-only",
                "display_name": "Codey Only",
                "description": "Should not appear in a user catalog merge"
            }),
        ]
    }

    #[test]
    fn materialize_writes_the_derived_copy_outside_codex_home() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        let catalog_dir = root.path().join("codey/model-catalogs");
        fs::create_dir_all(&codex_home).unwrap();

        let path =
            materialize_derived_catalog(&catalog_dir, &codex_home, &generated_models(), None)
                .unwrap();

        assert_eq!(path, derived_catalog_path(&catalog_dir));
        assert!(path.is_absolute() || path.exists());
        assert!(!legacy_codex_catalog_path(&codex_home).exists());
        assert!(!codex_home.join("model-catalogs").exists());
        let catalog: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn materialize_keeps_the_user_catalog_bytes_and_fills_missing_fields() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        let catalog_dir = root.path().join("codey/model-catalogs");
        let user_path = root.path().join("user-catalog.json");
        let user_bytes = serde_json::to_vec_pretty(&json!({
            "models": [{
                "slug": "gpt-5.6-sol",
                "display_name": "My Sol"
            }]
        }))
        .unwrap();
        fs::write(&user_path, &user_bytes).unwrap();

        materialize_derived_catalog(
            &catalog_dir,
            &codex_home,
            &generated_models(),
            Some(&user_path),
        )
        .unwrap();

        assert_eq!(fs::read(&user_path).unwrap(), user_bytes);
        let derived: Value =
            serde_json::from_slice(&fs::read(derived_catalog_path(&catalog_dir)).unwrap()).unwrap();
        let model = &derived["models"][0];
        assert_eq!(model["display_name"], "My Sol");
        assert_eq!(model["description"], "Codey description");
        assert_eq!(model["visibility"], "list");
        assert_eq!(derived["models"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn materialize_does_not_write_when_the_user_catalog_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let catalog_dir = root.path().join("codey/model-catalogs");
        let user_path = root.path().join("missing.json");

        let error = materialize_derived_catalog(
            &catalog_dir,
            root.path(),
            &generated_models(),
            Some(&user_path),
        )
        .unwrap_err();

        assert!(error.to_string().contains("用户模型目录不存在"));
        assert!(!derived_catalog_path(&catalog_dir).exists());
    }

    #[test]
    fn materialize_does_not_write_when_the_user_catalog_is_invalid_json() {
        let root = tempfile::tempdir().unwrap();
        let catalog_dir = root.path().join("codey/model-catalogs");
        let user_path = root.path().join("broken.json");
        let user_bytes = b"{ not json ";
        fs::write(&user_path, user_bytes).unwrap();

        let error = materialize_derived_catalog(
            &catalog_dir,
            root.path(),
            &generated_models(),
            Some(&user_path),
        )
        .unwrap_err();

        assert!(error.to_string().contains("不是合法 JSON"));
        assert_eq!(fs::read(&user_path).unwrap(), user_bytes);
        assert!(!derived_catalog_path(&catalog_dir).exists());
    }

    #[cfg(unix)]
    #[test]
    fn materialize_does_not_write_when_the_user_catalog_is_unreadable() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let catalog_dir = root.path().join("codey/model-catalogs");
        let user_path = root.path().join("secret.json");
        let user_bytes = b"{\"models\":[]}\n";
        fs::write(&user_path, user_bytes).unwrap();
        fs::set_permissions(&user_path, fs::Permissions::from_mode(0o000)).unwrap();

        let error = materialize_derived_catalog(
            &catalog_dir,
            root.path(),
            &generated_models(),
            Some(&user_path),
        )
        .unwrap_err();

        fs::set_permissions(&user_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(error.to_string().contains("没有权限读取用户模型目录"));
        assert_eq!(fs::read(&user_path).unwrap(), user_bytes);
        assert!(!derived_catalog_path(&catalog_dir).exists());
    }

    #[test]
    fn materialize_removes_stale_derived_copies_and_the_legacy_codex_file() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        let catalog_dir = root.path().join("codey/model-catalogs");
        let legacy = legacy_codex_catalog_path(&codex_home);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"{\"models\":[]}\n").unwrap();
        fs::create_dir_all(&catalog_dir).unwrap();
        fs::write(catalog_dir.join("codey-derived-old.json"), b"{}\n").unwrap();
        fs::write(
            catalog_dir.join(".codey-derived.json.codey-deadbeef.tmp"),
            b"partial\n",
        )
        .unwrap();

        materialize_derived_catalog(&catalog_dir, &codex_home, &generated_models(), None).unwrap();

        assert!(!legacy.exists());
        assert!(!catalog_dir.join("codey-derived-old.json").exists());
        assert!(
            !catalog_dir
                .join(".codey-derived.json.codey-deadbeef.tmp")
                .exists()
        );
        assert!(derived_catalog_path(&catalog_dir).exists());
    }

    #[test]
    fn migrate_copies_legacy_bytes_before_the_legacy_file_is_removed() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        let catalog_dir = root.path().join("codey/model-catalogs");
        let legacy = legacy_codex_catalog_path(&codex_home);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"{\"models\":[{\"slug\":\"legacy\"}]}\n").unwrap();

        assert!(migrate_legacy_catalog_if_needed(&codex_home, &catalog_dir).unwrap());
        assert_eq!(
            fs::read(derived_catalog_path(&catalog_dir)).unwrap(),
            b"{\"models\":[{\"slug\":\"legacy\"}]}\n"
        );
        assert!(legacy.exists());
    }
}
