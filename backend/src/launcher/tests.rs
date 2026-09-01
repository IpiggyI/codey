use super::*;
use std::collections::HashMap;
use std::path::Path;

#[test]
fn packaged_activation_detects_a_reused_process_id() {
    let existing_process_ids = HashSet::from([41_u32, 42_u32]);

    assert!(activation_reused_existing_process(
        &existing_process_ids,
        42
    ));
    assert!(!activation_reused_existing_process(
        &existing_process_ids,
        43
    ));
}

#[test]
fn process_creation_identity_rejects_pid_reuse_when_timestamps_are_available() {
    assert!(process_creation_identity_matches(Some(100), Some(100)));
    assert!(!process_creation_identity_matches(Some(100), Some(101)));
    assert!(process_creation_identity_matches(Some(100), None));
    assert!(process_creation_identity_matches(None, Some(101)));
}

#[test]
fn windows_stop_survivors_match_targets_by_creation_identity() {
    let mut expected = HashMap::new();
    expected.insert(10, Some(100));
    expected.insert(11, Some(101));
    expected.insert(12, None);
    let targets = HashSet::from([10, 11, 12, 13]);
    let current = vec![
        (10, "ChatGPT.exe".to_string(), Some(100)),
        // A recycled pid no longer matches the process we tried to stop.
        (11, "ChatGPT.exe".to_string(), Some(999)),
        // The snapshot had no identity. Even if a timestamp is now available,
        // keep waiting without passing that new identity to retry termination.
        (12, "codex.exe".to_string(), Some(777)),
        // Processes outside the pre-termination snapshot are never ours.
        (13, "unrelated.exe".to_string(), None),
    ];

    let survivors = windows_stop_survivors(&expected, &current, &targets);
    assert_eq!(
        survivors,
        vec![
            (10, "ChatGPT.exe".to_string(), Some(100)),
            (12, "codex.exe".to_string(), None),
        ]
    );
}

#[test]
fn windows_stop_failure_summary_lists_surviving_executables() {
    let remaining = vec![
        (10, "ChatGPT.exe".to_string(), Some(100)),
        (11, "codex.exe".to_string(), Some(101)),
    ];
    assert_eq!(
        windows_stop_failure_summary(&remaining),
        "2 个进程仍在运行：ChatGPT.exe(10)、codex.exe(11)",
    );

    let many = (0..7)
        .map(|index| (100 + index, "helper.exe".to_string(), None))
        .collect::<Vec<_>>();
    let summary = windows_stop_failure_summary(&many);
    assert!(summary.starts_with("7 个进程仍在运行："));
    assert!(summary.ends_with("等共 7 个"));
}

#[test]
fn official_provider_inherits_the_codex_builtin_model_catalog() {
    assert!(!should_install_codey_model_catalog(true, true, false));
    assert!(!should_install_codey_model_catalog(true, false, false));
}

#[test]
fn third_party_provider_installs_the_codey_model_catalog_when_available() {
    assert!(should_install_codey_model_catalog(false, true, false));
    assert!(!should_install_codey_model_catalog(false, false, false));
}

#[tokio::test]
async fn disabled_official_route_installs_an_empty_model_catalog() {
    let home = tempfile::tempdir().unwrap();
    let mut official = ProviderProfile::new("Official");
    official.source_provider_id = Some("openai".into());
    official.auth_mode = crate::config::AUTH_MODE_OFFICIAL_ACCOUNT.into();
    official.enabled = false;
    official.normalize();
    let config = CodeyConfig {
        active_profile_id: official.id.clone(),
        profiles: vec![official],
        official_account_available_this_launch: true,
        selected_models_by_provider: std::collections::BTreeMap::from([(
            "openai".into(),
            vec!["gpt-5.6-sol".into()],
        )]),
        upstream_models_by_provider: std::collections::BTreeMap::from([(
            "openai".into(),
            vec!["gpt-5.6-sol".into()],
        )]),
        default_model: "openai/gpt-5.6-sol".into(),
        ..CodeyConfig::default()
    }
    .normalize();

    let startup = prepare_startup_model_catalog(&config, &config.profiles[0], home.path())
        .await
        .unwrap();

    assert!(startup.use_official_catalog);
    assert!(startup.model_state.official_models.is_empty());
    assert!(startup.model_state.third_party_models.is_empty());
    assert!(runtime_default_model(&config, true, &startup.model_state).is_none());
    let catalog: serde_json::Value = serde_json::from_slice(
        &std::fs::read(home.path().join(model_catalog::relative_path())).unwrap(),
    )
    .unwrap();
    assert_eq!(catalog["models"], serde_json::json!([]));

    let mut unavailable = config;
    unavailable.official_account_available_this_launch = false;
    assert!(!resolve_startup_profile(&unavailable).unwrap().enabled);
}

