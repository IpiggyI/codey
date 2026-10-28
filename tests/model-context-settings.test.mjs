import assert from "node:assert/strict";
import test from "node:test";

import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const model = "gpt-5.6-sol";
const modelState = {
  officialModels: [{ slug: model, supported: true }],
  officialModelIds: [model],
  thirdPartyModels: [],
  manualThirdPartyModels: [],
  upstreamModels: [],
  defaultModel: model,
};

function modelPicker() {
  const calls = [];
  const notices = [];
  const config = {
    settingsRevision: 1,
    selectedModelsByProvider: { provider: [model] },
    declaredOfficialModelsByProvider: {},
    manualThirdPartyModelsByProvider: {},
    upstreamModelsByProvider: {},
    modelContextByProvider: {},
  };
  const graph = createModuleGraph(new URL("../src/useModelSelection.ts", import.meta.url), {
    stubs: {
      "./api": { invoke: async (command, args) => {
        calls.push({ command, args });
        return { config: { ...config, settingsRevision: 2 }, modelState: { ...modelState, defaultModel: "saved" }, restartRequired: true };
      } },
    },
  });
  const options = {
    config,
    currentProviderSnapshot: { id: "provider", ownershipKey: "provider" },
    officialAccountAvailable: true,
    runOperation: async (_name, action) => action(),
    applyConfigResult: () => true,
    setNotice: notice => notices.push(notice),
  };
  const render = () => {
    graph.restart();
    return graph.exports.useModelSelection(options);
  };
  render().openModelPicker(modelState, "", "provider");
  return { render, calls, options, notices };
}

test("模型保存结果被接纳时关闭编辑器并提示", async () => {
  const { render, calls, options, notices } = modelPicker();
  const accepted = [];
  options.applyConfigResult = result => { accepted.push(result); return true; };
  await render().saveModelSelection();
  assert.equal(calls[0].command, "save_selected_models");
  assert.equal(accepted.length, 1);
  assert.equal(render().modelPickerVisible, false);
  assert.equal(notices.length, 1);
});

test("模型保存结果过期时保留当前编辑器，不更新模型或提示", async () => {
  const { render, options, notices } = modelPicker();
  const accepted = [];
  options.applyConfigResult = result => { accepted.push(result); return false; };
  const before = render().modelState;
  await render().saveModelSelection();
  assert.equal(accepted.length, 1);
  assert.equal(render().modelState, before);
  assert.equal(render().modelPickerVisible, true);
  assert.deepEqual(notices, []);
});

test("模型顺序保存结果过期时不提示且不报告已保存", async () => {
  const { render, options, notices } = modelPicker();
  options.applyConfigResult = () => false;
  assert.equal(await render().saveModelOrder([model], "manual"), false);
  assert.deepEqual(notices, []);
  options.applyConfigResult = () => true;
  assert.equal(await render().saveModelOrder([model], "manual"), true);
  assert.equal(notices.length, 1);
});
