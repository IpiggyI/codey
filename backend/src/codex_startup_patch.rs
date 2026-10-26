#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]

use anyhow::Result;

#[cfg(any(windows, target_os = "macos", test))]
use anyhow::Context;

#[cfg(any(windows, target_os = "macos", test))]
use std::ffi::{OsStr, OsString};
#[cfg(any(windows, target_os = "macos", test))]
use std::io::Write;

/// 单次启动等待 CLI 包装器确认的上限，覆盖 app-server 冷启动；退出或明确失败会提前结束。
pub(crate) const STARTUP_CLI_READY_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(180);

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_TARGET_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_TARGET";
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_OVERRIDES_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_OVERRIDES";
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_SUBAGENT_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_SUBAGENT";
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_PORT_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_PORT";
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_TOKEN_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_TOKEN";
/// 包装器执行记录文件的绝对路径；回环握手丢失时启动器据此确认目标已执行。
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_MARKER_ENV: &str = "CODEY_CODEX_CLI_WRAPPER_MARKER";
/// 包装器可仅写标记文件，由启动器轮询确认执行。
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const CLI_WRAPPER_HANDSHAKE_OPTIONAL_ENV: &str =
    "CODEY_CODEX_CLI_WRAPPER_HANDSHAKE_OPTIONAL";
#[cfg(any(windows, target_os = "macos", test))]
const CLI_WRAPPER_HANDSHAKE_CONNECT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(500);
/// 单次回连最多 500ms；被安全软件或高负载拖慢时在 3 秒内重试，端口被拒绝则立即放弃。
#[cfg(any(windows, target_os = "macos", test))]
const CLI_WRAPPER_HANDSHAKE_CONNECT_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(any(windows, target_os = "macos", test))]
const CLI_WRAPPER_HANDSHAKE_RETRY_DELAY: std::time::Duration =
    std::time::Duration::from_millis(100);
#[cfg(any(windows, test))]
pub(crate) const WINDOWS_PACKAGE_RESUME_ARGUMENT: &str = "--codey-resume-packaged-app";

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn is_retryable_startup_io_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    ) || cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct CliWrapperFailure {
    pub message: String,
    pub retryable: bool,
}

#[cfg(any(windows, target_os = "macos", test))]
impl std::fmt::Display for CliWrapperFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Codex CLI 兼容执行器启动失败：{}", self.message)
    }
}

#[cfg(any(windows, target_os = "macos", test))]
impl std::error::Error for CliWrapperFailure {}

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const MAX_CLI_WRAPPER_FAILURE_BYTES: usize = 8 * 1024;

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const MAX_CLI_WRAPPER_MARKER_BYTES: u64 = 16 * 1024;

/// 包装器在握手端口之外留下的文件记录。回环连接被拖慢或丢失时，启动器仍能确认目标已执行，
/// 不会因为一次握手丢失就杀掉健康的 Codex。
#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CliWrapperMarkerStatus {
    Launching,
    Executed,
    Failed,
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct CliWrapperMarker {
    pub status: CliWrapperMarkerStatus,
    pub pid: u32,
    pub timestamp_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[cfg(any(windows, target_os = "macos", test))]
impl CliWrapperMarker {
    pub(crate) fn new(status: CliWrapperMarkerStatus) -> Self {
        Self {
            status,
            pid: std::process::id(),
            timestamp_ms: crate::fs_util::timestamp_millis(),
            message: None,
            retryable: None,
        }
    }

    pub(crate) fn write(&self, path: &std::path::Path) -> Result<()> {
        crate::fs_util::atomic_write_private_with_parent(path, &serde_json::to_vec(self)?)
    }

    /// `Ok(None)` 表示文件尚不存在；内容无法解析时返回错误，由调用方决定是否继续等待。
    pub(crate) fn read(path: &std::path::Path) -> Result<Option<Self>> {
        match crate::fs_util::read_bounded(path, MAX_CLI_WRAPPER_MARKER_BYTES) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

/// 只接受启动器传入的绝对 JSON 路径，避免包装器把记录写到不可预期的位置。
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn cli_wrapper_marker_path_from_env(
    value: Option<OsString>,
) -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(value?);
    (path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension == "json"))
    .then_some(path)
}

/// 启动兼容等待期间 Codex 进程已退出；无需再等待任何握手。
#[derive(Debug)]
pub(crate) struct StartupProcessExited {
    pub process_id: Option<u32>,
    pub exit_code: Option<u32>,
}

impl std::fmt::Display for StartupProcessExited {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.process_id {
            Some(process_id) => write!(
                formatter,
                "Codex 进程在启动兼容等待期间已退出（PID {process_id}）"
            ),
            None => write!(formatter, "Codex 进程在启动兼容等待期间已退出"),
        }?;
        if let Some(exit_code) = self.exit_code {
            write!(formatter, "，退出码 {exit_code}（0x{exit_code:08X}）")?;
        }
        Ok(())
    }
}

impl std::error::Error for StartupProcessExited {}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PersistedCliWrapperLaunch {
    version: u32,
    lease_id: String,
    target: std::path::PathBuf,
    overrides: Vec<String>,
    subagent: bool,
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, PartialEq)]
pub(crate) enum CliWrapperLaunchSource {
    Environment(std::path::PathBuf),
    Persisted(PersistedCliWrapperLaunch),
    None,
}

#[cfg(any(windows, target_os = "macos", test))]
struct ResolvedCliWrapperLaunch {
    overrides: Result<Vec<String>>,
    subagent: bool,
    begin_readiness: bool,
}

#[cfg(any(windows, target_os = "macos", test))]
fn resolve_cli_wrapper_launch(
    source: &CliWrapperLaunchSource,
    app_server: bool,
    environment: impl Fn(&str) -> Option<OsString>,
) -> ResolvedCliWrapperLaunch {
    if let CliWrapperLaunchSource::Persisted(config) = source {
        return ResolvedCliWrapperLaunch {
            overrides: Ok(config.overrides.clone()),
            subagent: config.subagent,
            begin_readiness: false,
        };
    }
    let overrides = (|| {
        let overrides = environment(CLI_WRAPPER_OVERRIDES_ENV)
            .and_then(|value| value.into_string().ok())
            .map(|value| serde_json::from_str::<Vec<String>>(&value))
            .transpose()
            .context("解析 Codex CLI 兼容运行时配置失败")?;
        anyhow::ensure!(
            !app_server || overrides.is_some(),
            "Codex app-server 缺少本次启动配置，已停止启动；请通过 Codey 重新启动 Codex"
        );
        Ok(overrides.unwrap_or_default())
    })();
    ResolvedCliWrapperLaunch {
        overrides,
        subagent: environment(CLI_WRAPPER_SUBAGENT_ENV).as_deref() == Some(OsStr::new("1")),
        begin_readiness: app_server && matches!(source, CliWrapperLaunchSource::Environment(_)),
    }
}

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn cli_wrapper_launch_source(
    target: Option<OsString>,
    app_server: bool,
    read_persisted: impl FnOnce() -> Option<(Vec<u8>, Option<String>)>,
) -> Result<CliWrapperLaunchSource> {
    if let Some(target) = target {
        return Ok(CliWrapperLaunchSource::Environment(target.into()));
    }
    if let Some((bytes, lease_id)) = read_persisted()
        && let Ok(config) = serde_json::from_slice::<PersistedCliWrapperLaunch>(&bytes)
        && config.version == 1
        && !config.lease_id.is_empty()
        && lease_id.as_deref() == Some(config.lease_id.as_str())
    {
        return Ok(CliWrapperLaunchSource::Persisted(config));
    }
    anyhow::ensure!(
        !app_server,
        "Codex app-server 缺少本次启动配置，已停止启动；请通过 Codey 重新启动 Codex"
    );
    Ok(CliWrapperLaunchSource::None)
}

