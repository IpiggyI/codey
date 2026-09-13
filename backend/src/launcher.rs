#[cfg(all(test, unix))]
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use anyhow::{Context, Result};
use codey_runtime_core::app_paths::resolve_codex_app_dir_with_saved;
use codey_runtime_core::launcher::build_codex_command;
use serde::Serialize;
use tokio::process::Child;
#[cfg(not(windows))]
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock, oneshot};

use crate::cdp;
use crate::codex_config::{
    ConfiguredModelCatalog, RuntimeRouterConfigOptions, apply_runtime_router_config, codex_home,
    restore_runtime_config as restore_codex_runtime_config,
};
use crate::config::{CodeyConfig, GpuLaunchMode, ProviderProfile, RuntimeModelTarget};
use crate::crashpad_pending_guard::{self, CrashpadPendingStatsHandle};
use crate::error_log;
use crate::maintenance_lock;
use crate::message_delete;
use crate::model_catalog;
use crate::model_id;
use crate::pet_slim_patch;
use crate::session_index_cleanup::{self, SessionIndexCleanupReport};
use crate::subagent_policy;
use crate::trace_log_guard;

mod platform;
mod process;

use platform::*;
#[cfg(windows)]
pub(crate) use process::windows_cli_wrapper_target;
use process::{
    SpawnedCodex, prepare_codex_for_launch, reap_child_after_cleanup, spawn_codex,
    spawn_codex_exit_watcher,
};
#[cfg(test)]
use process::{codex_runtime_arguments, gpu_launch_arguments};

const CDP_WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);
const CDP_WATCHDOG_FAILURE_THRESHOLD: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InjectionHealth {
    Healthy,
    Unhealthy,
    Inconclusive,
    TargetUnavailable,
}
pub const CODEX_APP_NOT_FOUND_ERROR: &str = "找不到 Codex 桌面应用";
pub const CODEX_APP_PATH_INVALID_ERROR: &str = "配置的 Codex App 路径无效或指向了 Codex CLI；请选择 Codex 桌面 App，不要选择 codex.exe 命令行程序";
const DISABLE_GPU_ARGUMENT: &str = "--disable-gpu";
const DISABLE_GPU_RASTERIZATION_ARGUMENT: &str = "--disable-gpu-rasterization";
const DISABLE_BACKGROUND_ECOQOS_ARGUMENT: &str = "--disable-features=UseEcoQoSForBackgroundProcess";
const DEFAULT_CHINESE_LOCALE_ARGUMENT: &str = "--lang=zh-CN";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStatus {
    pub session_status: String,
    pub session_files_fixed: usize,
    pub sqlite_rows_updated: usize,
    pub ghost_tasks_pruned: usize,
    pub performance_status: String,
    pub performance_detail: String,
}

