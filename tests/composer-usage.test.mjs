import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(
  new URL("../public/composer-usage.js", import.meta.url),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeElement extends FakeElementCore {
  constructor(tagName = "div", { visible = true, rect = null } = {}) {
    super(tagName);
    this.visible = visible;
    this.value = "";
    this.innerText = "";
    this.innerHTML = "";
    this.disabled = false;
    this.isContentEditable = false;
    this.readOnly = false;
    this.rect = rect;
    this.hidden = false;
  }

  getBoundingClientRect() {
    if (this.visible && this.rect) return { ...this.rect };
    return this.visible
      ? {
          bottom: 300,
          height: 36,
          left: 100,
          right: 180,
          top: 264,
          width: 80,
        }
      : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = false;
  }

  observe() {
    this.observed = true;
  }

  disconnect() {
    this.observed = false;
  }
}

const walkText = (node) => {
  if (!node) return "";
  const parts = [node.textContent || "", node.innerHTML || ""];
  for (const child of node.children || []) parts.push(walkText(child));
  return parts.join(" ");
};

const createEnvironment = (options = {}) => {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  const scope = new FakeElement("div");
  const anchor = new FakeElement("div");
  anchor.setAttribute(
    "data-above-composer-conversation-id",
    options.conversationId ?? "thread-1",
  );
  const textarea = new FakeElement("textarea", {
    rect: {
      bottom: 320,
      height: 80,
      left: 80,
      right: 900,
      top: 240,
      width: 820,
    },
  });
  const toolbar = new FakeElement("div");
  const accessButton = new FakeElement("button", {
    rect: { bottom: 300, height: 28, left: 120, right: 200, top: 272, width: 80 },
  });
  accessButton.textContent = "完全访问";
  accessButton.setAttribute("aria-label", "完全访问");
  const modelButton = new FakeElement("button", {
    rect: { bottom: 300, height: 28, left: 210, right: 320, top: 272, width: 110 },
  });
  modelButton.textContent = "6 Astra 高";
  modelButton.setAttribute("aria-label", "model");
  const contextWrap = new FakeElement("span");
  const contextRing = new FakeElement("span", {
    rect: { bottom: 296, height: 18, left: 330, right: 348, top: 278, width: 18 },
  });
  contextRing.setAttribute("role", "img");
  contextRing.setAttribute("aria-label", "上下文 10%");
  contextWrap.appendChild(contextRing);
  toolbar.appendChild(accessButton);
  toolbar.appendChild(modelButton);
  toolbar.appendChild(contextWrap);
  scope.appendChild(anchor);
  scope.appendChild(textarea);
  scope.appendChild(toolbar);
  body.appendChild(scope);
  documentElement.appendChild(body);

  const findById = (root, id) => {
    if (!root) return null;
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };

  const queryAll = (selector) => {
    const fromRoot = documentElement.querySelectorAll(selector);
    return fromRoot;
  };

  const todayResetAt = new Date();
  todayResetAt.setHours(23, 45, 0, 0);
  const weekResetAt = new Date(todayResetAt);
  weekResetAt.setDate(weekResetAt.getDate() + 6);

  let accountUsageResult = options.accountUsage ?? {
    status: "ok",
    planType: "pro",
    accountLabel: options.accountLabel ?? "user@example.com",
    fetchedAt: Math.floor(Date.now() / 1000),
    primary: {
      usedPercent: 15,
      windowMinutes: 300,
      resetsAt: Math.floor(todayResetAt.getTime() / 1000),
    },
    secondary: {
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: Math.floor(weekResetAt.getTime() / 1000),
    },
    credits: { hasCredits: true, unlimited: false, balance: "42" },
  };
  const appServerUsageResult = {
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: Math.floor(weekResetAt.getTime() / 1000),
      },
      credits: { hasCredits: true, unlimited: false, balance: "77" },
      planType: "plus",
    },
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        primary: { usedPercent: 90, windowDurationMins: 300 },
      },
    },
  };
  const notificationCallbacks = [];
  const calls = [];

  const document = {
    body,
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id) || findById(body, id),
    querySelector: (selector) => queryAll(selector)[0] || null,
    querySelectorAll: queryAll,
    addEventListener() {},
  };

  const windowListeners = new Map();
  const testSetTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  const window = {
    innerHeight: 800,
    innerWidth: 1280,
    __codeyInjectionStatus: {
      "composer-usage": { status: "executed", detail: null, error: null },
    },
    __codeySessionToolsInjectLoaded: true,
    __codeyLoadSessionTools: async () => true,
    __codeyReadAccountRateLimits: async () => appServerUsageResult,
    __codeyLoadCodexSessionController: async () => ({
      kind: "manager",
      manager: {
        addNotificationCallback: (callback) => {
          notificationCallbacks.push(callback);
          return () => {};
        },
      },
    }),
    addEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent() {
      return true;
    },
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    setTimeout: testSetTimeout,
    clearTimeout,
  };

  const sandbox = {
    document,
    window,
    MutationObserver: FakeMutationObserver,
    setTimeout: testSetTimeout,
    clearTimeout,
    HTMLElement: FakeElement,
  };
  sandbox.window.__codexSessionDeleteBridge = async (path) => {
    calls.push(path);
    if (path === "/settings/get") {
      return {
        currentProviderSnapshot: { id: options.providerId ?? "gs" },
      };
    }
    if (path === "/account/usage") return accountUsageResult;
    return {};
  };
  vm.runInContext(source, vm.createContext(sandbox));

  return {
    accessButton,
    accountUsageResult,
    appServerUsageResult,
    body,
    calls,
    contextWrap,
    modelButton,
    notificationCallbacks,
    toolbar,
    getElementById: (id) => findById(documentElement, id) || findById(body, id),
    setAccountUsage: (next) => {
      accountUsageResult = next;
    },
    emitNotification: (message) => {
      sandbox.window.__codeyComposerUsage.applyNotification(message);
    },
    snapshot: () => sandbox.window.__codeyComposerUsage.snapshot(),
    refreshCredits: () => sandbox.window.__codeyComposerUsage.refreshCredits(),
    window: sandbox.window,
  };
};