#[cfg(any(windows, test))]
pub(crate) fn write_windows_cli_wrapper_launch(
    config_path: &std::path::Path,
    target: &std::path::Path,
    overrides: &[String],
    subagent: bool,
) -> Result<()> {
    let config = PersistedCliWrapperLaunch {
        version: 1,
        lease_id: crate::codex_config::cli_wrapper_lease_id(config_path)
            .context("读取 Codex CLI 启动租约失败")?,
        target: target.to_path_buf(),
        overrides: overrides.to_vec(),
        subagent,
    };
    crate::fs_util::atomic_write_private_with_parent(
        &config_path.with_file_name("codex-cli-launch.json"),
        &serde_json::to_vec(&config)?,
    )
    .context("保存 Codex CLI 本次启动配置失败")
}

#[cfg(windows)]
fn log_detached_cli_launch(app_server: bool, source: &str, outcome: &str) {
    let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
        "launcher.cli_wrapper_launch_source",
        serde_json::json!({
            "source": source,
            "subcommand": if app_server { "app-server" } else { "other" },
            "outcome": outcome,
        }),
    );
}

#[cfg(any(windows, target_os = "macos"))]
fn cli_wrapper_target(
    arguments: &[OsString],
    target: Option<OsString>,
    config_store: &crate::config::ConfigStore,
) -> Result<Option<(std::path::PathBuf, CliWrapperLaunchSource)>> {
    if target.is_some() {
        let source = cli_wrapper_launch_source(target, false, || None)?;
        if let CliWrapperLaunchSource::Environment(target) = &source {
            return Ok(Some((target.clone(), source)));
        }
    }
    // Browser helpers keep CODEX_CLI_PATH but can discard Codey's environment.
    // CLI arguments must never fall through to the desktop startup/cleanup path.
    let Some(first) = arguments.first() else {
        return Ok(None);
    };
    if first == "--debug-port"
        || cfg!(target_os = "macos")
            && first
                .to_str()
                .is_some_and(|value| value.starts_with("-psn_"))
    {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        let app_server = arguments
            .iter()
            .filter(|arg| arg.as_os_str() == OsStr::new("app-server"))
            .count()
            == 1;
        let source = cli_wrapper_launch_source(None, app_server, || {
            let bytes =
                std::fs::read(config_store.path().with_file_name("codex-cli-launch.json")).ok()?;
            let lease_id = crate::codex_config::cli_wrapper_lease_id(config_store.path()).ok();
            Some((bytes, lease_id))
        })?;
        if let CliWrapperLaunchSource::Persisted(config) = source {
            return Ok(Some((
                config.target.clone(),
                CliWrapperLaunchSource::Persisted(config),
            )));
        }
    }
    let config = config_store.load().context("读取 Codex CLI 应用位置失败")?;
    let app_dir = crate::launcher::find_configured_codex_app_dir_sync(&config.codex_app_path)?
        .context("找不到有效的 Codex 桌面应用，无法转发 CLI 调用")?;
    #[cfg(windows)]
    let target = crate::launcher::windows_cli_wrapper_target(&app_dir)?;
    #[cfg(target_os = "macos")]
    let target = codey_runtime_core::app_paths::codex_runtime_executable(&app_dir)
        .context("Codex App 内未找到内置 CLI")?;
    Ok(Some((target, CliWrapperLaunchSource::None)))
}

#[cfg(any(windows, target_os = "macos"))]
pub fn run_cli_wrapper_if_requested() -> Result<bool> {
    if std::env::args_os().nth(1).as_deref() == Some(OsStr::new("--codey-route-app-server-input")) {
        let result =
            route_local_app_server_input(std::io::stdin().lock(), std::io::stdout().lock());
        if let Err(error) = result
            && error.kind() != std::io::ErrorKind::BrokenPipe
        {
            return Err(error).context("转发 Codex 本地路由请求失败");
        }
        return Ok(true);
    }
    #[cfg(windows)]
    if run_windows_package_resume_helper_if_requested()? {
        return Ok(true);
    }

    let original_args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let app_server = original_args
        .iter()
        .filter(|argument| argument.as_os_str() == OsStr::new("app-server"))
        .count()
        == 1;
    let environment_target = std::env::var_os(CLI_WRAPPER_TARGET_ENV);
    #[cfg(windows)]
    let detached = environment_target.is_none();
    let Some((target, launch_source)) = cli_wrapper_target(
        &original_args,
        environment_target,
        &crate::config::ConfigStore::default(),
    )
    .inspect_err(|_| {
        #[cfg(windows)]
        if detached {
            log_detached_cli_launch(app_server, "none", "rejected");
        }
    })?
    else {
        return Ok(false);
    };
    // 启动器只接收首次握手；之后 app-server 重启时仍必须能执行 CLI。
    let resolved =
        resolve_cli_wrapper_launch(&launch_source, app_server, |name| std::env::var_os(name));
    let readiness = resolved.begin_readiness.then(CliWrapperReadiness::begin);
    let mut input_router: Option<std::process::Child> = None;
    let launch = (|| -> Result<std::process::Child> {
        anyhow::ensure!(
            target.is_absolute(),
            "Codex CLI 兼容目标无效：{}",
            target.display()
        );
        let metadata = std::fs::metadata(&target)
            .with_context(|| format!("Codex CLI 兼容目标无效：{}", target.display()))?;
        anyhow::ensure!(
            metadata.is_file(),
            "Codex CLI 兼容目标不是文件：{}",
            target.display()
        );
        if std::fs::canonicalize(&target).ok()
            == std::env::current_exe().and_then(std::fs::canonicalize).ok()
        {
            anyhow::bail!("Codex CLI 兼容目标不能指向 Codey 自身");
        }
        let runtime_overrides = resolved.overrides?;
        let rewritten_args = rewrite_app_server_args(&original_args, &runtime_overrides)?;
        let mut command = std::process::Command::new(&target);
        command.args(rewritten_args);
        for name in [
            "CODEX_CLI_PATH",
            CLI_WRAPPER_TARGET_ENV,
            CLI_WRAPPER_OVERRIDES_ENV,
            CLI_WRAPPER_SUBAGENT_ENV,
            CLI_WRAPPER_PORT_ENV,
            CLI_WRAPPER_TOKEN_ENV,
            CLI_WRAPPER_MARKER_ENV,
            CLI_WRAPPER_HANDSHAKE_OPTIONAL_ENV,
            "NODE_OPTIONS",
        ] {
            command.env_remove(name);
        }
        if app_server && resolved.subagent {
            command.env(crate::subagent_gate::RUNTIME_ACTIVE_ENV, "1");
            command.env(
                crate::subagent_gate::RUNTIME_ID_ENV,
                uuid::Uuid::new_v4().to_string(),
            );
        }
        if let Some(parent) = target.parent() {
            let mut paths = vec![parent.to_path_buf()];
            if let Some(path) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&path));
            }
            if let Ok(path) = std::env::join_paths(paths) {
                command.env("PATH", path);
            }
        }
        if app_server && local_router_runtime_enabled(&runtime_overrides) {
            // Keep macOS exec/PID semantics. The helper owns only the input pipe;
            // Desktop closing stdin ends it, including when app-server restarts.
            let mut relay = std::process::Command::new(std::env::current_exe()?);
            relay
                .arg("--codey-route-app-server-input")
                .stdout(std::process::Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                relay.creation_flags(codey_runtime_core::windows_create_no_window());
            }
            let mut relay = relay.spawn().context("启动 Codex 本地路由请求转发失败")?;
            command.stdin(
                relay
                    .stdout
                    .take()
                    .context("Codex 本地路由请求管道不可用")?,
            );
            input_router = Some(relay);
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::process::CommandExt;
            // exec 成功后不再有机会写文件：先记录已执行，exec 失败时随后改写为失败。
            if let Some(readiness) = readiness.as_ref() {
                readiness.mark_executed();
            }
            let _ = codey_runtime_core::diagnostic_log::flush_diagnostic_log();
            Err(command.exec())
                .with_context(|| format!("启动 Codex CLI 失败：{}", target.display()))
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(codey_runtime_core::windows_create_no_window());
            command
                .spawn()
                .with_context(|| format!("启动 Codex CLI 失败：{}", target.display()))
        }
    })();
    #[cfg(windows)]
    if !matches!(launch_source, CliWrapperLaunchSource::Environment(_)) {
        log_detached_cli_launch(
            app_server,
            if matches!(launch_source, CliWrapperLaunchSource::Persisted(_)) {
                "persisted"
            } else {
                "none"
            },
            if launch.is_ok() { "spawned" } else { "failed" },
        );
    }
    let mut child = match launch {
        Ok(child) => child,
        Err(error) => {
            if let Some(mut relay) = input_router {
                let _ = relay.kill();
                let _ = relay.wait();
            }
            if let Some(readiness) = readiness {
                // 校验或创建进程失败必须显式回传，避免被误报成握手超时。
                readiness.fail(&CliWrapperFailure {
                    message: format!("{error:#}").chars().take(1024).collect(),
                    retryable: error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(is_retryable_startup_io_error),
                });
            }
            return Err(error);
        }
    };
    // macOS exec 成功由 CLOEXEC 关闭连接；Windows 只在 spawn 成功后关闭。
    if let Some(readiness) = readiness {
        readiness.executed();
    }
    let status = child.wait();
    if let Some(mut relay) = input_router {
        let _ = relay.kill();
        let _ = relay.wait();
    }
    let status =
        status.with_context(|| format!("等待 Codex CLI 退出失败：{}", target.display()))?;
    let _ = codey_runtime_core::diagnostic_log::flush_diagnostic_log();
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(any(windows, target_os = "macos", test))]
fn route_local_app_server_input(
    mut input: impl std::io::BufRead,
    mut output: impl std::io::Write,
) -> std::io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        if let Ok(mut message) = serde_json::from_slice::<serde_json::Value>(&line)
            && matches!(
                message.get("method").and_then(serde_json::Value::as_str),
                Some("thread/start" | "thread/resume" | "thread/fork")
            )
        {
            if message.get("params").is_none_or(serde_json::Value::is_null) {
                message["params"] = serde_json::json!({});
            }
            if let Some(params) = message
                .get_mut("params")
                .and_then(serde_json::Value::as_object_mut)
            {
                params.insert("modelProvider".into(), "codey_router".into());
                if let Some(config) = params
                    .get_mut("config")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    config.retain(|key, _| {
                        key != "model_provider"
                            && !key.starts_with("model_provider.")
                            && key != "model_providers"
                            && !key.starts_with("model_providers.")
                    });
                }
                line = serde_json::to_vec(&message).map_err(std::io::Error::other)?;
                line.push(b'\n');
            }
        }
        output.write_all(&line)?;
        output.flush()?;
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn run_cli_wrapper_if_requested() -> Result<bool> {
    Ok(false)
}

