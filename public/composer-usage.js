// Composer chips for thread usage and ChatGPT account credits.
// Token counts come from Codex `thread/tokenUsage/updated`. Account credits
// stay on `/account/usage` with `account/rateLimits/read` as fallback.
// Subscribe on AppServerManager, its requestClient, and the composer fiber
// requestClient. Copy host chip chrome and the SVG ring only. Keep Codey's
// product contract: 5h/7d labels, plan + Credits balance, CH → context% → 用量,
// hide usage until token data, and never invent unit prices.
(() => {
  const moduleLoaded = window.__codeyComposerUsageModuleLoaded === true;
  window.__codeyComposerUsageModuleLoaded = true;
  if (moduleLoaded && window.__codeyComposerUsage) return;

  const settingsPath = "/settings/get";
  const accountUsagePath = "/account/usage";
  const styleId = "codey-composer-usage-style";
  const usageRootId = "codey-thread-usage";
  const creditsRootId = "codey-account-credits";
  const usagePopoverId = "codey-thread-usage-popover";
  const creditsPopoverId = "codey-account-credits-popover";
  const configChangedEvent = "codey:config-changed";
  const injectionStatusId = "composer-usage";
  const injectionStatusChangedEvent = "codey-injection-status-changed";
  const accountUsageRefreshIntervalMs = 60_000;
  const accountUsageTimeoutMs = 8_000;
  const composerAnchorSelector = "[data-above-composer-conversation-id]";
  const composerCandidateSelector =
    "textarea, [contenteditable='true'], [role='textbox']";
  const composerFallbackSelector =
    "main textarea, main [contenteditable='true'], main [role='textbox'], textarea, [contenteditable='true'][role='textbox']";
  const composerControlSelector = "button, [role='button']";
  const ignoredComposerContainerSelector =
    "dialog, [role='dialog'], [aria-modal='true']";
  const ignoredControlContainerSelector =
    `${ignoredComposerContainerSelector}, [role='menu'], [role='listbox'], ` +
    "[cmdk-list], [data-radix-popper-content-wrapper]";

  let ready = false;
  let providerId = "";
  let accountLabel = "";
  let creditsResult = null;
  let creditsPollingEnabled = true;
  let creditsCheckInFlight = false;
  let creditsTimer = 0;
  let usageByThread = new Map();
  let inputElement = null;
  let usageRoot = null;
  let creditsRoot = null;
  let usagePopover = null;
  let creditsPopover = null;
  let usageOpen = false;
  let creditsOpen = false;
  let usageCloseTimer = 0;
  let creditsCloseTimer = 0;
  let scanTimer = 0;
  let observer = null;
  let unsubscribeMutations = null;
  let unsubscribeNotifications = null;
  let notificationSubscribePromise = null;
  let sessionManagerBound = false;
  const boundNotificationTargets = new Set();
  const notificationUnsubscribers = [];

  const publishInjectionStatus = (detail) => {
    const entry = window.__codeyInjectionStatus?.[injectionStatusId];
    if (!entry || entry.status === "pending") return;
    const status = ready ? "effective" : "inactive";
    if (entry.status === status && entry.detail === detail && !entry.error) return;
    entry.status = status;
    entry.detail = detail;
    entry.error = null;
    if (
      typeof window.dispatchEvent === "function"
      && typeof window.CustomEvent === "function"
    ) {
      window.dispatchEvent(new window.CustomEvent(injectionStatusChangedEvent, {
        detail: { id: injectionStatusId, status },
      }));
    }
  };

  const callBridge = (path, payload = {}, options = {}) => {
    if (typeof window.__codexSessionDeleteBridge === "function") {
      return window.__codexSessionDeleteBridge(path, payload, options);
    }
    return Promise.reject(new Error("Codey bridge 尚未就绪"));
  };

  const withTimeout = (promise, ms, message) => {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  };

  const isRecord = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const nonNegativeNumber = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

  const normalizeThreadId = (value) => {
    const id = typeof value === "string" ? value.trim() : "";
    return id ? id.replace(/^local:/, "") : "";
  };

  const pickNumber = (source, ...keys) => {
    if (!isRecord(source)) return undefined;
    for (const key of keys) {
      const value = nonNegativeNumber(source[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const escapeText = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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

  const formatCacheHit = (value) => `CH ${decimal(value, 1)}%`;

  const remainingPercent = (usedPercent) =>
    Math.min(100, Math.max(0, 100 - Number(usedPercent)));

  const creditsTone = (usedPercent) => {
    if (usedPercent >= 90) return "hot";
    if (usedPercent >= 70) return "warn";
    return "ok";
  };

  const toneColor = (tone) => {
    if (tone === "hot") return "#c45c4a";
    if (tone === "warn") return "#c9a227";
    return "#3d9a64";
  };

  const formatCreditsPercent = (value) => `${decimal(value, 1)}%`;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const tokenUsageNotificationMethod = "thread/tokenUsage/updated";
  const tokenUsageNotificationMethods = [tokenUsageNotificationMethod];
  const tokenUsageFields = [
    ["totalTokens", "total_tokens"],
    ["inputTokens", "input_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
    ["cacheWriteInputTokens", "cache_write_input_tokens"],
    ["outputTokens", "output_tokens"],
    ["reasoningOutputTokens", "reasoning_output_tokens"],
    ["totalCostUsd", "total_cost_usd"],
    ["totalCredits", "total_credits"],
    ["outputTokensPerSecond", "output_tokens_per_second"],
  ];

  const createUsageRing = (percent, options) => {
    const size = options.size;
    const strokeWidth = options.strokeWidth;
    const color = options.color;
    const trackColor = options.trackColor
      ?? "color-mix(in srgb, currentColor 18%, transparent)";
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.min(100, Math.max(0, percent));
    const offset = circumference * (1 - clamped / 100);
    const center = size / 2;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("aria-hidden", "true");
    svg.style.display = "block";
    svg.style.flex = "0 0 auto";
    svg.style.transform = "rotate(-90deg)";
    const track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("cx", String(center));
    track.setAttribute("cy", String(center));
    track.setAttribute("r", String(radius));
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", trackColor);
    track.setAttribute("stroke-width", String(strokeWidth));
    const fill = document.createElementNS(SVG_NS, "circle");
    fill.setAttribute("cx", String(center));
    fill.setAttribute("cy", String(center));
    fill.setAttribute("r", String(radius));
    fill.setAttribute("fill", "none");
    fill.setAttribute("stroke", color);
    fill.setAttribute("stroke-width", String(strokeWidth));
    fill.setAttribute("stroke-linecap", "round");
    fill.setAttribute("stroke-dasharray", String(circumference));
    fill.setAttribute("stroke-dashoffset", String(offset));
    svg.append(track, fill);
    return svg;
  };

  const applyPopoverChrome = (popover) => {
    popover.style.border =
      "1px solid light-dark(rgba(15, 23, 42, 0.10), color-mix(in srgb, CanvasText 16%, transparent))";
    popover.style.borderRadius = "14px";
    popover.style.backgroundColor =
      "light-dark(Canvas, color-mix(in srgb, Canvas 88%, white 12%))";
    popover.style.color = "CanvasText";
    popover.style.boxShadow =
      "light-dark(0 10px 24px rgba(15, 23, 42, 0.12), 0 20px 45px rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";
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
    if (isRecord(value) && typeof value.addNotificationCallback === "function") return value;
    return isRecord(value?.requestClient)
      && typeof value.requestClient.addNotificationCallback === "function"
      ? value.requestClient
      : null;
  };

  const collectManagerNotificationTargets = (controller) => {
    if (controller?.kind !== "manager" || !isRecord(controller.manager)) return [];
    const manager = controller.manager;
    const targets = [];
    const add = (candidate) => {
      const target = notificationTargetFromValue(candidate);
      if (target && !targets.includes(target)) targets.push(target);
    };
    add(manager);
    add(manager.requestClient);
    return targets;
  };

  const reactFiberName = (node) => {
    if (!node) return "";
    return Object.getOwnPropertyNames(node).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    )) || "";
  };

  const reactFiberFromNode = (node) => {
    const name = reactFiberName(node);
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
      fiber = parent && (typeof parent === "object" || typeof parent === "function")
        ? parent
        : null;
    }
    return targets;
  };

  const windowKind = (window) => {
    const minutes = Number(window?.windowMinutes);
    if (!Number.isFinite(minutes) || !Number.isFinite(Number(window?.usedPercent))) {
      return null;
    }
    if (minutes >= 6 * 24 * 60 && minutes <= 8 * 24 * 60) return "seven-day";
    if (minutes >= 270 && minutes <= 330) return "five-hour";
    return null;
  };

  const windowLabel = (kind) => {
    if (kind === "five-hour") return "5 小时额度";
    if (kind === "seven-day") return "7 天额度";
    return "账号额度";
  };

  const planLabel = (planType) => {
    const raw = String(planType || "").trim();
    if (!raw) return "";
    const compact = raw.toLowerCase().replace(/[\s_$-]+/g, "");
    if (compact === "5x" || compact.includes("pro5x") || compact.includes("pro100")) {
      return "Pro 5x";
    }
    if (compact === "pro" || compact.includes("pro20x") || compact.includes("pro200")) {
      return "Pro 20x";
    }
    if (compact.includes("plus")) return "Plus";
    if (compact.includes("free")) return "Free";
    return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
  };

  const resetTimeLabel = (resetsAt) => {
    const timestamp = Number(resetsAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const resetAt = new Date(timestamp * 1000);
    if (Number.isNaN(resetAt.getTime())) return "";
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfResetDay = new Date(
      resetAt.getFullYear(),
      resetAt.getMonth(),
      resetAt.getDate(),
    ).getTime();
    const dayOffset = Math.round((startOfResetDay - startOfToday) / (24 * 60 * 60 * 1000));
    const time = resetAt.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (dayOffset === 0) return `今天 ${time} 重置`;
    if (dayOffset === 1) return `明天 ${time} 重置`;
    return `${resetAt.getMonth() + 1}月${resetAt.getDate()}日 ${time} 重置`;
  };

  const creditsBalanceLabel = (credits) => {
    if (!credits) return "";
    if (credits.unlimited) return "不限";
    if (credits.balance !== undefined && credits.balance !== null) return String(credits.balance);
    return credits.hasCredits ? "可用" : "0";
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
    const threadId = normalizeThreadId(
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
    const contextWindowTokens = pickNumber(
      tokenUsage,
      "modelContextWindow",
      "model_context_window",
    );
    if (
      contextUsedTokens !== undefined
      && contextWindowTokens !== undefined
      && contextWindowTokens > 0
    ) {
      usage.contextUsedTokens = contextUsedTokens;
      usage.contextWindowTokens = contextWindowTokens;
    }
    const inputTokens = pickNumber(last, "inputTokens", "input_tokens");
    const cachedInputTokens = pickNumber(last, "cachedInputTokens", "cached_input_tokens");
    if (inputTokens !== undefined && cachedInputTokens !== undefined && inputTokens > 0) {
      usage.cacheHitRatePercent = Math.min(100, (cachedInputTokens / inputTokens) * 100);
    }
    addBreakdown(usage, last);
    if (Object.keys(usage).length === 0) return null;
    return { threadId, usage };
  };

  const usageHasDisplayData = (usage) => {
    if (!usage) return false;
    return [
      usage.cacheHitRatePercent,
      usage.contextUsedTokens,
      usage.contextWindowTokens,
      usage.totalTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.cacheWriteInputTokens,
      usage.reasoningOutputTokens,
    ].some((value) => value !== undefined);
  };

  const usageChipLabel = (usage) => {
    if (usage?.cacheHitRatePercent !== undefined) {
      return formatCacheHit(usage.cacheHitRatePercent);
    }
    if (
      usage?.contextUsedTokens !== undefined
      && usage.contextWindowTokens
      && usage.contextWindowTokens > 0
    ) {
      return `${decimal((usage.contextUsedTokens / usage.contextWindowTokens) * 100, 1)}%`;
    }
    return "用量";
  };

  const accountIdentity = () => accountLabel || providerId || "未登录";

  const addStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .codey-trigger-chip {
        -webkit-app-region: no-drag !important;
        pointer-events: auto !important;
        display: none;
        flex: 0 0 auto;
        align-items: center;
        align-self: center;
        justify-content: center;
        box-sizing: border-box;
        height: 28px;
        margin: 0;
        padding: 0 8px;
        border: 0;
        border-radius: 9999px;
        background: transparent;
        color: inherit;
        white-space: nowrap;
        font: 12px/16px system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
        cursor: pointer;
        user-select: none;
        vertical-align: middle;
      }
      .codey-trigger-chip:hover:not(:disabled) {
        background: rgba(127, 127, 127, 0.08);
      }
      .codey-trigger-chip:active:not(:disabled) {
        background: rgba(127, 127, 127, 0.16);
      }
      .codey-trigger-chip[data-state="open"] {
        background: rgba(127, 127, 127, 0.08);
      }
      #${usageRootId} {
        gap: 4px;
        width: fit-content;
        max-width: min(180px, 30vw);
        color: var(--color-text-tertiary, #8f8f8f);
      }
      #${creditsRootId} {
        gap: 5px;
        width: fit-content;
        max-width: min(72px, 18vw);
      }
      #${creditsRootId} [data-codey-credits-ring] {
        display: inline-flex;
        flex: 0 0 auto;
      }
      #${usagePopoverId}[hidden], #${creditsPopoverId}[hidden] { display: none !important; }
      #${usagePopoverId} [data-codey-usage-title],
      #${creditsPopoverId} [data-codey-credits-title] { font-size: 12.5px; font-weight: 600; }
      #${usagePopoverId} [data-codey-usage-title] { margin-bottom: 6px; }
      #${creditsPopoverId} [data-codey-credits-header] { margin-bottom: 11px; }
      #${usagePopoverId} [data-codey-usage-row] {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 20px;
        padding: 4px 0;
      }
      #${creditsPopoverId} [data-codey-credits-meta] {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 5px;
      }
      #${usagePopoverId} [data-codey-usage-row] span:first-child,
      #${creditsPopoverId} [data-codey-credits-reset] {
        color: color-mix(in srgb, currentColor 62%, transparent);
      }
      #${usagePopoverId} [data-codey-usage-row] span:first-child {
        color: color-mix(in srgb, currentColor 68%, transparent);
      }
      #${usagePopoverId} [data-codey-usage-row] span:last-child {
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
      }
      #${creditsPopoverId} [data-codey-credits-remaining] {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
        white-space: nowrap;
        font-size: 26px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--codey-credits-tone);
      }
      #${creditsPopoverId} [data-codey-credits-remaining] small {
        font-size: 11px;
        font-weight: 600;
        opacity: .8;
      }
      #${creditsPopoverId} [data-codey-credits-bar] {
        height: 6px;
        overflow: hidden;
        border-radius: 9999px;
        background: color-mix(in srgb, currentColor 16%, transparent);
      }
      #${creditsPopoverId} [data-codey-credits-bar] > span {
        display: block;
        height: 100%;
        width: calc(var(--codey-credits-remaining) * 1%);
        border-radius: inherit;
        background: var(--codey-credits-tone);
      }
      #${creditsPopoverId} [data-codey-credits-tile] { margin-bottom: 11px; }
      #${creditsPopoverId} [data-codey-credits-tile]:last-of-type { margin-bottom: 0; }
      #${creditsPopoverId} [data-codey-credits-plan] {
        display: inline-block;
        margin-left: 6px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 4px;
        padding: 0 4px;
        font-size: 10px;
        font-weight: 700;
      }
    `;
    document.documentElement.appendChild(style);
  };

  const isComposerInput = (element) => {
    if (!element) return false;
    if (element.tagName === "TEXTAREA") return true;
    if (element.isContentEditable === true) return true;
    if (element.getAttribute?.("contenteditable") === "true") return true;
    return element.getAttribute?.("role") === "textbox";
  };

  const isVisible = (element) => {
    if (!isComposerInput(element)) return false;
    if (element.closest?.(ignoredComposerContainerSelector)) return false;
    if (element.closest?.("[hidden], [aria-hidden='true']")) return false;
    if (element.disabled || element.readOnly) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isVisibleControl = (element) => {
    if (!element) return false;
    if (element === usageRoot || element === creditsRoot) return false;
    if (element.id === "codey-prompt-optimize-button") return false;
    if (element.closest?.(ignoredControlContainerSelector)) return false;
    if (element.closest?.("[hidden], [aria-hidden='true']")) return false;
    if (element.disabled) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const controlDescriptor = (element) =>
    [
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("data-testid"),
      element?.textContent,
      element?.innerText,
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  const controlIsNearInput = (control, inputRect) => {
    const rect = control.getBoundingClientRect();
    if (rect.bottom <= inputRect.top) return false;
    const controlMiddle = rect.top + rect.height / 2;
    const inputMiddle = inputRect.top + inputRect.height / 2;
    return Math.abs(controlMiddle - inputMiddle) <= Math.max(96, inputRect.height);
  };

  const controlLooksLikeComposerAction = (control) =>
    /(^|[^a-z])(model|send|submit|attach|upload|microphone|mic|voice|full access)([^a-z]|$)|模型|发送|提交|附件|上传|语音|麦克风|完全访问/i.test(
      controlDescriptor(control),
    );

  const hasComposerActionContext = (element) => {
    if (!element?.parentElement) return false;
    const inputRect = element.getBoundingClientRect();
    let scope = element.parentElement;
    let depth = 0;
    while (scope && depth < 6) {
      const controls = [...(scope.querySelectorAll?.(composerControlSelector) || [])];
      if (controls.some((control) =>
        isVisibleControl(control)
        && controlIsNearInput(control, inputRect)
        && controlLooksLikeComposerAction(control)
      )) return true;
      scope = scope.parentElement;
      depth += 1;
    }
    return false;
  };

  const findComposerInput = () => {
    const seen = new Set();
    for (const anchor of document.querySelectorAll(composerAnchorSelector)) {
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      const scope = anchor.parentElement || anchor;
      for (const candidate of scope.querySelectorAll(composerCandidateSelector)) {
        if (isVisible(candidate)) return candidate;
      }
    }
    let best = null;
    let bestScore = -1;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    for (const candidate of document.querySelectorAll(composerFallbackSelector)) {
      if (!isVisible(candidate) || !hasComposerActionContext(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      if (viewportHeight > 0 && (rect.bottom <= 0 || rect.top >= viewportHeight)) continue;
      const score = Math.max(0, rect.bottom) * 10_000 + Math.min(rect.width * rect.height, 9_999_999);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  };

  const conversationIdFromNode = (node) => {
    if (!node?.getAttribute) return "";
    for (const name of [
      "data-above-composer-conversation-id",
      "data-conversation-id",
      "data-thread-id",
      "data-session-id",
    ]) {
      const id = normalizeThreadId(node.getAttribute(name));
      if (id) return id;
    }
    return "";
  };

  const findComposerConversationId = (element) => {
    if (!element) return null;
    for (const anchor of document.querySelectorAll(composerAnchorSelector)) {
      const scope = anchor.parentElement || anchor;
      if (scope === element || scope.contains?.(element)) {
        const conversationId = conversationIdFromNode(anchor);
        if (conversationId) return conversationId;
      }
    }
    for (let node = element; node; node = node.parentElement) {
      const conversationId = conversationIdFromNode(node);
      if (conversationId) return conversationId;
    }
    return normalizeThreadId(
      document.querySelector?.('[data-app-action-sidebar-thread-active="true"]')
        ?.getAttribute?.("data-app-action-sidebar-thread-id"),
    ) || null;
  };

  const unwrapSingleton = (control) => {
    let anchor = control;
    let host = control.parentElement;
    while (host?.parentElement && host.children?.length === 1) {
      anchor = host;
      host = host.parentElement;
    }
    if (!host?.insertBefore) return null;
    return { anchor, host };
  };

  const modelControlScore = (control, inputRect) => {
    const rect = control.getBoundingClientRect();
    if (rect.bottom <= inputRect.top) return Number.NEGATIVE_INFINITY;
    if (!controlIsNearInput(control, inputRect)) return Number.NEGATIVE_INFINITY;
    const descriptor = controlDescriptor(control);
    const visibleText = [control.textContent, control.innerText]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const hasModelHint = /(^|[^a-z])model([^a-z]|$)|模型/i.test(descriptor);
    const hasModelValueHint =
      /(^|[^a-z])(gpt|codex|claude|gemini|grok|llama|luna|qwen|deepseek|mistral|sonnet|opus|haiku|mini|sol|low|medium|high|xhigh|auto)([^a-z]|$)|\bo\d+\b|\d+(?:\.\d+)?|低|中|高|极高|轻|自动/i.test(
        visibleText,
      );
    if (!hasModelHint && !hasModelValueHint) return Number.NEGATIVE_INFINITY;
    if (!hasModelHint && /完全访问|full access|附件|attach|上传|upload|优化/i.test(descriptor)) {
      return Number.NEGATIVE_INFINITY;
    }
    if (
      !hasModelHint
      && inputRect.width > 0
      && rect.right < inputRect.left + inputRect.width * 0.45
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    return (
      (hasModelHint ? 1_000_000 : 0)
      + (control.getAttribute?.("aria-haspopup") ? 100_000 : 0)
      + Math.max(0, rect.right) * 10
      + Math.min(rect.width, 500)
    );
  };

  const findModelInsertionTarget = () => {
    if (!inputElement?.parentElement) return null;
    const inputRect = inputElement.getBoundingClientRect();
    const seen = new Set();
    let bestControl = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let scope = inputElement.parentElement;
    let depth = 0;
    while (scope && depth < 8) {
      for (const control of scope.querySelectorAll?.(composerControlSelector) || []) {
        if (inputElement.contains?.(control) || seen.has(control) || !isVisibleControl(control)) {
          continue;
        }
        seen.add(control);
        const score = modelControlScore(control, inputRect);
        if (score > bestScore) {
          bestControl = control;
          bestScore = score;
        }
      }
      if (bestScore >= 1_000_000) break;
      scope = scope.parentElement;
      depth += 1;
    }
    return bestControl ? unwrapSingleton(bestControl) : null;
  };

  const findContextInsertionTarget = () => {
    if (!inputElement?.parentElement) return null;
    const inputRect = inputElement.getBoundingClientRect();
    let scope = inputElement.parentElement;
    let depth = 0;
    while (scope && depth < 8) {
      for (const node of scope.querySelectorAll?.("span[role='img'], span[role=img]") || []) {
        const label = String(node.getAttribute?.("aria-label") || "");
        if (!/context|上下文|%/i.test(label)) continue;
        const wrapper = node.parentElement;
        if (!wrapper || !controlIsNearInput(wrapper, inputRect)) continue;
        return unwrapSingleton(wrapper);
      }
      scope = scope.parentElement;
      depth += 1;
    }
    return null;
  };

  const findPermissionInsertionTarget = () => {
    if (!inputElement?.parentElement) return null;
    const inputRect = inputElement.getBoundingClientRect();
    const seen = new Set();
    let scope = inputElement.parentElement;
    let depth = 0;
    while (scope && depth < 8) {
      for (const control of scope.querySelectorAll?.(composerControlSelector) || []) {
        if (seen.has(control) || !isVisibleControl(control)) continue;
        seen.add(control);
        if (!controlIsNearInput(control, inputRect)) continue;
        if (!/完全访问|full access/i.test(controlDescriptor(control))) continue;
        return unwrapSingleton(control);
      }
      scope = scope.parentElement;
      depth += 1;
    }
    return null;
  };

  const isMountedBefore = (element, anchor, host) => {
    if (element?.parentElement !== host) return false;
    const children = [...(host.children || [])];
    return children.indexOf(element) + 1 === children.indexOf(anchor);
  };

  const placeBefore = (element, target) => {
    if (!element || !target) return false;
    if (isMountedBefore(element, target.anchor, target.host)) return true;
    target.host.insertBefore(element, target.anchor);
    return true;
  };

  const createChip = (id, ariaLabel) => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "codey-trigger-chip";
    button.setAttribute("aria-label", ariaLabel);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "dialog");
    return button;
  };

  const createPopover = (id, label) => {
    const popover = document.createElement("div");
    popover.id = id;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", label);
    popover.hidden = true;
    popover.style.position = "fixed";
    popover.style.inset = "auto";
    popover.style.boxSizing = "border-box";
    popover.style.margin = "0";
    popover.style.padding = "10px 12px";
    popover.style.font = "13px/1.35 system-ui, -apple-system, \"PingFang SC\", \"Segoe UI\", sans-serif";
    popover.style.letterSpacing = "0";
    popover.style.zIndex = "2147483647";
    if (id === usagePopoverId) {
      popover.style.width = "260px";
      popover.style.maxWidth = "min(320px, calc(100vw - 24px))";
    } else {
      popover.style.width = "240px";
      popover.style.maxWidth = "min(280px, calc(100vw - 24px))";
    }
    applyPopoverChrome(popover);
    document.body.appendChild(popover);
    return popover;
  };

  const positionPopover = (trigger, popover) => {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(280, Math.max(220, (window.innerWidth || 800) - 24));
    const left = Math.max(12, Math.min(rect.left, (window.innerWidth || 800) - width - 12));
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.right = "auto";
    popover.style.top = "auto";
    popover.style.bottom = `${Math.max(12, (window.innerHeight || 800) - rect.top + 8)}px`;
  };

  const setPopoverOpen = (kind, open) => {
    const trigger = kind === "usage" ? usageRoot : creditsRoot;
    const popover = kind === "usage" ? usagePopover : creditsPopover;
    if (!trigger || !popover) return;
    if (kind === "usage") usageOpen = open;
    else creditsOpen = open;
    popover.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) positionPopover(trigger, popover);
  };

  const bindChipPopover = (kind, trigger, popover) => {
    const cancelClose = () => {
      if (kind === "usage") {
        window.clearTimeout(usageCloseTimer);
        usageCloseTimer = 0;
      } else {
        window.clearTimeout(creditsCloseTimer);
        creditsCloseTimer = 0;
      }
    };
    const scheduleClose = () => {
      cancelClose();
      const timer = window.setTimeout(() => setPopoverOpen(kind, false), 140);
      if (kind === "usage") usageCloseTimer = timer;
      else creditsCloseTimer = timer;
    };
    trigger.addEventListener("click", () => {
      cancelClose();
      const open = kind === "usage" ? !usageOpen : !creditsOpen;
      setPopoverOpen(kind, open);
      if (open && kind === "credits") void checkAccountUsage();
    });
    trigger.addEventListener("pointerenter", () => {
      cancelClose();
      setPopoverOpen(kind, true);
      if (kind === "credits") void checkAccountUsage();
    });
    trigger.addEventListener("pointerleave", scheduleClose);
    trigger.addEventListener("focus", () => {
      cancelClose();
      setPopoverOpen(kind, true);
    });
    trigger.addEventListener("blur", scheduleClose);
    popover.addEventListener("pointerenter", cancelClose);
    popover.addEventListener("pointerleave", scheduleClose);
  };

  const ensureChips = () => {
    addStyle();
    if (!usageRoot) {
      usageRoot = createChip(usageRootId, "对话用量详情");
      usagePopover = createPopover(usagePopoverId, "对话用量详情");
      bindChipPopover("usage", usageRoot, usagePopover);
    }
    if (!creditsRoot) {
      creditsRoot = createChip(creditsRootId, "账号额度详情");
      const ring = document.createElement("span");
      ring.setAttribute("data-codey-credits-ring", "");
      ring.setAttribute("aria-hidden", "true");
      ring.style.display = "inline-flex";
      ring.style.flex = "0 0 auto";
      const label = document.createElement("span");
      label.setAttribute("data-codey-credits-label", "");
      label.style.display = "inline-block";
      label.style.maxWidth = "100%";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.style.whiteSpace = "nowrap";
      creditsRoot.appendChild(ring);
      creditsRoot.appendChild(label);
      creditsPopover = createPopover(creditsPopoverId, "账号额度详情");
      bindChipPopover("credits", creditsRoot, creditsPopover);
    }
  };

  const currentUsage = () => {
    const threadId = findComposerConversationId(inputElement);
    if (threadId && usageByThread.has(threadId)) return usageByThread.get(threadId);
    if (!threadId && usageByThread.size === 1) {
      return usageByThread.values().next().value;
    }
    return threadId ? usageByThread.get(threadId) || null : null;
  };

  const renderUsage = () => {
    if (!usageRoot || !usagePopover) return;
    const usage = currentUsage();
    if (!usageHasDisplayData(usage) || !inputElement) {
      usageRoot.style.display = "none";
      setPopoverOpen("usage", false);
      return;
    }
    const label = usageChipLabel(usage);
    usageRoot.textContent = label;
    usageRoot.setAttribute("aria-label", `对话用量：${label}`);
    usageRoot.style.display = "inline-flex";
    const rows = [
      ["账号", accountIdentity()],
    ];
    if (usage.contextUsedTokens !== undefined && usage.contextWindowTokens) {
      rows.push([
        "上下文",
        `${decimal((usage.contextUsedTokens / usage.contextWindowTokens) * 100, 1)}% / ${formatTokenCount(usage.contextWindowTokens)}`,
      ]);
    }
    if (usage.cacheHitRatePercent !== undefined) {
      rows.push(["最近缓存命中率", formatCacheHit(usage.cacheHitRatePercent)]);
    }
    if (usage.cachedInputTokens !== undefined) {
      rows.push(["缓存读取", formatTokenCount(usage.cachedInputTokens)]);
    }
    if (usage.cacheWriteInputTokens !== undefined) {
      rows.push(["缓存写入", formatTokenCount(usage.cacheWriteInputTokens)]);
    }
    if (usage.reasoningOutputTokens !== undefined) {
      rows.push(["推理", formatTokenCount(usage.reasoningOutputTokens)]);
    }
    if (usage.totalTokens !== undefined) {
      rows.push(["Token 总数", formatTokenCount(usage.totalTokens)]);
    }
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      rows.push([
        "输入 / 输出",
        `${formatTokenCount(usage.inputTokens || 0)} / ${formatTokenCount(usage.outputTokens || 0)}`,
      ]);
    }
    if (usage.outputTokensPerSecond !== undefined) {
      rows.push(["输出速度", `${decimal(usage.outputTokensPerSecond, 1)} Token/秒`]);
    }
    if (usage.totalCostUsd !== undefined) {
      rows.push(["会话费用估算", `$${usage.totalCostUsd.toFixed(3)}`]);
    }
    if (usage.totalCredits !== undefined) {
      rows.push(["已记录消耗", `${decimal(usage.totalCredits, 3)} credits`]);
    }
    usagePopover.innerHTML =
      `<div data-codey-usage-title>用量</div>` +
      rows.map(([name, value]) =>
        `<div data-codey-usage-row><span>${escapeText(name)}</span><span>${escapeText(value)}</span></div>`
      ).join("");
  };

  const creditsWindows = (result) => {
    const windows = [];
    for (const window of [result?.primary, result?.secondary]) {
      const kind = windowKind(window);
      if (!kind || windows.some((entry) => entry.kind === kind)) continue;
      windows.push({ kind, window });
    }
    windows.sort((left, right) => {
      if (left.kind === right.kind) return 0;
      return left.kind === "five-hour" ? -1 : 1;
    });
    return windows;
  };

  const hideCredits = () => {
    if (!creditsRoot) return;
    creditsRoot.style.display = "none";
    setPopoverOpen("credits", false);
  };

  const renderCredits = () => {
    if (!creditsRoot || !creditsPopover) return;
    if (!inputElement || creditsResult?.status !== "ok") {
      hideCredits();
      return;
    }
    const windows = creditsWindows(creditsResult);
    if (!windows.length) {
      hideCredits();
      return;
    }
    const primary = windows[0];
    const remaining = remainingPercent(primary.window.usedPercent);
    const percent = formatCreditsPercent(remaining);
    const tone = creditsTone(primary.window.usedPercent);
    const color = toneColor(tone);
    creditsRoot.style.setProperty("--codey-credits-remaining", String(remaining));
    creditsRoot.style.setProperty("--codey-credits-tone", color);
    const ring = creditsRoot.querySelector?.("[data-codey-credits-ring]");
    if (ring) {
      ring.replaceChildren(createUsageRing(remaining, {
        size: 14,
        strokeWidth: 2.4,
        color,
      }));
    }
    const label = creditsRoot.querySelector?.("[data-codey-credits-label]");
    if (label) label.textContent = percent;
    creditsRoot.setAttribute(
      "aria-label",
      `${windowLabel(primary.kind)} ${percent}`,
    );
    creditsRoot.title = `${windowLabel(primary.kind)} ${percent}`;
    creditsRoot.style.display = "inline-flex";
    const plan = planLabel(creditsResult.planType);
    const secondary = windows.slice(1);
    const balance = creditsBalanceLabel(creditsResult.credits);
    creditsPopover.style.setProperty("--codey-credits-remaining", String(remaining));
    creditsPopover.style.setProperty("--codey-credits-tone", color);
    creditsPopover.style.backgroundImage =
      `radial-gradient(160px 100px at 18% -10%, color-mix(in srgb, ${color} 20%, transparent), transparent 70%)`;
    creditsPopover.innerHTML = `
      <div data-codey-credits-header>
        <div data-codey-credits-meta>
          <div>
            <div data-codey-credits-title>${escapeText(windowLabel(primary.kind))}${
              plan ? `<span data-codey-credits-plan>${escapeText(plan)}</span>` : ""
            }</div>
            ${primary.window.resetsAt
              ? `<div data-codey-credits-reset>${escapeText(resetTimeLabel(primary.window.resetsAt))}</div>`
              : ""}
          </div>
          <div data-codey-credits-remaining><small>剩余</small>${escapeText(percent)}</div>
        </div>
        <div data-codey-credits-bar aria-hidden="true"><span></span></div>
      </div>
      ${secondary.map((entry) => {
        const secondaryRemaining = remainingPercent(entry.window.usedPercent);
        const secondaryPercent = formatCreditsPercent(secondaryRemaining);
        const secondaryColor = toneColor(creditsTone(entry.window.usedPercent));
        return `
          <div data-codey-credits-tile data-window="${entry.kind}">
            <div data-codey-credits-meta>
              <div>
                <div>${escapeText(windowLabel(entry.kind))}</div>
                ${entry.window.resetsAt
                  ? `<div data-codey-credits-reset>${escapeText(resetTimeLabel(entry.window.resetsAt))}</div>`
                  : ""}
              </div>
              <div style="color:${secondaryColor};font-variant-numeric:tabular-nums">剩余 ${escapeText(secondaryPercent)}</div>
            </div>
            <div data-codey-credits-bar aria-hidden="true" style="--codey-credits-remaining:${secondaryRemaining};--codey-credits-tone:${secondaryColor}"><span></span></div>
          </div>
        `;
      }).join("")}
      ${balance ? `<div data-codey-credits-meta><span>Credits 余额</span><span>${escapeText(balance)}</span></div>` : ""}
    `;
  };

  const normalizeAppServerAccountUsage = (payload) => {
    const buckets = [];
    if (isRecord(payload?.rateLimits)) buckets.push(payload.rateLimits);
    const windowsByKind = new Map();
    for (const bucket of buckets) {
      for (const window of [bucket.primary, bucket.secondary]) {
        const usedPercent = Number(window?.usedPercent);
        const windowMinutes = Number(window?.windowDurationMins);
        if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
          continue;
        }
        const normalized = {
          usedPercent,
          windowMinutes,
          resetsAt: Number(window?.resetsAt) || undefined,
        };
        const kind = windowKind(normalized);
        if (kind && !windowsByKind.has(kind)) windowsByKind.set(kind, normalized);
      }
    }
    const fiveHour = windowsByKind.get("five-hour") || null;
    const sevenDay = windowsByKind.get("seven-day") || null;
    const credits = buckets.find((bucket) => bucket.credits)?.credits || payload.credits || null;
    if (!fiveHour && !sevenDay && !credits) {
      throw new Error("Codex 官方额度响应中没有可展示的信息");
    }
    const nextPlan = buckets
      .map((bucket) => bucket.planType)
      .find((value) => typeof value === "string" && value.trim())
      || (typeof payload.planType === "string" ? payload.planType : undefined);
    return {
      status: "ok",
      planType: nextPlan,
      primary: fiveHour || sevenDay,
      secondary: fiveHour && sevenDay ? sevenDay : null,
      credits,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  };

  const readAccountUsageFromAppServer = async () => {
    const loaded = typeof window.__codeyLoadSessionTools === "function"
      ? await window.__codeyLoadSessionTools()
      : window.__codeySessionToolsInjectLoaded === true;
    if (!loaded || typeof window.__codeyReadAccountRateLimits !== "function") {
      throw new Error("Codex 官方额度读取接口不可用");
    }
    const response = await window.__codeyReadAccountRateLimits();
    return normalizeAppServerAccountUsage(response);
  };

  const scheduleAccountUsageCheck = (delayMs = accountUsageRefreshIntervalMs) => {
    window.clearTimeout(creditsTimer);
    creditsTimer = 0;
    if (!creditsPollingEnabled || document.visibilityState === "hidden") return;
    creditsTimer = window.setTimeout(() => {
      creditsTimer = 0;
      void checkAccountUsage();
    }, delayMs);
  };

  const checkAccountUsage = async () => {
    if (creditsCheckInFlight || document.visibilityState === "hidden") return creditsResult;
    creditsCheckInFlight = true;
    try {
      let result = await withTimeout(
        callBridge(accountUsagePath, {}, { timeoutMs: accountUsageTimeoutMs }),
        accountUsageTimeoutMs,
        "读取官方账号额度超时",
      );
      if (result?.status === "error") {
        try {
          result = await withTimeout(
            readAccountUsageFromAppServer(),
            accountUsageTimeoutMs,
            "读取 Codex 官方额度超时",
          );
        } catch {
          // Keep the backend error when AppServerManager is unavailable.
        }
      }
      if (result?.status === "ok" && result.accountLabel) {
        accountLabel = String(result.accountLabel);
      }
      if (result?.status === "disabled" || result?.status === "unavailable") {
        creditsPollingEnabled = false;
        creditsResult = result;
        hideCredits();
        return result;
      }
      creditsPollingEnabled = true;
      if (result?.status === "error" && creditsResult?.status === "ok") {
        return creditsResult;
      }
      creditsResult = result;
      renderCredits();
      return result;
    } catch (error) {
      if (creditsResult?.status === "ok") return creditsResult;
      creditsResult = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      hideCredits();
      return creditsResult;
    } finally {
      creditsCheckInFlight = false;
      if (creditsPollingEnabled) scheduleAccountUsageCheck();
    }
  };

  const loadSettings = async () => {
    try {
      const settings = await callBridge(settingsPath);
      const nextId = settings?.currentProviderSnapshot?.id;
      if (typeof nextId === "string" && nextId.trim()) providerId = nextId.trim();
    } catch {
      // Provider id is only the no-login fallback for the usage account row.
    }
  };

  const applyTokenUsage = (message) => {
    const observed = observeTokenUsage(message);
    if (!observed) return false;
    usageByThread.set(observed.threadId, observed.usage);
    renderUsage();
    return true;
  };

  const bindNotificationTargets = (targets) => {
    for (const target of targets) {
      if (boundNotificationTargets.has(target)) continue;
      const unsubscribe = bindNotificationCallback(target, applyTokenUsage);
      if (!unsubscribe) continue;
      boundNotificationTargets.add(target);
      notificationUnsubscribers.push(unsubscribe);
    }
    if (!notificationUnsubscribers.length) return;
    unsubscribeNotifications = () => {
      for (const unsubscribe of notificationUnsubscribers.splice(0)) unsubscribe();
      boundNotificationTargets.clear();
      sessionManagerBound = false;
    };
  };

  const collectPendingNotificationTargets = (controller) => {
    const seen = new Set(boundNotificationTargets);
    const targets = [];
    const addTarget = (target) => {
      if (!target || seen.has(target)) return;
      seen.add(target);
      targets.push(target);
    };
    const managerTargets = sessionManagerBound
      ? []
      : collectManagerNotificationTargets(controller);
    for (const target of managerTargets) addTarget(target);
    for (const target of collectFiberNotificationTargets(inputElement)) addTarget(target);
    return { managerTargets, targets };
  };

  const subscribeNotifications = async () => {
    if (notificationSubscribePromise) return notificationSubscribePromise;
    notificationSubscribePromise = (async () => {
      try {
        if (typeof window.__codeyLoadSessionTools === "function") {
          await window.__codeyLoadSessionTools();
        }
        let controller = null;
        if (typeof window.__codeyLoadCodexSessionController === "function") {
          try {
            controller = await window.__codeyLoadCodexSessionController();
          } catch {
            controller = null;
          }
        }
        const { managerTargets, targets } = collectPendingNotificationTargets(controller);
        bindNotificationTargets(targets);
        if (managerTargets.some((target) => boundNotificationTargets.has(target))) {
          sessionManagerBound = true;
        }
      } finally {
        notificationSubscribePromise = null;
      }
    })().catch(() => {
      notificationSubscribePromise = null;
    });
    return notificationSubscribePromise;
  };

  const updateChipPlacement = () => {
    ensureChips();
    inputElement = findComposerInput();
    if (!inputElement) {
      if (usageRoot) usageRoot.style.display = "none";
      hideCredits();
      return false;
    }
    const usageTarget = findContextInsertionTarget() || findModelInsertionTarget();
    if (usageTarget) placeBefore(usageRoot, usageTarget);
    const creditsTarget = findPermissionInsertionTarget();
    if (creditsTarget) placeBefore(creditsRoot, creditsTarget);
    renderUsage();
    renderCredits();
    void subscribeNotifications();
    return true;
  };

  const scan = () => {
    ready = true;
    const mounted = updateChipPlacement();
    publishInjectionStatus(mounted ? "输入栏用量与额度芯片已就绪" : "等待输入栏");
  };

  const scheduleScan = () => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 120);
  };

  const startObserver = () => {
    if (observer) return;
    const handle = () => scheduleScan();
    const options = { childList: true, subtree: true };
    if (typeof window.__codeyMutationDispatcher?.subscribe === "function") {
      unsubscribeMutations = window.__codeyMutationDispatcher.subscribe(handle, options);
      observer = { disconnect: unsubscribeMutations };
      return;
    }
    observer = new MutationObserver(handle);
    observer.observe(document.documentElement, options);
  };

  const boot = async () => {
    addStyle();
    ensureChips();
    startObserver();
    await loadSettings();
    scan();
    creditsPollingEnabled = true;
    await checkAccountUsage();
    renderUsage();
    window.addEventListener?.(configChangedEvent, () => {
      creditsPollingEnabled = true;
      void loadSettings();
      scheduleAccountUsageCheck(0);
    });
    window.addEventListener?.("focus", () => {
      scan();
      scheduleAccountUsageCheck(0);
    });
    document.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState !== "hidden") scheduleAccountUsageCheck(0);
    });
  };

  window.__codeyComposerUsage = {
    snapshot: () => ({
      ready,
      providerId,
      accountLabel,
      usageVisible: usageRoot?.style.display === "inline-flex",
      creditsVisible: creditsRoot?.style.display === "inline-flex",
      subscribed: Boolean(unsubscribeNotifications),
      usageLabel: usageRoot?.textContent || "",
      creditsLabel: creditsRoot?.querySelector?.("[data-codey-credits-label]")?.textContent
        || creditsRoot?.textContent
        || "",
      threadCount: usageByThread.size,
    }),
    scan,
    refreshCredits: checkAccountUsage,
    applyNotification: applyTokenUsage,
  };

  void boot();
})();
