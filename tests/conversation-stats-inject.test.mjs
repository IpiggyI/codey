import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(
  new URL("../public/conversation-stats-inject.js", import.meta.url),
  "utf8",
);
const quotaUnlockSource = readFileSync(
  new URL("../public/quota-unlock.js", import.meta.url),
  "utf8",
);

const flushTimers = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeElement extends FakeElementCore {
  constructor(tagName = "div", { visible = true } = {}) {
    super(tagName);
    this.visible = visible;
  }

  matches(selector) {
    if (selector === ":popover-open") {
      if (typeof this.showPopover !== "function") throw new SyntaxError("Unsupported popover selector");
      return this.popoverOpen === true;
    }
    const match = selector.match(/^(\w+)?\.([\w-]+)$/);
    if (match) return (!match[1] || this.tagName === match[1].toUpperCase())
      && String(this.className || "").split(/\s+/).includes(match[2]);
    return super.matches(selector);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  getClientRects() {
    return this.visible ? [{ bottom: 10, left: 0, right: 10, top: 0 }] : [];
  }

  getBoundingClientRect() {
    return this.visible
      ? { bottom: 160, height: 60, left: 0, right: 600, top: 100, width: 600 }
      : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
  }
}

const NOW = Date.UTC(2026, 9, 19, 11, 16, 54);

const createEnvironment = (options = {}) => {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  const scope = new FakeElement("div");
  const anchor = new FakeElement("div", { visible: options.anchorVisible !== false });
  anchor.setAttribute(
    "data-above-composer-conversation-id",
    options.conversationId ?? "conversation-1",
  );
  const textarea = new FakeElement("textarea", {
    visible: options.inputVisible !== false,
  });
  documentElement.appendChild(body);
  body.appendChild(scope);
  if (options.anchor !== false) {
    scope.appendChild(anchor);
    scope.appendChild(textarea);
  }

  const findById = (root, id) => {
    if (root.id === id || root.getAttribute?.("id") === id) return root;
    for (const child of root.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };

  let latestObserver = null;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = false;
      latestObserver = this;
    }

    observe() {
      this.observed = true;
    }

    disconnect() {
      this.observed = false;
    }
  }

  const document = {
    body,
    documentElement,
    visibilityState: "visible",
    activeElement: body,
    createElement: (tagName) => Object.assign(new FakeElement(tagName), { ownerDocument: document }, options.popover ? {
      showPopover() { this.popoverOpen = true; },
      hidePopover() { this.popoverOpen = false; },
    } : {}),
    getElementById: (id) => findById(documentElement, id),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    listeners: new Map(),
    addEventListener: FakeElementCore.prototype.addEventListener,
    removeEventListener: FakeElementCore.prototype.removeEventListener,
    dispatchEvent: FakeElementCore.prototype.dispatchEvent,
  };
  for (const element of [documentElement, body, scope, anchor, textarea]) element.ownerDocument = document;

  const location = {
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
  };

  let nowMs = options.nowMs ?? NOW;
  const RealDate = Date;
  class TestDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }

  const statsBySession = new Map(Object.entries(options.statsBySession ?? {}));
  const calls = [];
  let statsFailures = options.statsFailures ?? 0;
  let settingsResult = {
    currentProviderSnapshot: {
      id: options.providerId ?? "gs",
      usesOfficialAccountAuth: options.settingsOfficial ?? false,
    },
    cacheValidMinutes: options.cacheValidMinutes ?? 30,
  };
  let identityResult = options.accountIdentity ?? {
    status: "ok",
    loggedIn: true,
    accountLabel: "user@example.com",
    accountEmail: "user@example.com",
    providerName: "Relay",
    usesOfficialAccountAuth: false,
  };
  const bridge = async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/session/stats") {
      if (options.request) return options.request(payload.sessionId);
      if (statsFailures > 0) {
        statsFailures -= 1;
        return { status: "failed", message: "读取失败" };
      }
      return {
        status: "ok",
        stats: statsBySession.get(payload.sessionId) ?? null,
      };
    }
    if (path === "/settings/get") return settingsResult;
    if (path === "/account/identity") return identityResult;
    return { status: "ok" };
  };

  const window = {
    __codexSessionDeleteBridge: options.bridgeReady === false ? undefined : bridge,
    innerHeight: 800,
    innerWidth: 1000,
    location,
    listeners: new Map(),
    addEventListener: FakeElementCore.prototype.addEventListener,
    removeEventListener: FakeElementCore.prototype.removeEventListener,
    dispatchEvent: FakeElementCore.prototype.dispatchEvent,
  };
  if (options.loadSessionController) {
    window.__codeyLoadCodexSessionController = options.loadSessionController;
  }

  const testSetTimeout = (callback, delay, ...args) => {
    // 缓存锚点重读间隔为 500 ms；fastRetry 让重读立即发生。
    const timer = setTimeout(callback, options.fastRetry && delay === 500 ? 0 : delay, ...args);
    timer.unref?.();
    return timer;
  };
  const sandbox = {
    Symbol,
    console: { warn: () => {}, error: console.error, log: console.log },
    Date: TestDate,
    document,
    window,
    location,
    URLSearchParams,
    MutationObserver: FakeMutationObserver,
    HTMLElement: FakeElement,
    setTimeout: testSetTimeout,
    clearTimeout,
  };
  if (options.fiberRequestClient) {
    textarea["__reactFiber$test"] = {
      memoizedState: { memoizedState: { requestClient: options.fiberRequestClient }, next: null },
      return: null,
    };
  }
  const context = vm.createContext(sandbox);
  if (options.quotaUnlock) vm.runInContext(quotaUnlockSource, context);
  vm.runInContext(source, context);
  const observer = latestObserver;

  return {
    anchor,
    textarea,
    document,
    scope,
    calls,
    context,
    statsBySession,
    statsCalls: () => calls.filter((call) => call.path === "/session/stats"),
    bar: () => findById(documentElement, "codey-conversation-stats"),
    snapshot: () => context.window.__codeyConversationStats?.snapshot(),
    refresh: () => context.window.__codeyConversationStats.refresh(),
    notify: (message) => context.window.__codeyConversationStats.applyNotification(message),
    setStats: (sessionId, value) => statsBySession.set(sessionId, value),
    setStatsFailures: (count) => { statsFailures = count; },
    setIdentity: (next) => { identityResult = next; },
    setSettings: (patch) => { Object.assign(settingsResult, patch); },
    now: () => nowMs,
    advanceMs: (ms) => { nowMs += ms; },
    setConversation: (id) => {
      anchor.setAttribute("data-above-composer-conversation-id", id);
    },
    switchConversation: async (id) => {
      anchor.setAttribute("data-above-composer-conversation-id", id);
      observer?.callback?.([
        { type: "attributes", target: anchor, attributeName: "data-above-composer-conversation-id" },
      ]);
      await flushTimers(160);
    },
    emitMutation: (mutations = [{ type: "childList", target: documentElement }]) => {
      if (observer?.observed) observer.callback(mutations);
    },
    emitAnchorMutation: () => {
      observer?.callback?.([
        { type: "attributes", target: anchor, attributeName: "data-above-composer-conversation-id" },
      ]);
    },
    rerun: () => vm.runInContext(source, context),
    dispose: () => context.window.__codeyConversationStats.dispose(),
    markPreviousVersion: () => { context.window.__codeyConversationStats.version = 0; },
    window,
  };
};

