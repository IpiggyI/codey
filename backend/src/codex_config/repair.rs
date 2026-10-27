use super::*;
use toml_edit::TableLike;

pub(crate) fn check_codex_config() -> RepairResult<ConfigRepairReport> {
    check_at(codex_home(), &codey_model_catalog_dir())
}

pub(crate) fn repair_codex_config() -> RepairResult<ConfigRepairReport> {
    repair_at(codex_home(), &lease_marker_path())
}

struct Inspection {
    original: Option<Vec<u8>>,
    replacement: Vec<u8>,
}

fn inspect(home: &Path, catalog_dir: &Path) -> RepairResult<Inspection> {
    let path = home.join("config.toml");
    if !home.is_absolute() {
        return Err(ConfigRepairFailure::new(
            "检查路径",
            &path,
            "CODEX_HOME 必须是绝对路径",
        ));
    }
    for ancestor in home.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(ConfigRepairFailure::new(
                "检查路径",
                &path,
                "配置目录包含符号链接，请手动检查",
            ));
        }
    }
    check_config_file(&path)?;
    let original = read_optional(&path)
        .map_err(|error| safe_error("读取配置", &path, "无法读取配置文件", error))?;
    let bytes = original.as_deref().unwrap_or_default();
    let mut document = parse_safe(bytes, &path)?;
    let mut replacement = bytes.to_vec();
    if document
        .get("model_catalog_json")
        .and_then(Item::as_str)
        .is_some_and(|raw| owned_catalog(raw, home, catalog_dir))
    {
        // 仅删除已确认归属的赋值范围，其余字节和注释原样保留。
        let text = str::from_utf8(bytes).expect("已校验 UTF-8");
        let source = toml_edit::ImDocument::parse(text).expect("已校验 TOML");
        let key = source
            .as_table()
            .key("model_catalog_json")
            .and_then(|key| key.span());
        let item = source.get("model_catalog_json").and_then(Item::span);
        let (Some(key), Some(item)) = (key, item) else {
            return Err(ConfigRepairFailure::new(
                "检查配置",
                &path,
                "无法安全定位 Codey 配置项，已保留原文件",
            ));
        };
        replacement.drain(key.start..item.end);
        document = parse_safe(&replacement, &path)?;
    }
    check_document_references(&document, home)?;
    Ok(Inspection {
        original,
        replacement,
    })
}

fn owned_catalog(raw: &str, home: &Path, catalog_dir: &Path) -> bool {
    let path = Path::new(raw);
    // 不采用旧识别器的任意目录后缀匹配，避免误认用户文件。
    path == Path::new(crate::model_catalog_store::LEGACY_CODEX_CATALOG_RELATIVE_PATH)
        || path == crate::model_catalog_store::legacy_codex_catalog_path(home)
        || path == crate::model_catalog_store::derived_catalog_path(catalog_dir)
}

fn check_at(home: &Path, catalog_dir: &Path) -> RepairResult<ConfigRepairReport> {
    let inspected = inspect(home, catalog_dir)?;
    let message = if inspected.original.is_none() {
        "Codex 配置目录或 config.toml 缺失，可确认后补建"
    } else if inspected.original.as_deref() != Some(inspected.replacement.as_slice()) {
        "发现旧版 Codey 模型目录配置，可确认后移除并改用运行期覆盖"
    } else {
        "未发现可修复的问题"
    };
    Ok(ConfigRepairReport {
        message: message.into(),
        config_path: home.join("config.toml"),
        repaired: false,
        backup_path: None,
    })
}

