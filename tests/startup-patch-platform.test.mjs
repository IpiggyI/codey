import assert from "node:assert/strict";
import test from "node:test";

import { loadSpawnCodexSections } from "./helpers/startup-patch.mjs";
import { readSource } from "./helpers/read-source.mjs";

// Static contracts keep both platforms' spawn_codex wiring visible on any CI host.
test("Windows startup compatibility failure cleans the process before compatible restart", async () => {
  const { cleanup, windowsSpawn } = await loadSpawnCodexSections();
  const cleanupCall = windowsSpawn.indexOf(
    "stop_windows_spawned_codex(&mut spawned, app_dir).await",
  );
  const compatibleRestart = windowsSpawn.indexOf(
    "match spawn_windows_codex(app_dir, debug_port, &runtime_arguments, &[], false)",
  );

  assert.ok(cleanupCall >= 0);
  assert.ok(compatibleRestart > cleanupCall);
  const singleInstanceCleanup = windowsSpawn.indexOf("if single_instance_exit {", cleanupCall);
  assert.ok(singleInstanceCleanup > cleanupCall && singleInstanceCleanup < compatibleRestart);
  assert.match(
    windowsSpawn.slice(singleInstanceCleanup, compatibleRestart),
    /Err\(sweep_error\) => anyhow::bail!\(/,
  );
  assert.match(windowsSpawn, /fallback\.performance_status = "degraded"/);
  assert.match(
    windowsSpawn,
    /Codex 已启动，但部分启动设置未能应用/,
  );
  assert.match(cleanup, /-> Result<\(\)>/);
  assert.match(
    cleanup,
    /terminate_windows_codex_processes_with_timeout\(\s*app_dir,\s*process_id,\s*WINDOWS_STARTUP_PATCH_FAILURE_STOP_TIMEOUT,\s*\)\s*\.await/,
  );
  assert.doesNotMatch(
    cleanup,
    /terminate_windows_codex_processes\(app_dir, process_id\)\.await/,
  );
});

test("Store environment uses supervised native activation with scoped cleanup", async () => {
  const { launcherPlatform } = await loadSpawnCodexSections();
  const source = await readSource("backend/src/launcher/windows_packaged.rs");
  const supervisor = await readSource("backend/src/launcher/windows_activation.rs");
  assert.doesNotMatch(source, /PACKAGE_NAME_ATTRIBUTE|STARTUPINFOEXW|CreateProcessW|UpdateProcThreadAttribute/);
  assert.match(source, /settings\.EnableDebugging\(/);
  assert.match(source, /settings\s*\.DisableDebugging\(/);
  assert.match(source, /impl Drop for WindowsPackageDebugSession[\s\S]*?journal\.recover\(disable_windows_packaged_environment\)/);
  const prepare = source.indexOf("session.journal.arm(&package_full_name)?");
  const enable = source.indexOf("enable_windows_packaged_environment(", prepare);
  assert.ok(prepare >= 0 && enable > prepare);
  const setup = launcherPlatform.indexOf("WindowsPackageDebugSession::start(");
  const supervision = launcherPlatform.indexOf("tokio::spawn(async move", setup);
  const activation = launcherPlatform.indexOf("codey_runtime_core::launcher::activate_packaged_app(", supervision);
  const verification = launcherPlatform.indexOf("let package_check", activation);
  const resumed = launcherPlatform.indexOf("wait_for_resume(feedback.as_deref(), process_id).await?", verification);
  const spawned = launcherPlatform.indexOf("SpawnedCodex {", verification);
  const cleanup = launcherPlatform.indexOf("package_debug_session.finish()", verification);
  assert.ok(setup >= 0 && supervision > setup && activation > supervision && verification > activation && resumed > verification && spawned > resumed && cleanup > spawned);
  assert.match(source, /if self\.activation_pending/);
  assert.match(launcherPlatform, /wait_for_resume_failure\(feedback\.clone\(\)\)/);
  assert.match(launcherPlatform, /cancel_resume_feedback\(feedback\.as_deref\(\)\)/);
  assert.match(supervisor, /timeout\(self\.timeout, &mut activation\)/);
  assert.match(supervisor, /timeout\(self\.settle_timeout, &mut activation\)/);
  assert.match(supervisor, /result = &mut activation => break result/);
  assert.match(supervisor, /let stopped = stop\(\)\.await;[\s\S]*?let cleared = finish\(\);/);
  assert.match(launcherPlatform, /!environment_required && error\.is::<recovery::IntegrationFailure>\(\)/);
});

test("Store environment failures identify each native operation without logging values", async () => {
  const source = await readSource("backend/src/launcher/windows_packaged.rs");
  const setupStart = source.indexOf("fn with_windows_package_debug_settings<T>");
  const enableStart = source.indexOf("fn enable_windows_packaged_environment(", setupStart);
  const disableStart = source.indexOf("fn disable_windows_packaged_environment(", enableStart);
  assert.ok(setupStart >= 0 && enableStart > setupStart && disableStart > enableStart);
  const setup = source.slice(setupStart, enableStart);
  const enable = source.slice(enableStart, disableStart);
  assert.match(setup, /初始化 Windows 包调试 COM 环境失败（CoInitializeEx）/);
  assert.match(setup, /创建 Windows 包调试设置接口失败（CoCreateInstance）/);
  assert.match(enable, /\.DisableDebugging\(package\)\s*\.context\("安装兼容环境前清理包调试设置失败/);
  assert.match(enable, /EnableDebugging；环境块 UTF-16 长度=\{\}，恢复命令 UTF-16 长度=\{\}/);
  assert.match(source.slice(disableStart), /移除包调试设置失败（IPackageDebugSettings::DisableDebugging）/);

  const failureStart = source.indexOf("let detail = format!(\"{error:#}\");");
  const cleanupStart = source.indexOf("let cleared = session.finish();", failureStart);
  assert.ok(failureStart >= 0 && cleanupStart > failureStart);
  const failure = source.slice(failureStart, cleanupStart);
  assert.match(failure, /crate::error_log::record_failure\(\s*"package_environment_failed",\s*"enable_windows_packaged_environment"/);
  assert.match(failure, /"environmentVariableNames": environment\.iter\(\)\s*\.map\(\|\(name, _\)\| name\.as_str\(\)\)/);
  assert.match(failure, /error\.downcast_ref::<windows::core::Error>\(\)/);
  assert.doesNotMatch(failure, /"environment"\s*:|"environmentValues"\s*:/);
  assert.match(source.slice(cleanupStart), /startup_activation_error_after_cleanup\(\s*error,\s*Ok\(\(\)\),\s*cleared/);
});

test("Store debugger resumes only a verified Codex process and its own thread", async () => {
  const source = await readSource("backend/src/launcher/windows_packaged.rs");
  const { startupPatch } = await loadSpawnCodexSections();
  const ownership = source.indexOf("owner != 0 && owner == process_id");
  const packageCheck = source.indexOf("validate_package_record(&package)?", ownership);
  const registered = source.indexOf("refresh_windows_packaged_app_dir", packageCheck);
  const image = source.indexOf("QueryFullProcessImageNameW(", registered);
  const verifiedImage = source.indexOf("normalized_windows_path(&image)", image);
  const resumed = source.indexOf("ResumeThread(thread_handle)", verifiedImage);
  assert.ok(ownership >= 0 && packageCheck > ownership && registered > packageCheck && image > registered && verifiedImage > image && resumed > verifiedImage);
  const confirmation = source.indexOf("serde_json::to_vec(&ResumeFeedbackState::Resumed { process_id })", resumed);
  assert.ok(confirmation > resumed);
  assert.match(startupPatch, /run_windows_package_resume_helper_if_requested\(\)\?/);
  assert.match(startupPatch, /resume_windows_packaged_thread\(\s*process_id,\s*thread_id,\s*launch_id,\s*&feedback_path,?\s*\)/);
  assert.match(source.slice(verifiedImage, resumed), /require_pending_resume\(feedback\)\?/);
  assert.match(source, /--launch-state/);
  assert.match(startupPatch, /target\.is_none\(\)/);
});

test("native recovery shares Store activation and preserves the configured home", async () => {
  const source = await readSource("backend/src/launcher/recovery.rs");
  assert.doesNotMatch(source, /spawn_with_environment|CreateProcessW/);
  assert.match(source, /windows_codex_launch_environment\(&\[\], home\)/);
  assert.match(source, /activate_windows_codex\(\s*app_dir,\s*&app_id,\s*"",\s*required\.then_some\(environment\.as_slice\(\)\),\s*required/);
});

test("Windows and macOS confirm the CLI wrapper before reporting startup success", async () => {
  const { launcher, macosSpawn, startupPatch, windowsSpawn } = await loadSpawnCodexSections();
  for (const spawn of [windowsSpawn, macosSpawn]) {
    const confirmation = spawn.indexOf("confirm_cli_wrapper_startup(");
    const ready = spawn.indexOf('performance_status = "ready"', confirmation);
    assert.ok(confirmation >= 0 && ready > confirmation);
    assert.match(spawn, /prepare_cli_wrapper\(app_dir, subagent_gate_active, runtime_config_overrides\)/);
    assert.doesNotMatch(spawn, /--inspect|NODE_OPTIONS|prepare_startup_require/);
  }
  assert.match(windowsSpawn, /let wrapper_environment_required = constrained/);
  assert.match(windowsSpawn, /wrapper_environment_applied\.then\(\|\| wrapper\.into_handshake\(\)\)/);
  assert.match(macosSpawn, /add_macos_cli_wrapper\(&mut command, &wrapper\.environment\)/);
  assert.match(macosSpawn, /spawned_environment = wrapper\.environment\.clone\(\)/);
  assert.match(launcher, /exited = startup_process_exited\(spawned\) => Err\(exited\.into\(\)\)/);
  assert.match(launcher, /result = wait_for_cli_wrapper\(handshake, deadline\) => result/);
  assert.match(launcher, /result = accept_handshake => result,[\s\S]*?result = marker => result/);
  assert.match(startupPatch, /!running_in_app_container\(\)/);
});

test("Codex CLI wrapper environment does not leak into the real CLI", async () => {
  const { startupPatch } = await loadSpawnCodexSections();
  assert.match(
    startupPatch,
    /for name in \[\s*"CODEX_CLI_PATH",\s*CLI_WRAPPER_TARGET_ENV,/,
  );
  assert.match(startupPatch, /CLI_WRAPPER_MARKER_ENV,[\s\S]*?"NODE_OPTIONS",/);
});
