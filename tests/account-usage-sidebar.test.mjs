import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(new URL("../public/renderer-inject.js", import.meta.url), "utf8");
const quotaUnlockSource = readFileSync(new URL("../public/quota-unlock.js", import.meta.url), "utf8");

class FakeElement extends FakeElementCore {
  constructor(tagName = "div", { visible = true, right = 100, width = right, height = 46, top = 0 } = {}) {
    super(tagName);
    this.right = right;
    this.width = width;
    this.height = height;
    this.top = top;
    this.visible = visible;
  }

  getBoundingClientRect() {
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
}

const findById = (root, id) => {
  let result = null;
  const visit = (element) => {
    if (result || !element) return;
    if (element.id === id) {
      result = element;
      return;
    }
    for (const child of element.children || []) visit(child);
  };
  visit(root);
  return result;
};

const mountSidebar = ({ footerMode = "controls", usageResult, unlock = false } = {}) => {
  const sidebarRoot = new FakeElement("div", { right: 320, width: 320, height: 800 });
  const navigation = new FakeElement("nav", { right: 320, width: 320, height: 720 });
  const scroll = new FakeElement("div", { right: 320, width: 320, height: 620 });
  scroll.setAttribute("data-app-action-sidebar-scroll", "");
  navigation.appendChild(scroll);
  const footer = new FakeElement("div", { right: 320, width: 320, height: footerMode === "absolute" ? 0 : 64, top: 736 });
  const anchor = new FakeElement(footerMode === "controls" ? "button" : "div", {
    right: 220,
    width: 200,
    height: footerMode === "absolute" ? 0 : 40,
    top: 748,
  });
  footer.appendChild(anchor);
  sidebarRoot.append(navigation, footer);
  const documentElement = new FakeElement("html", { right: 1200, width: 1200, height: 800 });
  documentElement.appendChild(sidebarRoot);
  const document = {
    body: new FakeElement("body"),
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id),
    querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
  };
  const delays = [];
  const bridgeCalls = [];
  let accountUsageResult = usageResult;
  const payloadText = JSON.stringify(usageResult);
  const window = {
    __codeySessionToolsInjectLoaded: true,
    __codexSessionDeleteBridge: async (path, _payload, options) => {
      bridgeCalls.push({ path, timeoutMs: options?.timeoutMs });
      if (path === "/account/usage") {
        return unlock ? window.__codeyNativeJsonParse(payloadText) : accountUsageResult;
      }
      if (path === "/backend/health") return { status: "ok" };
      if (path === "/internal/codey/session-tools/load") return { status: "ok" };
      return { status: "unavailable" };
    },
    addEventListener() {},
    clearTimeout() {},
    dispatchEvent() {},
    getComputedStyle: (element) => ({
      display: element.visible === false ? "none" : "flex",
      visibility: "visible",
      position: footerMode === "absolute" && element === footer ? "absolute" : "static",
      bottom: footerMode === "absolute" && element === footer ? "0px" : "auto",
    }),
    innerHeight: 800,
    innerWidth: 1200,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (_callback, delay) => {
      delays.push(delay);
      return delays.length;
    },
  };
  window.window = window;
  const sandbox = {
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
  };
  const context = vm.createContext(sandbox);
  if (unlock) vm.runInContext(quotaUnlockSource, context);
  vm.runInContext(source, context);
  return {
    anchor,
    bridgeCalls,
    context,
    delays,
    document,
    footer,
    setUsage: (next) => {
      accountUsageResult = next;
    },
    window,
  };
};

test("mounts weekly and five-hour usage before the sidebar footer's last child", async () => {
  const today = new Date();
  today.setHours(23, 45, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const env = mountSidebar({
    usageResult: {
      status: "ok",
      planType: "pro",
      fetchedAt: Math.floor(Date.now() / 1000),
      primary: {
        usedPercent: 15,
        windowMinutes: 300,
        resetsAt: Math.floor(today.getTime() / 1000),
      },
      secondary: {
        usedPercent: 40,
        windowMinutes: 10080,
        resetsAt: Math.floor(tomorrow.getTime() / 1000),
      },
      credits: { hasCredits: true, unlimited: false, balance: "42" },
    },
  });

  await env.window.__codeyRefreshAccountUsage();

  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.equal(usage.parentElement, env.footer);
  assert.equal(usage.nextElementSibling, env.anchor);
  assert.deepEqual(env.footer.children, [usage, env.anchor]);
  assert.equal(env.footer.getAttribute("data-codey-usage-host"), "true");
  assert.match(usage.innerHTML, /周额度[\s\S]*?60%[\s\S]*?5 小时[\s\S]*?85%/);
  assert.match(usage.innerHTML, /class="codey-usage-plan-tag">Pro 20x</);
  assert.match(usage.innerHTML, /已用 40%/);
  assert.match(usage.innerHTML, /剩余 60%/);
  assert.match(usage.innerHTML, /Credits 余额[\s\S]*?42/);
  assert.equal(usage.dataset.state, "ready");
  assert.equal(usage.dataset.windowCount, "2");
  assert.ok(env.delays.includes(250));
  assert.ok(env.delays.includes(8_000));
  assert.ok(env.delays.includes(60_000));
  assert.ok(env.bridgeCalls.some((call) => call.path === "/account/usage" && call.timeoutMs === 8_000));

  env.setUsage({ status: "error", message: "官方额度接口返回 401" });
  await env.window.__codeyRefreshAccountUsage();
  assert.equal(usage.dataset.state, "stale");
  assert.match(usage.innerHTML, /周额度/);

  env.setUsage({ status: "disabled" });
  await env.window.__codeyRefreshAccountUsage();
  assert.equal(env.document.getElementById("codey-account-usage"), null);
});

test("mounts into Codex's bottom-anchored footer when it has no controls yet", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountSidebar({
    footerMode: "absolute",
    usageResult: {
      status: "ok",
      planType: "plus",
      fetchedAt: Math.floor(Date.now() / 1000),
      primary: { usedPercent: 20, windowMinutes: 300, resetsAt },
      secondary: { usedPercent: 45, windowMinutes: 10080, resetsAt },
    },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.equal(usage.parentElement, env.footer);
  assert.equal(usage.nextElementSibling, env.anchor);
  assert.match(usage.innerHTML, /周额度/);
  assert.match(usage.innerHTML, /data-window="five-hour"/);
});

test("sidebar keeps a real 100 percent reading while quota unlock is installed", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  const usageResult = {
    status: "ok",
    rateLimits: { primary_window: { used_percent: 100 } },
    fetchedAt: Math.floor(Date.now() / 1000),
    primary: { used_percent: 100, window_minutes: 10080, resets_at: resetsAt },
  };
  const env = mountSidebar({ usageResult, unlock: true });
  const raw = JSON.stringify(usageResult);
  const sanitized = vm.runInContext(`JSON.parse(${JSON.stringify(raw)})`, env.context);
  assert.equal(sanitized.primary.used_percent, 3);

  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.match(usage.innerHTML, /已用 100%/);
  assert.match(usage.innerHTML, /剩余 0%/);
  assert.doesNotMatch(usage.innerHTML, /已用 3%/);
  assert.equal(usage.parentElement, env.footer);
  assert.equal(usage.nextElementSibling, env.anchor);
});

test("shows the error state when the first quota read fails", async () => {
  const env = mountSidebar({
    usageResult: { status: "error", message: "官方额度接口返回 401" },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.equal(usage.dataset.state, "error");
  assert.equal(usage.textContent, "额度暂不可用");
});
