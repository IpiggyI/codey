import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(
  new URL("../public/composer-usage.js", import.meta.url),
  "utf8",
);
const quotaUnlockSource = readFileSync(
  new URL("../public/quota-unlock.js", import.meta.url),
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
    rect: { bottom: 300, height: 28, left: 760, right: 880, top: 272, width: 120 },
  });
  const modelLabel = options.modelLabel ?? "6 Astra 高";
  modelButton.textContent = modelLabel;
  modelButton.setAttribute("aria-label", options.modelAriaLabel ?? "model");
  const contextWrap = new FakeElement("span");
  const contextRing = new FakeElement("span", {
    rect: { bottom: 296, height: 18, left: 890, right: 908, top: 278, width: 18 },
  });
  contextRing.setAttribute("role", "img");
  contextRing.setAttribute("aria-label", "上下文 10%");
  contextWrap.appendChild(contextRing);
  const sendButton = new FakeElement("button", {
    rect: { bottom: 300, height: 28, left: 900, right: 928, top: 272, width: 28 },
  });
  sendButton.setAttribute("aria-label", "发送");
  toolbar.appendChild(accessButton);
  toolbar.appendChild(modelButton);
  toolbar.appendChild(sendButton);
  if (!options.omitContext) toolbar.appendChild(contextWrap);
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
  let accountIdentityResult = options.accountIdentity
    ?? { status: "ok", loggedIn: true, accountLabel: "user@example.com" };
  const notificationCallbacks = [];
  const calls = [];
  let nowMs = options.nowMs ?? Date.now();
  const RealDate = Date;
  class TestDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }
  let settingsResult = {
    currentProviderSnapshot: {
      id: options.providerId ?? "gs",
      usesOfficialAccountAuth: options.usesOfficialAccountAuth ?? false,
    },
    cacheValidMinutes: options.cacheValidMinutes ?? 30,
  };

  const documentListeners = new Map();
  const document = {
    body,
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_ns, tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id) || findById(body, id),
    querySelector: (selector) => queryAll(selector)[0] || null,
    querySelectorAll: queryAll,
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      documentListeners.set(type, handlers.filter((candidate) => candidate !== handler));
    },
    dispatchEvent(event) {
      for (const handler of [...(documentListeners.get(event?.type) || [])]) handler(event);
    },
  };

  const windowListeners = new Map();
  const testSetTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay * (options.timeoutScale ?? 1), ...args);
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
    __codeyLoadCodexSessionController: async () => (
      options.loadSessionController
        ? options.loadSessionController()
        : {
          kind: "manager",
          manager: {
            getConversation: () => ({ latestTokenUsageInfo: null }),
            addNotificationCallback: (methodOrCallback, maybeCallback) => {
              const callback = typeof methodOrCallback === "function"
                ? methodOrCallback
                : maybeCallback;
              notificationCallbacks.push({
                methods: typeof methodOrCallback === "function" ? null : methodOrCallback,
                callback,
              });
              return () => {};
            },
          },
        }
    ),
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
    dispatchEvent(event) {
      const handlers = windowListeners.get(event?.type) || [];
      for (const handler of handlers) handler(event);
      return true;
    },
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    setTimeout: testSetTimeout,
    clearTimeout,
  };

  const sandbox = {
    Symbol,
    Date: TestDate,
    document,
    window,
    MutationObserver: FakeMutationObserver,
    setTimeout: testSetTimeout,
    clearTimeout,
    HTMLElement: FakeElement,
  };
  const modelRequests = new Map();
  const rolloutThreads = new Set(options.rolloutThreads || []);
  let lastModelRequestFailures = options.lastModelRequestFailures ?? 0;
  sandbox.window.__codexSessionDeleteBridge = async (path, payload) => {
    calls.push(path);
    if (path === "/settings/get") return settingsResult;
    if (path === "/account/usage") return accountUsageResult;
    if (path === "/account/identity") return accountIdentityResult;
    if (path === "/session/last-model-request") {
      if (lastModelRequestFailures > 0) {
        lastModelRequestFailures -= 1;
        return { status: "failed", message: "读取失败" };
      }
      const request = modelRequests.get(payload?.sessionId);
      if (request) return { status: "ok", found: true, request };
      return {
        status: "ok",
        found: false,
        reason: rolloutThreads.has(payload?.sessionId) ? "no-usage" : "no-rollout",
      };
    }
    return {};
  };
  if (options.fiberRequestClient) {
    textarea["__reactFiber$test"] = {
      memoizedState: {
        memoizedState: { requestClient: options.fiberRequestClient },
        next: null,
      },
      return: null,
    };
  }
  const context = vm.createContext(sandbox);
  if (options.quotaUnlock) vm.runInContext(quotaUnlockSource, context);
  vm.runInContext(source, context);

  return {
    accessButton,
    accountUsageResult,
    appServerUsageResult,
    body,
    calls,
    contextWrap,
    modelButton,
    notificationCallbacks,
    scope,
    textarea,
    setConversationId: (id) => {
      anchor.setAttribute("data-above-composer-conversation-id", id);
      sandbox.window.__codeyComposerUsage.scan();
    },
    toolbar,
    sendButton,
    // Mirrors the rollout's latest token_count for a thread.
    recordModelRequest: (
      threadId = "thread-1",
      message = tokenUsageMessage(threadId),
      at = nowMs,
      details = {},
    ) => {
      const last = message.params.tokenUsage.last || {};
      modelRequests.set(threadId, {
        ...details,
        requestedAt: at,
        lastTokenUsage: {
          inputTokens: last.inputTokens ?? null,
          cachedInputTokens: last.cachedInputTokens ?? null,
          outputTokens: last.outputTokens ?? null,
        },
        threadTotalTokens: message.params.tokenUsage.total?.totalTokens ?? null,
      });
    },
    now: () => nowMs,
    document,
    getElementById: (id) => findById(documentElement, id) || findById(body, id),
    setAccountUsage: (next) => {
      accountUsageResult = next;
    },
    setAccountIdentity: (next) => {
      accountIdentityResult = next;
    },
    focusWindow: () => sandbox.window.dispatchEvent({ type: "focus" }),
    emitNotification: (message) => {
      sandbox.window.__codeyComposerUsage.applyNotification(message);
    },
    advanceMs: (ms) => {
      nowMs += ms;
      sandbox.window.__codeyComposerUsage.scan();
    },
    setSettings: (patch) => {
      Object.assign(settingsResult, patch);
    },
    snapshot: () => sandbox.window.__codeyComposerUsage.snapshot(),
    context,
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

const rpcManager = (readUsage = () => null) => {
  const subscriptions = [];
  const manager = Object.assign(() => {}, {
    getHostId: async () => "local",
    getConversation: (id) => ({ latestTokenUsageInfo: readUsage(id) }),
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
  return { manager, subscriptions };
};

test("subscribes to the callable RPC manager and releases its lease", async () => {
  const rpc = rpcManager();
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  assert.equal(rpc.subscriptions.length, 1);
  const entry = rpc.subscriptions[0];
  assert.equal(entry.type, "notification");
  assert.equal(entry.key.hostId, "local");
  assert.equal(entry.methods, "thread/tokenUsage/updated");
  entry.listener(tokenUsageMessage());
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().subscribed, true);
  env.window.__codeyComposerUsage.dispose();
  assert.equal(entry.released, true);
  assert.equal(entry.requestReleased, true);
  assert.equal(env.snapshot().subscribed, false);
});

test("injection status is effective only after the usage subscription exists", async () => {
  const rpc = rpcManager();
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  const entry = env.window.__codeyInjectionStatus["composer-usage"];
  assert.equal(rpc.subscriptions.length, 1);
  assert.equal(entry.status, "effective");
  assert.equal(entry.detail, "输入栏用量芯片已就绪");
  assert.equal(entry.error, null);
});

test("a manager discovery failure is reported as failed only after it persists", async () => {
  const env = createEnvironment({
    loadSessionController: async () => { throw new Error("当前 Codex 暂不支持会话管理，请稍后重试"); },
  });
  await flush();
  const entry = env.window.__codeyInjectionStatus["composer-usage"];
  assert.equal(env.snapshot().subscribed, false);
  assert.equal(env.snapshot().composerFound, true);
  // Codex may still be hydrating; a startup status read must not log an error.
  assert.equal(entry.status, "executed");
  assert.equal(entry.detail, "正在订阅对话用量（未取得 Codex 会话管理器：当前 Codex 暂不支持会话管理，请稍后重试）");
  assert.equal(entry.error, null);
  env.advanceMs(30_000);
  await flush();
  assert.equal(entry.status, "failed");
  assert.equal(entry.detail, "输入栏用量未订阅");
  assert.equal(entry.error, "未取得 Codex 会话管理器：当前 Codex 暂不支持会话管理，请稍后重试");
});

test("reads history without a new notification and refreshes on thread re-entry", async () => {
  const reads = [];
  const rpc = rpcManager((id) => {
    reads.push(id);
    return id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null;
  });
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.window.__codeyComposerUsage.scan();
  await flush();
  assert.deepEqual(reads, ["thread-1"]);
  env.setConversationId("thread-2");
  await flush();
  assert.equal(env.snapshot().usageVisible, false);
  env.setConversationId("thread-1");
  await flush();
  assert.equal(env.snapshot().usageVisible, true);
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.deepEqual(reads, ["thread-1", "thread-2", "thread-1"]);
  env.setConversationId("");
  await flush();
  assert.equal(env.snapshot().usageVisible, false);
});

test("a replay on thread entry counts from the recorded request, not from its arrival", async () => {
  const rpc = rpcManager((id) => (
    id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null
  ));
  const env = createEnvironment({
    nowMs: Date.UTC(2026, 8, 28, 8, 0, 0),
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  env.recordModelRequest("thread-1", tokenUsageMessage(), env.now() - 25 * 60_000);
  await flush();
  rpc.subscriptions[0].listener(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "ok");
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().cacheTone, "warn");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /5:00/);
  env.window.__codeyComposerUsage.dispose();
});

test("a request older than the TTL shows expired", async () => {
  const env = createEnvironment();
  env.recordModelRequest("thread-1", tokenUsageMessage(), env.now() - 31 * 60_000);
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("waits for the rollout line that matches the live notification", async () => {
  const env = createEnvironment();
  const previous = tokenUsageMessage();
  previous.params.tokenUsage.last.inputTokens = 900;
  env.recordModelRequest("thread-1", previous, env.now() - 20 * 60_000);
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.notEqual(env.snapshot().cacheTone, "ok");
  env.recordModelRequest("thread-1", tokenUsageMessage(), env.now());
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(env.snapshot().cacheAnchor, "ok");
  assert.equal(env.snapshot().cacheTone, "ok");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /30:00|29:59/);
  env.window.__codeyComposerUsage.dispose();
});

test("shows unknown at once, not expired, when the thread has no local rollout", async () => {
  const env = createEnvironment();
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "unknown:no-rollout");
  assert.equal(env.snapshot().cacheRingVisible, false);
  const popover = env.getElementById("codey-thread-usage-popover").innerHTML;
  assert.match(popover, /未知/);
  assert.doesNotMatch(popover, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("shows unknown after retries when the rollout never records usage", async () => {
  const env = createEnvironment({ timeoutScale: 0, rolloutThreads: ["thread-1"] });
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "unknown:no-usage");
  assert.equal(
    env.calls.filter((path) => path === "/session/last-model-request").length,
    6,
  );
  env.window.__codeyComposerUsage.dispose();
});

test("retries a failed rollout read, so a refresh still resumes the countdown", async () => {
  const env = createEnvironment({ timeoutScale: 0, lastModelRequestFailures: 2 });
  env.recordModelRequest("thread-1", tokenUsageMessage(), env.now() - 10 * 60_000);
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "ok");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /20:00|19:59/);
  env.window.__codeyComposerUsage.dispose();
});

test("shows unknown when every rollout read fails", async () => {
  const env = createEnvironment({ timeoutScale: 0, lastModelRequestFailures: 99 });
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "unknown:failed");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /未知/);
  env.window.__codeyComposerUsage.dispose();
});

