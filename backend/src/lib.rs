mod account_usage;
mod cdp;
mod codex_config;
mod codex_extensions;
mod codex_config_guidance;
mod codex_provider;
mod codex_startup_patch;
mod codey_router_session_migrate;
mod commands;
mod computer_use;
mod config;
mod context_recovery;
mod crashpad_pending_guard;
#[cfg(windows)]
mod desktop_instance;
mod target_prefetch;
mod error_log;
pub mod fastctx;
mod fastctx_route_gate;
mod fs_util;
mod hook_io;
mod http_response;
mod launch_proxy;
mod launch_proxy_relay;
mod launcher;
mod maintenance_lock;
mod message_delete;
mod model_catalog;
mod model_catalog_store;
mod model_id;
mod model_list;
mod model_order;
mod model_ownership;
#[cfg(target_os = "macos")]
mod native_update_ui;
mod notifications;
mod pending_approval;
mod pet_slim_patch;
mod plugin_marketplace;
mod process_cleanup;
mod process_tree;
mod prompt_optimization;
mod provider_models;
mod renderer_asset_patch;
mod rollout_last_request;
mod route_request_log;
mod session_delete;
mod session_index_cleanup;
mod session_metadata;
mod session_transfer;
mod sqlite_util;
mod subagent;
mod subagent_gate;
mod subagent_orchestrator;
mod subagent_policy;
mod trace_log_guard;
mod trace_log_stats;

// 单元测试不能写入用户真实的 Codey 状态目录：诊断日志和错误日志都按该目录
// 定位，否则测试记录会淹没真实故障并提前触发日志轮转。在 main 之前设置，
// 保证任何测试线程读取路径时都已生效。`cargo run` 和 `cargo test` 重建的
// 正式二进制都不包含这段代码。
#[cfg(test)]
mod test_state_isolation {
    extern "C" fn isolate_app_state_dir() {
        const KEY: &str = "CODEY_APP_STATE_DIR";
        if std::env::var_os(KEY).is_some_and(|value| !value.is_empty()) {
            return;
        }
        let dir = std::env::temp_dir().join(format!("codey-test-state-{}", std::process::id()));
        // SAFETY: runs as a pre-main initializer before any other thread exists.
        unsafe { std::env::set_var(KEY, dir) };
    }

    #[used]
    #[cfg_attr(target_os = "macos", unsafe(link_section = "__DATA,__mod_init_func"))]
    #[cfg_attr(target_os = "linux", unsafe(link_section = ".init_array"))]
    #[cfg_attr(windows, unsafe(link_section = ".CRT$XCU"))]
    static ISOLATE_APP_STATE_DIR: extern "C" fn() = isolate_app_state_dir;
}

use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use anyhow::Context;
use anyhow::Result;

use commands::{AppShutdownReason, AppState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownReason {
    CodexExited,
    Signal,
    RuntimeRestartFailed,
}

impl ShutdownReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::CodexExited => "codex_exited",
            Self::Signal => "signal",
            Self::RuntimeRestartFailed => "runtime_restart_failed",
        }
    }
}

struct DesktopLifecycle {
    started_at: std::time::Instant,
    reason: std::sync::Mutex<&'static str>,
}

impl DesktopLifecycle {
    fn new() -> Self {
        Self {
            started_at: std::time::Instant::now(),
            reason: std::sync::Mutex::new("startup_failed"),
        }
    }

    fn set_reason(&self, reason: &'static str) {
        *self
            .reason
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = reason;
    }

    fn shutdown_requested(&self, reason: ShutdownReason) {
        self.set_reason(reason.as_str());
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "desktop.shutdown_requested",
            serde_json::json!({
                "processId": std::process::id(),
                "uptimeMs": self.started_at.elapsed().as_millis(),
                "reason": reason.as_str(),
            }),
        );
        let _ = codey_runtime_core::diagnostic_log::flush_diagnostic_log();
    }

    fn exit_details(&self, success: bool, panicking: bool) -> serde_json::Value {
        let reason = *self
            .reason
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        serde_json::json!({
            "processId": std::process::id(),
            "uptimeMs": self.started_at.elapsed().as_millis(),
            "reason": if panicking { "panic" } else { reason },
            "success": success && !panicking,
            "exitCode": if panicking { None } else { Some(if success { 0 } else { 1 }) },
        })
    }
}

struct DesktopExitGuard {
    lifecycle: Arc<DesktopLifecycle>,
    success: bool,
}