struct SessionMaintenanceSummary {
    status: String,
    files_fixed: usize,
    sqlite_rows_updated: usize,
    ghost_tasks_pruned: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeModelConfig {
    selected_models_by_provider: std::collections::BTreeMap<String, Vec<String>>,
    supports_1m_context_by_provider: std::collections::BTreeMap<String, Vec<String>>,
    model_context_by_provider: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<String, crate::config::ModelContextConfig>,
    >,
    manual_third_party_models_by_provider: std::collections::BTreeMap<String, Vec<String>>,
    declared_official_models_by_provider: std::collections::BTreeMap<String, Vec<String>>,
    upstream_models_by_provider: std::collections::BTreeMap<String, Vec<String>>,
    default_model: String,
}

impl RuntimeModelConfig {
    pub fn from_config(config: &CodeyConfig) -> Self {
        Self {
            selected_models_by_provider: config.selected_models_by_provider.clone(),
            supports_1m_context_by_provider: config.supports_1m_context_by_provider.clone(),
            model_context_by_provider: config.model_context_by_provider.clone(),
            manual_third_party_models_by_provider: config
                .manual_third_party_models_by_provider
                .clone(),
            declared_official_models_by_provider: config
                .declared_official_models_by_provider
                .clone(),
            upstream_models_by_provider: config.upstream_models_by_provider.clone(),
            default_model: config.default_model.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeSubagentConfig {
    model: String,
    reasoning_effort: String,
    roles: std::collections::BTreeMap<String, crate::config::SubagentRoleConfig>,
}

impl RuntimeSubagentConfig {
    pub fn from_config(config: &CodeyConfig) -> Self {
        Self {
            model: config.subagent_model.clone(),
            reasoning_effort: config.subagent_reasoning_effort.clone(),
            roles: config.subagent_roles.clone(),
        }
    }
}

pub struct CodeyRuntime {
    pub codex_app_path: PathBuf,
    pub maintenance: MaintenanceStatus,
    pub applied_config: CodeyConfig,
    applied_model_config: RwLock<RuntimeModelConfig>,
    applied_subagent_config: RwLock<RuntimeSubagentConfig>,
    pub injection_statuses: Arc<RwLock<Arc<[cdp::InjectionScriptStatus]>>>,
    injection_scripts: cdp::PreparedInjectionScripts,
    injection_websocket_url: Arc<RwLock<Arc<str>>>,
    child: Arc<Mutex<Option<Child>>>,
    process_id: Option<u32>,
    #[cfg(unix)]
    process_group_id: Option<u32>,
    #[cfg(target_os = "macos")]
    inspector_argument: Option<String>,
    watchdog_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    watchdog_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    exit_watchdog_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    exit_watchdog_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    crashpad_guard_enabled: Arc<AtomicBool>,
    crashpad_guard_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    crashpad_guard_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

async fn run_startup_session_maintenance(
    home: &std::path::Path,
) -> Result<SessionMaintenanceSummary> {
    let maintenance_home = home.to_path_buf();
    let maintenance_result = tokio::task::spawn_blocking(move || {
        let stale_lock_recovery = maintenance_lock::recover_stale_locks(&maintenance_home);
        // A loaded Codex thread may have flushed a deleted turn after the live
        // request completed. Reapply durable tombstones after the old process
        // is stopped and before the new process can hydrate that stale data.
        let message_delete_replay = message_delete::reapply_persisted_deletions(&maintenance_home);
        // `session_index.jsonl` is also cleaned before spawn, while its
        // source snapshot is stable. The original file is backed up.
        let index_cleanup = session_index_cleanup::cleanup(&maintenance_home);
        (stale_lock_recovery, message_delete_replay, index_cleanup)
    })
    .await;
    let (stale_lock_recovery, message_delete_replay, index_cleanup) = match maintenance_result {
        Ok(result) => result,
        Err(error) => {
            let error = anyhow::Error::new(error).context("启动前会话维护任务异常退出");
            error_log::record_failure(
                "patch_failed",
                "run_startup_session_maintenance",
                format!("{error:#}"),
                serde_json::json!({
                    "codexHome": home,
                }),
            );
            return Err(error);
        }
    };
    match stale_lock_recovery {
        Ok(recovered) => {
            for path in recovered {
                eprintln!("已清理陈旧维护锁：{}", path.display());
            }
        }
        Err(error) => {
            error_log::record_failure(
                "patch_failed",
                "recover_stale_maintenance_locks",
                format!("{error:#}"),
                serde_json::json!({
                    "codexHome": home,
                }),
            );
            eprintln!("清理陈旧维护锁失败：{error:#}");
        }
    }
    match message_delete_replay {
        Ok(summary) => {
            if summary.deleted > 0 {
                eprintln!(
                    "启动前重新清理了 {} 个已删除对话轮（{} 个会话）",
                    summary.deleted, summary.cleared_sessions
                );
            }
            for (session_id, message) in summary.failures {
                error_log::record_failure(
                    "patch_failed",
                    "reapply_message_deletion",
                    message,
                    serde_json::json!({
                        "sessionId": session_id,
                    }),
                );
            }
        }
        Err(error) => {
            error_log::record_failure(
                "patch_failed",
                "reapply_message_deletions",
                format!("{error:#}"),
                serde_json::json!({
                    "codexHome": home,
                }),
            );
            eprintln!("启动前重施消息删除失败：{error:#}");
        }
    }
    if let Err(error) = &index_cleanup {
        error_log::record_failure(
            "patch_failed",
            "cleanup_session_index",
            format!("{error:#}"),
            serde_json::json!({
                "codexHome": home,
            }),
        );
    }
    Ok(session_maintenance_summary(&index_cleanup))
}

async fn resolve_configured_codex_app_dir(config: &CodeyConfig) -> Result<PathBuf> {
    let configured_app_path = config.codex_app_path.trim();
    let configured_app_path_is_empty = configured_app_path.is_empty();
    let configured_app_path =
        (!configured_app_path_is_empty).then(|| PathBuf::from(configured_app_path));
    tokio::task::spawn_blocking(move || {
        resolve_codex_app_dir_with_saved(configured_app_path.as_deref(), None)
    })
    .await
    .map_err(|error| anyhow::Error::new(error).context("定位 Codex App 任务异常退出"))?
    .ok_or_else(|| {
        if configured_app_path_is_empty {
            anyhow::anyhow!(CODEX_APP_NOT_FOUND_ERROR)
        } else {
            anyhow::anyhow!(CODEX_APP_PATH_INVALID_ERROR)
        }
    })
}

struct StartupModelCatalog {
    model_catalog_path: Option<PathBuf>,
    model_state: model_catalog::ModelSelectionState,
}

struct PreparedCodexStartupState {
    runtime_config: CodeyConfig,
    runtime_config_overrides: Vec<String>,
}

fn runtime_subagent_model(
    model: &str,
    catalog: &subagent_policy::SubagentCatalogSnapshot,
) -> String {
    let requested = model.trim();
    catalog
        .canonical_model(requested)
        .unwrap_or(requested)
        .to_string()
}

fn should_install_codey_model_catalog(
    official_only: bool,
    catalog_available: bool,
    custom_context: bool,
) -> bool {
    (!official_only || custom_context) && catalog_available
}

#[test]
fn model_context_explicit_official_budget_requires_generated_catalog() {
    assert!(!should_install_codey_model_catalog(true, true, false));
    assert!(should_install_codey_model_catalog(true, true, true));
    assert!(!should_install_codey_model_catalog(true, false, true));
    assert!(should_install_codey_model_catalog(false, true, false));
}

fn should_inject_runtime_model_catalog(
    user_catalog_configured: bool,
    leftover_codey_catalog: bool,
    official_only: bool,
    catalog_available: bool,
    custom_context: bool,
) -> bool {
    user_catalog_configured
        || (leftover_codey_catalog && catalog_available)
        || should_install_codey_model_catalog(official_only, catalog_available, custom_context)
}

fn runtime_default_model(
    config: &CodeyConfig,
    codey_catalog_installed: bool,
    model_state: &model_catalog::ModelSelectionState,
) -> Option<String> {
    let model = if codey_catalog_installed {
        config.default_model().unwrap_or(&model_state.default_model)
    } else {
        // Official-account-only launches keep Codex's built-in catalog.
        &model_state.default_model
    };
    let model = model.trim();
    (!model.is_empty()).then(|| model.to_string())
}

async fn prepare_startup_model_catalog(
    config: &CodeyConfig,
    home: &std::path::Path,
) -> Result<StartupModelCatalog> {
    let catalog_home = home.to_path_buf();
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    let catalog_source =
        crate::codex_config::configured_model_catalog(&catalog_home, &catalog_dir)?;
    let leftover_codey_catalog = matches!(catalog_source, ConfiguredModelCatalog::CodeyOwned);
    let user_catalog = match catalog_source {
        ConfiguredModelCatalog::User(path) => Some(path),
        ConfiguredModelCatalog::Unset | ConfiguredModelCatalog::CodeyOwned => None,
    };
    let user_catalog_configured = user_catalog.is_some();
    let official_provider = config
        .current_provider_snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.uses_official_account_auth)
        && config.official_account_available_this_launch;
    let current_provider_is_third_party = config.current_provider_is_third_party();
    let (runtime_upstream_models, runtime_selected_models) = config.runtime_catalog_models();
    let runtime_websocket_models = config.runtime_websocket_model_aliases();
    let runtime_native_web_search_models = config.runtime_native_web_search_model_aliases();
    let refresh_official_provider =
        config.official_account_available_this_launch && !current_provider_is_third_party;
    let refresh_upstream_models =
        current_provider_is_third_party.then_some(runtime_upstream_models);
    let list_key = config
        .current_model_list_key()
        .unwrap_or_default()
        .to_string();
    let upstream_models = config.upstream_models_by_provider.get(&list_key).cloned();
    let selected_models = if official_provider {
        config
            .selected_models_by_provider
            .get(&list_key)
            .cloned()
            .unwrap_or_default()
    } else {
        config.enabled_route_models(&list_key)
    };
    let manual_models = config
        .manual_third_party_models_by_provider
        .get(&list_key)
        .cloned()
        .unwrap_or_default();
    let requested_default_model = config.default_model().map(str::to_string);
    let catalog_dir_for_refresh = catalog_dir.clone();
    let user_catalog_for_refresh = user_catalog.clone();
    let (refresh_result, catalog_available, selection_result) =
        tokio::task::spawn_blocking(move || {
            let refresh = model_catalog::refresh_catalog(model_catalog::CatalogRefreshArgs {
                codex_home: &catalog_home,
                catalog_dir: &catalog_dir_for_refresh,
                official_provider: refresh_official_provider,
                upstream_models: refresh_upstream_models.as_deref(),
                selected_models: &runtime_selected_models,
                websocket_models: Some(&runtime_websocket_models),
                native_web_search_models: Some(&runtime_native_web_search_models),
                user_catalog: user_catalog_for_refresh.as_deref(),
            });
            let catalog_available =
                refresh.is_err() && model_catalog::is_available(&catalog_dir_for_refresh);
            let selection = model_catalog::selection_state_with_manual_models(
                &catalog_home,
                &catalog_dir_for_refresh,
                official_provider,
                upstream_models.as_deref(),
                &selected_models,
                &manual_models,
                requested_default_model.as_deref(),
            );
            (refresh, catalog_available, selection)
        })
        .await
        .map_err(|error| {
            let error = anyhow::Error::new(error).context("准备模型目录任务异常退出");
            error_log::record_failure(
                "patch_failed",
                "prepare_model_catalog",
                format!("{error:#}"),
                serde_json::json!({
                    "officialProvider": official_provider,
                    "taskJoinFailed": true,
                }),
            );
            error
        })?;

    if let (true, Err(error)) = (user_catalog_configured, &refresh_result) {
        error_log::record_failure(
            "patch_failed",
            "refresh_model_catalog",
            format!("{error:#}"),
            serde_json::json!({
                "fallback": "none",
                "userModelCatalog": true,
                "officialProvider": official_provider,
            }),
        );
        anyhow::bail!("无法根据用户模型目录生成派生副本：{error:#}");
    }

    let catalog_available_for_runtime = match refresh_result {
        // Codex rejects an empty catalog even when writing it succeeded.
        Ok(count) => count > 0,
        Err(error) if model_catalog::is_runtime_model_cache_unavailable(&error) => {
            if catalog_available {
                eprintln!("本机官方模型缓存暂不含自定义目录必需字段，沿用上一份合法镜像");
            } else {
                eprintln!("本机官方模型缓存暂不含自定义目录必需字段，使用 Codex 内置模型目录");
            }
            catalog_available
        }
        Err(error) if catalog_available => {
            error_log::record_failure(
                "patch_failed",
                "refresh_model_catalog",
                format!("{error:#}"),
                serde_json::json!({
                    "fallback": "last_valid_catalog",
                    "officialProvider": official_provider,
                }),
            );
            eprintln!("刷新官方账号模型目录失败，沿用上一份合法镜像：{error:#}");
            true
        }
        Err(error) => {
            error_log::record_failure(
                "patch_failed",
                "refresh_model_catalog",
                format!("{error:#}"),
                serde_json::json!({
                    "fallback": "codex_builtin_catalog",
                    "officialProvider": official_provider,
                }),
            );
            eprintln!("刷新官方账号模型目录失败，临时使用 Codex 内置目录：{error:#}");
            false
        }
    };
    // Official OpenAI routes should inherit Codex's built-in model metadata,
    // including its context window and automatic-compaction defaults. Codey's
    // generated catalog remains necessary for third-party model filtering and
    // synthetic model entries. A user-supplied model_catalog_json always
    // installs the derived copy so Codex never reads the user file.
    let install_codey_catalog = should_inject_runtime_model_catalog(
        user_catalog_configured,
        leftover_codey_catalog,
        !current_provider_is_third_party,
        catalog_available_for_runtime,
        !config.runtime_model_contexts().is_empty(),
    );
    let model_catalog_path = install_codey_catalog
        .then(|| crate::model_catalog_store::derived_catalog_path(&catalog_dir));
    let model_state = match selection_result {
        Ok(state) => state,
        Err(error) => {
            error_log::record_failure(
                "patch_failed",
                "read_model_catalog_selection",
                format!("{error:#}"),
                serde_json::json!({
                    "fallback": "empty_default_model",
                    "officialProvider": official_provider,
                }),
            );
            model_catalog::ModelSelectionState::default()
        }
    };
    Ok(StartupModelCatalog {
        model_catalog_path,
        model_state,
    })
}

async fn prepare_codex_startup_state(
    config: &CodeyConfig,
    home: &std::path::Path,
    startup_catalog: StartupModelCatalog,
) -> Result<PreparedCodexStartupState> {
    let StartupModelCatalog {
        model_catalog_path,
        model_state,
    } = startup_catalog;
    let runtime_config_home = home.to_path_buf();
    let runtime_default_model =
        runtime_default_model(config, model_catalog_path.is_some(), &model_state);
    let fast_context_tools = config.fast_context_tools;
    let mut runtime_subagent_config = config.clone();
    subagent_policy::reconcile_with_model_state(&mut runtime_subagent_config, Some(&model_state));
    let subagent_catalog = subagent_policy::catalog_snapshot_for_config(&runtime_subagent_config);
    let subagent_optimization = runtime_subagent_config.subagent_optimization;
    let subagent_model =
        runtime_subagent_model(&runtime_subagent_config.subagent_model, &subagent_catalog);
    let subagent_reasoning_effort = runtime_subagent_config.subagent_reasoning_effort.clone();
    let mut subagent_roles = runtime_subagent_config.subagent_roles.clone();
    for selection in subagent_roles.values_mut() {
        selection.model = runtime_subagent_model(&selection.model, &subagent_catalog);
    }
    let runtime_config = tokio::task::spawn_blocking(move || {
        apply_runtime_router_config(
            &runtime_config_home,
            RuntimeRouterConfigOptions {
                model_catalog_path: model_catalog_path.as_deref(),
                default_model: runtime_default_model.as_deref(),
                fast_context_tools,
                subagent_optimization,
                subagent_model: &subagent_model,
                subagent_reasoning_effort: &subagent_reasoning_effort,
                subagent_roles: Some(&subagent_roles),
                subagent_catalog,
            },
        )
    })
    .await
    .map_err(|error| {
        let error = anyhow::Error::new(error).context("应用运行时 Provider 配置任务异常退出");
        error_log::record_failure(
            "patch_failed",
            "apply_runtime_router_config",
            format!("{error:#}"),
            serde_json::json!({
                "provider": config.current_provider_id(),
                "fastContextTools": config.fast_context_tools,
                "subagentOptimization": config.subagent_optimization,
                "taskJoinFailed": true,
            }),
        );
        error
    })?;
    let applied = runtime_config.map_err(|error| {
        error_log::record_failure(
            "patch_failed",
            "apply_runtime_router_config",
            format!("{error:#}"),
            serde_json::json!({
                "provider": config.current_provider_id(),
                "fastContextTools": config.fast_context_tools,
                "subagentOptimization": config.subagent_optimization,
            }),
        );
        error
    })?;
    runtime_subagent_config.fast_context_tools = applied.fast_context_tools_active;
    Ok(PreparedCodexStartupState {
        runtime_config: runtime_subagent_config,
        runtime_config_overrides: applied.runtime_config_overrides,
    })
}

async fn await_initial_storage_guards(
    initial_trace_guard: tokio::task::JoinHandle<Result<trace_log_guard::TraceLogGuardReport>>,
    disable_trace_log_writes: bool,
    trace_log_write_protection_active: &AtomicBool,
    initial_crashpad_guard: tokio::task::JoinHandle<crashpad_pending_guard::CrashpadGuardRun>,
    protect_crashpad_pending: bool,
    crashpad_pending_stats: &CrashpadPendingStatsHandle,
) -> Result<()> {
    let (trace_result, crashpad_result) = tokio::join!(initial_trace_guard, initial_crashpad_guard);
    let trace_result = match trace_result {
        Ok(Ok(report)) => {
            trace_log_write_protection_active.store(
                report.protection_active(disable_trace_log_writes),
                Ordering::Release,
            );
            Ok(())
        }
        Ok(Err(error)) => {
            error_log::record_failure(
                "patch_failed",
                "configure_trace_log_guard",
                format!("{error:#}"),
                serde_json::json!({
                    "disabled": disable_trace_log_writes,
                }),
            );
            Err(error)
        }
        Err(error) => {
            let error = anyhow::Error::new(error).context("Trace 日志保护切换任务异常退出");
            error_log::record_failure(
                "patch_failed",
                "configure_trace_log_guard",
                format!("{error:#}"),
                serde_json::json!({
                    "disabled": disable_trace_log_writes,
                }),
            );
            Err(error)
        }
    };

    match crashpad_result {
        Ok(run) => {
            if !run.cleanup.errors.is_empty() || run.cleanup.still_over_limit {
                error_log::record_failure(
                    "cleanup_failed",
                    "enforce_crashpad_pending_limit_at_startup",
                    if run.cleanup.still_over_limit {
                        "Crashpad pending 仍超过安全上限".to_string()
                    } else {
                        format!(
                            "{} 个 Crashpad 待处理文件未能完成收敛",
                            run.cleanup.errors.len()
                        )
                    },
                    serde_json::json!({
                        "errorCount": run.cleanup.errors.len(),
                        "stillOverLimit": run.cleanup.still_over_limit,
                        "bytesReclaimed": run.cleanup.bytes_reclaimed,
                    }),
                );
            }
            crashpad_pending_stats.replace(run.snapshot);
        }
        Err(error) => {
            let error = format!("Crashpad 磁盘保护任务异常退出：{error}");
            error_log::record_failure(
                "cleanup_failed",
                "enforce_crashpad_pending_limit_at_startup",
                error.clone(),
                serde_json::json!({
                    "taskJoinFailed": true,
                }),
            );
            let mut snapshot = crashpad_pending_guard::CrashpadPendingStatsSnapshot::idle(
                protect_crashpad_pending,
            );
            snapshot.errors.push(error);
            crashpad_pending_stats.replace(snapshot);
        }
    }
    trace_result
}

type PetSlimTaskResult =
    std::result::Result<Result<pet_slim_patch::PetSlimReport>, tokio::task::JoinError>;

async fn configure_startup_pet(home: &std::path::Path, slim_codex_pet: bool) -> PetSlimTaskResult {
    let pet_home = home.to_path_buf();
    tokio::task::spawn_blocking(move || pet_slim_patch::configure(&pet_home, slim_codex_pet)).await
}

async fn stop_runtime_watcher(
    shutdown: &Mutex<Option<oneshot::Sender<()>>>,
    task: &Mutex<Option<tokio::task::JoinHandle<()>>>,
    failure_event: &'static str,
    failure_operation: &'static str,
    failure_message: &'static str,
) {
    if let Some(sender) = shutdown.lock().await.take() {
        let _ = sender.send(());
    }
    let task = task.lock().await.take();
    if let Some(task) = task
        && let Err(error) = task.await
    {
        error_log::record_failure(
            failure_event,
            failure_operation,
            error.to_string(),
            serde_json::json!({}),
        );
        eprintln!("{failure_message}：{error}");
    }
}

async fn stop_codex_processes(
    app_dir: &std::path::Path,
    process_id: Option<u32>,
    #[cfg(unix)] process_group_id: Option<u32>,
    #[cfg(target_os = "macos")] inspector_argument: Option<&str>,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        if let Some(inspector_argument) = inspector_argument {
            return stop_macos_codex(inspector_argument, app_dir, process_id, process_group_id)
                .await;
        }
        terminate_unix_codex_processes(app_dir, process_id, process_group_id, None)
            .await
            .map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        terminate_unix_codex_processes(app_dir, process_id, process_group_id, None)
            .await
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        terminate_windows_codex_processes(app_dir, process_id).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (app_dir, process_id);
        Ok(())
    }
}

fn injection_failure_cleanup_operation() -> &'static str {
    #[cfg(windows)]
    {
        "cleanup_windows_after_injection_failure"
    }
    #[cfg(target_os = "macos")]
    {
        "cleanup_macos_after_injection_failure"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "cleanup_unix_after_injection_failure"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "cleanup_after_injection_failure"
    }
}

async fn inject_initial_renderer(
    debug_port: u16,
    handler: codey_runtime_core::bridge::BridgeHandler,
    injection_scripts: &cdp::PreparedInjectionScripts,
    app_dir: &std::path::Path,
    home: &std::path::Path,
    spawned: &SpawnedCodex,
    child: &Arc<Mutex<Option<Child>>>,
) -> Result<cdp::InjectedTarget> {
    let failure = match cdp::retry_inject_with_scripts(debug_port, handler, injection_scripts).await
    {
        Ok(target) => return Ok(target),
        Err(failure) => failure,
    };
    let error_message = format!("{failure:#}");
    let failure_metadata = error_log::FailureMetadata {
        stage: Some("startup.renderer_injection".to_string()),
        recoverable: Some(false),
    };
    let mut error = failure.into_error();
    error_log::record_failure_with_metadata(
        "injection_failed",
        "inject_cdp_bridge",
        error_message,
        failure_metadata,
        serde_json::json!({
            "appPath": app_dir,
            "debugPort": debug_port,
            "processId": spawned.process_id,
        }),
    );

    if let Err(stop_error) = stop_codex_processes(
        app_dir,
        spawned.process_id,
        #[cfg(unix)]
        spawned.process_group_id,
        #[cfg(target_os = "macos")]
        spawned.inspector_argument.as_deref(),
    )
    .await
    {
        let context = serde_json::json!({
            "appPath": app_dir,
            "processId": spawned.process_id,
        });
        #[cfg(unix)]
        let context = {
            let mut context = context;
            if let Some(context) = context.as_object_mut() {
                context.insert(
                    "processGroupId".to_string(),
                    serde_json::json!(spawned.process_group_id),
                );
            }
            context
        };
        error_log::record_failure(
            "cleanup_failed",
            injection_failure_cleanup_operation(),
            format!("{stop_error:#}"),
            context,
        );
        eprintln!("Codex 注入失败后的进程清理失败：{stop_error:#}");
        error = anyhow::anyhow!(
            "{error:#}；Codex 注入失败后的进程清理失败，请退出残留 Codex 后重试：{stop_error:#}"
        );
    }
    if let Some(child) = child.lock().await.take() {
        reap_child_after_cleanup(child, "reap_child_after_injection_failure").await;
    }
    Err(restore_runtime_config_after_error(home, error).await)
}

struct InjectionWatchdog {
    statuses: Arc<RwLock<Arc<[cdp::InjectionScriptStatus]>>>,
    websocket_url: Arc<RwLock<Arc<str>>>,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

fn spawn_injection_watchdog(
    injected_target: cdp::InjectedTarget,
    debug_port: u16,
    handler: codey_runtime_core::bridge::BridgeHandler,
    injection_scripts: cdp::PreparedInjectionScripts,
) -> InjectionWatchdog {
    let statuses = Arc::new(RwLock::new(injected_target.injection_statuses()));
    let websocket_url = Arc::new(RwLock::new(injected_target.websocket_url_arc()));
    let (shutdown, mut shutdown_rx) = oneshot::channel();
    let watchdog_statuses = statuses.clone();
    let watchdog_websocket_url = websocket_url.clone();
    let watchdog_scripts = injection_scripts;
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(CDP_WATCHDOG_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        let mut target = injected_target;
        let mut consecutive_failures = 0u8;
        'watchdog: loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => break,
                _ = interval.tick() => {}
            }
            let health = tokio::select! {
                biased;
                _ = &mut shutdown_rx => break 'watchdog,
                result = cdp::is_target_healthy(&target) => {
                    match result {
                        Ok(cdp::TargetHealth::Disconnected) => InjectionHealth::TargetUnavailable,
                        Ok(cdp::TargetHealth::Healthy) => InjectionHealth::Healthy,
                        Ok(cdp::TargetHealth::Unhealthy) => InjectionHealth::Unhealthy,
                        Ok(cdp::TargetHealth::Busy) => {
                            // The renderer answered CDP but the in-page bridge
                            // round-trip missed its budget: the bridge is still
                            // installed, the page is just busy. Reinjecting
                            // would pile more script work onto a stalled page.
                            InjectionHealth::Inconclusive
                        }
                        Err(error) => {
                            let requires_rediscovery =
                                cdp::target_health_error_requires_rediscovery(&error);
                            error_log::record_failure_async(
                                "injection_health_check_failed",
                                "check_cdp_bridge_health",
                                format!("{error:#}"),
                                serde_json::json!({
                                    "websocketUrl": target.websocket_url(),
                                    "requiresTargetRediscovery": requires_rediscovery,
                                }),
                            )
                            .await;
                            if requires_rediscovery {
                                // The saved /devtools/page endpoint no longer
                                // accepts CDP traffic. Rediscover immediately;
                                // retrying this URL cannot repair a replaced
                                // Windows renderer target.
                                InjectionHealth::TargetUnavailable
                            } else {
                                // A busy renderer can miss the diagnostic
                                // deadline while its bridge remains installed.
                                // Reinjecting in that state adds more CDP/script
                                // work to an already stalled page.
                                InjectionHealth::Inconclusive
                            }
                        }
                    }
                }
            };
            if !watchdog_should_reinject(&mut consecutive_failures, health) {
                continue;
            }
            let reinjection = tokio::select! {
                biased;
                _ = &mut shutdown_rx => break 'watchdog,
                result = cdp::retry_inject_with_scripts(
                    debug_port,
                    handler.clone(),
                    &watchdog_scripts,
                ) => result,
            };
            match reinjection {
                Ok(reinjected) => {
                    let next_statuses = reinjected.injection_statuses();
                    let next_websocket_url = reinjected.websocket_url_arc();
                    let previous = std::mem::replace(&mut target, reinjected);
                    *watchdog_statuses.write().await = next_statuses;
                    *watchdog_websocket_url.write().await = next_websocket_url;
                    previous.close().await;
                    consecutive_failures = 0;
                }
                Err(error) => {
                    let error_message = format!("{error:#}");
                    error_log::record_failure_with_metadata_async(
                        "injection_failed",
                        "reinject_cdp_bridge",
                        error_message.clone(),
                        error_log::FailureMetadata {
                            stage: Some("runtime.renderer_reinjection".to_string()),
                            recoverable: Some(true),
                        },
                        serde_json::json!({
                            "debugPort": debug_port,
                        }),
                    )
                    .await;
                    *watchdog_statuses.write().await = watchdog_scripts
                        .statuses_with_error(format!("脚本重新注入失败：{error_message}"));
                    eprintln!("Codey CDP bridge 恢复失败：{error_message}");
                    consecutive_failures = CDP_WATCHDOG_FAILURE_THRESHOLD.saturating_sub(1);
                }
            }
        }
        target.close().await;
    });
    InjectionWatchdog {
        statuses,
        websocket_url,
        shutdown,
        task,
    }
}

