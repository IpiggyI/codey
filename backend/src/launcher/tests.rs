use super::*;
use crate::codey_router_session_migrate::ROUTER_PROVIDER_ID;
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

#[test]
fn empty_generated_catalog_is_not_injected_except_for_a_user_catalog() {
    assert!(!should_inject_runtime_model_catalog(
        false, false, false, false, false
    ));
    assert!(!should_inject_runtime_model_catalog(
        false, true, false, false, false
    ));
    assert!(!should_inject_runtime_model_catalog(
        false, false, true, false, true
    ));
    // A user-supplied model_catalog_json still yields to the derived copy.
    assert!(should_inject_runtime_model_catalog(
        true, false, false, false, false
    ));
}

#[tokio::test]
async fn official_current_provider_keeps_codex_builtin_catalog() {
    let home = tempfile::tempdir().unwrap();
    let snapshot = crate::model_ownership::CurrentProviderSnapshot::from_parts(
        "openai",
        "https://chatgpt.com/backend-api/codex",
        "responses",
        true,
    );
    let config = CodeyConfig {
        official_account_available_this_launch: true,
        selected_models_by_provider: std::collections::BTreeMap::from([(
            snapshot.ownership_key.clone(),
            vec!["gpt-5.6-sol".into()],
        )]),
        upstream_models_by_provider: std::collections::BTreeMap::from([(
            snapshot.ownership_key.clone(),
            vec!["gpt-5.6-sol".into()],
        )]),
        default_model: "gpt-5.6-sol".into(),
        current_provider_snapshot: Some(snapshot.into()),
        ..CodeyConfig::default()
    }
    .normalize();

    let startup = prepare_startup_model_catalog(&config, home.path())
        .await
        .unwrap();

    assert!(startup.model_catalog_path.is_none());
    resolve_startup_provider(&config).unwrap();
    let mut unavailable = config;
    unavailable.official_account_available_this_launch = false;
    assert!(resolve_startup_provider(&unavailable).is_err());
}

#[tokio::test]
async fn startup_fallback_does_not_inject_a_catalog_for_an_isolated_chat_route() {
    let home = tempfile::tempdir().unwrap();

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

    let startup = prepare_startup_model_catalog(&config, home.path())
        .await
        .unwrap();

    assert!(startup.model_catalog_path.is_none());
}

#[test]
fn generated_catalog_uses_the_configured_default_selector() {
    let leftover = model_catalog::ModelSelectionState {
        default_model: "gpt-6-astra".into(),
        ..model_catalog::ModelSelectionState::default()
    };
    assert_eq!(
        runtime_default_model(&leftover).as_deref(),
        Some("gpt-6-astra")
    );

    let resolved = model_catalog::ModelSelectionState {
        default_model: "catalog-default".into(),
        ..model_catalog::ModelSelectionState::default()
    };
    assert_eq!(
        runtime_default_model(&resolved).as_deref(),
        Some("catalog-default")
    );

    let empty = model_catalog::ModelSelectionState {
        default_model: "   ".into(),
        ..model_catalog::ModelSelectionState::default()
    };
    assert_eq!(runtime_default_model(&empty), None);
}