fn repair_at(home: &Path, marker: &Path) -> RepairResult<ConfigRepairReport> {
    let path = home.join("config.toml");
    let catalog_dir = marker.with_file_name("model-catalogs");
    let inspected = inspect(home, &catalog_dir)?;
    if inspected.original.as_deref() == Some(inspected.replacement.as_slice()) {
        return check_at(home, &catalog_dir);
    }
    let _lock = RuntimeConfigLock::acquire(marker)
        .map_err(|error| safe_error("获取运行时锁", &path, "无法获取配置锁", error))?;
    let backup = backup_original(marker, inspected.original.as_deref())?;
    let result = write_and_verify(home, &inspected);
    if let Err(mut failure) = result {
        if let Some(backup) = &backup {
            failure
                .message
                .push_str(&format!("；原文件备份：{}", backup.display()));
        }
        return Err(failure);
    }
    let mut message = "配置修复完成，请从 Codey 重启 Codex".to_owned();
    if let Some(backup) = &backup {
        message.push_str(&format!("；原文件备份：{}", backup.display()));
    }
    Ok(ConfigRepairReport {
        message,
        config_path: path,
        repaired: true,
        backup_path: backup,
    })
}

fn backup_original(marker: &Path, original: Option<&[u8]>) -> RepairResult<Option<PathBuf>> {
    let Some(bytes) = original else {
        return Ok(None);
    };
    let directory = marker
        .with_file_name("config-repair-backups")
        .join(uuid::Uuid::new_v4().to_string());
    let path = directory.join("config.toml");
    create_private_dir_all(&directory)
        .and_then(|_| restrict_backup_directory(&directory))
        .and_then(|_| write_private_file(&path, bytes))
        .map_err(|error| safe_error("备份配置", &path, "无法创建私有备份，未写入配置", error))?;
    if fs::read(&path).ok().as_deref() != Some(bytes) {
        return Err(ConfigRepairFailure::new(
            "备份配置",
            &path,
            "备份读回不一致，未写入配置",
        ));
    }
    Ok(Some(path))
}

#[cfg(not(windows))]
fn restrict_backup_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn restrict_backup_directory(path: &Path) -> Result<()> {
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", r#"
$ErrorActionPreference = 'Stop'
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:CODEY_CONFIG_BACKUP_DIR -AclObject $acl
"#])
        .env("CODEY_CONFIG_BACKUP_DIR", path)
        .output().context("无法设置备份目录访问权限")?;
    anyhow::ensure!(
        status.status.success(),
        "无法将备份目录限制为当前用户访问，未写入配置"
    );
    Ok(())
}

fn write_and_verify(home: &Path, inspected: &Inspection) -> RepairResult<()> {
    let path = home.join("config.toml");
    check_config_file(&path)?;
    let current = read_optional(&path)
        .map_err(|error| safe_error("检查并发修改", &path, "无法复读配置", error))?;
    if current != inspected.original {
        return Err(ConfigRepairFailure::new(
            "检查并发修改",
            &path,
            "配置已被其他程序修改，请重新检查",
        ));
    }
    atomic_write(&path, &inspected.replacement)
        .map_err(|error| safe_error("写入配置", &path, "原子写入失败", error))?;
    let verified = fs::read(&path).map_err(|error| {
        ConfigRepairFailure::new("读回验证", &path, format!("无法读回配置：{error}"))
    })?;
    if verified != inspected.replacement {
        return Err(ConfigRepairFailure::new(
            "读回验证",
            &path,
            "配置读回不一致",
        ));
    }
    parse_safe(&verified, &path)?;
    Ok(())
}

