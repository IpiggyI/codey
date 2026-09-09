// Lightweight renderer bootstrap injected by the Codey CDP launcher.
// The heavier session/sidebar tools live in codey-inject.js and are loaded
// after sidebar interaction or once the renderer has idle time.
(() => {
  const rendererCoreAlreadyLoaded = window.__codeyRendererCoreLoaded === true;
  window.__codeyRendererModuleReady = true;

  const sessionToolsLoadPath = "/internal/codey/session-tools/load";
  const backendHealthPath = "/backend/health";
  const buttonId = "codey-settings-button";
  const styleId = "codey-core-injected-style";
  const runtimeHealthEvent = "codey-runtime-health-changed";
  const runtimeHealthCheckIntervalMs = 30_000;
  const runtimeHealthCheckTimeoutMs = 3_000;
  const runtimeHealthFailureRetryMs = 1_000;
  const runtimeHealthFailureThreshold = 2;
  const sessionToolsIdleLoadTimeoutMs = 5_000;
  const sessionToolsLoadTimeoutMs = 10_000;
  const sidebarSelector = [
    "[data-app-action-sidebar-scroll]",
    "[data-app-action-sidebar-section]",
    "[data-app-action-sidebar-thread-row]",
    "[data-app-action-sidebar-project-row]",
    "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]",
  ].join(", ");
  const headerSelector = "header, nav";
  const subagentHeaderSelector = ".h-12.shrink-0.border-b";
  const bootstrapProbeSelector = `${headerSelector}, ${sidebarSelector}`;
  const settingsIcon = `
    <svg viewBox="0 0 350 350" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="350" height="350" rx="34" fill="#fff" stroke="none"></rect>
      <path d="M70 301c-16 0-24-18-13-30l73-77c8-8 8-20 0-28L65 101C50 86 57 61 78 57c9-2 18 1 25 8l91 91c18 18 18 46 0 64l-66 66c-6 6-2 15 7 15h183" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
  let sessionToolsLoadPromise = null;
  let scanTimer = 0;
  let runtimeHealthTimer = 0;
  let runtimeHealthCheckInFlight = false;
  let runtimeHealthFailures = 0;
  let runtimeHealthState = "checking";
  let runtimeHealthMessage = "";
  let runtimeHealthObservedAt = 0;
  let sessionToolsInteractionArmed = false;
  let sessionToolsIdleLoadScheduled = false;
  let bootstrapObserver = null;
  let headerMountDirty = true;

  const queryWithin = (root, selector) => {
    const matches = [];
    if (root instanceof HTMLElement && typeof root.matches === "function" && root.matches(selector)) {
      matches.push(root);
    }
    if (root && typeof root.querySelectorAll === "function") {
      matches.push(...root.querySelectorAll(selector));
    }
    return matches;
  };

  const callBridge = (path, payload = {}, options = {}) => {
    if (typeof window.__codexSessionDeleteBridge === "function") {
      return window.__codexSessionDeleteBridge(path, payload, options);
    }
    return Promise.resolve({
      status: "failed",
      code: "bridge_unavailable",
      message: "Codey bridge 不可用",
    });
  };

  const addStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${buttonId} { -webkit-app-region: no-drag !important; pointer-events: auto !important; position: relative; z-index: 2147483641; display: inline-grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 8px; padding: 0; margin-inline-start: 8px; margin-inline-end: 18px; background: transparent; color: inherit; cursor: pointer; opacity: .86; user-select: none; transition: background .15s ease, opacity .15s ease, transform .15s ease; }
      #${buttonId}[data-codey-header-actions="true"] { width: 28px; height: 28px; margin-inline-start: 0; margin-inline-end: 6px; }
      #${buttonId}:hover { background: rgba(127, 127, 127, .14); opacity: 1; }
      #${buttonId}:active { transform: translateY(1px); }
      #${buttonId}:focus-visible { outline: 2px solid rgba(139, 151, 255, .72); outline-offset: 2px; }
      #${buttonId} svg { display: block; width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 22; stroke-linecap: round; stroke-linejoin: round; }
      #${buttonId} .codey-settings-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      #${buttonId} .codey-runtime-badge { position: absolute; top: -2px; right: -2px; display: grid; width: 13px; height: 13px; place-items: center; border: 2px solid Canvas; border-radius: 999px; background: #ff453a; color: #fff; font: 800 9px/1 -apple-system, BlinkMacSystemFont, sans-serif; opacity: 0; transform: scale(.65); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
      #${buttonId}[data-codey-runtime-state="unavailable"] { background: rgba(255, 69, 58, .12); color: #ff453a; opacity: 1; }
      #${buttonId}[data-codey-runtime-state="unavailable"]:hover { background: rgba(255, 69, 58, .2); }
      #${buttonId}[data-codey-runtime-state="unavailable"] .codey-runtime-badge { opacity: 1; transform: scale(1); }
      @media (prefers-reduced-motion: reduce) {
        #${buttonId}, #${buttonId} * { animation: none !important; transition: none !important; }
      }
    `;
    document.documentElement.appendChild(style);
  };

  const applyRuntimeBadge = (button = document.getElementById(buttonId)) => {
    if (!(button instanceof HTMLElement)) return;
    button.setAttribute("data-codey-runtime-state", runtimeHealthState);
    if (runtimeHealthState === "unavailable") {
      const detail = runtimeHealthMessage || "Codey 后端未响应";
      button.setAttribute(
        "aria-label",
        "Codey 进程异常或连接中断，点击查看处理提示",
      );
      button.title = `Codey 进程异常或连接中断：${detail}（点击查看处理提示）`;
      return;
    }
    button.setAttribute("aria-label", "打开 Codey 配置");
    button.title = "打开 Codey 配置";
  };

  const runtimeHealthSnapshot = () => ({
    state: runtimeHealthState,
    message: runtimeHealthMessage,
    observedAt: runtimeHealthObservedAt,
    consecutiveFailures: runtimeHealthFailures,
  });

  const setRuntimeHealthState = (state, message = "") => {
    const nextState = state === "healthy" || state === "unavailable"
      ? state
      : "checking";
    const nextMessage = String(message || "").slice(0, 160);
    const changed = runtimeHealthState !== nextState || runtimeHealthMessage !== nextMessage;
    runtimeHealthState = nextState;
    runtimeHealthMessage = nextMessage;
    runtimeHealthObservedAt = Date.now();
    window.__codeyRuntimeHealth = runtimeHealthSnapshot();
    if (changed) applyRuntimeBadge();
    if (
      changed
      && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function"
    ) {
      window.dispatchEvent(new CustomEvent(runtimeHealthEvent, {
        detail: window.__codeyRuntimeHealth,
      }));
    }
    return window.__codeyRuntimeHealth;
  };

  const withTimeout = (
    promise,
    timeoutMs,
    message = "请求超时",
  ) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

  const scheduleRuntimeHealthCheck = (delayMs = runtimeHealthCheckIntervalMs) => {
    window.clearTimeout(runtimeHealthTimer);
    runtimeHealthTimer = 0;
    if (document.visibilityState === "hidden") return;
    runtimeHealthTimer = window.setTimeout(() => {
      runtimeHealthTimer = 0;
      void checkRuntimeHealth();
    }, delayMs);
  };

  const checkRuntimeHealth = async () => {
    if (document.visibilityState === "hidden") {
      scheduleRuntimeHealthCheck();
      return runtimeHealthSnapshot();
    }
    if (runtimeHealthCheckInFlight) return runtimeHealthSnapshot();
    runtimeHealthCheckInFlight = true;
    try {
      if (typeof window.__codexSessionDeleteBridge !== "function") {
        runtimeHealthFailures = runtimeHealthFailureThreshold;
        return setRuntimeHealthState("unavailable", "Codey bridge 不可用");
      }
      const result = await withTimeout(
        callBridge(backendHealthPath, {}, { timeoutMs: runtimeHealthCheckTimeoutMs }),
        runtimeHealthCheckTimeoutMs + 250,
        "Codey 后端健康检查超时",
      );
      if (result?.status === "ok") {
        runtimeHealthFailures = 0;
        return setRuntimeHealthState("healthy");
      }
      const error = new Error(result?.message || "Codey 后端未响应");
      error.code = result?.code || "backend_unavailable";
      throw error;
    } catch (error) {
      runtimeHealthFailures += 1;
      const immediate = error?.code === "bridge_unavailable";
      if (immediate) runtimeHealthFailures = runtimeHealthFailureThreshold;
      if (runtimeHealthFailures >= runtimeHealthFailureThreshold) {
        return setRuntimeHealthState("unavailable", "Codey 后端未响应");
      }
      return setRuntimeHealthState("checking", "正在确认 Codey 进程状态");
    } finally {
      runtimeHealthCheckInFlight = false;
      const nextDelay = runtimeHealthFailures > 0
        && runtimeHealthFailures < runtimeHealthFailureThreshold
        ? runtimeHealthFailureRetryMs
        : runtimeHealthCheckIntervalMs;
      scheduleRuntimeHealthCheck(nextDelay);
    }
  };

  const openSettings = () => {
    if (runtimeHealthState === "unavailable") {
      window.alert(
        "Codey 进程异常或已退出，当前配置面板无法连接。请退出 Codex 后重新启动 Codey。",
      );
      return;
    }
    if (window.__codeySettingsOverlay?.toggle) {
      window.__codeySettingsOverlay.toggle();
      return;
    }
    const detail = String(window.__codeyOverlayError || "").split("\n")[0];
    window.alert(detail
      ? `Codey 内嵌配置面板加载失败：${detail}`
      : "Codey 内嵌配置面板尚未加载，请退出 Codex 后重新启动 Codey");
  };

  const visibleMountRect = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    if (element.closest("[hidden], [aria-hidden=true]")) return null;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0
      ? rect
      : null;
  };

  const isTopChromeMountTarget = (element) => {
    const rect = visibleMountRect(element);
    if (!rect) return false;
    const viewportWidth = Math.max(
      window.innerWidth || 0,
      document.documentElement?.clientWidth || 0,
      document.documentElement?.getBoundingClientRect?.().width || 0,
      rect.right,
    );
    return rect.top <= 96
      && rect.height <= 120
      && rect.width >= 48
      && rect.right >= viewportWidth - 48;
  };

  const findHeaderMount = () => {
    const header = [...document.querySelectorAll("header")].find(isTopChromeMountTarget)
      || [...document.querySelectorAll("nav")].find(isTopChromeMountTarget);
    if (!header) return null;

    const rightmostControl = [...header.querySelectorAll("button, [role=button], a[href]")]
      .reduce((rightmost, control) => {
        if (control.id === buttonId) return rightmost;
        const rect = visibleMountRect(control);
        if (!rect || (rightmost && rect.right <= rightmost.right)) return rightmost;
        return { control, right: rect.right };
      }, null)?.control || null;
    if (!rightmostControl) return { header, target: header };

    let headerChild = rightmostControl;
    while (headerChild.parentElement && headerChild.parentElement !== header) {
      headerChild = headerChild.parentElement;
    }
    const headerRect = header.getBoundingClientRect();
    const childRect = headerChild.getBoundingClientRect();
    const hasTrailingActionRegion = headerChild !== rightmostControl
      && childRect.width <= 240
      && childRect.right >= headerRect.right - 24;
    return {
      header,
      target: header,
      before: hasTrailingActionRegion ? headerChild : null,
    };
  };

  const mountedButtonIsUsable = (button) => {
    if (headerMountDirty || !(button instanceof HTMLElement) || button.isConnected !== true) {
      return false;
    }
    const parent = button.parentElement;
    if (!(parent instanceof HTMLElement) || button.closest("[hidden], [aria-hidden=true]")) {
      return false;
    }
    const validParent = parent.matches?.(headerSelector);
    const anchored = button.dataset.codeyHeaderActions !== "true"
      || (
        !!button.nextElementSibling
        && button.nextElementSibling === button.__codeyHeaderAnchor
      );
    return !!validParent && anchored;
  };

  const mountButton = () => {
    addStyle();
    const existingButton = document.getElementById(buttonId);
    if (mountedButtonIsUsable(existingButton)) return;
    const mount = findHeaderMount();
    if (!mount) {
      existingButton?.remove?.();
      return;
    }
    let button = existingButton;
    if (!button) {
      button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      button.setAttribute("aria-label", "打开 Codey 配置");
      button.innerHTML = `${settingsIcon}<span class="codey-runtime-badge" aria-hidden="true">!</span><span class="codey-settings-label">Codey</span>`;
      button.title = "打开 Codey 配置";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSettings();
      }, true);
    }
    if (mount.before) {
      button.dataset.codeyHeaderActions = "true";
    } else {
      delete button.dataset.codeyHeaderActions;
    }
    if (mount.before) {
      if (button.parentElement !== mount.target || button.nextElementSibling !== mount.before) {
        mount.target.insertBefore(button, mount.before);
      }
    } else if (button.parentElement !== mount.target) {
      mount.target.appendChild(button);
    }
    button.__codeyHeaderAnchor = mount.before || null;
    applyRuntimeBadge(button);
    headerMountDirty = false;
  };

  const finishSessionToolsLoad = () => {
    if (window.__codeySessionToolsInjectLoaded !== true) return false;
    disarmSessionToolsInteraction();
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    return true;
  };

  const loadSessionTools = () => {
    if (finishSessionToolsLoad()) return Promise.resolve(true);
    if (sessionToolsLoadPromise) return sessionToolsLoadPromise;
    sessionToolsLoadPromise = Promise.resolve(callBridge(
      sessionToolsLoadPath,
      {},
      { timeoutMs: sessionToolsLoadTimeoutMs },
    ))
      .then((result) => {
        if (!result || result.status !== "ok") {
          throw new Error(result?.message || "会话工具加载请求失败");
        }
        if (window.__codeySessionToolsInjectLoaded !== true) {
          throw new Error(window.__codeySessionToolsError || "会话工具未完成初始化");
        }
        return finishSessionToolsLoad();
      })
      .catch((error) => {
        // Runtime.evaluate can time out while the renderer keeps executing the
        // already-started script. If initialization completed before the bridge
        // rejection reached this page, treat it as success and always release
        // the bootstrap observer/listeners.
        if (finishSessionToolsLoad()) return true;
        sessionToolsLoadPromise = null;
        console.warn("[Codey] session tools lazy load failed", error);
        return false;
      });
    return sessionToolsLoadPromise;
  };

  const loadSessionToolsFromInteraction = (event) => {
    const target = event?.target instanceof Element
      ? event.target
      : event?.target?.parentElement;
    if (!target?.closest?.(sidebarSelector)) return;
    void loadSessionTools();
  };

  const armSessionToolsInteraction = () => {
    if (
      typeof document.addEventListener !== "function"
      || sessionToolsInteractionArmed
      || sessionToolsLoadPromise
      || window.__codeySessionToolsInjectLoaded === true
    ) return;
    sessionToolsInteractionArmed = true;
    document.addEventListener("pointerover", loadSessionToolsFromInteraction, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerdown", loadSessionToolsFromInteraction, {
      capture: true,
      passive: true,
    });
    document.addEventListener("focusin", loadSessionToolsFromInteraction, true);
  };

  const disarmSessionToolsInteraction = () => {
    if (!sessionToolsInteractionArmed) return;
    sessionToolsInteractionArmed = false;
    document.removeEventListener("pointerover", loadSessionToolsFromInteraction, true);
    document.removeEventListener("pointerdown", loadSessionToolsFromInteraction, true);
    document.removeEventListener("focusin", loadSessionToolsFromInteraction, true);
  };

  const scheduleSessionToolsIdleLoad = () => {
    if (
      sessionToolsIdleLoadScheduled
      || sessionToolsLoadPromise
      || window.__codeySessionToolsInjectLoaded === true
    ) return;
    sessionToolsIdleLoadScheduled = true;
    const run = () => {
      sessionToolsIdleLoadScheduled = false;
      void loadSessionTools();
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: sessionToolsIdleLoadTimeoutMs });
      return;
    }
    window.setTimeout(run, 1_000);
  };

  const subagentHeaders = new Map();
  const subagentConversationId = (header) => {
    const key = Object.keys(header).find((key) => key.startsWith("__reactFiber$"));
    let seed = null;
    for (let fiber = header[key], depth = 0; fiber && depth < 16; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (typeof props?.backAriaLabel === "string" && typeof props?.onBack === "function") seed = props.seed;
      if (seed && props?.conversationId === seed) return seed;
    }
    return null;
  };
  const syncSubagentHeaders = () => {
    for (const [header, binding] of subagentHeaders) {
      if (header.isConnected && subagentConversationId(header) === binding.id) continue;
      binding.element?.remove();
      subagentHeaders.delete(header);
    }
    for (const header of document.querySelectorAll(subagentHeaderSelector)) {
      const id = subagentConversationId(header);
      if (!id) continue;
      if (subagentHeaders.has(header)) {
        subagentHeaders.get(header).refresh?.();
        continue;
      }
      const binding = { id };
      subagentHeaders.set(header, binding);
      void loadSessionTools().then(() => window.__codeyLoadCodexSessionController?.()).then((controller) => {
        if (subagentHeaders.get(header) !== binding || !header.isConnected) return;
        const manager = controller?.manager;
        if (typeof manager?.readThread !== "function") {
          subagentHeaders.delete(header);
          return;
        }
        const element = document.createElement("span");
        element.setAttribute("data-codey-subagent-model", "true");
        element.className = "text-xs text-secondary";
        element.style.cssText = "display:inline-flex;gap:6px;min-width:0;max-width:65%;flex-shrink:0;margin-inline-start:auto;white-space:nowrap;font-weight:400";
        const modelLabel = document.createElement("span");
        modelLabel.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis";
        const effortLabel = document.createElement("span");
        effortLabel.style.flexShrink = "0";
        element.append(modelLabel, effortLabel);
        binding.element = element;
        const update = (thread) => {
          const model = typeof thread?.model === "string" && thread.model.trim() || "待获取";
          const effort = typeof thread?.reasoningEffort === "string" && thread.reasoningEffort.trim() || "待获取";
          const description = `模型：${model} · 推理强度：${effort}`;
          if (element.title === description) return;
          element.title = description;
          element.setAttribute("aria-label", description);
          modelLabel.textContent = model.split("/").at(-1) || model;
          effortLabel.textContent = `· ${effort}`;
        };
        update();
        header.append(element);
        binding.refresh = async () => {
          if (binding.pending || Date.now() - (binding.updatedAt || 0) < 1000) return;
          binding.pending = true;
          try {
            const result = await manager.readThread(id, { includeTurns: false });
            if (subagentHeaders.get(header) === binding && header.isConnected && subagentConversationId(header) === id) update(result?.thread);
          } catch {
            // Retry on the next panel interaction; never guess from role defaults.
          } finally {
            binding.pending = false;
            binding.updatedAt = Date.now();
          }
        };
        void binding.refresh();
      }).catch(() => {
        if (subagentHeaders.get(header) === binding) subagentHeaders.delete(header);
      });
    }
  };
  window.__codeySyncSubagentHeaders = syncSubagentHeaders;

  const scan = (root = document) => {
    mountButton();
    syncSubagentHeaders();
  };

  const scheduleScan = (root = document) => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan(root);
    }, 60);
  };

  const invalidateHeaderMount = (root = document) => {
    headerMountDirty = true;
    scheduleScan(root || document);
  };

  window.__codeySubagentHeaderCleanup?.();
  let subagentHeaderTimer = 0;
  const onSubagentHeaderMutations = (mutations) => {
    if (!mutations.some((mutation) => {
      const target = mutation.target instanceof HTMLElement ? mutation.target : mutation.target?.parentElement;
      if (target?.closest?.("[data-codey-subagent-model]")) return false;
      return target?.closest?.(subagentHeaderSelector) || [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some((node) =>
        node instanceof HTMLElement && (node.matches?.(subagentHeaderSelector) || node.querySelector?.(subagentHeaderSelector)));
    })) return;
    window.clearTimeout(subagentHeaderTimer);
    subagentHeaderTimer = window.setTimeout(syncSubagentHeaders, 60);
  };
  const subagentMutationOptions = { childList: true, subtree: true };
  let unsubscribeSubagentHeaders = window.__codeyMutationDispatcher?.subscribe?.(onSubagentHeaderMutations, subagentMutationOptions);
  if (!unsubscribeSubagentHeaders) {
    const observer = new MutationObserver(onSubagentHeaderMutations);
    observer.observe(document.documentElement, subagentMutationOptions);
    unsubscribeSubagentHeaders = () => observer.disconnect();
  }
  const onSubagentHeaderClick = () => {
    window.clearTimeout(subagentHeaderTimer);
    subagentHeaderTimer = window.setTimeout(syncSubagentHeaders, 60);
  };
  document.addEventListener?.("click", onSubagentHeaderClick, true);
  window.__codeySubagentHeaderCleanup = () => {
    unsubscribeSubagentHeaders();
    document.removeEventListener?.("click", onSubagentHeaderClick, true);
    window.clearTimeout(subagentHeaderTimer);
    for (const binding of subagentHeaders.values()) {
      binding.element?.remove();
    }
    subagentHeaders.clear();
  };
  syncSubagentHeaders();

  if (rendererCoreAlreadyLoaded) return;
  // Arm before React mounts the sidebar. The handler itself filters to sidebar
  // targets, so this closes the observer/debounce race without moving the heavy
  // session-tools evaluation into startup.
  armSessionToolsInteraction();
  scheduleSessionToolsIdleLoad();
  scan();
  void checkRuntimeHealth();

  const headerNodesChanged = (nodes) => {
    for (const node of nodes || []) {
      if (
        node instanceof HTMLElement
        && node.id !== buttonId
      ) {
        return true;
      }
    }
    return false;
  };

  // Lightweight observer telemetry: per-handler call count, mutation count and
  // wall time, exposed on window.__codeyObserverStats for performance triage.
  // No behavior change; timing falls back to Date.now() where performance is
  // unavailable (test sandboxes).
  const codeyTimed = (name, count, run) => {
    const now = () =>
      typeof performance === "object" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const stats = (window.__codeyObserverStats ||= {});
    const entry = (stats[name] ||= { calls: 0, items: 0, totalMs: 0, maxMs: 0 });
    const startedAt = now();
    try {
      return run();
    } finally {
      const elapsed = now() - startedAt;
      entry.calls += 1;
      entry.items += count;
      entry.totalMs += elapsed;
      if (elapsed > entry.maxMs) entry.maxMs = elapsed;
    }
  };
  const handleBootstrapMutations = (mutations) =>
    codeyTimed("renderer-inject.bootstrapMutations", mutations?.length ?? 0, () => handleBootstrapMutationsImpl(mutations));
  const handleBootstrapMutationsImpl = (mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof HTMLElement
        ? mutation.target
        : mutation.target?.parentElement;
      if (mutation.type === "attributes") {
        if (target?.matches?.(headerSelector) || target?.matches?.(sidebarSelector)) {
          if (target.matches?.(headerSelector)) headerMountDirty = true;
          scheduleScan(target);
          return;
        }
        continue;
      }
      const targetHeader = target?.matches?.(headerSelector)
        ? target
        : target?.closest?.(headerSelector);
      const headerChildrenChanged = targetHeader && (
        headerNodesChanged(mutation.addedNodes)
        || headerNodesChanged(mutation.removedNodes)
      );
      if (headerChildrenChanged) {
        headerMountDirty = true;
        scheduleScan(targetHeader);
        return;
      }
      for (const node of mutation.addedNodes || []) {
        const element = node instanceof HTMLElement ? node : null;
        if (!element) continue;
        // One combined probe rejects the overwhelmingly common streaming case
        // in two subtree walks instead of four.
        const matched = element.matches?.(bootstrapProbeSelector)
          ? element
          : element.querySelector?.(bootstrapProbeSelector);
        if (!matched) continue;
        if (element.matches?.(headerSelector) || element.querySelector?.(headerSelector)) {
          headerMountDirty = true;
        }
        scheduleScan(element);
        return;
      }
    }
  };
  const bootstrapMutationOptions = {
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-scroll",
      "data-app-action-sidebar-section",
      "data-app-action-sidebar-thread-id",
      "data-app-action-sidebar-thread-title",
      "data-app-action-sidebar-project-id",
      "data-app-action-sidebar-project-row",
      "hidden",
      "aria-hidden",
    ],
    childList: true,
    subtree: true,
  };
  const mutationDispatcher = window.__codeyMutationDispatcher;
  if (typeof mutationDispatcher?.subscribe === "function") {
    const unsubscribe = mutationDispatcher.subscribe(
      handleBootstrapMutations,
      bootstrapMutationOptions,
    );
    if (mutationDispatcher.snapshot?.().observerInstalled) {
      bootstrapObserver = { disconnect: unsubscribe };
    } else {
      unsubscribe?.();
    }
  }
  if (!bootstrapObserver) {
    bootstrapObserver = new MutationObserver(handleBootstrapMutations);
    bootstrapObserver.observe(document.documentElement, bootstrapMutationOptions);
  }

  window.__codeyLoadSessionTools = loadSessionTools;
  window.__codeyRendererScan = scan;
  window.__codeyRendererInvalidateHeaderMount = invalidateHeaderMount;
  window.__codeyRefreshRuntimeHealth = checkRuntimeHealth;

  window.addEventListener?.("focus", () => {
    void loadSessionTools();
    scan();
    scheduleRuntimeHealthCheck(0);
  });
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState !== "hidden") void loadSessionTools();
    scheduleRuntimeHealthCheck(0);
  });
  window.addEventListener?.("pageshow", () => {
    void loadSessionTools();
    scan();
    scheduleRuntimeHealthCheck(0);
  });
  // Commit the idempotency marker only after every synchronous bootstrap step
  // succeeded. If an earlier step throws, CDP can inject this module again.
  window.__codeyRendererCoreLoaded = true;
})();