#[tokio::test]
async fn startup_fallback_removes_search_from_a_stale_chat_route_catalog() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join(crate::model_catalog_store::DERIVED_CATALOG_FILE_NAME);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "models": [{
                "slug": "route-chat/gpt-5.6-sol",
                "display_name": "Chat / GPT-5.6-Sol",
                "description": "Third-party API model",
                "base_instructions": "test instructions",
                "codey_source": "third_party",
                "supports_search_tool": true,
                "web_search_tool_type": "text_and_image"
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let mut route = ProviderProfile::new("Chat route");
    route.id = "route-chat".into();
    route.base_url = "https://chat.example/v1".into();
    route.api_key = "secret".into();
    route.api_key_configured = true;
    route.upstream_protocol = crate::config::UPSTREAM_PROTOCOL_OPENAI_CHAT_COMPLETIONS.into();
    route.normalize();
    let mut config = CodeyConfig {
        local_router_enabled: true,
        active_profile_id: route.id.clone(),
        profiles: vec![route],
        ..CodeyConfig::default()
    };
    config
        .upstream_models_by_provider
        .insert("route-chat".into(), vec!["gpt-5.6-sol".into()]);
    config
        .selected_models_by_provider
        .insert("route-chat".into(), vec!["gpt-5.6-sol".into()]);
    config = config.normalize();

    let startup = prepare_startup_model_catalog(&config, &config.profiles[0], home.path())
        .await
        .unwrap();

    assert!(startup.model_catalog_path.is_some());
    let catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(catalog["models"][0].get("supports_search_tool").is_none());
    assert!(catalog["models"][0].get("web_search_tool_type").is_none());
}

#[test]
fn generated_catalog_uses_the_route_aware_default_selector() {
    let config = CodeyConfig {
        default_model: "route-a/shared-model".into(),
        ..CodeyConfig::default()
    };
    let state = model_catalog::ModelSelectionState {
        default_model: "shared-model".into(),
        ..model_catalog::ModelSelectionState::default()
    };

    assert_eq!(
        runtime_default_model(&config, true, &state).as_deref(),
        Some("route-a/shared-model")
    );
    assert_eq!(
        runtime_default_model(&config, false, &state).as_deref(),
        Some("shared-model")
    );
}

#[test]
fn subagent_runtime_models_alias_only_catalog_members() {
    let route_aliases = vec![
        "route-a/shared-model".to_string(),
        "route-b/shared-model".to_string(),
    ];
    let catalog = crate::subagent_policy::SubagentCatalogSnapshot::new(
        "route-a",
        vec!["shared-model".into(), "gpt-5.6-sol".into()],
    );
    assert_eq!(
        route_subagent_model("route-a", "shared-model", &route_aliases, &catalog),
        "route-a/shared-model"
    );
    assert_eq!(
        route_subagent_model("route-a", "gpt-5.6-sol", &route_aliases, &catalog),
        "route-a/gpt-5.6-sol"
    );
    assert_eq!(
        route_subagent_model("route-a", "route-a/shared-model", &route_aliases, &catalog),
        "route-a/shared-model"
    );
    assert_eq!(
        route_subagent_model("route-a", "route-b/shared-model", &route_aliases, &catalog),
        "route-b/shared-model"
    );
    assert_eq!(
        route_subagent_model("route-a", "gone-model", &route_aliases, &catalog),
        "gone-model"
    );
}

#[test]
fn validate_router_provider_rejects_a_user_owned_router_before_maintenance() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        format!(
            "[model_providers.{ROUTER_PROVIDER_ID}]\n\
             name = \"User Router\"\n\
             base_url = \"https://example.com/v1\"\n"
        ),
    )
    .unwrap();

    let error = validate_router_provider(temp.path()).unwrap_err();
    assert!(error.to_string().contains("已占用 Codey 内部 Provider ID"));
}

