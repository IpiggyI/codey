import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(new URL("../public/renderer-inject.js", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../public/codey-bridge.js", import.meta.url), "utf8");

const runRenderer = (sandbox) => {
  const context = vm.createContext(sandbox);
  vm.runInContext(bridgeSource, context);
  vm.runInContext(source, context);
};

class FakeElement extends FakeElementCore {
  constructor(tagName = "div", { visible = true, right = 100, width = right, height = 46, top = 0 } = {}) {
    super(tagName);
    this.right = right;
    this.width = width;
    this.height = height;
    this.top = top;
    this.visible = visible;
    this.rectReads = 0;
  }

  insertBefore(child, before) {
    child.remove();
    const index = this.children.indexOf(before);
    assert.notEqual(index, -1);
    child.parentElement = this;
    child.isConnected = true;
    this.children.splice(index, 0, child);
    return child;
  }

  closest() {
    return null;
  }

  getBoundingClientRect() {
    this.rectReads += 1;
    return this.visible
      ? {
          bottom: this.top + this.height,
          height: this.height,
          left: this.right - this.width,
          right: this.right,
          top: this.top,
          width: this.width,
        }
      : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
  }

  getClientRects() {
    return this.visible ? [this.getBoundingClientRect()] : [];
  }

  querySelector() {
    return super.querySelector(...arguments);
  }

  querySelectorAll(selector) {
    return super.querySelectorAll(selector);
  }

  matches(selector) {
    return selector
      .split(",")
      .some((part) => super.matches(part.trim()));
  }

  closest(selector) {
    return super.closest(selector);
  }
}

test("moves the Codey button beside the visible header's trailing action region", () => {
  const hiddenHeader = new FakeElement("header", { visible: false });
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const rightRegion = new FakeElement("div", { right: 1200, width: 70 });
  const actionRow = new FakeElement("div", { right: 1192, width: 62 });
  const controlWrapper = new FakeElement("span", { right: 1192, width: 28 });
  const nativeButton = new FakeElement("button", { right: 1192, width: 28 });
  const codeyButton = new FakeElement("button", { right: 200, width: 32 });
  codeyButton.id = "codey-settings-button";
  hiddenHeader.appendChild(codeyButton);
  visibleHeader.appendChild(rightRegion);
  rightRegion.appendChild(actionRow);
  actionRow.appendChild(controlWrapper);
  controlWrapper.appendChild(nativeButton);

  const placeholders = {
    "codey-injected-style": new FakeElement("style"),
    "codey-message-toolbar": new FakeElement(),
    "codey-settings-button": codeyButton,
  };
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "header" ? [hiddenHeader, visibleHeader] : []),
  };
  const window = {
    addEventListener() {},
    clearTimeout() {},
    dispatchEvent() {},
    getComputedStyle: (element) => ({
      display: element.visible ? "flex" : "none",
      visibility: element.visible ? "visible" : "hidden",
    }),
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    setTimeout: () => 1,
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  assert.equal(codeyButton.parentElement, visibleHeader);
  assert.equal(codeyButton.dataset.codeyHeaderActions, "true");
  assert.equal(hiddenHeader.children.includes(codeyButton), false);
  assert.deepEqual(visibleHeader.children, [codeyButton, rightRegion]);
});

const createStartupUpdateFixture = (bridge) => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const documentElement = new FakeElement("html");
  const elementsById = new Map();
  let nextTimerId = 1;
  const timers = [];
  const events = [];
  const alerts = [];
  const documentListeners = new Map();
  const activeTimers = () => timers.filter((timer) => !timer.cleared);
  const visibleButton = () =>
    elementsById.get("codey-settings-button") || null;
  const document = {
    body: new FakeElement("body"),
    documentElement,
    visibilityState: "visible",
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    createElement: (tagName) => {
      const element = new FakeElement(tagName);
      let id = element.id;
      Object.defineProperty(element, "id", {
        configurable: true,
        get: () => id,
        set: (value) => {
          id = String(value);
          if (id) elementsById.set(id, element);
        },
      });
      const originalSetAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        originalSetAttribute(name, value);
        if (name === "id") elementsById.set(String(value), element);
      };
      return element;
    },
    getElementById: (id) => {
      const element = id === "codey-settings-button"
        ? visibleButton()
        : elementsById.get(id);
      return element?.isConnected ? element : null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "header" ? [visibleHeader] : [],
  };
  const window = {
    __codexSessionDeleteBridge: async (path, payload, options) => {
      if (path === "/internal/codey/session-tools/load") {
        window.__codeySessionToolsInjectLoaded = true;
        return { status: "ok" };
      }
      return bridge(path, payload, options);
    },
    addEventListener() {},
    alert(message) {
      alerts.push(String(message));
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    innerWidth: 1200,
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    requestIdleCallback(callback, options = {}) {
      const timer = {
        id: nextTimerId,
        callback,
        delay: options.timeout ?? 0,
        cleared: false,
        idle: true,
      };
      nextTimerId += 1;
      timers.push(timer);
      return timer.id;
    },
    setTimeout(callback, delay) {
      const timer = { id: nextTimerId, callback, delay, cleared: false };
      nextTimerId += 1;
      timers.push(timer);
      return timer.id;
    },
  };
  window.window = window;

  runRenderer({
    console,
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  return {
    activeTimers,
    alerts,
    document,
    dispatchDocumentEvent(type) {
      for (const handler of documentListeners.get(type) || []) {
        handler({ type });
      }
    },
    elementsById,
    events,
    timers,
    window,
  };
};

test("legacy update payloads do not show a red-dot or schedule update checks", async () => {
  const bridgeCalls = [];
  const fixture = createStartupUpdateFixture(async (path, payload) => {
    bridgeCalls.push({ path, payload });
    if (path === "/backend/status") {
      return {
        status: "ok",
        availableUpdate: {
          currentVersion: "0.3.9",
          latestVersion: "0.4.0",
          updateAvailable: true,
          selectedAsset: { fileName: "Codey-0.4.0.zip" },
        },
      };
    }
    if (path === "/backend/health") return { status: "ok" };
    if (path === "/api/check_for_updates") {
      throw new Error("update check must stay unreachable");
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });

  await new Promise((resolve) => setImmediate(resolve));

  const button = fixture.document.getElementById("codey-settings-button");
  assert.ok(button);
  assert.equal(button.getAttribute("data-codey-update-available"), null);
  assert.equal(button.getAttribute("aria-label"), "打开 Codey 配置");
  assert.equal(fixture.window.__codeyUpdateAvailability, undefined);
  assert.equal(
    fixture.events.some((event) => event.type === "codey-update-availability-changed"),
    false,
  );
  assert.equal(fixture.document.getElementById("codey-update-check-status"), null);
  assert.equal(fixture.document.getElementById("codey-update-dialog"), null);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30 * 60 * 1000),
    false,
  );
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 10_000),
    false,
  );
  assert.equal(
    bridgeCalls.some(({ path }) => path === "/api/check_for_updates"),
    false,
  );
  const actionLabels = [button.getAttribute("aria-label"), button.title].filter(Boolean);
  assert.equal(actionLabels.some((label) => /检查更新|下载更新|安装更新|可用更新/.test(label)), false);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    true,
  );
});