#[test]
fn subagent_runtime_models_keep_bare_ids() {
    let catalog = crate::subagent_policy::SubagentCatalogSnapshot::new(
        "relay",
        vec!["shared-model".into(), "gpt-5.6-sol".into()],
    );
    assert_eq!(
        runtime_subagent_model("shared-model", &catalog),
        "shared-model"
    );
    assert_eq!(
        runtime_subagent_model("gpt-5.6-sol", &catalog),
        "gpt-5.6-sol"
    );
    assert_eq!(
        runtime_subagent_model("relay/shared-model", &catalog),
        "shared-model"
    );
    assert_eq!(runtime_subagent_model("gone-model", &catalog), "gone-model");
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
    let mut timings = StartupStageTimings::default();
    let preparation = prepare_startup_storage(
        home.path(),
        &config,
        None,
        InitialStorageGuards { trace, crashpad },
        &trace_active,
        &stats,
        &mut timings,
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
async fn session_maintenance_does_not_rewrite_historical_session_providers() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        "model_provider = \"openai\"\n",
    )
    .unwrap();
    let sessions = temp.path().join("sessions/2026/08/27");
    std::fs::create_dir_all(&sessions).unwrap();
    let rollout = sessions.join("rollout-thread-1.jsonl");
    let original = format!(
        "{}\n",
        serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": "thread-1",
                "model_provider": ROUTER_PROVIDER_ID
            }
        })
    );
    std::fs::write(&rollout, &original).unwrap();

    run_startup_session_maintenance(temp.path()).await.unwrap();

    assert_eq!(std::fs::read_to_string(&rollout).unwrap(), original);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_launch_forces_a_new_app_instance() {
    let command = build_fresh_macos_open_command(
        std::path::Path::new("/Applications/ChatGPT.app"),
        9229,
        &["--disable-gpu".to_string()],
    );
    assert_eq!(command.first().map(String::as_str), Some("open"));
    assert!(command.iter().any(|part| part == "-n"));
    assert!(command.iter().any(|part| part == "-W"));
    assert!(
        command
            .iter()
            .any(|part| part == "--remote-debugging-port=9229")
    );
    assert!(command.iter().any(|part| part == "--disable-gpu"));
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
        b"100 1 100 Thu Jul 23 19:23:12 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9229\n\
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
            Some("--remote-debugging-port=9229"),
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
    for code in [0, 23] {
        let child = Command::new("sh")
            .args(["-c", &format!("exit {code}")])
            .spawn()
            .expect("spawn short-lived child");
        let child = Arc::new(Mutex::new(Some(child)));
        let exited = Arc::new(AtomicBool::new(false));
        let (_shutdown, exit_rx, task) = spawn_codex_exit_watcher(child, exited.clone());

        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .expect("watcher timed out")
            .expect("watcher was cancelled");
        task.await.expect("watcher task failed");
        assert!(exited.load(Ordering::Acquire));
        assert_eq!(exit.exit_code, Some(code));
        assert_eq!(exit.platform, std::env::consts::OS);
    }
}

#[tokio::test]
async fn startup_patch_cleanup_retains_process_identity_until_stop_succeeds() {
    let child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let process_id = child.id();
    let mut spawned = SpawnedCodex {
        child: Some(child),
        process_id,
        process_group_id: process_id,
        performance_status: String::new(),
        performance_detail: String::new(),
    };
    for _ in 0..2 {
        assert!(
            complete_spawned_codex_cleanup(&mut spawned, Err(anyhow::anyhow!("stop failed")))
                .await
                .is_err()
        );
        assert_eq!(spawned.process_id, process_id);
        let child = spawned.child.as_mut().unwrap();
        assert_eq!(child.id(), process_id);
        assert!(child.try_wait().unwrap().is_none());
    }
    spawned.child.as_mut().unwrap().kill().await.unwrap();
    complete_spawned_codex_cleanup(&mut spawned, Ok(()))
        .await
        .unwrap();
    assert!(spawned.child.is_none());
    assert!(spawned.process_id.is_none());
}