#[test]
fn validate_router_provider_allows_a_codey_owned_resume_shim() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        format!(
            "model_provider = \"codey_global\"\n\
             \n\
             [model_providers.codey_global]\n\
             name = \"OpenAI\"\n\
             base_url = \"https://chatgpt.com/backend-api/codex\"\n\
             wire_api = \"responses\"\n\
             requires_openai_auth = true\n\
             \n\
             [model_providers.{ROUTER_PROVIDER_ID}]\n\
             name = \"Codey Local Router\"\n\
             base_url = \"https://chatgpt.com/backend-api/codex\"\n\
             wire_api = \"responses\"\n\
             requires_openai_auth = true\n\
             supports_websockets = false\n"
        ),
    )
    .unwrap();

    validate_router_provider(temp.path()).unwrap();
}

#[test]
fn validate_router_provider_reads_legacy_codey_global_after_resume_shim() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        "model_provider = \"codey_global\"\n\
         \n\
         [model_providers]\n\
         \n\
         [model_providers.codey_global]\n\
         name = \"OpenAI\"\n\
         base_url = \"https://chatgpt.com/backend-api/codex\"\n\
         wire_api = \"responses\"\n\
         requires_openai_auth = true\n",
    )
    .unwrap();

    assert!(crate::codex_config::prepare_persistent_router_resume_shim_at(temp.path()).unwrap());
    validate_router_provider(temp.path()).unwrap();
}

#[tokio::test]
async fn initial_storage_guards_wait_for_crashpad_after_trace_failure() {
    let trace = tokio::spawn(async { anyhow::bail!("trace guard failed") });
    let (release, released) = oneshot::channel();
    let crashpad = tokio::spawn(async move {
        released.await.unwrap();
        crashpad_pending_guard::CrashpadGuardRun {
            cleanup: Default::default(),
            snapshot: crashpad_pending_guard::CrashpadPendingStatsSnapshot {
                files_found: 7,
                ..crashpad_pending_guard::CrashpadPendingStatsSnapshot::idle(true)
            },
        }
    });
    let trace_active = AtomicBool::new(false);
    let stats = CrashpadPendingStatsHandle::idle(true);
    let wait = await_initial_storage_guards(trace, true, &trace_active, crashpad, true, &stats);
    tokio::pin!(wait);

    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut wait)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert_eq!(wait.await.unwrap_err().to_string(), "trace guard failed");
    assert_eq!(serde_json::to_value(&stats).unwrap()["filesFound"], 7);
}

#[tokio::test]
async fn startup_storage_waits_for_guards_when_app_resolution_fails() {
    let home = tempfile::tempdir().unwrap();
    let config = CodeyConfig {
        codex_app_path: home
            .path()
            .join("missing-installation")
            .display()
            .to_string(),
        ..CodeyConfig::default()
    };
    let trace = tokio::spawn(async { anyhow::bail!("secondary trace failure") });
    let (release, released) = oneshot::channel();
    let crashpad = tokio::spawn(async move {
        released.await.unwrap();
        crashpad_pending_guard::CrashpadGuardRun {
            cleanup: Default::default(),
            snapshot: crashpad_pending_guard::CrashpadPendingStatsSnapshot {
                files_found: 9,
                ..crashpad_pending_guard::CrashpadPendingStatsSnapshot::idle(true)
            },
        }
    });
    let trace_active = AtomicBool::new(false);
    let stats = CrashpadPendingStatsHandle::idle(true);
    let preparation = prepare_startup_storage(
        home.path(),
        &config,
        None,
        InitialStorageGuards { trace, crashpad },
        &trace_active,
        &stats,
    );
    tokio::pin!(preparation);

    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut preparation)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    let error = preparation.await.err().expect("invalid app path must fail");
    assert_eq!(error.to_string(), CODEX_APP_PATH_INVALID_ERROR);
    assert_eq!(serde_json::to_value(&stats).unwrap()["filesFound"], 9);
}

