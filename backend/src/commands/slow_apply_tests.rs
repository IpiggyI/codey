use super::*;

const TEST_WATCHDOG: Duration = Duration::from_secs(15);

type Reconcile = dyn Fn(&CodeyConfig) -> anyhow::Result<crate::codex_config::RuntimeSubagentReconcileReport>
    + Send
    + Sync;

#[derive(Default)]
pub(super) struct TestHooks {
    pub subagents: Option<Arc<Reconcile>>,
    pub trace_home: Option<PathBuf>,
}

async fn settled(state: &AppState) -> Value {
    tokio::time::timeout(TEST_WATCHDOG, async {
        loop {
            let result = config_apply::status(state);
            if result["state"] != "pending" {
                return result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

async fn save_without_waiting(state: &Arc<AppState>, config: CodeyConfig) -> Value {
    let result = tokio::time::timeout(TEST_WATCHDOG, save_codey_config(state, config))
        .await
        .expect("slow application must not block a subsequent save")
        .unwrap();
    assert_eq!(state.store.load().unwrap(), *state.config.read().await);
    result
}

#[tokio::test]
async fn role_worker_wait_releases_config_lock_and_does_not_mark_old_roles_applied() {
    let directory = tempfile::tempdir().unwrap();
    let config = CodeyConfig {
        subagent_optimization: true,
        local_router_enabled: false,
        ..Default::default()
    };
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered_tx = BlockingMutex::new(Some(entered_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = BlockingMutex::new(release_rx);
    let runtime = Arc::new(CodeyRuntime::for_model_delivery_test(
        config.clone(),
        "ws://unused",
    ));
    let state = Arc::new(AppState {
        store: ConfigStore::new(directory.path().join("config.json")),
        config: RwLock::new(config.clone()),
        runtime: Mutex::new(Some(runtime.clone())),
        slow_apply_test: TestHooks {
            subagents: Some(Arc::new(move |_| {
                if let Some(entered) = entered_tx.lock().unwrap().take() {
                    entered.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                Ok(Default::default())
            })),
            ..Default::default()
        },
        ..Default::default()
    });
    let delivery = tokio::spawn({
        let state = state.clone();
        async move { hot_reload_runtime_subagent_config(&state, &config).await }
    });
    entered_rx.await.unwrap();
    let mut newer = state.config.read().await.clone();
    let role = newer.subagent_roles.get_mut("codey_quick_scan").unwrap();
    role.reasoning_effort = if role.reasoning_effort == "high" {
        "low"
    } else {
        "high"
    }
    .into();
    save_without_waiting(&state, newer).await;
    *state.runtime.lock().await = None;
    release_tx.send(()).unwrap();
    assert_eq!(delivery.await.unwrap().health(), "superseded");
    let result = settled(&state).await;
    assert_ne!(result["state"], "failed", "{result}");
    assert_ne!(
        runtime.applied_subagent_config().await.as_ref(),
        &RuntimeSubagentConfig::from_config(&*state.config.read().await)
    );
}

#[tokio::test]
async fn trace_wait_does_not_block_saves_and_applies_latest_without_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let user_config = directory.path().join("config.toml");
    let original = b"# user\nmodel='user-model'\n";
    std::fs::write(&user_config, original).unwrap();
    let config = CodeyConfig {
        disable_trace_log_writes: false,
        ..Default::default()
    };
    let state = Arc::new(AppState {
        store: ConfigStore::new(directory.path().join("config.json")),
        config: RwLock::new(config.clone()),
        slow_apply_test: TestHooks {
            trace_home: Some(directory.path().into()),
            ..Default::default()
        },
        ..Default::default()
    });
    let diagnostic = state.diagnostic_storage_operation.lock().await;
    let mut enabled = config;
    enabled.disable_trace_log_writes = true;
    save_without_waiting(&state, enabled).await;
    loop {
        if state.runtime_operation.try_lock().is_err() {
            break;
        }
        tokio::task::yield_now().await;
    }
    let mut latest = state.config.read().await.clone();
    latest.disable_trace_log_writes = false;
    let saved = save_without_waiting(&state, latest).await;
    drop(diagnostic);
    let result = settled(&state).await;
    assert_eq!(result["revision"], saved["configApply"]["revision"]);
    assert_eq!(result["state"], "saved");
    assert_eq!(state.trace_log_guard_state.applied_target(), Some(false));
    assert_eq!(std::fs::read(&user_config).unwrap(), original);
    assert!(!directory.path().join("config-repair-backups").exists());
    assert!(
        !state
            .trace_log_write_protection_active
            .load(Ordering::Acquire)
    );
}

#[test]
fn background_config_apply_never_calls_user_config_repair() {
    let source = include_str!("config_apply.rs");
    assert!(!source.contains("repair_codex_config("));
    assert!(!source.contains("config.toml"));
    assert!(!source.contains("patch_config("));
}

#[tokio::test]
async fn background_apply_writes_subagent_artifacts_without_touching_user_files() {
    fn snapshot(root: &std::path::Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(
            root: &std::path::Path,
            dir: &std::path::Path,
            files: &mut BTreeMap<PathBuf, Vec<u8>>,
        ) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        std::fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut files = BTreeMap::new();
        visit(root, root, &mut files);
        files
    }
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("codex-home");
    let owned = directory.path().join("codey-state");
    std::fs::create_dir_all(&home).unwrap();
    let original = b"# user-owned\nmodel = 'user-model'\n";
    std::fs::write(home.join("config.toml"), original).unwrap();
    std::fs::write(home.join("unrelated.txt"), b"unchanged").unwrap();
    let config = CodeyConfig {
        subagent_optimization: true,
        ..Default::default()
    }
    .normalize();
    let marker = owned.join("codex-lease.json");
    crate::codex_config::prepare_subagent_apply_test(&home, &marker, &config).unwrap();
    let before = snapshot(directory.path());
    let mut applied = config.clone();
    // 阻止测试连接页面；子代理文件应用仍经过完整后台队列。
    applied
        .supports_1m_context_by_provider
        .insert("test".into(), vec!["test-model".into()]);
    let runtime = Arc::new(CodeyRuntime::for_model_delivery_test(
        applied,
        "ws://unused",
    ));
    let writes = Arc::new(AtomicBool::new(false));
    let observed = writes.clone();
    let state = Arc::new(AppState {
        store: ConfigStore::new(owned.join("config.json")),
        config: RwLock::new(config.clone()),
        runtime: Mutex::new(Some(runtime)),
        slow_apply_test: TestHooks {
            trace_home: Some(home.clone()),
            subagents: Some(Arc::new(move |config| {
                let report = crate::codex_config::reconcile_subagent_apply_test(config, &marker)?;
                observed.store(report.repaired, Ordering::Release);
                Ok(report)
            })),
        },
        ..Default::default()
    });
    let mut next = config;
    let role = next.subagent_roles.get_mut("codey_quick_scan").unwrap();
    role.reasoning_effort = if role.reasoning_effort == "high" {
        "low"
    } else {
        "high"
    }
    .into();
    save_without_waiting(&state, next).await;
    let status = settled(&state).await;
    assert_ne!(status["state"], "failed", "{status}");
    assert!(writes.load(Ordering::Acquire));
    assert_eq!(std::fs::read(home.join("config.toml")).unwrap(), original);
    let after = snapshot(directory.path());
    let changed = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        changed.iter().all(|path| path.starts_with("codey-state")
            || path.starts_with("codex-home/codey-subagent-gate-v3")),
        "{changed:?}"
    );
    assert!(
        changed
            .iter()
            .any(|path| path.starts_with("codey-state/codex-constraints/runtime/agents")),
        "{changed:?}"
    );
}

#[tokio::test]
async fn trace_failure_keeps_saved_target_and_retries_without_rescanning_success() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().join("trace-home");
    std::fs::write(&home, "not a directory").unwrap();
    let state = Arc::new(AppState {
        store: ConfigStore::new(directory.path().join("config.json")),
        config: RwLock::new(CodeyConfig {
            disable_trace_log_writes: false,
            ..Default::default()
        }),
        slow_apply_test: TestHooks {
            trace_home: Some(home.clone()),
            ..Default::default()
        },
        ..Default::default()
    });
    let mut enabled = state.config.read().await.clone();
    enabled.disable_trace_log_writes = true;
    save_without_waiting(&state, enabled).await;
    assert_eq!(settled(&state).await["state"], "failed");
    assert!(state.store.load().unwrap().disable_trace_log_writes);
    assert!(
        !state
            .trace_log_write_protection_active
            .load(Ordering::Acquire)
    );
    std::fs::remove_file(&home).unwrap();
    std::fs::create_dir(&home).unwrap();
    let current = state.config.read().await.clone();
    save_without_waiting(&state, current).await;
    assert_eq!(settled(&state).await["state"], "saved");
    assert_eq!(state.trace_log_guard_state.applied_target(), Some(true));
    assert!(
        !state
            .trace_log_write_protection_active
            .load(Ordering::Acquire)
    );
    std::fs::remove_dir(&home).unwrap();
    std::fs::write(&home, "not a directory").unwrap();
    let current = state.config.read().await.clone();
    save_without_waiting(&state, current).await;
    assert_eq!(settled(&state).await["state"], "saved");
}
