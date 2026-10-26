// 在运行 Codey 的 Windows 主机执行。仅查询当前页面，不安装适配器或执行业务写操作。
// 用法：node docs/handoffs/2026-10-26-codex-compatibility-probe.mjs [CDP端口]
const port = Number(process.argv[2] || 9229);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("CDP 端口无效");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.url === "app://-/index.html");
if (!target) throw Error("没有找到 Codex 主页面");
const expression = async () => {
  const capabilities = {};
  for (const feature of ["session", "sidebarDelete", "deleteMessages", "refresh", "usage", "mcpReload", "reconcile"]) {
    try {
      const controller = await window.__codeyLoadCodexSessionController({ feature });
      capabilities[feature] = { available: true, kind: controller.kind };
    } catch (error) {
      capabilities[feature] = { available: false, code: error.code, message: error.message };
    }
  }
  const entry = [...document.scripts].map((item) => item.src).find((url) => /\/assets\/index-/.test(url));
  if (!entry) throw Error("没有找到页面入口资源");
  const source = await (await fetch(entry)).text();
  const urls = window.__codeyCodexAssetReferencesFromSource(source, entry);
  const resources = [];
  let native = null;
  for (const url of urls) {
    const text = await (await fetch(url)).text();
    const module = await import(url);
    const candidates = Object.values(module).filter((value) => typeof value === "function"
      && /AppServerManager RPC is unavailable for hostId:/.test(Function.prototype.toString.call(value))
      && /\.forHost\(/.test(Function.prototype.toString.call(value)));
    resources.push({
      url,
      registryLookupCount: text.split("getForHostId(").length - 1,
      oldResolverFound: Boolean(window.__codeyAppServerManagerResolverFromModule(module)),
      newResolverCount: candidates.length,
    });
    if (native || candidates.length !== 1) continue;
    const manager = window.__codeyAppServerManagerFromReact(candidates[0]);
    if (!manager) continue;
    const hostRequest = manager.getHostId();
    let hostId;
    try { hostId = await hostRequest; }
    finally { hostRequest?.[Symbol.dispose]?.(); }
    const id = window.__codeyGetSessionId();
    if (!id) {
      native = { type: typeof manager, hostId, currentConversationKnown: false };
      continue;
    }
    const conversation = manager.getConversation(id);
    const usageRequest = conversation.latestTokenUsageInfo;
    let usage;
    try { usage = await usageRequest; }
    finally {
      usageRequest?.[Symbol.dispose]?.();
      conversation?.[Symbol.dispose]?.();
    }
    native = {
      type: typeof manager,
      hostId,
      subscribeType: typeof manager.subscribe,
      currentConversationKnown: true,
      storedUsagePresent: Boolean(usage),
      storedUsageKeys: usage ? Object.keys(usage) : [],
    };
  }
  const rows = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].slice(0, 3).map((row) => {
    const button = row.querySelector("[data-codey-session-delete]");
    if (!button) return { buttonPresent: false };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      buttonPresent: true,
      rowRect: row.getBoundingClientRect().toJSON(),
      buttonRect: rect.toJSON(),
      buttonHit: button === hit || button.contains(hit),
      actionParentClass: button.parentElement.className,
      actionParentDisplay: getComputedStyle(button.parentElement).display,
    };
  });
  const bridge = window.electronBridge;
  const descriptor = bridge && Object.getOwnPropertyDescriptor(bridge, "sendMessageFromView");
  return {
    observedAt: new Date().toISOString(),
    entry,
    capabilities,
    resources,
    native,
    rows,
    usage: window.__codeyComposerUsage?.snapshot(),
    locale: window.__codeyDefaultChineseLocale?.snapshot(),
    serviceTier: window.__codeyServiceTierStatus,
    model: window.__codeyModelWhitelistPatch?.snapshot(),
    modelDelivery: window.__codeyModelWhitelistPatch?.delivery(),
    pluginBridge: {
      frozen: Boolean(bridge && Object.isFrozen(bridge)),
      writable: descriptor?.writable,
      patched: Boolean(bridge?.sendMessageFromView?.__codeyPatched),
      reportedStatus: window.__codeyInjectionStatus?.["plugin-marketplace-compatibility"],
    },
    settingsEntryPresent: Boolean(document.getElementById("codey-settings-button")),
    accountUsageVisible: Boolean(document.getElementById("codey-account-usage")?.getBoundingClientRect().width),
  };
};
const socket = new WebSocket(target.webSocketDebuggerUrl);
const timeout = setTimeout(() => {
  console.error("只读探针超时；没有执行删除、重载、配置写入或模型请求");
  socket.close();
  process.exitCode = 1;
}, 25000);
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const response = await new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) resolve(message);
    });
    socket.addEventListener("close", () => reject(Error("CDP 连接提前关闭")), { once: true });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression: `(${expression.toString()})()`, returnByValue: true, awaitPromise: true,
    } }));
  });
  if (response.error || response.result?.exceptionDetails) {
    throw Error(JSON.stringify(response.error || response.result.exceptionDetails));
  }
  console.log(JSON.stringify(response.result.result.value, null, 2));
} finally {
  clearTimeout(timeout);
  socket.close();
}
