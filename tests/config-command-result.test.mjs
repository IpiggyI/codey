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
const APP_FUNCTIONS = [
  "isDraftObject", "draftValuesEqual", "configsHaveSameDraftValues", "mergeDraftValue", "reconcileSavedDraft",
  "adoptCommandConfig", "applyCommandResult", "applyRouteResult", "persist",
];
// useCallback 包裹的草稿编辑函数同样取出真实代码。
const APP_CALLBACKS = ["editConfig", "updateDraft"];
const appCallbacks = new Map();
{
  const source = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && APP_CALLBACKS.includes(node.name.text)
      && node.initializer && ts.isCallExpression(node.initializer)) {
      appCallbacks.set(node.name.text, `const ${node.name.text} = ${node.initializer.arguments[0].getText(source)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function harness(initial = baseConfig()) {
  const state = {
    config: initial, dirty: true, status: { running: true },
    model: { defaultModel: "current" }, provider: { id: "current" }, snapshot: { id: "current" },
  };
  const effects = [], calls = [], invocations = [];
  const persistedConfigRef = { current: initial };
  const draftConfigRef = { current: initial };
  const dependencies = {
    isStaleConfig,
    applyConfigCommandResult,
    persistedConfigRef,
    draftConfigRef,
    config: initial,
    setConfig: config => { calls.push("config"); state.config = config; },
    setPersistedConfig: config => {
      calls.push("config");
      persistedConfigRef.current = config;
      draftConfigRef.current = config;
      state.config = config;
    },
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
  const exported = [...APP_FUNCTIONS, ...APP_CALLBACKS];
  const compiled = ts.transpileModule([
    ...APP_FUNCTIONS.map(name => appFunctions.get(name)),
    ...APP_CALLBACKS.map(name => appCallbacks.get(name)),
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const app = new Function(...Object.keys(dependencies), `${compiled}; return { ${exported.join(", ")} };`)(...Object.values(dependencies));
  // 模拟 App：编辑同时更新草稿引用与界面状态。
  const edit = next => { draftConfigRef.current = next; state.config = next; };
  return { app, state, calls, effects, invocations, persistedConfigRef, draftConfigRef, edit };
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
    const firstDraft = { ...baseConfig(), miscModel: "first" };
    const secondDraft = { ...baseConfig(), miscModel: "second" };
    h.edit(firstDraft);
    const first = h.app.persist(firstDraft, firstDraft);
    h.edit(secondDraft);
    const second = h.app.persist(secondDraft, secondDraft);
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

test("save response retains edits made after submitting the draft", async () => {
  const h = harness();
  const submitted = { ...baseConfig(), miscModel: "submitted" };
  h.edit(submitted);
  const saving = h.app.persist(submitted, submitted);
  h.edit({ ...submitted, miscModel: "edited while saving" });
  const incoming = { ...submitted, settingsRevision: 2, serverFlag: true };
  h.invocations[0].resolve({ config: incoming });
  await saving;
  assert.equal(h.state.config.miscModel, "edited while saving");
  assert.equal(h.state.config.serverFlag, true);
  assert.equal(h.state.config.settingsRevision, 2);
  assert.equal(h.persistedConfigRef.current, incoming);
  assert.equal(h.draftConfigRef.current, h.state.config);
  assert.equal(h.state.dirty, true);
});

test("save acknowledgement clears dirty for an unchanged draft and for edits that match the saved values", async () => {
  for (const edited of [false, true]) {
    const h = harness();
    const submitted = { ...baseConfig(), miscModel: "submitted" };
    h.edit(submitted);
    const saving = h.app.persist(submitted, submitted);
    const incoming = { ...submitted, settingsRevision: 2 };
    if (edited) h.edit({ ...submitted, miscModel: "temporary" });
    if (edited) h.edit({ ...submitted });
    h.invocations[0].resolve({ config: incoming, configApply: { revision: 2, state: "failed" }, restartRequired: true });
    await saving;
    assert.equal(h.state.dirty, false);
    assert.equal(h.state.config.settingsRevision, 2);
  }
});

test("a stale save response keeps edits made while saving", async () => {
  const h = harness(baseConfig(3));
  const submitted = { ...baseConfig(3), miscModel: "submitted" };
  h.edit(submitted);
  const saving = h.app.persist(submitted, submitted);
  h.edit({ ...submitted, miscModel: "edited while saving" });
  h.invocations[0].resolve({ config: baseConfig(2) });
  assert.equal(await saving, null);
  assert.equal(h.state.config.miscModel, "edited while saving");
  assert.equal(h.state.config.settingsRevision, 3);
});

test("draft comparison ignores revision and object key order but keeps array values significant", () => {
  const { configsHaveSameDraftValues } = harness().app;
  const left = { settingsRevision: 1, nested: { a: 1, b: 2 }, profiles: [{ id: "one" }] };
  assert.equal(configsHaveSameDraftValues(left, { profiles: [{ id: "one" }], nested: { b: 2, a: 1 }, settingsRevision: 9 }), true);
  assert.equal(configsHaveSameDraftValues(left, { ...left, profiles: [{ id: "two" }] }), false);
  assert.equal(configsHaveSameDraftValues(left, { ...left, profiles: [] }), false);
  assert.equal(configsHaveSameDraftValues(null, null), true);
  assert.equal(configsHaveSameDraftValues(left, null), false);
});

test("editing a saved value back to its baseline clears dirty", () => {
  const h = harness();
  const initial = h.state.config;
  h.app.editConfig({ ...initial, miscModel: "changed" });
  assert.equal(h.state.dirty, true);
  h.app.editConfig({ ...initial, settingsRevision: 99 });
  assert.equal(h.state.dirty, false);
});

test("functional draft updates build on the latest draft, not a stale render snapshot", () => {
  const h = harness();
  const initial = h.state.config;
  h.app.editConfig({ ...initial, miscModel: "first" });
  h.app.updateDraft(current => ({ ...current, subagentOptimization: true }));
  assert.equal(h.draftConfigRef.current.miscModel, "first");
  assert.equal(h.draftConfigRef.current.subagentOptimization, true);
  assert.equal(h.state.dirty, true);
});

function saveHarness({ dirty = true } = {}) {
  const persisted = [];
  const notices = [];
  const gates = [];
  const saveInFlightRef = { current: false };
  const config = { settingsRevision: 1, miscModel: "draft" };
  const dependencies = {
    config, dirty, saveInFlightRef, notices,
    runOperation: async (_name, action) => { await action(); },
    persist: async next => {
      persisted.push(next);
      await new Promise(resolve => gates.push(resolve));
      return {};
    },
    setNotice: notice => notices.push(notice),
    configApplyNotice: status => ({ tone: "info", text: status.state }),
  };
  const compiled = ts.transpileModule(appFunctions.get("saveCurrent"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const saveCurrent = new Function(...Object.keys(dependencies), `${compiled}; return saveCurrent;`)(...Object.values(dependencies));
  return { saveCurrent, persisted, gates, saveInFlightRef, config };
}

test("save does nothing for a clean draft and submits once while a save is in flight", async () => {
  const clean = saveHarness({ dirty: false });
  const cleanSave = clean.saveCurrent();
  await flush();
  assert.equal(clean.persisted.length, 0);
  clean.gates.forEach(release => release());
  await cleanSave;

  const h = saveHarness();
  const first = h.saveCurrent();
  await flush();
  assert.equal(h.saveInFlightRef.current, true);
  const second = h.saveCurrent();
  await flush();
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0], h.config);
  h.gates.forEach(release => release());
  await Promise.all([first, second]);
  assert.equal(h.saveInFlightRef.current, false);
  const again = h.saveCurrent();
  await flush();
  assert.equal(h.persisted.length, 2);
  h.gates.forEach(release => release());
  await again;
});

test("a failed save releases the in-flight guard", async () => {
  const rejecting = saveHarnessRejecting();
  await assert.rejects(rejecting.saveCurrent(), /boom/);
  assert.equal(rejecting.saveInFlightRef.current, false);
});

function saveHarnessRejecting() {
  const saveInFlightRef = { current: false };
  const dependencies = {
    config: { settingsRevision: 1 }, dirty: true, saveInFlightRef,
    runOperation: async (_name, action) => { await action(); },
    persist: async () => { throw new Error("boom"); },
    setNotice: () => {}, configApplyNotice: () => ({}),
  };
  const compiled = ts.transpileModule(appFunctions.get("saveCurrent"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { saveCurrent: new Function(...Object.keys(dependencies), `${compiled}; return saveCurrent;`)(...Object.values(dependencies)), saveInFlightRef };
}

test("the save button reports progress while editing stays open for feature controls", () => {
  assert.match(appSource, /const saving = busy === "save";\s+const saveButtonText = saving \? "保存中" : dirty \? "保存更改" : "已保存"/);
  assert.match(appSource, /aria-label=\{saving \? "正在保存设置" : saveButtonText\}[\s\S]{0,200}loading=\{saving\}/);
});
