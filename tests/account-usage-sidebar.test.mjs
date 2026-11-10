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
  assert.match(usage.innerHTML, /每周<\/span>\s*<\/span>\s*<span class="codey-usage-value">60<span class="codey-usage-unit">%[\s\S]*?5 小时<\/span>\s*<\/span>\s*<span class="codey-usage-value">85</);
  assert.match(usage.innerHTML, /class="codey-usage-plan-tag" data-pro-tier="200">Pro 200</);
  assert.match(usage.innerHTML, /周额度[\s\S]*?codey-usage-detail-percent">60%/);
  // 摘要是紧凑卡片：只有标签、大号百分比和重置时间，不含进度条与“重置”后缀。
  const summaryHtml = usage.innerHTML.split('class="codey-usage-details"')[0];
  assert.match(summaryHtml, /class="codey-usage-plan-tag" data-pro-tier="200">Pro 200<\/span>\s*<span class="codey-usage-window-label">每周</);
  assert.match(summaryHtml, /class="codey-usage-reset">明天 \d{2}:\d{2}<\/span>/);
  assert.doesNotMatch(summaryHtml, /重置|codey-usage-meter|codey-usage-border-progress|余额|>42</);
  assert.doesNotMatch(usage.innerHTML, /已用|detail-value">剩余/);
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

test("maps plan types to sidebar labels and Pro tier attributes", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const baseUsage = {
    status: "ok",
    planType: "prolite",
    fetchedAt: Math.floor(Date.now() / 1000),
    primary: { usedPercent: 15, windowMinutes: 300, resetsAt },
    secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt },
  };
  const env = mountSidebar({ usageResult: baseUsage });
  const planTag = /<span class="codey-usage-plan-tag"((?: data-plan="plus")?(?: data-pro-tier="(?:100|200|500)")?)>([^<]*)<\/span>/;

  for (const [planType, expectedLabel, expectedTier] of [
    ["prolite", "Pro 100", "100"],
    ["pro", "Pro 200", "200"],
    ["promax", "Pro 500", "500"],
    ["  ProLite  ", "Pro 100", "100"],
    ["pro100", "Pro 100", "100"],
    ["pro200", "Pro 200", "200"],
    ["pro500", "Pro 500", "500"],
    ["pro 100", "Pro 100", "100"],
    ["pro_200", "Pro 200", "200"],
    ["pro-500", "Pro 500", "500"],
    ["Pro $100", "Pro 100", "100"],
    ["5x", "Pro 5x"],
    ["pro5x", "Pro 5x"],
    ["pro20x", "Pro 20x"],
    ["plus", "Plus"],
    ["free", "Free"],
    ["business_prolite", "business_prolite"],
    ["business_pro100", "business_pro100"],
    ["pro500_trial", "pro500_trial"],
    ["pro_lite", "pro_lite"],
    ["business_plus", "business_plus"],
    ["  future_plan  ", "future_plan"],
    ["__proto__", "__proto__"],
    ['pro500" data-pro-tier="500', 'pro500&quot; data-pro-tier=&quot;500'],
  ]) {
    env.setUsage({ ...baseUsage, planType });
    await env.window.__codeyRefreshAccountUsage();
    const usage = env.document.getElementById("codey-account-usage");
    assert.ok(usage, `usage mounted for ${planType}`);
    const match = usage.innerHTML.match(planTag);
    assert.equal(match?.[2], expectedLabel, `rendered plan label for ${planType}`);
    assert.equal(
      match?.[1].match(/data-pro-tier="(\d+)"/)?.[1],
      expectedTier,
      `rendered Pro tier for ${planType}`,
    );
    assert.equal(
      match?.[1].includes('data-plan="plus"'),
      expectedLabel === "Plus",
      `applies Plus styling only to Plus for ${planType}`,
    );
  }
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
  assert.match(usage.innerHTML, /codey-usage-detail-percent">0%/);
  assert.doesNotMatch(usage.innerHTML, /codey-usage-detail-percent">97%|已用/);
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

const appServerWindow = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });

// 后端读取失败时，侧栏会回退到 app-server 的 account/rateLimits/read。
const mountAppServerUsage = (rateLimitsResponse) => {
  const env = mountSidebar({ usageResult: { status: "error", message: "官方额度接口返回 401" } });
  env.window.__codeyReadAccountRateLimits = async () => rateLimitsResponse;
  return env;
};

test("app-server rateLimitsByLimitId keeps codex as the summary and lists other groups separately", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountAppServerUsage({
    rateLimits: { limitId: "codex", primary: appServerWindow(99, 300, resetsAt), secondary: appServerWindow(99, 10080, resetsAt) },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: appServerWindow(10, 300, resetsAt), secondary: appServerWindow(30, 10080, resetsAt), planType: "plus" },
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "  GPT-5.3-Codex-Spark ",
        primary: appServerWindow(100, 300, resetsAt),
        secondary: appServerWindow(25, 10080, resetsAt),
      },
      empty_group: { limitId: "empty_group", limitName: "没有窗口", primary: null },
    },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  // 摘要来自 rateLimitsByLimitId.codex，而不是 rateLimits 或其他额度组。
  assert.match(usage.innerHTML, /周额度[\s\S]*?70%[\s\S]*?5 小时[\s\S]*?90%/);
  assert.equal(usage.dataset.windowCount, "2");
  assert.match(usage.innerHTML, /class="codey-usage-plan-tag" data-plan="plus">Plus</);
  assert.match(usage.innerHTML, /class="codey-usage-detail-row" data-tone="critical" style="--codey-usage-remaining:0"/);
  const summary = usage.innerHTML.slice(0, usage.innerHTML.indexOf("codey-account-usage-details"));
  assert.doesNotMatch(summary, /GPT-5\.3-Codex-Spark/);
  // 其他额度组只出现在详情里，带名称和独立的小标题。
  assert.match(usage.innerHTML, /其他额度组[\s\S]*?GPT-5\.3-Codex-Spark[\s\S]*?已用尽[\s\S]*?5 小时额度[\s\S]*?detail-percent">0%[\s\S]*?周额度[\s\S]*?detail-percent">75%/);
  assert.doesNotMatch(usage.innerHTML, /没有窗口/);
});

