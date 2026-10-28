import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";

import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

async function loadRendererPatch(options) {
  const records = [];
  const context = {
    console: { error() {} }, URL, BigInt, Map, Set,
    __codeyPatchLog: (record) => records.push(JSON.parse(record)),
  };
  runInNewContext(await loadStartupPatchTemplate(options), context);
  assert.equal(context.__codeyRendererPatchInstalled, true);
  return { patch: context.__codeyRendererPatchEntry, records, context };
}

const entitlementSource = [
  "const signal=`Failed to read service tier for request`;",
  "async function allowed(e,t){let n=await auth(e,t);",
  "if(n!==`chatgpt`&&n!==`personalAccessToken`)return!1;",
  "let r=await requirements(e,t);return r.requirements?.featureRequirements?.fast_mode!==!1}",
].join("");

const ultraQuerySource = await readFile(
  new URL("./fixtures/codex-ultra-model-query.js", import.meta.url), "utf8",
);

function ultraQuery(source, { custom, caller, gate, efforts }) {
  const calls = [];
  const query = runInNewContext(source, {
    di: undefined, qSn: () => [], kio: "efforts", yio: "models", Lg: "gate",
    cg: "hosts", Ms: { FIVE_MINUTES: 300000 }, xio: (options) => options,
  });
  const result = query({
    additionalAvailableModels: [], authMethod: "apikey", enabledReasoningEfforts: efforts,
    hostId: "local", includeUltraReasoningEffort: caller, isCustomModelProvider: custom,
    modelCatalogPath: "catalog.json", modelProvider: "provider",
  }, {
    get: (key, id) => {
      calls.push([key, id]);
      if (key === "gate") return gate;
      if (key === "efforts") return new Set(["high"]);
      if (key === "hosts") return ["local"];
      return { availableModels: new Set(), useHiddenModels: false };
    },
  });
  return { selected: result.select({ data: [] }), calls };
}

test("custom provider Ultra bypasses the official gate and preserves caller and user settings", async () => {
  const { patch, records } = await loadRendererPatch();
  const patched = patch("app://-/assets/app-initial-ultra.js", ultraQuerySource);
  assert.equal(typeof patched, "string");
  assert.deepEqual(records, []);
  for (const caller of [false, true]) {
    for (const gate of [false, true]) {
      for (const efforts of [undefined, ["low", "ultra"]]) {
        const { selected, calls } = ultraQuery(patched, { custom: true, caller, gate, efforts });
        assert.equal(selected.includeUltraReasoningEffort, caller);
        assert.deepEqual([...selected.enabledReasoningEfforts], efforts ? [...efforts, "persistent"] : ["high"]);
        assert.equal(calls.some(([key]) => key === "gate"), false);
      }
    }
  }
});

test("non-custom providers keep the official Ultra gate", async () => {
  const { patch } = await loadRendererPatch();
  const patched = patch("app://-/assets/app-initial-ultra.js", ultraQuerySource);
  for (const caller of [false, true]) {
    for (const gate of [false, true]) {
      const options = { custom: false, caller, gate };
      assert.equal(ultraQuery(patched, options).selected.includeUltraReasoningEffort, caller && gate);
      assert.deepEqual(ultraQuery(patched, options).calls, ultraQuery(ultraQuerySource, options).calls);
    }
  }
});

test("a mismatched Ultra anchor preserves the source, records failure and skips only this item", async () => {
  const { patch, records } = await loadRendererPatch();
  const drifted = ultraQuerySource.replace("S=a&&d(", "S=a||d(");
  assert.equal(patch("app://-/assets/app-initial-drifted.js", drifted), null);
  const patched = patch("app://-/assets/app-initial-other.js", drifted + ";" + entitlementSource);
  assert.ok(patched.startsWith(drifted + ";"));
  assert.match(patched, /async function allowed\(e,t\)\{return!0\}/);
  assert.equal(records.length, 2);
  assert.ok(records.every(({ operation, context }) =>
    operation === "renderer_patch:third-party Ultra reasoning" && context.matchCount === 0));
});

test("the Ultra patch leaves Ultrafast access and service tiers unchanged", async () => {
  const { patch, records } = await loadRendererPatch();
  const speed = "const supportsIndependentSpeedModes=true,ultrafast_mode=true;"
    + "function speedAllowed(e,t){if(e==null)return!1;let n=kind(t);return t===`flex`||e[n??`fast`]}"
    + "const settings={serviceTierAccess:access,isLoading:false};";
  const patched = patch("app://-/assets/app-initial-ultra.js", ultraQuerySource + ";" + speed);
  assert.ok(patched.endsWith(";" + speed));
  assert.equal(patched, (ultraQuerySource + ";" + speed).replace("S=a&&d(Lg,`1186680773`)", "S=a&&(o||d(Lg,`1186680773`))"));
  assert.deepEqual(records, []);
});

const nativeModelAccessSource = [
  "const includeUltraReasoningEffort=!0;",
  "function visible({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:o,useHiddenModels:s}){",
  "let c=o.availableAccessPrograms?.cyber;return n===`apikey`&&!t&&c!=null&&c.length>0&&!c.includes(`standard`)?!1:",
  "e?.has(o.model)===!0||o.model!==`codex-auto-review`&&(i&&!o.hidden||",
  "(s&&!a&&n!==`amazonBedrock`?r.has(o.model)||n===`apikey`&&t&&!o.hidden&&c?.some(e=>e!==`standard`)===!0:!o.hidden))}",
].join("");

