use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde_json::{Value, json};
use toml_edit::{DocumentMut, Item};

const MARKETPLACE: &str = "codey-local";
const PLUGIN: &str = "codey-computer-use";
const OWNER: &[u8] = b"Codey managed computer-use plugin v1\n";
const LICENSE: &[u8] = include_bytes!("../../vendor/ComputerUse/LICENSE");
const INFO_PLIST: &[u8] = include_bytes!("../resources/computer-use/Info.plist");
#[cfg(any(target_os = "macos", windows))]
const NATIVE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/computer-use-native"));
#[cfg(not(any(target_os = "macos", windows)))]
const NATIVE: &[u8] = &[];
#[cfg(target_os = "macos")]
const SIGNATURE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/computer-use-signature"));

pub(crate) fn data_root() -> PathBuf {
    crate::config::default_config_path()
        .parent()
        .expect("Codey 配置缺少父目录")
        .to_path_buf()
}

pub(crate) fn marketplace_path(data_root: &Path) -> PathBuf {
    marketplace_root(data_root).join(".agents/plugins/marketplace.json")
}

fn marketplace_root(data_root: &Path) -> PathBuf {
    data_root.join("marketplaces/codey-local")
}

/// 仅由用户显式准备；安装和启用由 Codex 管理。
pub(crate) fn prepare(home: &Path, data_root: &Path) -> Result<bool> {
    ensure!(!NATIVE.is_empty(), "当前平台不支持桌面工具");
    install(home, data_root, NATIVE)
}

pub(crate) fn status(home: &Path, data_root: &Path) -> Value {
    json!({
        "supported": !NATIVE.is_empty(),
        "ready": resources_available(data_root, NATIVE)
            && read_registration(home, &marketplace_root(data_root)).is_ok(),
    })
}

fn resources_available(data_root: &Path, native: &[u8]) -> bool {
    if native.is_empty() {
        return false;
    }
    let root = marketplace_root(data_root);
    if ![data_root, &data_root.join("marketplaces"), &root]
        .iter()
        .all(|path| {
            fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        })
    {
        return false;
    }
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let plugin = root.join("plugins").join(PLUGIN);
    #[cfg(target_os = "macos")]
    let metadata_available = {
        let executable = executable_path(&root, native);
        let contents = executable.parent().unwrap().parent().unwrap();
        [
            (contents.join("Info.plist"), INFO_PLIST),
            (contents.join("_CodeSignature/CodeResources"), SIGNATURE),
        ]
        .iter()
        .all(|(path, bytes)| {
            regular_resource(&root, path) && fs::read(path).is_ok_and(|actual| actual == *bytes)
        })
    };
    #[cfg(not(target_os = "macos"))]
    let metadata_available = true;
    metadata_available
        && [".mcp.json", ".codex-plugin/plugin.json", "LICENSE"]
            .iter()
            .all(|path| regular_resource(&root, &plugin.join(path)))
        && fs::read(root.join(".codey-owner")).is_ok_and(|bytes| bytes == OWNER)
        && regular_resource(&root, &root.join(".codey-owner"))
        && regular_resource(&root, &executable_path(&root, native))
        && fs::read(plugin.join("LICENSE")).is_ok_and(|bytes| bytes == LICENSE)
        && fs::read(executable_path(&root, native)).is_ok_and(|bytes| bytes == native)
        && managed_documents(&root, native)
            .iter()
            .all(|(path, expected)| {
                regular_resource(&root, path)
                    && read_json(path).is_some_and(|actual| actual == *expected)
            })
}

fn regular_resource(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let Ok(meta) = fs::symlink_metadata(&current) else {
            return false;
        };
        if meta.file_type().is_symlink() || (current != path && !meta.is_dir()) {
            return false;
        }
        if current == path && !meta.is_file() {
            return false;
        }
    }
    true
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub(crate) fn runtime_overrides(home: &Path, data_root: &Path) -> Result<Vec<String>> {
    runtime_overrides_for(home, data_root, NATIVE)
}

fn runtime_overrides_for(home: &Path, data_root: &Path, native: &[u8]) -> Result<Vec<String>> {
    if !resources_available(data_root, native) {
        return Ok(Vec::new());
    }
    let root = marketplace_root(data_root).canonicalize()?;
    read_registration(home, &root)?;
    let source = toml_edit::Value::from(root.to_string_lossy().into_owned());
    Ok(vec![
        format!("marketplaces.{MARKETPLACE}.source_type=\"local\""),
        format!("marketplaces.{MARKETPLACE}.source={source}"),
    ])
}

