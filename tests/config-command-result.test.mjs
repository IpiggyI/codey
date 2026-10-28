import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { applyConfigCommandResult, isStaleConfig } = createModuleGraph(new URL("../src/configCommandResult.ts", import.meta.url)).exports;
const { reconcileConfigApply } = createModuleGraph(new URL("../src/configApply.ts", import.meta.url)).exports;
const baseConfig = (settingsRevision = 1) => ({ settingsRevision, miscModel: "old" });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

// 从 App.tsx 取出配置结果相关的函数，接上内存替身后真实执行。
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const appFunctions = new Map();
{
  const source = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) appFunctions.set(node.name.text, node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const APP_FUNCTIONS = ["adoptCommandConfig", "applyCommandResult", "applyRouteResult", "persist"];

function harness(initial = baseConfig()) {
  const state = {
    config: initial, dirty: true, status: { running: true },
    model: { defaultModel: "current" }, provider: { id: "current" }, snapshot: { id: "current" },
  };
  const effects = [], calls = [], invocations = [];
  const persistedConfigRef = { current: initial };
  const dependencies = {
    isStaleConfig,
    applyConfigCommandResult,
    persistedConfigRef,
    setPersistedConfig: config => { calls.push("config"); persistedConfigRef.current = config; state.config = config; },
    acceptConfigApply: incoming => {
      calls.push("apply");
      if (!incoming) return incoming;
      state.status = { ...state.status, configApply: reconcileConfigApply(state.status.configApply, incoming) };
      return state.status.configApply;
    },
    setDirty: value => { calls.push("dirty"); state.dirty = value; },
    setModelState: value => { calls.push("model"); state.model = value; },
    setProviderStatus: value => { calls.push("provider"); state.provider = value; },
    setCurrentProviderSnapshot: value => { calls.push("snapshot"); state.snapshot = value; },
    setStatus: update => { calls.push("status"); state.status = update(state.status); },
    setFastContextToolsStatus: value => effects.push(value),
    UNKNOWN_FAST_CONTEXT_TOOLS_STATUS: {},
    window: { dispatchEvent: event => effects.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    refreshStatus: async () => effects.push("refresh"),
    invoke: (command, args) => { const call = { command, args, ...deferred() }; invocations.push(call); return call.promise; },
  };
  const compiled = ts.transpileModule(APP_FUNCTIONS.map(name => appFunctions.get(name)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const app = new Function(...Object.keys(dependencies), `${compiled}; return { ${APP_FUNCTIONS.join(", ")} };`)(...Object.values(dependencies));
  return { app, state, calls, effects, invocations };
}

for (const mode of ["route", "save"]) {
  test(`${mode} rejects stale config and all accompanying state`, async () => {
    const h = harness(baseConfig(3));
    const old = {
      config: baseConfig(2),
      configApply: { revision: 2, state: "pending" },
      modelState: { defaultModel: "old" }, providerStatus: { id: "old" }, currentProviderSnapshot: { id: "old" }, restartRequired: true,
    };
    if (mode === "route") {
      assert.equal(h.app.applyRouteResult(old), false);
    } else {
      const saving = h.app.persist(baseConfig(3));
      h.invocations[0].resolve(old);
      assert.equal(await saving, null);
    }
    assert.equal(h.state.config.settingsRevision, 3);
    assert.equal(h.state.dirty, true);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.effects, []);
    assert.equal(h.state.model.defaultModel, "current");
    assert.equal(h.state.provider.id, "current");
    assert.equal(h.state.snapshot.id, "current");
    assert.deepEqual(h.state.status, { running: true });
  });
}

test("an accepted save adopts the config, its status and broadcasts once", async () => {
  const h = harness();
  const saving = h.app.persist(baseConfig());
  const result = {
    config: baseConfig(2), configApply: { revision: 1, state: "pending" },
    modelState: { defaultModel: "new" }, providerStatus: { id: "new" }, currentProviderSnapshot: { id: "new" },
  };
  h.invocations[0].resolve(result);
  assert.equal(await saving, result);
  assert.equal(h.invocations[0].command, "save_codey_config");
  assert.equal(h.state.config.settingsRevision, 2);
  assert.equal(h.state.dirty, false);
  assert.deepEqual(h.state.status.configApply, { revision: 1, state: "pending" });
  assert.equal(h.state.model.defaultModel, "new");
  assert.equal(h.state.snapshot.id, "new");
  const events = h.effects.filter(effect => effect?.type === "codey:config-changed");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.currentProviderSnapshot.id, "new");
  assert.ok(h.effects.includes("refresh"));
});

for (const laterFirst of [false, true]) {
  test(`two saves in a row end in the later save when it resolves ${laterFirst ? "first" : "last"}`, async () => {
    const h = harness();
    const first = h.app.persist({ ...baseConfig(), miscModel: "first" });
    const second = h.app.persist({ ...baseConfig(), miscModel: "second" });
    const firstResult = { config: { ...baseConfig(2), miscModel: "first" }, configApply: { revision: 1, state: "pending" }, modelState: { defaultModel: "first" } };
    const secondResult = { config: { ...baseConfig(3), miscModel: "second" }, configApply: { revision: 2, state: "pending" }, modelState: { defaultModel: "second" } };
    const order = laterFirst ? [[1, secondResult], [0, firstResult]] : [[0, firstResult], [1, secondResult]];
    for (const [index, result] of order) {
      h.invocations[index].resolve(result);
      await flush();
    }
    assert.equal(await second, secondResult);
    assert.equal(await first, laterFirst ? null : firstResult);
    assert.equal(h.state.config.miscModel, "second");
    assert.equal(h.state.config.settingsRevision, 3);
    assert.equal(h.state.model.defaultModel, "second");
    assert.deepEqual(h.state.status.configApply, { revision: 2, state: "pending" });
    assert.equal(h.state.dirty, false);
  });
}

for (const incomingApply of [undefined, { revision: 2, state: "pending" }]) {
  test(`completed application survives a delayed response ${incomingApply ? "with pending status" : "with legacy restart flag"}`, () => {
    const h = harness();
    const complete = { revision: 2, state: "applied" };
    h.state.status = { running: true, configApply: complete, restartRequired: false };
    const result = { config: baseConfig(2), configApply: incomingApply, restartRequired: true };
    assert.equal(h.app.applyRouteResult(result), true);
    assert.equal(h.state.status.configApply, complete);
    assert.equal(h.state.status.restartRequired, false);
    if (incomingApply) assert.equal(result.configApply, complete);
    assert.equal(h.state.dirty, false);
  });
}

test("legacy command results still update restart state when no newer application exists", () => {
  const h = harness();
  assert.equal(h.app.applyRouteResult({ config: baseConfig(2), restartRequired: true }), true);
  assert.equal(h.state.status.restartRequired, true);
});

test("the shared boundary adopts configs only by revision", () => {
  assert.equal(isStaleConfig(null, baseConfig(1)), false);
  assert.equal(isStaleConfig(baseConfig(3), baseConfig(2)), true);
  assert.equal(isStaleConfig(baseConfig(3), baseConfig(3)), false);
  assert.equal(isStaleConfig(baseConfig(3), baseConfig(4)), false);
});

test("App renders the apply banner through the shared visibility rule", () => {
  assert.match(appSource, /configApplyBannerVisible\(status\.configApply, configApplyError\)/);
  assert.match(appSource, /configApplyCompletionNotice\(previousConfigApplyRef\.current, status\.configApply\)/);
});
