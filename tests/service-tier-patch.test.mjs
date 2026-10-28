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

const cdp = await readFile(new URL("../backend/src/cdp.rs", import.meta.url), "utf8");
const tierProbe = cdp.match(/service_tier::LOADER,\s*r#"([\s\S]*?)"#/)[1];
const snapshot = cdp.match(/fn injection_status_snapshot_script[\s\S]*?r#"([\s\S]*?)"#/)[1]
  .replaceAll("{{", "{").replaceAll("}}", "}")
  .replace("{probes}", `{"service-tier":()=>(${tierProbe}),other:()=>{throw Error('must not run')}}`)
  .replaceAll("{MAX_INJECTION_ERROR_CHARS}", "500");

for (const [name, source, installed] of [
  ["installed", "function codeyReadServiceTier(){};codeyReadServiceTier.__codeyServiceTier=1;export {codeyReadServiceTier}", true],
  ["missing marker", "export function codeyReadServiceTier(){}", false],
  ["missing reader", "export const other={__codeyServiceTier:1}", false],
  ["wrong reader", "function other(){};other.__codeyServiceTier=1;export {other}", false],
  ["module error", "throw Error('module unavailable')", false],
]) {
  test(`failed service-tier refresh checks actual installation: ${name}`, async () => {
    const url = `data:text/javascript,${encodeURIComponent(source)}#/app-initial-test.js`;
    const window = {
      __codeyServiceTierStatus: {status: "failed", error: "original prepare failure"},
      __codeyInjectionStatus: {
        "service-tier": {id: "service-tier", status: "failed", error: "original prepare failure"},
        other: {id: "other", status: "failed", error: "unrelated"},
      },
    };
    const document = {querySelectorAll: () => [{src: url}]};
    const run = new Function("window", "document", "performance", `return ${snapshot}`);
    await run(window, document, {getEntriesByType: () => []});
    const entry = window.__codeyInjectionStatus["service-tier"];
    assert.equal(entry.status, installed ? "effective" : "failed");
    assert.equal(window.__codeyServiceTierStatus.status, installed ? "ready" : "failed");
    if (installed) assert.equal(entry.error, undefined);
    else assert.equal(entry.error, "original prepare failure");
    assert.equal(window.__codeyInjectionStatus.other.error, "unrelated");
  });
}

test("refresh rejects a saved ready state without the installed reader", async () => {
  const window = {
    __codeyServiceTierStatus: {status: "ready"},
    __codeyInjectionStatus: {"service-tier": {id: "service-tier", status: "effective"}},
  };
  const run = new Function("window", "document", "performance", `return ${snapshot}`);
  await run(window, {querySelectorAll: () => []}, {getEntriesByType: () => []});
  assert.equal(window.__codeyInjectionStatus["service-tier"].status, "failed");
  assert.match(window.__codeyInjectionStatus["service-tier"].error, /读取函数或安装标记不存在/);
});

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
