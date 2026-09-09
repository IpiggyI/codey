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
  toolbar.appendChild(accessButton);
  toolbar.appendChild(modelButton);
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

  const document = {
    body,
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_ns, tagName) => new FakeElement(tagName),
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
    __codeyLoadCodexSessionController: async () => (
      options.loadSessionController
        ? options.loadSessionController()
        : {
          kind: "manager",
          manager: {
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
  const credits = env.getElementById("codey-account-credits");
  const ring = credits.querySelector("[data-codey-credits-ring]");
  assert.equal(ring?.children[0]?.tagName, "SVG");
  assert.equal(ring?.children[0]?.children.length, 2);
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
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
});

test("matches a local: composer conversation id to the native thread id", async () => {
  const env = createEnvironment({ conversationId: "local:thread-1" });
  await flush();
  env.emitNotification(tokenUsageMessage("thread-1"));
  const usage = env.getElementById("codey-thread-usage");
  assert.equal(usage.style.display, "inline-flex");
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
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
  assert.equal(usage.textContent, "CH 99.6%");
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
