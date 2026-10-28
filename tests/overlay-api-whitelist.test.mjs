import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const api = await loadTypeScriptModule(new URL("../src/api.ts", import.meta.url));

test("overlay API paths reject commands outside the backend whitelist", () => {
  assert.equal(api.codeyApiPath("save_codey_config"), "/api/save_codey_config");
  assert.equal(api.isCodeyApiCommand("runtime_status"), true);
  assert.equal(api.isCodeyApiCommand("query_route_request_logs"), true);
  assert.equal(api.isCodeyApiCommand("query_route_request_log_stats"), true);
  assert.equal(api.isCodeyApiCommand("clear_route_request_logs"), true);
  for (const command of [
    "list_official_accounts",
    "import_current_codex_login",
    "import_official_account_credential",
    "start_official_account_login",
    "poll_official_account_login",
    "cancel_official_account_login",
    "set_default_official_account",
    "remove_official_account",
    "query_official_account_usage",
    "store_official_account_usage",
  ]) assert.equal(api.isCodeyApiCommand(command), true, command);
  assert.equal(api.isCodeyApiCommand("../session/delete"), false);
  assert.throws(
    () => api.codeyApiPath("../session/delete"),
    /不允许的 Codey API 命令/,
  );
});

test("frontend and backend API command whitelists stay in sync", () => {
  const backend = fs.readFileSync(
    new URL("../backend/src/commands.rs", import.meta.url),
    "utf8",
  );
  const invokeApi = backend.slice(
    backend.indexOf("pub async fn invoke_api"),
    backend.indexOf("pub async fn load_codey_config"),
  );
  // 一个分支可以用 | 合并多个命令，并跨行书写。
  const backendCommands = [
    ...invokeApi.matchAll(/^\s*("[a-z][a-z0-9_]*"(?:\s*\|\s*"[a-z][a-z0-9_]*")*)\s*=>/gm),
  ].flatMap((match) => [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((name) => name[1]));

  assert.deepEqual(
    [...api.CODEY_API_COMMANDS].sort(),
    backendCommands.sort(),
  );
});

test("overlay resolves bridge paths through the checked helper", () => {
  const overlay = fs.readFileSync(
    new URL("../src/overlay.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overlay, /__codexSessionDeleteBridge\(codeyApiPath\(command\), args\)/);
  assert.doesNotMatch(overlay, /__codexSessionDeleteBridge\(`\/api\/\$\{command\}`/);
});