test("app-server legacy rateLimits payload renders without an additional group section", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountAppServerUsage({
    rateLimits: { primary: appServerWindow(20, 300, resetsAt), secondary: appServerWindow(45, 10080, resetsAt), planType: "plus" },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.match(usage.innerHTML, /周额度[\s\S]*?55%[\s\S]*?5 小时[\s\S]*?80%/);
  assert.doesNotMatch(usage.innerHTML, /其他额度组/);
});

test("app-server rateLimitsByLimitId falls back to rateLimits when codex is absent", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountAppServerUsage({
    rateLimits: { limitId: "codex", primary: appServerWindow(20, 300, resetsAt), secondary: appServerWindow(45, 10080, resetsAt) },
    rateLimitsByLimitId: {
      codex_other: { primary: appServerWindow(50, 300, resetsAt) },
    },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.match(usage.innerHTML, /周额度[\s\S]*?55%[\s\S]*?5 小时[\s\S]*?80%/);
  // 没有 limitName 时用键名作为组名。
  assert.match(usage.innerHTML, /其他额度组[\s\S]*?codex_other[\s\S]*?detail-percent">50%/);
});

test("backend additionalLimits render in the details with names, blocked marker and escaping", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountSidebar({
    usageResult: {
      status: "ok",
      planType: "pro",
      fetchedAt: Math.floor(Date.now() / 1000),
      primary: { usedPercent: 15, windowMinutes: 300, resetsAt },
      secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt },
      additionalLimits: [
        { limitName: "Spark <b>", limitId: "spark", primary: { usedPercent: 100, windowMinutes: 300, resetsAt }, blocked: true },
        { limitName: "Review", secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt }, blocked: false },
        { limitName: "", primary: { usedPercent: 1, windowMinutes: 300 }, blocked: false },
      ],
    },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.equal(usage.dataset.windowCount, "2");
  assert.match(usage.innerHTML, /其他额度组[\s\S]*?Spark &lt;b&gt;[\s\S]*?已用尽[\s\S]*?5 小时额度[\s\S]*?Review[\s\S]*?周额度[\s\S]*?detail-percent">90%/);
  assert.doesNotMatch(usage.innerHTML, /Spark <b>/);
  assert.equal(usage.innerHTML.match(/已用尽/g).length, 1);
  const summary = usage.innerHTML.slice(0, usage.innerHTML.indexOf("codey-account-usage-details"));
  assert.doesNotMatch(summary, /Spark|Review/);
});

// 固定在本地 15:30，避开 hour12:false 在零点附近的 24:xx 写法。
const localAfterDays = (days, hours = 15, minutes = 30) => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  value.setHours(hours, minutes, 0, 0);
  return Math.floor(value.getTime() / 1000);
};
const monthDayLabel = (seconds) => {
  const value = new Date(seconds * 1000);
  return `${value.getMonth() + 1}月${value.getDate()}日 15:30`;
};
const resetCreditsBase = () => ({
  status: "ok",
  planType: "pro",
  fetchedAt: Math.floor(Date.now() / 1000),
  primary: { usedPercent: 15, windowMinutes: 300, resetsAt: localAfterDays(1) },
  secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: localAfterDays(1) },
});
const renderedUsage = async (usageResult) => {
  const env = mountSidebar({ usageResult });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  return usage;
};

const summaryOf = (usage) => usage.innerHTML.split('class="codey-usage-details"')[0];
const weeklyOnly = (usedPercent, resetsAt = localAfterDays(1)) => ({
  ...resetCreditsBase(),
  primary: { usedPercent, windowMinutes: 10080, resetsAt },
  secondary: null,
});

test("a lone weekly window draws a border progress ring and a calendar-date reset", async () => {
  const resetsAt = localAfterDays(1);
  const usage = await renderedUsage(weeklyOnly(15, resetsAt));
  assert.equal(usage.dataset.windowCount, "1");
  const summary = summaryOf(usage);
  assert.match(summary, new RegExp(`<span class="codey-usage-reset">${monthDayLabel(resetsAt)} 重置</span>`));
  assert.doesNotMatch(summary, /今天|明天/);
  assert.match(summary, /class="codey-usage-border-progress" aria-hidden="true" focusable="false"/);
  assert.match(summary, /pathLength="100" stroke-dasharray="85 100"/);
  assert.doesNotMatch(summary, /codey-usage-meter/);
});

test("the border progress follows the remaining percentage and the tone thresholds", async () => {
  for (const [remaining, tone] of [[100, "healthy"], [71, "healthy"], [70, "normal"], [57, "normal"], [40, "warning"], [20, "critical"], [0, "critical"]]) {
    const summary = summaryOf(await renderedUsage(weeklyOnly(100 - remaining)));
    assert.ok(summary.includes(`data-window="weekly" data-tone="${tone}"`), `${remaining}% tone`);
    assert.ok(summary.includes(`stroke-dasharray="${remaining} 100"`), `${remaining}% dash`);
    assert.equal(summary.includes('opacity="0"'), remaining === 0, `${remaining}% hides the rounded end cap`);
  }
});

test("the border progress is limited to a lone weekly window", async () => {
  const both = await renderedUsage(resetCreditsBase());
  assert.equal(both.dataset.windowCount, "2");
  assert.doesNotMatch(both.innerHTML, /codey-usage-border-progress/);
  assert.match(summaryOf(both), /class="codey-usage-reset">明天 15:30</);

  const fiveHourOnly = await renderedUsage({
    ...resetCreditsBase(),
    primary: { usedPercent: 15, windowMinutes: 300, resetsAt: localAfterDays(1) },
    secondary: null,
  });
  assert.equal(fiveHourOnly.dataset.windowCount, "1");
  assert.doesNotMatch(fiveHourOnly.innerHTML, /codey-usage-border-progress/);
  assert.match(fiveHourOnly.innerHTML, /data-window="five-hour"/);
});

test("reset credits render their count and the nearest expiry with the shared day-time label", async () => {
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    resetCredits: { availableCount: 3, nextExpiresAt: localAfterDays(1) },
  });
  assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?codey-usage-detail-value">3 次</);
  assert.match(usage.innerHTML, /<span>最近 明天 15:30 过期<\/span>/);
  // 详情里的窗口重置时间带“重置”后缀，摘要与过期时间不带。
  assert.match(usage.innerHTML, /<span class="codey-usage-detail-reset">明天 15:30 重置<\/span>/);
  assert.match(usage.innerHTML, /<span class="codey-usage-reset">明天 15:30<\/span>/);
  assert.doesNotMatch(usage.innerHTML, /过期[^<]*重置|重置[^<]*过期/);
  const summary = usage.innerHTML.slice(0, usage.innerHTML.indexOf("codey-account-usage-details"));
  assert.doesNotMatch(summary, /重置次数/);
});