test("a hung backend does not fall back to a periodic update check", async () => {
  const fixture = createStartupUpdateFixture(
    async () => new Promise(() => {}),
  );

  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 10_000),
    false,
  );
  assert.equal(fixture.document.getElementById("codey-update-check-status"), null);
  assert.equal(fixture.document.getElementById("codey-update-dialog"), null);
  assert.equal(fixture.window.__codeyUpdateAvailability, undefined);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30 * 60 * 1000),
    false,
  );
});


test("marks the Codey icon unavailable after consecutive hung health checks and recovers", async () => {
  let healthMode = "hang";
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") {
      return { status: "ok", availableUpdate: null };
    }
    if (path === "/backend/health") {
      return healthMode === "healthy"
        ? { status: "ok" }
        : new Promise(() => {});
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });

  const fireLatestHealthTimeout = () => {
    const timer = fixture.activeTimers()
      .filter((candidate) => candidate.delay === 3_250)
      .at(-1);
    assert.ok(timer, "health timeout should be armed");
    timer.cleared = true;
    timer.callback();
  };

  fireLatestHealthTimeout();
  await new Promise((resolve) => setImmediate(resolve));

  const button = fixture.document.getElementById("codey-settings-button");
  assert.ok(button);
  assert.equal(button.getAttribute("data-codey-runtime-state"), "checking");

  const retryTimer = fixture.activeTimers().find(
    (candidate) => candidate.delay === 1_000,
  );
  assert.ok(retryTimer, "first health failure should retry after one second");
  retryTimer.cleared = true;
  retryTimer.callback();
  fireLatestHealthTimeout();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(button.getAttribute("data-codey-runtime-state"), "unavailable");
  assert.match(button.getAttribute("aria-label"), /Codey 进程异常或连接中断/);
  assert.match(button.title, /Codey 后端未响应/);
  button.dispatchEvent({
    type: "click",
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(fixture.alerts, [
    "Codey 进程异常或已退出，当前配置面板无法连接。请退出 Codex 后重新启动 Codey。",
  ]);

  healthMode = "healthy";
  await fixture.window.__codeyRefreshRuntimeHealth();

  assert.equal(button.getAttribute("data-codey-runtime-state"), "healthy");
  assert.equal(button.getAttribute("aria-label"), "打开 Codey 配置");
  assert.equal(button.title, "打开 Codey 配置");
  assert.equal(fixture.window.__codeyRuntimeHealth.consecutiveFailures, 0);
});

