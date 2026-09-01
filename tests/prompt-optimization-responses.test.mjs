import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cardSource = readFileSync(
  new URL("../src/PromptOptimizationCard.tsx", import.meta.url),
  "utf8",
);
const mantineWrapperSource = readFileSync(
  new URL("../src/components/mantine/index.tsx", import.meta.url),
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
  assert.match(
    manualComboboxSource,
    /useCombobox\(/,
  );
  assert.match(
    manualComboboxSource,
    /Combobox\.EventsTarget/,
  );
  assert.match(
    manualComboboxSource,
    /使用自定义模型/,
  );
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