for (const gate of ["model allowlist", "model visibility"]) {
  test(`Codex 26.1013 native model access skips the ${gate} patch`, async () => {
    const { patch, records } = await loadRendererPatch();
    assert.equal(patch("app://-/assets/app-initial-native-models.js", nativeModelAccessSource), null);
    assert.deepEqual(records.filter(({ operation }) => operation === `renderer_patch:${gate}`), []);
    const visible = runInNewContext(`${nativeModelAccessSource};visible`);
    const options = {
      additionalAvailableModels: new Set(), apiKeyDaybreakSupported: false,
      authMethod: "apikey", availableModels: new Set(), hasConfiguredModelCatalog: false,
      isCustomModelProvider: true, model: { model: "provider-model", hidden: false },
      useHiddenModels: true,
    };
    assert.equal(visible(options), true);
    assert.equal(visible({ ...options, authMethod: "chatgpt" }), true);
    assert.equal(visible({ ...options, model: { ...options.model, hidden: true } }), false);
    assert.equal(visible({ ...options, isCustomModelProvider: false, authMethod: "chatgpt" }), false);
    assert.equal(visible({ ...options, isCustomModelProvider: false, authMethod: "chatgpt",
      availableModels: new Set(["provider-model"]) }), true);
    assert.equal(visible({ ...options, model: { ...options.model,
      availableAccessPrograms: { cyber: ["restricted"] } } }), false);
    assert.equal(visible({ ...options, apiKeyDaybreakSupported: true,
      model: { ...options.model, availableAccessPrograms: { cyber: ["restricted"] } } }), true);
  });
}

test("Codex 26.1013 native model recognition follows renamed bindings", async () => {
  const { patch, records } = await loadRendererPatch();
  const renamed = nativeModelAccessSource.replace(/\b[aceinorst]\b/g, (name) => `$${name}`);
  assert.equal(patch("app://-/assets/app-initial-renamed-models.js", renamed), null);
  assert.deepEqual(records, []);
});

test("Codex 26.1013 model gates still report incompatible provider and visibility conditions", async () => {
  for (const source of [
    nativeModelAccessSource.replace("s&&!a", "s&&a"),
    nativeModelAccessSource.replace(":!o.hidden))", ":o.hidden))"),
    nativeModelAccessSource.replace("r.has(o.model)", "r.has(other.model)"),
  ]) {
    const { patch, records } = await loadRendererPatch();
    assert.equal(patch("app://-/assets/app-initial-incompatible-models.js", source), null);
    assert.deepEqual(records.map(({ operation }) => operation), [
      "renderer_patch:model allowlist",
      "renderer_patch:model visibility",
    ]);
    assert.ok(records.every(({ context }) => context.matchCount === 0));
  }
});

test("the renderer patch loads without Node, Electron or a DOM", async () => {
  const { patch, context, records } = await loadRendererPatch();
  assert.equal(context.process, undefined);
  assert.equal(context.window, undefined);
  assert.equal(context.document, undefined);
  const patched = patch("app://-/assets/app-shared-current.js", entitlementSource);
  assert.match(patched, /async function allowed\(e,t\)\{return!0\}/);
  assert.deepEqual(records, []);
  assert.equal(patch(null, entitlementSource), null);
  assert.equal(patch("app://-/assets/app-shared-current.js", null), null);
  assert.equal(patch("app://-/assets/app-shared-current.js", "const untouched=1"), null);
});

test("browser interception and the page entry share the local asset list", async () => {
  const { patch } = await loadRendererPatch();
  for (const name of ["app-initial", "app-primary", "app-shared", "codex-composer-adapter",
    "initialize-app-host-services", "general-settings", "model-list-filter", "windows-model-controls",
    "use-service-tier-settings", "read-service-tier-for-request", "subagent-activity-chip-group"]) {
    assert.match(patch(`app://-/assets/${name}-current.js?version=2`, entitlementSource), /return!0/);
  }
  assert.equal(patch("app://-/assets/custom-entry.js", entitlementSource), null);
  assert.equal(patch("https://example.invalid/assets/app-initial.js", entitlementSource), null);
  const slim = await loadRendererPatch({ disablePet: true });
  for (const name of ["appearance-settings", "pet-settings", "pets-settings"]) {
    assert.equal(patch(`app://-/assets/${name}-current.js`, entitlementSource), null);
    assert.match(slim.patch(`app://-/assets/${name}-current.js`, entitlementSource), /return!0/);
  }
});

test("a drifted gate skips only itself and repeated failures stay deduplicated", async () => {
  const { patch, records } = await loadRendererPatch();
  const source = 'const markers="useHiddenModels: availableModels: includeUltraReasoningEffort amazonBedrock";'
    + entitlementSource;
  for (const url of [
    "app://-/assets/app-initial-current.js",
    "app://-/assets/app-shared-current.js",
  ]) {
    const patched = patch(url, source);
    assert.ok(patched.startsWith('const markers="useHiddenModels:'));
    assert.match(patched, /async function allowed\(e,t\)\{return!0\}/);
  }
  assert.deepEqual(records.map(({ operation }) => operation), [
    "renderer_patch:model allowlist",
    "renderer_patch:model visibility",
  ]);
  assert.ok(records.every(({ context }) => context.matchCount === 0));
});
