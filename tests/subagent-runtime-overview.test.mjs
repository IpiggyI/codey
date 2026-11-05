import assert from "node:assert/strict";
import test from "node:test";

import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const heroui = autoStubModule("heroui");
const ui = autoStubModule("ui");

const policyGraph = createModuleGraph(new URL("../src/FeaturePolicyCard.tsx", import.meta.url), {
  stubs: {
    "@heroui/react": heroui,
    "./components/ui": ui,
    "@tabler/icons-react": autoStubModule("icons"),
    "react-aria": { UNSAFE_PortalProvider: heroui.PortalProvider },
  },
});
const overviewGraph = createModuleGraph(new URL("../src/components/SubagentRuntimeOverview.tsx", import.meta.url), {
  stubs: { "./ui": ui, "@tabler/icons-react": autoStubModule("icons") },
});

const find = (tree, type) => collectElements(tree, (node) => elementType(node) === type);
const byTag = (tree, tag) => collectElements(tree, (node) => node.type === tag);

function renderFeaturePolicy(config, onConfigChange = () => {}) {
  policyGraph.restart();
  return policyGraph.exports.FeaturePolicyCard({
    config,
    fastContextToolsStatus: { userConfigured: false, detectionFailed: false },
    isMacClient: false,
    isWindowsClient: true,
    popupContainer: null,
    tooltipContainer: null,
    isBusy: false,
    onConfigChange,
  });
}
const scopeGuardSwitch = (tree) =>
  find(tree, ui.Switch).filter((node) => elementProps(node)["aria-label"] === "防御性编程控制");

test("防御性编程控制开关绑定 scopeGuard，并以整份配置保存", () => {
  const saved = [];
  const config = { scopeGuard: false, slimCodexPet: false, gpuLaunchMode: "off", codexLaunchProxy: "" };
  const switches = scopeGuardSwitch(renderFeaturePolicy(config, (next) => saved.push(next)));
  assert.equal(switches.length, 1);
  const props = elementProps(switches[0]);
  assert.equal(props.checked, false);
  assert.equal(props.disabled, false);
  props.onCheckedChange(true);
  assert.deepEqual(saved, [{ ...config, scopeGuard: true }]);

  const enabledTree = renderFeaturePolicy({ ...config, scopeGuard: true });
  assert.equal(elementProps(scopeGuardSwitch(enabledTree)[0]).checked, true);
  const helpText = textContent(enabledTree);
  for (const phrase of ["新会话", "压缩后的会话", "子代理", "兼容层", "兜底代码", "重复检查", "下次压缩后生效"]) {
    assert.ok(helpText.includes(phrase), phrase);
  }
});

const OVERVIEW = {
  status: "ok",
  platformSupported: true,
  enabled: true,
  scopeGuardEnabled: false,
  concurrency: { readOnly: 4, writable: 1 },
  hooks: [{ event: "SessionStart", purpose: "新会话开始时注入指引" }],
  documents: [
    {
      id: "root-guidance",
      title: "主代理调度指引",
      description: "新会话开始时交给主代理",
      source: "file",
      path: "/home/u/.codey/root-guidance.md",
      format: "markdown",
      content: "# 调度\n- 一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长",
    },
    {
      id: "never-seen-before-id",
      title: "全新的文档",
      description: "id 从未出现过",
      source: "override",
      path: null,
      format: "toml",
      content: "key = \"value\"",
    },
  ],
  rules: {
    source: "builtin",
    path: null,
    items: [{ id: "some-rule", explanation: "子代理必须给出证据", definition: "[[rule]]\nid = \"some-rule\"" }],
  },
};

function renderPanel(state, onRetry = () => {}) {
  overviewGraph.restart();
  return overviewGraph.exports.SubagentRuntimeOverviewPanel({ state, onRetry });
}

test("运行方式按数据通用渲染文档与规则，未见过的 id 也会显示", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  const text = textContent(tree);
  for (const needle of [
    "主代理调度指引", "新会话开始时交给主代理", "文件", "/home/u/.codey/root-guidance.md",
    "全新的文档", "id 从未出现过", "启动参数 -c 传入",
    "子代理必须给出证据", "内置，尚未写入文件",
    "SessionStart", "新会话开始时注入指引", "当前平台支持", "只读角色 4", "可写角色 1",
  ]) {
    assert.ok(text.includes(needle), needle);
  }
  // 文档按收到的顺序排列，每项折叠，展开后是只读的完整内容。
  const details = byTag(tree, "details");
  assert.equal(details.length, 3, "两份文档与一条规则各为一个折叠项");
  assert.deepEqual(
    details.slice(0, 2).map((node) => textContent(byTag(node, "strong")[0])),
    ["主代理调度指引", "全新的文档"],
  );
  const contents = byTag(tree, "pre").map((node) => textContent(node));
  assert.deepEqual(contents, [
    OVERVIEW.documents[0].content,
    OVERVIEW.documents[1].content,
    OVERVIEW.rules.items[0].definition,
  ]);
  assert.ok(byTag(tree, "pre").every((node) => /whitespace-pre\b/.test(node.props.className) && /overflow-auto/.test(node.props.className)));
  assert.equal(collectElements(tree, (node) => ["textarea", "input"].includes(node.type)).length, 0, "没有编辑控件");
});

test("文档来源徽章按 source 区分", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  const [first, second] = byTag(tree, "details").map((node) => find(node, ui.Badge).map((badge) => textContent(badge)));
  assert.deepEqual(first, ["文件", "Markdown"]);
  assert.deepEqual(second, ["启动参数 -c 传入", "TOML"]);
});

test("平台不支持时给出提示", () => {
  const tree = renderPanel({ status: "ready", overview: { ...OVERVIEW, platformSupported: false } });
  assert.ok(textContent(tree).includes("当前平台不支持"));
});

test("读取中显示加载状态，失败显示中文错误并可重试", () => {
  assert.ok(textContent(renderPanel({ status: "loading" })).includes("正在读取运行方式"));
  let retried = 0;
  const tree = renderPanel({ status: "error", message: "后端不可用" }, () => { retried += 1; });
  assert.ok(textContent(tree).includes("读取运行方式失败：后端不可用"));
  const retry = find(tree, ui.Button).find((node) => textContent(node) === "重试");
  elementProps(retry).onPress();
  assert.equal(retried, 1);
});

test("运行方式默认折叠，且位于子代理卡片内", () => {
  overviewGraph.restart();
  const section = overviewGraph.exports.SubagentRuntimeOverviewSection();
  assert.equal(section.type, "details");
  assert.equal(section.props.open, undefined, "默认不展开");
  assert.ok(textContent(section).includes("运行方式"));
  assert.equal(byTag(section, "pre").length, 0, "折叠时不渲染内容");
  policyGraph.restart();
  const card = policyGraph.exports.SubagentPolicyCard({
    config: { subagentOptimization: false, subagentRoles: {} },
    popupContainer: null,
    isBusy: false,
    subagentModelOptions: [],
    onConfigChange() {},
    onSubagentOptimizationChange() {},
  });
  assert.equal(collectElements(card, (node) => typeof node.type === "function" && node.type.name === "SubagentRuntimeOverviewSection").length, 1);
});
