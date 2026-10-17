import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = readFileSync(new URL(
  "../vendor/CodeyRuntime/crates/codey-runtime-core/src/bridge.rs", import.meta.url,
), "utf8");
const template = bridgeSource.slice(bridgeSource.indexOf("fn build_bridge_script_for_session("))
  .match(/r#"([\s\S]*?)"#/)[1];
const bridgeScript = template.replaceAll("{{", "{").replaceAll("}}", "}")
  .replaceAll("{session_token}", JSON.stringify("test-session"))
  .replaceAll("{binding_name}", "codexSessionDeleteV2");

function fixture() {
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const window = {
    codexSessionDeleteV2: (payload) => requests.push(JSON.parse(payload)),
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const context = vm.createContext({ window, crypto: { randomUUID } });
  const install = () => vm.runInContext(bridgeScript, context);
  install();
  return { window, install, requests, timers };
}

test("bridge reinstall fails pending page calls and clears their timeouts", async () => {
  const { window, install, timers } = fixture();
  const pending = [
    window.__codexSessionDeleteBridge("/session/timestamps", {}, { timeoutMs: 10_000 }),
    window.__codexSessionDeleteBridge("/session/timestamps", {}),
  ];
  assert.equal(timers.size, 1);
  install();
  for (const call of pending) {
    const result = await call;
    assert.equal(result.status, "failed");
    assert.equal(result.code, "bridge_reinstalled");
  }
  assert.equal(timers.size, 0);
  assert.equal(window.__codexSessionDeleteCallbacks.size, 0);
});

test("a reply from the old document cannot settle a new document's call", async () => {
  const { window, install, requests } = fixture();
  const previous = window.__codexSessionDeleteBridge("/session/timestamps", {});
  install();
  assert.equal((await previous).code, "bridge_reinstalled");
  let settled = false;
  const current = window.__codexSessionDeleteBridge("/session/timestamps", {}).then((result) => {
    settled = true;
    return result;
  });
  assert.notEqual(requests[0].id, requests[1].id);
  window.__codexSessionDeleteResolve(requests[0].id, { status: "ok" });
  await Promise.resolve();
  assert.equal(settled, false);
  window.__codexSessionDeleteResolve(requests[1].id, { status: "ok" });
  assert.equal((await current).status, "ok");
});

test("a lost timestamp reply settles when the bridge timeout expires", async () => {
  const { window, timers } = fixture();
  const pending = window.__codexSessionDeleteBridge("/session/timestamps", {}, { timeoutMs: 10_000 });
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 10_000);
  timer.callback();
  assert.equal((await pending).code, "bridge_timeout");
  assert.equal(window.__codexSessionDeleteCallbacks.size, 0);
  assert.equal(timers.size, 0);
});
