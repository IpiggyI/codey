use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use crate::error_log;

type InstalledPlugins = HashMap<String, bool>;
type InstalledPluginsCache = HashMap<PathBuf, (Option<Vec<u8>>, InstalledPlugins)>;
type MarketplaceEntriesCache = HashMap<PathBuf, Arc<MarketplaceEntries>>;

static INSTALLED_PLUGINS_CACHE: OnceLock<Mutex<InstalledPluginsCache>> = OnceLock::new();
static MARKETPLACE_ENTRIES_CACHE: OnceLock<Mutex<MarketplaceEntriesCache>> = OnceLock::new();

struct MarketplaceEntries {
    bytes: Vec<u8>,
    entries: Vec<MarketplaceEntry>,
}

struct MarketplaceEntry {
    id: String,
    template: Map<String, Value>,
    manifest_path: PathBuf,
    manifest_bytes: Option<Vec<u8>>,
}

/// Repairs the official/local marketplace registration without touching the
/// Codex installation directory. The core crate owns the platform-specific
/// config format and embedded marketplace snapshot; Codey only exposes a small,
/// renderer-friendly status/list API around it.
pub fn ensure_marketplaces(home: &Path) -> Result<Value> {
    let remote =
        codey_runtime_core::plugin_marketplace::ensure_openai_curated_remote_marketplace_available(
            home,
        )
        .context("初始化 Codey 内置插件市场失败")?;
    let curated_changed =
        codey_runtime_core::plugin_marketplace::ensure_openai_curated_marketplace_config(home)
            .context("迁移插件市场兼容配置失败")?;
    let role_changed =
        codey_runtime_core::plugin_marketplace::ensure_role_specific_plugins_marketplace_config(
            home,
        )
        .context("注册本地工具插件市场失败")?;
    let official = codey_runtime_core::plugin_marketplace::openai_curated_marketplace_status(home);
    let remote_status =
        codey_runtime_core::plugin_marketplace::openai_curated_remote_marketplace_status(home);
    Ok(json!({
        "officialMarketplace": official.marketplace_root.is_some(),
        "officialPath": official.marketplace_root,
        "remoteMarketplace": remote_status.marketplace_root.is_some(),
        "remoteRegistered": remote_status.config_registered,
        "remotePath": remote_status.marketplace_root,
        "managedConfigCompatible": official.config_registered,
        "initializedRemote": remote.initialized,
        "configuredRemote": remote.configured,
        "configChanged": remote.configured || curated_changed || role_changed,
    }))
}

/// Reads marketplace availability and registration without creating files or
/// changing Codex configuration. Repairs are deliberately kept in
/// `ensure_marketplaces` so opening Codey settings remains side-effect free.
pub fn marketplaces_status(home: &Path) -> Value {
    let official = codey_runtime_core::plugin_marketplace::openai_curated_marketplace_status(home);
    let remote =
        codey_runtime_core::plugin_marketplace::openai_curated_remote_marketplace_status(home);
    let official_marketplace = official.marketplace_root.is_some();
    let remote_marketplace = remote.marketplace_root.is_some();
    let managed_config_compatible = official.config_registered;
    let needs_repair =
        !remote_marketplace || !remote.config_registered || !managed_config_compatible;
    json!({
        "officialMarketplace": official_marketplace,
        "officialPath": official.marketplace_root,
        "remoteMarketplace": remote_marketplace,
        "remoteRegistered": remote.config_registered,
        "remotePath": remote.marketplace_root,
        "managedConfigCompatible": managed_config_compatible,
        "needsRepair": needs_repair,
        "computerUse": crate::computer_use::status(home, &crate::computer_use::data_root()),
    })
}

pub fn list_plugins(home: &Path) -> Result<Value> {
    list_plugins_from_paths(home, marketplace_paths(home))
}