#[tokio::test]
async fn failed_renderer_injection_retains_cleanup_until_process_tree_stop_succeeds() {
    for final_reap in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("config.toml");
        std::fs::write(&config_path, "runtime config").unwrap();
        let child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let process_id = child.id();
        let cleanup = Arc::new(PendingRuntimeCleanup {
            home: temp.path().to_path_buf(),
            app_dir: temp.path().join("missing-codex-app"),
            process_id,
            process_group_id: process_id,
            child: Arc::new(Mutex::new(Some(child))),
        });
        let restore = || async {
            std::fs::write(&config_path, "restored config").map_err(anyhow::Error::from)
        };
        // 使用注入失败分支的同一清理动作，首次失败不能回收 Child 或恢复配置。
        let error = cleanup_initial_renderer_failure(
            Arc::clone(&cleanup),
            recovery::recoverable("renderer injection failed"),
            async { anyhow::bail!("process snapshot unavailable") },
            restore(),
        )
        .await
        .context("startup context");
        // 启动握手失败会先经过此层，仍须保留类型化的清理责任。
        let error = restore_runtime_config_after_error(temp.path(), error).await;
        assert!(PendingRuntimeCleanup::from_error(&error).is_some());
        assert!(!error.is::<recovery::IntegrationFailure>());
        // 原生回退不得吞掉携带进程身份的错误。
        let error = recovery::after_integration_failure(temp.path(), &cleanup.app_dir, error).await;
        let state = Arc::new(crate::commands::AppState::default());
        *state.failed_runtime_start.lock().await = PendingRuntimeCleanup::from_error(&error);
        drop(error);
        assert!(state.runtime.lock().await.is_none());
        for _ in 0..2 {
            let retained = state.failed_runtime_start.lock().await.clone().unwrap();
            assert!(Arc::ptr_eq(&retained, &cleanup));
            assert_eq!(retained.process_id, process_id);
            assert_eq!(retained.process_group_id, process_id);
            assert_eq!(
                retained.child.lock().await.as_ref().unwrap().id(),
                process_id
            );
            assert_eq!(
                std::fs::read_to_string(&config_path).unwrap(),
                "runtime config"
            );
            // 生产 stop 的保留与重试分支继续使用同一清理对象。
            let cleaning_state = Arc::clone(&state);
            let failed =
                crate::commands::cleanup_pending_runtime_start_with(&state, |pending| async move {
                    assert!(cleaning_state.failed_runtime_start.lock().await.is_some());
                    pending
                        .stop_with_cleanup(async { anyhow::bail!("still unavailable") }, restore())
                        .await
                })
                .await;
            assert!(failed.is_err());
        }
        if final_reap {
            // 只回收直接子进程不代表整棵进程树停止，也不能恢复配置。
            let mut child = cleanup.child.lock().await.take().unwrap();
            child.kill().await.unwrap();
            assert!(cleanup.child.lock().await.is_none());
            assert!(state.failed_runtime_start.lock().await.is_some());
            let failed =
                crate::commands::cleanup_pending_runtime_start_with(&state, |pending| async move {
                    pending
                        .stop_with_cleanup(
                            async { anyhow::bail!("descendant still alive") },
                            restore(),
                        )
                        .await
                })
                .await;
            assert!(failed.is_err());
            assert!(state.failed_runtime_start.lock().await.is_some());
            assert_eq!(
                std::fs::read_to_string(&config_path).unwrap(),
                "runtime config"
            );
        }
        let cleaned =
            crate::commands::cleanup_pending_runtime_start_with(&state, |pending| async move {
                pending
                    .stop_with_cleanup(
                        stop_codex_processes(
                            &pending.app_dir,
                            pending.process_id,
                            pending.process_group_id,
                        ),
                        restore(),
                    )
                    .await
            })
            .await
            .unwrap();
        assert!(cleaned);
        assert!(state.failed_runtime_start.lock().await.is_none());
        assert!(cleanup.child.lock().await.is_none());
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            "restored config"
        );
    }
}

#[tokio::test]
async fn failed_config_restore_retains_cleanup_for_retry_after_process_stop() {
    let temp = tempfile::tempdir().unwrap();
    let cleanup = Arc::new(PendingRuntimeCleanup {
        home: temp.path().to_path_buf(),
        app_dir: temp.path().join("missing-codex-app"),
        process_id: None,
        process_group_id: None,
        child: Arc::new(Mutex::new(None)),
    });
    let error = cleanup_initial_renderer_failure(
        Arc::clone(&cleanup),
        recovery::recoverable("renderer injection failed"),
        async { Ok(()) },
        async { anyhow::bail!("restore failed") },
    )
    .await;
    let state = Arc::new(crate::commands::AppState::default());
    *state.failed_runtime_start.lock().await = PendingRuntimeCleanup::from_error(&error);
    assert!(state.failed_runtime_start.lock().await.is_some());
    assert!(!error.is::<recovery::IntegrationFailure>());
    assert!(
        crate::commands::cleanup_pending_runtime_start_with(&state, |pending| async move {
            pending
                .stop_with_cleanup(async { Ok(()) }, async { Ok(()) })
                .await
        })
        .await
        .unwrap()
    );
    assert!(state.failed_runtime_start.lock().await.is_none());
}

