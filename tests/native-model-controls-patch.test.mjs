import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalizeLineEndings = (source) => source.replace(/\r\n/g, "\n");

test("starting or restarting Codex replaces the old runtime with one managed by Codey", async () => {
  const [runtimeSource, launcherSource, launcherProcessSource, launcherPlatformSource, appSource] =
    await Promise.all([
    readFile(new URL("../backend/src/commands/runtime.rs", import.meta.url), "utf8")
      .then(normalizeLineEndings),
    readFile(new URL("../backend/src/launcher.rs", import.meta.url), "utf8")
      .then(normalizeLineEndings),
    readFile(
      new URL("../backend/src/launcher/process.rs", import.meta.url),
      "utf8",
    ).then(normalizeLineEndings),
    readFile(
      new URL("../backend/src/launcher/platform.rs", import.meta.url),
      "utf8",
    ).then(normalizeLineEndings),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);
  const launcherModules =
    `${launcherSource}\n${launcherProcessSource}\n${launcherPlatformSource}`;
  const restartFlow = runtimeSource.slice(
    runtimeSource.indexOf("pub async fn schedule_restart_codey_runtime"),
    runtimeSource.indexOf("pub async fn stop_codey_runtime"),
  );
  const prepareLaunchFlow = launcherProcessSource.slice(
    launcherProcessSource.indexOf("async fn prepare_codex_for_launch"),
    launcherProcessSource.indexOf("fn startup_patch_detail"),
  );

  assert.match(restartFlow, /runtime_operation\.lock\(\)/);
  assert.match(restartFlow, /stop_codey_runtime_locked\(&restart_state\)/);
  assert.match(restartFlow, /launch_codey_inner_locked\(&restart_state\)/);
  assert.match(restartFlow, /runtime_generation/);
  assert.match(restartFlow, /restart_task/);
  assert.match(restartFlow, /oneshot::channel\(\)/);
  assert.match(restartFlow, /is_shutting_down\(\)/);
  assert.match(restartFlow, /request_shutdown\(\)/);
  assert.match(
    runtimeSource,
    /pub async fn begin_shutdown[\s\S]*?cancel\.send\(\(\)\)[\s\S]*?task\.await/,
  );
  assert.match(
    runtimeSource,
    /runtime_generation\.load\(Ordering::Acquire\) == runtime_generation/,
  );
  assert.match(
    launcherModules,
    /stop_codex_processes\(\s*&self\.codex_app_path,[\s\S]*?self\.process_id,[\s\S]*?self\.process_group_id/,
  );
  assert.match(
    prepareLaunchFlow,
    /stop_running_windows_codex_instances\(app_dir\)[\s\S]*?\.await[\s\S]*?if !stopped\.is_empty\(\)/,
  );
  assert.match(
    prepareLaunchFlow,
    /if macos_codex_is_running\(app_dir\)\.await\? \{[\s\S]*?terminate_unix_codex_processes\(app_dir, None, None, None\)[\s\S]*?\.await/,
  );
  assert.doesNotMatch(prepareLaunchFlow, /anyhow::bail!/);
  assert.match(launcherModules, /build_codex_executable\(app_dir\)/);
  assert.match(launcherModules, /owned_unix_codex_process_ids/);
  assert.match(launcherModules, /libc::SIGKILL/);
  assert.doesNotMatch(runtimeSource, /"close_codex"/);
  assert.doesNotMatch(runtimeSource, /show_manual_relaunch_prompt/);
  assert.match(appSource, /await withTimeout\(invoke\("restart_codey"\),/);
  assert.match(appSource, /Codey 将自动重新拉起客户端/);
  assert.doesNotMatch(appSource, /关闭 Codex/);
});