fn check_provider(table: &dyn TableLike, providers: &[String], home: &Path) -> RepairResult<()> {
    if let Some(provider) = table.get("model_provider").and_then(Item::as_str) {
        let defined = providers.iter().any(|defined| defined == provider);
        if !matches!(provider, "openai" | "ollama" | "lmstudio") && !defined {
            return Err(ConfigRepairFailure::new(
                "检查 provider",
                &home.join("config.toml"),
                "model_provider 引用了不存在的 provider，请手动修正",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigRepairReport {
    pub message: String,
    pub config_path: PathBuf,
    pub repaired: bool,
    pub backup_path: Option<PathBuf>,
}

#[derive(Debug)]
pub(crate) struct ConfigRepairFailure {
    pub stage: &'static str,
    pub path: PathBuf,
    pub message: String,
}

impl ConfigRepairFailure {
    pub(crate) fn new(stage: &'static str, path: &Path, message: impl Into<String>) -> Self {
        Self {
            stage,
            path: path.to_path_buf(),
            message: message.into(),
        }
    }

    pub(crate) fn description(&self) -> String {
        format!(
            "修复 Codex 配置失败（{}）：{}；路径：{}",
            self.stage,
            self.message,
            self.path.display()
        )
    }
}

type RepairResult<T> = std::result::Result<T, ConfigRepairFailure>;

// 解析错误可能包含密钥，只保留文件系统错误原因。
fn safe_error(
    stage: &'static str,
    path: &Path,
    action: &str,
    error: anyhow::Error,
) -> ConfigRepairFailure {
    let detail = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .map(|error| format!("{action}：{error}"))
        .unwrap_or_else(|| format!("{action}；请检查配置内容或重试，原有用户配置未被清空"));
    ConfigRepairFailure::new(stage, path, detail)
}

fn check_config_file(path: &Path) -> RepairResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(ConfigRepairFailure::new(
            "检查路径",
            path,
            "config.toml 是符号链接，自动替换可能改变链接目标，请先手动检查链接",
        )),
        Ok(metadata) if !metadata.is_file() => Err(ConfigRepairFailure::new(
            "检查路径",
            path,
            "config.toml 路径不是普通文件",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigRepairFailure::new(
            "检查路径",
            path,
            format!("无法检查配置路径：{error}"),
        )),
    }
}

fn parse_safe(bytes: &[u8], path: &Path) -> RepairResult<DocumentMut> {
    let text = str::from_utf8(bytes).map_err(|_| {
        ConfigRepairFailure::new(
            "解析配置",
            path,
            "配置不是 UTF-8 文本，已保留原文件，请手动修正编码",
        )
    })?;
    text.parse::<DocumentMut>().map_err(|error| {
        let location = error
            .span()
            .map(|span| {
                format!(
                    "（第 {} 行附近）",
                    bytes[..span.start.min(bytes.len())]
                        .iter()
                        .filter(|byte| **byte == b'\n')
                        .count()
                        + 1
                )
            })
            .unwrap_or_default();
        ConfigRepairFailure::new(
            "解析配置",
            path,
            format!("TOML 语法无效{location}，已保留原文件，请手动修正；不会使用空配置覆盖"),
        )
    })
}

#[derive(Clone, Copy)]
enum ReferenceKind {
    Text,
    Toml,
    Json,
}

fn check_document_references(document: &DocumentMut, home: &Path) -> RepairResult<()> {
    check_document_references_at(document, home, 0, &[])
}

fn check_document_references_at(
    document: &DocumentMut,
    home: &Path,
    depth: usize,
    inherited_providers: &[String],
) -> RepairResult<()> {
    if depth > 8 {
        return Err(ConfigRepairFailure::new(
            "检查文件引用",
            home,
            "子代理配置文件引用层数过多或存在循环，请手动检查引用关系",
        ));
    }
    let mut providers = inherited_providers.to_vec();
    if let Some(defined) = document
        .get("model_providers")
        .and_then(Item::as_table_like)
    {
        providers.extend(defined.iter().map(|(id, _)| id.to_owned()));
    }
    check_provider(document.as_table(), &providers, home)?;
    check_table_references(document.as_table(), home, depth, &providers)?;
    if let Some(profiles) = document.get("profiles").and_then(Item::as_table_like) {
        for (_, profile) in profiles.iter() {
            if let Some(profile) = profile.as_table_like() {
                check_provider(profile, &providers, home)?;
                check_table_references(profile, home, depth, &providers)?;
            }
        }
    }
    Ok(())
}

fn check_table_references(
    table: &dyn TableLike,
    home: &Path,
    depth: usize,
    providers: &[String],
) -> RepairResult<()> {
    for (key, kind) in [
        ("model_catalog_json", ReferenceKind::Json),
        ("model_instructions_file", ReferenceKind::Text),
        ("experimental_instructions_file", ReferenceKind::Text),
    ] {
        if let Some(item) = table.get(key) {
            check_path_item(item, home, (key, kind), depth, providers)?;
        }
    }
    if let Some(agents) = table.get("agents").and_then(Item::as_table_like) {
        for (_, agent) in agents.iter() {
            if let Some(item) = agent
                .as_table_like()
                .and_then(|agent| agent.get("config_file"))
            {
                check_path_item(
                    item,
                    home,
                    ("agents.*.config_file", ReferenceKind::Toml),
                    depth,
                    providers,
                )?;
            }
        }
    }
    // MCP 命令可能来自 PATH，provider 字段可能是 URL，不作为文件引用。
    Ok(())
}

fn check_path_item(
    item: &Item,
    home: &Path,
    reference: (&str, ReferenceKind),
    depth: usize,
    providers: &[String],
) -> RepairResult<()> {
    let (key, kind) = reference;
    let text = item
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            ConfigRepairFailure::new(
                "检查文件引用",
                &home.join("config.toml"),
                format!("{key} 必须是非空文件路径"),
            )
        })?;
    let path = Path::new(text);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        home.join(path)
    };
    check_reference_at(&resolved, key, kind, depth, providers)
}

fn check_reference_at(
    path: &Path,
    key: &str,
    kind: ReferenceKind,
    depth: usize,
    providers: &[String],
) -> RepairResult<()> {
    let bytes = fs::read(path).map_err(|error| {
        ConfigRepairFailure::new(
            "检查文件引用",
            path,
            format!("{key} 引用的文件不可读取：{error}；请恢复该文件或修正配置中的路径"),
        )
    })?;
    match kind {
        ReferenceKind::Toml => {
            let document = parse_safe(&bytes, path)?;
            check_document_references_at(
                &document,
                path.parent().unwrap_or(path),
                depth + 1,
                providers,
            )?;
        }
        ReferenceKind::Json => {
            serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| {
                ConfigRepairFailure::new(
                    "检查文件引用",
                    path,
                    format!("{key} 引用的文件不是有效 JSON"),
                )
            })?;
        }
        ReferenceKind::Text => {
            str::from_utf8(&bytes).map_err(|_| {
                ConfigRepairFailure::new(
                    "检查文件引用",
                    path,
                    format!("{key} 引用的文件不是 UTF-8 文本"),
                )
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(root: &Path) -> (PathBuf, PathBuf) {
        (root.join("codex"), root.join("codey/codex-lease.json"))
    }

    #[test]
    fn config_repair_check_is_read_only_and_missing_paths_are_created_only_on_repair() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        let report = check_at(&home, &marker.with_file_name("model-catalogs")).unwrap();
        assert!(!report.repaired);
        assert!(report.message.contains("缺失"));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        let report = repair_at(&home, &marker).unwrap();
        assert!(report.repaired);
        assert!(report.backup_path.is_none());
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), b"");
        assert!(!repair_at(&home, &marker).unwrap().repaired);
        fs::remove_file(home.join("config.toml")).unwrap();
        assert!(repair_at(&home, &marker).unwrap().repaired);
    }

    #[test]
    fn config_repair_preserves_all_user_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        let original = b"# user\r\nmodel = 'custom'\r\n[mcp_servers.mine]\r\ncommand='npx'\r\nargs=['-y','tool']\r\n";
        fs::write(home.join("config.toml"), original).unwrap();
        assert!(!repair_at(&home, &marker).unwrap().repaired);
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
        assert!(!marker.parent().unwrap().exists());
    }

    #[test]
    fn config_repair_removes_only_exact_owned_catalog_and_keeps_original_backup() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        for catalog in [
            "model-catalogs/codey-official.json".to_owned(),
            home.join("model-catalogs/codey-official.json")
                .to_string_lossy()
                .into_owned(),
            marker
                .with_file_name("model-catalogs/codey-derived.json")
                .to_string_lossy()
                .into_owned(),
        ] {
            let assignment = format!("\"model_catalog_json\" = '''{catalog}'''");
            let before = "# my header\r\nmodel = 'mine'\r\n";
            let after = " # my comment\r\n[mcp_servers.mine]\r\ncommand='npx'\r\n";
            let original = format!("{before}{assignment}{after}");
            fs::write(home.join("config.toml"), original.as_bytes()).unwrap();
            assert!(
                check_at(&home, &marker.with_file_name("model-catalogs"))
                    .unwrap()
                    .message
                    .contains("旧版")
            );
            assert_eq!(
                fs::read(home.join("config.toml")).unwrap(),
                original.as_bytes()
            );
            let report = repair_at(&home, &marker).unwrap();
            let backup = report.backup_path.as_ref().unwrap();
            assert!(backup.starts_with(marker.parent().unwrap()));
            assert!(!backup.starts_with(&home));
            assert_eq!(fs::read(backup).unwrap(), original.as_bytes());
            assert_eq!(
                fs::read(home.join("config.toml")).unwrap(),
                format!("{before}{after}").as_bytes()
            );
            assert!(report.message.contains(backup.to_str().unwrap()));
            let json = serde_json::to_value(&report).unwrap();
            assert_eq!(json["repaired"], true);
            assert!(json["configPath"].is_string());
            assert!(json["backupPath"].is_string());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(backup).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                assert_eq!(
                    fs::metadata(backup.parent().unwrap())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
            }
        }
    }

    #[test]
    fn config_repair_reports_unsafe_user_content_without_writes_or_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        for original in [
            "token='private-secret' broken\n",
            "model_provider='missing-provider'\n",
            "model_instructions_file='missing-file'\n",
            "model_catalog_json='user/model-catalogs/codey-official.json'\n",
            "[profiles.work.agents.reader]\nconfig_file='missing.toml'\n",
        ] {
            fs::write(home.join("config.toml"), original).unwrap();
            for failure in [
                check_at(&home, &marker.with_file_name("model-catalogs")).unwrap_err(),
                repair_at(&home, &marker).unwrap_err(),
            ] {
                assert!(!failure.description().contains("private-secret"));
                if original.contains("broken") {
                    assert!(failure.message.contains("第 1 行"));
                }
            }
            assert_eq!(
                fs::read(home.join("config.toml")).unwrap(),
                original.as_bytes()
            );
            assert!(!marker.parent().unwrap().exists());
        }
    }

    #[test]
    fn config_repair_checks_nested_references_and_provider_profiles() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(home.join("agents")).unwrap();
        fs::write(
            home.join("config.toml"),
            "[agents.reader]\nconfig_file='agents/reader.toml'\n",
        )
        .unwrap();
        fs::write(
            home.join("agents/reader.toml"),
            "model_instructions_file='missing.md'\n",
        )
        .unwrap();
        assert_eq!(
            repair_at(&home, &marker).unwrap_err().path,
            home.join("agents/missing.md")
        );
        fs::write(home.join("agents/missing.md"), "instructions").unwrap();
        assert!(!repair_at(&home, &marker).unwrap().repaired);
        fs::write(home.join("config.toml"), "[model_providers.custom]\nbase_url='https://example.test'\n[agents.reader]\nconfig_file='agents/reader.toml'\n").unwrap();
        fs::write(home.join("agents/reader.toml"), "model_provider='custom'\n").unwrap();
        assert!(!repair_at(&home, &marker).unwrap().repaired);
        fs::write(
            home.join("agents/reader.toml"),
            "model_provider='missing'\n",
        )
        .unwrap();
        assert_eq!(
            repair_at(&home, &marker).unwrap_err().stage,
            "检查 provider"
        );
        fs::write(
            home.join("config.toml"),
            "[profiles.work]\nmodel_provider='unknown'\n",
        )
        .unwrap();
        assert_eq!(
            repair_at(&home, &marker).unwrap_err().stage,
            "检查 provider"
        );
    }

    #[cfg(unix)]
    #[test]
    fn config_repair_backup_exists_before_a_failed_write() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        let original = "model_catalog_json='model-catalogs/codey-official.json'\n";
        fs::write(home.join("config.toml"), original).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o500)).unwrap();
        let result = repair_at(&home, &marker);
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let failure = result.unwrap_err();
        assert_eq!(failure.stage, "写入配置");
        let directory = fs::read_dir(marker.with_file_name("config-repair-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let backup = directory.join("config.toml");
        assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
        assert!(failure.message.contains(backup.to_str().unwrap()));
        assert_eq!(
            fs::read(home.join("config.toml")).unwrap(),
            original.as_bytes()
        );
    }

    #[cfg(unix)]
    #[test]
    fn config_repair_rejects_symlinks_without_replacing_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        let target = temp.path().join("target.toml");
        fs::write(&target, b"model='mine'").unwrap();
        std::os::unix::fs::symlink(&target, home.join("config.toml")).unwrap();
        assert!(repair_at(&home, &marker).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"model='mine'");
        assert!(!marker.parent().unwrap().exists());
    }

    fn exercise_runtime_config_lifecycle(home: &Path, marker: &Path, check: impl Fn(&str)) {
        let start = || {
            apply_isolated_test_runtime_config(
                home, true, None, true, DEFAULT_SUBAGENT_MODEL,
                DEFAULT_SUBAGENT_REASONING_EFFORT, None, marker,
                &marker.with_file_name("codex-backups"),
            ).unwrap();
            assert!(marker.is_file());
        };
        start();
        check("启动");
        assert!(restore_runtime_config_at(home, marker, true).unwrap());
        check("重启前恢复");
        start();
        check("重启后启动");
        assert!(restore_runtime_config_at(home, marker, true).unwrap());
        check("退出");
        start();
        check("保留租约");
        assert!(restore_runtime_config_at(home, marker, true).unwrap());
        check("租约恢复");
        assert!(!restore_runtime_config_at(home, marker, true).unwrap());
        check("重复恢复");
    }

    #[test]
    fn codex_extensions_lifecycle_preserves_user_project_and_skill_files() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        let project = temp.path().join("project");
        let files = [
            (home.join("config.toml"), b"# user\r\n[mcp_servers.demo]\r\ncommand='example'\r\n".as_slice()),
            (project.join(".codex/config.toml"), b"# project\n[mcp_servers.local]\ncommand='local'\n".as_slice()),
            (home.join("skills/demo/SKILL.md"), b"---\nname: demo\ndescription: example\n---\n".as_slice()),
            (home.join("skills/demo/resources/data.bin"), b"\x00\xffresource".as_slice()),
            (project.join(".agents/skills/local/SKILL.md"), b"---\nname: local\ndescription: example\n---\n".as_slice()),
        ];
        for (path, bytes) in &files {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let extensions = marker.with_file_name("codex-extensions");
        exercise_runtime_config_lifecycle(&home, &marker, |stage| {
            for (path, bytes) in &files {
                assert_eq!(fs::read(path).unwrap(), *bytes, "{stage}: {}", path.display());
            }
            assert!(!extensions.exists(), "{stage}: 不得创建扩展数据目录");
            assert!(!extensions.join("backups").exists());
            assert!(!extensions.join("audit.jsonl").exists());
        });
    }

    #[test]
    fn codex_config_startup_and_exit_never_call_config_repair() {
        let temp = tempfile::tempdir().unwrap();
        let (home, marker) = paths(temp.path());
        fs::create_dir_all(&home).unwrap();
        let original = b"# user\nmodel_catalog_json='model-catalogs/codey-official.json'\n";
        fs::write(home.join("config.toml"), original).unwrap();
        exercise_runtime_config_lifecycle(&home, &marker, |_| {
            assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
        });
        assert!(!marker.with_file_name("config-repair-backups").exists());
        for source in [
            include_str!("../codex_config.rs"),
            include_str!("../launcher.rs"),
            include_str!("../commands/runtime.rs"),
            include_str!("../lib.rs"),
            include_str!("../codex_provider.rs"),
        ] {
            assert!(!source.contains("repair_codex_config("));
        }
    }
}