const LAST_TURN = {
  id: "turn-1", status: "completed", coverage: "recorded",
  startedAtUnixMs: NOW - 120_000, completedAtUnixMs: NOW - 60_000,
  stepCount: 2, modelDurationMs: 10000, toolDurationMs: 3000,
  averageOutputTokensPerSecond: 187.52, speedIsEstimate: false,
  turnReasoningOutputTokens: 1_400,
};
const LAST_MODEL_REQUEST = {
  requestedAt: NOW - 60_000,
  sessionStartedAt: NOW - 3_600_000,
  threadTotalTokens: 131_500,
  turnReasoningOutputTokens: 1_400,
  compactionCount: 1,
  lastTokenUsage: { inputTokens: 1_000, cachedInputTokens: 996, outputTokens: 400, reasoningOutputTokens: 200 },
  responseWindow: { startedAt: NOW - 70_000, endedAt: NOW - 60_000 },
};
const STATS = {
  lastTurn: LAST_TURN,
  outputTokensPerSecond: 40,
  speedSource: "rollout",
  speedScope: "latest_recorded_request",
  speedRecordedAtUnixMs: NOW - 60_000,
  speedIsEstimate: false,
  inputTokens: 128_400,
  outputTokens: 3_100,
  cachedInputTokens: 120_000,
  cacheWriteInputTokens: null,
  totalTokens: 131_500,
  updatedAtUnixMs: NOW - 60_000,
  usageSource: "rollout",
  usageScope: "session",
  turnCount: 4,
  activitySource: "rollout",
  activityScope: "session",
  lastModelRequest: LAST_MODEL_REQUEST,
};

// 与 STATS.lastModelRequest 对应的用量通知。
const tokenUsageMessage = (threadId = "conversation-1", { last, total, window = 353_400 } = {}) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId,
    tokenUsage: {
      modelContextWindow: window,
      total: {
        inputTokens: 128_400,
        outputTokens: 3_100,
        cachedInputTokens: 120_000,
        totalTokens: 131_500,
        ...total,
      },
      last: {
        inputTokens: 1_000,
        cachedInputTokens: 996,
        outputTokens: 400,
        totalTokens: 36_400,
        ...last,
      },
    },
  },
});

const metric = (bar, name) => name === "status" ? bar.dataset.status : bar.querySelector(`.codey-cs-${name}`).textContent;
const field = (bar, name) => bar.__codeyCs.fields[name].textContent;
const fieldColor = (bar, name) => bar.__codeyCs.fields[name].style.color;
const rowHidden = (bar, name) => bar.__codeyCs.rows[name].hidden === true;
const summary = (env, kind = "activity") => env.bar().__codeyCs.buttons[kind];
const panel = (env, kind = "activity") => env.document.getElementById(`codey-conversation-stats-${kind}`);
const click = (element) => element.dispatchEvent({ type: "click" });
const buttonText = (env, kind) => {
  const parts = [];
  const visit = (node) => {
    if (node.hidden) return;
    // 假 DOM 的 textContent 不含子节点，按顺序拼接自身文字与子节点。
    if (node.textContent) parts.push(node.textContent);
    node.children.forEach(visit);
  };
  visit(summary(env, kind));
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
const assertExpanded = (env, expanded, kind = "activity") => {
  assert.equal(summary(env, kind).getAttribute("aria-expanded"), String(expanded));
  assert.equal(panel(env, kind).hidden, !expanded);
};
// 卡片结构：按显示顺序的行名，不含隐藏行；卡片里没有分节标题。
const cardStructure = (env, kind) => {
  const rows = [];
  for (const child of panel(env, kind).children) {
    assert.notEqual(child.className, "codey-cs-section", `${kind} has no section sub-heading`);
    if (child.tagName === "DL") {
      for (const row of child.children) if (!row.hidden) rows.push(row.children[0].textContent);
    }
  }
  return rows;
};
const localDateTime = (ms) => new Date(ms).toLocaleString("sv-SE");

const observeRenderWork = (env) => {
  const counts = { composerScans: 0, textWrites: 0 };
  const querySelectorAll = env.document.querySelectorAll;
  env.document.querySelectorAll = (selector) => {
    if (selector === "[data-above-composer-conversation-id]") counts.composerScans += 1;
    return querySelectorAll(selector);
  };
  const refs = env.bar().__codeyCs;
  for (const element of [refs.speed, refs["cache-rate"], refs.total, refs.activity,
    ...Object.values(refs.fields), ...Object.values(refs.notes)]) {
    let value = element.textContent;
    Object.defineProperty(element, "textContent", {
      configurable: true,
      get: () => value,
      set: (next) => { counts.textWrites += 1; value = next; },
    });
  }
  return counts;
};

test("refreshes with one composer scan per async phase and only writes changed text", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const counts = observeRenderWork(env);
    const initialCalls = env.statsCalls().length;
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(counts, { composerScans: 2, textWrites: 0 });
    assert.equal(env.statsCalls().length, initialCalls + 1);
    env.setStats("conversation-1", { ...STATS, totalTokens: 500, lastTurn: { ...LAST_TURN, averageOutputTokensPerSecond: 50 } });
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(counts, { composerScans: 4, textWrites: 4 });
    assert.equal(metric(env.bar(), "total"), "500 tok");
    assert.equal(field(env.bar(), "totalTokens"), "500 tok");
    assert.equal(metric(env.bar(), "speed"), "50.0 tok/s");
    assert.equal(field(env.bar(), "turnSpeed"), "50.0 tok/s");
  } finally {
    env.dispose();
  }
});

test("renders three buttons and the agreed cards for a full payload", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    const bar = env.bar();
    assert.equal(bar.parentElement, env.scope);
    assert.equal(bar.querySelectorAll(".codey-cs-summary").length, 3);
    assert.equal(buttonText(env, "activity"), "4 轮 · 2 步 · 188 tok/s");
    assert.equal(buttonText(env, "tokens"), "132k tok · 缓存命中 93%");
    assert.equal(buttonText(env, "session"), "10.3% · 36.4k");
    assert.deepEqual(cardStructure(env, "activity"), [
      "模型用时", "工具调用用时", "最近一次用时", "平均速度（本轮）", "最近一次速度", "本轮推理",
    ]);
    assert.deepEqual(cardStructure(env, "tokens"), [
      "会话缓存命中", "最近一次缓存命中", "未缓存输入", "缓存读取", "输出",
    ]);
    assert.deepEqual(cardStructure(env, "session"), [
      "账号", "开始时间", "上次回复", "缓存剩余时间", "上下文",
      "最近一次 未缓存 / 输出 / 缓存读取", "压缩次数",
    ]);
    for (const key of ["cacheRemaining", "requestTokens"]) {
      assert.equal(panel(env, "session").querySelector(`[data-row="${key}"]`)?.getAttribute("data-row"), key);
      assert.equal(panel(env, "tokens").querySelector(`[data-row="${key}"]`), null, `${key} left the tokens card`);
    }
    for (const kind of ["activity", "tokens", "session"]) {
      assert.equal(panel(env, kind).querySelector("strong").textContent,
        { activity: "最近一轮统计", tokens: "Token 用量", session: "会话" }[kind]);
      const rows = panel(env, kind).querySelectorAll("dt");
      assert.equal(rows.length, { activity: 6, tokens: 5, session: 8 }[kind], kind);
      assert.ok(rows.every((row) => !/TTFT|首 token/i.test(row.textContent)), `${kind} has no TTFT row`);
    }
    assert.equal(field(bar, "modelDuration"), "10秒");
    assert.equal(field(bar, "toolDuration"), "3秒");
    assert.equal(field(bar, "turnSpeed"), "188 tok/s");
    assert.equal(field(bar, "turnReasoning"), "1.4k");
    // 最近一次请求速度 = 400 ÷ 10 秒，与本轮平均速度同时显示。
    assert.equal(field(bar, "requestSpeed"), "40 tok/s");
    assert.equal(field(bar, "requestDuration"), "10.0s");
    assert.equal(field(bar, "totalTokens"), "131,500 tok");
    assert.equal(field(bar, "sessionCacheRate"), "93%");
    assert.equal(field(bar, "uncachedInputTokens"), "8,400 tok");
    assert.equal(field(bar, "cachedInputTokens"), "120,000 tok");
    assert.equal(field(bar, "outputTokens"), "3,100 tok");
    assert.equal(field(bar, "requestCacheRate"), "99.6%");
    assert.equal(field(bar, "requestTokens"), "4 / 400 / 996");
    assert.equal(field(bar, "cacheRemaining"), "29:00");
    assert.equal(field(bar, "account"), "Relay");
    assert.equal(field(bar, "startedAt"), localDateTime(NOW - 3_600_000));
    assert.equal(field(bar, "lastReplyAt"), localDateTime(NOW - 60_000));
    assert.equal(field(bar, "context"), "10.3% (36.4k/353.4k)");
    assert.equal(field(bar, "compactionCount"), "1");
    assert.equal(env.calls.some((call) => call.path === "/session/last-model-request"), false);
    assert.doesNotMatch(bar.__codeyCs.notes.tokens.textContent, /缓存剩余时间/);
    assert.equal(bar.__codeyCs.notes.session.textContent, "");
    assert.doesNotMatch(summary(env, "session").getAttribute("aria-label"), /压缩/);
    assert.match(summary(env, "session").getAttribute("aria-label"), /上下文占用 10\.3% · 36\.4k/);
    assert.equal(bar.__codeyCs.contextSummary.title, "上下文占用");
  } finally {
    env.dispose();
  }
});

