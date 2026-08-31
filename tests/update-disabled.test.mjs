import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN_CLIENT_UPDATE_TOKENS = [
  "latest.json",
  "CODEY_UPDATE_BASE_URL",
  "update_manifest",
  "updateManifestUrl",
  "DEFAULT_UPDATE_BASE_URL",
  "startup_update",
  "check_for_updates",
  "download_update",
  "install_downloaded_update",
  "generate-update-manifest",
];

const SCAN_ROOTS = [
  "backend/src",
  "src",
  "public",
  "scripts",
  ".github/workflows",
];

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
      continue;
    }
    yield path;
  }
}

test("startup and client sources never request or name an update manifest", async () => {
  const library = await readFile(join(root, "backend/src/lib.rs"), "utf8");
  assert.doesNotMatch(library, /startup_update::run/);
  assert.doesNotMatch(library, /check_for_update/);
  assert.doesNotMatch(library, /InstallScheduled|InstallUpdate/);
  assert.match(library, /commands::launch_codey_runtime\(&state\)\.await/);

  const hits = [];
  for (const relativeRoot of SCAN_ROOTS) {
    for await (const path of walkFiles(join(root, relativeRoot))) {
      const source = await readFile(path, "utf8");
      for (const token of FORBIDDEN_CLIENT_UPDATE_TOKENS) {
        if (source.includes(token)) {
          hits.push(`${path.slice(root.length + 1)}: ${token}`);
        }
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("console and Codex icon surfaces have no reachable update actions", async () => {
  const [app, api, inject, types] = await Promise.all([
    readFile(join(root, "src/App.tsx"), "utf8"),
    readFile(join(root, "src/api.ts"), "utf8"),
    readFile(join(root, "public/renderer-inject.js"), "utf8"),
    readFile(join(root, "src/App.types.ts"), "utf8"),
  ]);

  assert.doesNotMatch(app, /useAppUpdates/);
  assert.doesNotMatch(app, /header-update-pill|检查 Codey 在线更新|handleCheckForUpdates/);
  assert.doesNotMatch(app, /checkForUpdates|downloadUpdate|askInstallDownloadedUpdate/);
  assert.doesNotMatch(api, /check_for_updates|download_update|install_downloaded_update/);
  assert.doesNotMatch(
    inject,
    /check_for_updates|hydrateUpdateAvailability|data-codey-update-available|有可用更新|updateCheckTimeoutMs/,
  );
  assert.doesNotMatch(types, /availableUpdate|UpdateCheck|install-update/);

  const commandList = api.slice(
    api.indexOf("export const CODEY_API_COMMANDS"),
    api.indexOf("] as const"),
  );
  assert.doesNotMatch(
    commandList,
    /check_for_updates|download_update|install_downloaded_update/,
  );
});