#[cfg(windows)]
fn run_windows_package_resume_helper_if_requested() -> Result<bool> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let Some(WindowsPackageResumeTarget {
        process_id,
        thread_id,
        launch_id,
        feedback_path,
    }) = windows_package_resume_target(&arguments)?
    else {
        return Ok(false);
    };
    let result = crate::launcher::resume_windows_packaged_thread(
        process_id,
        thread_id,
        launch_id,
        &feedback_path,
    );
    if let Err(error) = &result {
        crate::error_log::record_failure(
            "package_thread_resume_failed",
            "resume_windows_packaged_thread",
            format!("{error:#}"),
            serde_json::json!({"processId": process_id, "threadId": thread_id}),
        );
    }
    let _ = codey_runtime_core::diagnostic_log::flush_diagnostic_log();
    result.map(|_| true)
}

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
struct WindowsPackageResumeTarget {
    process_id: u32,
    thread_id: u32,
    launch_id: uuid::Uuid,
    feedback_path: std::path::PathBuf,
}

#[cfg(any(windows, test))]
fn windows_package_resume_target(
    arguments: &[OsString],
) -> Result<Option<WindowsPackageResumeTarget>> {
    if arguments.first().and_then(|value| value.to_str()) != Some(WINDOWS_PACKAGE_RESUME_ARGUMENT) {
        return Ok(None);
    }
    let mut process_id = None;
    let mut thread_id = None;
    let mut launch_id = None;
    let mut feedback_path = None;
    let (pairs, remainder) = arguments[1..].as_chunks::<2>();
    for pair in pairs {
        let name = pair[0].to_str().context("Windows Store 启动参数名称无效")?;
        if name.eq_ignore_ascii_case("--launch-state") {
            anyhow::ensure!(feedback_path.is_none(), "Windows Store 启动通知路径重复");
            feedback_path = Some(std::path::PathBuf::from(&pair[1]));
            continue;
        }
        if name.eq_ignore_ascii_case("--launch-id") {
            anyhow::ensure!(launch_id.is_none(), "Windows Store 启动标识重复");
            let value = pair[1].to_str().context("Windows Store 启动标识无效")?;
            let id = uuid::Uuid::parse_str(value).context("Windows Store 启动标识无效")?;
            anyhow::ensure!(!id.is_nil(), "Windows Store 启动标识为空");
            launch_id = Some(id);
            continue;
        }
        let target = if name.eq_ignore_ascii_case("-p") {
            &mut process_id
        } else if name.eq_ignore_ascii_case("-tid") {
            &mut thread_id
        } else {
            anyhow::bail!("Windows Store 启动参数不受支持");
        };
        anyhow::ensure!(target.is_none(), "Windows Store 启动参数重复");
        let value = pair[1]
            .to_str()
            .context("Windows Store 进程或线程 ID 无效")?;
        anyhow::ensure!(
            !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
            "Windows Store 进程或线程 ID 无效"
        );
        let value = value
            .parse::<u32>()
            .context("Windows Store 进程或线程 ID 无效")?;
        anyhow::ensure!(value != 0, "Windows Store 进程或线程 ID 为空");
        *target = Some(value);
    }
    anyhow::ensure!(remainder.is_empty(), "Windows Store 启动参数缺少值");
    let launch_id = launch_id.context("Windows Store 未传递启动标识")?;
    let feedback_path = feedback_path.context("Windows Store 未传递启动通知路径")?;
    anyhow::ensure!(
        feedback_path.is_absolute()
            && feedback_path.file_name() == Some(OsStr::new(&format!("resume-{launch_id}.json"))),
        "Windows Store 启动通知路径与本次启动不匹配"
    );
    Ok(Some(WindowsPackageResumeTarget {
        process_id: process_id.context("Windows Store 未传递待恢复的进程 ID")?,
        thread_id: thread_id.context("Windows Store 未传递待恢复的线程 ID")?,
        launch_id,
        feedback_path,
    }))
}

/// 包装器向启动器汇报进度的两条通道：回环握手连接和记录文件。任一到达即可确认。
#[cfg(any(windows, target_os = "macos", test))]
struct CliWrapperReadiness {
    stream: Option<std::net::TcpStream>,
    marker: Option<std::path::PathBuf>,
    tcp_deferred: bool,
}

#[cfg(any(windows, target_os = "macos", test))]
impl CliWrapperReadiness {
    fn begin() -> Self {
        let started = std::time::Instant::now();
        let marker = cli_wrapper_marker_path_from_env(std::env::var_os(CLI_WRAPPER_MARKER_ENV));
        let handshake_required = cli_wrapper_handshake_required(
            std::env::var_os(CLI_WRAPPER_HANDSHAKE_OPTIONAL_ENV).as_deref(),
        );
        Self::begin_with_diagnostics(
            marker,
            handshake_required,
            started,
            cfg!(windows),
            connect_cli_wrapper_handshake,
        )
    }

