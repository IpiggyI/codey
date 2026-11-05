import assert from "node:assert/strict";
import test from "node:test";

import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const heroui = autoStubModule("heroui");
const graph = createModuleGraph(new URL("../src/components/ManualModelCombobox.tsx", import.meta.url), {
  stubs: {
    "@heroui/react": heroui,
    "react-aria": { UNSAFE_PortalProvider: heroui.PortalProvider },
    "@tabler/icons-react": autoStubModule("icons"),
  },
});
const HINT = "没有可选模型，可直接输入模型名称";

function render(props) {
  graph.restart();
  return graph.exports.ManualModelCombobox({ ariaLabel: "默认模型", onChange() {}, value: "", ...props });
}
const find = (tree, type) => collectElements(tree, (node) => elementType(node) === type);

test("传入 emptyHint 且没有候选模型时，不挂载下拉层，只在输入框下方提示", () => {
  const tree = render({ options: [], emptyHint: HINT });
  assert.equal(find(tree, heroui.ComboBox.Popover).length, 0, "不弹出空的下拉层");
  // 传入空数组也会让组件允许打开空的下拉层，所以无候选时不传 items。
  assert.equal(elementProps(find(tree, heroui.ComboBox)[0]).items, undefined);
  assert.equal(elementProps(find(tree, heroui.ComboBox)[0]).allowsEmptyCollection, false);
  assert.equal(elementProps(find(tree, heroui.ComboBox.Trigger)[0]).className, "hidden");
  assert.ok(textContent(tree).includes(HINT));
  const hint = collectElements(tree, (node) => node.type === "p")[0];
  assert.ok(elementProps(find(tree, heroui.Input)[0])["aria-describedby"].split(" ").includes(elementProps(hint).id));
});

test("传入 emptyHint 且没有候选时仍可输入任意模型名称", () => {
  const typed = [];
  const tree = render({ options: [], emptyHint: HINT, value: "my-model", onChange: (value) => typed.push(value) });
  assert.equal(find(tree, heroui.ComboBox.Popover).length, 0);
  elementProps(find(tree, heroui.ComboBox)[0]).onInputChange("my-model-2");
  assert.deepEqual(typed, ["my-model-2"]);
});

test("不传 emptyHint 时行为不变：空列表仍传 items、挂载下拉层，并保留下拉层内的原有提示（提示词优化卡片依赖它）", () => {
  const tree = render({ options: [] });
  assert.deepEqual(elementProps(find(tree, heroui.ComboBox)[0]).items, []);
  assert.equal(elementProps(find(tree, heroui.ComboBox)[0]).allowsEmptyCollection, true, "空集合时下拉层不会立刻关闭，空状态提示才能显示");
  assert.equal(find(tree, heroui.ComboBox.Popover).length, 1);
  assert.equal(elementProps(find(tree, heroui.ComboBox.Trigger)[0]).className, undefined);
  const listBox = find(tree, heroui.ListBox)[0];
  assert.ok(textContent(elementProps(listBox).renderEmptyState()).includes("暂无模型列表，可输入自定义模型或点击「获取列表」"));
  assert.ok(!textContent(tree).includes(HINT));
  assert.equal(collectElements(tree, (node) => node.type === "p").length, 0, "没有额外的提示段落");
});

test("有候选时挂载下拉层，不显示提示，也不隐藏触发按钮", () => {
  const tree = render({ options: ["a", "b"] });
  assert.equal(find(tree, heroui.ComboBox.Popover).length, 1);
  assert.deepEqual(elementProps(find(tree, heroui.ComboBox)[0]).items.map((item) => item.id), ["a", "b"]);
  assert.equal(elementProps(find(tree, heroui.ComboBox.Trigger)[0]).className, undefined);
  assert.ok(!textContent(tree).includes(HINT));
});

test("autoFocus 交给输入框", () => {
  assert.equal(elementProps(find(render({ options: ["a"], autoFocus: true }), heroui.Input)[0]).autoFocus, true);
  assert.equal(elementProps(find(render({ options: ["a"] }), heroui.Input)[0]).autoFocus, undefined);
});

const MODELS = ["gpt-5", "gpt-5-mini", "provider-fast-coder", "deepseek-chat"];
const items = (tree) => elementProps(find(tree, heroui.ComboBox)[0]).items;
const ids = (tree) => items(tree).map((item) => item.id);

