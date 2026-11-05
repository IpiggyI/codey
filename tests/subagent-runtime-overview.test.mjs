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

const ROLE_IDS = ["codey_quick_scan", "codey_deep_research", "codey_visual_analysis", "codey_worker", "codey_visual_worker"];
const ALL_ROLE_IDS = [...ROLE_IDS, "default"];
const roleConfig = (enabled, model = "gpt-test", reasoningEffort = "high") => ({ enabled, model, reasoningEffort });
const SAVED_ROLES = Object.fromEntries(ALL_ROLE_IDS.map((id) => [id, roleConfig(id !== "codey_worker")]));

const item = (overrides) => ({
  destination: null,
  template: null,
  overrides: [],
  events: [],
  content: null,
  ...overrides,
});

const OVERVIEW = {
  status: "ok",
  platformSupported: true,
  saved: { subagentOptimization: true, scopeGuard: false, roles: SAVED_ROLES },
  master: [
    item({
      id: "root-guidance",
      title: "主代理指导",
      description: "追加在已有的主代理指令之后",
      channel: "override",
      template: { path: "/home/u/.codey/codex-constraints/root-instructions.md", exists: true },
      overrides: [{ label: "主代理指令（追加）", key: "developer_instructions", value: null }],
      content: { format: "markdown", text: "# 调度\n- 一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长" },
    }),
    item({
      id: "codex-agent-settings",
      title: "Codex 子代理设置",
      description: "只在本次启动生效",
      channel: "override",
      overrides: [{ label: "每个会话同时运行的子代理上限", key: "agents.max_concurrent_threads_per_session", value: "沿用 Codex 配置；未设置时为 3" }],
    }),
  ],
  roles: ALL_ROLE_IDS.map((id) => ({
    id,
    destination: `/home/u/.codey/codex-constraints/runtime/agents/${id}.toml`,
    template: { path: `/home/u/.codey/codex-constraints/agents/${id}.toml`, exists: id === "codey_worker" },
    overrides: [{ label: "注册角色配置文件", key: `agents.${id}.config_file`, value: `/home/u/.codey/codex-constraints/runtime/agents/${id}.toml` }],
    model: "gpt-test",
    reasoningEffort: "high",
    content: { format: "toml", text: `name = "${id}"` },
    error: id === "codey_visual_worker" ? "解析模板失败" : null,
  })),
  scopeGuard: [
    item({
      id: "scope-guard-root",
      title: "主会话规则",
      description: "钩子把规则交给主代理",
      channel: "hook",
      events: [{ event: "SessionStart", name: "会话开始时", purpose: "注入完整规则" }],
      content: { format: "markdown", text: "# 适度原则" },
    }),
  ],
  gate: {
    items: [
      item({
        id: "gate-hooks",
        title: "门禁钩子",
        description: "按门禁规则放行或拦截",
        channel: "hook",
        events: [{ event: "PreToolUse", name: "调用工具前", purpose: "检查权限和并发上限" }],
      }),
      item({ id: "runtime-policy", title: "子代理身份记录", description: "门禁据此核对身份", channel: "file", destination: "/home/u/.codex/codey-subagent-gate-v3/runtime-subagent-policy.json" }),
    ],
    concurrency: { readOnly: 4, writable: 1 },
    rules: {
      source: "builtin",
      path: null,
      items: [{ id: "some-rule", explanation: "子代理必须给出证据", definition: "{\"id\": \"some-rule\"}" }],
    },
  },
};

const DRAFT = {
  subagentOptimization: true,
  scopeGuard: false,
  subagentModel: "gpt-test",
  subagentReasoningEffort: "high",
  subagentRoles: structuredClone(SAVED_ROLES),
};

// 角色名称取自真实的子代理角色列表，而不是在测试里另写一份。
function overviewSectionProps(config = { ...DRAFT }) {
  policyGraph.restart();
  const card = policyGraph.exports.SubagentPolicyCard({
    config,
    popupContainer: null,
    isBusy: false,
    subagentModelOptions: [],
    onConfigChange() {},
    onSubagentOptimizationChange() {},
  });
  const sections = collectElements(card, (node) => typeof node.type === "function" && node.type.name === "SubagentRuntimeOverviewSection");
  assert.equal(sections.length, 1);
  return sections[0].props;
}

function renderPanel(state, { draft = DRAFT, onRetry = () => {} } = {}) {
  const props = overviewSectionProps(draft);
  overviewGraph.restart();
  return overviewGraph.exports.SubagentRuntimeOverviewPanel({ ...props, state, onRetry });
}