test("reset credits show the count without an expiry when none is known", async () => {
  const usage = await renderedUsage({ ...resetCreditsBase(), resetCredits: { availableCount: 1 } });
  assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?codey-usage-detail-value">1 次</);
  assert.doesNotMatch(usage.innerHTML, /过期/);
});

test("reset credits do not show an expiry that has already passed", async () => {
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    resetCredits: { availableCount: 2, nextExpiresAt: Math.floor(Date.now() / 1000) - 60 },
  });
  assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?codey-usage-detail-value">2 次</);
  assert.doesNotMatch(usage.innerHTML, /过期/);
});

test("no reset-credit row renders when the field is absent or malformed", async () => {
  for (const resetCredits of [undefined, null, {}, { availableCount: null }, { availableCount: "n/a" }, "3"]) {
    const usage = await renderedUsage({ ...resetCreditsBase(), resetCredits });
    assert.doesNotMatch(usage.innerHTML, /剩余重置次数|过期/, `resetCredits=${JSON.stringify(resetCredits)}`);
  }
});

test("a zero reset-credit count renders no row and no expiry warning", async () => {
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    resetCredits: { availableCount: 0, nextExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
  });
  assert.doesNotMatch(usage.innerHTML, /剩余重置次数|codey-usage-credit-dot/);
  assert.equal(usage.dataset.creditExpiring, undefined);
});