struct InitialStorageGuards {
    trace: tokio::task::JoinHandle<Result<trace_log_guard::TraceLogGuardReport>>,
    crashpad: tokio::task::JoinHandle<crashpad_pending_guard::CrashpadGuardRun>,
}

struct StartupStorageState {
    app_dir: PathBuf,
    session_maintenance: SessionMaintenanceSummary,
}

struct PreparedProviderState {
    runtime_config: CodeyConfig,
    runtime_config_overrides: Vec<String>,
}

struct StartupPatchState {
    debug_port: u16,
}

struct SpawnedRenderer {
    app_dir: PathBuf,
    spawned: SpawnedCodex,
    child: Arc<Mutex<Option<Child>>>,
    maintenance: MaintenanceStatus,
    injected_target: cdp::InjectedTarget,
}

struct RuntimeWatchers {
    injection_statuses: Arc<RwLock<Arc<[cdp::InjectionScriptStatus]>>>,
    injection_websocket_url: Arc<RwLock<Arc<str>>>,
    watchdog_shutdown: oneshot::Sender<()>,
    watchdog_task: tokio::task::JoinHandle<()>,
    crashpad_guard_enabled: Arc<AtomicBool>,
    crashpad_guard_shutdown: oneshot::Sender<()>,
    crashpad_guard_task: tokio::task::JoinHandle<()>,
    exit_watchdog_shutdown: oneshot::Sender<()>,
    exit_watchdog_task: tokio::task::JoinHandle<()>,
    codex_exit: oneshot::Receiver<()>,
}

