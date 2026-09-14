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
    currentProviderSnapshot: { id: options.providerId ?? "gs" },
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
  sandbox.window.__codexSessionDeleteBridge = async (path) => {
    calls.push(path);
    if (path === "/settings/get") return settingsResult;
    if (path === "/account/usage") return accountUsageResult;
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
    textarea,
    setConversationId: (id) => {
      anchor.setAttribute("data-above-composer-conversation-id", id);
      sandbox.window.__codeyComposerUsage.scan();
    },
    toolbar,
    sendButton,
    submitComposer: (text = "在吗") => {
      textarea.value = text;
      document.dispatchEvent({ type: "keydown", key: "Enter", target: textarea });
      textarea.value = "";
    },
    clickSend: () => {
      document.dispatchEvent({ type: "click", target: sendButton });
    },
    document,
    getElementById: (id) => findById(documentElement, id) || findById(body, id),
    setAccountUsage: (next) => {
      accountUsageResult = next;
    },
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
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
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

test("replaying stored token usage on thread enter does not start the cache ring", async () => {
  const rpc = rpcManager((id) => (
    id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null
  ));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  assert.equal(env.snapshot().cacheRingVisible, false);
  rpc.subscriptions[0].listener(tokenUsageMessage());
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("a notification during history hydration does not start the cache ring", async () => {
  let resolve;
  const rpc = rpcManager(() => new Promise((done) => { resolve = done; }));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  rpc.subscriptions[0].listener(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, false);
  resolve(tokenUsageMessage().params.tokenUsage);
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.window.__codeyComposerUsage.dispose();
});

test("a replay that arrives before history hydration does not start the cache ring", async () => {
  const rpc = rpcManager((id) => (
    id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null
  ));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  env.emitNotification(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("a submitted turn starts the cache ring while the history read is still pending", async () => {
  const rpc = rpcManager(() => new Promise(() => {}));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().cacheTone, "ok");
  assert.equal(env.snapshot().storedUsageRead, "");
  env.window.__codeyComposerUsage.dispose();
});

test("clicking the send button also opens the cache timer", async () => {
  const env = createEnvironment();
  await flush();
  env.clickSend();
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().submittedThreadCount, 1);
  env.window.__codeyComposerUsage.dispose();
});

test("a new conversation with no id yet still starts the cache ring", async () => {
  const env = createEnvironment({ conversationId: "" });
  await flush();
  env.submitComposer();
  assert.equal(env.snapshot().pendingSubmit, true);
  env.setConversationId("thread-9");
  await flush();
  env.emitNotification(tokenUsageMessage("thread-9"));
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().pendingSubmit, false);
  env.window.__codeyComposerUsage.dispose();
});

test("a pending submit is not claimed by a thread this page already showed", async () => {
  const env = createEnvironment();
  await flush();
  env.emitNotification(tokenUsageMessage("thread-1"));
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.textarea.value = "在吗";
  env.document.dispatchEvent({ type: "keydown", key: "Enter", target: env.textarea });
  env.textarea.value = "";
  const update = tokenUsageMessage("thread-1");
  update.params.tokenUsage.last.cachedInputTokens = 400;
  env.emitNotification(update);
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.window.__codeyComposerUsage.dispose();
});

test("an empty composer Enter never opens the cache timer", async () => {
  const env = createEnvironment();
  await flush();
  env.document.dispatchEvent({ type: "keydown", key: "Enter", target: env.textarea });
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.equal(env.snapshot().submittedThreadCount, 0);
  env.window.__codeyComposerUsage.dispose();
});

test("a keystroke that is not a send never opens the cache timer", async () => {
  const env = createEnvironment();
  await flush();
  env.textarea.value = "换行不算发送";
  for (const event of [
    { type: "keydown", key: "Enter", shiftKey: true, target: env.textarea },
    { type: "keydown", key: "Enter", isComposing: true, target: env.textarea },
    { type: "keydown", key: "a", target: env.textarea },
    { type: "keydown", key: "Enter", target: env.toolbar },
  ]) env.document.dispatchEvent(event);
  env.textarea.value = "";
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.equal(env.snapshot().submittedThreadCount, 0);
  assert.equal(env.snapshot().pendingSubmit, false);
  env.window.__codeyComposerUsage.dispose();
});

test("entering a thread whose history read comes back empty does not start the cache ring", async () => {
  const rpc = rpcManager(() => null);
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  rpc.subscriptions[0].listener(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.window.__codeyComposerUsage.dispose();
});

test("two differing replays on thread enter do not start the cache ring", async () => {
  const rpc = rpcManager((id) => (
    id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null
  ));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  const partial = tokenUsageMessage();
  delete partial.params.tokenUsage.last;
  rpc.subscriptions[0].listener(partial);
  rpc.subscriptions[0].listener(tokenUsageMessage());
  await flush();
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
  assert.equal(env.snapshot().cacheRingVisible, false);
  env.window.__codeyComposerUsage.dispose();
});

test("a later token usage change after hydration starts the cache ring", async () => {
  const rpc = rpcManager((id) => (
    id === "thread-1" ? tokenUsageMessage().params.tokenUsage : null
  ));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  env.submitComposer();
  const update = tokenUsageMessage();
  update.params.tokenUsage.last.cachedInputTokens = 500;
  rpc.subscriptions[0].listener(update);
  assert.equal(env.snapshot().usageLabel, "CH 50%");
  assert.equal(env.snapshot().cacheRingVisible, true);
  assert.equal(env.snapshot().storedUsageRead, "ok");
  env.window.__codeyComposerUsage.dispose();
});

test("switching to another thread with stored usage does not start a cache ring", async () => {
  const usageFor = (id) => {
    const message = tokenUsageMessage(id);
    if (id === "thread-2") message.params.tokenUsage.last.cachedInputTokens = 400;
    return message.params.tokenUsage;
  };
  const rpc = rpcManager((id) => usageFor(id));
  const env = createEnvironment({
    loadSessionController: async () => ({ kind: "manager", manager: rpc.manager }),
  });
  await flush();
  env.submitComposer();
  const live = tokenUsageMessage("thread-1");
  live.params.tokenUsage.last.cachedInputTokens = 500;
  rpc.subscriptions[0].listener(live);
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.setConversationId("thread-2");
  await flush();
  rpc.subscriptions[0].listener({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-2", tokenUsage: usageFor("thread-2") },
  });
  assert.equal(env.snapshot().usageLabel, "CH 40%");
  assert.equal(env.snapshot().cacheRingVisible, false);
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
  assert.equal(env.snapshot().usageLabel, "CH 99.6%");
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
  assert.match(popover.innerHTML, /缓存剩余/);
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
  assert.match(credits.getAttribute("aria-label"), /5 小时额度 85%/);
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

test("credits chip stays transparent until hover and uses an svg ring", async () => {
  const env = createEnvironment();
  await flush();
  await env.refreshCredits();
  const style = env.getElementById("codey-composer-usage-style");
  assert.match(style.textContent, /background:\s*transparent/);
  assert.match(style.textContent, /rgba\(127, 127, 127, 0\.08\)/);
  assert.doesNotMatch(style.textContent, /conic-gradient/);
  assert.match(style.textContent, /\[data-codey-usage-ring\][\s\S]*position:\s*absolute/);
  assert.match(style.textContent, /\[data-codey-credits-ring\][\s\S]*position:\s*absolute/);
  const credits = env.getElementById("codey-account-credits");
  const ring = credits.querySelector("[data-codey-credits-ring]");
  const svg = ring?.children[0];
  assert.equal(svg?.tagName, "SVG");
  // The capsule is measured in chip pixels, so nothing is stretched.
  assert.equal(svg?.getAttribute?.("preserveAspectRatio"), null);
  assert.equal(svg?.getAttribute?.("viewBox"), "0 0 80 36");
  assert.equal(svg?.children.length, 2);
  const arc = svg?.children[1];
  assert.match(arc?.getAttribute?.("d"), /^M 40 6\.8 H /);
  assert.equal(arc?.getAttribute?.("pathLength"), "100");
  assert.match(arc?.getAttribute?.("stroke-dasharray"), /^\d+(\.\d+)? 100$/);
  const popover = env.getElementById("codey-account-credits-popover");
  assert.match(String(popover.style.backgroundImage), /radial-gradient/);
  assert.equal(popover.style.borderRadius, "14px");
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
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
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
  env.submitComposer();
  env.emitNotification(tokenUsageMessage("thread-1"));
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
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
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

test("expires the live cache ring when the composer model changes", async () => {
  const env = createEnvironment();
  await flush();
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.modelButton.textContent = "Grok 4.6 高";
  env.window.__codeyComposerUsage.scan();
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("expires every live cache ring when the provider changes", async () => {
  const env = createEnvironment();
  await flush();
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
  assert.equal(env.snapshot().cacheRingVisible, true);
  env.window.dispatchEvent(new env.window.CustomEvent("codey:config-changed", {
    detail: {
      config: { cacheValidMinutes: 30 },
      currentProviderSnapshot: { id: "other-provider" },
    },
  }));
  assert.equal(env.snapshot().cacheRingVisible, false);
  assert.match(env.getElementById("codey-thread-usage-popover").innerHTML, /已过期/);
  env.window.__codeyComposerUsage.dispose();
});

test("recomputes remaining time when the configured TTL changes", async () => {
  const env = createEnvironment();
  await flush();
  env.submitComposer();
  env.emitNotification(tokenUsageMessage());
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