fn list_plugins_from_paths(home: &Path, paths: impl IntoIterator<Item = PathBuf>) -> Result<Value> {
    let installed = installed_plugins(home)?;
    let mut plugins = Vec::new();
    for path in paths {
        if let Some(marketplace) = marketplace_entries(home, &path) {
            plugins.extend(marketplace.entries.iter().map(|entry| {
                let mut object = entry.template.clone();
                object["installed"] = Value::Bool(installed.contains_key(&entry.id));
                object["enabled"] = Value::Bool(installed.get(&entry.id).copied().unwrap_or(false));
                Value::Object(object)
            }));
        }
    }
    let count = plugins.len();
    Ok(json!({"plugins": plugins, "count": count}))
}

fn marketplace_entries(home: &Path, marketplace_path: &Path) -> Option<Arc<MarketplaceEntries>> {
    let bytes = match fs::read(marketplace_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            error_log::record_failure(
                "patch_status_failed",
                "read_plugin_marketplace_file",
                // 去重只看错误文本，带上路径才不会吞掉其他文件的同类错误。
                format!("{}: {error}", marketplace_path.display()),
                serde_json::json!({
                    "path": marketplace_path,
                }),
            );
            return None;
        }
    };
    let cache = MARKETPLACE_ENTRIES_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache
        .lock()
        .ok()
        .and_then(|guard| guard.get(marketplace_path).cloned());
    if let Some(cached) = cached
        && cached.bytes == bytes
        && cached
            .entries
            .iter()
            .all(|entry| fs::read(&entry.manifest_path).ok() == entry.manifest_bytes)
    {
        return Some(cached);
    }
    let mut marketplace = match serde_json::from_slice::<Value>(&bytes) {
        Ok(marketplace) => marketplace,
        Err(error) => {
            error_log::record_failure(
                "patch_status_failed",
                "parse_plugin_marketplace_file",
                format!("{}: {error}", marketplace_path.display()),
                serde_json::json!({
                    "path": marketplace_path,
                }),
            );
            return None;
        }
    };
    let marketplace_name = marketplace
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("local")
        .to_string();
    let root = marketplace_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".tmp").join("plugins"));
    let entries = marketplace
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)?;
    let mut parsed_entries = Vec::with_capacity(entries.len());
    for entry in entries {
        let Value::Object(mut object) = entry else {
            continue;
        };
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                object
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| id.split('@').next())
            })
            .unwrap_or_default()
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let plugin_root = root.join("plugins").join(&name);
        let id = format!("{name}@{marketplace_name}");
        object.insert("name".into(), Value::String(name.clone()));
        object.insert("id".into(), Value::String(id.clone()));
        object.insert(
            "marketplaceName".into(),
            Value::String(marketplace_name.clone()),
        );
        object.insert(
            "marketplacePath".into(),
            Value::String(marketplace_path.to_string_lossy().to_string()),
        );
        object.insert(
            "localPath".into(),
            Value::String(plugin_root.to_string_lossy().to_string()),
        );
        object.insert("installed".into(), Value::Bool(false));
        object.insert("enabled".into(), Value::Bool(false));
        let manifest_path = plugin_root.join(".codex-plugin/plugin.json");
        let manifest_bytes = fs::read(&manifest_path).ok();
        if let Some(bytes) = &manifest_bytes {
            merge_manifest(&mut object, bytes);
        }
        parsed_entries.push(MarketplaceEntry {
            id,
            template: object,
            manifest_path,
            manifest_bytes,
        });
    }
    let marketplace = Arc::new(MarketplaceEntries {
        bytes,
        entries: parsed_entries,
    });
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= 32 && !guard.contains_key(marketplace_path) {
            guard.clear();
        }
        guard.insert(marketplace_path.to_path_buf(), Arc::clone(&marketplace));
    }
    Some(marketplace)
}

fn marketplace_paths(home: &Path) -> [PathBuf; 5] {
    [
        home.join(".tmp/plugins/.agents/plugins/marketplace.json"),
        home.join(".tmp/plugins/.agents/plugins/api_marketplace.json"),
        home.join(".tmp/plugins-remote/.agents/plugins/marketplace.json"),
        home.join(".tmp/marketplaces/role-specific-plugins/.agents/plugins/marketplace.json"),
        crate::computer_use::marketplace_path(&crate::computer_use::data_root()),
    ]
}