test("the bar never shows the cache countdown or the retired composer chip", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
    for (const kind of ["activity", "tokens", "session"]) {
      assert.doesNotMatch(buttonText(env, kind), /\d+:\d\d|剩余/, kind);
    }
    assert.equal(env.bar().contains(env.bar().__codeyCs.fields.cacheRemaining), false);
    assert.equal(env.document.getElementById("codey-thread-usage"), null);
    assert.equal(env.document.getElementById("codey-thread-usage-popover"), null);
  } finally {
    env.dispose();
  }
});

test("a payload with nulls shows — for every value it cannot read", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS,
    inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, turnCount: null,
    lastTurn: { ...LAST_TURN, status: "running", stepCount: null, modelDurationMs: null, toolDurationMs: null,
      averageOutputTokensPerSecond: null, turnReasoningOutputTokens: null },
    lastModelRequest: null,
  } } });
  try {
    await flushTimers(30);
    const bar = env.bar();
    assert.equal(buttonText(env, "activity"), "— 轮 · — 步 · 生成中");
    assert.equal(buttonText(env, "tokens"), "— · 缓存命中 —");
    assert.equal(buttonText(env, "session"), "—");
    assert.match(summary(env, "session").getAttribute("aria-label"), /上下文占用 未知/);
    // 工具仍在运行时后端给 null，显示 —。
    for (const name of ["modelDuration", "toolDuration", "turnReasoning", "requestSpeed", "requestDuration",
      "totalTokens", "sessionCacheRate", "uncachedInputTokens", "cachedInputTokens", "outputTokens",
      "requestCacheRate", "requestTokens", "cacheRemaining", "startedAt", "lastReplyAt", "context", "compactionCount"]) {
      assert.equal(field(bar, name), "—", name);
    }
    assert.equal(field(bar, "turnSpeed"), "生成中");
    assert.equal(rowHidden(bar, "cost"), true);
    assert.doesNotMatch(env.bar().__codeyCs.notes.activity.textContent, /工具调用用时按时间区间合并/);
  } finally {
    env.dispose();
  }
});

test("account row: official auth shows the email, otherwise the provider name, signed out shows 未登录", async () => {
  const cases = [
    [{ usesOfficialAccountAuth: true, loggedIn: true }, "user@example.com"],
    [{ usesOfficialAccountAuth: false, loggedIn: true }, "Relay"],
    [{ usesOfficialAccountAuth: false, loggedIn: false }, "Relay"],
    [{ usesOfficialAccountAuth: true, loggedIn: false, accountEmail: null }, "未登录"],
    [{ usesOfficialAccountAuth: true, loggedIn: true, accountEmail: null }, "—"],
    [{ usesOfficialAccountAuth: false, providerName: null }, "gs"],
    [{ usesOfficialAccountAuth: null, providerName: null }, "gs"],
  ];
  for (const [patch, expected] of cases) {
    const env = createEnvironment({
      statsBySession: { "conversation-1": STATS },
      accountIdentity: {
        status: "ok", loggedIn: true, accountLabel: "user@example.com", accountEmail: "user@example.com",
        providerName: "Relay", usesOfficialAccountAuth: false, ...patch,
      },
    });
    await flushTimers(30);
    assert.equal(field(env.bar(), "account"), expected, JSON.stringify(patch));
    env.dispose();
  }
  const settingsOnly = createEnvironment({ settingsOfficial: true, accountIdentity: { status: "failed", message: "读取失败" } });
  await flushTimers(30);
  assert.equal(field(settingsOnly.bar(), "account"), "—", "unreadable identity must not show a wrong account");
  settingsOnly.dispose();
});

test("account row follows an account switch when the window regains focus", async () => {
  const identity = { status: "ok", loggedIn: true, accountEmail: "user@example.com", providerName: "OpenAI", usesOfficialAccountAuth: true };
  const env = createEnvironment({ accountIdentity: identity });
  try {
    await flushTimers(30);
    assert.equal(field(env.bar(), "account"), "user@example.com");
    env.setIdentity({ ...identity, accountEmail: "other@example.com" });
    env.window.dispatchEvent({ type: "focus" });
    await flushTimers(30);
    assert.equal(field(env.bar(), "account"), "other@example.com");
  } finally {
    env.dispose();
  }
});

test("cost shows only when the usage carries a cost field", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(buttonText(env, "session"), "10.3% · 36.4k");
    assert.equal(rowHidden(env.bar(), "cost"), true);
    assert.equal(cardStructure(env, "session").includes("会话费用估算"), false);
    env.notify(tokenUsageMessage("conversation-1", { total: { totalCostUsd: 1.2834 } }));
    await flushTimers(30);
    assert.equal(buttonText(env, "session"), "≈$1.28 · 10.3% · 36.4k");
    assert.equal(rowHidden(env.bar(), "cost"), false);
    assert.equal(field(env.bar(), "cost"), "$1.283");
    assert.match(summary(env, "session").getAttribute("aria-label"), /费用估算 ≈\$1\.28，上下文占用 10\.3% · 36\.4k/);
    assert.deepEqual(cardStructure(env, "session"), [
      "账号", "开始时间", "上次回复", "缓存剩余时间", "上下文",
      "最近一次 未缓存 / 输出 / 缓存读取", "压缩次数", "会话费用估算",
    ]);
  } finally {
    env.dispose();
  }
});

test("estimated speed carries ≈ during generation and is corrected by the recorded usage", async () => {
  const env = createEnvironment();
  try {
    for (const [changes, expected] of [
      [{ status: "running", speedIsEstimate: true, averageOutputTokensPerSecond: 62.35 }, "≈62.4 tok/s"],
      [{ status: "running", speedIsEstimate: false, averageOutputTokensPerSecond: 65 }, "65.0 tok/s"],
      [{ status: "completed", averageOutputTokensPerSecond: 71.2 }, "71.2 tok/s"],
      [{ status: "running", averageOutputTokensPerSecond: null }, "生成中"],
      [{ status: "completed", averageOutputTokensPerSecond: null }, "—"],
    ]) {
      env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, ...changes } });
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "speed"), expected);
      assert.equal(field(env.bar(), "turnSpeed"), expected);
      // 估算只影响速度显示，会话累计只取记录中的总量。
      assert.equal(field(env.bar(), "totalTokens"), "131,500 tok");
      assert.equal(env.bar().__codeyCs.notes.activity.textContent.includes("含生成中的 Token 估算"), changes.speedIsEstimate === true);
      assert.doesNotMatch(metric(env.bar(), "speed"), /等待输出/);
    }
  } finally {
    env.dispose();
  }
});

test("a session switch clears the previous conversation's numbers at once", async () => {
  const pending = [];
  const env = createEnvironment({ request: (sessionId) => new Promise((resolve) => pending.push({ sessionId, resolve })) });
  try {
    await flushTimers(30);
    pending[0].resolve({ status: "ok", stats: STATS });
    env.notify(tokenUsageMessage("conversation-1", { total: { totalCostUsd: 2 } }));
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(field(env.bar(), "context"), "10.3% (36.4k/353.4k)");
    click(summary(env, "session"));
    await env.switchConversation("conversation-2");
    const bar = env.bar();
    assertExpanded(env, false, "session");
    assert.equal(metric(bar, "total"), "—");
    assert.equal(metric(bar, "activity"), "— 轮 · — 步");
    assert.equal(buttonText(env, "session"), "—");
    for (const name of ["modelDuration", "requestSpeed", "requestCacheRate", "requestTokens", "cacheRemaining",
      "startedAt", "lastReplyAt", "context", "compactionCount", "totalTokens"]) {
      assert.equal(field(bar, name), "—", name);
    }
    assert.equal(rowHidden(bar, "cost"), true);
    assert.doesNotMatch(summary(env, "tokens").getAttribute("aria-label"), /132k/);
    assert.equal(pending.at(-1).sessionId, "conversation-2");
  } finally {
    env.dispose();
  }
});

