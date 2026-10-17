import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

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

test("bootstrap discovery adds bounded app assets and respects pet options", async () => {
  const { patch } = await loadRendererPatch();
  const discovered = "app://-/webview/assets/custom-entry.js?version=2";
  assert.equal(patch(discovered, entitlementSource), null);
  assert.equal(patch("app://-/webview/index.html", [
    '<script src="./assets/custom-entry.js?version=1"></script>',
    '<link href="./assets/preloaded-entry.js" rel="modulepreload">',
    '<link href="https://example.invalid/assets/external.js" rel="modulepreload">',
    '<script src="./outside-assets.js"></script>',
  ].join("")), null);
  assert.match(patch(discovered, entitlementSource), /function allowed\(e,t\)\{return!0\}/);
  assert.match(patch("app://-/webview/assets/preloaded-entry.js", entitlementSource), /return!0/);
  assert.equal(patch("https://example.invalid/assets/external.js", entitlementSource), null);
  assert.equal(patch("app://-/webview/outside-assets.js", entitlementSource), null);
  assert.equal(patch("app://-/assets/pets-settings-route-current.js", entitlementSource), null);
  const slim = await loadRendererPatch({ disablePet: true });
  assert.match(slim.patch("app://-/assets/pets-settings-route-current.js", entitlementSource), /return!0/);
  const html = Array.from({ length: 129 }, (_, index) =>
    `<script src="./assets/discovered-${index}.js"></script>`).join("");
  patch("app://-/index.html", html);
  assert.equal(patch("app://-/assets/discovered-0.js", entitlementSource), null);
  assert.match(patch("app://-/assets/discovered-128.js", entitlementSource), /return!0/);
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