struct RuntimeWatcherInputs {
    injected_target: cdp::InjectedTarget,
    debug_port: u16,
    handler: codey_runtime_core::bridge::BridgeHandler,
    injection_scripts: cdp::PreparedInjectionScripts,
    child: Arc<Mutex<Option<Child>>>,
    process_id: Option<u32>,
    protect_crashpad_pending: bool,
    crashpad_pending_stats: CrashpadPendingStatsHandle,
}

fn spawn_initial_storage_guards(
    home: &std::path::Path,
    config: &CodeyConfig,
) -> InitialStorageGuards {
    let trace_guard_home = home.to_path_buf();
    let disable_trace_log_writes = config.disable_trace_log_writes;
    let trace = tokio::task::spawn_blocking(move || {
        trace_log_guard::configure(&trace_guard_home, disable_trace_log_writes)
    });
    let protect_crashpad_pending = config.protect_crashpad_pending;
    let crashpad = tokio::task::spawn_blocking(move || {
        if protect_crashpad_pending {
            crashpad_pending_guard::enforce_system_limit()
        } else {
            crashpad_pending_guard::CrashpadGuardRun {
                cleanup: crashpad_pending_guard::CrashpadCleanupReport::default(),
                snapshot: crashpad_pending_guard::snapshot_system(false),
            }
        }
    });
    InitialStorageGuards { trace, crashpad }
}

