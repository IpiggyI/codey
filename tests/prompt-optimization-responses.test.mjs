import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  autoStubModule,
  collectElements,
  createModuleGraph,
  elementProps,
  elementType,
  textContent,
} from "./helpers/jsx-tree.mjs";

const cardSource = readFileSync(
  new URL("../src/PromptOptimizationCard.tsx", import.meta.url),
  "utf8",
);
const backendSource = readFileSync(
  new URL("../backend/src/prompt_optimization.rs", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);

test("prompt optimization switches between official account, current provider, and manual configuration", () => {
  assert.match(cardSource, /官方账号/);
  assert.match(cardSource, /沿用当前 provider/);
  assert.match(cardSource, /手动配置/);
  assert.match(cardSource, /改为手工填写/);
  assert.match(cardSource, /OpenAI Responses/);
  assert.match(cardSource, /OpenAI Chat Completions/);
  assert.match(cardSource, /Anthropic Messages/);
  assert.doesNotMatch(cardSource, /使用 Codey 路由/);
  assert.doesNotMatch(cardSource, /<ModelCombobox/);
  assert.doesNotMatch(cardSource, /所有线路均暂无模型/);
  assert.match(cardSource, /from "\.\/components\/ui"/);
  assert.doesNotMatch(cardSource, /from "\.\/components\/mantine"/);
  assert.doesNotMatch(cardSource, /from "\.\/mantine"/);
  assert.doesNotMatch(cardSource, /@mantine\/core/);
});

const manualComboboxSource = readFileSync(
  new URL("../src/components/ManualModelCombobox.tsx", import.meta.url),
  "utf8",
);

test("prompt optimization renders the searchable manual model combobox without remounting", () => {
  assert.doesNotMatch(cardSource, /modelSelectKey/);
  assert.match(
    cardSource,
    /<ManualModelCombobox[\s\S]*?options=\{cloudModels\}/,
  );
  assert.match(manualComboboxSource, /from "@heroui\/react"/);
  assert.match(manualComboboxSource, /<ComboBox[\s\S]*allowsCustomValue/);
  assert.match(manualComboboxSource, /使用自定义模型/);
  assert.doesNotMatch(manualComboboxSource, /from "\.\/mantine"/);
  assert.doesNotMatch(manualComboboxSource, /@mantine\/core/);
  assert.doesNotMatch(cardSource, /prompt-optimization-model-create-option/);
});

test("prompt optimization supports all manual upstream request formats", () => {
  assert.match(backendSource, /fn responses_payload\(/);
  assert.match(backendSource, /fn openai_chat_payload\(/);
  assert.match(backendSource, /fn anthropic_payload\(/);
  assert.match(backendSource, /extract_anthropic_optimized_text/);
  assert.match(backendSource, /extract_responses_optimized_text\(response\)/);
  assert.match(backendSource, /extract_responses_stream_optimized_text/);
  assert.match(backendSource, /remove\("max_output_tokens"\)/);
});

test("prompt optimization connection tests use the shared toast instead of inline results", () => {
  assert.match(appSource, /<PromptOptimizationCard[\s\S]*?onNotice=\{setNotice\}/);
  assert.match(cardSource, /onNotice: \(notice: Notice\) => void/);
  assert.match(cardSource, /showTestNotice\(\s*"success"/);
  assert.match(cardSource, /showTestNotice\(\s*"error"/);
  assert.doesNotMatch(cardSource, /<NoticeToast/);
  assert.doesNotMatch(cardSource, /\btestResult\b/);
});

function renderCard({ officialAccountAvailable = false } = {}) {
  const ui = autoStubModule("ui");
  const graph = createModuleGraph(
    new URL("../src/PromptOptimizationCard.tsx", import.meta.url),
    { autoStub: true, stubs: { "./components/ui": ui } },
  );
  const changes = [];
  const render = (current) => {
    graph.restart();
    return graph.exports.PromptOptimizationCard({
      config: { promptOptimization: current },
      currentProviderSnapshot: null,
      officialAccountAvailable,
      isBusy: false,
      popupContainer: null,
      onConfigChange: (next) => changes.push(next),
      onNotice: () => {},
    });
  };
  const fetchButton = (tree) =>
    collectElements(
      tree,
      (node) => elementType(node) === ui.Button && textContent(node) === "获取列表",
    )[0];
  const switchTo = (tree, label) => {
    const tab = collectElements(
      tree,
      (node) => node.type === "button" && textContent(node) === label,
    )[0];
    elementProps(tab).onClick();
    return changes.at(-1).promptOptimization;
  };
  return { render, fetchButton, switchTo, text: textContent };
}

const savedManualWithoutKey = (credentialsReadyByMode) => ({
  enabled: true,
  mode: "manual",
  baseUrl: "",
  apiKey: "",
  apiKeyConfigured: false,
  model: "",
  upstreamProtocol: "openaiResponses",
  instruction: "",
  credentialsReady: false,
  ...(credentialsReadyByMode ? { credentialsReadyByMode } : {}),
});

test("切换到官方账号草稿后，按官方账号自身的就绪状态启用获取列表", () => {
  const card = renderCard();
  const saved = savedManualWithoutKey({ officialAccount: true, currentProvider: false });
  const draft = card.switchTo(card.render(saved), "官方账号");
  assert.equal(draft.mode, "officialAccount");
  const tree = card.render(draft);
  assert.equal(elementProps(card.fetchButton(tree)).disabled, false);
  assert.match(card.text(tree), /使用本机 ChatGPT 登录态/);
});

test("切换到沿用当前 provider 草稿后，按该模式自身的就绪状态决定获取列表", () => {
  const card = renderCard();
  const ready = savedManualWithoutKey({ officialAccount: false, currentProvider: true });
  const readyDraft = card.switchTo(card.render(ready), "沿用当前 provider");
  assert.equal(
    elementProps(card.fetchButton(card.render(readyDraft))).disabled,
    false,
  );
  const notReady = savedManualWithoutKey({ officialAccount: true, currentProvider: false });
  const notReadyDraft = card.switchTo(card.render(notReady), "沿用当前 provider");
  assert.equal(
    elementProps(card.fetchButton(card.render(notReadyDraft))).disabled,
    true,
  );
});

test("缺少分模式就绪状态时，非手动模式保持获取列表禁用并提示官方账号不可用", () => {
  const card = renderCard();
  const draft = card.switchTo(card.render(savedManualWithoutKey(null)), "官方账号");
  const tree = card.render(draft);
  assert.equal(elementProps(card.fetchButton(tree)).disabled, true);
  assert.match(card.text(tree), /官方账号登录不可用/);
});
