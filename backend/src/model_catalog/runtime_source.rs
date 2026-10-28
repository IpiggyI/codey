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
    // 与启动器共用安装解析，Store 更新后仍按原包系列定位当前版本。
    let root = resolve_configured_app(&root)?.context("无法确定 Codex 安装路径")?;
    let path = codey_runtime_core::app_paths::codex_runtime_executable(&root)
        .with_context(|| codey_runtime_core::app_paths::codex_runtime_executable_missing(&root))?;
    runtime_source(&path)
}

fn resolve_configured_app(app: &Path) -> Result<Option<PathBuf>> {
    #[cfg(test)]
    let app = tests::registered_package_app(app);
    crate::launcher::find_configured_codex_app_dir_sync(
        app.to_str().context("Codex 安装路径不是有效 UTF-8")?,
    )
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
        static PACKAGE_UPDATE: std::cell::RefCell<Option<(PathBuf, PathBuf)>> = const { std::cell::RefCell::new(None) };
    }

    pub(super) fn discovered_app() -> Result<Option<PathBuf>> {
        DISCOVERY_CALLS.with(|calls| calls.set(calls.get() + 1));
        DISCOVERY.with(|discovery| match discovery.borrow().as_ref() {
            Some(result) => result.clone().map_err(anyhow::Error::msg),
            None => Ok(Some(DEFAULT_INSTALL.with(|root| root.path().to_path_buf()))),
        })
    }

    pub(super) fn registered_package_app(app: &Path) -> PathBuf {
        PACKAGE_UPDATE.with(|update| match update.borrow().as_ref() {
            Some((previous, current)) if app == previous => current.clone(),
            _ => app.to_path_buf(),
        })
    }

    fn with_package_update(previous: PathBuf, current: PathBuf, check: impl FnOnce()) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                PACKAGE_UPDATE.with(|update| *update.borrow_mut() = None);
            }
        }
        PACKAGE_UPDATE.with(|update| *update.borrow_mut() = Some((previous, current)));
        let _reset = Reset;
        check();
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
    fn third_party_channel_with_removed_package_keeps_catalog_source() {
        let root = tempfile::tempdir().unwrap();
        let previous = installation(&root.path().join("OpenAI.Codex_26.930.2377.0/app"));
        let current = installation(&root.path().join("OpenAI.Codex_26.1023.6123.0/app"));
        fs::remove_dir_all(&previous).unwrap();
        assert!(!previous.exists());
        assert!(current.exists());
        assert!(resolve_configured_app(&current).unwrap().is_some());
        let home = root.path().join("codex");
        let catalog_dir = root.path().join("catalogs");
        fs::create_dir_all(&home).unwrap();
        let config_bytes = br#"model_provider = "openai"
model = "gpt-6.1-sol"
model_catalog_url = "https://example.invalid/backend-api/codex/models"
[model_providers.third_party]
name = "Third party"
base_url = "https://example.invalid/v1"
wire_api = "responses"
"#;
        fs::write(home.join("config.toml"), config_bytes).unwrap();
        let mut config = crate::config::CodeyConfig {
            codex_app_path: previous.to_str().unwrap().into(),
            selected_channel_id: Some("provider:third_party".into()),
            ..crate::config::CodeyConfig::default()
        };
        assert_eq!(
            crate::channels::runtime_overrides(&home, &config).unwrap(),
            ["model_provider=\"third_party\"", "model=\"gpt-6.1-sol\""]
        );
        config.attach_current_provider_snapshot(
            crate::codex_provider::current_provider_snapshot_for_config(&home, &config).unwrap(),
        );
        assert!(config.current_provider_is_third_party());
        assert!(
            crate::codex_config::configured_user_model_catalog_path(&home, &catalog_dir)
                .unwrap()
                .is_none()
        );
        fs::write(
            home.join("models_cache.json"),
            serde_json::to_vec(&json!({"models":[{
                "slug":"gpt-6.1-sol", "visibility":"list", "description":"测试模型",
                "base_instructions":"当前缓存指令"
            }]}))
            .unwrap(),
        )
        .unwrap();
        let selected = vec!["gpt-6.1-sol".to_string()];
        let refresh = || {
            refresh_catalog(CatalogRefreshArgs {
                codex_app_path: &config.codex_app_path,
                codex_home: &home,
                catalog_dir: &catalog_dir,
                official_provider: config.official_account_available_this_launch
                    && !config.current_provider_is_third_party(),
                include_official_models: false,
                upstream_models: Some(&selected),
                selected_models: &selected,
                excluded_official_models: &[],
                websocket_models: Some(&[]),
                native_web_search_models: Some(&[]),
                context_1m_models: Some(&[]),
                user_catalog: None,
            })
        };
        // 模拟 Windows 同包系列更新后的路径；目录校验和写入使用真实临时文件。
        with_package_update(previous.clone(), current.clone(), || {
            let launch_refresh = refresh();
            let sync_refresh = refresh();
            // 启动允许刷新失败后使用内置目录；同步失败时会再次校验来源。
            let source = validate_catalog_source(&catalog_dir, &config.codex_app_path);
            assert!(
                source.is_ok(),
                "{source:?}; launch={launch_refresh:?}; sync={sync_refresh:?}"
            );
            assert_eq!(launch_refresh.unwrap(), 1);
            assert_eq!(sync_refresh.unwrap(), 1);
            let catalog = read_derived_catalog(&catalog_dir).unwrap();
            let recorded: RuntimeCatalogSource =
                serde_json::from_value(catalog["codey_runtime_source"].clone()).unwrap();
            assert_eq!(
                recorded,
                catalog_source_for_app(current.to_str().unwrap()).unwrap()
            );
            let mut legacy = catalog;
            legacy
                .as_object_mut()
                .unwrap()
                .remove("codey_runtime_source");
            write_derived_catalog(&catalog_dir, &legacy).unwrap();
            assert_eq!(refresh().unwrap(), 1);
            validate_catalog_source(&catalog_dir, &config.codex_app_path).unwrap();
        });
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), config_bytes);
    }

    #[test]
    fn refreshed_package_still_rejects_a_catalog_from_another_install() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("removed-package/app");
        let current = installation(&root.path().join("current-package/app"));
        let foreign = installation(&root.path().join("other-install"));
        write_catalog(root.path());
        stamp_catalog(root.path(), foreign.to_str().unwrap()).unwrap();
        let original = fs::read(derived_catalog_path(root.path())).unwrap();
        with_package_update(previous.clone(), current, || {
            let error =
                validate_catalog_source(root.path(), previous.to_str().unwrap()).unwrap_err();
            assert!(error.to_string().contains("来源与所选 Codex 安装不符"));
        });
        assert_eq!(
            fs::read(derived_catalog_path(root.path())).unwrap(),
            original
        );
    }

    #[test]
    fn missing_explicit_install_does_not_fall_back_to_discovery() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let other = installation(&root.path().join("other"));
        with_discovery(Ok(Some(other)), || {
            assert!(catalog_source_for_app(missing.to_str().unwrap()).is_err());
            assert_eq!(DISCOVERY_CALLS.with(std::cell::Cell::get), 0);
        });
    }

    #[test]
    fn third_party_launch_with_user_catalog_keeps_source_for_model_sync() {
        let root = tempfile::tempdir().unwrap();
        let app = installation(&root.path().join("app"));
        let home = root.path().join("codex");
        let catalog_dir = root.path().join("catalogs");
        fs::create_dir_all(&home).unwrap();
        let user_path = root.path().join("user.json");
        let original = br#"{"models":[{"slug":"provider-model","codey_source":"third_party","description":"provider model","base_instructions":"provider instructions"}]}"#;
        fs::write(&user_path, original).unwrap();
        let selected = vec!["provider-model".to_string()];
        let refresh = || {
            refresh_catalog(CatalogRefreshArgs {
                codex_app_path: app.to_str().unwrap(),
                codex_home: &home,
                catalog_dir: &catalog_dir,
                official_provider: false,
                include_official_models: false,
                upstream_models: Some(&selected),
                selected_models: &selected,
                excluded_official_models: &[],
                websocket_models: Some(&[]),
                native_web_search_models: Some(&[]),
                context_1m_models: Some(&[]),
                user_catalog: Some(&user_path),
            })
        };

        assert_eq!(refresh().unwrap(), 1);
        apply_catalog_contexts(&catalog_dir, &BTreeMap::new(), &[]).unwrap();
        // 同步刷新失败时也会执行此来源校验，不能拒绝本次启动生成的目录。
        validate_catalog_source(&catalog_dir, app.to_str().unwrap()).unwrap();
        assert_eq!(refresh().unwrap(), 1);
        validate_catalog_source(&catalog_dir, app.to_str().unwrap()).unwrap();
        let mut catalog = read_derived_catalog(&catalog_dir).unwrap();
        catalog["models"][0]["supports_search_tool"] = json!(true);
        write_derived_catalog(&catalog_dir, &catalog).unwrap();
        assert!(prepare_cached_catalog_for_native_web_search(&catalog_dir, &[], &[]).unwrap());
        validate_catalog_source(&catalog_dir, app.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(&user_path).unwrap(), original);
    }

    #[test]
    fn first_refresh_rebuilds_missing_or_previous_package_source_from_native_cache() {
        let root = tempfile::tempdir().unwrap();
        let previous = installation(&root.path().join("OpenAI.Codex_26.930.2377.0"));
        let current = installation(&root.path().join("OpenAI.Codex_26.1023.6123.0"));
        let selected = vec!["gpt-6.1-sol".to_string()];
        fs::write(
            root.path().join("models_cache.json"),
            serde_json::to_vec(&json!({"models":[{
                "slug":"gpt-6.1-sol", "visibility":"list", "description":"测试模型",
                "base_instructions":"当前缓存指令"
            }]}))
            .unwrap(),
        )
        .unwrap();
        for recorded in [false, true] {
            write_catalog(root.path());
            if recorded {
                stamp_catalog(root.path(), previous.to_str().unwrap()).unwrap();
            }
            let error =
                validate_catalog_source(root.path(), current.to_str().unwrap()).unwrap_err();
            assert!(error.to_string().contains(if recorded {
                "来源与所选 Codex 安装不符"
            } else {
                "未记录 Codex 安装来源"
            }));
            with_discovery(Ok(Some(current.clone())), || {
                refresh_for_provider(root.path(), false, Some(&selected), &selected).unwrap();
            });
            validate_catalog_source(root.path(), current.to_str().unwrap()).unwrap();
            let catalog = read_derived_catalog(root.path()).unwrap();
            assert_eq!(catalog["models"][0]["base_instructions"], "当前缓存指令");
            assert_eq!(catalog["models"].as_array().unwrap().len(), 1);
        }
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