#[tokio::test]
async fn completed_renderer_failure_cleanup_preserves_native_fallback_cause() {
    let temp = tempfile::tempdir().unwrap();
    let cleanup = Arc::new(PendingRuntimeCleanup {
        home: temp.path().to_path_buf(),
        app_dir: temp.path().join("missing-codex-app"),
        process_id: None,
        process_group_id: None,
        child: Arc::new(Mutex::new(None)),
    });
    let restored = AtomicBool::new(false);
    let error = cleanup_initial_renderer_failure(
        cleanup,
        recovery::recoverable("renderer injection failed"),
        async { Ok(()) },
        async {
            restored.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;
    assert!(restored.load(Ordering::SeqCst));
    assert!(error.is::<recovery::IntegrationFailure>());
    assert!(PendingRuntimeCleanup::from_error(&error).is_none());
}

#[tokio::test]
async fn runtime_stop_preserves_resources_on_failure_and_allows_retry() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.toml");
    std::fs::write(&config_path, "runtime config").unwrap();
    let config = CodeyConfig::default();
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
        applied_model_config: RwLock::new(Arc::new(RuntimeModelConfig::from_config(&config))),
        applied_subagent_config: RwLock::new(Arc::new(RuntimeSubagentConfig::from_config(&config))),
        delivered_model_catalog: RwLock::new(None),
        subagent_restart_config: RwLock::new(None),
        applied_config: config,
        injection_statuses: Arc::new(RwLock::new(Arc::from([]))),
        injection_scripts: cdp::prepare_injection_scripts(false, false, false, false, &[]),
        injection_websocket_url: Arc::new(RwLock::new(Arc::from(""))),
        child,
        process_id,
        process_group_id: process_id,
        watchdog_shutdown: Mutex::new(Some(watchdog_shutdown)),
        watchdog_task: Mutex::new(Some(watchdog_task)),
        exit_watchdog_shutdown: Mutex::new(Some(exit_shutdown)),
        exit_watchdog_task: Mutex::new(Some(exit_task)),
        crashpad_guard_enabled: Arc::new(AtomicBool::new(false)),
        crashpad_guard_shutdown: Mutex::new(None),
        crashpad_guard_task: Mutex::new(None),
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

    // The real test child exits while its watcher still owns Child.
    let failure = runtime
        .stop_with_cleanup(
            stop_codex_processes(&runtime.codex_app_path, process_id, process_id),
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
    runtime
        .stop_with_cleanup(async { Ok(()) }, restore())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&config_path).unwrap(),
        "restored config"
    );
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
fn applied_role_catalog_matches_the_gate_for_models_and_reasoning() {
    let initial = CodeyConfig {
        subagent_model: "shared-model".into(),
        subagent_roles: crate::config::uniform_subagent_roles("shared-model", "high"),
        ..Default::default()
    };
    let applied = RuntimeSubagentConfig::from_config(&initial);
    let mut changed = initial.clone();
    changed
        .subagent_roles
        .get_mut("codey_worker")
        .unwrap()
        .model = "provider-custom-model".into();
    changed
        .subagent_roles
        .get_mut("codey_explorer")
        .unwrap()
        .reasoning_effort = "low".into();
    let desired = RuntimeSubagentConfig::from_config(&changed);

    assert_eq!(applied.roles, initial.subagent_roles);
    assert_eq!(desired.roles, changed.subagent_roles);
    assert_eq!(applied.model, desired.model);
    assert_ne!(applied.roles, desired.roles);
    assert_eq!(desired.roles["codey_worker"].model, "provider-custom-model");
    assert_eq!(desired.roles["codey_explorer"].reasoning_effort, "low");
}

#[tokio::test]
async fn live_role_changes_preserve_subagent_hot_reload_within_the_current_provider() {
    let initial = CodeyConfig {
        subagent_optimization: true,
        ..Default::default()
    };
    let runtime = CodeyRuntime::for_model_delivery_test(initial.clone(), "ws://unused");
    let mut latest = initial.clone();
    latest
        .subagent_roles
        .get_mut("codey_worker")
        .unwrap()
        .reasoning_effort = "low".into();
    latest
        .subagent_roles
        .get_mut("codey_explorer")
        .unwrap()
        .model = "provider-custom-model".into();
    assert_ne!(
        runtime.applied_subagent_config().await.as_ref(),
        &RuntimeSubagentConfig::from_config(&latest)
    );
    assert!(runtime.supports_subagent_config_hot_reload(&latest));
    latest.fast_context_tools = !initial.fast_context_tools;
    assert!(!runtime.supports_subagent_config_hot_reload(&latest));
}

#[test]
fn live_route_edits_preserve_subagent_hot_reload_support_within_the_current_provider() {
    let initial = CodeyConfig {
        subagent_optimization: true,
        ..Default::default()
    };
    let runtime = CodeyRuntime::for_model_delivery_test(initial.clone(), "ws://unused");
    let mut latest = initial.clone();
    let mut profile = crate::config::ProviderProfile::new("新线路名称");
    profile.base_url = "https://gateway.example/v1".into();
    latest.profiles.push(profile);
    assert!(runtime.supports_subagent_config_hot_reload(&latest));
    latest.fast_context_tools = !initial.fast_context_tools;
    assert!(!runtime.supports_subagent_config_hot_reload(&latest));
    latest.fast_context_tools = initial.fast_context_tools;
    latest.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "other",
            "https://other.example/v1",
            "responses",
            false,
        ),
    );
    assert!(!runtime.supports_subagent_config_hot_reload(&latest));
}