test("pauses Codey health checks while the page is hidden and resumes immediately", async () => {
  let healthCalls = 0;
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { status: "ok", availableUpdate: null };
    if (path === "/backend/health") {
      healthCalls += 1;
      return { status: "ok" };
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 1);

  fixture.document.visibilityState = "hidden";
  fixture.dispatchDocumentEvent("visibilitychange");
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    false,
  );
  await fixture.window.__codeyRefreshRuntimeHealth();
  assert.equal(healthCalls, 1);

  fixture.document.visibilityState = "visible";
  fixture.dispatchDocumentEvent("visibilitychange");
  const immediateTimer = fixture.activeTimers().find((timer) => timer.delay === 0);
  assert.ok(immediateTimer);
  immediateTimer.cleared = true;
  immediateTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthCalls, 2);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    true,
  );
});

test("ignores sidebar nav and main content until top chrome is available", () => {
  const sidebarNav = new FakeElement("nav", { right: 84, width: 84, height: 720 });
  const main = new FakeElement("main", { right: 1200, width: 1200, height: 640, top: 80 });
  const mainContent = new FakeElement("div", { right: 1080, width: 960, height: 640, top: 80 });
  const staleButton = new FakeElement("button", { right: 60, width: 28 });
  staleButton.id = "codey-settings-button";
  sidebarNav.appendChild(staleButton);
  main.appendChild(mainContent);

  let topNav = null;
  const placeholders = {
    "codey-core-injected-style": new FakeElement("style"),
    "codey-settings-button": staleButton,
  };
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html", { right: 1200, width: 1200, height: 800 }),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: (selector) => (selector === "main" ? main : null),
    querySelectorAll: (selector) => {
      if (selector === "header") return [];
      if (selector === "nav") return topNav ? [sidebarNav, topNav] : [sidebarNav];
      return [];
    },
  };
  const window = {
    addEventListener() {},
    alert() {},
    clearTimeout() {},
    getComputedStyle: (element) => ({
      display: element.visible ? "flex" : "none",
      visibility: element.visible ? "visible" : "hidden",
    }),
    innerWidth: 1200,
    setTimeout: () => 1,
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    URLSearchParams,
    window,
  });

  assert.equal(staleButton.parentElement, null);
  assert.equal(sidebarNav.children.includes(staleButton), false);
  assert.equal(mainContent.children.length, 0);

  topNav = new FakeElement("nav", { right: 1200, width: 96, height: 46 });
  window.__codeyRendererScan();

  assert.equal(staleButton.parentElement, topNav);
  assert.deepEqual(topNav.children, [staleButton]);
});

test("repeated scans fast-path an already mounted button without layout reads", () => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const rightRegion = new FakeElement("div", { right: 1200, width: 70 });
  const nativeButton = new FakeElement("button", { right: 1192, width: 28 });
  const codeyButton = new FakeElement("button", { right: 1120, width: 28 });
  codeyButton.id = "codey-settings-button";
  codeyButton.dataset.codeyHeaderActions = "true";
  codeyButton.isConnected = true;
  visibleHeader.appendChild(codeyButton);
  visibleHeader.appendChild(rightRegion);
  rightRegion.appendChild(nativeButton);

  const placeholders = {
    "codey-core-injected-style": new FakeElement("style"),
    "codey-settings-button": codeyButton,
  };
  let headerQueries = 0;
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === "header" || selector === "nav") headerQueries += 1;
      return selector === "header" ? [visibleHeader] : [];
    },
  };
  const window = {
    addEventListener() {},
    alert() {},
    clearTimeout() {},
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    setTimeout: () => 1,
  };
  window.window = window;
  let observerCallback = null;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}
      disconnect() {}
    },
    URLSearchParams,
    window,
  });

  headerQueries = 0;
  for (const element of [visibleHeader, rightRegion, nativeButton, codeyButton]) {
    element.rectReads = 0;
  }
  for (let scan = 0; scan < 10; scan += 1) {
    window.__codeyRendererScan();
  }
  assert.equal(headerQueries, 0);
  assert.equal(visibleHeader.rectReads, 0);
  assert.equal(rightRegion.rectReads, 0);
  assert.equal(nativeButton.rectReads, 0);
  assert.equal(codeyButton.rectReads, 0);
  assert.deepEqual(visibleHeader.children, [codeyButton, rightRegion]);

  const newRightRegion = new FakeElement("div", { right: 1200, width: 50 });
  const newRightButton = new FakeElement("button", { right: 1200, width: 28 });
  newRightRegion.appendChild(newRightButton);
  visibleHeader.appendChild(newRightRegion);
  observerCallback([{
    type: "childList",
    target: visibleHeader,
    addedNodes: [newRightRegion],
    removedNodes: [],
  }]);
  window.__codeyRendererScan();

  assert.ok(headerQueries > 0);
  assert.equal(codeyButton.__codeyHeaderAnchor, newRightRegion);
  assert.equal(codeyButton.dataset.codeyHeaderActions, "true");
  assert.deepEqual(visibleHeader.children, [rightRegion, codeyButton, newRightRegion]);
});