test("reset credits expiring within 18 hours light the warning dot, the critical row and the aria hint", async () => {
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    resetCredits: { availableCount: 2, nextExpiresAt: Math.floor(Date.now() / 1000) + 6 * 3600 },
  });
  assert.equal(usage.dataset.creditExpiring, "true");
  assert.match(usage.innerHTML, /codey-usage-credit-dot[\s\S]*?codey-usage-window-label/);
  assert.match(usage.innerHTML, /data-tone="critical"[\s\S]*?剩余重置次数[\s\S]*?codey-usage-credit-dot[\s\S]*?is-expiring[\s\S]*?过期/);
  assert.match(usage.getAttribute("aria-label"), /重置次数即将过期/);
});

test("reset credits expiring at 17 hours are warned and at 19 hours are not", async () => {
  for (const [hours, expiring] of [[17, true], [19, false]]) {
    const usage = await renderedUsage({
      ...resetCreditsBase(),
      resetCredits: { availableCount: 3, nextExpiresAt: Math.floor(Date.now() / 1000) + hours * 3600 },
    });
    assert.equal(usage.dataset.creditExpiring === "true", expiring, `${hours}h`);
    assert.equal(usage.innerHTML.includes("codey-usage-credit-dot"), expiring, `${hours}h dot`);
  }
});

test("a zero Credits balance renders no row", async () => {
  const usage = await renderedUsage({ ...resetCreditsBase(), credits: { hasCredits: false, unlimited: false, balance: "0" } });
  assert.doesNotMatch(usage.innerHTML, /Credits 余额/);
});

test("reset credits expiring after more than 18 hours show no warning", async () => {
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    resetCredits: { availableCount: 2, nextExpiresAt: Math.floor(Date.now() / 1000) + 24 * 3600 },
  });
  assert.equal(usage.dataset.creditExpiring, undefined);
  assert.doesNotMatch(usage.innerHTML, /codey-usage-credit-dot|is-expiring/);
  assert.doesNotMatch(usage.getAttribute("aria-label"), /即将过期/);
});