impl Drop for DesktopExitGuard {
    fn drop(&mut self) {
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "desktop.finished",
            self.lifecycle
                .exit_details(self.success, std::thread::panicking()),
        );
        let _ = codey_runtime_core::diagnostic_log::flush_diagnostic_log();
    }
}

pub fn run_error_log_helper_if_requested() -> Result<bool> {
    error_log::run_helper_if_requested()
}

pub fn run_codex_cli_wrapper_if_requested() -> Result<bool> {
    codex_startup_patch::run_cli_wrapper_if_requested()
}

pub fn install_crash_log_hook(component: &'static str, stage: &'static str) {
    error_log::install_panic_hook(component, stage);
}

pub fn record_process_failure(
    event: impl Into<String>,
    operation: impl Into<String>,
    error: impl Into<String>,
    stage: impl Into<String>,
) {
    error_log::record_process_failure(event, operation, error, stage);
}

pub fn record_process_failure_with_recoverability(
    event: impl Into<String>,
    operation: impl Into<String>,
    error: impl Into<String>,
    stage: impl Into<String>,
    recoverable: bool,
) {
    error_log::record_process_failure_with_recoverability(
        event,
        operation,
        error,
        stage,
        recoverable,
    );
}

pub fn run_subagent_gate_hook_if_requested() -> Result<bool> {
    subagent_gate::run_hook_if_requested()
}

pub fn run_fastctx_route_hook_if_requested() -> Result<bool> {
    fastctx_route_gate::run_hook_if_requested()
}

pub fn run_desktop_application() -> Result<()> {
    let lifecycle = Arc::new(DesktopLifecycle::new());
    let mut exit_guard = DesktopExitGuard {
        lifecycle: Arc::clone(&lifecycle),
        success: false,
    };
    let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
        "desktop.started",
        serde_json::json!({ "processId": std::process::id() }),
    );
    let result = run_desktop_application_inner(lifecycle);
    exit_guard.success = result.is_ok();
    result
}

fn run_desktop_application_inner(lifecycle: Arc<DesktopLifecycle>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        native_update_ui::run_macos_application(move || {
            build_async_runtime()?.block_on(run(lifecycle))
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(windows)]
        let Some(_desktop_instance) = desktop_instance::claim() else {
            lifecycle.set_reason("instance_not_acquired");
            let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                "desktop.instance_not_acquired",
                serde_json::json!({}),
            );
            return Ok(());
        };
        build_async_runtime()?.block_on(run(lifecycle))
    }
}

fn build_async_runtime() -> Result<tokio::runtime::Runtime> {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    // Codey is an I/O coordinator. Blocking filesystem/SQLite work already
    // runs on Tokio's blocking pool, so two async workers avoid creating a
    // CPU-count-sized thread team for every helper instance.
    builder.worker_threads(2);
    builder.enable_all().build().map_err(anyhow::Error::from)
}

