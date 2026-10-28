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