test("app-server reset credits keep the nearest unexpired, unredeemed expiry", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const nearest = localAfterDays(4);
  const buildResponse = (summary) => ({
    rateLimits: {
      primary: appServerWindow(20, 300, resetsAt),
      secondary: appServerWindow(45, 10080, resetsAt),
      planType: "plus",
    },
    ...summary,
  });
  const rows = [
    // 更近的过期时间属于已兑换、已过期或已经过去的明细，都不能显示。
    { status: "redeemed", expiresAt: localAfterDays(1) },
    { status: "expired", expiresAt: localAfterDays(2) },
    { status: "available", expiresAt: Math.floor(Date.now() / 1000) - 3600 },
    { status: "unknown", expiresAt: localAfterDays(3) },
    { status: "available", expiresAt: localAfterDays(9) },
    { status: "available", expiresAt: nearest },
  ];
  for (const summary of [
    { rateLimitResetCredits: { availableCount: 2, credits: rows } },
    { rate_limit_reset_credits: { available_count: 2, credits: rows.map(({ status, expiresAt }) => ({ status, expires_at: expiresAt * 1000 })) } },
    { rateLimits: { primary: appServerWindow(20, 300, resetsAt), secondary: appServerWindow(45, 10080, resetsAt), rateLimitResetCredits: { availableCount: 2, credits: rows } } },
  ]) {
    const env = mountAppServerUsage(buildResponse(summary));
    await env.window.__codeyRefreshAccountUsage();
    const usage = env.document.getElementById("codey-account-usage");
    assert.ok(usage);
    assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?codey-usage-detail-value">2 次</);
    assert.match(usage.innerHTML, new RegExp(`最近 ${monthDayLabel(nearest)} 过期`));
    assert.equal(usage.innerHTML.match(/过期/g).length, 1);
  }
});

test("app-server reset credits without usable rows keep only the count", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const env = mountAppServerUsage({
    rateLimits: { primary: appServerWindow(20, 300, resetsAt), secondary: appServerWindow(45, 10080, resetsAt) },
    rateLimitResetCredits: { availableCount: 1, credits: [{ status: "redeemed", expiresAt: localAfterDays(2) }] },
  });
  await env.window.__codeyRefreshAccountUsage();
  const usage = env.document.getElementById("codey-account-usage");
  assert.ok(usage);
  assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?codey-usage-detail-value">1 次</);
  assert.doesNotMatch(usage.innerHTML, /过期/);

  const absent = mountAppServerUsage({
    rateLimits: { primary: appServerWindow(20, 300, resetsAt), secondary: appServerWindow(45, 10080, resetsAt) },
  });
  await absent.window.__codeyRefreshAccountUsage();
  assert.doesNotMatch(absent.document.getElementById("codey-account-usage").innerHTML, /剩余重置次数/);
});

test("details keep the fork's extras and put the updated time in the heading", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const usage = await renderedUsage({
    ...resetCreditsBase(),
    planType: "promax",
    credits: { hasCredits: true, unlimited: false, balance: "12.500" },
    additionalLimits: [{ limitName: "Spark", primary: { usedPercent: 10, windowMinutes: 300, resetsAt }, blocked: false }],
    resetCredits: { availableCount: 1, nextExpiresAt: localAfterDays(1) },
  });
  assert.match(usage.innerHTML, /class="codey-usage-plan-tag" data-pro-tier="500">Pro 500</);
  assert.match(usage.innerHTML, /Credits 余额[\s\S]*?12\.5</);
  assert.match(usage.innerHTML, /剩余重置次数[\s\S]*?其他额度组[\s\S]*?Spark/);
  assert.match(
    usage.innerHTML,
    /额度详情<\/span>\s*<span class="codey-usage-details-updated">更新于 \d{2}:\d{2}<\/span>\s*<\/div>\s*<div class="codey-usage-details-list">/,
  );
  assert.doesNotMatch(usage.innerHTML, /<div class="codey-usage-details-updated">/);
});