async fn run(lifecycle: Arc<DesktopLifecycle>) -> Result<()> {
    error_log::initialize();
    let state = Arc::new(AppState::default());
    let configured_codex_app_path = state.config.read().await.codex_app_path.clone();
    let _ = tokio::task::spawn_blocking(move || {
        error_log::refresh_codex_app_version(None, Some(&configured_codex_app_path));
    })
    .await;
    let codex_home = codex_config::codex_home();
    if let Err(error) = launcher::restore_previous_runtime_state(codex_home).await {
        error_log::record_failure_with_metadata(
            "restore_failed",
            "restore_previous_runtime_state_at_startup",
            format!("{error:#}"),
            error_log::FailureMetadata {
                stage: Some("startup.restore_previous_state".to_string()),
                recoverable: Some(true),
            },
            serde_json::json!({}),
        );
        eprintln!("Codey 启动前恢复上次临时配置失败：{error:#}");
    }
    match repair_legacy_model_catalog(codex_home).await {
        Ok(true) => eprintln!("已修复旧版 Codey 模型目录缺失的 description 字段"),
        Ok(false) => {}
        Err(error) => {
            error_log::record_failure(
                "repair_failed",
                "repair_legacy_model_catalog",
                format!("{error:#}"),
                serde_json::json!({
                    "codexHome": codex_home,
                }),
            );
            eprintln!("Codey 启动前修复旧版模型目录失败：{error:#}");
        }
    }
    let mut shutdown = Box::pin(shutdown_signal());
    let shutdown_reason = match commands::launch_codey_runtime(&state).await {
        Ok(_) => {
            lifecycle.set_reason("runtime_failed");
            tokio::select! {
                reason = state.wait_for_shutdown() => match reason {
                    AppShutdownReason::CodexExited => ShutdownReason::CodexExited,
                    AppShutdownReason::RuntimeRestartFailed => ShutdownReason::RuntimeRestartFailed,
                },
                _ = &mut shutdown => ShutdownReason::Signal,
            }
        }
        Err(error) => {
            eprintln!("Codey 自动启动 Codex 失败：{error:#}");
            let cleanup = stop_runtime_with_retry(&state).await;
            if let Err(cleanup_error) = &cleanup {
                error_log::record_failure(
                    "restore_failed",
                    "restore_runtime_after_startup_failure",
                    cleanup_error.clone(),
                    serde_json::json!({}),
                );
            }
            let error =
                initial_startup_failure_error(&error, cleanup.as_ref().err().map(String::as_str));
            #[cfg(windows)]
            show_initial_startup_failure(&error).await;
            return Err(anyhow::Error::msg(error));
        }
    };

    let shutdown_started_at = std::time::SystemTime::now();
    lifecycle.shutdown_requested(shutdown_reason);
    let cleanup = stop_runtime_with_retry(&state).await;
    if let Err(error) = &cleanup {
        error_log::record_failure(
            "restore_failed",
            "restore_runtime_during_shutdown",
            error.clone(),
            serde_json::json!({}),
        );
    }
    let shutdown_context = match shutdown_reason {
        ShutdownReason::CodexExited => "Codex 已退出",
        ShutdownReason::Signal => "Codey 收到退出信号",
        ShutdownReason::RuntimeRestartFailed => "Codey 自动重启 Codex 失败",
    };
    // The public no-argument helper remains available for callers without a shutdown boundary:
    // terminate_other_codey_processes().await
    match process_cleanup::terminate_other_codey_processes_since(shutdown_started_at).await {
        Ok(0) => {}
        Ok(count) => eprintln!("{shutdown_context}，已终止 {count} 个遗留 Codey 进程"),
        Err(error) => {
            error_log::record_failure(
                "cleanup_failed",
                "terminate_other_codey_processes",
                format!("{error:#}"),
                serde_json::json!({
                    "shutdownContext": shutdown_context,
                }),
            );
            eprintln!("{shutdown_context}，但清理遗留 Codey 进程失败：{error:#}");
        }
    }
    runtime_shutdown_result(shutdown_reason, cleanup).map_err(anyhow::Error::msg)
}

fn runtime_shutdown_result(
    reason: ShutdownReason,
    cleanup: Result<(), String>,
) -> Result<(), String> {
    match (reason, cleanup) {
        (ShutdownReason::RuntimeRestartFailed, Ok(())) => Err("自动重启 Codex 失败".to_string()),
        (ShutdownReason::RuntimeRestartFailed, Err(error)) => {
            Err(format!("自动重启 Codex 失败；退出清理失败：{error}"))
        }
        (_, result) => result,
    }
}

async fn repair_legacy_model_catalog(home: &Path) -> Result<bool> {
    let home = home.to_path_buf();
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    tokio::task::spawn_blocking(move || {
        model_catalog::repair_missing_descriptions(&home, &catalog_dir)
    })
    .await
    .map_err(anyhow::Error::from)?
}

async fn stop_runtime_with_retry(state: &Arc<AppState>) -> Result<(), String> {
    match commands::stop_codey_runtime(state).await {
        Ok(_) => Ok(()),
        Err(first_error) => {
            eprintln!("Codey 恢复 Codex 配置失败，正在重试：{first_error}");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            commands::stop_codey_runtime(state)
                .await
                .map(|_| ())
                .map_err(|retry_error| format!("{first_error}；重试失败：{retry_error}"))
        }
    }
}

fn initial_startup_failure_error(startup_error: &str, cleanup_error: Option<&str>) -> String {
    match cleanup_error {
        Some(cleanup_error) => {
            format!("{startup_error}；启动失败后的清理也失败：{cleanup_error}")
        }
        None => startup_error.to_string(),
    }
}