test("已有值且不输入直接打开时显示全部候选，值不会把列表缩成一项", () => {
  graph.reset();
  assert.deepEqual(ids(render({ options: MODELS, value: "provider-fast-coder" })), MODELS);
  // 值与候选不完全一致时，自定义行仍排第一，候选保持完整。
  assert.deepEqual(ids(render({ options: MODELS, value: "gpt-5-x" })), ["gpt-5-x", ...MODELS]);
  // 精确匹配忽略大小写和首尾空白。
  assert.deepEqual(ids(render({ options: MODELS, value: " GPT-5 " })), MODELS);
});

test("用户输入后按输入过滤，下拉层关闭后下一次打开恢复完整列表", () => {
  graph.reset();
  const props = { options: MODELS, value: "gpt-5" };
  const input = () => elementProps(find(render(props), heroui.Input)[0]);
  const combo = () => elementProps(find(render(props), heroui.ComboBox)[0]);
  assert.deepEqual(ids(render(props)), MODELS);
  input().onInput();
  assert.deepEqual(ids(render(props)), ["gpt-5", "gpt-5-mini"]);
  // 没有匹配项时回退为全部候选，自定义行排第一。
  props.value = "zzz";
  assert.deepEqual(ids(render(props)), ["zzz", ...MODELS]);
  props.value = "gpt-5";
  combo().onOpenChange(true);
  assert.deepEqual(ids(render(props)), ["gpt-5", "gpt-5-mini"], "打开事件不清除输入过滤");
  combo().onOpenChange(false);
  assert.deepEqual(ids(render(props)), MODELS);
});

test("没有下拉层时的输入不记为过滤，之后拉到列表首次打开显示全部", () => {
  graph.reset();
  elementProps(find(render({ options: [], emptyHint: HINT, value: "gpt-5" }), heroui.Input)[0]).onInput();
  assert.deepEqual(ids(render({ options: MODELS, emptyHint: HINT, value: "gpt-5" })), MODELS);
});

test("选择候选项或自定义行仍然把值交给 onChange", () => {
  const picked = [];
  const tree = render({ options: MODELS, value: "mine", onChange: (value) => picked.push(value) });
  const select = elementProps(find(tree, heroui.ComboBox)[0]).onSelectionChange;
  select("gpt-5-mini");
  select("mine");
  select(null);
  assert.deepEqual(picked, ["gpt-5-mini", "mine"]);
});

test("清空按钮仍然清空输入框", () => {
  const typed = [];
  const tree = render({ options: MODELS, value: "gpt-5", onChange: (value) => typed.push(value) });
  const clear = collectElements(tree, (node) => node.type === "button")[0];
  elementProps(clear).onClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(typed, [""]);
});

test("没有候选但已有值时，下拉层给出自定义行和不可选的未获取提示；值为空时仍是原有空状态", () => {
  graph.reset();
  const withValue = render({ options: [], value: "my-model" });
  const rows = items(withValue);
  assert.deepEqual(rows.map((item) => [item.id, Boolean(item.custom), Boolean(item.note)]), [
    ["my-model", true, false],
    ["\u0000not-fetched", false, true],
  ]);
  assert.ok(rows[1].label.includes("获取列表"));
  const listBox = find(withValue, heroui.ListBox)[0];
  const note = collectElements(elementProps(listBox).children(rows[1]), (node) => elementType(node) === heroui.ListBox.Item)[0];
  assert.equal(elementProps(note).isDisabled, true, "说明行不可选");
  const custom = collectElements(elementProps(listBox).children(rows[0]), (node) => elementType(node) === heroui.ListBox.Item)[0];
  assert.ok(!elementProps(custom).isDisabled);
  assert.deepEqual(items(render({ options: [], value: "" })), []);
  assert.equal(find(render({ options: [], value: "" }), heroui.ComboBox.Popover).length, 1);
});

test("传入 emptyHint 且没有候选时，已有值也不产生说明行或下拉层", () => {
  const tree = render({ options: [], emptyHint: HINT, value: "my-model" });
  assert.equal(items(tree), undefined);
  assert.equal(find(tree, heroui.ComboBox.Popover).length, 0);
});
