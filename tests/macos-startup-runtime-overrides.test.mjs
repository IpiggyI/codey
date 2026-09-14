import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS startup patch requires app-server runtime override validation", async () => {
  const source = (
    await readFile(
      new URL("../backend/src/launcher/process.rs", import.meta.url),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf('#[cfg(target_os = "macos")]\n    {');
  const end = source.indexOf("#[cfg(not(any(windows, target_os = \"macos\")))]", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const macosSpawn = source.slice(start, end);
  const successStart = macosSpawn.indexOf("Ok(mode) =>");
  const failureStart = macosSpawn.indexOf("Err(error) =>", successStart);

  assert.match(macosSpawn, /install_startup_patch_with_cli_fallback\(/);
  assert.match(
    macosSpawn,
    /Ok\(mode\)[\s\S]*?startup_injection_mode = mode\.as_str\(\)[\s\S]*?performance_status = "ready"/,
  );
  assert.ok(successStart >= 0);
  assert.ok(failureStart > successStart);
  assert.doesNotMatch(
    macosSpawn.slice(successStart, failureStart),
    /stop_macos_codex|reap_child_after_cleanup|degraded/,
  );
  assert.match(
    source,
    /"launcher\.startup_compatibility_mode"[\s\S]*?"main_process_inspector_unavailable"[\s\S]*?StartupInjectionMode::CliWrapper/,
  );
  assert.match(
    source,
    /codex_startup_patch::install\(\s*inspector_port,\s*patch_options,\s*runtime_config_overrides,\s*!runtime_config_overrides\.is_empty\(\),\s*renderer_debug_port,\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /codex_startup_patch::install\(\s*inspector_port,\s*patch_options,\s*runtime_config_overrides,\s*false,/,
  );
  // A disabled fuse keeps the launch marker but waits on the CLI wrapper alone.
  // NODE_OPTIONS `--require` also excludes the Inspector: both wrap Module._load.
  assert.match(
    macosSpawn,
    /let use_inspector = !use_require && inspect_fuse\.inspector_possible\(\);/,
  );
  assert.match(
    macosSpawn,
    /let wait_inspector_port = if use_inspector \{ inspector_port \} else \{ None \};/,
  );
  assert.match(
    macosSpawn,
    /install_startup_patch_with_cli_fallback\(\s*wait_inspector_port,/,
  );
});

test("Codex CLI wrapper environment does not leak into the real CLI", async () => {
  const source = await readFile(
    new URL("../backend/src/codex_startup_patch.rs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /for name in \[\s*"CODEX_CLI_PATH",\s*CLI_WRAPPER_TARGET_ENV,/,
  );
});