#[cfg(windows)]
async fn show_initial_startup_failure(error: &str) {
    let description = format!("{error}\n\nCodey 将退出。处理上述问题后，请重新启动 Codey。");
    if let Err(dialog_error) = tokio::task::spawn_blocking(move || {
        rfd::MessageDialog::new()
            .set_title("Codey 启动失败")
            .set_description(description)
            .set_level(rfd::MessageLevel::Error)
            .set_buttons(rfd::MessageButtons::Ok)
            .show()
    })
    .await
    {
        error_log::record_failure(
            "dialog_failed",
            "show_initial_startup_failure",
            dialog_error.to_string(),
            serde_json::json!({}),
        );
        eprintln!("Codey 启动失败提示框显示异常：{dialog_error}");
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        match signal(SignalKind::terminate()).context("监听 SIGTERM 失败") {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = ctrl_c_signal() => {}
                    _ = wait_for_termination_signal(terminate.recv()) => {}
                }
            }
            Err(error) => {
                error_log::record_failure(
                    "shutdown_signal_listener_failed",
                    "register_sigterm_listener",
                    format!("{error:#}"),
                    serde_json::json!({}),
                );
                eprintln!("{error:#}");
                ctrl_c_signal().await;
            }
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c_signal().await;
    }
}

#[cfg(any(unix, test))]
async fn wait_for_termination_signal(signal: impl std::future::Future<Output = Option<()>>) {
    if signal.await.is_none() {
        error_log::record_failure(
            "shutdown_signal_listener_failed",
            "wait_for_sigterm",
            "SIGTERM 监听流已关闭，未收到退出信号",
            serde_json::json!({}),
        );
        std::future::pending::<()>().await;
    }
}

/// A listener that cannot be registered never fires, so Codex exit remains
/// the shutdown trigger instead of Codey quitting right after launch.
async fn ctrl_c_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error_log::record_failure(
            "shutdown_signal_listener_failed",
            "wait_for_ctrl_c",
            error.to_string(),
            serde_json::json!({}),
        );
        eprintln!("监听 Ctrl+C 失败：{error}");
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        DesktopLifecycle, ShutdownReason, initial_startup_failure_error, runtime_shutdown_result,
        wait_for_termination_signal,
    };

    #[test]
    fn desktop_exit_diagnostics_preserve_reason_and_cleanup_failure() {
        let lifecycle = DesktopLifecycle::new();
        for reason in [ShutdownReason::CodexExited, ShutdownReason::Signal] {
            lifecycle.set_reason(reason.as_str());
            for success in [true, false] {
                let details = lifecycle.exit_details(success, false);
                assert_eq!(details["processId"], std::process::id());
                assert_eq!(details["reason"], reason.as_str());
                assert_eq!(details["success"], success);
                assert_eq!(details["exitCode"], if success { 0 } else { 1 });
                assert!(details["uptimeMs"].is_u64());
            }
        }
        lifecycle.set_reason("instance_not_acquired");
        assert_eq!(
            lifecycle.exit_details(true, false)["reason"],
            "instance_not_acquired"
        );
        let panic = lifecycle.exit_details(false, true);
        assert_eq!(panic["reason"], "panic");
        assert_eq!(panic["success"], false);
        assert!(panic["exitCode"].is_null());
        assert_eq!(
            DesktopLifecycle::new().exit_details(false, false)["reason"],
            "startup_failed"
        );
    }

    #[test]
    fn runtime_restart_failure_remains_failure_after_shutdown_cleanup() {
        let reason = ShutdownReason::RuntimeRestartFailed;
        let lifecycle = DesktopLifecycle::new();
        lifecycle.set_reason(reason.as_str());
        for cleanup in [Ok(()), Err("配置恢复失败".to_string())] {
            let result = runtime_shutdown_result(reason, cleanup.clone());
            let details = lifecycle.exit_details(result.is_ok(), false);
            assert_eq!(details["reason"], "runtime_restart_failed");
            assert_eq!(details["success"], false);
            assert_eq!(details["exitCode"], 1);
            let error = result.unwrap_err();
            assert!(error.contains("自动重启 Codex 失败"));
            if let Err(cleanup_error) = cleanup {
                assert!(error.contains(&cleanup_error));
            }
        }
        assert_eq!(
            runtime_shutdown_result(ShutdownReason::CodexExited, Ok(())),
            Ok(())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn closed_sigterm_stream_does_not_trigger_shutdown() {
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                wait_for_termination_signal(async { None }),
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn received_sigterm_triggers_shutdown() {
        tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_termination_signal(async { Some(()) }),
        )
        .await
        .unwrap();
    }

    #[test]
    fn startup_failure_keeps_the_cleanup_error() {
        assert_eq!(
            initial_startup_failure_error("Codex 启动失败", Some("配置恢复失败")),
            "Codex 启动失败；启动失败后的清理也失败：配置恢复失败"
        );
    }

    #[test]
    fn startup_failure_is_unchanged_after_successful_cleanup() {
        assert_eq!(
            initial_startup_failure_error("Codex 启动失败", None),
            "Codex 启动失败"
        );
    }
}