test("each conversation keeps its own usage and cache anchor", async () => {
  const env = createEnvironment({ statsBySession: {
    "conversation-1": STATS,
    "conversation-2": { ...STATS, totalTokens: 900, lastModelRequest: { ...LAST_MODEL_REQUEST, requestedAt: NOW - 40 * 60_000 } },
  } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage("conversation-1"));
    env.notify(tokenUsageMessage("conversation-2", { window: 100_000 }));
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
    await env.switchConversation("conversation-2");
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "900 tok");
    assert.equal(field(env.bar(), "cacheRemaining"), "已过期");
    assert.equal(field(env.bar(), "context"), "36.4% (36.4k/100k)");
    await env.switchConversation("conversation-1");
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
  } finally {
    env.dispose();
  }
});

test("preview collapses 350 ms after leaving, click pins it", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    summary(env).dispatchEvent({ type: "pointerenter" });
    assertExpanded(env, true);
    summary(env).dispatchEvent({ type: "pointerleave" });
    await flushTimers(300);
    assertExpanded(env, true);
    await flushTimers(80);
    assertExpanded(env, false);
    summary(env).dispatchEvent({ type: "pointerenter" });
    summary(env).dispatchEvent({ type: "pointerleave" });
    panel(env).dispatchEvent({ type: "pointerenter" });
    await flushTimers(380);
    assertExpanded(env, true);
    panel(env).dispatchEvent({ type: "pointerleave" });
    await flushTimers(380);
    assertExpanded(env, false);
    summary(env, "session").dispatchEvent({ type: "focus" });
    assertExpanded(env, true, "session");
    click(summary(env, "session"));
    summary(env, "session").dispatchEvent({ type: "pointerleave" });
    await flushTimers(380);
    assertExpanded(env, true, "session");
  } finally {
    env.dispose();
  }
});

test("pins each independent panel and switches between the three groups", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    assert.equal(summary(env).getAttribute("aria-controls"), panel(env).id);
    click(summary(env));
    assertExpanded(env, true);
    click(summary(env, "tokens"));
    assertExpanded(env, false);
    assertExpanded(env, true, "tokens");
    click(summary(env, "session"));
    assertExpanded(env, false, "tokens");
    assertExpanded(env, true, "session");
    click(summary(env, "session"));
    assertExpanded(env, false, "session");
  } finally {
    env.dispose();
  }
});

test("pointerdown inside details keeps them open, outside closes them", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    click(summary(env, "tokens"));
    assert.equal(panel(env, "tokens").parentElement.parentElement, env.document.body);
    assert.equal(env.bar().contains(panel(env, "tokens")), false, "details must escape the clipping composer");
    env.document.dispatchEvent({ type: "pointerdown", target: panel(env, "tokens").querySelector("dd") });
    assertExpanded(env, true, "tokens");
    env.textarea.focus();
    env.document.dispatchEvent({ type: "pointerdown", target: env.textarea });
    assertExpanded(env, false, "tokens");
    assert.equal(env.document.activeElement, env.textarea);
  } finally {
    env.dispose();
  }
});

test("Escape closes the card and restores focus only when focus was inside the stats bar", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    for (const inside of [true, false]) {
      click(summary(env));
      const target = inside ? summary(env) : env.textarea;
      target.focus();
      let prevented = false;
      let stopped = false;
      env.document.dispatchEvent({
        type: "keydown", key: "Escape",
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
      });
      assertExpanded(env, false);
      assert.equal(env.document.activeElement, inside ? summary(env) : env.textarea);
      assert.equal(prevented, inside);
      assert.equal(stopped, inside);
    }
    click(summary(env, "session"));
    panel(env, "session").focus();
    env.document.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {}, stopPropagation() {} });
    assertExpanded(env, false, "session");
    assert.equal(env.document.activeElement, summary(env, "session"));
  } finally {
    env.dispose();
  }
});

test("cards fade in rising 4 px over 150 ms, and reduced motion turns the animation off", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    const css = env.document.getElementById("codey-conversation-stats-styles").textContent;
    const detailsRule = css.match(/\.codey-cs-details \{[^}]*\}/)[0];
    assert.match(detailsRule, /animation: codey-cs-enter 150ms/);
    assert.match(css, /@keyframes codey-cs-enter \{ from \{ opacity: 0; transform: translateY\(4px\); \}/);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{(.*)\}\s*$/m)?.[1] ?? "";
    assert.match(reduced, /\.codey-cs-details \{ animation: none; \}/);
    // 深色主题沿用 Codex 的文字与背景变量。
    assert.match(css, /--cs-text: var\(--text-primary, CanvasText\)/);
    assert.match(css, /--cs-surface: color-mix\(in srgb, var\(--bg-primary, Canvas\)/);
  } finally {
    env.dispose();
  }
});

test("native popovers switch and close together with their triggers", async () => {
  const env = createEnvironment({ popover: true });
  try {
    await flushTimers(30);
    click(summary(env));
    assert.equal(panel(env).popoverOpen, true);
    click(summary(env, "tokens"));
    assert.equal(panel(env).popoverOpen, false);
    assert.equal(panel(env, "tokens").popoverOpen, true);
    env.document.dispatchEvent({ type: "pointerdown", target: env.textarea });
    assert.equal(panel(env, "tokens").popoverOpen, false);
  } finally {
    env.dispose();
  }
});

test("centers the details immediately above the trigger and clamps the viewport", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    summary(env).getBoundingClientRect = () => ({ left: 200, top: 700, width: 400, height: 28 });
    panel(env).getBoundingClientRect = () => ({ width: 420, height: 300 });
    click(summary(env));
    assert.equal(panel(env).style.left, "190px");
    assert.equal(panel(env).style.top, "392px");
    click(summary(env));
    summary(env).getBoundingClientRect = () => ({ left: 0, top: 700, width: 200, height: 28 });
    click(summary(env));
    assert.equal(panel(env).style.left, "12px");
  } finally {
    env.dispose();
  }
});

test("a replayed usage counts the cache from the recorded request, not its arrival", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, lastModelRequest: { ...LAST_MODEL_REQUEST, requestedAt: NOW - 25 * 60_000 },
  } } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(env.snapshot().cacheAnchor, "ok");
    assert.equal(field(env.bar(), "cacheRemaining"), "5:00");
    assert.equal(fieldColor(env.bar(), "cacheRemaining"), "#ffbf00");
    env.advanceMs(2_000);
    await flushTimers(1_050);
    assert.equal(field(env.bar(), "cacheRemaining"), "4:58", "the countdown ticks in the card");
    env.advanceMs(3 * 60_000);
    env.refresh();
    await flushTimers(30);
    assert.equal(fieldColor(env.bar(), "cacheRemaining"), "#ff3b30");
    env.advanceMs(2 * 60_000);
    env.refresh();
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "已过期");
  } finally {
    env.dispose();
  }
});

test("waits for the session record that matches the live notification", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, lastModelRequest: { ...LAST_MODEL_REQUEST, requestedAt: NOW - 20 * 60_000,
      lastTokenUsage: { ...LAST_MODEL_REQUEST.lastTokenUsage, inputTokens: 900 } },
  } } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    // 记录还停在上一次请求：保留旧锚点，不把通知到达时间当作请求时间。
    assert.equal(field(env.bar(), "cacheRemaining"), "10:00");
    env.setStats("conversation-1", { ...STATS, lastModelRequest: { ...LAST_MODEL_REQUEST, requestedAt: NOW } });
    await flushTimers(600);
    assert.equal(env.snapshot().cacheAnchor, "ok");
    assert.equal(field(env.bar(), "cacheRemaining"), "30:00");
    assert.equal(fieldColor(env.bar(), "cacheRemaining"), "#22c55e");
  } finally {
    env.dispose();
  }
});

