import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("directory picker preflight and launch share Store update recovery", async () => {
  const [commands, launcher] = await Promise.all([
    readFile(new URL("../backend/src/commands.rs", import.meta.url), "utf8"),
    readFile(new URL("../backend/src/launcher.rs", import.meta.url), "utf8"),
  ]);
  const preflight = commands.slice(
    commands.indexOf("async fn ensure_windows_codex_app_path("),
    commands.indexOf("pub async fn save_codey_config("),
  );
  assert.match(preflight, /find_configured_codex_app_dir\(&configured_app_path\)/);
  assert.match(preflight, /if resolved.is_some\(\)\s*\{\s*return Ok\(\(\)\);/);
  assert.ok(
    preflight.indexOf("if resolved.is_some()")
      < preflight.indexOf("select_codex_app_directory().await"),
  );
  const launch = launcher.slice(
    launcher.indexOf("async fn resolve_configured_codex_app_dir("),
    launcher.indexOf("struct StartupModelCatalog"),
  );
  assert.match(launch, /find_configured_codex_app_dir\(&config.codex_app_path\)/);
});