test("a rollout already ahead of a stale notification counts from its own time", async () => {
  const env = createEnvironment();
  const newer = tokenUsageMessage();
  newer.params.tokenUsage.last.inputTokens = 5_000;
  newer.params.tokenUsage.total.totalTokens += 7_000;
  env.recordModelRequest("thread-1", newer, env.now() - 60_000);
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheAnchor, "ok");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /29:00|28:59/);
  env.window.__codeyComposerUsage.dispose();
});

test("each thread keeps its own recorded request time", async () => {
  const rpc = rpcManager((id) => tokenUsageMessage(id).params.tokenUsage);
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  env.recordModelRequest("thread-1", tokenUsageMessage("thread-1"), env.now() - 60_000);
  env.recordModelRequest("thread-2", tokenUsageMessage("thread-2"), env.now() - 40 * 60_000);
  await flush();
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.setConversationId("thread-2");
  await flush();
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("re-subscribes after an RPC connection breaks", async () => {
  const rpc = rpcManager();
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  env.window.__codeyCodexSessionController = { kind: "manager", manager: rpc.manager };
  rpc.subscriptions[0].breakConnection();
  assert.equal(env.window.__codeyCodexSessionController, null);
  assert.equal(env.snapshot().subscribed, false);
  assert.equal(rpc.subscriptions[0].released, true);
  env.window.__codeyComposerUsage.scan();
  await flush();
  assert.equal(rpc.subscriptions.length, 2);
  rpc.subscriptions[1].listener(tokenUsageMessage());
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().usageError, null);
  env.window.__codeyComposerUsage.dispose();
});

test("releases an RPC lease that arrives after disposal", async () => {
  let resolve;
  let released = false;
  let requestReleased = false;
  const rpc = rpcManager();
  rpc.manager.subscribe = () => Object.assign(new Promise((done) => { resolve = done; }), {
    [Symbol.dispose]: () => { requestReleased = true; },
  });
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  env.window.__codeyComposerUsage.dispose();
  resolve({ [Symbol.dispose]: () => { released = true; } });
  await flush();
  assert.equal(released, true);
  assert.equal(requestReleased, true);
  assert.equal(env.snapshot().subscribed, false);
});

test("a delayed history read cannot overwrite a newer notification", async () => {
  let resolve;
  const rpc = rpcManager(() => new Promise((done) => { resolve = done; }));
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  const update = tokenUsageMessage();
  update.params.tokenUsage.last.cachedInputTokens = 500;
  rpc.subscriptions[0].listener(update);
  resolve(tokenUsageMessage().params.tokenUsage);
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 50%");
});

test("a history read finishing after a switch cannot show the previous thread", async () => {
  let resolve;
  const rpc = rpcManager((id) => id === "thread-1" ? new Promise((done) => { resolve = done; }) : null);
  const env = createEnvironment({ loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }) });
  await flush();
  env.setConversationId("thread-2");
  resolve(tokenUsageMessage().params.tokenUsage);
  await flush();
  assert.equal(env.snapshot().usageVisible, false);
});