fn resolve_startup_provider(config: &CodeyConfig) -> Result<()> {
    let snapshot = config.current_provider_snapshot.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "找不到当前 Codex Provider。请先在 Codex 的 config.toml 中配置 model_provider。"
        )
    })?;
    if snapshot.uses_official_account_auth && !config.official_account_available_this_launch {
        anyhow::bail!("当前 Provider 需要官方账号登录，但本次 Codex 启动未检测到可用的官方登录态");
    }
    Ok(())
}

async fn prepare_startup_storage(
    home: &std::path::Path,
    config: &CodeyConfig,
    _current_profile: Option<&ProviderProfile>,
    guards: InitialStorageGuards,
    trace_log_write_protection_active: &AtomicBool,
    crashpad_pending_stats: &CrashpadPendingStatsHandle,
) -> Result<(StartupStorageState, Option<StartupModelCatalog>)> {
    let preparation = async {
        let app_dir = resolve_configured_codex_app_dir(config).await?;
        // Session repair must never race a live Codex writer. Stopping the old
        // runtime first also gives SQLite and rollout buffers a chance to flush
        // before any permanent maintenance is applied.
        prepare_codex_for_launch(&app_dir).await?;

        // Keep each task's saved provider. Historical session ownership is left
        // unchanged. The catalog touches separate files, so prepare it alongside
        // session maintenance after Codex has stopped.
        let (session_maintenance, startup_catalog) =
            tokio::join!(run_startup_session_maintenance(home), async {
                prepare_startup_model_catalog(config, home).await.map(Some)
            });
        Ok::<_, anyhow::Error>((
            StartupStorageState {
                app_dir,
                session_maintenance: session_maintenance?,
            },
            startup_catalog?,
        ))
    };
    let storage_guards = await_initial_storage_guards(
        guards.trace,
        config.disable_trace_log_writes,
        trace_log_write_protection_active,
        guards.crashpad,
        config.protect_crashpad_pending,
        crashpad_pending_stats,
    );
    // A failed preparation must still finish the already-started blocking
    // guards and publish their status before the caller can retry or exit.
    let (preparation, storage_guards) = tokio::join!(preparation, storage_guards);
    let prepared = preparation?;
    storage_guards?;
    Ok(prepared)
}