test("shows unknown at once, not expired, when the conversation has no session record", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(env.snapshot().cacheAnchor, "unknown:no-rollout");
    assert.equal(field(env.bar(), "cacheRemaining"), "未知");
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(field(env.bar(), "requestSpeed"), "—");
    assert.equal(field(env.bar(), "startedAt"), "—");
  } finally {
    env.dispose();
  }
});

test("shows unknown after six reads when the record never catches up", async () => {
  const env = createEnvironment({ fastRetry: true, statsBySession: { "conversation-1": { ...STATS, lastModelRequest: null } } });
  try {
    await flushTimers(30);
    const before = env.statsCalls().length;
    env.notify(tokenUsageMessage());
    await flushTimers(60);
    assert.equal(env.snapshot().cacheAnchor, "unknown:no-usage");
    assert.equal(env.statsCalls().length - before, 6);
    assert.equal(field(env.bar(), "cacheRemaining"), "未知");
  } finally {
    env.dispose();
  }
});

test("a failed read is retried, so the countdown still resumes", async () => {
  const env = createEnvironment({ fastRetry: true, statsBySession: { "conversation-1": {
    ...STATS, lastModelRequest: { ...LAST_MODEL_REQUEST, requestedAt: NOW - 10 * 60_000 },
  } } });
  try {
    await flushTimers(30);
    env.setStatsFailures(2);
    env.notify(tokenUsageMessage());
    await flushTimers(60);
    assert.equal(env.snapshot().cacheAnchor, "ok");
    assert.equal(field(env.bar(), "cacheRemaining"), "20:00");
  } finally {
    env.dispose();
  }
});

test("shows unknown when every read fails", async () => {
  const env = createEnvironment({ fastRetry: true, statsFailures: 99 });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(60);
    assert.equal(env.snapshot().cacheAnchor, "unknown:failed");
    assert.equal(field(env.bar(), "cacheRemaining"), "未知");
  } finally {
    env.dispose();
  }
});

test("a record already ahead of a stale notification counts from its own time", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, lastModelRequest: { ...LAST_MODEL_REQUEST, threadTotalTokens: 138_500,
      lastTokenUsage: { ...LAST_MODEL_REQUEST.lastTokenUsage, inputTokens: 5_000 } },
  } } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(env.snapshot().cacheAnchor, "ok");
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
  } finally {
    env.dispose();
  }
});

test("recomputes the countdown when the configured cache time changes", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
    env.setSettings({ cacheValidMinutes: 5 });
    env.window.dispatchEvent({ type: "codey:config-changed", detail: { config: { cacheValidMinutes: 5 } } });
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "4:00");
  } finally {
    env.dispose();
  }
});

test("last request speed and duration show plain text without colour tiers", async () => {
  const cases = [
    { output: 600, seconds: 10, speed: "60 tok/s", duration: "10.0s" },
    { output: 599, seconds: 10, speed: "60 tok/s", duration: "10.0s" },
    { output: 450, seconds: 15, speed: "30 tok/s", duration: "15.0s" },
    { output: 299, seconds: 10, speed: "30 tok/s", duration: "10.0s" },
    { output: 397, seconds: 40, speed: "9.9 tok/s", duration: "40.0s" },
    { output: 83, seconds: 83, speed: "1.0 tok/s", duration: "1m 23s" },
  ];
  for (const { output, seconds, speed, duration } of cases) {
    const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS, lastModelRequest: {
      ...LAST_MODEL_REQUEST,
      lastTokenUsage: { ...LAST_MODEL_REQUEST.lastTokenUsage, outputTokens: output },
      responseWindow: { startedAt: NOW - seconds * 1000, endedAt: NOW },
    } } } });
    await flushTimers(30);
    const label = `${output} tokens in ${seconds}s`;
    assert.deepEqual([field(env.bar(), "requestSpeed"), fieldColor(env.bar(), "requestSpeed") || ""], [speed, ""], label);
    assert.deepEqual([field(env.bar(), "requestDuration"), fieldColor(env.bar(), "requestDuration") || ""], [duration, ""], label);
    env.dispose();
  }
});

test("last request speed divides the record's own output, not a newer notification's", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestSpeed"), "40 tok/s");
    // 下一次通知先于其会话记录到达。
    env.notify(tokenUsageMessage("conversation-1", { last: { inputTokens: 71_000, cachedInputTokens: 70_100, outputTokens: 900 } }));
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestSpeed"), "40 tok/s");
    assert.equal(field(env.bar(), "requestTokens"), "900 / 900 / 70.1k");
  } finally {
    env.dispose();
  }
});

const rpcManager = (readUsage = () => null) => {
  const subscriptions = [];
  const reads = [];
  const manager = Object.assign(() => {}, {
    getHostId: async () => "local",
    getConversation: (id) => { reads.push(id); return { latestTokenUsageInfo: readUsage(id) }; },
    addNotificationCallback: () => { throw new Error("Legacy RPC method must not be called"); },
    subscribe: (options) => {
      const entry = { ...options, released: false, requestReleased: false };
      subscriptions.push(entry);
      const lease = {
        [Symbol.dispose]: () => { entry.released = true; },
        onRpcBroken: (callback) => { entry.breakConnection = callback; },
      };
      return Object.assign(Promise.resolve(lease), {
        [Symbol.dispose]: () => { entry.requestReleased = true; },
      });
    },
  });
  return { manager, subscriptions, reads };
};

const withManager = (manager) => async () => ({ kind: "manager", manager });

test("subscribes to the callable RPC manager and releases its lease on dispose", async () => {
  const rpc = rpcManager();
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  await flushTimers(30);
  assert.equal(rpc.subscriptions.length, 1);
  const entry = rpc.subscriptions[0];
  assert.equal(entry.type, "notification");
  assert.equal(entry.key.hostId, "local");
  assert.equal(entry.methods, "thread/tokenUsage/updated");
  entry.listener(tokenUsageMessage());
  assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
  assert.equal(env.snapshot().subscribed, true);
  env.dispose();
  assert.equal(entry.released, true);
  assert.equal(entry.requestReleased, true);
  assert.equal(env.snapshot().subscribed, false);
});

test("reads stored usage on entry and again on re-entry", async () => {
  const rpc = rpcManager((id) => id === "conversation-1" ? tokenUsageMessage().params.tokenUsage : null);
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  try {
    await flushTimers(30);
    assert.equal(field(env.bar(), "context"), "10.3% (36.4k/353.4k)");
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(rpc.reads, ["conversation-1"]);
    await env.switchConversation("conversation-2");
    await flushTimers(30);
    assert.equal(field(env.bar(), "context"), "—");
    await env.switchConversation("conversation-1");
    await flushTimers(30);
    assert.equal(field(env.bar(), "context"), "10.3% (36.4k/353.4k)");
    assert.deepEqual(rpc.reads, ["conversation-1", "conversation-2", "conversation-1"]);
  } finally {
    env.dispose();
  }
});

test("a delayed stored usage read cannot overwrite a newer notification", async () => {
  let resolve;
  const rpc = rpcManager(() => new Promise((done) => { resolve = done; }));
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  try {
    await flushTimers(30);
    rpc.subscriptions[0].listener(tokenUsageMessage("conversation-1", { last: { cachedInputTokens: 500 } }));
    resolve(tokenUsageMessage().params.tokenUsage);
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestCacheRate"), "50%");
  } finally {
    env.dispose();
  }
});

test("a stored usage read finishing after a switch cannot show the previous conversation", async () => {
  let resolve;
  const rpc = rpcManager((id) => id === "conversation-1" ? new Promise((done) => { resolve = done; }) : null);
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  try {
    await flushTimers(30);
    await env.switchConversation("conversation-2");
    resolve(tokenUsageMessage().params.tokenUsage);
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestCacheRate"), "—");
    assert.equal(field(env.bar(), "context"), "—");
  } finally {
    env.dispose();
  }
});