    #[cfg(test)]
    fn begin_with(
        marker: Option<std::path::PathBuf>,
        handshake_required: bool,
        prefer_marker: bool,
        connect: impl FnOnce() -> Result<std::net::TcpStream>,
    ) -> Self {
        Self::begin_with_diagnostics(
            marker,
            handshake_required,
            std::time::Instant::now(),
            prefer_marker,
            connect,
        )
    }

    fn begin_with_diagnostics(
        marker: Option<std::path::PathBuf>,
        handshake_required: bool,
        started: std::time::Instant,
        prefer_marker: bool,
        connect: impl FnOnce() -> Result<std::net::TcpStream>,
    ) -> Self {
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "launcher.cli_wrapper_started",
            serde_json::json!({
                "pid": std::process::id(),
                "markerPresent": marker.is_some(),
                "handshakeRequired": handshake_required,
            }),
        );
        let readiness = Self {
            stream: None,
            marker,
            tcp_deferred: false,
        };
        let marker_written = readiness.mark(CliWrapperMarkerStatus::Launching, None);
        // Windows 回环连接可能受网络隔离影响。只有本次记录写入成功才跳过 TCP，
        // 启动器仍须等到 Executed 或 Failed；路径已配置不代表文件通道可用。
        let tcp_required = handshake_required && (!prefer_marker || !marker_written);
        let stream = if tcp_required {
            readiness.connect_with_diagnostics(marker_written, connect)
        } else {
            None
        };
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "launcher.cli_wrapper_handshake_connect",
            serde_json::json!({
                "connected": stream.is_some(),
                "tcpAttempted": tcp_required,
                "markerWritten": marker_written,
                "elapsedMs": started.elapsed().as_millis(),
            }),
        );
        Self {
            stream,
            tcp_deferred: handshake_required && !tcp_required,
            ..readiness
        }
    }

    fn connect_with_diagnostics(
        &self,
        marker_written: bool,
        connect: impl FnOnce() -> Result<std::net::TcpStream>,
    ) -> Option<std::net::TcpStream> {
        match connect() {
            Ok(stream) => Some(stream),
            Err(error) => {
                // 端口被拒绝说明启动器已不再监听（例如 app-server 重启），属正常情况。
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_none_or(|error| error.kind() != std::io::ErrorKind::ConnectionRefused)
                {
                    crate::error_log::record_failure(
                        "compatibility_fallback",
                        "connect_cli_wrapper_handshake",
                        format!("{error:#}"),
                        serde_json::json!({
                            "markerPresent": self.marker.is_some(),
                            "markerWritten": marker_written,
                        }),
                    );
                }
                None
            }
        }
    }

    fn mark(&self, status: CliWrapperMarkerStatus, failure: Option<&CliWrapperFailure>) -> bool {
        let Some(path) = self.marker.as_deref() else {
            return false;
        };
        let mut marker = CliWrapperMarker::new(status);
        if let Some(failure) = failure {
            marker.message = Some(failure.message.clone());
            marker.retryable = Some(failure.retryable);
        }
        if let Err(error) = marker.write(path) {
            crate::error_log::record_failure(
                "compatibility_fallback",
                "write_cli_wrapper_marker",
                format!("{error:#}"),
                serde_json::json!({ "marker": path, "status": status }),
            );
            return false;
        }
        true
    }

    fn mark_executed(&self) -> bool {
        self.mark(CliWrapperMarkerStatus::Executed, None)
    }

    fn fail(self, failure: &CliWrapperFailure) {
        self.finish_with(Some(failure), connect_cli_wrapper_handshake);
    }

    /// 记录已执行；随后 drop 关闭握手连接，启动器以 EOF 作为执行确认。
    fn executed(self) {
        self.finish_with(None, connect_cli_wrapper_handshake);
    }

    fn finish_with(
        mut self,
        failure: Option<&CliWrapperFailure>,
        connect: impl FnOnce() -> Result<std::net::TcpStream>,
    ) {
        let marker_written = match failure {
            Some(failure) => self.mark(CliWrapperMarkerStatus::Failed, Some(failure)),
            None => self.mark_executed(),
        };
        // 初次写入成功后，文件仍可能被占用。仅在此前没有尝试 TCP 时补一次有界连接，
        // 避免丢失最终状态，也不会叠加两次连接重试预算。
        if !marker_written && self.tcp_deferred {
            let started = std::time::Instant::now();
            self.stream = self.connect_with_diagnostics(false, connect);
            let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                "launcher.cli_wrapper_handshake_fallback",
                serde_json::json!({
                    "connected": self.stream.is_some(),
                    "elapsedMs": started.elapsed().as_millis(),
                }),
            );
        }
        if let Some(failure) = failure
            && let Some(mut stream) = self.stream.take()
        {
            let _ = stream.write_all(b"!");
            let _ = serde_json::to_writer(&mut stream, failure);
        }
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn cli_wrapper_handshake_required(optional: Option<&OsStr>) -> bool {
    optional != Some(OsStr::new("1"))
}

#[cfg(any(windows, target_os = "macos", test))]
fn connect_cli_wrapper_handshake() -> Result<std::net::TcpStream> {
    let port = std::env::var(CLI_WRAPPER_PORT_ENV)
        .context("Codex CLI 缺少兼容校验端口")?
        .parse::<u16>()
        .context("Codex CLI 兼容校验端口无效")?;
    anyhow::ensure!(port != 0, "Codex CLI 兼容校验端口不能为 0");
    let token = std::env::var(CLI_WRAPPER_TOKEN_ENV).context("Codex CLI 缺少兼容校验令牌")?;
    anyhow::ensure!(
        !token.is_empty() && token.len() <= 128,
        "Codex CLI 兼容校验令牌无效"
    );
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = connect_loopback_with_retry(
        &address,
        std::time::Instant::now() + CLI_WRAPPER_HANDSHAKE_CONNECT_BUDGET,
    )
    .context("连接 Codex CLI 兼容校验端口失败")?;
    stream
        .set_write_timeout(Some(CLI_WRAPPER_HANDSHAKE_CONNECT_TIMEOUT))
        .context("设置 Codex CLI 兼容校验写入时限失败")?;
    stream
        .write_all(token.as_bytes())
        .context("发送 Codex CLI 兼容校验令牌失败")?;
    Ok(stream)
}

/// 被拒绝立即返回；超时等暂时性错误在预算内重试，避免单次 500ms 连不上就静默放弃握手。
#[cfg(any(windows, target_os = "macos", test))]
fn connect_loopback_with_retry(
    address: &std::net::SocketAddr,
    deadline: std::time::Instant,
) -> std::io::Result<std::net::TcpStream> {
    connect_loopback_with_retry_using(address, deadline, std::net::TcpStream::connect_timeout)
}

#[cfg(any(windows, target_os = "macos", test))]
fn connect_loopback_with_retry_using(
    address: &std::net::SocketAddr,
    deadline: std::time::Instant,
    mut connect: impl FnMut(
        &std::net::SocketAddr,
        std::time::Duration,
    ) -> std::io::Result<std::net::TcpStream>,
) -> std::io::Result<std::net::TcpStream> {
    let mut attempts = 0_u32;
    loop {
        attempts += 1;
        match connect(address, CLI_WRAPPER_HANDSHAKE_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                return Err(error);
            }
            Err(error) => {
                let now = std::time::Instant::now();
                if now + CLI_WRAPPER_HANDSHAKE_RETRY_DELAY >= deadline {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("{error}（已重试 {attempts} 次）"),
                    ));
                }
                std::thread::sleep(CLI_WRAPPER_HANDSHAKE_RETRY_DELAY);
            }
        }
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn runtime_override_key(config: &str) -> &str {
    config.split_once('=').map_or(config, |(key, _)| key).trim()
}