test("reads existing usage from a legacy manager", async () => {
  const env = createEnvironment({ loadSessionController: async () => ({
    kind: "manager",
    manager: {
      addNotificationCallback: () => () => {},
      getConversation: () => ({ latestTokenUsageInfo: tokenUsageMessage().params.tokenUsage }),
    },
  }) });
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("hides the usage chip until a matching thread token event arrives", async () => {
  const env = createEnvironment();
  await flush();

  const usage = env.getElementById("codey-thread-usage");
  assert.ok(usage);
  assert.equal(env.getElementById("codey-account-credits"), null);
  assert.equal(usage.style.display, "none");

  env.emitNotification(tokenUsageMessage("other-thread"));
  assert.equal(usage.style.display, "none");

  env.emitNotification(tokenUsageMessage());
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(usage.parentElement, env.toolbar);
  assert.equal(usage.nextElementSibling, env.contextWrap);
});

const popoverRows = (env) => [
  ...env.getElementById("codey-thread-usage-popover").innerHTML.matchAll(
    /<div data-codey-usage-row><span>(.*?)<\/span><span([^>]*)>(.*?)<\/span><\/div>/g,
  ),
].map(([, name, attrs, value]) => ({
  name,
  value,
  color: /color:(#[0-9a-f]+)/.exec(attrs)?.[1] ?? null,
}));

const rowValue = (env, name) => popoverRows(env).find((row) => row.name === name);

// `sv-SE` renders local time as YYYY-MM-DD HH:mm:ss, an independent oracle.
const localDateTime = (ms) => new Date(ms).toLocaleString("sv-SE");

const requestUsageMessage = ({ input = 70_710, cached = 70_100, output = 236 } = {}) => {
  const message = tokenUsageMessage();
  message.params.tokenUsage.modelContextWindow = 475_000;
  message.params.tokenUsage.last = {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
  };
  return message;
};

const showRecordedRequest = async (env, message, details) => {
  env.recordModelRequest("thread-1", message, env.now(), details);
  await flush();
  env.emitNotification(message);
  await flush();
};

test("usage popover lists the agreed rows in order", async () => {
  const env = createEnvironment({ nowMs: Date.UTC(2026, 9, 19, 11, 16, 54) });
  const startedAt = env.now() - 6_000;
  await showRecordedRequest(env, requestUsageMessage(), {
    sessionStartedAt: startedAt,
    responseWindow: { startedAt: env.now() - 6_200, endedAt: env.now() },
    turnReasoningOutputTokens: 14,
    compactionCount: 0,
  });
  assert.deepEqual(popoverRows(env).map(({ name, value }) => [name, value]), [
    ["账号", "gs"],
    ["开始时间", localDateTime(startedAt)],
    ["上次回复", localDateTime(env.now())],
    ["上下文", "14.9% (70.9k/475k)"],
    ["输入/输出/缓存", "610 / 236 / 70.1k"],
    ["最近缓存命中率", "CH 99.1%"],
    ["缓存时间剩余", "30:00"],
    ["压缩次数", "0"],
    ["速度", "38 tok/s"],
    ["耗时", "6.2s"],
    ["本轮推理", "14"],
  ]);
  assert.equal(rowValue(env, "速度").color, "#ffbf00");
  assert.equal(rowValue(env, "耗时").color, "#22c55e");
  env.window.__codeyComposerUsage.dispose();
});

test("speed and duration use the three colour tiers", async () => {
  const cases = [
    { output: 600, seconds: 10, speed: ["60 tok/s", "#22c55e"], duration: ["10.0s", "#22c55e"] },
    { output: 599, seconds: 10, speed: ["60 tok/s", "#ffbf00"], duration: ["10.0s", "#22c55e"] },
    { output: 450, seconds: 15, speed: ["30 tok/s", "#ffbf00"], duration: ["15.0s", "#ffbf00"] },
    { output: 299, seconds: 10, speed: ["30 tok/s", "#ff3b30"], duration: ["10.0s", "#22c55e"] },
    { output: 399, seconds: 39.9, speed: ["10 tok/s", "#ff3b30"], duration: ["39.9s", "#ffbf00"] },
    { output: 397, seconds: 40, speed: ["9.9 tok/s", "#ff3b30"], duration: ["40.0s", "#ff3b30"] },
    { output: 83, seconds: 83, speed: ["1.0 tok/s", "#ff3b30"], duration: ["1m 23s", "#ff3b30"] },
    { output: 3720, seconds: 3720, speed: ["1.0 tok/s", "#ff3b30"], duration: ["1h 2m", "#ff3b30"] },
  ];
  for (const { output, seconds, speed, duration } of cases) {
    const env = createEnvironment();
    await showRecordedRequest(env, requestUsageMessage({ output }), {
      responseWindow: { startedAt: env.now() - seconds * 1000, endedAt: env.now() },
    });
    const label = `${output} tokens in ${seconds}s`;
    const speedRow = rowValue(env, "速度");
    const durationRow = rowValue(env, "耗时");
    assert.deepEqual([speedRow.value, speedRow.color], speed, label);
    assert.deepEqual([durationRow.value, durationRow.color], duration, label);
    env.window.__codeyComposerUsage.dispose();
  }
});

test("rows read from the rollout stay hidden when the thread has no local rollout", async () => {
  const env = createEnvironment();
  await flush();
  env.emitNotification(requestUsageMessage());
  await flush();
  assert.deepEqual(popoverRows(env).map(({ name, value }) => [name, value]), [
    ["账号", "gs"],
    ["上下文", "14.9% (70.9k/475k)"],
    ["输入/输出/缓存", "610 / 236 / 70.1k"],
    ["最近缓存命中率", "CH 99.1%"],
    ["缓存时间剩余", "未知"],
  ]);
  env.window.__codeyComposerUsage.dispose();
});

test("speed, duration and turn reasoning hide when the rollout lacks them", async () => {
  const env = createEnvironment();
  await showRecordedRequest(env, requestUsageMessage(), {
    sessionStartedAt: env.now() - 60_000,
    responseWindow: null,
    turnReasoningOutputTokens: null,
    compactionCount: 3,
  });
  const names = popoverRows(env).map((row) => row.name);
  assert.equal(rowValue(env, "压缩次数").value, "3");
  for (const name of ["速度", "耗时", "本轮推理"]) assert.equal(names.includes(name), false, name);
  env.window.__codeyComposerUsage.dispose();
});

test("speed divides the rollout's own output, not a newer notification's", async () => {
  const env = createEnvironment();
  await showRecordedRequest(env, requestUsageMessage({ output: 400 }), {
    responseWindow: { startedAt: env.now() - 10_000, endedAt: env.now() },
  });
  assert.equal(rowValue(env, "速度").value, "40 tok/s");
  // The next notification arrives before its rollout line is readable.
  env.emitNotification(requestUsageMessage({ input: 71_000, output: 900 }));
  await flush();
  assert.equal(rowValue(env, "速度").value, "40 tok/s");
  assert.equal(rowValue(env, "输入/输出/缓存").value, "900 / 900 / 70.1k");
  env.window.__codeyComposerUsage.dispose();
});

test("account row shows the official account only for providers that sign in with it", async () => {
  const cases = [
    [{ usesOfficialAccountAuth: true }, "user@example.com"],
    [{ usesOfficialAccountAuth: false }, "gs"],
    [{ usesOfficialAccountAuth: true, accountIdentity: { status: "ok", loggedIn: false, accountLabel: null } }, "未登录"],
    [{ usesOfficialAccountAuth: true, accountIdentity: { status: "ok", loggedIn: true, accountLabel: null } }, "gs"],
    [{ usesOfficialAccountAuth: true, accountIdentity: { status: "failed", message: "读取失败" } }, "gs"],
  ];
  for (const [options, expected] of cases) {
    const env = createEnvironment(options);
    await flush();
    env.emitNotification(tokenUsageMessage());
    await flush();
    assert.equal(rowValue(env, "账号").value, expected, JSON.stringify(options));
    env.window.__codeyComposerUsage.dispose();
  }
});

test("account row follows an account switch when the window regains focus", async () => {
  const env = createEnvironment({ usesOfficialAccountAuth: true });
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(rowValue(env, "账号").value, "user@example.com");
  env.setAccountIdentity({ status: "ok", loggedIn: true, accountLabel: "other@example.com" });
  env.focusWindow();
  await flush();
  assert.equal(rowValue(env, "账号").value, "other@example.com");
  env.window.__codeyComposerUsage.dispose();
});

test("usage popover drops the retired rows and skips invented cost", async () => {
  const env = createEnvironment();
  env.recordModelRequest();
  await flush();
  env.emitNotification(tokenUsageMessage());
  await flush();
  const names = popoverRows(env).map((row) => row.name);
  for (const name of ["缓存读取", "缓存写入", "推理", "Token 总数", "输入 / 输出", "输出速度", "缓存剩余", "会话费用估算", "已记录消耗"]) {
    assert.equal(names.includes(name), false, name);
  }
});

test("quota unlock keeps the conversation usage chip on real token counts", async () => {
  const env = createEnvironment({ quotaUnlock: true });
  await flush();
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  const raw = JSON.stringify({
    rateLimits: { primary: { used_percent: 100 } },
    primary: { used_percent: 100, window_minutes: 10080 },
  });
  const literal = JSON.stringify(raw);
  assert.equal(vm.runInContext(`JSON.parse(${literal}).primary.used_percent`, env.context), 3);
  assert.equal(env.window.__codeyNativeJsonParse(raw).primary.used_percent, 100);
});

test("composer chip does not render the account quota control", async () => {
  const env = createEnvironment();
  await flush();
  assert.equal(env.getElementById("codey-account-credits"), null);
  assert.equal(env.getElementById("codey-account-credits-popover"), null);
  assert.equal(env.calls.includes("/account/usage"), false);
  const style = env.getElementById("codey-composer-usage-style");
  assert.match(style.textContent, /background:\s*transparent/);
  assert.match(style.textContent, /\[data-codey-usage-ring\][\s\S]*position:\s*absolute/);
  assert.doesNotMatch(style.textContent, /data-codey-credits-ring/);
});

test("does not register the usage listener as a method after a filtered subscribe succeeds", async () => {
  const methodKinds = [];
  const requestClientCallbacks = [];
  const env = createEnvironment({
    loadSessionController: async () => ({
      kind: "manager",
      manager: {
        addNotificationCallback: () => () => {},
        requestClient: {
          addNotificationCallback: (methodOrCallback, maybeCallback) => {
            methodKinds.push(typeof methodOrCallback);
            if (typeof methodOrCallback === "function") return () => {};
            requestClientCallbacks.push({
              methods: methodOrCallback,
              callback: maybeCallback,
            });
            return () => {};
          },
        },
      },
    }),
  });
  await flush();
  assert.ok(!methodKinds.includes("function"));
  assert.ok(requestClientCallbacks.length >= 1);
  requestClientCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("shows CH from the composer requestClient when the session manager stays silent", async () => {
  const requestClientCallbacks = [];
  const env = createEnvironment({
    loadSessionController: async () => ({
      kind: "manager",
      manager: {
        addNotificationCallback: () => () => {},
        requestClient: {
          addNotificationCallback: (methodOrCallback, maybeCallback) => {
            const callback = typeof methodOrCallback === "function"
              ? methodOrCallback
              : maybeCallback;
            requestClientCallbacks.push({
              methods: typeof methodOrCallback === "function" ? null : methodOrCallback,
              callback,
            });
            return () => {};
          },
        },
      },
    }),
  });
  await flush();
  assert.ok(requestClientCallbacks.length >= 1);
  requestClientCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("shows CH from a composer fiber requestClient when the session manager stays silent", async () => {
  const fiberCallbacks = [];
  const env = createEnvironment({
    loadSessionController: async () => ({
      kind: "manager",
      manager: {
        addNotificationCallback: () => () => {},
      },
    }),
    fiberRequestClient: {
      addNotificationCallback: (methodOrCallback, maybeCallback) => {
        const callback = typeof methodOrCallback === "function"
          ? methodOrCallback
          : maybeCallback;
        fiberCallbacks.push({
          methods: typeof methodOrCallback === "function" ? null : methodOrCallback,
          callback,
        });
        return () => {};
      },
    },
  });
  await flush();
  assert.ok(fiberCallbacks.length >= 1);
  fiberCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("binds a composer fiber requestClient that appears after the session manager subscription", async () => {
  const fiberCallbacks = [];
  const env = createEnvironment({
    loadSessionController: async () => ({
      kind: "manager",
      manager: {
        addNotificationCallback: () => () => {},
      },
    }),
  });
  await flush();
  assert.equal(env.getElementById("codey-thread-usage").style.display, "none");
  env.textarea["__reactFiber$test"] = {
    memoizedState: {
      memoizedState: {
        requestClient: {
          addNotificationCallback: (methodOrCallback, maybeCallback) => {
            const callback = typeof methodOrCallback === "function"
              ? methodOrCallback
              : maybeCallback;
            fiberCallbacks.push({
              methods: typeof methodOrCallback === "function" ? null : methodOrCallback,
              callback,
            });
            return () => {};
          },
        },
      },
      next: null,
    },
    return: null,
  };
  env.window.__codeyComposerUsage.scan();
  await flush();
  assert.ok(fiberCallbacks.length >= 1);
  fiberCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("subscribes to thread/tokenUsage/updated on the session manager", async () => {
  const env = createEnvironment();
  await flush();
  assert.ok(env.notificationCallbacks.length >= 1);
  assert.ok(env.notificationCallbacks.some((entry) => (
    entry.methods === "thread/tokenUsage/updated"
    || JSON.stringify(entry.methods) === JSON.stringify(["thread/tokenUsage/updated"])
  )));
  env.notificationCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("matches a local: composer conversation id to the native thread id", async () => {
  const env = createEnvironment({ conversationId: "local:thread-1" });
  await flush();
  env.emitNotification(tokenUsageMessage("thread-1"));
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("parses snake_case token usage fields into the CH chip", async () => {
  const env = createEnvironment();
  await flush();
  env.emitNotification({
    method: "thread/tokenUsage/updated",
    params: {
      thread_id: "thread-1",
      token_usage: {
        model_context_window: 353_400,
        last: {
          input_tokens: 1_000,
          cached_input_tokens: 996,
          total_tokens: 2_000,
        },
      },
    },
  });
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("retries usage subscription after the session manager is late", async () => {
  let managerReady = false;
  const env = createEnvironment({
    loadSessionController: async () => {
      if (!managerReady) return { kind: "signals" };
      return {
        kind: "manager",
        manager: {
          addNotificationCallback: (methodOrCallback, maybeCallback) => {
            const callback = typeof methodOrCallback === "function"
              ? methodOrCallback
              : maybeCallback;
            env.notificationCallbacks.push({
              methods: typeof methodOrCallback === "function" ? null : methodOrCallback,
              callback,
            });
            return () => {};
          },
        },
      };
    },
  });
  await flush();
  assert.equal(env.notificationCallbacks.length, 0);
  assert.equal(env.snapshot().subscribed, false);
  managerReady = true;
  env.window.__codeyComposerUsage.scan();
  await flush();
  assert.ok(env.notificationCallbacks.length >= 1);
  assert.equal(env.snapshot().subscribed, true);
  env.notificationCallbacks[0].callback(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
});

test("places the usage chip before a model picker that only shows the model name", async () => {
  const env = createEnvironment({
    omitContext: true,
    modelLabel: "Grok 4.6 高",
    modelAriaLabel: "Grok 4.6 高",
  });
  await flush();
  env.emitNotification(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(usage.parentElement, env.toolbar);
  assert.equal(usage.nextElementSibling, env.modelButton);
});

test("places the usage chip before a Luna light model picker", async () => {
  const env = createEnvironment({
    omitContext: true,
    modelLabel: "5.6 Luna 轻度",
    modelAriaLabel: "5.6 Luna 轻度",
  });
  await flush();
  env.emitNotification(tokenUsageMessage());
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(usage.parentElement, env.toolbar);
  assert.equal(usage.nextElementSibling, env.modelButton);
});

test("shows a remaining-time ring after a live usage notification", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().cacheTone, "ok");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /30:00|29:59/);
  const ring = env.getElementById("codey-thread-usage")
    .querySelector("[data-codey-usage-ring]");
  assert.equal(ring.children[0]?.getAttribute?.("viewBox"), "0 0 80 36");
  assert.equal(ring.children[0]?.children[1]?.getAttribute?.("pathLength"), "100");
  env.window.__codeyComposerUsage.dispose();
});

test("does not restart the cache ring when switching conversations", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest("thread-1");
  env.emitNotification(tokenUsageMessage("thread-1"));
  await flush();
  env.advanceMs(120_000);
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /28:00|27:59/);
  env.setConversationId("thread-2");
  await flush();
  assert.equal(env.snapshot().usageVisible, false);
  env.setConversationId("thread-1");
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /28:00|27:59/);
  env.window.__codeyComposerUsage.dispose();
});

test("turns the cache ring yellow then red, and drops it after expiry", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  env.advanceMs(22.5 * 60_000);
  assert.equal(env.snapshot().cacheTone, "warn");
  env.advanceMs(4.5 * 60_000);
  assert.equal(env.snapshot().cacheTone, "hot");
  env.advanceMs(3 * 60_000);
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.equal(env.snapshot().cacheTone, "");
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("keeps the cache ring when the composer model changes without a new turn", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.modelButton.textContent = "Grok 4.6 低";
  env.window.__codeyComposerUsage.scan();
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.doesNotMatch(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("keeps the cache ring when a composer popup item mentions a model", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  const skillItem = new env.modelButton.constructor("button", {
    rect: { bottom: 300, height: 28, left: 80, right: 900, top: 272, width: 820 },
  });
  skillItem.textContent = "Domain Modeling Build and sharpen a domain model";
  env.scope.appendChild(skillItem);
  env.window.__codeyComposerUsage.scan();
  assert.equal(env.snapshot().cacheRingVisible, true);
  skillItem.remove();
  env.window.__codeyComposerUsage.scan();
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.window.__codeyComposerUsage.dispose();
});

test("keeps live cache rings when the provider changes without a new turn", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.window.dispatchEvent(new env.window.CustomEvent("codey:config-changed", {
    detail: {
      config: { cacheValidMinutes: 30 },
      currentProviderSnapshot: { id: "other-provider" },
    },
  }));
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.doesNotMatch(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("recomputes remaining time when the configured TTL changes", async () => {
  const env = createEnvironment();
  await flush();
  env.recordModelRequest();
  env.emitNotification(tokenUsageMessage());
  await flush();
  env.advanceMs(10 * 60_000);
  env.setSettings({ cacheValidMinutes: 10 });
  env.window.dispatchEvent(new env.window.CustomEvent("codey:config-changed", {
    detail: { config: { cacheValidMinutes: 10 } },
  }));
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.setSettings({ cacheValidMinutes: 60 });
  env.window.dispatchEvent(new env.window.CustomEvent("codey:config-changed", {
    detail: { config: { cacheValidMinutes: 60 } },
  }));
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().cacheTone, "ok");
  env.window.__codeyComposerUsage.dispose();
});
