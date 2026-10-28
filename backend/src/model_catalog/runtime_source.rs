use super::*;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct RuntimeCatalogSource {
    path: PathBuf,
    len: u64,
    modified: std::time::SystemTime,
}

pub(super) fn catalog_source_for_app(app: &str) -> Result<RuntimeCatalogSource> {
    let root = if app.trim().is_empty() {
        discover_app()?.context("未发现可用的 Codex 安装，无法验证模型目录来源")?
    } else {
        PathBuf::from(app.trim())
    };
    let root = codey_runtime_core::app_paths::resolve_validated_codex_app_dir_with_saved_checked(
        Some(&root),
        None,
    )?
    .context("无法确定 Codex 安装路径")?;
    let path = codey_runtime_core::app_paths::codex_runtime_executable(&root)
        .with_context(|| codey_runtime_core::app_paths::codex_runtime_executable_missing(&root))?;
    runtime_source(&path)
}

fn runtime_source(path: &Path) -> Result<RuntimeCatalogSource> {
    let path = path.canonicalize().context("无法访问 Codex 运行程序")?;
    let metadata = fs::metadata(&path).context("无法读取 Codex 运行程序信息")?;
    Ok(RuntimeCatalogSource {
        path,
        len: metadata.len(),
        modified: metadata
            .modified()
            .context("无法读取 Codex 运行程序修改时间")?,
    })
}

#[cfg(not(test))]
fn discover_app() -> Result<Option<PathBuf>> {
    codey_runtime_core::app_paths::resolve_codex_app_dir_with_saved_checked(None, None)
}

#[cfg(test)]
fn discover_app() -> Result<Option<PathBuf>> {
    tests::discovered_app()
}

pub(crate) fn validate_catalog_source(catalog_dir: &Path, app: &str) -> Result<()> {
    validate_catalog_source_with(catalog_dir, &catalog_source_for_app(app))
}

pub(super) fn validate_catalog_source_with(
    catalog_dir: &Path,
    expected: &Result<RuntimeCatalogSource>,
) -> Result<()> {
    let Some(catalog) = read_derived_catalog(catalog_dir) else {
        return Ok(());
    };
    let recorded = catalog.get("codey_runtime_source").with_context(|| {
        format!(
            "Codey 模型目录未记录 Codex 安装来源：{}",
            derived_catalog_path(catalog_dir).display()
        )
    })?;
    let expected = expected
        .as_ref()
        .map_err(|error| anyhow::anyhow!("无法验证 Codey 模型目录来源：{error:#}"))?;
    let recorded: RuntimeCatalogSource =
        serde_json::from_value(recorded.clone()).context("Codey 模型目录来源记录无效")?;
    anyhow::ensure!(
        expected == &recorded,
        "Codey 模型目录来源与所选 Codex 安装不符：{}",
        derived_catalog_path(catalog_dir).display()
    );
    Ok(())
}