#[tokio::test]
async fn startup_maintenance_preserves_router_and_other_provider_threads() {
    let temp = tempfile::tempdir().unwrap();
    let config = "model_provider = \"yescode\"\n\n[model_providers.yescode]\nbase_url = \"https://first.example/v1\"\n";
    std::fs::write(temp.path().join("config.toml"), config).unwrap();
    let database = rusqlite::Connection::open(temp.path().join("state_5.sqlite")).unwrap();
    database
        .execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, model TEXT);",
        )
        .unwrap();
    let mut rollouts = Vec::new();
    for (index, provider) in [ROUTER_PROVIDER_ID, "aizz", "openai"].iter().enumerate() {
        let directory = temp.path().join(if index == 1 {
            "archived_sessions"
        } else {
            "sessions"
        });
        std::fs::create_dir_all(&directory).unwrap();
        let thread_id = format!("thread-{index}");
        let model = "route-aizz/gpt-5.6-luna";
        let rollout = directory.join(format!("rollout-{thread_id}.jsonl"));
        let content = format!(
            "{}\n",
            serde_json::json!({
                "type": "session_meta",
                "payload": { "id": thread_id, "model_provider": provider, "model": model }
            })
        );
        std::fs::write(&rollout, &content).unwrap();
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3)",
                rusqlite::params![thread_id, provider, model],
            )
            .unwrap();
        rollouts.push((rollout, content));
    }

    validate_router_provider(temp.path()).unwrap();
    let summary = run_startup_session_maintenance(temp.path()).await.unwrap();

    assert_eq!(summary.status, "ready");
    assert_eq!(summary.files_fixed, 0);
    assert_eq!(summary.sqlite_rows_updated, 0);
    assert_eq!(
        std::fs::read_to_string(temp.path().join("config.toml")).unwrap(),
        config
    );
    for (path, original) in rollouts {
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }
    let rows = database
        .prepare("SELECT model_provider, model FROM threads ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        [ROUTER_PROVIDER_ID, "aizz", "openai"]
            .map(|provider| { (provider.to_string(), "route-aizz/gpt-5.6-luna".to_string()) })
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_launch_forces_a_new_app_instance() {
    let command = build_fresh_macos_open_command(
        std::path::Path::new("/Applications/ChatGPT.app"),
        9229,
        &["--inspect-brk=127.0.0.1:19321".to_string()],
    );
    assert_eq!(command.first().map(String::as_str), Some("open"));
    assert!(command.iter().any(|part| part == "-n"));
    assert!(command.iter().any(|part| part == "-W"));
    assert!(
        command
            .iter()
            .any(|part| part == "--remote-debugging-port=9229")
    );
    assert!(
        command
            .iter()
            .any(|part| part == "--inspect-brk=127.0.0.1:19321")
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn macos_running_check_does_not_match_an_unrelated_app_path() {
    let running = macos_codex_is_running(std::path::Path::new(
        "/Applications/Definitely Not Codex.app",
    ))
    .await
    .unwrap();
    assert!(!running);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_running_check_matches_only_the_app_main_executable() {
    let processes = crate::process_tree::parse_unix_process_snapshot(
        b"100 1 100 Thu Jul 23 19:23:12 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9229\n\
          101 100 100 Thu Jul 23 19:23:13 2026 /Applications/ChatGPT.app/Contents/Resources/codex app-server\n\
          102 101 102 Thu Jul 23 19:23:14 2026 /Applications/ChatGPT.app/Contents/Frameworks/Chromium Helper\n",
    );
    assert!(macos_main_executable_is_running(
        &processes,
        Path::new("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    ));
    assert!(!macos_main_executable_is_running(
        &processes[1..],
        Path::new("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    ));
}

#[test]
fn owned_codex_tree_includes_bundle_helpers_and_external_descendants() {
    let processes = crate::process_tree::parse_unix_process_snapshot(
        b"100 1 100 Thu Jul 23 19:23:12 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --inspect\n\
          101 100 100 Thu Jul 23 19:23:13 2026 /Applications/ChatGPT.app/Contents/Resources/codex app-server\n\
          102 101 102 Thu Jul 23 19:23:14 2026 node ./mcp/server.mjs\n\
          103 1 103 Thu Jul 23 19:23:15 2026 /Applications/ChatGPT.app/Contents/Frameworks/browser_crashpad_handler\n\
          200 1 200 Thu Jul 23 19:23:16 2026 unrelated\n",
    );
    assert_eq!(
        owned_unix_codex_process_ids(
            &processes,
            Path::new("/Applications/ChatGPT.app"),
            None,
            None,
            Some("--inspect"),
        ),
        HashSet::from([100, 101, 102, 103])
    );
}

#[tokio::test]
async fn unix_shutdown_terminates_the_spawned_process_group() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 30 & wait"]);
    command.process_group(0);
    let mut child = command.spawn().expect("spawn process tree");
    let process_id = child.id().expect("child process id");

    terminate_unix_codex_processes(
        Path::new("/definitely-not-a-real-codex-app"),
        Some(process_id),
        Some(process_id),
        None,
    )
    .await
    .expect("terminate process tree");

    tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .expect("root process was left running")
        .expect("wait for root process");
}

#[tokio::test]
async fn exit_watcher_reports_a_naturally_exited_child() {
    let child = Command::new("sh")
        .args(["-c", "exit 0"])
        .spawn()
        .expect("spawn short-lived child");
    let child = Arc::new(Mutex::new(Some(child)));
    let exited = Arc::new(AtomicBool::new(false));
    let (_shutdown, exit_rx, task) = spawn_codex_exit_watcher(child, exited.clone());

    tokio::time::timeout(Duration::from_secs(2), exit_rx)
        .await
        .expect("watcher timed out")
        .expect("watcher was cancelled");
    task.await.expect("watcher task failed");
    assert!(exited.load(Ordering::Acquire));
}

#[tokio::test]
async fn runtime_stop_preserves_resources_on_failure_and_allows_retry() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.toml");
    std::fs::write(&config_path, "runtime config").unwrap();
    let config = CodeyConfig::default();
    let router = LocalRouter::start(&config).await.unwrap();
    let router_url = router.endpoint().base_url;
    let child = Command::new("sleep")
        .arg("30")
        .kill_on_drop(true)
        .process_group(0)
        .spawn()
        .unwrap();
    let process_id = child.id();
    let child = Arc::new(Mutex::new(Some(child)));
    let (exit_shutdown, exit_rx, exit_task) =
        spawn_codex_exit_watcher(child.clone(), Arc::new(AtomicBool::new(false)));
    let (watchdog_shutdown, watchdog_rx) = oneshot::channel();
    let watchdog_task = tokio::spawn(async move {
        let _ = watchdog_rx.await;
    });
    let runtime = CodeyRuntime {
        codex_app_path: temp.path().join("nonexistent-codex-app"),
        maintenance: MaintenanceStatus {
            session_status: String::new(),
            session_files_fixed: 0,
            sqlite_rows_updated: 0,
            ghost_tasks_pruned: 0,
            performance_status: String::new(),
            performance_detail: String::new(),
        },
        applied_model_config: RwLock::new(RuntimeModelConfig::from_config(&config)),
        applied_subagent_config: RwLock::new(RuntimeSubagentConfig::from_config(&config)),
        applied_config: config,
        injection_statuses: Arc::new(RwLock::new(Arc::from([]))),
        injection_scripts: cdp::prepare_injection_scripts(false, false, false, &[]),
        injection_websocket_url: Arc::new(RwLock::new(Arc::from(""))),
        child,
        process_id,
        process_group_id: process_id,
        #[cfg(target_os = "macos")]
        inspector_argument: None,
        watchdog_shutdown: Mutex::new(Some(watchdog_shutdown)),
        watchdog_task: Mutex::new(Some(watchdog_task)),
        exit_watchdog_shutdown: Mutex::new(Some(exit_shutdown)),
        exit_watchdog_task: Mutex::new(Some(exit_task)),
        crashpad_guard_enabled: Arc::new(AtomicBool::new(false)),
        crashpad_guard_shutdown: Mutex::new(None),
        crashpad_guard_task: Mutex::new(None),
        local_router: Some(router),
    };
    let restore = || async { std::fs::write(&config_path, "restored config").map_err(Into::into) };
    let failure = runtime
        .stop_with_cleanup(
            async {
                Command::new(temp.path().join("missing-process-stopper"))
                    .status()
                    .await
                    .context("process stop failed")?;
                Ok(())
            },
            restore(),
        )
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("清理 Codex 遗留进程失败"));
    assert_eq!(
        std::fs::read_to_string(&config_path).unwrap(),
        "runtime config"
    );
    assert!(
        !runtime
            .watchdog_task
            .lock()
            .await
            .as_ref()
            .unwrap()
            .is_finished()
    );
    assert!(
        !runtime
            .exit_watchdog_task
            .lock()
            .await
            .as_ref()
            .unwrap()
            .is_finished()
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(client.get(&router_url).send().await.is_ok());

    // The real test child exits while its watcher still owns Child. A failed
    // config write must leave the router available until restoration succeeds.
    let failure = runtime
        .stop_with_cleanup(
            stop_codex_processes(
                &runtime.codex_app_path,
                process_id,
                process_id,
                #[cfg(target_os = "macos")]
                None,
            ),
            async {
                std::fs::write(config_path.join("invalid-child"), "config").map_err(Into::into)
            },
        )
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("恢复 Codex 配置失败"));
    let _ = tokio::time::timeout(Duration::from_secs(1), exit_rx)
        .await
        .unwrap();
    assert!(runtime.child.lock().await.is_none());
    assert!(client.get(&router_url).send().await.is_ok());
    runtime
        .stop_with_cleanup(async { Ok(()) }, restore())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&config_path).unwrap(),
        "restored config"
    );
    assert!(client.get(&router_url).send().await.is_err());
}

#[tokio::test]
async fn exit_watcher_returns_the_child_to_stop_on_shutdown() {
    let child = Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .expect("spawn long-lived child");
    let child = Arc::new(Mutex::new(Some(child)));
    let exited = Arc::new(AtomicBool::new(false));
    let (shutdown, _exit_rx, task) = spawn_codex_exit_watcher(child.clone(), exited.clone());

    shutdown.send(()).expect("send watcher shutdown");
    task.await.expect("watcher task failed");

    assert!(!exited.load(Ordering::Acquire));
    let mut process = child
        .lock()
        .await
        .take()
        .expect("watcher should return the child");
    process.kill().await.expect("kill child");
    process.wait().await.expect("reap child");
}

#[test]
fn cdp_watchdog_requires_consecutive_failures_before_reinjecting() {
    let mut failures = 0;

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert_eq!(failures, 1);
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Healthy
    ));
    assert_eq!(failures, 0);
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert!(watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
}

#[test]
fn cdp_watchdog_does_not_reinject_after_renderer_timeouts() {
    let mut failures = 0;

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert_eq!(failures, 0);

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert_eq!(failures, 0);
}

#[test]
fn cdp_watchdog_immediately_rediscovers_an_unavailable_target() {
    let mut failures = 1;

    assert!(watchdog_should_reinject(
        &mut failures,
        InjectionHealth::TargetUnavailable
    ));
    assert_eq!(failures, 0);
}
