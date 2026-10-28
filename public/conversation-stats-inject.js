// 对话用量统计条：输入框下方三个按钮，悬停或点击展开对应卡片，未知数据显示 —。
// 轮数、步数、计时和会话累计来自 /session/stats（只读会话记录）；最近一次请求的
// 缓存、上下文和费用来自 Codex thread/tokenUsage/updated 通知，缓存剩余时间以
// stats.lastModelRequest 中与通知对上的请求时间为锚点。会话 id 取自可见 composer。
(() => {
  const PROBE_KEY = "__codeyConversationStats";
  const VERSION = 1;
  const previous = window[PROBE_KEY];
  if (previous?.installed && (previous.version === VERSION || !previous.dispose)) return;
  previous?.dispose?.();

  const barId = "codey-conversation-stats";
  const styleId = "codey-conversation-stats-styles";
  const overlayId = `${barId}-overlay`;
  const styleScope = `:is(#${barId}, #${overlayId})`;
  const conversationAttribute = "data-above-composer-conversation-id";
  // 与 codey-inject.js 的会话识别保持同一优先级：先看可见 composer，再看
  // 会话元素属性、活动侧边栏项，最后退回 URL。
  const sessionIdAttributes = [
    conversationAttribute,
    "data-session-id",
    "data-conversation-id",
    "data-thread-id",
    "data-request-user-input-auto-resolution-conversation-id",
    "data-response-annotation-conversation",
  ];
  const sessionAttributeSelector = sessionIdAttributes
    .map((attribute) => `[${attribute}]`)
    .join(",");
  const activeThreadSelector = '[data-app-action-sidebar-thread-active="true"]';
  const POLL_IDLE_MS = 3_000;
  const POLL_ACTIVE_MS = 1_100;
  const RESCAN_DEBOUNCE_MS = 120;
  const settingsPath = "/settings/get";
  const accountIdentityPath = "/account/identity";
  const configChangedEvent = "codey:config-changed";
  // 会话记录与用量通知来自同一事件；记录可读前的短暂窗口用几次快速重读覆盖。
  const cacheAnchorRetryMs = 500;
  const cacheAnchorMaxAttempts = 6;
  const cacheValidMinutesMin = 1;
  const cacheValidMinutesMax = 180;
  const cacheValidMinutesDefault = 30;
  const cacheWarnElapsedRatio = 0.75;
  const cacheHotElapsedRatio = 0.90;
  const tokenUsageNotificationMethod = "thread/tokenUsage/updated";
  const tokenUsageNotificationMethods = [tokenUsageNotificationMethod];
  const tokenUsageFields = [
    ["totalTokens", "total_tokens"],
    ["inputTokens", "input_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalCostUsd", "total_cost_usd"],
  ];

  let statsElement = null;
  let currentSessionId = "";
  let stats = null;
  let pollTimer = 0;
  let rescanTimer = 0;
  let cacheTimer = 0;
  let fetchInFlight = false;
  let lastFetchOk = false;
  let lastResult = null;
  let sessionGeneration = 0;
  let fetchAttempted = false;
  let disposed = false;
  let providerId = "";
  // 设置返回前保持 undefined；身份接口带回同名字段时以身份接口为准。
  let providerUsesOfficialAuth;
  let accountIdentity = null;
  let cacheValidMinutes = cacheValidMinutesDefault;
  const usageByThread = new Map();
  // 每个会话：{ status: "ok", at, request } 或 { status: "unknown", reason }。
  const cacheAnchorByThread = new Map();
  // 收到通知后尚未对上会话记录的会话及已重读次数。
  const anchorAttempts = new Map();
  const boundNotificationTargets = new Map();
  // 经会话管理器绑定的订阅跨 composer 共享；其余来自 composer 的 requestClient。
  const managerNotificationTargets = new Set();
  let notificationSubscribePromise = null;
  let sessionManagerBound = false;
  let usageSelection = null;
  let usageError = null;
  let storedUsageRead = "";
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener?.(type, handler, options);
    listeners.push(() => target.removeEventListener?.(type, handler, options));
  };

  const isRendered = (element) => (
    element instanceof HTMLElement
    && element.getClientRects().length > 0
  );

  const visibleSessionElement = (selector) => {
    const first = document.querySelector(selector);
    if (isRendered(first)) return first;
    return [...document.querySelectorAll(selector)].find(isRendered);
  };

  const composerInputSelector =
    "textarea, [contenteditable='true'], [role='textbox']";

  // 锚点是只带数据属性的标记元素，自身通常没有布局矩形，不能用
  // getClientRects 判断。当前对话的判定标准是锚点所在 composer 容器内
  // 存在视口内可见的输入框；Codex 保留的非活动会话不满足这一点。
  const visibleComposerInput = (anchor) => {
    const host = anchor?.parentElement || anchor;
    if (!host) return null;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    for (const input of host.querySelectorAll?.(composerInputSelector) || []) {
      if (!(input instanceof HTMLElement)) continue;
      if (input.closest?.("[hidden], [aria-hidden='true']")) continue;
      const rect = input.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (viewportHeight > 0 && (rect.bottom <= 0 || rect.top >= viewportHeight)) {
        continue;
      }
      return input;
    }
    return null;
  };

  const findVisibleComposerAnchor = () => {
    for (const anchor of document.querySelectorAll(`[${conversationAttribute}]`)) {
      if (visibleComposerInput(anchor)) return anchor;
    }
    return null;
  };

  const callBridge = (path, payload = {}, options = {}) => {
    if (typeof window.__codexSessionDeleteBridge === "function") {
      return window.__codexSessionDeleteBridge(path, payload, options);
    }
    return Promise.resolve({ status: "failed", message: "Codey bridge unavailable" });
  };

  const withTimeout = (promise, ms, message) => {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const normalizeSessionId = (value) => (
    String(value || "").trim().replace(/^local:/, "").trim()
  );

  const resolveSessionId = (anchor = findVisibleComposerAnchor()) => {
    // 可见输入框的空标识表示会话尚未建立，不从旧 URL 或侧边栏取回旧会话。
    if (anchor) return normalizeSessionId(anchor.getAttribute(conversationAttribute));
    for (const attribute of sessionIdAttributes.slice(1)) {
      const value = visibleSessionElement(`[${attribute}]`)?.getAttribute(attribute);
      const normalized = normalizeSessionId(value);
      if (normalized) return normalized;
    }
    const activeThread = visibleSessionElement(activeThreadSelector)
      ?.getAttribute("data-app-action-sidebar-thread-id");
    if (activeThread) return normalizeSessionId(activeThread);
    const match = location.pathname.match(/(?:\/c\/|\/conversation\/|\/session\/)([A-Za-z0-9_-]+)/);
    if (match) return match[1];
    const params = new URLSearchParams(location.search);
    return normalizeSessionId(params.get("conversation_id") || params.get("session_id"));
  };

  // 只在同一同步阶段复用查询结果；跨过桥接请求后重新确认当前 composer。
  const resolveSessionContext = () => {
    const anchor = findVisibleComposerAnchor();
    return { anchor, sessionId: resolveSessionId(anchor) };
  };

  const ensureStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      ${styleScope} { --cs-text: var(--text-primary, CanvasText); --cs-muted: color-mix(in srgb, var(--cs-text) 60%, transparent); --cs-line: color-mix(in srgb, var(--cs-text) 11%, transparent); --cs-surface: color-mix(in srgb, var(--bg-primary, Canvas) 97%, var(--cs-text)); -webkit-app-region: no-drag !important; pointer-events: auto !important; position: relative; box-sizing: border-box; width: 100%; min-width: 0; padding: 5px 4px 0; color: var(--cs-text); font: 12px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; font-variant-numeric: tabular-nums; }
      ${styleScope} *, ${styleScope} *::before { box-sizing: border-box; }
      ${styleScope}[hidden], ${styleScope} [hidden] { display: none !important; }
      ${styleScope} .codey-cs-groups { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 2px 10px; }
      ${styleScope} button { font: inherit; color: inherit; cursor: pointer; }
      ${styleScope} .codey-cs-summary { display: inline-flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; padding: 4px 9px; border: 0; border-radius: 999px; background: transparent; color: var(--cs-muted); text-align: center; }
      ${styleScope} .codey-cs-summary:hover, ${styleScope} .codey-cs-summary[aria-expanded="true"] { background: color-mix(in srgb, var(--cs-text) 5%, transparent); color: color-mix(in srgb, var(--cs-text) 72%, transparent); }
      ${styleScope} button:focus-visible { outline: 2px solid var(--cs-text); outline-offset: 2px; }
      ${styleScope} .codey-cs-icon { display: inline-block; width: 15px; height: 15px; flex: 0 0 15px; background: currentColor; mask: var(--cs-icon) center / contain no-repeat; }
      ${styleScope} .codey-cs-metric { white-space: nowrap; }
      ${styleScope} .codey-cs-details { -webkit-app-region: no-drag !important; pointer-events: auto !important; position: fixed; inset: auto; margin: 0; z-index: 1000; width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; padding: 17px 18px 15px; color: var(--cs-text); background: var(--cs-surface); border: 1px solid var(--cs-line); border-radius: 15px; box-shadow: 0 5px 20px #0000000d; user-select: text; animation: codey-cs-enter 150ms ease-out; }
      @keyframes codey-cs-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      ${styleScope} .codey-cs-heading { display: flex; align-items: center; gap: 8px; padding-bottom: 11px; margin-bottom: 10px; border-bottom: 1px solid var(--cs-line); }
      ${styleScope} .codey-cs-heading strong { font-size: 13px; font-weight: 550; white-space: nowrap; }
      ${styleScope} .codey-cs-heading-total { margin-left: auto; font-size: 13px; text-align: right; }
      ${styleScope} dl { margin: 0; }
      ${styleScope} .codey-cs-detail-row { display: flex; justify-content: space-between; gap: 14px; padding: 4px 0; }
      ${styleScope} dt { color: var(--cs-muted); }
      ${styleScope} dd { margin: 0; text-align: right; color: color-mix(in srgb, var(--cs-text) 72%, transparent); overflow-wrap: anywhere; }
      ${styleScope} .codey-cs-note { margin: 10px 0 0; color: var(--cs-muted); font-size: 10px; line-height: 1.6; }
      ${styleScope} .codey-cs-note:empty { display: none; }
      @media (max-width: 480px) { ${styleScope} .codey-cs-groups { gap: 2px; } ${styleScope} .codey-cs-summary { padding-inline: 6px; font-size: 11px; } ${styleScope} .codey-cs-details { padding: 14px; } }
      @media (prefers-reduced-motion: reduce) { ${styleScope} .codey-cs-details { animation: none; } }
    `;
    document.documentElement.appendChild(style);
  };

  // 卡片按表定稿：每张一个无分节标题的行列表，同类项相邻，时间相关项放在一起。
  const cards = [
    ["activity", "最近一轮统计", [
      ["modelDuration", "模型用时"], ["toolDuration", "工具调用用时"], ["requestDuration", "最近一次用时"],
      ["turnSpeed", "平均速度（本轮）"], ["requestSpeed", "最近一次速度"], ["turnReasoning", "本轮推理"],
    ]],
    ["tokens", "Token 用量", [
      ["sessionCacheRate", "会话缓存命中"], ["requestCacheRate", "最近一次缓存命中"],
      ["uncachedInputTokens", "未缓存输入"], ["cachedInputTokens", "缓存读取"], ["outputTokens", "输出"],
    ]],
    ["session", "会话", [
      ["account", "账号"], ["startedAt", "开始时间"], ["lastReplyAt", "上次回复"], ["cacheRemaining", "缓存剩余时间"],
      ["context", "上下文"], ["requestTokens", "最近一次 未缓存 / 输出 / 缓存读取"],
      ["compactionCount", "压缩次数"], ["cost", "会话费用估算"],
    ]],
  ];

  // 状态条挂在 composer 标记所在的同一列容器末尾，即输入卡片下方；
  // composer 容器会随会话切换重建，所以每次都要重新核对挂载父节点。
  const ensureBar = (anchor = findVisibleComposerAnchor()) => {
    const host = anchor?.parentElement;
    if (!host) return null;
    let bar = document.getElementById(barId) || statsElement;
    if (!bar?.__codeyCs) {
      bar = document.createElement("div");
      bar.id = barId;
      bar.className = "codey-conversation-stats";
      const make = (tag, className, text, parent) => {
        const element = document.createElement(tag);
        element.className = className;
        if (text) element.textContent = text;
        parent?.appendChild(element);
        return element;
      };
      const groups = make("div", "codey-cs-groups", "", bar);
      // 浮层独立于 composer，避免 transform 改变 fixed 坐标系或 overflow 裁切。
      const overlay = make("div", "", "", document.body || document.documentElement);
      overlay.id = overlayId;
      overlay.style.display = "contents";
      const refs = { overlay, buttons: {}, panels: {}, fields: {}, rows: {}, notes: {}, active: null, pinned: false, closeTimer: 0 };
      // Tabler Icons v3.45.0 (MIT), matching the existing application icon family.
      const paths = {
        activity: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M13.41 10.59l2.59 -2.59", "M7 12a5 5 0 0 1 5 -5"],
        tokens: ["M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0", "M4 6v6a8 3 0 0 0 16 0v-6", "M4 12v6a8 3 0 0 0 16 0v-6"],
        session: ["M8 9h8", "M8 13h6", "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12"],
      };
      const icon = (kind, parent) => {
        const element = make("span", "codey-cs-icon", "", parent);
        element.setAttribute("aria-hidden", "true");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind].map(d => `<path d="${d}"/>`).join("")}</svg>`;
        element.style.setProperty?.("--cs-icon", `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
      };
      const separator = (parent) => {
        const element = make("span", "codey-cs-separator", "·", parent);
        element.setAttribute("aria-hidden", "true");
        return element;
      };
      for (const [kind, title, fields] of cards) {
        const button = make("button", `codey-cs-summary codey-cs-${kind}-summary`, "", groups);
        button.type = "button";
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", `${barId}-${kind}`);
        icon(kind, button);
        if (kind === "activity") {
          refs.activity = make("span", "codey-cs-metric codey-cs-activity", "— 轮 · — 步", button);
          refs.activity.title = "轮数为会话总轮数，步数和速度为最近一轮统计。";
          separator(button);
          refs.speed = make("span", "codey-cs-metric codey-cs-speed", "—", button);
        } else if (kind === "tokens") {
          refs.total = make("span", "codey-cs-metric codey-cs-total", "—", button);
          separator(button);
          const cache = make("span", "codey-cs-metric", "缓存命中 ", button);
          refs["cache-rate"] = make("span", "codey-cs-cache-rate", "—", cache);
        } else {
          refs.cost = make("span", "codey-cs-metric codey-cs-cost", "", button);
          refs.cost.hidden = true;
          refs.costSeparator = separator(button);
          refs.costSeparator.hidden = true;
          refs.contextSummary = make("span", "codey-cs-metric codey-cs-context", "—", button);
          refs.contextSummary.title = "上下文占用";
        }
        const panel = make("section", "codey-cs-details", "", overlay);
        panel.id = `${barId}-${kind}`;
        panel.hidden = true;
        if (typeof panel.showPopover === "function") panel.setAttribute("popover", "manual");
        panel.setAttribute("aria-label", title);
        const heading = make("div", "codey-cs-heading", "", panel);
        icon(kind, heading);
        make("strong", "", title, heading);
        if (kind === "tokens") {
          refs.fields.totalTokens = make("span", "codey-cs-heading-total", "—", heading);
          refs.fields.totalTokens.setAttribute("data-field", "totalTokens");
        }
        const list = make("dl", "", "", panel);
        for (const [key, label] of fields) {
          const row = make("div", "codey-cs-detail-row", "", list);
          row.setAttribute("data-row", key);
          make("dt", "", label, row);
          refs.rows[key] = row;
          refs.fields[key] = make("dd", "", "—", row);
          refs.fields[key].setAttribute("data-field", key);
        }
        refs.notes[kind] = make("p", `codey-cs-note codey-cs-${kind}-note`, "", panel);
        refs.buttons[kind] = button;
        refs.panels[kind] = panel;
        const preview = () => { clearTimeout(refs.closeTimer); if (!refs.pinned && !refs.restoringFocus) setExpanded(true, false, kind); };
        const leave = () => { clearTimeout(refs.closeTimer); refs.closeTimer = setTimeout(() => { if (!refs.pinned) setExpanded(false); }, 350); };
        button.addEventListener("pointerenter", preview);
        button.addEventListener("focus", preview);
        button.addEventListener("pointerleave", leave);
        button.addEventListener("blur", (event) => { if (!panel.contains(event.relatedTarget)) leave(); });
        panel.addEventListener("pointerenter", () => clearTimeout(refs.closeTimer));
        panel.addEventListener("pointerleave", leave);
        button.addEventListener("click", () => {
          const close = refs.active === kind && refs.pinned;
          setExpanded(!close, false, kind);
          refs.pinned = !close;
        });
      }
      refs.rows.cost.hidden = true;
      bar.__codeyCs = refs;
    }
    if (bar.parentElement !== host) {
      if (statsElement) setExpanded(false);
      host.appendChild(bar);
    }
    const overlay = bar.__codeyCs.overlay;
    if (!overlay.isConnected) {
      setExpanded(false);
      (document.body || document.documentElement).appendChild(overlay);
    }
    statsElement = bar;
    return bar;
  };

  const containsStats = (target) => Boolean(target && (
    statsElement?.contains(target) || statsElement?.__codeyCs?.overlay.contains(target)
  ));

  const syncPanelTheme = () => {
    const overlay = statsElement?.__codeyCs?.overlay;
    const computed = statsElement && window.getComputedStyle?.(statsElement);
    if (!overlay || !computed) return;
    for (const name of ["--text-primary", "--bg-primary", "--cs-text", "--cs-muted", "--cs-line", "--cs-surface"]) {
      const value = computed.getPropertyValue(name).trim();
      if (value) overlay.style.setProperty(name, value);
      else overlay.style.removeProperty(name);
    }
    overlay.style.colorScheme = computed.colorScheme;
  };

  // 条上的会话累计沿用上游格式；卡片中来自原输入栏芯片的数值沿用芯片格式。
  const formatTotalTokens = (value) => {
    if (value == null || !Number.isFinite(value)) return "—";
    if (value < 1_000) return `${Math.round(value)}`;
    if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
  };

  const decimal = (value, fractionDigits) =>
    value.toFixed(fractionDigits).replace(/\.?0+$/u, "");

  const formatTokenCount = (value) => {
    const sign = value < 0 ? "-" : "";
    const absolute = Math.abs(value);
    if (absolute < 1_000) return `${sign}${Math.round(absolute)}`;
    if (absolute < 1_000_000) return `${sign}${decimal(absolute / 1_000, 1)}k`;
    if (absolute < 1_000_000_000) return `${sign}${decimal(absolute / 1_000_000, 1)}M`;
    return `${sign}${decimal(absolute / 1_000_000_000, 1)}B`;
  };

  const positionPanel = () => {
    const refs = statsElement?.__codeyCs;
    if (!refs?.active) return;
    if (!statsElement.isConnected || !findVisibleComposerAnchor()) { setExpanded(false); return; }
    syncPanelTheme();
    const panel = refs.panels[refs.active];
    const rect = refs.buttons[refs.active].getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    // 气泡贴近入口，鼠标可以直接移入；只覆盖编辑器，不推动页面布局。
    const available = Math.max(80, rect.top - 20);
    panel.style.left = `${Math.max(12, Math.min(rect.left + (rect.width - panelRect.width) / 2, width - panelRect.width - 12))}px`;
    panel.style.maxHeight = `${Math.min(height - 24, available)}px`;
    panel.style.top = `${Math.max(12, rect.top - Math.min(panelRect.height, available) - 8)}px`;
  };

  const setExpanded = (expanded, restoreFocus = false, kind = null) => {
    const refs = statsElement?.__codeyCs;
    if (!refs) return;
    const active = kind || refs.active || "activity";
    clearTimeout(refs.closeTimer);
    refs.active = expanded ? active : null;
    if (!expanded) refs.pinned = false;
    for (const key of Object.keys(refs.panels)) {
      const panel = refs.panels[key];
      const visible = expanded && key === active;
      if (!visible && panel.hasAttribute("popover") && panel.matches(":popover-open")) panel.hidePopover();
      panel.hidden = !visible;
      if (visible && panel.hasAttribute("popover") && !panel.matches(":popover-open")) {
        try { panel.showPopover(); } catch { panel.removeAttribute("popover"); }
      }
      refs.buttons[key].setAttribute("aria-expanded", String(visible));
    }
    if (expanded) positionPanel();
    else if (restoreFocus) {
      refs.restoringFocus = true;
      refs.buttons[active].focus?.({ preventScroll: true });
      refs.restoringFocus = false;
    }
  };

  const resetSession = (sessionId) => {
    currentSessionId = sessionId;
    sessionGeneration += 1;
    stats = null;
    lastResult = null;
    lastFetchOk = false;
    fetchAttempted = false;
    setExpanded(false);
  };

  const formatSpeed = (value) => (
    value == null || !Number.isFinite(value) || value < 0
      ? null
      : `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`
  );

  // 缓存读占输入总量的百分比；记录未提供缓存字段时返回 null，显示未知而不是 0%。
  const cacheRatePercent = (input, cached) => {
    if (input == null || cached == null || input <= 0 || cached < 0 || cached > input) return null;
    return `${Math.round((cached / input) * 100)}%`;
  };

  const toneColor = (tone) => {
    if (tone === "hot") return "#ff3b30";
    if (tone === "warn") return "#ffbf00";
    return "#22c55e";
  };

  const formatRequestSpeed = (rate) => {
    const oneDecimal = rate.toFixed(1);
    return rate >= 10 || Number(oneDecimal) >= 10
      ? `${Math.round(rate)} tok/s`
      : `${oneDecimal} tok/s`;
  };

  const formatRequestDuration = (seconds) => {
    if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
    const total = Math.round(seconds);
    if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  };

  const formatDateTime = (ms) => {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const normalizeCacheValidMinutes = (value) => {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return cacheValidMinutesDefault;
    return Math.min(cacheValidMinutesMax, Math.max(cacheValidMinutesMin, Math.round(minutes)));
  };

  const formatCacheRemaining = (remainingMs) => {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  };

  const cacheTimerState = (threadId, now = Date.now()) => {
    const anchor = threadId ? cacheAnchorByThread.get(threadId) : undefined;
    if (!anchor) return { kind: "pending" };
    if (anchor.status !== "ok") return { kind: "unknown" };
    const ttlMs = cacheValidMinutes * 60_000;
    const remainingMs = ttlMs - (now - anchor.at);
    if (remainingMs <= 0) return { kind: "expired" };
    const elapsedRatio = 1 - remainingMs / ttlMs;
    const tone = elapsedRatio >= cacheHotElapsedRatio ? "hot"
      : elapsedRatio >= cacheWarnElapsedRatio ? "warn" : "ok";
    return { kind: "live", remainingMs, tone };
  };

  // 官方账号鉴权显示官方账号邮箱，否则显示服务商名称；读不到时显示 —。
  const accountRowValue = () => {
    const official = typeof accountIdentity?.usesOfficialAccountAuth === "boolean"
      ? accountIdentity.usesOfficialAccountAuth
      : providerUsesOfficialAuth;
    if (official === true) {
      if (!accountIdentity) return "—";
      return accountIdentity.loggedIn ? accountIdentity.accountEmail || "—" : "未登录";
    }
    if (official === false) return accountIdentity?.providerName || providerId || "—";
    return "—";
  };

  const setText = (element, value) => {
    // 相同 textContent 仍会替换文本节点，触发其他页面观察器。
    if (element.textContent !== value) element.textContent = value;
  };

  // 浏览器把颜色读回为 rgb()，按上次写入的值比较才能跳过重复写入。
  const setColor = (element, color) => {
    if (element.__codeyColor === color) return;
    element.__codeyColor = color;
    element.style.color = color;
  };

  const setHidden = (element, hidden) => {
    if (element.hidden !== hidden) element.hidden = hidden;
  };

  // 倒计时只写卡片里的一格，每秒更新，不重绘整条。
  const renderCacheRemaining = () => {
    clearTimeout(cacheTimer);
    cacheTimer = 0;
    const refs = statsElement?.__codeyCs;
    if (disposed || !refs) return;
    const usage = usageByThread.get(currentSessionId);
    const timer = cacheTimerState(currentSessionId);
    const field = refs.fields.cacheRemaining;
    const text = usage?.cacheHitRatePercent === undefined ? "—"
      : timer.kind === "live" ? formatCacheRemaining(timer.remainingMs)
        : timer.kind === "expired" ? "已过期"
          : timer.kind === "unknown" ? "未知" : "—";
    setText(field, text);
    setColor(field, text !== "—" && timer.kind === "live" ? toneColor(timer.tone) : "");
    // 页面隐藏时暂停；重新可见时由 visibilitychange 重算。
    if (timer.kind === "live" && usage?.cacheHitRatePercent !== undefined
      && document.visibilityState !== "hidden") {
      cacheTimer = setTimeout(renderCacheRemaining, 1000);
    }
  };

  const renderRequestRows = (refs, request) => {
    const output = request?.lastTokenUsage?.outputTokens;
    const span = request?.responseWindow;
    const seconds = Number.isFinite(span?.startedAt) && Number.isFinite(span?.endedAt)
      ? (span.endedAt - span.startedAt) / 1000
      : 0;
    const known = seconds > 0 && Number.isFinite(output);
    const rate = known ? output / seconds : 0;
    setText(refs.fields.requestSpeed, known ? formatRequestSpeed(rate) : "—");
    setText(refs.fields.requestDuration, known ? formatRequestDuration(seconds) : "—");
  };

  const renderSessionCard = (refs, usage, anchor, request) => {
    const finite = value => Number.isFinite(value) && value >= 0;
    setText(refs.fields.account, accountRowValue());
    setText(refs.fields.startedAt, finite(request?.sessionStartedAt) ? formatDateTime(request.sessionStartedAt) : "—");
    setText(refs.fields.lastReplyAt, request ? formatDateTime(anchor.at) : "—");
    const contextKnown = usage?.contextUsedTokens !== undefined && usage.contextWindowTokens > 0;
    const contextPercent = contextKnown
      ? `${decimal((usage.contextUsedTokens / usage.contextWindowTokens) * 100, 1)}%` : "";
    setText(refs.fields.context, contextKnown
      ? `${contextPercent} (${formatTokenCount(usage.contextUsedTokens)}/${formatTokenCount(usage.contextWindowTokens)})`
      : "—");
    const contextText = contextKnown ? `${contextPercent} · ${formatTokenCount(usage.contextUsedTokens)}` : "—";
    setText(refs.contextSummary, contextText);
    const compaction = Number.isInteger(request?.compactionCount) && request.compactionCount >= 0
      ? String(request.compactionCount) : "—";
    setText(refs.fields.compactionCount, compaction);
    // 费用只来自用量通知里的费用字段，不按单价换算。
    const cost = usage?.totalCostUsd;
    const costKnown = cost !== undefined;
    setHidden(refs.rows.cost, !costKnown);
    setHidden(refs.cost, !costKnown);
    setHidden(refs.costSeparator, !costKnown);
    setText(refs.fields.cost, costKnown ? `$${cost.toFixed(3)}` : "—");
    setText(refs.cost, costKnown ? `≈$${cost.toFixed(2)}` : "");
    return { contextLabel: `上下文占用 ${contextKnown ? contextText : "未知"}`, cost: costKnown ? refs.cost.textContent : "" };
  };

  const render = (anchor) => {
    if (disposed) return;
    const bar = ensureBar(anchor);
    if (!bar) {
      // 输入框不可见（例如离开会话页）时，若旧宿主仍在隐藏会话里，显式
      // 隐藏状态条，避免恢复可见时短暂展示过期数据。
      if (statsElement) { statsElement.hidden = true; setExpanded(false); }
      return;
    }
    bar.hidden = false;
    const data = { ...stats };
    const sessionUsage = data.usageSource === "rollout" && data.usageScope === "session";
    const runtimeRequests = data.requestsScope === "runtime"
      || (data.usageSource == null && data.usageScope == null);
    const hasRuntimeRequest = runtimeRequests && (data.requests > 0 || data.inFlight > 0);
    const turn = typeof data.lastTurn?.id === "string" && data.lastTurn.id.trim()
      ? data.lastTurn : null;
    const running = turn?.status === "running";
    const stale = fetchAttempted && !lastFetchOk;
    if (!hasRuntimeRequest) {
      for (const key of ["requests", "inFlight", "model", "lastStatus", "updatedAtUnixMs"]) data[key] = null;
    }
    // 最近一轮由后端按用户 turn 归属聚合；不回退到会话累计或单次请求字段。
    for (const key of ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "requests", "inFlight"]) {
      if (!Number.isFinite(data[key]) || data[key] < 0) data[key] = null;
    }
    if (!Number.isInteger(data.turnCount) || data.turnCount < 0) data.turnCount = null;
    const formattedSpeed = formatSpeed(running && stale ? null : turn?.averageOutputTokensPerSecond);
    const speedKnown = formattedSpeed != null;
    const estimatedSpeed = turn?.speedIsEstimate === true;
    const speedText = speedKnown ? `${estimatedSpeed ? "≈" : ""}${formattedSpeed}` : running ? stale ? "更新暂停" : "生成中" : "—";
    const coverageNote = ({
      recorded: "仅覆盖本轮可恢复且有有效计时的记录",
      partial: "本轮记录不完整，仅统计可恢复的部分",
    })[turn?.coverage] || "本轮统计范围未知，缺失值显示 —";
    const speedNote = running && stale ? "实时统计更新失败，恢复后继续显示本轮平均速度"
      : `本轮平均速度为本轮输出 Token ÷ 本轮各次模型请求用时之和，含等待首个 Token 的时间，不含工具调用用时；${coverageNote}${estimatedSpeed && speedKnown ? "；含生成中的 Token 估算" : ""}`;
    const rate = cacheRatePercent(data.inputTokens, data.cachedInputTokens) || "—";
    const refs = bar.__codeyCs;
    setText(refs.speed, speedText);
    refs.speed.title = speedNote;
    setText(refs["cache-rate"], rate);
    setText(refs.total, data.totalTokens == null ? "—" : `${formatTotalTokens(data.totalTokens)} tok`);
    const finite = value => Number.isFinite(value) && value >= 0;
    const count = value => finite(value) ? value.toLocaleString("zh-CN") : "—";
    const duration = (value) => {
      if (!finite(value)) return "—";
      const seconds = value / 1000;
      if (seconds < 60) return `${Number(seconds.toFixed(1))}秒`;
      return `${Math.floor(seconds / 60)}分 ${Math.floor(seconds % 60)}秒`;
    };
    setText(refs.activity, `${count(data.turnCount)} 轮 · ${count(turn?.stepCount)} 步`);
    const hasData = stats && (turn || hasRuntimeRequest || [data.turnCount, data.totalTokens, data.inputTokens, data.outputTokens].some(finite));
    const unknownUsage = data.usageSource === "unknown" || data.usageScope === "unknown";
    const scopeLabel = !stats || unknownUsage ? "统计范围未知" : sessionUsage ? "会话累计" : "本次运行";
    const state = !currentSessionId ? "waiting" : stale ? "stale" : !fetchAttempted ? "loading" : !hasData ? "empty" : "ok";
    const status = {
      waiting: "等待会话", loading: "读取统计中", stale: "统计暂不可用", empty: "暂无统计",
      ok: fetchInFlight ? "更新统计中" : running ? "本轮进行中" : turn?.status === "aborted" ? "本轮已中止" : (sessionUsage ? "历史统计" : "运行期统计"),
    }[state];
    bar.dataset.status = status;
    const tokenValue = value => finite(value) ? `${count(value)} tok` : "—";
    const uncached = finite(data.inputTokens) && finite(data.cachedInputTokens) && data.cachedInputTokens <= data.inputTokens ? data.inputTokens - data.cachedInputTokens : null;
    setText(refs.fields.modelDuration, duration(turn?.modelDurationMs));
    setText(refs.fields.toolDuration, duration(turn?.toolDurationMs));
    setText(refs.fields.turnSpeed, speedText);
    setText(refs.fields.turnReasoning, finite(turn?.turnReasoningOutputTokens) ? formatTokenCount(turn.turnReasoningOutputTokens) : "—");
    setText(refs.fields.totalTokens, tokenValue(data.totalTokens));
    setText(refs.fields.sessionCacheRate, rate);
    setText(refs.fields.uncachedInputTokens, tokenValue(uncached));
    setText(refs.fields.cachedInputTokens, tokenValue(data.cachedInputTokens));
    setText(refs.fields.outputTokens, tokenValue(data.outputTokens));
    const usage = currentSessionId ? usageByThread.get(currentSessionId) : undefined;
    const anchorEntry = currentSessionId ? cacheAnchorByThread.get(currentSessionId) : undefined;
    const request = anchorEntry?.status === "ok" ? anchorEntry.request || {} : null;
    renderRequestRows(refs, request);
    const requestRate = usage?.cacheHitRatePercent;
    setText(refs.fields.requestCacheRate, requestRate === undefined ? "—" : `${decimal(requestRate, 1)}%`);
    // 未提供的一项显示 —；缓存未知或大于输入时不推算未缓存输入。
    const lastInput = usage?.lastInputTokens;
    const lastCached = usage?.lastCachedInputTokens;
    const lastUncached = lastInput !== undefined && lastCached !== undefined && lastCached <= lastInput
      ? lastInput - lastCached : undefined;
    setText(refs.fields.requestTokens, lastInput === undefined ? "—"
      : [lastUncached, usage.lastOutputTokens, lastCached]
        .map((value) => value === undefined ? "—" : formatTokenCount(value)).join(" / "));
    renderCacheRemaining();
    const session = renderSessionCard(refs, usage, anchorEntry, request);
    const pendingNote = stale ? (stats ? "更新失败，当前数据可能已过期。" : "暂时无法读取统计，将自动重试。") : !currentSessionId ? "建立会话后显示统计。" : !stats ? "缺失数据以 — 显示。" : "";
    const sourceNote = unknownUsage ? "Token 统计范围未知。" : sessionUsage ? "会话累计 Token 来自会话记录，缓存读取已包含在输入中。" : "";
    const activityNote = turn ? "一次提问为一轮，步数为该轮的模型请求次数。" : "暂无可识别的最近一轮。";
    const toolNote = finite(turn?.toolDurationMs) ? "工具调用用时按时间区间合并，并行调用不重复计算。" : "";
    setText(refs.notes.activity, `${pendingNote}${activityNote}${toolNote}${speedNote}。`);
    setText(refs.notes.tokens, `${pendingNote}${sourceNote}`);
    refs.buttons.activity.setAttribute("aria-label", `会话总轮数 ${count(data.turnCount)} 轮，最近一轮统计 ${count(turn?.stepCount)} 步，本轮平均速度 ${speedText}，${status}。${speedNote}。查看统计详情`);
    refs.buttons.tokens.setAttribute("aria-label", `Token 用量，${scopeLabel} ${refs.total.textContent}，缓存命中 ${rate}，${status}。查看统计详情`);
    refs.buttons.session.setAttribute("aria-label", `会话，${session.cost ? `费用估算 ${session.cost}，` : ""}${session.contextLabel}。查看会话详情`);
    bar.dataset.running = running ? "true" : "false";
    bar.dataset.state = state;
    positionPanel();
  };

  const isRecord = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const isRpcManager = (value) =>
    typeof value === "function" && typeof value.subscribe === "function";

  const nonNegativeNumber = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

  const pickNumber = (source, ...keys) => {
    if (!isRecord(source)) return undefined;
    for (const key of keys) {
      const value = nonNegativeNumber(source[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const notificationRecord = (value) => {
    if (!isRecord(value)) return null;
    if (isRecord(value.notification)) return notificationRecord(value.notification);
    if (typeof value.method === "string") return value;
    if (
      isRecord(value.params)
      && (
        isRecord(value.params.tokenUsage)
        || isRecord(value.params.token_usage)
        || value.params.threadId
        || value.params.thread_id
        || value.params.conversationId
        || value.params.conversation_id
      )
    ) {
      return { method: tokenUsageNotificationMethod, params: value.params };
    }
    if (
      isRecord(value.tokenUsage)
      || isRecord(value.token_usage)
      || typeof value.threadId === "string"
      || typeof value.thread_id === "string"
      || typeof value.conversationId === "string"
      || typeof value.conversation_id === "string"
    ) {
      return { method: tokenUsageNotificationMethod, params: value };
    }
    return null;
  };

  const addBreakdown = (target, source) => {
    if (!isRecord(source)) return;
    for (const [camel, snake] of tokenUsageFields) {
      const value = pickNumber(source, camel, snake);
      if (value !== undefined) target[camel] = value;
    }
  };

  const observeTokenUsage = (value) => {
    const record = notificationRecord(value);
    if (!record || record.method !== tokenUsageNotificationMethod) return null;
    const params = record.params;
    if (!isRecord(params)) return null;
    const threadId = normalizeSessionId(
      [params.threadId, params.thread_id, params.conversationId, params.conversation_id]
        .find((id) => typeof id === "string" && id.trim()),
    );
    if (!threadId) return null;
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params.token_usage;
    if (!isRecord(tokenUsage)) return null;
    const usage = {};
    addBreakdown(usage, isRecord(tokenUsage.total) ? tokenUsage.total : undefined);
    const last = isRecord(tokenUsage.last)
      ? tokenUsage.last
      : isRecord(tokenUsage.last_turn) ? tokenUsage.last_turn : undefined;
    const contextUsedTokens = pickNumber(last, "totalTokens", "total_tokens");
    const contextWindowTokens = pickNumber(tokenUsage, "modelContextWindow", "model_context_window");
    if (contextUsedTokens !== undefined && contextWindowTokens !== undefined && contextWindowTokens > 0) {
      usage.contextUsedTokens = contextUsedTokens;
      usage.contextWindowTokens = contextWindowTokens;
    }
    const inputTokens = pickNumber(last, "inputTokens", "input_tokens");
    const cachedInputTokens = pickNumber(last, "cachedInputTokens", "cached_input_tokens");
    if (inputTokens !== undefined && cachedInputTokens !== undefined && inputTokens > 0) {
      usage.cacheHitRatePercent = Math.min(100, (cachedInputTokens / inputTokens) * 100);
    }
    addBreakdown(usage, last);
    if (inputTokens !== undefined) {
      usage.lastInputTokens = inputTokens;
      usage.lastCachedInputTokens = cachedInputTokens;
      usage.lastOutputTokens = pickNumber(last, "outputTokens", "output_tokens");
      // 与会话记录的最近一次请求比对后才采用其时间。
      usage.lastRequest = {
        inputTokens,
        cachedInputTokens,
        outputTokens: usage.lastOutputTokens,
        threadTotalTokens: pickNumber(
          isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage.total_token_usage,
          "totalTokens",
          "total_tokens",
        ),
      };
    }
    if (Object.keys(usage).length === 0) return null;
    return { threadId, usage };
  };

  // 会话记录追上通知即可采用：同一次请求，或会话总量已超过通知（别处发起的一轮）。
  // 会话总量可能重置，只能证明“超前”，不能证明“相等”。
  const requestMatchesUsage = (request, usage) => {
    const expected = usage?.lastRequest;
    if (!expected) return true;
    const recorded = request?.lastTokenUsage || {};
    const sameRequest = ["inputTokens", "cachedInputTokens", "outputTokens"].every((key) => (
      expected[key] === undefined || recorded[key] === expected[key]
    ));
    const ahead = Number.isFinite(request?.threadTotalTokens)
      && expected.threadTotalTokens !== undefined
      && request.threadTotalTokens > expected.threadTotalTokens;
    return sameRequest || ahead;
  };

  // 每次读到统计都重新核对锚点；只有收到通知后才计重读次数，用尽后记为未知。
  const resolveCacheAnchor = (threadId, result) => {
    const ok = result?.status === "ok";
    if (ok && result.stats == null) {
      // 没有本地会话记录的会话重读也不会出现记录。
      cacheAnchorByThread.set(threadId, { status: "unknown", reason: "no-rollout" });
      anchorAttempts.delete(threadId);
      return;
    }
    const request = ok ? result.stats.lastModelRequest : null;
    if (
      request
      && Number.isFinite(request.requestedAt)
      && requestMatchesUsage(request, usageByThread.get(threadId))
    ) {
      cacheAnchorByThread.set(threadId, { status: "ok", at: request.requestedAt, request });
      anchorAttempts.delete(threadId);
      return;
    }
    if (!anchorAttempts.has(threadId)) return;
    const attempts = anchorAttempts.get(threadId) + 1;
    if (attempts < cacheAnchorMaxAttempts) {
      anchorAttempts.set(threadId, attempts);
      return;
    }
    anchorAttempts.delete(threadId);
    const reason = !ok ? "failed" : request ? "mismatch" : "no-usage";
    if (!ok) console.warn("[Codey] conversation stats cache anchor read failed", result?.message || "");
    cacheAnchorByThread.set(threadId, { status: "unknown", reason });
  };

  const schedulePoll = (delay) => {
    if (disposed) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  };

  const pollInterval = () => anchorAttempts.has(currentSessionId) ? cacheAnchorRetryMs
    : stats?.lastTurn?.status === "running" || stats?.inFlight > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;

  const applyTokenUsage = (message) => {
    if (disposed) return false;
    const observed = observeTokenUsage(message);
    if (!observed) return false;
    usageByThread.set(observed.threadId, observed.usage);
    anchorAttempts.set(observed.threadId, 0);
    if (observed.threadId === currentSessionId) schedulePoll(0);
    render();
    return true;
  };

  const bindNotificationCallback = (target, callback) => {
    const add = target.addNotificationCallback.bind(target);
    const unsubscribers = [];
    const tryAdd = (...args) => {
      try {
        const unsubscribe = add(...args);
        if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
        return typeof unsubscribe === "function";
      } catch {
        return false;
      }
    };
    if (!tryAdd(tokenUsageNotificationMethod, callback)) {
      tryAdd(tokenUsageNotificationMethods, callback);
    }
    if (!unsubscribers.length) tryAdd(callback);
    if (!unsubscribers.length) return null;
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  };

  const notificationTargetFromValue = (value) => {
    if (isRpcManager(value)) return value;
    if (isRecord(value) && typeof value.addNotificationCallback === "function") return value;
    return isRecord(value?.requestClient)
      && typeof value.requestClient.addNotificationCallback === "function"
      ? value.requestClient
      : null;
  };

  const collectManagerNotificationTargets = (controller) => {
    if (controller?.kind !== "manager") return [];
    const manager = controller.manager;
    if (isRpcManager(manager)) return [manager];
    if (!isRecord(manager)) return [];
    const targets = [];
    const add = (candidate) => {
      const target = notificationTargetFromValue(candidate);
      if (target && !targets.includes(target)) targets.push(target);
    };
    add(manager);
    add(manager.requestClient);
    return targets;
  };

  const reactFiberFromNode = (node) => {
    if (!node) return null;
    const name = Object.getOwnPropertyNames(node).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    ));
    if (!name) return null;
    const fiber = Object.getOwnPropertyDescriptor(node, name)?.value;
    return fiber && (typeof fiber === "object" || typeof fiber === "function") ? fiber : null;
  };

  const findComposerFiber = (element) => {
    if (!element) return null;
    const descendants = typeof element.querySelectorAll === "function"
      ? [element, ...element.querySelectorAll("*")]
      : [element];
    for (const node of descendants) {
      const fiber = reactFiberFromNode(node);
      if (fiber) return fiber;
    }
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const fiber = reactFiberFromNode(ancestor);
      if (fiber) return fiber;
    }
    return null;
  };

  const collectFiberNotificationTargets = (element) => {
    const targets = [];
    let fiber = findComposerFiber(element);
    for (let depth = 0; fiber && depth < 200; depth += 1) {
      let hook = fiber.memoizedState;
      for (let hookIndex = 0; hook && hookIndex < 100; hookIndex += 1) {
        const target = notificationTargetFromValue(isRecord(hook) ? hook.memoizedState : null);
        if (target && !targets.includes(target)) targets.push(target);
        hook = isRecord(hook) && isRecord(hook.next) ? hook.next : null;
      }
      const parent = fiber.return;
      fiber = parent && (typeof parent === "object" || typeof parent === "function") ? parent : null;
    }
    return targets;
  };

  const bindRpcNotifications = async (target) => {
    const hostRequest = target.getHostId();
    let hostId;
    try {
      hostId = await withTimeout(hostRequest, 8_000, "读取用量订阅主机超时");
    } finally {
      hostRequest?.[Symbol.dispose]?.();
    }
    let stopped = disposed;
    let lease = null;
    let request = null;
    const release = () => {
      stopped = true;
      const resources = [lease, request];
      lease = null;
      request = null;
      for (const resource of resources) resource?.[Symbol.dispose]?.();
    };
    const onBroken = () => {
      if (stopped) return;
      release();
      boundNotificationTargets.delete(target);
      managerNotificationTargets.delete(target);
      sessionManagerBound = false;
      if (window.__codeyCodexSessionController?.manager === target) {
        window.__codeyCodexSessionController = null;
      }
      usageError = "用量订阅连接已断开";
      schedulePoll(0);
    };
    if (stopped) return null;
    try {
      request = target.subscribe({
        type: "notification",
        key: { hostId },
        methods: tokenUsageNotificationMethod,
        listener: (message) => { if (!stopped) applyTokenUsage(message); },
      });
      request.onRpcBroken?.(onBroken);
      await withTimeout(Promise.resolve(request).then((value) => {
        lease = value;
        if (stopped || disposed) release();
      }), 8_000, "订阅对话用量超时");
      if (stopped || disposed) return null;
      lease.onRpcBroken?.(onBroken);
      return stopped ? null : release;
    } catch (error) {
      release();
      throw error;
    }
  };

  const readStoredUsage = async (manager, threadId) => {
    if (!isRpcManager(manager)) {
      return (await manager.getConversation(threadId))?.latestTokenUsageInfo;
    }
    // RPC 属性管线只读取用量，不读取对话内容。
    const conversation = manager.getConversation(threadId);
    const usage = conversation.latestTokenUsageInfo;
    try {
      return await withTimeout(usage, 8_000, "读取历史对话用量超时");
    } finally {
      usage?.[Symbol.dispose]?.();
      conversation?.[Symbol.dispose]?.();
    }
  };

  // 进入会话时读取已保存的用量，历史会话不必等新通知就有上下文和费用。
  const refreshStoredUsage = (manager) => {
    const threadId = currentSessionId;
    if (!threadId || typeof manager?.getConversation !== "function") {
      usageSelection = null;
      return;
    }
    if (usageSelection?.threadId === threadId && usageSelection.manager === manager) return;
    const selection = { manager, threadId };
    usageSelection = selection;
    const previousUsage = usageByThread.get(threadId);
    void readStoredUsage(manager, threadId).then((tokenUsage) => {
      if (disposed || usageSelection !== selection) return;
      const message = { method: tokenUsageNotificationMethod, params: { threadId, tokenUsage } };
      const stored = tokenUsage ? observeTokenUsage(message) : null;
      storedUsageRead = stored ? "ok" : "empty";
      if (usageByThread.get(threadId) === previousUsage && stored) {
        usageError = null;
        applyTokenUsage(message);
      }
    }).catch((error) => {
      storedUsageRead = "failed";
      if (usageSelection === selection) usageError = "读取历史对话用量失败";
      console.warn("[Codey] conversation stats stored usage read failed", error);
    });
  };

  const bindNotificationTargets = async (targets) => {
    for (const target of targets) {
      if (boundNotificationTargets.has(target)) continue;
      const unsubscribe = isRpcManager(target)
        ? await bindRpcNotifications(target)
        : bindNotificationCallback(target, (message) => applyTokenUsage(message));
      if (!unsubscribe) continue;
      if (disposed) { unsubscribe(); continue; }
      boundNotificationTargets.set(target, unsubscribe);
      usageError = null;
    }
  };

  const releaseNotifications = () => {
    for (const unsubscribe of boundNotificationTargets.values()) unsubscribe();
    boundNotificationTargets.clear();
    managerNotificationTargets.clear();
    sessionManagerBound = false;
  };

  // composer 重建后旧 requestClient 不再出现，释放它们的订阅，保留会话管理器的共享订阅。
  const releaseStaleFiberTargets = (fiberTargets) => {
    for (const [target, unsubscribe] of [...boundNotificationTargets]) {
      if (managerNotificationTargets.has(target) || fiberTargets.includes(target)) continue;
      boundNotificationTargets.delete(target);
      unsubscribe();
    }
  };

  const collectPendingNotificationTargets = (controller, fiberTargets) => {
    const seen = new Set(boundNotificationTargets.keys());
    const targets = [];
    const addTarget = (target) => {
      if (!target || seen.has(target)) return;
      seen.add(target);
      targets.push(target);
    };
    const managerTargets = sessionManagerBound ? [] : collectManagerNotificationTargets(controller);
    for (const target of managerTargets) addTarget(target);
    for (const target of fiberTargets) addTarget(target);
    return { managerTargets, targets };
  };

  // 每次轮询都补订阅：会话管理器和 composer 的 requestClient 可能晚于脚本出现。
  const subscribeNotifications = (input) => {
    if (disposed) return null;
    if (notificationSubscribePromise) return notificationSubscribePromise;
    notificationSubscribePromise = (async () => {
      try {
        if (typeof window.__codeyLoadSessionTools === "function") {
          await window.__codeyLoadSessionTools();
        }
        let controller = null;
        let controllerError = "";
        if (typeof window.__codeyLoadCodexSessionController === "function") {
          try {
            controller = await window.__codeyLoadCodexSessionController();
          } catch (error) {
            controller = null;
            controllerError = String(error?.message || error || "");
          }
        }
        if (disposed) return;
        const fiberTargets = collectFiberNotificationTargets(input);
        releaseStaleFiberTargets(fiberTargets);
        const { managerTargets, targets } = collectPendingNotificationTargets(controller, fiberTargets);
        await bindNotificationTargets(targets);
        for (const target of managerTargets) {
          if (boundNotificationTargets.has(target)) managerNotificationTargets.add(target);
        }
        if (!boundNotificationTargets.size) {
          usageError = controllerError
            ? `未取得 Codex 会话管理器：${controllerError}`
            : "未找到对话用量通知入口";
        }
        if (managerTargets.some((target) => boundNotificationTargets.has(target))) {
          sessionManagerBound = true;
        }
        if (!disposed && controller?.kind === "manager") refreshStoredUsage(controller.manager);
      } finally {
        notificationSubscribePromise = null;
      }
    })().catch((error) => {
      usageError = "订阅对话用量失败";
      notificationSubscribePromise = null;
      console.warn("[Codey] conversation stats usage subscribe failed", error);
    });
    return notificationSubscribePromise;
  };

  const applyProviderSnapshot = (snapshot) => {
    const nextId = snapshot?.id;
    const nextProvider = typeof nextId === "string" && nextId.trim() ? nextId.trim() : "";
    if (!nextProvider) return;
    providerId = nextProvider;
    if (typeof snapshot.usesOfficialAccountAuth === "boolean") {
      providerUsesOfficialAuth = snapshot.usesOfficialAccountAuth;
    }
  };

  const textOrNull = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

  const loadAccountIdentity = async () => {
    try {
      const identity = await callBridge(accountIdentityPath);
      if (identity?.status !== "ok") throw new Error(identity?.message || "读取官方账号失败");
      accountIdentity = {
        loggedIn: identity.loggedIn === true,
        accountEmail: textOrNull(identity.accountEmail),
        providerName: textOrNull(identity.providerName),
        usesOfficialAccountAuth: typeof identity.usesOfficialAccountAuth === "boolean"
          ? identity.usesOfficialAccountAuth : null,
      };
    } catch (error) {
      // 账号行改用设置中的服务商信息，读不到时显示 —。
      accountIdentity = null;
      console.warn("[Codey] conversation stats account read failed", error);
    }
    render();
  };

  const loadSettings = async () => {
    try {
      const settings = await callBridge(settingsPath);
      applyProviderSnapshot(settings?.currentProviderSnapshot);
      cacheValidMinutes = normalizeCacheValidMinutes(settings?.cacheValidMinutes);
    } catch (error) {
      console.warn("[Codey] conversation stats settings read failed", error);
    }
    render();
  };

  const poll = async () => {
    if (disposed) return;
    if (document.visibilityState === "hidden") {
      schedulePoll(POLL_IDLE_MS);
      return;
    }
    const { anchor, sessionId } = resolveSessionContext();
    if (sessionId !== currentSessionId) {
      resetSession(sessionId);
      render(anchor);
    }
    void subscribeNotifications(visibleComposerInput(anchor));
    if (!currentSessionId) {
      schedulePoll(POLL_IDLE_MS);
      return;
    }
    if (!fetchInFlight) {
      fetchInFlight = true;
      render(anchor);
      const requestSessionId = currentSessionId;
      const requestGeneration = sessionGeneration;
      let completedContext = null;
      try {
        const result = await callBridge("/session/stats", { sessionId: requestSessionId });
        if (disposed) return;
        completedContext = resolveSessionContext();
        if (requestGeneration !== sessionGeneration || completedContext.sessionId !== requestSessionId) return;
        fetchAttempted = true;
        lastResult = result ?? null;
        if (result?.status === "ok") {
          lastFetchOk = true;
          stats = result.stats ?? null;
        } else {
          lastFetchOk = false;
        }
        resolveCacheAnchor(requestSessionId, result);
      } catch (error) {
        if (!disposed) completedContext = resolveSessionContext();
        if (!disposed && requestGeneration === sessionGeneration && completedContext.sessionId === requestSessionId) {
          fetchAttempted = true;
          lastFetchOk = false;
          resolveCacheAnchor(requestSessionId, { status: "failed", message: String(error?.message || error) });
        }
      } finally {
        fetchInFlight = false;
        if (!disposed) {
          completedContext ||= resolveSessionContext();
          schedulePoll(requestGeneration !== sessionGeneration || completedContext.sessionId !== requestSessionId ? 0 : pollInterval());
        }
      }
      render(completedContext?.anchor);
      return;
    }
    schedulePoll(pollInterval());
  };

  const scheduleRescan = () => {
    if (disposed || rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      const { anchor, sessionId } = resolveSessionContext();
      const changed = sessionId !== currentSessionId;
      if (changed) {
        resetSession(sessionId);
      }
      render(anchor);
      // 会话切换立即拉取，不等下一轮轮询。
      if (changed && currentSessionId) schedulePoll(0);
    }, RESCAN_DEBOUNCE_MS);
  };

  const mutationHandler = (mutations) => {
    for (const mutation of mutations || []) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (!(target instanceof HTMLElement)) continue;
        if (containsStats(target)) continue;
        if (
          target.hasAttribute?.(conversationAttribute)
          || target.hasAttribute?.("hidden")
          || target.hasAttribute?.("aria-hidden")
        ) {
          scheduleRescan();
          return;
        }
        continue;
      }
      const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id === overlayId) { scheduleRescan(); continue; }
        if (node.closest?.(`#${overlayId}`)) continue;
        if (node.id === barId || node.closest?.(`#${barId}`) || node.querySelector?.(`#${barId}`)) {
          // 状态条自身被移除时也要尽快重挂。
          if (node.id === barId || node.querySelector?.(`#${barId}`)) scheduleRescan();
          continue;
        }
        if (
          node.matches?.(sessionAttributeSelector)
          || node.querySelector?.(sessionAttributeSelector)
          || node.querySelector?.(activeThreadSelector)
        ) {
          scheduleRescan();
          return;
        }
        // 会话容器子树变化一律重扫，代价只是一次 debounce 查询。
        if (node.querySelector?.("[contenteditable='true'], textarea")) {
          scheduleRescan();
          return;
        }
      }
    }
  };

  const bootstrap = () => {
    ensureStyle();
    render();
    const options = {
      attributes: true,
      attributeFilter: [
        conversationAttribute,
        "data-app-action-sidebar-thread-active",
        "hidden",
        "aria-hidden",
      ],
      childList: true,
      subtree: true,
    };
    const dispatcher = window.__codeyMutationDispatcher;
    if (typeof dispatcher?.subscribe === "function") {
      const unsubscribe = dispatcher.subscribe(mutationHandler, options);
      if (dispatcher.snapshot?.().observerInstalled) {
        window.__codeyConversationStatsObserver = { disconnect: unsubscribe };
      } else {
        unsubscribe?.();
      }
    }
    if (!window.__codeyConversationStatsObserver) {
      const observer = new MutationObserver(mutationHandler);
      observer.observe(document.documentElement, options);
      window.__codeyConversationStatsObserver = observer;
    }
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(cacheTimer);
        cacheTimer = 0;
        return;
      }
      renderCacheRemaining();
      schedulePoll(0);
    });
    listen(window, "focus", () => {
      if (usageError) usageSelection = null;
      schedulePoll(0);
      void loadAccountIdentity();
    });
    listen(window, "pageshow", () => schedulePoll(0));
    listen(window, configChangedEvent, (event) => {
      const nextMinutes = event?.detail?.config?.cacheValidMinutes;
      if (nextMinutes !== undefined) cacheValidMinutes = normalizeCacheValidMinutes(nextMinutes);
      applyProviderSnapshot(event?.detail?.currentProviderSnapshot);
      render();
      void loadSettings();
      void loadAccountIdentity();
    });
    listen(window, "resize", positionPanel);
    listen(document, "scroll", positionPanel, true);
    listen(document, "pointerdown", (event) => {
      if (statsElement && !containsStats(event.target)) setExpanded(false);
    });
    listen(document, "keydown", (event) => {
      if (event.key !== "Escape" || !statsElement?.__codeyCs?.active) return;
      const focusedInside = containsStats(document.activeElement);
      setExpanded(false, focusedInside);
      if (focusedInside) { event.preventDefault(); event.stopPropagation(); }
    });
    void loadSettings();
    void loadAccountIdentity();
    schedulePoll(0);
    window[PROBE_KEY] = {
      installed: true,
      version: VERSION,
      snapshot: () => {
        const anchor = cacheAnchorByThread.get(currentSessionId);
        return {
          sessionId: currentSessionId,
          anchorFound: Boolean(findVisibleComposerAnchor()),
          mounted: statsElement?.isConnected === true,
          hidden: statsElement?.hidden !== false,
          stats,
          lastFetchOk,
          lastResult,
          subscribed: boundNotificationTargets.size > 0,
          usageError,
          storedUsageRead,
          hasUsage: usageByThread.has(currentSessionId),
          cacheAnchor: !anchor ? "" : anchor.status === "ok" ? "ok" : `unknown:${anchor.reason}`,
        };
      },
      refresh: () => schedulePoll(0),
      applyNotification: (message) => applyTokenUsage(message),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        sessionGeneration += 1;
        clearTimeout(pollTimer);
        clearTimeout(rescanTimer);
        clearTimeout(cacheTimer);
        setExpanded(false);
        releaseNotifications();
        window.__codeyConversationStatsObserver?.disconnect?.();
        delete window.__codeyConversationStatsObserver;
        listeners.splice(0).forEach(remove => remove());
        statsElement?.__codeyCs?.overlay.remove();
        statsElement?.remove();
        document.getElementById(styleId)?.remove();
        window[PROBE_KEY].installed = false;
      },
    };
  };

  try {
    bootstrap();
  } catch (error) {
    // 同步引导失败不置 installed，CDP 会按 probe 重新注入。
    console.warn("[Codey] conversation stats bootstrap failed", error);
  }
})();