#[allow(dead_code)]
fn native_subagent_model(
    config: &CodeyConfig,
    targets: &[RuntimeModelTarget],
    model: &str,
) -> String {
    let model = model.trim();
    targets
        .iter()
        .find(|target| model_id::equal(&target.alias, model))
        .map(|target| target.upstream_model.clone())
        .or_else(|| native_provider_prefixed_subagent_model(config, model))
        .unwrap_or_else(|| model.to_string())
}

#[allow(dead_code)]
fn native_provider_prefixed_subagent_model(config: &CodeyConfig, model: &str) -> Option<String> {
    for profile in &config.profiles {
        let provider_id = profile.provider_id();
        let prefix = model_id::model_alias(provider_id, "");
        let Some(upstream_model) = strip_model_provider_prefix(model, &prefix) else {
            continue;
        };
        let known_model = config
            .upstream_models_by_provider
            .get(provider_id)
            .into_iter()
            .flatten()
            .chain(
                config
                    .selected_models_by_provider
                    .get(provider_id)
                    .into_iter()
                    .flatten(),
            )
            .chain(
                config
                    .declared_official_models_by_provider
                    .get(provider_id)
                    .into_iter()
                    .flatten(),
            )
            .find(|known| model_id::equal(known, upstream_model))
            .cloned()
            .or_else(|| {
                model_catalog::default_official_model_slugs()
                    .into_iter()
                    .find(|known| model_id::equal(known, upstream_model))
            });
        if known_model.is_some() {
            return known_model;
        }
    }
    None
}

#[allow(dead_code)]
fn strip_model_provider_prefix<'a>(model: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix = prefix.trim();
    model
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .and_then(|_| model.get(prefix.len()..))
        .map(str::trim)
        .filter(|suffix| !suffix.is_empty())
}

#[allow(dead_code)]
fn native_subagent_runtime_config(config: &CodeyConfig) -> CodeyConfig {
    let mut runtime_config = config.clone();
    let targets = config.runtime_model_targets();
    runtime_config.subagent_model = native_subagent_model(config, &targets, &config.subagent_model);
    for selection in runtime_config.subagent_roles.values_mut() {
        selection.model = native_subagent_model(config, &targets, &selection.model);
    }
    runtime_config
}

#[allow(dead_code)]
fn reconciled_native_subagent_runtime_config(
    config: &CodeyConfig,
    home: &std::path::Path,
) -> CodeyConfig {
    let mut runtime_config = native_subagent_runtime_config(config);
    if let Ok(model_state) = crate::commands::native_subagent_model_state(&runtime_config, home) {
        subagent_policy::reconcile_with_model_state(&mut runtime_config, Some(&model_state));
    }
    runtime_config
}

async fn prepare_runtime_provider_state(
    home: &std::path::Path,
    config: &CodeyConfig,
) -> Result<PreparedProviderState> {
    let startup_catalog = prepare_startup_model_catalog(config, home).await?;
    let prepared_startup = prepare_codex_startup_state(config, home, startup_catalog).await?;
    Ok(PreparedProviderState {
        runtime_config: prepared_startup.runtime_config,
        runtime_config_overrides: prepared_startup.runtime_config_overrides,
    })
}

#[allow(dead_code)]
async fn prepare_native_runtime_state(
    home: &std::path::Path,
    config: &CodeyConfig,
) -> Result<PreparedProviderState> {
    let runtime_config_home = home.to_path_buf();
    let fast_context_tools = config.fast_context_tools;
    let subagent_optimization = config.subagent_optimization;
    let native_subagent_config = config.clone();
    let applied = tokio::task::spawn_blocking(move || {
        let native_subagent_config = reconciled_native_subagent_runtime_config(
            &native_subagent_config,
            &runtime_config_home,
        );
        apply_runtime_router_config(
            &runtime_config_home,
            RuntimeRouterConfigOptions {
                model_catalog_path: None,
                default_model: None,
                fast_context_tools,
                subagent_optimization,
                subagent_model: &native_subagent_config.subagent_model,
                subagent_reasoning_effort: &native_subagent_config.subagent_reasoning_effort,
                subagent_roles: Some(&native_subagent_config.subagent_roles),
                subagent_catalog: subagent_policy::catalog_snapshot_for_config(
                    &native_subagent_config,
                ),
            },
        )
    })
    .await
    .map_err(|error| {
        anyhow::Error::new(error).context("应用原生 Provider 运行配置任务异常退出")
    })??;
    let mut runtime_config = config.clone();
    runtime_config.fast_context_tools = applied.fast_context_tools_active;
    Ok(PreparedProviderState {
        runtime_config,
        runtime_config_overrides: applied.runtime_config_overrides,
    })
}

async fn prepare_startup_patches(
    home: &std::path::Path,
    config: &CodeyConfig,
) -> StartupPatchState {
    let slim_codex_pet = config.slim_codex_pet;
    let pet_result = configure_startup_pet(home, slim_codex_pet).await;
    let debug_port = codey_runtime_core::ports::select_packaged_codex_debug_port(9229);
    match pet_result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            error_log::record_failure_with_metadata(
                "patch_failed",
                "configure_codex_pet_slim",
                format!("{error:#}"),
                error_log::FailureMetadata {
                    stage: Some("startup.pet_slim".to_string()),
                    recoverable: Some(true),
                },
                serde_json::json!({
                    "enabled": slim_codex_pet,
                    "fallback": "continue_startup",
                }),
            );
        }
        Err(error) => {
            error_log::record_failure_with_metadata(
                "patch_failed",
                "configure_codex_pet_slim",
                error.to_string(),
                error_log::FailureMetadata {
                    stage: Some("startup.pet_slim".to_string()),
                    recoverable: Some(true),
                },
                serde_json::json!({
                    "enabled": slim_codex_pet,
                    "taskJoinFailed": true,
                    "fallback": "continue_startup",
                }),
            );
        }
    };
    StartupPatchState { debug_port }
}

async fn spawn_and_inject_runtime(
    home: &std::path::Path,
    config: &CodeyConfig,
    handler: &codey_runtime_core::bridge::BridgeHandler,
    injection_scripts: &cdp::PreparedInjectionScripts,
    mut storage: StartupStorageState,
    patch: &StartupPatchState,
    runtime_config_overrides: &[String],
) -> Result<SpawnedRenderer> {
    let mut spawned = match spawn_codex(
        &mut storage.app_dir,
        patch.debug_port,
        config.slim_codex_pet,
        config.subagent_optimization,
        config.gpu_launch_mode,
        runtime_config_overrides,
    )
    .await
    {
        Ok(spawned) => spawned,
        Err(error) => {
            return Err(restore_runtime_config_after_error(home, error).await);
        }
    };
    let maintenance = MaintenanceStatus {
        session_status: storage.session_maintenance.status,
        session_files_fixed: storage.session_maintenance.files_fixed,
        sqlite_rows_updated: storage.session_maintenance.sqlite_rows_updated,
        ghost_tasks_pruned: storage.session_maintenance.ghost_tasks_pruned,
        performance_status: spawned.performance_status.clone(),
        performance_detail: spawned.performance_detail.clone(),
    };
    let child = Arc::new(Mutex::new(spawned.child.take()));
    let injected_target = inject_initial_renderer(
        patch.debug_port,
        handler.clone(),
        injection_scripts,
        &storage.app_dir,
        home,
        &spawned,
        &child,
    )
    .await?;
    Ok(SpawnedRenderer {
        app_dir: storage.app_dir,
        spawned,
        child,
        maintenance,
        injected_target,
    })
}