test("re-subscribes after an RPC connection breaks", async () => {
  const rpc = rpcManager();
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  try {
    await flushTimers(30);
    env.window.__codeyCodexSessionController = { kind: "manager", manager: rpc.manager };
    rpc.subscriptions[0].breakConnection();
    assert.equal(env.window.__codeyCodexSessionController, null);
    assert.equal(env.snapshot().subscribed, false);
    assert.equal(rpc.subscriptions[0].released, true);
    await flushTimers(30);
    assert.equal(rpc.subscriptions.length, 2);
    rpc.subscriptions[1].listener(tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(env.snapshot().usageError, null);
  } finally {
    env.dispose();
  }
});

test("releases an RPC lease that arrives after disposal", async () => {
  let resolve;
  let released = false;
  let requestReleased = false;
  const rpc = rpcManager();
  rpc.manager.subscribe = () => Object.assign(new Promise((done) => { resolve = done; }), {
    [Symbol.dispose]: () => { requestReleased = true; },
  });
  const env = createEnvironment({ loadSessionController: withManager(rpc.manager) });
  await flushTimers(30);
  env.dispose();
  resolve({ [Symbol.dispose]: () => { released = true; } });
  await flushTimers(30);
  assert.equal(released, true);
  assert.equal(requestReleased, true);
  assert.equal(env.snapshot().subscribed, false);
});

test("reads existing usage from a legacy manager and binds its method filter", async () => {
  const callbacks = [];
  const env = createEnvironment({ loadSessionController: withManager({
    addNotificationCallback: (methodOrCallback, maybeCallback) => {
      callbacks.push({ methods: typeof methodOrCallback === "function" ? null : methodOrCallback, callback: maybeCallback ?? methodOrCallback });
      return () => {};
    },
    getConversation: () => ({ latestTokenUsageInfo: tokenUsageMessage().params.tokenUsage }),
  }) });
  try {
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(env.snapshot().storedUsageRead, "ok");
    assert.equal(callbacks[0].methods, "thread/tokenUsage/updated");
  } finally {
    env.dispose();
  }
});

test("binds a composer fiber requestClient that appears after the manager subscription", async () => {
  const fiberCallbacks = [];
  const env = createEnvironment({ loadSessionController: withManager({ addNotificationCallback: () => () => {} }) });
  try {
    await flushTimers(30);
    env.textarea["__reactFiber$test"] = {
      memoizedState: { memoizedState: { requestClient: {
        addNotificationCallback: (method, callback) => { fiberCallbacks.push(callback); return () => {}; },
      } }, next: null },
      return: null,
    };
    env.refresh();
    await flushTimers(30);
    assert.equal(fiberCallbacks.length, 1);
    fiberCallbacks[0](tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
  } finally {
    env.dispose();
  }
});

test("retries the usage subscription when the session manager is late", async () => {
  let managerReady = false;
  const callbacks = [];
  const env = createEnvironment({ loadSessionController: async () => (managerReady
    ? { kind: "manager", manager: { addNotificationCallback: (method, callback) => { callbacks.push(callback); return () => {}; } } }
    : { kind: "signals" }) });
  try {
    await flushTimers(30);
    assert.equal(env.snapshot().subscribed, false);
    managerReady = true;
    env.refresh();
    await flushTimers(30);
    assert.equal(env.snapshot().subscribed, true);
    callbacks[0](tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
  } finally {
    env.dispose();
  }
});

test("matches local: ids and snake_case usage fields", async () => {
  const env = createEnvironment({ conversationId: " local:conversation-1 " });
  try {
    await flushTimers(30);
    assert.equal(env.statsCalls()[0].payload.sessionId, "conversation-1");
    env.notify({
      method: "thread/tokenUsage/updated",
      params: {
        thread_id: "local:conversation-1",
        token_usage: {
          model_context_window: 353_400,
          last: { input_tokens: 1_000, cached_input_tokens: 996, total_tokens: 2_000 },
        },
      },
    });
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(field(env.bar(), "context"), "0.6% (2k/353.4k)");
  } finally {
    env.dispose();
  }
});

test("quota unlock keeps the stats bar on real token counts", async () => {
  const env = createEnvironment({ quotaUnlock: true, statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(metric(env.bar(), "total"), "132k tok");
    const raw = JSON.stringify({
      rateLimits: { primary: { used_percent: 100 } },
      primary: { used_percent: 100, window_minutes: 10080 },
    });
    assert.equal(vm.runInContext(`JSON.parse(${JSON.stringify(raw)}).primary.used_percent`, env.context), 3);
    assert.equal(env.window.__codeyNativeJsonParse(raw).primary.used_percent, 100);
  } finally {
    env.dispose();
  }
});

test("remounts into a replacement composer after an in-flight stats response", async () => {
  let resolve;
  const env = createEnvironment({ request: () => new Promise(done => { resolve = done; }) });
  try {
    await flushTimers(30);
    const originalBar = env.bar();
    env.scope.remove();
    const replacement = env.document.createElement("div");
    const anchor = env.document.createElement("div");
    anchor.setAttribute("data-above-composer-conversation-id", "conversation-1");
    replacement.append(anchor, env.document.createElement("textarea"));
    env.document.body.appendChild(replacement);
    resolve({ status: "ok", stats: STATS });
    await flushTimers(30);
    assert.equal(env.bar(), originalBar);
    assert.equal(env.bar().parentElement, replacement);
    assert.equal(metric(env.bar(), "total"), "132k tok");
  } finally {
    env.dispose();
  }
});

test("discards a response after navigation without a mutation notification", async () => {
  const pending = [];
  const env = createEnvironment({ request: sessionId => new Promise(resolve => pending.push({ sessionId, resolve })) });
  try {
    await flushTimers(30);
    env.setConversation("conversation-2");
    pending[0].resolve({ status: "ok", stats: STATS });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "—");
    assert.equal(pending[1].sessionId, "conversation-2");
    pending[1].resolve({ status: "ok", stats: { ...STATS, totalTokens: 700 } });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "700 tok");
  } finally {
    env.dispose();
  }
});

test("discards the original A response after switching A to B to A", async () => {
  const pending = [];
  const env = createEnvironment({ request: (sessionId) => new Promise((resolve) => {
    pending.push({ sessionId, resolve });
  }) });
  try {
    await flushTimers(30);
    click(summary(env));
    await env.switchConversation("conversation-2");
    assertExpanded(env, false);
    await env.switchConversation("conversation-1");
    pending[0].resolve({ status: "ok", stats: STATS });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "—", "old A request must not repopulate A after a round trip");
    assert.equal(pending.length, 2);
    assert.equal(pending[1].sessionId, "conversation-1");
    pending[1].resolve({ status: "ok", stats: { ...STATS, totalTokens: 700 } });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "700 tok");
  } finally {
    env.dispose();
  }
});

test("mounts cached stats when the composer appears after the initial response", async () => {
  const env = createEnvironment({ anchor: false, pathname: "/c/conversation-1", statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    assert.equal(env.bar(), null);
    assert.equal(env.statsCalls().length, 1);
    env.scope.append(env.anchor, env.textarea);
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(env.bar().parentElement, env.scope);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(env.statsCalls().length, 1, "mounting must not refetch the same session");
  } finally {
    env.dispose();
  }
});

test("keeps the bar visible while the current conversation has no stats", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    assert.equal(env.bar()?.hidden, false);
    assert.equal(metric(env.bar(), "status"), "暂无统计");
    assert.equal(metric(env.bar(), "total"), "—");
  } finally {
    env.dispose();
  }
});

test("remounts the bar after Codex rebuilds the composer DOM", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const bar = env.bar();
    bar.remove();
    env.emitMutation([{ type: "childList", target: env.scope, removedNodes: [bar], addedNodes: [] }]);
    await flushTimers(200);
    assert.equal(env.bar().parentElement, env.scope);
    assert.equal(env.bar().hidden, false);
  } finally {
    env.dispose();
  }
});

