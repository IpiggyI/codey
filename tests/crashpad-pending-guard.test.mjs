import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Crashpad pending protection is bounded, allowlisted, and surfaced with Trace diagnostics", async () => {
  const [
    guard,
    config,
    launcher,
    commands,
    diagnosticCommands,
    runtime,
    app,
    diagnostics,
    api,
  ] = await Promise.all([
    readFile(
      new URL("../backend/src/crashpad_pending_guard.rs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../backend/src/config.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/launcher.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/commands.rs", import.meta.url), "utf8"),
    readFile(
      new URL("../backend/src/commands/diagnostics.rs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../backend/src/commands/runtime.rs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/TraceLogModule.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    guard,
    /PENDING_HARD_LIMIT_BYTES: u64 = 512 \* 1024 \* 1024/,
  );
  assert.match(
    guard,
    /PENDING_TARGET_BYTES: u64 = 384 \* 1024 \* 1024/,
  );
  assert.match(guard, /GUARD_INTERVAL: Duration = Duration::from_secs\(5 \* 60\)/);
  assert.match(guard, /COMPLETE_REPORT_QUIET_PERIOD[\s\S]*10 \* 60/);
  assert.match(guard, /Codex\/Crashpad\/pending/);
  assert.match(guard, /com\.openai\.codex\/web\/Crashpad\/pending/);
  assert.match(guard, /strip_suffix\("\.dmp"\)/);
  assert.match(guard, /strip_suffix\("_sidecar\.json"\)/);
  assert.match(guard, /Uuid::parse_str/);
  assert.match(guard, /symlink_metadata/);
  assert.match(guard, /file_type\(\)\.is_file\(\)/);
  assert.doesNotMatch(guard, /read_dir[\s\S]{0,120}read_dir/);

  assert.match(config, /pub protect_crashpad_pending: bool/);
  assert.match(config, /protect_crashpad_pending: true/);
  assert.match(launcher, /enforce_system_limit/);
  assert.match(launcher, /spawn_crashpad_guard_watcher/);
  assert.match(commands, /"refresh_diagnostic_storage_stats"/);
  assert.match(commands, /"clear_diagnostic_storage"/);
  assert.match(
    diagnosticCommands,
    /refresh_diagnostic_storage_stats[\s\S]*?diagnostic_storage_operation\.lock\(\)\.await/,
  );
  assert.doesNotMatch(
    diagnosticCommands,
    /refresh_diagnostic_storage_stats[\s\S]*?diagnostic_storage_operation\.try_lock\(\)/,
  );
  assert.match(diagnosticCommands, /"status": if errors\.is_empty\(\) \{ "ok" \} else \{ "partial" \}/);
  assert.match(runtime, /"crashpadPendingStats"/);

  assert.match(app, /invoke<\{[\s\S]*?\}>\("clear_diagnostic_storage"\)/);
  assert.match(app, /refresh_diagnostic_storage_stats/);
  assert.match(diagnostics, /诊断存储保护/);
  assert.match(
    diagnostics,
    /Boolean\(traceSnapshot\) &&[\s\S]*?!crashpadSupported \|\| Boolean\(crashpadSnapshot\)/,
  );
  assert.match(diagnostics, /Crashpad 报告/);
  assert.match(diagnostics, /Crashpad 占用/);
  assert.match(api, /"refresh_diagnostic_storage_stats"/);
  assert.match(api, /"clear_diagnostic_storage"/);
});

test("maintenance metrics cross the backend boundary as structured fields", async () => {
  const [launcher, types, operationsPanel] = await Promise.all([
    readFile(new URL("../backend/src/launcher.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/App.types.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/OperationsPanel.tsx", import.meta.url), "utf8"),
  ]);

  for (const [rustField, wireField] of [
    ["session_files_fixed", "sessionFilesFixed"],
    ["sqlite_rows_updated", "sqliteRowsUpdated"],
    ["ghost_tasks_pruned", "ghostTasksPruned"],
  ]) {
    assert.match(launcher, new RegExp(`pub ${rustField}: usize`));
    assert.match(types, new RegExp(`${wireField}\\?: number`));
    assert.match(operationsPanel, new RegExp(`maintenance\\?\\.${wireField}`));
  }

  assert.doesNotMatch(operationsPanel, /sessionDetailStr\.match/);
  assert.doesNotMatch(operationsPanel, /\.match\(\/修复/);
  assert.doesNotMatch(operationsPanel, /\.match\(\/更新/);
  assert.doesNotMatch(operationsPanel, /\.match\(\/清理/);
});

test("startup renders a loading state and desktop/FastCtx entrypoints keep crash logging wired", async () => {
  const [app, notice, errorLog, main, fastctx, startupPatch] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/useAppNotice.tsx", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/error_log.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/main.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/bin/codey-fastctx.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/renderer_asset_patch.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /if \(!config \|\| !provider\)/);
  assert.match(app, /正在载入 Codey/);
  assert.match(
    app,
    /<p>\s*<NoticeLoadingText controller=\{noticeController\} \/>\s*<\/p>/,
  );
  assert.match(notice, /return <>\{notice\.text\}<\/>/);
  assert.match(errorLog, /codey-errors\.log/);
  assert.match(main, /install_crash_log_hook\("codey"/);
  assert.match(main, /record_process_failure/);
  assert.match(fastctx, /install_crash_log_hook\("fastctx"/);
  assert.match(startupPatch, /recordCodeyPatchFailure/);
});