const cards = (tree) => collectElements(tree, (node) => node.type === "div" && /\brounded-md border\b/.test(node.props.className ?? ""));
const cardTitle = (card) => textContent(byTag(card, "strong")[0]);
const cardBadges = (card) => find(card, ui.Badge).map((badge) => textContent(badge));
const roleCard = (tree, name) => cards(tree).filter((card) => cardTitle(card) === name);

test("运行方式按触发条件分为四组，顺序固定", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  assert.deepEqual(byTag(tree, "h3").map(textContent), [
    "「Codey 子代理角色与调度增强」开关",
    "子代理角色",
    "「防御性编程控制」开关",
    "门禁、钩子与并发",
  ]);
  const text = textContent(tree);
  for (const needle of ["内容依据：已保存的设置", "保存并重启 Codex 后生效", "下一次派生子代理起生效", "思考强度：这里显示已保存的值", "「低」"]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.equal(collectElements(tree, (node) => ["textarea", "input", "select"].includes(node.type)).length, 0, "没有编辑控件");
});

test("角色列表里的每个角色恰好一条，名称与角色列表一致，启用与否都在", () => {
  const { roles } = overviewSectionProps();
  assert.deepEqual(roles.map(({ id }) => id), ROLE_IDS);
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  for (const { name } of [...roles, { name: "通用子代理" }]) {
    assert.equal(roleCard(tree, name).length, 1, name);
  }
  const worker = roleCard(tree, "代码实施")[0];
  assert.ok(cardBadges(worker).includes("未启用"));
  assert.ok(textContent(worker).includes("下方是启用后会写入的内容"));
  const quickScan = roleCard(tree, "快速定位")[0];
  assert.ok(cardBadges(quickScan).includes("已启用"));
  assert.ok(!cardBadges(quickScan).includes("未保存"));
  assert.ok(textContent(roleCard(tree, "视觉实施")[0]).includes("无法生成角色配置：解析模板失败"));
});

test("角色条目分开写明写入位置、模板、启动参数和可折叠的内容", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  for (const id of ALL_ROLE_IDS) {
    const plan = OVERVIEW.roles.find((role) => role.id === id);
    const card = cards(tree).find((candidate) => byTag(candidate, "code").some((code) => textContent(code) === id));
    assert.ok(card, id);
    const text = textContent(card);
    assert.ok(text.includes(`写入位置：${plan.destination}`), id);
    assert.ok(text.includes(plan.template.path), id);
    assert.ok(text.includes(plan.template.exists ? "（可编辑）" : "生效后首次启动 Codex 时写到"), id);
    assert.ok(text.includes(`agents.${id}.config_file`), id);
    assert.ok(text.includes("启动时可能按模型目录调整"), id);
    if (plan.content) {
      const details = byTag(card, "details");
      assert.equal(details.length, 1, id);
      assert.equal(textContent(byTag(details[0], "pre")[0]), plan.content.text);
    }
  }
});

test("标题不用内部角色标识，标识只以「角色标识」的次要形式出现", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  for (const title of byTag(tree, "strong").map(textContent)) {
    assert.ok(ALL_ROLE_IDS.every((id) => !title.includes(id)), title);
  }
  const idCodes = byTag(tree, "code").filter((code) => ALL_ROLE_IDS.includes(textContent(code)));
  assert.deepEqual(idCodes.map(textContent).sort(), [...ALL_ROLE_IDS].sort(), "每个角色的标识恰好出现一次");
  const idLabels = collectElements(tree, (node) => node.type === "span" && textContent(node).startsWith("角色标识 "));
  assert.equal(idLabels.length, ALL_ROLE_IDS.length);
  assert.ok(!textContent(tree).includes("根代理"));
});

test("页面草稿与已保存设置不同时标出未保存，且说明内容仍按已保存设置", () => {
  const draft = structuredClone(DRAFT);
  draft.subagentRoles.codey_worker.enabled = true;
  draft.scopeGuard = true;
  const tree = renderPanel({ status: "ready", overview: OVERVIEW }, { draft });
  const text = textContent(tree);
  assert.ok(text.includes("有未保存的修改"));
  assert.ok(text.includes("标有「未保存」的部分，下方内容仍按已保存的设置显示"));
  const worker = roleCard(tree, "代码实施")[0];
  assert.ok(cardBadges(worker).includes("已启用"), "状态取自页面草稿");
  assert.ok(cardBadges(worker).includes("未保存"));
  assert.ok(textContent(worker).includes("下方内容按已保存的设置生成"));
  assert.ok(!cardBadges(roleCard(tree, "快速定位")[0]).includes("未保存"));

  const synced = textContent(renderPanel({ status: "ready", overview: OVERVIEW }));
  assert.ok(!synced.includes("有未保存的修改"));
  assert.ok(synced.includes("与页面当前的设置一致"));
});