test("does not fetch in a hidden page and refreshes when visibility returns", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const calls = env.statsCalls().length;
    env.document.visibilityState = "hidden";
    env.refresh();
    await flushTimers(30);
    assert.equal(env.statsCalls().length, calls);
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await flushTimers(30);
    assert.equal(env.statsCalls().length, calls + 1);
  } finally {
    env.dispose();
  }
});

test("shows the turn state from the record status", async () => {
  const env = createEnvironment();
  try {
    for (const [status, label] of [
      ["aborted", "本轮已中止"],
      ["running", "本轮进行中"],
      ["completed", "历史统计"],
    ]) {
      env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, status } });
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "status"), label);
      assert.equal(env.bar().dataset.running, String(status === "running"));
    }
  } finally {
    env.dispose();
  }
});

test("ignores hidden composer anchors and stays empty without a session", async () => {
  const env = createEnvironment({ inputVisible: false });
  try {
    await flushTimers(30);
    assert.equal(env.snapshot().sessionId, "");
  } finally {
    env.dispose();
  }
});

test("does not double-install on repeated injection", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.rerun();
    await flushTimers(30);
    assert.equal(env.scope.children.filter((child) => child.id === "codey-conversation-stats").length, 1);
  } finally {
    env.dispose();
  }
});

test("keeps a waiting bar without a session and does not request stats", async () => {
  const env = createEnvironment({
    conversationId: "", pathname: "/c/previous-conversation",
    statsBySession: { "previous-conversation": STATS },
  });
  try {
    await flushTimers(30);
    assert.equal(metric(env.bar(), "status"), "等待会话");
    assert.equal(metric(env.bar(), "total"), "—");
    assert.equal(env.statsCalls().length, 0);
    click(summary(env));
    assertExpanded(env, true);
  } finally {
    env.dispose();
  }
});

test("preserves reported zero values", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, totalTokens: 0, inputTokens: 100, outputTokens: 0, cachedInputTokens: 0,
    lastTurn: { ...LAST_TURN, stepCount: 0, modelDurationMs: 0, toolDurationMs: 0, averageOutputTokensPerSecond: 0 },
    lastModelRequest: { ...LAST_MODEL_REQUEST, compactionCount: 0 },
  } } });
  try {
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "0 tok");
    assert.equal(field(env.bar(), "outputTokens"), "0 tok");
    assert.equal(metric(env.bar(), "cache-rate"), "0%");
    assert.equal(metric(env.bar(), "speed"), "0.0 tok/s");
    assert.equal(field(env.bar(), "toolDuration"), "0秒");
    assert.equal(field(env.bar(), "compactionCount"), "0");
  } finally {
    env.dispose();
  }
});

test("rejects invalid last turn values and does not borrow another scope", async () => {
  const env = createEnvironment();
  try {
    for (const value of [undefined, null, NaN, Infinity, -5]) {
      env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN,
        averageOutputTokensPerSecond: value, stepCount: value, modelDurationMs: value, toolDurationMs: value } });
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "activity"), "4 轮 · — 步");
      for (const name of ["turnSpeed", "modelDuration", "toolDuration"]) assert.equal(field(env.bar(), name), "—");
    }
    for (const lastTurn of [undefined, null, {}, { ...LAST_TURN, id: " " }]) {
      env.setStats("conversation-1", { ...STATS, lastTurn });
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "activity"), "4 轮 · — 步");
      assert.match(env.bar().__codeyCs.notes.activity.textContent, /暂无可识别的最近一轮/);
    }
  } finally {
    env.dispose();
  }
});

test("explains turn coverage, turn speed and merged tool time", async () => {
  const env = createEnvironment();
  try {
    for (const [coverage, note] of [
      ["recorded", "仅覆盖本轮可恢复且有有效计时的记录"],
      ["partial", "本轮记录不完整，仅统计可恢复的部分"],
      ["unknown", "本轮统计范围未知"],
    ]) {
      env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, coverage } });
      env.refresh();
      await flushTimers(30);
      assert.ok(env.bar().__codeyCs.notes.activity.textContent.includes(note));
    }
    const note = env.bar().__codeyCs.notes.activity.textContent;
    assert.match(note, /一次提问为一轮，步数为该轮的模型请求次数/);
    assert.match(note, /本轮输出 Token ÷ 本轮各次模型请求用时之和/);
    assert.match(note, /工具调用用时按时间区间合并，并行调用不重复计算/);
    assert.doesNotMatch(note, /可能重叠/);
  } finally {
    env.dispose();
  }
});

test("last request tokens show — for unknown items and never derive uncached input from an unknown cache", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage("conversation-1", { last: { inputTokens: 1_000, cachedInputTokens: null, outputTokens: null } }));
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestTokens"), "— / — / —");
    assert.equal(field(env.bar(), "requestCacheRate"), "—");
    env.notify(tokenUsageMessage("conversation-1", { last: { inputTokens: 1_000, cachedInputTokens: 1_200, outputTokens: 0 } }));
    await flushTimers(30);
    assert.equal(field(env.bar(), "requestTokens"), "— / 0 / 1.2k");
  } finally {
    env.dispose();
  }
});

test("replaced composer clients release their subscriptions and keep the shared manager one", async () => {
  const subscriptions = [];
  const client = (name) => ({
    addNotificationCallback: (method, callback) => {
      const entry = { name, callback, released: false };
      subscriptions.push(entry);
      return () => { entry.released = true; };
    },
  });
  const env = createEnvironment({ loadSessionController: withManager(client("manager")) });
  try {
    await flushTimers(30);
    for (let index = 1; index <= 4; index += 1) {
      env.textarea["__reactFiber$test"] = {
        memoizedState: { memoizedState: { requestClient: client(`composer-${index}`) }, next: null },
        return: null,
      };
      env.refresh();
      await flushTimers(30);
    }
    const active = subscriptions.filter((entry) => !entry.released).map((entry) => entry.name);
    assert.deepEqual(active, ["manager", "composer-4"]);
    subscriptions.find((entry) => entry.name === "composer-4").callback(tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
  } finally {
    env.dispose();
  }
  assert.equal(subscriptions.every((entry) => entry.released), true);
});

test("the countdown pauses while the page is hidden and recomputes when it is visible again", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(30);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00");
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    env.advanceMs(2_000);
    await flushTimers(1_100);
    assert.equal(field(env.bar(), "cacheRemaining"), "29:00", "a hidden page must not tick");
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    assert.equal(field(env.bar(), "cacheRemaining"), "28:58");
  } finally {
    env.dispose();
  }
});

const cdpSource = readFileSync(new URL("../backend/src/cdp.rs", import.meta.url), "utf8");
const featureProbe = cdpSource
  .slice(cdpSource.indexOf('"conversation-stats",'))
  .match(/r#"([\s\S]*?)"#\s*\.to_string\(\),\s*Feature,/)[1];

test("the console feature probe reports ready, inactive and not effective", async () => {
  const probe = (env) => vm.runInContext(featureProbe, env.context);
  const noComposer = createEnvironment({ inputVisible: false });
  const noConversation = createEnvironment({ conversationId: "" });
  const unsubscribed = createEnvironment();
  const ready = createEnvironment({ loadSessionController: withManager({ addNotificationCallback: () => () => {} }) });
  try {
    await flushTimers(30);
    assert.deepEqual({ ...probe(noComposer) }, { effective: false, inactive: true, detail: "等待输入栏" });
    assert.deepEqual({ ...probe(noConversation) }, { effective: false, inactive: true, detail: "等待对话建立" });
    assert.deepEqual({ ...probe(unsubscribed) }, { effective: false, detail: "尚未订阅对话用量" });
    assert.equal(probe(ready), "对话用量统计条已就绪");
  } finally {
    for (const env of [noComposer, noConversation, unsubscribed, ready]) env.dispose();
  }
  assert.equal(probe(ready), "", "a disposed script is not reported as installed");
});

test("keeps current totals on failed or thrown refresh and recovers after retry", async () => {
  let response = { status: "ok", stats: STATS };
  const env = createEnvironment({ request: () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  try {
    await flushTimers(30);
    for (const failure of [{ status: "failed" }, new Error("offline")]) {
      response = failure;
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "total"), "132k tok");
      assert.equal(metric(env.bar(), "status"), "统计暂不可用");
      assert.equal(env.bar().hidden, false);
    }
    response = { status: "ok", stats: { ...STATS, totalTokens: 200 } };
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "200 tok");
    assert.equal(metric(env.bar(), "status"), "历史统计");
  } finally {
    env.dispose();
  }
});