const tokenUsageMessage = (threadId = "thread-1") => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId,
    tokenUsage: {
      modelContextWindow: 353_400,
      total: {
        inputTokens: 35_500_000,
        outputTokens: 84_000,
        cachedInputTokens: 33_400_000,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 8_900,
        totalTokens: 35_600_000,
      },
      last: {
        inputTokens: 1_000,
        cachedInputTokens: 996,
        totalTokens: 2_000,
      },
    },
  },
});

test("hides the usage chip until a matching thread token event arrives", async () => {
  const env = createEnvironment();
  await flush();
  await env.refreshCredits();

  const usage = env.getElementById("codey-thread-usage");
  const credits = env.getElementById("codey-account-credits");
  assert.ok(usage);
  assert.ok(credits);
  assert.equal(usage.style.display, "none");
  assert.equal(credits.style.display, "inline-flex");
  assert.equal(credits.parentElement, env.toolbar);
  assert.equal(credits.nextElementSibling, env.accessButton);
  assert.match(env.snapshot().creditsLabel, /85%/);

  env.emitNotification(tokenUsageMessage("other-thread"));
  assert.equal(usage.style.display, "none");

  env.emitNotification(tokenUsageMessage());
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(usage.textContent, "CH 99.6%");
  assert.equal(usage.parentElement, env.toolbar);
  assert.equal(usage.nextElementSibling, env.contextWrap);
});

test("usage popover lists screenshot fields and skips invented cost", async () => {
  const env = createEnvironment();
  await flush();
  env.emitNotification(tokenUsageMessage());
  const popover = env.getElementById("codey-thread-usage-popover");
  assert.match(popover.innerHTML, /用量/);
  assert.match(popover.innerHTML, /账号/);
  assert.match(popover.innerHTML, /user@example.com/);
  assert.match(popover.innerHTML, /上下文/);
  assert.match(popover.innerHTML, /最近缓存命中率/);
  assert.match(popover.innerHTML, /CH 99\.6%/);
  assert.match(popover.innerHTML, /缓存读取/);
  assert.match(popover.innerHTML, /缓存写入/);
  assert.match(popover.innerHTML, /推理/);
  assert.match(popover.innerHTML, /Token 总数/);
  assert.match(popover.innerHTML, /输入 \/ 输出/);
  assert.doesNotMatch(popover.innerHTML, /会话费用估算/);
  assert.doesNotMatch(popover.innerHTML, /已记录消耗/);
  assert.doesNotMatch(popover.innerHTML, /输出速度/);
});

test("credits chip prefers the 5-hour window and keeps the 7-day tile", async () => {
  const env = createEnvironment();
  await flush();
  await env.refreshCredits();

  const credits = env.getElementById("codey-account-credits");
  const popover = env.getElementById("codey-account-credits-popover");
  assert.equal(credits.style.display, "inline-flex");
  assert.match(credits.getAttribute("aria-label"), /5 小时额度剩余 85%/);
  assert.match(popover.innerHTML, /5 小时额度/);
  assert.match(popover.innerHTML, /7 天额度/);
  assert.doesNotMatch(popover.innerHTML, /周额度/);
  assert.doesNotMatch(popover.innerHTML, /更新于/);
  assert.match(popover.innerHTML, /Pro 20x/);
  assert.match(popover.innerHTML, /Credits 余额/);
  assert.match(popover.innerHTML, /42/);
  assert.match(walkText(popover), /剩余/);
});

test("falls back to the generic app-server rate limit when /account/usage errors", async () => {
  const env = createEnvironment({
    accountUsage: { status: "error", message: "官方额度接口返回 401" },
  });
  await flush();
  await env.refreshCredits();
  const credits = env.getElementById("codey-account-credits");
  const popover = env.getElementById("codey-account-credits-popover");
  assert.equal(credits.style.display, "inline-flex");
  assert.match(popover.innerHTML, /7 天额度/);
  assert.doesNotMatch(popover.innerHTML, /5 小时额度/);
  assert.match(popover.innerHTML, /Plus/);
  assert.match(popover.innerHTML, /77/);
});

test("hides credits when ChatGPT login is unavailable", async () => {
  const env = createEnvironment({
    accountUsage: { status: "unavailable", reason: "chatgpt_login_missing" },
    accountLabel: "",
  });
  await flush();
  await env.refreshCredits();
  const credits = env.getElementById("codey-account-credits");
  assert.equal(credits.style.display, "none");
  env.emitNotification(tokenUsageMessage());
  const popover = env.getElementById("codey-thread-usage-popover");
  assert.match(popover.innerHTML, />gs</);
});

test("hover opens the credits popover", async () => {
  const env = createEnvironment();
  await flush();
  await env.refreshCredits();
  const credits = env.getElementById("codey-account-credits");
  const popover = env.getElementById("codey-account-credits-popover");
  assert.equal(popover.hidden, true);
  credits.dispatchEvent({ type: "pointerenter" });
  assert.equal(popover.hidden, false);
  assert.equal(credits.getAttribute("aria-expanded"), "true");
});
