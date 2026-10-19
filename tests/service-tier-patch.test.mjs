import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { serviceTierEnvironment } from "./helpers/service-tier-environment.mjs";

const fixture = await readFile(new URL("./fixtures/codex-service-tier.js", import.meta.url), "utf8");
const shared = await readFile(new URL("./fixtures/codex-service-tier-shared.js", import.meta.url), "utf8");
const legacy = await readFile(new URL("./fixtures/codex-service-tier-legacy.js", import.meta.url), "utf8");
const planner = await readFile(new URL("../backend/src/cdp/service_tier.js", import.meta.url), "utf8");
const plan = (source) => runInNewContext(`${planner};codeyServiceTierExpression`)(source);
const native = `${shared};${fixture};const Xi=Xat,Tr=Uat,We=Wat,Lee=Yat;`;

test("native independent tier reads and selection share model validation", async () => {
  const expression = plan(fixture);
  const env = serviceTierEnvironment();
  const runtime = runInNewContext(`${native}
    ({read:(model,tier)=>x$s(scope,'local',model,tier),
      apply:()=>${expression},
      select:(id,tier)=>_wo(id,{modelSettings:state.modelSettings,setModelAndReasoningEffort(){}},
        {value:tier},false,{serviceTier:tier,isLoading:state.settingsLoading})})`, env);
  const options = (selected) => selected.serviceTierSettings.availableOptions.map((option) => option.value);
  assert.equal(await runtime.read("supported", "priority"), null);
  const mounted = runtime.select(null, "priority");
  assert.equal(mounted.serviceTierAccess, null);
  assert.deepEqual(options(mounted), [null]);
  assert.equal(mounted.serviceTierSettings.serviceTierForRequest, null);
  assert.equal(runtime.apply(), true);
  const remounted = runtime.select(null, "priority");
  assert.deepEqual({ ...remounted.serviceTierAccess }, { fast: true, ultrafast: true });
  assert.deepEqual(options(remounted), [null, "priority"]);
  assert.equal(remounted.serviceTierSettings.serviceTierForRequest, "priority");
  for (const auth of [null, "apikey", "chatgpt", "personalAccessToken"]) {
    env.state.authMethod = auth;
    assert.equal(await runtime.read("supported", "priority"), "priority");
    assert.equal(await runtime.read("supported", "default"), null);
    assert.equal(await runtime.read("supported", null), null);
    assert.equal(await runtime.read("unsupported", "priority"), null);
  }
  for (const model of ["supported", "unsupported"]) {
    env.state.config.model = model;
    for (const tier of [undefined, "default", "priority"]) {
      env.state.config.service_tier = tier;
      assert.equal(await runtime.read(null), model === "supported" && tier !== "default" ? "priority" : null);
    }
    env.state.selection = { type: "custom", serviceTier: "priority" };
    assert.equal(await runtime.read(model), model === "supported" ? "priority" : null);
    env.state.selection = { type: "standard" };
    assert.equal(await runtime.read(model), null);
    env.state.selection = { type: "fromConfig" };
    env.state.modelSettings.model = model;
    for (const id of [null, "thread"]) {
      env.state.modelSettings.serviceTier = "priority";
      const selected = runtime.select(id, "priority").serviceTierSettings;
      assert.equal(selected.serviceTierForRequest, model === "supported" ? "priority" : null);
      assert.equal(selected.selectedServiceTier, selected.serviceTierForRequest);
      env.state.requirementsPending = true;
      assert.equal(runtime.select(id, "priority").serviceTierSettings.isLoading, false);
      env.state.requirementsPending = false;
      env.state.settingsLoading = true;
      assert.equal(runtime.select(id, "priority").serviceTierSettings.isLoading, true);
      env.state.settingsLoading = false;
    }
  }
  assert.deepEqual(env.errors, []);
});

test("unknown native layouts fail before generating a partial patch", () => {
  assert.throws(() => plan(legacy), /服务档位权限形态不兼容/);
  assert.throws(() => plan(fixture.replaceAll("serviceTierForRequest:", "unknown:")), /形态不兼容/);
  assert.throws(() => plan(fixture.replace("?Tr(c):null", "?c:null")), /服务档位依赖形态不兼容/);
  assert.throws(() => plan(fixture + fixture), /形态不兼容/);
  const runtime = runInNewContext(`${native}
    Mxo=function changed(){};const before=[x$s,Mxo,_wo];
    ({apply:()=>${plan(fixture)},unchanged:()=>[x$s,Mxo,_wo].every((fn,i)=>fn===before[i])})`, serviceTierEnvironment());
  assert.throws(() => runtime.apply(), /源码已变化/);
  assert.equal(runtime.unchanged(), true);
});

test("loader retries failures and isolates completions from replaced bridges", async () => {
  const rust = await readFile(new URL("../backend/src/cdp/service_tier.rs", import.meta.url), "utf8");
  const loader = rust.match(/const LOADER: &str = r#"([\s\S]*?)"#;/)[1];
  const window = {}, pending = [], errors = [];
  const bridge = () => new Promise((resolve) => pending.push(resolve));
  window.__codexSessionDeleteBridge = bridge;
  const run = () => runInNewContext(loader, { window, console: { error: (...args) => errors.push(args) } });
  run();
  const old = window.__codeyServiceTierInstallation;
  run();
  assert.equal(pending.length, 1);
  window.__codexSessionDeleteBridge = (...args) => bridge(...args);
  run();
  pending[0]({ status: "failed", message: "old bridge" });
  await old;
  assert.equal(window.__codeyServiceTierStatus.status, "pending");
  pending[1]({ status: "failed", message: "current bridge" });
  await window.__codeyServiceTierInstallation;
  assert.equal(window.__codeyServiceTierStatus.status, "failed");
  run();
  pending[2]({ status: "ok" });
  await window.__codeyServiceTierInstallation;
  assert.equal(window.__codeyServiceTierStatus.status, "ready");
  run();
  assert.equal(pending.length, 3);
  assert.equal(errors.length, 2);
});