test("a thrown read counts toward the cache anchor retries", async () => {
  let fail = true;
  const env = createEnvironment({ fastRetry: true, request: () => {
    if (fail) throw new Error("offline");
    return { status: "ok", stats: STATS };
  } });
  try {
    await flushTimers(30);
    env.notify(tokenUsageMessage());
    await flushTimers(60);
    assert.equal(env.snapshot().cacheAnchor, "unknown:failed");
    fail = false;
    env.refresh();
    await flushTimers(30);
    assert.equal(env.snapshot().cacheAnchor, "ok");
  } finally {
    env.dispose();
  }
});

test("a new user turn clears all prior turn values without clearing session tokens", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    click(summary(env));
    const originalPanel = panel(env);
    env.setStats("conversation-1", { ...STATS, turnCount: 5, lastTurn: { id: "turn-2", status: "running", stepCount: 0,
      averageOutputTokensPerSecond: null, modelDurationMs: null, toolDurationMs: null, coverage: "partial" } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), "生成中");
    assert.equal(metric(env.bar(), "activity"), "5 轮 · 0 步");
    for (const name of ["modelDuration", "toolDuration", "turnReasoning"]) assert.equal(field(env.bar(), name), "—");
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(panel(env), originalPanel);
    assertExpanded(env, true);
  } finally {
    env.dispose();
  }
});

test("session totals own the turn count while the last turn owns speed, steps and timing", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, turnCount: 99, stepCount: 500, modelDurationMs: 900000, toolDurationMs: 800000,
    averageOutputTokensPerSecond: 999, outputTokensPerSecond: 777,
    lastTurn: { ...LAST_TURN, stepCount: 3, averageOutputTokensPerSecond: 20 },
  } } });
  try {
    await flushTimers(30);
    assert.equal(metric(env.bar(), "activity"), "99 轮 · 3 步");
    assert.equal(field(env.bar(), "modelDuration"), "10秒");
    assert.equal(field(env.bar(), "toolDuration"), "3秒");
    assert.equal(metric(env.bar(), "speed"), "20.0 tok/s");
    assert.equal(field(env.bar(), "requestSpeed"), "40 tok/s");
  } finally {
    env.dispose();
  }
});

test("uses only the reported session turn count and preserves zero", async () => {
  const env = createEnvironment();
  try {
    for (const turnCount of [undefined, null, NaN, Infinity, -1, 1.5, "4", 0, 4]) {
      env.setStats("conversation-1", { ...STATS, turnCount });
      env.refresh();
      await flushTimers(30);
      const expected = turnCount === 0 || turnCount === 4 ? String(turnCount) : "—";
      assert.equal(metric(env.bar(), "activity"), `${expected} 轮 · 2 步`);
    }
    env.setStats("conversation-1", { turnCount: 0 });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "activity"), "0 轮 · — 步");
    assert.notEqual(env.bar().dataset.state, "empty");
  } finally {
    env.dispose();
  }
});

test("preserves the same session values while refreshing and marks failed values stale", async () => {
  let resolveRefresh;
  let first = true;
  const env = createEnvironment({ request: () => {
    if (first) { first = false; return { status: "ok", stats: STATS }; }
    return new Promise((resolve) => { resolveRefresh = resolve; });
  } });
  try {
    await flushTimers(30);
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(metric(env.bar(), "status"), "更新统计中");
    resolveRefresh({ status: "failed" });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.match(env.bar().__codeyCs.notes.activity.textContent, /可能已过期/);
  } finally {
    env.dispose();
  }
});

test("binds the manager requestClient once with the method filter and never reads account quota", async () => {
  const kinds = [];
  const callbacks = [];
  const env = createEnvironment({ loadSessionController: withManager({
    addNotificationCallback: () => () => {},
    requestClient: {
      addNotificationCallback: (methodOrCallback, maybeCallback) => {
        kinds.push(typeof methodOrCallback);
        if (typeof methodOrCallback !== "function") callbacks.push(maybeCallback);
        return () => {};
      },
    },
  }) });
  try {
    await flushTimers(30);
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(kinds, ["string"], "a filtered subscribe must not add a catch-all listener");
    callbacks[0](tokenUsageMessage());
    assert.equal(field(env.bar(), "requestCacheRate"), "99.6%");
    assert.equal(env.calls.some((call) => call.path === "/account/usage"), false);
  } finally {
    env.dispose();
  }
});

test("hides a frozen live turn speed after failure and resumes without changing its panel", async () => {
  const live = { ...STATS, lastTurn: { ...LAST_TURN, status: "running", speedIsEstimate: true } };
  let response = { status: "ok", stats: live };
  const env = createEnvironment({ request: () => response });
  try {
    await flushTimers(30);
    click(summary(env));
    const originalPanel = panel(env);
    assert.equal(metric(env.bar(), "speed"), "≈188 tok/s");
    response = { status: "failed" };
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), "更新暂停");
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(metric(env.bar(), "status"), "统计暂不可用");
    response = { status: "ok", stats: { ...live, lastTurn: { ...live.lastTurn, averageOutputTokensPerSecond: 54 } } };
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), "≈54.0 tok/s");
    assert.equal(panel(env), originalPanel);
    assertExpanded(env, true);
  } finally {
    env.dispose();
  }
});

test("does not subtract inconsistent cache", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS, cachedInputTokens: 999999 } } });
  try {
    await flushTimers(30);
    for (const key of ["uncachedInputTokens", "sessionCacheRate"]) assert.equal(field(env.bar(), key), "—");
  } finally {
    env.dispose();
  }
});

test("hiding the composer closes its open details", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    click(summary(env));
    env.textarea.visible = false;
    env.textarea.setAttribute("hidden", "");
    env.emitMutation([{ type: "attributes", target: env.textarea, attributeName: "hidden" }]);
    await flushTimers(160);
    assert.equal(env.bar().hidden, true);
    assertExpanded(env, false);
  } finally {
    env.dispose();
  }
});

test("reuses one detached bar and overlay and closes panels on remount", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const originalBar = env.bar();
    const overlay = panel(env).parentElement;
    click(summary(env));
    originalBar.remove();
    env.emitMutation([{ type: "childList", target: env.scope, removedNodes: [originalBar] }]);
    await flushTimers(160);
    assert.equal(env.bar(), originalBar);
    assert.equal(panel(env).parentElement, overlay);
    assert.equal(env.document.querySelectorAll("#codey-conversation-stats-overlay").length, 1);
    assertExpanded(env, false);
  } finally {
    env.dispose();
  }
});

test("dispose removes portal, listeners and pending response without resurrecting UI", async () => {
  let resolve;
  const env = createEnvironment({ request: () => new Promise(done => { resolve = done; }) });
  await flushTimers(30);
  env.dispose();
  assert.equal(env.bar(), null);
  assert.equal(env.document.getElementById("codey-conversation-stats-overlay"), null);
  assert.equal(env.document.getElementById("codey-conversation-stats-styles"), null);
  assert.ok([...env.document.listeners.values(), ...env.window.listeners.values()].every(list => list.length === 0));
  resolve({ status: "ok", stats: STATS });
  await flushTimers(30);
  assert.equal(env.bar(), null);
  assert.equal(env.statsCalls().length, 1);
});

test("version replacement disposes previous ownership before installing one new portal", async () => {
  const env = createEnvironment();
  try {
    await flushTimers(30);
    const originalBar = env.bar();
    env.markPreviousVersion();
    env.rerun();
    await flushTimers(30);
    assert.notEqual(env.bar(), originalBar);
    assert.equal(env.document.querySelectorAll("#codey-conversation-stats-overlay").length, 1);
    assert.equal(env.document.listeners.get("pointerdown").length, 1);
    click(summary(env));
    assertExpanded(env, true);
  } finally {
    env.dispose();
  }
});
