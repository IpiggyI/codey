import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("startup does not run an update preflight before the first Codex launch", async () => {
  const library = await readFile(
    new URL("backend/src/lib.rs", root),
    "utf8",
  );

  assert.doesNotMatch(library, /startup_update::run/);
  assert.doesNotMatch(library, /InstallScheduled|InstallUpdate/);
  assert.match(library, /commands::launch_codey_runtime\(&state\)\.await/);
});

test("Windows no longer starts a native update status thread", async () => {
  const [ui, cargo] = await Promise.all([
    readFile(new URL("backend/src/native_update_ui.rs", root), "utf8"),
    readFile(new URL("backend/Cargo.toml", root), "utf8"),
  ]);

  assert.doesNotMatch(ui, /codey-native-update-ui/);
  assert.doesNotMatch(ui, /GetMessageW\(&mut message, None, 0, 0\)/);
  assert.doesNotMatch(ui, /更新并重启|正在检查更新/);
  assert.match(cargo, /features = \["common-controls-v6"\]/);
});

test("macOS keeps AppKit on the main thread without a Dock icon", async () => {
  const [ui, build] = await Promise.all([
    readFile(new URL("backend/src/native_update_ui.rs", root), "utf8"),
    readFile(new URL("scripts/build.mjs", root), "utf8"),
  ]);

  assert.match(ui, /MainThreadMarker::new\(\)/);
  assert.match(ui, /NSApplicationActivationPolicy::Accessory/);
  assert.match(ui, /name\("codey-runtime"\.to_string\(\)\)/);
  assert.match(ui, /app\.run\(\)/);
  assert.doesNotMatch(ui, /NSPanel::initWithContentRect_styleMask_backing_defer/);
  assert.match(build, /<key>LSUIElement<\/key><true\/>/);
});