fn spawn_runtime_watchers(inputs: RuntimeWatcherInputs) -> RuntimeWatchers {
    let RuntimeWatcherInputs {
        injected_target,
        debug_port,
        handler,
        injection_scripts,
        child,
        process_id,
        protect_crashpad_pending,
        crashpad_pending_stats,
    } = inputs;
    #[cfg(not(windows))]
    let _ = process_id;
    let InjectionWatchdog {
        statuses: injection_statuses,
        websocket_url: injection_websocket_url,
        shutdown: watchdog_shutdown,
        task: watchdog_task,
    } = spawn_injection_watchdog(injected_target, debug_port, handler, injection_scripts);
    let codex_exited = Arc::new(AtomicBool::new(false));
    let crashpad_guard_enabled = Arc::new(AtomicBool::new(protect_crashpad_pending));
    let (crashpad_guard_shutdown, crashpad_guard_task) =
        spawn_crashpad_guard_watcher(crashpad_guard_enabled.clone(), crashpad_pending_stats);
    #[cfg(windows)]
    let (exit_watchdog_shutdown, codex_exit, exit_watchdog_task) =
        spawn_codex_exit_watcher(child, process_id, codex_exited);
    #[cfg(not(windows))]
    let (exit_watchdog_shutdown, codex_exit, exit_watchdog_task) =
        spawn_codex_exit_watcher(child, codex_exited);
    RuntimeWatchers {
        injection_statuses,
        injection_websocket_url,
        watchdog_shutdown,
        watchdog_task,
        crashpad_guard_enabled,
        crashpad_guard_shutdown,
        crashpad_guard_task,
        exit_watchdog_shutdown,
        exit_watchdog_task,
        codex_exit,
    }
}

impl CodeyRuntime {
    pub async fn renderer_websocket_url(&self) -> Arc<str> {
        self.injection_websocket_url.read().await.clone()
    }

    pub async fn applied_model_config(&self) -> RuntimeModelConfig {
        self.applied_model_config.read().await.clone()
    }

    pub async fn mark_model_config_applied(&self, config: &CodeyConfig) {
        *self.applied_model_config.write().await = RuntimeModelConfig::from_config(config);
    }

    pub async fn applied_subagent_config(&self) -> RuntimeSubagentConfig {
        self.applied_subagent_config.read().await.clone()
    }

    pub async fn mark_subagent_config_applied(&self, config: &CodeyConfig) {
        *self.applied_subagent_config.write().await = RuntimeSubagentConfig::from_config(config);
    }

    pub fn supports_subagent_config_hot_reload(&self, config: &CodeyConfig) -> bool {
        self.applied_config.subagent_optimization
            && config.subagent_optimization
            && self.applied_config.local_router_enabled == config.local_router_enabled
            && self.applied_config.fast_context_tools == config.fast_context_tools
            && snapshot_identity(&self.applied_config) == snapshot_identity(config)
    }

    #[allow(dead_code)]
    pub(crate) fn subagent_reconcile_config(&self, config: &CodeyConfig) -> CodeyConfig {
        native_subagent_runtime_config(config)
    }

    pub fn set_crashpad_pending_protection(&self, enabled: bool) {
        self.crashpad_guard_enabled
            .store(enabled, Ordering::Release);
    }