fn merge_manifest(plugin: &mut Map<String, Value>, bytes: &[u8]) {
    let Ok(manifest) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    let Some(manifest) = manifest.as_object() else {
        return;
    };
    for key in [
        "displayName",
        "description",
        "keywords",
        "interface",
        "logoPath",
        "composerIconPath",
    ] {
        if let Some(value) = manifest.get(key) {
            plugin
                .entry(key.to_string())
                .or_insert_with(|| value.clone());
        }
    }
}

fn installed_plugins(home: &Path) -> Result<InstalledPlugins> {
    let config_bytes = match fs::read(home.join("config.toml")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    };
    let cache = INSTALLED_PLUGINS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(bytes) = &config_bytes
        && let Ok(guard) = cache.lock()
        && let Some((cached_bytes, installed)) = guard.get(home)
        && cached_bytes == bytes
    {
        return Ok(installed.clone());
    }
    let snapshot = codey_runtime_core::config_manager::ConfigManager::for_home(home)
        .load()
        .context("读取插件安装配置失败")?;
    let table = snapshot
        .document()
        .get("plugins")
        .and_then(|item| item.as_table_like());
    let installed: InstalledPlugins = table
        .into_iter()
        .flat_map(|table| table.iter())
        .map(|(key, item)| {
            let enabled = item
                .as_table_like()
                .and_then(|table| table.get("enabled"))
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            (key.to_string(), enabled)
        })
        .collect();
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= 16 && !guard.contains_key(home) {
            guard.clear();
        }
        guard.insert(
            home.to_path_buf(),
            (
                snapshot.exists().then(|| snapshot.raw().to_vec()),
                installed.clone(),
            ),
        );
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_marketplace_cache_invalidates_for_marketplace_config_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex");
        fs::create_dir(&home).unwrap();
        let marketplace = crate::computer_use::marketplace_path(temp.path());
        let root = marketplace.ancestors().nth(3).unwrap();
        let manifest = root.join("plugins/desktop/.codex-plugin/plugin.json");
        fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        let write_market = |name| {
            fs::write(
                &marketplace,
                json!({"name": name, "plugins": [{"name": "desktop"}]}).to_string(),
            )
            .unwrap();
        };
        let list = || list_plugins_from_paths(&home, [marketplace.clone()]).unwrap();
        write_market("first");
        fs::write(&manifest, r#"{"displayName":"Original"}"#).unwrap();
        let first = marketplace_entries(&home, &marketplace).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &marketplace_entries(&home, &marketplace).unwrap()
        ));
        assert_eq!(list()["plugins"][0]["displayName"], "Original");
        assert_eq!(list()["plugins"][0]["installed"], false);

        fs::write(
            home.join("config.toml"),
            "[plugins.\"desktop@first\"]\nenabled = true\n",
        )
        .unwrap();
        assert_eq!(list()["plugins"][0]["enabled"], true);
        fs::write(&manifest, r#"{"displayName":"Modified"}"#).unwrap();
        assert_eq!(list()["plugins"][0]["displayName"], "Modified");
        fs::remove_file(manifest).unwrap();
        assert!(list()["plugins"][0].get("displayName").is_none());
        write_market("other");
        assert_eq!(list()["plugins"][0]["id"], "desktop@other");
        assert_eq!(list()["plugins"][0]["installed"], false);
    }

    #[test]
    fn disabled_plugins_remain_installed_and_report_disabled() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_marketplace(home, "plugins-remote", "test-market", "test-plugin");
        fs::write(
            home.join("config.toml"),
            "[plugins.\"test-plugin@test-market\"]\nenabled = false\n",
        )
        .unwrap();
        let result = list_plugins(home).unwrap();
        let plugin = result["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plugin| plugin["id"] == "test-plugin@test-market")
            .unwrap();
        assert_eq!(plugin["installed"], true);
        assert_eq!(plugin["enabled"], false);
        fs::write(home.join("config.toml"), "").unwrap();
        assert!(
            !installed_plugins(home)
                .unwrap()
                .contains_key("test-plugin@test-market")
        );
    }

    #[test]
    fn invalid_installation_config_returns_error_instead_of_empty_plugins() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("config.toml"), "[broken").unwrap();
        assert!(list_plugins(temp.path()).is_err());
    }

    fn write_marketplace(home: &Path, directory: &str, name: &str, plugin: &str) {
        let root = home.join(".tmp").join(directory);
        fs::create_dir_all(root.join(".agents").join("plugins")).unwrap();
        let manifest_dir = root.join("plugins").join(plugin).join(".codex-plugin");
        fs::create_dir_all(&manifest_dir).unwrap();
        fs::write(
            manifest_dir.join("plugin.json"),
            json!({"name": plugin}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join(".agents")
                .join("plugins")
                .join("marketplace.json"),
            serde_json::to_vec(&json!({
                "name": name,
                "plugins": [{"name": plugin, "path": format!("./plugins/{plugin}")}],
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn marketplace_status_is_read_only_when_repair_is_needed() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let config_path = home.join("config.toml");
        let original = b"model_provider = \"openai\"\n";
        fs::write(&config_path, original).unwrap();

        let status = marketplaces_status(home);

        assert_eq!(status["needsRepair"], true);
        assert_eq!(status["officialMarketplace"], false);
        assert_eq!(status["remoteMarketplace"], false);
        assert_eq!(fs::read(&config_path).unwrap(), original);
        assert!(!home.join(".tmp").exists());
    }

    #[test]
    fn marketplace_repair_installs_the_embedded_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();

        let repair = ensure_marketplaces(home).unwrap();
        let status = marketplaces_status(home);

        assert_eq!(repair["initializedRemote"], true);
        assert_eq!(repair["configuredRemote"], true);
        assert_eq!(status["officialMarketplace"], false);
        assert_eq!(status["remoteMarketplace"], true);
        assert_eq!(status["remoteRegistered"], true);
        assert_eq!(status["managedConfigCompatible"], true);
        assert_eq!(status["needsRepair"], false);
    }

    #[test]
    fn marketplace_repair_replaces_managed_reserved_entries() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let official_root = home.join(".tmp").join("plugins");
        let remote_root = home.join(".tmp").join("plugins-remote");
        fs::write(
            home.join("config.toml"),
            format!(
                r#"model = "gpt-5"

[marketplaces.openai-curated]
source_type = "local"
source = {}

[marketplaces.openai-api-curated]
source_type = "local"
source = {}

[marketplaces.openai-curated-remote]
source_type = "local"
source = {}
"#,
                toml_edit::value(format!(r"\\?\{}", official_root.display())),
                toml_edit::value(format!(r"\\?\{}", official_root.display())),
                toml_edit::value(format!(r"\\?\{}", remote_root.display())),
            ),
        )
        .unwrap();

        let repair = ensure_marketplaces(home).unwrap();
        let status = marketplaces_status(home);
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        let parsed = config.parse::<toml_edit::DocumentMut>().unwrap();
        let marketplaces = parsed["marketplaces"].as_table().unwrap();

        assert_eq!(repair["initializedRemote"], true);
        assert!(marketplaces.get("openai-curated").is_none());
        assert!(marketplaces.get("openai-api-curated").is_none());
        assert!(marketplaces.get("openai-curated-remote").is_none());
        assert_eq!(
            marketplaces["codey-curated"]["source"].as_str(),
            Some(
                if cfg!(windows) {
                    format!(r"\\?\{}", remote_root.display())
                } else {
                    remote_root.to_string_lossy().into_owned()
                }
                .as_str()
            )
        );
        assert_eq!(parsed["model"].as_str(), Some("gpt-5"));
        assert_eq!(status["needsRepair"], false);
    }

    #[test]
    fn marketplace_status_repairs_cached_remote_registration() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_marketplace(
            home,
            "plugins-remote",
            "openai-curated-remote",
            "product-design",
        );

        let before = marketplaces_status(home);
        let repair = ensure_marketplaces(home).unwrap();
        let after = marketplaces_status(home);

        assert_eq!(before["remoteMarketplace"], true);
        assert_eq!(before["remoteRegistered"], false);
        assert_eq!(before["needsRepair"], true);
        assert_eq!(repair["configuredRemote"], true);
        assert_eq!(after["remoteRegistered"], true);
        assert_eq!(after["managedConfigCompatible"], true);
        assert_eq!(after["needsRepair"], false);
    }
}