pub(super) fn stamp_catalog(catalog_dir: &Path, app: &str) -> Result<()> {
    let Some(mut catalog) = read_derived_catalog(catalog_dir) else {
        return Ok(());
    };
    let source = catalog_source_for_app(app).context("无法记录 Codey 模型目录来源")?;
    catalog["codey_runtime_source"] = serde_json::to_value(source)?;
    write_derived_catalog(catalog_dir, &catalog)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        static DEFAULT_INSTALL: tempfile::TempDir = {
            let root = tempfile::tempdir().unwrap();
            installation(root.path());
            root
        };
        static DISCOVERY: std::cell::RefCell<Option<std::result::Result<Option<PathBuf>, String>>> = const { std::cell::RefCell::new(None) };
        static DISCOVERY_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    pub(super) fn discovered_app() -> Result<Option<PathBuf>> {
        DISCOVERY_CALLS.with(|calls| calls.set(calls.get() + 1));
        DISCOVERY.with(|discovery| match discovery.borrow().as_ref() {
            Some(result) => result.clone().map_err(anyhow::Error::msg),
            None => Ok(Some(DEFAULT_INSTALL.with(|root| root.path().to_path_buf()))),
        })
    }

    fn with_discovery(result: std::result::Result<Option<PathBuf>, String>, check: impl FnOnce()) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                DISCOVERY.with(|discovery| *discovery.borrow_mut() = None);
            }
        }
        DISCOVERY.with(|discovery| *discovery.borrow_mut() = Some(result));
        DISCOVERY_CALLS.with(|calls| calls.set(0));
        let _reset = Reset;
        check();
    }

    fn installation(root: &Path) -> PathBuf {
        fs::create_dir_all(root.join("resources/app")).unwrap();
        fs::write(root.join("Codex.exe"), b"desktop").unwrap();
        fs::write(root.join("resources/codex.exe"), b"runtime").unwrap();
        fs::write(
            root.join("resources/app/package.json"),
            br#"{"name":"openai-codex-electron","version":"1.0.0"}"#,
        )
        .unwrap();
        root.to_path_buf()
    }

    #[test]
    fn configured_install_uses_validated_runtime_executable() {
        let root = tempfile::tempdir().unwrap();
        let app = installation(&root.path().join("app"));
        let source = catalog_source_for_app(app.to_str().unwrap()).unwrap();
        assert_eq!(
            source.path,
            app.join("resources/codex.exe").canonicalize().unwrap()
        );
    }

    fn write_catalog(root: &Path) {
        write_derived_catalog(
            root,
            &json!({"models":[{
                "slug":"gpt-6.1-sol", "visibility":"list", "description":"测试模型",
                "base_instructions":"目录专属指令"
            }]}),
        )
        .unwrap();
    }

    fn assert_readers_keep_catalog(root: &Path, app: &str) {
        let state = selection_state_with_catalog_options(
            root,
            root,
            true,
            None,
            &[],
            &[],
            &[],
            None,
            None,
            app,
        )
        .unwrap();
        assert!(
            state
                .official_model_ids
                .iter()
                .any(|slug| slug == "gpt-6.1-sol")
        );
        assert!(
            state
                .official_model_order
                .iter()
                .any(|slug| slug == "gpt-6.1-sol")
        );
        assert!(
            official_model_order(root, root, app)
                .iter()
                .any(|slug| slug == "gpt-6.1-sol")
        );
        assert!(
            available_official_models(root, root, None, app)
                .unwrap()
                .iter()
                .any(|model| model.slug == "gpt-6.1-sol")
        );
        let entries = read_official_entries_for_app(root, root, None, app).unwrap();
        assert!(
            entries
                .templates
                .iter()
                .any(|model| model["base_instructions"] == "目录专属指令")
        );
    }

    #[test]
    fn configured_readers_keep_install_a_when_discovery_finds_b_or_is_ambiguous() {
        let root = tempfile::tempdir().unwrap();
        let first = installation(&root.path().join("first"));
        let second = installation(&root.path().join("second"));
        write_catalog(root.path());
        stamp_catalog(root.path(), first.to_str().unwrap()).unwrap();
        for discovered in [
            Ok(Some(second)),
            Err("多个 Codex 安装，请明确选择应用路径".into()),
        ] {
            with_discovery(discovered, || {
                assert_readers_keep_catalog(root.path(), first.to_str().unwrap());
                assert_eq!(DISCOVERY_CALLS.with(std::cell::Cell::get), 0);
            });
        }
    }

    #[test]
    fn empty_path_discovers_and_validates_the_same_install_for_all_readers() {
        let root = tempfile::tempdir().unwrap();
        let app = installation(&root.path().join("app"));
        with_discovery(Ok(Some(app.clone())), || {
            let source = catalog_source_for_app("").unwrap();
            assert_eq!(
                source.path,
                app.join("resources/codex.exe").canonicalize().unwrap()
            );
            write_catalog(root.path());
            stamp_catalog(root.path(), "").unwrap();
            assert_readers_keep_catalog(root.path(), "");
            fs::remove_file(app.join("resources/app/package.json")).unwrap();
            assert!(
                catalog_source_for_app("")
                    .unwrap_err()
                    .to_string()
                    .contains("无法读取 Codex 应用身份")
            );
        });
    }

    #[test]
    fn unavailable_discovery_and_unstamped_catalog_report_reasons() {
        let root = tempfile::tempdir().unwrap();
        write_catalog(root.path());
        let original = fs::read(derived_catalog_path(root.path())).unwrap();
        with_discovery(Ok(None), || {
            let error = stamp_catalog(root.path(), "").unwrap_err();
            assert!(format!("{error:#}").contains("未发现可用的 Codex 安装"));
            assert_eq!(
                fs::read(derived_catalog_path(root.path())).unwrap(),
                original
            );
            let error = validate_catalog_source(root.path(), "").unwrap_err();
            assert!(error.to_string().contains("未记录 Codex 安装来源"));
            let entries =
                read_official_entries_for_app(root.path(), root.path(), None, "").unwrap();
            assert!(
                entries
                    .templates
                    .iter()
                    .all(|model| model["base_instructions"] != "目录专属指令")
            );
        });
        stamp_catalog(root.path(), "").unwrap();
        with_discovery(
            Err("多个 Codex 安装，请明确选择应用路径".into()),
            || {
                let error = validate_catalog_source(root.path(), "").unwrap_err();
                assert!(format!("{error:#}").contains("多个 Codex 安装"));
                let entries =
                    read_official_entries_for_app(root.path(), root.path(), None, "").unwrap();
                assert!(
                    entries
                        .templates
                        .iter()
                        .all(|model| model["base_instructions"] != "目录专属指令")
                );
            },
        );
    }

    #[test]
    fn refresh_reports_discovery_failure_instead_of_publishing_an_unstamped_success() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("models_cache.json"),
            serde_json::to_vec(&json!({"models":[{
                "slug":"gpt-6.1-sol", "visibility":"list", "description":"测试模型",
                "base_instructions":"测试指令"
            }]}))
            .unwrap(),
        )
        .unwrap();
        with_discovery(Ok(None), || {
            let error = refresh_for_provider(root.path(), true, None, &[]).unwrap_err();
            assert!(format!("{error:#}").contains("无法记录 Codey 模型目录来源"));
            assert!(format!("{error:#}").contains("未发现可用的 Codex 安装"));
        });
    }

    #[test]
    fn rejects_another_install_and_replaced_binary_with_reason() {
        let root = tempfile::tempdir().unwrap();
        let first = installation(&root.path().join("codex-a"));
        let second = installation(&root.path().join("codex-b"));
        write_derived_catalog(root.path(), &json!({"models":[]})).unwrap();
        stamp_catalog(root.path(), first.to_str().unwrap()).unwrap();
        validate_catalog_source(root.path(), first.to_str().unwrap()).unwrap();
        let error = validate_catalog_source(root.path(), second.to_str().unwrap()).unwrap_err();
        assert!(error.to_string().contains("来源与所选 Codex 安装不符"));
        fs::write(first.join("resources/codex.exe"), b"replaced runtime").unwrap();
        assert!(validate_catalog_source(root.path(), first.to_str().unwrap()).is_err());
    }

    #[test]
    fn reading_catalog_rejects_foreign_cached_templates() {
        let root = tempfile::tempdir().unwrap();
        let first = installation(&root.path().join("first"));
        let second = installation(&root.path().join("second"));
        let model = json!({"slug":"gpt-6.1-sol", "visibility":"list", "description":"test", "base_instructions":"foreign-only instructions"});
        write_derived_catalog(root.path(), &json!({"models":[model]})).unwrap();
        stamp_catalog(root.path(), first.to_str().unwrap()).unwrap();
        let current =
            read_official_entries_for_app(root.path(), root.path(), None, first.to_str().unwrap())
                .unwrap();
        assert!(
            current
                .templates
                .iter()
                .any(|model| model["base_instructions"] == "foreign-only instructions")
        );
        let switched =
            read_official_entries_for_app(root.path(), root.path(), None, second.to_str().unwrap())
                .unwrap();
        assert!(
            !switched
                .templates
                .iter()
                .any(|model| model["base_instructions"] == "foreign-only instructions")
        );
    }
}