fn read_registration(home: &Path, root: &Path) -> Result<bool> {
    let text = match fs::read_to_string(home.join("config.toml")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let document = text.trim_start_matches('\u{feff}').parse::<DocumentMut>()?;
    registration(&document, root)
}

fn plugin_version(native: &[u8]) -> String {
    format!("1.0.0+{}", &crate::fs_util::sha256_hex(native)[..16])
}

fn executable_path(root: &Path, native: &[u8]) -> PathBuf {
    if cfg!(target_os = "macos") {
        root.join("runtime/Codey Computer Use.app/Contents/MacOS/codey-computer-use")
    } else {
        // Windows 无法替换运行中的文件。旧会话退出前保留旧二进制，新安装使用新哈希。
        root.join("runtime")
            .join(crate::fs_util::sha256_hex(native))
            .join("codey-computer-use.exe")
    }
}

fn registration(doc: &DocumentMut, root: &Path) -> Result<bool> {
    let Some(markets) = doc.get("marketplaces") else {
        return Ok(false);
    };
    let markets = markets
        .as_table_like()
        .context("marketplaces 必须是配置表")?;
    let Some(entry) = markets.get(MARKETPLACE) else {
        return Ok(false);
    };
    let matches = entry.as_table_like().is_some_and(|entry| {
        entry.get("source_type").and_then(Item::as_str) == Some("local")
            && entry
                .get("source")
                .and_then(Item::as_str)
                .is_some_and(|source| {
                    let target = root.to_string_lossy();
                    Path::new(source.strip_prefix(r"\\?\").unwrap_or(source))
                        == Path::new(target.strip_prefix(r"\\?\").unwrap_or(target.as_ref()))
                })
    });
    ensure!(matches, "codey-local 已使用自定义来源，保留现有配置");
    Ok(true)
}

fn install(home: &Path, data_root: &Path, native: &[u8]) -> Result<bool> {
    let root = marketplace_root(data_root);
    // 写入托管资源前先拒绝用户自定义的同名来源。
    read_registration(home, &root)?;
    if let Ok(meta) = fs::symlink_metadata(data_root) {
        ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "Codey 数据目录不能使用符号链接或文件"
        );
    }
    fs::create_dir_all(data_root)?;
    let data_root = data_root
        .canonicalize()
        .context("无法定位 Codey 数据目录")?;
    let root = marketplace_root(&data_root);
    read_registration(home, &root)?;
    private_directory(&data_root, &root)?;
    let lock_path = root.join(".install.lock");
    reject_non_file(&lock_path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let lock = options.open(&lock_path)?;
    FileExt::try_lock_exclusive(&lock).context("Computer Use 插件正在更新，请稍后重试")?;
    let marker = root.join(".codey-owner");
    reject_non_file(&marker)?;
    if marker.exists() {
        ensure!(fs::read(&marker)? == OWNER, "保留非 Codey 管理的插件目录");
    } else {
        ensure!(
            fs::read_dir(&root)?
                .all(|entry| entry.is_ok_and(|entry| entry.file_name() == ".install.lock")),
            "保留非 Codey 管理的插件目录"
        );
        crate::fs_util::atomic_write_private(&marker, OWNER)?;
    }
    let executable = executable_path(&root, native);
    let plugin = root.join("plugins").join(PLUGIN);
    let mut changed = write_managed(&root, &executable, native)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
    }
    if cfg!(target_os = "macos") {
        let contents = executable.parent().unwrap().parent().unwrap();
        changed |= write_managed(&root, &contents.join("Info.plist"), INFO_PLIST)?;
        #[cfg(target_os = "macos")]
        {
            changed |= write_managed(
                &root,
                &contents.join("_CodeSignature/CodeResources"),
                SIGNATURE,
            )?;
        }
    }
    changed |= write_managed(&root, &plugin.join("LICENSE"), LICENSE)?;
    for (path, document) in managed_documents(&root, native) {
        changed |= write_managed(&root, &path, &serde_json::to_vec_pretty(&document)?)?;
    }
    FileExt::unlock(&lock).context("释放桌面插件更新锁失败")?;
    Ok(changed)
}

fn managed_documents(root: &Path, native: &[u8]) -> [(PathBuf, Value); 3] {
    let plugin = root.join("plugins").join(PLUGIN);
    let manifest = json!({
        "name": PLUGIN, "version": plugin_version(native),
        "description": "读取桌面应用状态，通过辅助功能完成点击、输入和滚动。",
        "author": {"name": "Codey"}, "license": "MIT",
        "mcpServers": "./.mcp.json",
        "interface": {
            "displayName": "Codey Computer Use",
            "shortDescription": "本地桌面应用操作",
            "longDescription": "读取桌面应用并执行点击、输入和滚动，支持 macOS 14 及以上和 Windows。macOS 需要辅助功能与屏幕录制权限；Windows 依赖系统 Windows PowerShell。",
            "developerName": "Codey", "category": "Productivity",
            "capabilities": ["Read", "Write"],
            "defaultPrompt": ["查看当前运行的应用", "帮我操作桌面应用"]
        }
    });
    let mcp = json!({"mcpServers": {"codey_computer_use": {
        "command": executable_path(root, native), "args": []
    }}});
    let marketplace = json!({
        "name": MARKETPLACE, "interface": {"displayName": "Codey"},
        "plugins": [{"name": PLUGIN,
            "source": {"source": "local", "path": format!("./plugins/{PLUGIN}")},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Productivity"}]
    });
    [
        (plugin.join(".codex-plugin/plugin.json"), manifest),
        (plugin.join(".mcp.json"), mcp),
        (root.join(".agents/plugins/marketplace.json"), marketplace),
    ]
}

fn private_directory(base: &Path, directory: &Path) -> Result<()> {
    let relative = directory.strip_prefix(base)?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        ensure!(
            matches!(component, std::path::Component::Normal(_)),
            "非法插件目录"
        );
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) => ensure!(
                meta.is_dir() && !meta.file_type().is_symlink(),
                "插件目录不能使用符号链接：{}",
                current.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn reject_non_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "插件文件不能使用符号链接或目录：{}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn write_managed(root: &Path, path: &Path, bytes: &[u8]) -> Result<bool> {
    private_directory(root, path.parent().context("插件文件缺少父目录")?)?;
    reject_non_file(path)?;
    if fs::metadata(path).is_ok_and(|meta| meta.len() == bytes.len() as u64)
        && fs::read(path)? == bytes
    {
        return Ok(false);
    }
    crate::fs_util::atomic_write_private(path, bytes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_runtime_registration_do_not_create_resources() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Codex Home");
        let data = temp.path().join("Codey Data");
        assert_eq!(status(&home, &data)["ready"], false);
        assert!(runtime_overrides(&home, &data).unwrap().is_empty());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn explicit_install_preserves_read_only_user_config_auth_and_disabled_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Codex Home");
        let data = temp.path().join("Codey Data");
        fs::create_dir(&home).unwrap();
        let config = b"model = 'user-model'\n[plugins.\"codey-computer-use@codey-local\"]\nenabled = false\n";
        let auth = b"{\"api_key\":\"fixture-secret\"}";
        fs::write(home.join("config.toml"), config).unwrap();
        fs::write(home.join("auth.json"), auth).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(home.join("config.toml"), fs::Permissions::from_mode(0o400))
                .unwrap();
            fs::set_permissions(home.join("auth.json"), fs::Permissions::from_mode(0o400)).unwrap();
        }
        assert!(install(&home, &data, b"native").unwrap());
        assert!(!install(&home, &data, b"native").unwrap());
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), config);
        assert_eq!(fs::read(home.join("auth.json")).unwrap(), auth);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 2);
        assert!(resources_available(&data, b"native"));
        let overrides = runtime_overrides_for(&home, &data, b"native").unwrap();
        assert_eq!(overrides.len(), 2);
        assert!(overrides[0].starts_with("marketplaces.codey-local.source_type="));
        let source: DocumentMut = overrides[1].parse().unwrap();
        assert_eq!(
            Path::new(
                source["marketplaces"][MARKETPLACE]["source"]
                    .as_str()
                    .unwrap()
            ),
            marketplace_root(&data).canonicalize().unwrap()
        );
        assert!(!overrides.join("\n").contains("enabled"));
        assert!(install(&home, &data, b"updated-native").unwrap());
        assert!(resources_available(&data, b"updated-native"));
        assert!(!resources_available(&data, b"native"));
    }

    #[test]
    fn refuses_custom_registration_without_writing_resources() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Codex");
        let data = temp.path().join("Codey");
        fs::create_dir(&home).unwrap();
        let config = b"[marketplaces.codey-local]\nsource_type='local'\nsource='/custom'\n";
        fs::write(home.join("config.toml"), config).unwrap();
        assert!(install(&home, &data, b"native").is_err());
        assert!(!data.exists());
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), config);
    }

    #[test]
    fn competing_preparation_preserves_existing_resources_until_the_lock_is_released() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Codex");
        let data = temp.path().join("Codey");
        install(&home, &data, b"native").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(marketplace_root(&data).join(".install.lock"))
            .unwrap();
        FileExt::try_lock_exclusive(&lock).unwrap();
        assert!(install(&home, &data, b"replacement").is_err());
        assert!(resources_available(&data, b"native"));
        FileExt::unlock(&lock).unwrap();
        assert!(install(&home, &data, b"replacement").unwrap());
        assert!(resources_available(&data, b"replacement"));
    }

    #[test]
    fn refuses_unowned_directory_and_corrupted_prepared_binary() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("Codey");
        let root = marketplace_root(&data);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("user-data"), b"keep").unwrap();
        assert!(install(temp.path(), &data, b"native").is_err());
        assert_eq!(fs::read(root.join("user-data")).unwrap(), b"keep");
        let other = tempfile::tempdir().unwrap();
        install(temp.path(), other.path(), b"native").unwrap();
        fs::write(
            executable_path(&marketplace_root(other.path()), b"native"),
            b"bad",
        )
        .unwrap();
        assert!(!resources_available(other.path(), b"native"));
        assert!(install(temp.path(), other.path(), b"native").unwrap());
        assert!(resources_available(other.path(), b"native"));
    }

    #[test]
    fn modified_manifests_are_not_ready_and_runtime_does_not_register_them() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Codex");
        let data = temp.path().join("Codey");
        install(&home, &data, b"native").unwrap();
        let root = marketplace_root(&data);
        let mcp_path = root.join("plugins").join(PLUGIN).join(".mcp.json");
        let mut mcp = read_json(&mcp_path).unwrap();
        mcp["mcpServers"]["codey_computer_use"]["args"] = json!(["--unmanaged"]);
        fs::write(&mcp_path, serde_json::to_vec(&mcp).unwrap()).unwrap();
        assert!(!resources_available(&data, b"native"));
        assert!(
            runtime_overrides_for(&home, &data, b"native")
                .unwrap()
                .is_empty()
        );
        assert!(install(&home, &data, b"native").unwrap());
        assert!(resources_available(&data, b"native"));
        let manifest_path = root
            .join("plugins")
            .join(PLUGIN)
            .join(".codex-plugin/plugin.json");
        let mut manifest = read_json(&manifest_path).unwrap();
        manifest["mcpServers"] = json!("./other.json");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(!resources_available(&data, b"native"));
        assert!(
            runtime_overrides_for(&home, &data, b"native")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn additional_managed_json_fields_prevent_runtime_registration() {
        for scenario in ["mcp-environment", "extra-plugin", "manifest-skills"] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("Codex");
            let data = temp.path().join("Codey");
            install(&home, &data, b"native").unwrap();
            let root = marketplace_root(&data);
            let plugin = root.join("plugins").join(PLUGIN);
            let path = match scenario {
                "mcp-environment" => plugin.join(".mcp.json"),
                "extra-plugin" => marketplace_path(&data),
                _ => plugin.join(".codex-plugin/plugin.json"),
            };
            let mut document = read_json(&path).unwrap();
            match scenario {
                "mcp-environment" => {
                    document["mcpServers"]["codey_computer_use"]["env"] =
                        json!({"UNMANAGED": "value"});
                }
                "extra-plugin" => document["plugins"].as_array_mut().unwrap().push(json!({
                    "name": "unmanaged",
                    "source": {"source": "local", "path": "./plugins/unmanaged"}
                })),
                _ => document["skills"] = json!("./unmanaged"),
            }
            fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
            assert!(!resources_available(&data, b"native"), "{scenario}");
            assert!(
                runtime_overrides_for(&home, &data, b"native")
                    .unwrap()
                    .is_empty(),
                "{scenario}"
            );
            assert!(install(&home, &data, b"native").unwrap());
            assert!(resources_available(&data, b"native"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_linked_directories_and_files() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let data = temp.path().join("Codey");
        fs::create_dir(&data).unwrap();
        symlink(outside.path(), data.join("marketplaces")).unwrap();
        assert!(install(temp.path(), &data, b"native").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(data.join("marketplaces")).unwrap();
        install(temp.path(), &data, b"native").unwrap();
        let path = marketplace_root(&data)
            .join("plugins")
            .join(PLUGIN)
            .join(".mcp.json");
        fs::remove_file(&path).unwrap();
        let destination = outside.path().join("keep");
        fs::write(&destination, b"keep").unwrap();
        symlink(&destination, &path).unwrap();
        assert!(!resources_available(&data, b"native"));
        assert!(install(temp.path(), &data, b"native").is_err());
        assert_eq!(fs::read(destination).unwrap(), b"keep");
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn unsupported_platform_does_not_prepare_resources() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            status(temp.path(), temp.path()),
            json!({"supported": false, "ready": false})
        );
        assert!(prepare(temp.path(), temp.path()).is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }
    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn native_mcp_handles_invalid_requests_without_desktop_actions() {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        let temp = tempfile::tempdir().unwrap();
        prepare(temp.path(), &temp.path().join("Codey Data")).unwrap();
        assert_eq!(
            status(temp.path(), &temp.path().join("Codey Data"))["ready"],
            true
        );
        let root = marketplace_root(&temp.path().join("Codey Data").canonicalize().unwrap());
        let executable = executable_path(&root, NATIVE);
        #[cfg(target_os = "macos")]
        assert!(
            std::process::Command::new("codesign")
                .args(["--verify", "--strict"])
                .arg(
                    executable
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                )
                .status()
                .unwrap()
                .success()
        );
        let mut child = tokio::process::Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut input = String::new();
        for value in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!([]),
            json!({"jsonrpc":"1.0","id":3,"method":"ping"}),
            json!({"jsonrpc":"2.0","id":4,"method":"unknown"}),
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"unknown"}}),
            json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"click","arguments":{"app":"test.invalid","click_count":true}}}),
            json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"click","arguments":{"app":"test.invalid","click_count":1e30}}}),
            json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"drag","arguments":{"app":"test.invalid"}}}),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"type_text","arguments":{"app":"test.invalid","text":true}}}),
            json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_apps"}}),
        ] {
            input.push_str(&value.to_string());
            input.push('\n');
        }
        input.push_str("not-json\n");
        input.push_str(&"x".repeat(1_052_672));
        input.push('\n');
        input.push_str(&json!({"jsonrpc":"2.0","id":10,"method":"ping"}).to_string());
        let mut stdin = child.stdin.take().unwrap();
        let writer = tokio::spawn(async move {
            stdin.write_all(input.as_bytes()).await.unwrap();
        });
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
                .await
                .expect("MCP server hung on invalid input or EOF")
                .unwrap();
        writer.await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let responses: Vec<serde_json::Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).expect("stdout must contain only JSON-RPC"))
            .collect();
        assert_eq!(
            responses.len(),
            13,
            "notifications must not receive replies"
        );
        let reply = |id| responses.iter().find(|reply| reply["id"] == id).unwrap();
        assert_eq!(reply(1)["result"]["serverInfo"]["name"], PLUGIN);
        let tools = reply(2)["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 9);
        assert!(tools.iter().find(|tool| tool["name"] == "click").unwrap()["annotations"]["destructiveHint"].as_bool().unwrap());
        assert_eq!(reply(4)["error"]["code"], -32601);
        assert_eq!(reply(5)["error"]["code"], -32602);
        for id in 6..=9 {
            assert_eq!(reply(id)["result"]["isError"], true);
        }
        assert!(reply(10)["result"].is_object());
        assert_eq!(
            responses
                .iter()
                .filter(|reply| reply["error"]["code"] == -32700)
                .count(),
            2
        );
        let manifest = root
            .join("plugins")
            .join(PLUGIN)
            .join(".codex-plugin/plugin.json");
        fs::remove_file(manifest).unwrap();
        assert_eq!(
            status(temp.path(), &temp.path().join("Codey Data"))["ready"],
            false
        );
        assert!(prepare(temp.path(), &temp.path().join("Codey Data")).unwrap());
        assert_eq!(
            status(temp.path(), &temp.path().join("Codey Data"))["ready"],
            true
        );
    }
}
