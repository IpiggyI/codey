import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const {
  reconcileConfigApply, configApplyNotice, configApplyPending, configApplyBannerVisible, configApplyCompletionNotice,
} = await loadTypeScriptModule(new URL("../src/configApply.ts", import.meta.url));
const { reconcileRuntimeStatus } = await loadTypeScriptModule(new URL("../src/runtimeStatusSnapshot.ts", import.meta.url));
const { createStatusPollScheduler, createStatusPollTask } = await loadTypeScriptModule(new URL("../src/runtimeStatusPollScheduler.ts", import.meta.url));

test("late save and polling responses cannot replace newer or completed application state", () => {
  const applied = { revision: 5, state: "applied" };
  assert.equal(reconcileConfigApply(applied, { revision: 5, state: "pending" }), applied);
  assert.equal(reconcileConfigApply(applied, { revision: 4, state: "failed" }), applied);
  assert.equal(reconcileConfigApply(applied, null), applied);
  const newer = { revision: 6, state: "pending" };
  assert.equal(reconcileConfigApply(applied, newer), newer);
  const status = reconcileRuntimeStatus({ running: true, configApply: applied, restartRequired: false },
    { running: true, configApply: { revision: 4, state: "pending" }, restartRequired: true });
  assert.equal(status.configApply, applied);
  assert.equal(status.restartRequired, false);
});

test("successful restart accepts a newer confirmation and rejects the old terminal result", () => {
  for (const state of ["failed", "restart_required", "saved"]) {
    const previous = { revision: 7, state };
    const confirmed = { revision: 8, state: "applied" };
    const status = reconcileRuntimeStatus(
      { running: true, configApply: previous, restartRequired: true },
      { running: true, configApply: confirmed, restartRequired: false },
    );
    assert.equal(status.configApply, confirmed);
    assert.equal(status.restartRequired, false);
    assert.equal(reconcileConfigApply(status.configApply, previous), confirmed);
  }
});

test("pending, failure and restart messages distinguish saving from applying", () => {
  assert.match(configApplyNotice({ revision: 1, state: "pending" }).text, /已保存，正在应用/);
  assert.equal(configApplyNotice({ revision: 1, state: "failed", error: "连接中断" }).tone, "error");
  assert.match(configApplyNotice({ revision: 1, state: "failed", error: "连接中断" }).text, /连接中断/);
  assert.match(configApplyNotice({ revision: 1, state: "restart_required" }).text, /重启/);
  assert.equal(configApplyNotice({ revision: 1, state: "saved" }).text, "配置已保存");
});

test("the status banner hides after a successful save or apply and shows failures", () => {
  for (const state of ["applied", "saved", "restart_required"]) {
    assert.equal(configApplyBannerVisible({ revision: 1, state }, null), false, state);
  }
  assert.equal(configApplyBannerVisible({ revision: 1, state: "pending" }, null), true);
  assert.equal(configApplyBannerVisible({ revision: 1, state: "failed", error: "连接中断" }, null), true);
  assert.equal(configApplyBannerVisible({ revision: 1, state: "pending" }, "暂时无法确认"), true);
  assert.equal(configApplyBannerVisible(null, null), false);
  assert.equal(configApplyBannerVisible(undefined, "暂时无法确认"), false);
});

test("completing an application this session saw as pending reports the result once", () => {
  const pending = { revision: 3, state: "pending" };
  assert.deepEqual(configApplyCompletionNotice(pending, { revision: 3, state: "applied" }), { tone: "success", text: "配置已保存并应用" });
  const failed = configApplyCompletionNotice(pending, { revision: 4, state: "failed", error: "连接中断" });
  assert.equal(failed.tone, "error");
  assert.match(failed.text, /连接中断/);
  assert.equal(configApplyCompletionNotice(pending, { revision: 4, state: "pending" }), null);
  assert.equal(configApplyCompletionNotice(pending, { revision: 2, state: "applied" }), null);
  assert.equal(configApplyCompletionNotice(undefined, { revision: 3, state: "applied" }), null);
  assert.equal(configApplyCompletionNotice({ revision: 3, state: "applied" }, { revision: 3, state: "applied" }), null);
});

function clockHarness() {
  let now = 0, id = 0;
  const timers = new Map();
  return { clock: { now: () => now, setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; }, clearTimeout: (key) => timers.delete(key) },
    async tick() { const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) return false; timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); await new Promise(setImmediate); return true; },
    timers };
}

test("application polling is lightweight, ignores older terminal states and stops on completion", async () => {
  const harness = clockHarness(), requests = [];
  const states = [{ revision: 1, state: "applied" }, { revision: 2, state: "pending" }, { revision: 2, state: "applied" }];
  const scheduler = createStatusPollScheduler(async (probe) => { requests.push(probe); return { running: true, configApply: states.shift() }; }, harness.clock);
  scheduler.add(createStatusPollTask({ kind: "configApply", delays: [10], refreshesInjectionStatus: false, pending: (next) => configApplyPending(next.configApply, 2) }, 100, 0));
  while (await harness.tick()) {}
  assert.deepEqual(requests, [false, false, false]);
});

for (const failure of [false, true]) test(`application polling is bounded on ${failure ? "query failures" : "timeout"} and can be restarted`, async () => {
  const harness = clockHarness();
  let exhausted = 0;
  const scheduler = createStatusPollScheduler(async () => { if (failure) throw Error("offline"); return { running: true, configApply: { revision: 2, state: "pending" } }; }, harness.clock);
  const task = () => createStatusPollTask({ kind: "configApply", delays: [10], refreshesInjectionStatus: false, pending: () => true, onExhausted: () => exhausted++ }, failure ? 1000 : 30, harness.clock.now());
  scheduler.add(task());
  while (await harness.tick()) {}
  assert.equal(exhausted, 1);
  scheduler.add(task());
  assert.equal(harness.timers.size, 1);
  scheduler.clear();
  assert.equal(harness.timers.size, 0);
});