    pub async fn crashpad_pending_protection_active(&self) -> bool {
        if !cfg!(target_os = "macos") || !self.crashpad_guard_enabled.load(Ordering::Acquire) {
            return false;
        }

        self.crashpad_guard_task
            .lock()
            .await
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    pub async fn refresh_injection_statuses(&self) -> Arc<[cdp::InjectionScriptStatus]> {
        let websocket_url = self.injection_websocket_url.read().await.clone();
        let statuses = cdp::read_injection_statuses(&websocket_url, &self.injection_scripts)
            .await
            .unwrap_or_else(|error| {
                self.injection_scripts
                    .statuses_with_error(format!("实时生效自检失败：{error:#}"))
            });
        if self.injection_websocket_url.read().await.as_ref() != websocket_url.as_ref() {
            return self.injection_statuses.read().await.clone();
        }
        *self.injection_statuses.write().await = statuses.clone();
        statuses
    }

    pub async fn start(
        config: &CodeyConfig,
        handler: codey_runtime_core::bridge::BridgeHandler,
        trace_log_write_protection_active: &AtomicBool,
        crashpad_pending_stats: CrashpadPendingStatsHandle,
    ) -> Result<(Self, oneshot::Receiver<()>)> {
        let home = codex_home();
        trace_log_write_protection_active.store(false, Ordering::Release);
        let injection_scripts = cdp::prepare_injection_scripts(
            false,
            config.slim_codex_pet,
            config.hide_full_access_warning,
            &config.user_scripts,
        );
        resolve_startup_provider(config)?;
        let initial_storage_guards = spawn_initial_storage_guards(home, config);
        let (storage, _startup_catalog) = prepare_startup_storage(
            home,
            config,
            None,
            initial_storage_guards,
            trace_log_write_protection_active,
            &crashpad_pending_stats,
        )
        .await?;
        let PreparedProviderState {
            runtime_config,
            runtime_config_overrides,
        } = match prepare_runtime_provider_state(home, config).await {
            Ok(state) => state,
            Err(error) => {
                return Err(restore_runtime_config_after_error(home, error).await);
            }
        };
        let patch = prepare_startup_patches(home, config).await;
        let SpawnedRenderer {
            app_dir,
            spawned,
            child,
            maintenance,
            injected_target,
        } = spawn_and_inject_runtime(
            home,
            config,
            &handler,
            &injection_scripts,
            storage,
            &patch,
            &runtime_config_overrides,
        )
        .await?;
        #[cfg(target_os = "macos")]
        let inspector_argument = spawned.inspector_argument.clone();
        let process_id = spawned.process_id;
        let RuntimeWatchers {
            injection_statuses,
            injection_websocket_url,
            watchdog_shutdown,
            watchdog_task,
            crashpad_guard_enabled,
            crashpad_guard_shutdown,
            crashpad_guard_task,
            exit_watchdog_shutdown,
            exit_watchdog_task,
            codex_exit,
        } = spawn_runtime_watchers(RuntimeWatcherInputs {
            injected_target,
            debug_port: patch.debug_port,
            handler,
            injection_scripts: injection_scripts.clone(),
            child: child.clone(),
            process_id,
            protect_crashpad_pending: config.protect_crashpad_pending,
            crashpad_pending_stats,
        });
        Ok((
            Self {
                codex_app_path: app_dir,
                maintenance,
                applied_model_config: RwLock::new(RuntimeModelConfig::from_config(&runtime_config)),
                applied_subagent_config: RwLock::new(RuntimeSubagentConfig::from_config(
                    &runtime_config,
                )),
                applied_config: runtime_config,
                injection_statuses,
                injection_scripts,
                injection_websocket_url,
                child,
                process_id,
                #[cfg(unix)]
                process_group_id: spawned.process_group_id,
                #[cfg(target_os = "macos")]
                inspector_argument,
                watchdog_shutdown: Mutex::new(Some(watchdog_shutdown)),
                watchdog_task: Mutex::new(Some(watchdog_task)),
                exit_watchdog_shutdown: Mutex::new(Some(exit_watchdog_shutdown)),
                exit_watchdog_task: Mutex::new(Some(exit_watchdog_task)),
                crashpad_guard_enabled,
                crashpad_guard_shutdown: Mutex::new(Some(crashpad_guard_shutdown)),
                crashpad_guard_task: Mutex::new(Some(crashpad_guard_task)),
            },
            codex_exit,
        ))
    }

    pub async fn stop(&self) -> Result<()> {
        self.stop_with_cleanup(
            stop_codex_processes(
                &self.codex_app_path,
                self.process_id,
                #[cfg(unix)]
                self.process_group_id,
                #[cfg(target_os = "macos")]
                self.inspector_argument.as_deref(),
            ),
            restore_runtime_config(codex_home()),
        )
        .await
    }

    async fn stop_with_cleanup(
        &self,
        process_stop: impl std::future::Future<Output = Result<()>>,
        config_restore: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        // A failed stop leaves a live Codex using this bridge, router and config.
        // Keep its watchers too, so the retained runtime can be stopped again.
        if let Err(error) = process_stop.await {
            error_log::record_failure(
                "cleanup_failed",
                "stop_codex_processes",
                format!("{error:#}"),
                serde_json::json!({
                    "appPath": self.codex_app_path,
                    "processId": self.process_id,
                }),
            );
            return Err(error.context("清理 Codex 遗留进程失败"));
        }
        stop_runtime_watcher(
            &self.crashpad_guard_shutdown,
            &self.crashpad_guard_task,
            "cleanup_failed",
            "stop_crashpad_pending_guard",
            "Crashpad 磁盘保护任务关闭失败",
        )
        .await;
        stop_runtime_watcher(
            &self.watchdog_shutdown,
            &self.watchdog_task,
            "injection_watchdog_failed",
            "stop_cdp_watchdog",
            "Codey CDP watchdog 关闭失败",
        )
        .await;
        stop_runtime_watcher(
            &self.exit_watchdog_shutdown,
            &self.exit_watchdog_task,
            "process_watch_failed",
            "stop_codex_exit_watcher",
            "Codex 退出监听器关闭失败",
        )
        .await;
        if let Some(child) = self.child.lock().await.take() {
            reap_child_after_cleanup(child, "reap_child_during_runtime_stop").await;
        }
        config_restore.await.context("恢复 Codex 配置失败")?;
        Ok(())
    }
}

fn spawn_crashpad_guard_watcher(
    enabled: Arc<AtomicBool>,
    stats: CrashpadPendingStatsHandle,
) -> (oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(crashpad_pending_guard::GUARD_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => break,
                _ = interval.tick() => {}
            }
            if !enabled.load(Ordering::Acquire) {
                continue;
            }
            let result =
                tokio::task::spawn_blocking(crashpad_pending_guard::enforce_system_limit).await;
            match result {
                Ok(run) => {
                    if !run.cleanup.errors.is_empty() || run.cleanup.still_over_limit {
                        error_log::record_failure_async(
                            "cleanup_failed",
                            "enforce_crashpad_pending_limit",
                            if run.cleanup.still_over_limit {
                                "Crashpad pending 仍超过安全上限".to_string()
                            } else {
                                format!(
                                    "{} 个 Crashpad 待处理文件未能完成收敛",
                                    run.cleanup.errors.len()
                                )
                            },
                            serde_json::json!({
                                "errorCount": run.cleanup.errors.len(),
                                "stillOverLimit": run.cleanup.still_over_limit,
                                "bytesReclaimed": run.cleanup.bytes_reclaimed,
                            }),
                        )
                        .await;
                    }
                    let _ = stats.replace_if_idle(run.snapshot);
                }
                Err(error) => {
                    error_log::record_failure_async(
                        "cleanup_failed",
                        "enforce_crashpad_pending_limit",
                        error.to_string(),
                        serde_json::json!({
                            "taskJoinFailed": true,
                        }),
                    )
                    .await;
                }
            }
        }
    });
    (shutdown_tx, task)
}

fn watchdog_should_reinject(consecutive_failures: &mut u8, health: InjectionHealth) -> bool {
    match health {
        InjectionHealth::Healthy | InjectionHealth::Inconclusive => {
            *consecutive_failures = 0;
            false
        }
        InjectionHealth::Unhealthy => {
            *consecutive_failures = consecutive_failures.saturating_add(1);
            *consecutive_failures >= CDP_WATCHDOG_FAILURE_THRESHOLD
        }
        InjectionHealth::TargetUnavailable => {
            *consecutive_failures = 0;
            true
        }
    }
}

fn session_maintenance_summary(
    index_cleanup: &Result<SessionIndexCleanupReport>,
) -> SessionMaintenanceSummary {
    let pruned_entries = match index_cleanup {
        Ok(report) => report.pruned_entries,
        Err(_) => 0,
    };
    let has_errors = index_cleanup.is_err();
    let status = if has_errors { "error" } else { "ready" };
    SessionMaintenanceSummary {
        status: status.to_string(),
        files_fixed: 0,
        sqlite_rows_updated: 0,
        ghost_tasks_pruned: pruned_entries,
    }
}

#[cfg(test)]
mod maintenance_status_tests;

fn snapshot_identity(config: &CodeyConfig) -> Option<(&str, &str)> {
    config
        .current_provider_snapshot
        .as_ref()
        .map(|snapshot| (snapshot.id.as_str(), snapshot.ownership_key.as_str()))
}

pub async fn restore_previous_runtime_state(home: &std::path::Path) -> Result<()> {
    restore_runtime_config(home).await
}

pub async fn restore_runtime_config(home: &std::path::Path) -> Result<()> {
    let home = home.to_path_buf();
    tokio::task::spawn_blocking(move || restore_runtime_config_blocking(&home))
        .await
        .context("恢复 Codey 运行时配置任务异常退出")?
}

fn restore_runtime_config_blocking(home: &std::path::Path) -> Result<()> {
    let result = restore_codex_runtime_config(home)
        .map(|_| ())
        .context("恢复 Codex 配置失败");
    if let Err(error) = &result {
        error_log::record_failure(
            "restore_failed",
            "restore_runtime_config",
            format!("{error:#}"),
            serde_json::json!({
                "codexHome": home,
            }),
        );
    }
    result
}

async fn restore_runtime_config_after_error(
    home: &std::path::Path,
    error: anyhow::Error,
) -> anyhow::Error {
    match restore_runtime_config(home).await {
        Ok(()) => error,
        Err(restore_error) => {
            anyhow::anyhow!("{error:#}；启动失败后恢复临时 Codex 配置也失败：{restore_error:#}")
        }
    }
}

#[cfg(test)]
mod gpu_launch_argument_tests;

#[cfg(test)]
#[path = "launcher/watchdog_tests.rs"]
mod watchdog_tests;

#[cfg(all(test, unix))]
mod tests;
