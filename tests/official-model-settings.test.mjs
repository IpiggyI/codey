import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

test("official settings use effective availability and save only the displayed catalog snapshot", async () => {
  const slots = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const components = new Proxy({}, { get: (_, name) => name });
  const imports = {
    react: {
      memo: (component) => component,
      useMemo: (compute) => compute(),
      useCallback: (callback) => callback,
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tabler/icons-react": components,
    "@heroui/react": components,
    "./components/ui": components,
    "./components/ModelCombobox": components,
    "./components/ModelOrderEditor": components,
    "./modelIds": await loadTypeScriptModule(new URL("../src/modelIds.ts", import.meta.url)),
    "./modelRoutes": { globalDefaultForProvider: (config) => config.defaultModel },
    "./overlay.constants": { SETTINGS_OVERLAY_Z_INDEX: 1 },
    "./uiClasses": { flushCardClass: "" },
  };
  const source = await readFile(new URL("../src/ModelSection.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, exports);
  const nodes = (node) => !node || typeof node !== "object" ? []
    : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const models = ["gpt-5.6-sol", "gpt-6-astra"];
  const state = (names) => ({
    officialModelIds: names,
    officialModels: names.map((slug) => ({ slug, displayName: slug, supported: true })),
  });
  let saved;
  const props = {
    config: { selectedModelsByProvider: { openai: [models[0]] }, defaultModel: models[0] },
    currentProviderSnapshot: { id: "openai", ownershipKey: "openai", usesOfficialAccountAuth: true },
    officialAccountAvailable: true, modelState: state(models), subagentModelOptions: [],
    onSaveOfficialRouteSettings: async (...args) => { saved = args; return true; },
  };
  const render = () => { cursor = 0; return nodes(exports.ModelSection(props)); };
  let tree = render();
  const configure = tree.find((node) => node.type === "Button" && node.props.children?.includes?.("同步模型"));
  assert.ok(configure, "the official model editor must be reachable");
  configure.props.onPress();
  tree = render();
  const astra = tree.find((node) => node.type === "Checkbox" && node.props["aria-label"] === "停用官方模型 gpt-6-astra");
  assert.ok(astra?.props.checked, "a new native model stays selected despite the old saved allowlist");
  astra.props.onCheckedChange(false);
  props.modelState = state([...models, "future-official-model"]);
  tree = render();
  assert.equal(tree.some((node) => node.type === "Checkbox" && node.props["aria-label"]?.includes("future-official-model")), false);
  const save = tree.find((node) => node.type === "Button" && node.props.children?.includes?.("保存模型"));
  assert.ok(save);
  await save.props.onPress();
  assert.deepEqual(saved[0], ["gpt-5.6-sol"]);
  assert.deepEqual(saved[2], models);
});