#[cfg(any(windows, target_os = "macos", test))]
fn app_server_runtime_configs(runtime_overrides: &[String]) -> Vec<String> {
    let mut configs = vec!["analytics.enabled=false".to_string()];
    for config in runtime_overrides {
        let key = runtime_override_key(config);
        if key.is_empty() || key == "analytics.enabled" || key.starts_with("__CODEY_WSL_ONLY__:") {
            continue;
        }
        if let Some(index) = configs
            .iter()
            .position(|existing| runtime_override_key(existing) == key)
        {
            configs[index] = config.clone();
        } else {
            configs.push(config.clone());
        }
    }
    configs
}

#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn local_router_runtime_enabled(overrides: &[String]) -> bool {
    overrides.iter().rev().find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        (key.trim() == "model_provider").then(|| value.trim().trim_matches(['\'', '"']))
    }) == Some(crate::codey_router_session_migrate::ROUTER_PROVIDER_ID)
}

#[cfg(any(windows, target_os = "macos", test))]
fn rewrite_app_server_args(
    args: &[OsString],
    runtime_overrides: &[String],
) -> Result<Vec<OsString>> {
    if args
        .iter()
        .filter(|argument| argument.as_os_str() == OsStr::new("app-server"))
        .count()
        != 1
    {
        return Ok(args.to_vec());
    }

    anyhow::ensure!(
        !local_router_runtime_enabled(runtime_overrides)
            || !args.iter().any(|arg| arg == "proxy" || arg == "daemon"),
        "本地路由模式不能使用 app-server proxy/daemon；请移除自定义后台服务启动命令"
    );

    let configs = app_server_runtime_configs(runtime_overrides);
    let managed_keys = configs
        .iter()
        .map(|config| runtime_override_key(config))
        .collect::<std::collections::HashSet<_>>();
    let mut rewritten = Vec::with_capacity(args.len() + configs.len() * 2);
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if argument.as_os_str() == OsStr::new("--analytics-default-enabled") {
            index += 1;
            continue;
        }
        if (argument.as_os_str() == OsStr::new("-c")
            || argument.as_os_str() == OsStr::new("--config"))
            && let Some(config) = args.get(index + 1).and_then(|value| value.to_str())
        {
            if !managed_keys.contains(runtime_override_key(config)) {
                rewritten.push(argument.clone());
                rewritten.push(args[index + 1].clone());
            }
            index += 2;
            continue;
        }
        if let Some(config) = argument
            .to_str()
            .and_then(|value| value.strip_prefix("--config="))
            && managed_keys.contains(runtime_override_key(config))
        {
            index += 1;
            continue;
        }
        rewritten.push(argument.clone());
        index += 1;
    }

    // Parent-table overrides from Desktop must precede the runtime fields.
    rewritten.extend(
        configs
            .into_iter()
            .flat_map(|config| [OsString::from("-c"), OsString::from(config)]),
    );
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    #[test]
    fn cli_wrapper_launch_source_persisted_ignores_conflicting_environment() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "lease_id": "active", "target": "persisted-cli",
            "overrides": ["model=\"persisted\""], "subagent": true
        }))
        .unwrap();
        let environment = [
            (CLI_WRAPPER_OVERRIDES_ENV, "invalid environment overrides"),
            (CLI_WRAPPER_SUBAGENT_ENV, "0"),
            (CLI_WRAPPER_MARKER_ENV, "stray-marker"),
            (CLI_WRAPPER_PORT_ENV, "1234"),
            (CLI_WRAPPER_TOKEN_ENV, "stray-token"),
            (CLI_WRAPPER_HANDSHAKE_OPTIONAL_ENV, "0"),
        ];
        let reads = std::cell::Cell::new(0);
        let get_env = |name: &str| {
            reads.set(reads.get() + 1);
            environment
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        };
        let source = cli_wrapper_launch_source(get_env(CLI_WRAPPER_TARGET_ENV), true, || {
            Some((bytes, Some("active".into())))
        })
        .unwrap();
        reads.set(0);
        let resolved = resolve_cli_wrapper_launch(&source, true, get_env);
        assert_eq!(resolved.overrides.unwrap(), ["model=\"persisted\""]);
        assert!(resolved.subagent);
        assert!(!resolved.begin_readiness);
        assert_eq!(reads.get(), 0);
    }

    #[test]
    fn cli_wrapper_launch_source_environment_begins_readiness_for_app_server() {
        let source = cli_wrapper_launch_source(Some("env-cli".into()), true, || {
            panic!("must not read file")
        })
        .unwrap();
        for app_server in [true, false] {
            let resolved = resolve_cli_wrapper_launch(&source, app_server, |name| match name {
                CLI_WRAPPER_OVERRIDES_ENV => Some(r#"["model=\"environment\""]"#.into()),
                CLI_WRAPPER_SUBAGENT_ENV => Some("1".into()),
                _ => panic!("must not read handshake values"),
            });
            assert_eq!(resolved.overrides.unwrap(), ["model=\"environment\""]);
            assert!(resolved.subagent);
            assert_eq!(resolved.begin_readiness, app_server);
        }
    }

    #[test]
    fn cli_wrapper_launch_source_environment_missing_overrides_still_refuses() {
        let source = cli_wrapper_launch_source(Some("env-cli".into()), true, || {
            panic!("must not read file")
        })
        .unwrap();
        let resolved = resolve_cli_wrapper_launch(&source, true, |_| None);
        assert!(resolved.begin_readiness);
        assert!(
            resolved
                .overrides
                .unwrap_err()
                .to_string()
                .contains("缺少本次启动配置")
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_wrapper_launch_source_temp_store_requires_matching_lease() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::config::ConfigStore::new(directory.path().join("config.json"));
        let lease = directory.path().join("codex-lease.json");
        std::fs::write(
            &lease,
            serde_json::json!({
                "launchId": "active", "backupDir": directory.path().join("backup")
            })
            .to_string(),
        )
        .unwrap();
        let target = directory.path().join("codex.exe");
        write_windows_cli_wrapper_launch(
            store.path(),
            &target,
            &["model=\"persisted\"".into()],
            true,
        )
        .unwrap();
        let arguments = [OsString::from("app-server")];
        let (actual_target, source) = cli_wrapper_target(&arguments, None, &store)
            .unwrap()
            .unwrap();
        assert_eq!(actual_target, target);
        let resolved =
            resolve_cli_wrapper_launch(&source, true, |_| panic!("must not read environment"));
        assert_eq!(resolved.overrides.unwrap(), ["model=\"persisted\""]);
        assert!(resolved.subagent);
        assert!(!resolved.begin_readiness);
        std::fs::remove_file(lease).unwrap();
        assert!(
            cli_wrapper_target(&arguments, None, &store)
                .unwrap_err()
                .to_string()
                .contains("缺少本次启动配置")
        );
    }

    #[test]
    fn cli_wrapper_launch_source_env_wins_without_reading_file() {
        let source = super::cli_wrapper_launch_source(Some("env-cli".into()), true, || {
            panic!("environment source must not consult the file")
        })
        .unwrap();
        assert!(
            matches!(source, super::CliWrapperLaunchSource::Environment(target) if target == std::path::Path::new("env-cli"))
        );
    }

    #[test]
    fn cli_wrapper_launch_source_file_supplies_all_three_values() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "lease_id": "active", "target": "persisted-cli",
            "overrides": ["model=\"persisted-model\""], "subagent": true
        }))
        .unwrap();
        let source =
            super::cli_wrapper_launch_source(None, true, || Some((bytes, Some("active".into()))))
                .unwrap();
        let super::CliWrapperLaunchSource::Persisted(config) = source else {
            panic!("expected persisted launch")
        };
        assert_eq!(config.target, std::path::Path::new("persisted-cli"));
        assert_eq!(config.overrides, ["model=\"persisted-model\""]);
        assert!(config.subagent);
    }

    #[test]
    fn cli_wrapper_launch_source_missing_corrupt_or_incomplete_file_refuses_app_server() {
        for bytes in [
            None,
            Some(b"not json".to_vec()),
            Some(br#"{"version":1,"lease_id":"active","target":"cli","subagent":false}"#.to_vec()),
        ] {
            let error = super::cli_wrapper_launch_source(None, true, || {
                bytes.map(|bytes| (bytes, Some("active".into())))
            })
            .unwrap_err();
            assert!(error.to_string().contains("缺少本次启动配置"));
        }
        assert!(matches!(
            super::cli_wrapper_launch_source(None, false, || None).unwrap(),
            super::CliWrapperLaunchSource::None
        ));
    }

    #[test]
    fn cli_wrapper_launch_source_rejects_wrong_version_and_replaced_lease() {
        for (version, lease_id) in [(2, Some("active")), (1, Some("replacement")), (1, None)] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "version": version, "lease_id": "active", "target": "cli", "overrides": [], "subagent": false
            })).unwrap();
            let error = super::cli_wrapper_launch_source(None, true, || {
                Some((bytes, lease_id.map(str::to_owned)))
            })
            .unwrap_err();
            assert!(error.to_string().contains("缺少本次启动配置"));
        }
    }

    use super::*;

    #[test]
    fn cli_wrapper_handshake_is_required_unless_marked_optional() {
        assert!(cli_wrapper_handshake_required(None));
        assert!(cli_wrapper_handshake_required(Some(OsStr::new("0"))));
        assert!(!cli_wrapper_handshake_required(Some(OsStr::new("1"))));
    }

    #[cfg(any(windows, target_os = "macos", test))]
    #[test]
    fn optional_cli_wrapper_handshake_writes_marker_without_connecting() {
        let temporary = tempfile::tempdir().unwrap();
        let marker_path = temporary.path().join("wrapper.json");
        let readiness =
            CliWrapperReadiness::begin_with(Some(marker_path.clone()), false, false, || {
                panic!("a marker-only wrapper must not connect")
            });
        assert!(readiness.stream.is_none());
        assert_eq!(
            CliWrapperMarker::read(&marker_path)
                .unwrap()
                .unwrap()
                .status,
            CliWrapperMarkerStatus::Launching
        );
        readiness.executed();
        assert_eq!(
            CliWrapperMarker::read(&marker_path)
                .unwrap()
                .unwrap()
                .status,
            CliWrapperMarkerStatus::Executed
        );
        let readiness =
            CliWrapperReadiness::begin_with(Some(marker_path.clone()), false, false, || {
                panic!("a marker-only wrapper must not connect")
            });
        readiness.fail(&CliWrapperFailure {
            message: "目标程序被占用".to_string(),
            retryable: true,
        });
        let marker = CliWrapperMarker::read(&marker_path).unwrap().unwrap();
        assert_eq!(marker.status, CliWrapperMarkerStatus::Failed);
        assert_eq!(marker.message.as_deref(), Some("目标程序被占用"));
        assert_eq!(marker.retryable, Some(true));
    }

    #[test]
    fn windows_cli_wrapper_confirms_execution_and_failure_through_written_marker() {
        for failure in [None, Some(false), Some(true)] {
            let temporary = tempfile::tempdir().unwrap();
            let marker_path = temporary.path().join("wrapper.json");
            assert!(!marker_path.exists());
            let readiness =
                CliWrapperReadiness::begin_with(Some(marker_path.clone()), true, true, || {
                    panic!("a successfully written Windows marker must avoid the TCP connection")
                });
            assert!(readiness.stream.is_none());
            assert_eq!(
                CliWrapperMarker::read(&marker_path)
                    .unwrap()
                    .unwrap()
                    .status,
                CliWrapperMarkerStatus::Launching
            );
            if let Some(retryable) = failure {
                readiness.fail(&CliWrapperFailure {
                    message: "CLI process creation failed".into(),
                    retryable,
                });
            } else {
                readiness.executed();
            }
            let marker = CliWrapperMarker::read(&marker_path).unwrap().unwrap();
            assert_eq!(marker.retryable, failure);
            if failure.is_some() {
                assert_eq!(marker.status, CliWrapperMarkerStatus::Failed);
                assert_eq!(
                    marker.message.as_deref(),
                    Some("CLI process creation failed")
                );
            } else {
                assert_eq!(marker.status, CliWrapperMarkerStatus::Executed);
                assert_eq!(marker.message, None);
            }
        }
    }

    #[test]
    fn windows_cli_wrapper_keeps_tcp_confirmation_when_marker_missing_or_unwritable() {
        use std::io::Read;

        let temporary = tempfile::tempdir().unwrap();
        let blocked_destination = temporary.path().join("directory.json");
        std::fs::create_dir(&blocked_destination).unwrap();
        let blocked_parent = temporary.path().join("file");
        std::fs::write(&blocked_parent, b"not a directory").unwrap();
        for marker in [
            None,
            Some(blocked_destination),
            Some(blocked_parent.join("wrapper.json")),
        ] {
            for failure in [None, Some(false), Some(true)] {
                let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                let readiness = CliWrapperReadiness::begin_with(marker.clone(), true, true, || {
                    Ok(std::net::TcpStream::connect(listener.local_addr()?)?)
                });
                assert!(readiness.stream.is_some());
                let (mut receiver, _) = listener.accept().unwrap();
                receiver
                    .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                    .unwrap();
                if let Some(retryable) = failure {
                    readiness.fail(&CliWrapperFailure {
                        message: "CLI process creation failed".into(),
                        retryable,
                    });
                } else {
                    readiness.executed();
                }
                let mut received = Vec::new();
                receiver.read_to_end(&mut received).unwrap();
                if let Some(retryable) = failure {
                    assert_eq!(received.first(), Some(&b'!'));
                    let failure: CliWrapperFailure =
                        serde_json::from_slice(&received[1..]).unwrap();
                    assert_eq!(failure.message, "CLI process creation failed");
                    assert_eq!(failure.retryable, retryable);
                } else {
                    assert!(received.is_empty(), "execution is confirmed by EOF");
                }
            }
        }
    }

    #[test]
    fn windows_cli_wrapper_falls_back_to_tcp_if_final_marker_write_fails() {
        use std::io::Read;

        for retryable in [None, Some(false), Some(true)] {
            let temporary = tempfile::tempdir().unwrap();
            let marker_path = temporary.path().join("wrapper.json");
            let readiness =
                CliWrapperReadiness::begin_with(Some(marker_path.clone()), true, true, || {
                    panic!("the initial marker write succeeded")
                });
            assert_eq!(
                CliWrapperMarker::read(&marker_path)
                    .unwrap()
                    .unwrap()
                    .status,
                CliWrapperMarkerStatus::Launching
            );
            std::fs::remove_file(&marker_path).unwrap();
            std::fs::create_dir(&marker_path).unwrap();
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let failure = retryable.map(|retryable| CliWrapperFailure {
                message: "CLI process creation failed".into(),
                retryable,
            });
            let mut attempted = false;
            readiness.finish_with(failure.as_ref(), || {
                attempted = true;
                Ok(std::net::TcpStream::connect(listener.local_addr()?)?)
            });
            assert!(
                attempted,
                "the failed final write must use the deferred TCP channel"
            );
            let (mut receiver, _) = listener.accept().unwrap();
            receiver
                .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                .unwrap();
            let mut received = Vec::new();
            receiver.read_to_end(&mut received).unwrap();
            if let Some(retryable) = retryable {
                assert_eq!(received.first(), Some(&b'!'));
                let failure: CliWrapperFailure = serde_json::from_slice(&received[1..]).unwrap();
                assert_eq!(failure.message, "CLI process creation failed");
                assert_eq!(failure.retryable, retryable);
            } else {
                assert!(received.is_empty(), "execution is confirmed by EOF");
            }
        }
    }

    #[test]
    fn cli_wrapper_does_not_repeat_an_exhausted_tcp_connect_budget() {
        for prefer_marker in [false, true] {
            let readiness = CliWrapperReadiness::begin_with(None, true, prefer_marker, || {
                Err(std::io::Error::from(std::io::ErrorKind::TimedOut).into())
            });
            readiness.finish_with(None, || {
                panic!("the connection budget was already used before launching")
            });
        }
    }

    #[test]
    fn cli_wrapper_readiness_writes_marker_even_when_handshake_is_refused() {
        let temporary = tempfile::tempdir().unwrap();
        let marker_path = temporary.path().join("wrapper.json");
        let mut attempted = false;
        let readiness =
            CliWrapperReadiness::begin_with(Some(marker_path.clone()), true, false, || {
                attempted = true;
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "listener already gone",
                )
                .into())
            });
        assert!(
            attempted,
            "other platforms keep TCP even after the marker was written"
        );
        assert!(readiness.stream.is_none());
        assert_eq!(
            CliWrapperMarker::read(&marker_path)
                .unwrap()
                .unwrap()
                .status,
            CliWrapperMarkerStatus::Launching
        );
    }

    #[test]
    fn cli_input_routes_thread_requests_and_preserves_other_protocol_messages() {
        for method in ["thread/start", "thread/resume", "thread/fork"] {
            let message = serde_json::json!({
                "id": 17, "method": method,
                "params": { "threadId": "old-thread", "model": "route-second/gpt-6-astra",
                    "modelProvider": null, "config": { "model_provider": "first",
                        "model_provider.name": "first", "model_providers": {"first": {}},
                        "model_providers.codey_router.base_url": "https://wrong.example",
                        "service_tier": "fast", "artifact.session": "keep" } }
            });
            let passthrough = b"{\"id\":18,\"method\":\"turn/start\",\"params\":{\"model\":\"route-second/gpt-6-astra\"}}\r\n{\"id\":19,\"result\":{}}\ninvalid-json\n";
            let mut input = serde_json::to_vec(&message).unwrap();
            input.push(b'\n');
            input.extend_from_slice(passthrough);
            let mut output = Vec::new();
            // One-byte buffers exercise split messages without changing framing.
            route_local_app_server_input(
                std::io::BufReader::with_capacity(1, input.as_slice()),
                &mut output,
            )
            .unwrap();
            let first_line = output.iter().position(|byte| *byte == b'\n').unwrap();
            let routed: serde_json::Value = serde_json::from_slice(&output[..first_line]).unwrap();
            assert_eq!(
                routed,
                serde_json::json!({ "id": 17, "method": method,
                    "params": { "threadId": "old-thread", "model": "route-second/gpt-6-astra",
                        "modelProvider": "codey_router", "config": { "service_tier": "fast", "artifact.session": "keep" } }
                })
            );
            assert_eq!(&output[first_line + 1..], passthrough);
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn detached_cli_calls_resolve_the_saved_app_or_fail_without_starting_the_desktop() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::config::ConfigStore::new(temp.path().join("config.json"));
        #[cfg(target_os = "macos")]
        let app = temp.path().join("Codex.app");
        #[cfg(windows)]
        let app = temp.path().join("Codex");
        #[cfg(target_os = "macos")]
        let target = app.join("Contents/Resources/codex");
        #[cfg(windows)]
        let target = app.join("resources/codex.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "test CLI").unwrap();
        #[cfg(windows)]
        std::fs::write(app.join("Codex.exe"), "test desktop").unwrap();
        #[cfg(target_os = "macos")]
        {
            std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            std::fs::write(app.join("Contents/MacOS/Codex"), "test desktop").unwrap();
            std::fs::write(
                app.join("Contents/Info.plist"),
                "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>",
            )
            .unwrap();
        }
        let package = target.parent().unwrap().join("app/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(
            package,
            r#"{"name":"codex","productName":"Codex","version":"1.0.0"}"#,
        )
        .unwrap();
        store
            .save(&crate::config::CodeyConfig {
                codex_app_path: app.to_string_lossy().into_owned(),
                ..Default::default()
            })
            .unwrap();
        for args in [
            vec!["sandbox", "windows", "--", "node.exe"],
            #[cfg(target_os = "macos")]
            vec!["-c", "key=value", "app-server"],
            vec!["exec-server"],
            vec!["--version"],
        ] {
            assert_eq!(
                cli_wrapper_target(
                    &args.iter().map(OsString::from).collect::<Vec<_>>(),
                    None,
                    &store
                )
                .unwrap()
                .map(|(target, _)| target),
                Some(target.clone()),
            );
        }
        std::fs::remove_file(&target).unwrap();
        assert!(cli_wrapper_target(&["sandbox".into()], None, &store).is_err());
        assert_eq!(cli_wrapper_target(&[], None, &store).unwrap(), None);
        assert_eq!(
            cli_wrapper_target(&["--debug-port".into(), "9333".into()], None, &store).unwrap(),
            None,
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            cli_wrapper_target(&["-psn_0_1".into()], None, &store).unwrap(),
            None
        );
        std::fs::write(store.path(), "invalid config").unwrap();
        assert!(cli_wrapper_target(&["sandbox".into()], None, &store).is_err());
        assert_eq!(
            cli_wrapper_target(&[], Some(target.clone().into_os_string()), &store)
                .unwrap()
                .map(|(target, _)| target),
            Some(target),
        );
    }

    #[test]
    fn windows_package_resume_helper_requires_both_process_and_thread() {
        let launch_id = "37f4f759-55f1-4b66-a45d-160644fe20d4";
        let feedback_path = std::env::temp_dir()
            .join("自定义 Codey 状态")
            .join(format!("resume-{launch_id}.json"));
        assert_eq!(windows_package_resume_target(&[]).unwrap(), None);
        assert_eq!(
            windows_package_resume_target(&["--debug-port".into()]).unwrap(),
            None
        );
        for args in [["-p", "42", "-tid", "73"], ["-TID", "73", "-P", "42"]] {
            let args = std::iter::once(WINDOWS_PACKAGE_RESUME_ARGUMENT)
                .chain(["--launch-id", launch_id])
                .chain(args)
                .map(OsString::from)
                .chain([
                    OsString::from("--launch-state"),
                    feedback_path.clone().into_os_string(),
                ])
                .collect::<Vec<_>>();
            assert_eq!(
                windows_package_resume_target(&args).unwrap(),
                Some(WindowsPackageResumeTarget {
                    process_id: 42,
                    thread_id: 73,
                    launch_id: uuid::Uuid::parse_str(launch_id).unwrap(),
                    feedback_path: feedback_path.clone()
                })
            );
        }
    }

    #[test]
    fn windows_package_resume_helper_rejects_malformed_targets() {
        let feedback_path =
            std::env::temp_dir().join("resume-37f4f759-55f1-4b66-a45d-160644fe20d4.json");
        for args in [
            vec![],
            vec!["-tid", "73"],
            vec!["-p", "42"],
            vec!["-p", "42", "-tid"],
            vec!["-p", "0", "-tid", "73"],
            vec!["-p", "42", "-tid", "0"],
            vec!["-p", "invalid", "-tid", "73"],
            vec!["-p", "42", "-tid", "4294967296"],
            vec!["-p", "42", "-tid", "+73"],
            vec!["-p", "42", "-tid", "-73"],
            vec!["-p", "42", "-tid", "73", "-P", "42"],
            vec!["-p", "42", "-tid", "73", "-tid", "74"],
            vec!["-p", "42", "-tid", "73", "--extra", "1"],
        ] {
            let args = std::iter::once(WINDOWS_PACKAGE_RESUME_ARGUMENT)
                .chain(["--launch-id", "37f4f759-55f1-4b66-a45d-160644fe20d4"])
                .chain(args)
                .map(OsString::from)
                .chain([
                    OsString::from("--launch-state"),
                    feedback_path.clone().into_os_string(),
                ])
                .collect::<Vec<_>>();
            assert!(windows_package_resume_target(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn windows_package_resume_helper_requires_valid_unique_launch_id() {
        let feedback_path =
            std::env::temp_dir().join("resume-37f4f759-55f1-4b66-a45d-160644fe20d4.json");
        for extra in [
            vec![],
            vec!["--launch-id", "../other-launch"],
            vec!["--launch-id", "00000000-0000-0000-0000-000000000000"],
            vec![
                "--launch-id",
                "37f4f759-55f1-4b66-a45d-160644fe20d4",
                "--launch-id",
                "37f4f759-55f1-4b66-a45d-160644fe20d4",
            ],
        ] {
            let args = [WINDOWS_PACKAGE_RESUME_ARGUMENT, "-p", "42", "-tid", "73"]
                .into_iter()
                .chain(extra)
                .map(OsString::from)
                .chain([
                    OsString::from("--launch-state"),
                    feedback_path.clone().into_os_string(),
                ])
                .collect::<Vec<_>>();
            assert!(windows_package_resume_target(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn windows_package_resume_helper_rejects_missing_or_unrelated_state_path() {
        let base = [
            WINDOWS_PACKAGE_RESUME_ARGUMENT,
            "-p",
            "42",
            "-tid",
            "73",
            "--launch-id",
            "37f4f759-55f1-4b66-a45d-160644fe20d4",
        ]
        .map(OsString::from)
        .to_vec();
        assert!(windows_package_resume_target(&base).is_err());
        for path in [
            std::path::PathBuf::from("relative/resume-37f4f759-55f1-4b66-a45d-160644fe20d4.json"),
            std::env::temp_dir().join("unrelated.json"),
        ] {
            let mut args = base.clone();
            args.extend([OsString::from("--launch-state"), path.into_os_string()]);
            assert!(windows_package_resume_target(&args).is_err());
        }
        let path = std::env::temp_dir().join("resume-37f4f759-55f1-4b66-a45d-160644fe20d4.json");
        let mut args = base;
        args.extend([
            OsString::from("--launch-state"),
            path.clone().into_os_string(),
        ]);
        assert!(windows_package_resume_target(&args).is_ok());
        args.extend([OsString::from("--launch-state"), path.into_os_string()]);
        assert!(windows_package_resume_target(&args).is_err());
    }

    #[test]
    fn cli_wrapper_rewrites_only_managed_app_server_configs() {
        let args = [
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--analytics-default-enabled",
            "--config",
            "model_provider=old",
            "-c",
            "unmanaged=true",
        ]
        .map(OsString::from);
        let overrides = vec![
            "model_provider=first".to_string(),
            "features.hooks=true".to_string(),
            "model_provider=codey_router".to_string(),
        ];

        assert_eq!(
            rewrite_app_server_args(&args, &overrides).unwrap(),
            [
                "-c",
                "features.code_mode_host=true",
                "app-server",
                "-c",
                "unmanaged=true",
                "-c",
                "analytics.enabled=false",
                "-c",
                "model_provider=codey_router",
                "-c",
                "features.hooks=true",
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn cli_wrapper_drops_stale_wsl_only_runtime_overrides() {
        let overrides = [
            "__CODEY_WSL_ONLY__:hooks={PreToolUse=[]}",
            "  __CODEY_WSL_ONLY__:hooks.state.legacy.trusted_hash=\"sha256:old\"",
            "hooks={PreToolUse=[]}",
            "developer_instructions=\"Preserve __CODEY_WSL_ONLY__: in values\"",
        ]
        .map(str::to_string);
        let args = [OsString::from("app-server")];
        assert_eq!(
            rewrite_app_server_args(&args, &overrides).unwrap(),
            [
                "app-server",
                "-c",
                "analytics.enabled=false",
                "-c",
                "hooks={PreToolUse=[]}",
                "-c",
                "developer_instructions=\"Preserve __CODEY_WSL_ONLY__: in values\"",
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn router_runtime_rejects_shared_app_server_commands() {
        let router = vec!["model_provider=\"codey_router\"".to_string()];
        assert!(local_router_runtime_enabled(&router));
        assert!(!local_router_runtime_enabled(&[
            router[0].clone(),
            "model_provider=\"openai\"".to_string(),
        ]));
        for subcommand in ["proxy", "daemon"] {
            let args = ["app-server", subcommand].map(OsString::from);
            assert!(rewrite_app_server_args(&args, &router).is_err());
            assert!(rewrite_app_server_args(&args, &[]).is_ok());
        }
    }

    #[test]
    fn cli_wrapper_marker_round_trips_and_only_accepts_absolute_json_paths() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("marker.json");
        assert!(CliWrapperMarker::read(&path).unwrap().is_none());
        let mut marker = CliWrapperMarker::new(CliWrapperMarkerStatus::Failed);
        marker.message = Some("boom".to_string());
        marker.retryable = Some(true);
        marker.write(&path).unwrap();
        let read = CliWrapperMarker::read(&path).unwrap().unwrap();
        assert_eq!(read.status, CliWrapperMarkerStatus::Failed);
        assert_eq!(read.pid, std::process::id());
        assert_eq!(read.message.as_deref(), Some("boom"));
        assert_eq!(read.retryable, Some(true));
        CliWrapperMarker::new(CliWrapperMarkerStatus::Executed)
            .write(&path)
            .unwrap();
        let read = CliWrapperMarker::read(&path).unwrap().unwrap();
        assert_eq!(read.status, CliWrapperMarkerStatus::Executed);
        assert_eq!(read.message, None);
        std::fs::write(&path, "not json").unwrap();
        assert!(CliWrapperMarker::read(&path).is_err());

        assert_eq!(
            cli_wrapper_marker_path_from_env(Some(path.clone().into_os_string())),
            Some(path.clone())
        );
        assert_eq!(
            cli_wrapper_marker_path_from_env(Some(OsString::from("relative.json"))),
            None
        );
        assert_eq!(
            cli_wrapper_marker_path_from_env(Some(temp.path().join("marker.txt").into_os_string())),
            None
        );
        assert_eq!(cli_wrapper_marker_path_from_env(None), None);
    }

    #[test]
    fn handshake_connect_connects_when_listening() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let deadline = std::time::Instant::now() + CLI_WRAPPER_HANDSHAKE_CONNECT_BUDGET;
        connect_loopback_with_retry(&address, deadline).unwrap();
    }

    #[test]
    fn handshake_connect_does_not_retry_refusal() {
        let address = "127.0.0.1:1".parse().unwrap();
        let mut attempts = 0;
        let error = connect_loopback_with_retry_using(
            &address,
            std::time::Instant::now() + CLI_WRAPPER_HANDSHAKE_CONNECT_BUDGET,
            |_, _| {
                attempts += 1;
                Err(std::io::ErrorKind::ConnectionRefused.into())
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionRefused);
        assert_eq!(attempts, 1, "a refused connection must not be retried");
    }

    #[test]
    fn handshake_connect_retries_timeout_and_connects_when_listening() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let mut attempts = 0;
        connect_loopback_with_retry_using(
            &address,
            std::time::Instant::now() + CLI_WRAPPER_HANDSHAKE_CONNECT_BUDGET,
            |address, timeout| {
                attempts += 1;
                if attempts == 1 {
                    Err(std::io::ErrorKind::TimedOut.into())
                } else {
                    std::net::TcpStream::connect_timeout(address, timeout)
                }
            },
        )
        .unwrap();
        assert_eq!(attempts, 2);
    }

    #[test]
    fn handshake_connect_stops_retrying_timeout_at_deadline() {
        let address = "127.0.0.1:1".parse().unwrap();
        let mut attempts = 0;
        let error =
            connect_loopback_with_retry_using(&address, std::time::Instant::now(), |_, _| {
                attempts += 1;
                Err(std::io::ErrorKind::TimedOut.into())
            })
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(attempts, 1);
    }
}