test("总开关未开启时，角色条目说明不会写入", () => {
  const draft = { ...structuredClone(DRAFT), subagentOptimization: false };
  const tree = renderPanel({ status: "ready", overview: OVERVIEW }, { draft });
  const quickScan = roleCard(tree, "快速定位")[0];
  assert.ok(cardBadges(quickScan).includes("已启用"), "角色自身状态仍取自草稿");
  assert.ok(cardBadges(quickScan).includes("未生效"));
  assert.ok(textContent(quickScan).includes("未开启，启动时不写入任何角色"));
  const worker = roleCard(tree, "代码实施")[0];
  assert.ok(cardBadges(worker).includes("未启用") && cardBadges(worker).includes("未生效"));
  assert.ok(!cardBadges(roleCard(renderPanel({ status: "ready", overview: OVERVIEW }), "快速定位")[0]).includes("未生效"));
});

test("整个区块的开关只用页面上的名称", () => {
  const text = textContent(renderPanel({ status: "ready", overview: { ...OVERVIEW, platformSupported: false } }));
  for (const stray of ["总开关", "子代理增强", "子代理开关", "根代理", "派发"]) {
    assert.ok(!text.includes(stray), stray);
  }
  assert.ok(text.includes("「Codey 子代理角色与调度增强」"));
});

test("每项写明触发条件和交付方式，门禁区分两种并发上限", () => {
  const tree = renderPanel({ status: "ready", overview: OVERVIEW });
  const byTitle = (title) => cards(tree).find((card) => cardTitle(card) === title);
  const root = byTitle("主代理指导");
  assert.ok(cardBadges(root).includes("启动参数覆盖"));
  assert.ok(textContent(root).includes("触发：开启「Codey 子代理角色与调度增强」"));
  assert.ok(textContent(root).includes("主代理指令（追加）：内容见下方"));
  const scope = byTitle("主会话规则");
  assert.ok(cardBadges(scope).includes("钩子注入"));
  assert.ok(textContent(scope).includes("触发：开启「防御性编程控制」"));
  assert.ok(textContent(scope).includes("会话开始时 SessionStart：注入完整规则"));
  const policy = byTitle("子代理身份记录");
  assert.ok(cardBadges(policy).includes("写入文件"));
  assert.ok(textContent(policy).includes("写入位置：/home/u/.codex/codey-subagent-gate-v3/runtime-subagent-policy.json"));
  const limits = textContent(byTitle("门禁并发上限"));
  assert.ok(limits.includes("最多同时 4 个") && limits.includes("最多同时 1 个"));
  assert.ok(limits.includes("每个会话同时运行的子代理上限"));
  assert.ok(textContent(byTitle("门禁规则")).includes("子代理必须给出证据"));
});

test("平台不支持时给出提示", () => {
  const tree = renderPanel({ status: "ready", overview: { ...OVERVIEW, platformSupported: false } });
  assert.ok(textContent(tree).includes("当前平台不支持"));
});

test("读取中显示加载状态，失败显示中文错误并可重试", () => {
  assert.ok(textContent(renderPanel({ status: "loading" })).includes("正在读取运行方式"));
  let retried = 0;
  const tree = renderPanel({ status: "error", message: "后端不可用" }, { onRetry: () => { retried += 1; } });
  assert.ok(textContent(tree).includes("读取运行方式失败：后端不可用"));
  const retry = find(tree, ui.Button).find((node) => textContent(node) === "重试");
  elementProps(retry).onPress();
  assert.equal(retried, 1);
});

test("运行方式默认折叠，且位于子代理卡片内并拿到草稿设置", () => {
  const props = overviewSectionProps();
  assert.equal(props.draft.subagentOptimization, true);
  assert.equal(props.reasoningEffortLabels.high, "高");
  overviewGraph.restart();
  const section = overviewGraph.exports.SubagentRuntimeOverviewSection(props);
  assert.equal(section.type, "details");
  assert.equal(section.props.open, undefined, "默认不展开");
  assert.ok(textContent(section).includes("运行方式"));
  assert.equal(byTag(section, "pre").length, 0, "折叠时不渲染内容");
});
