import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { readSource } from "./helpers/read-source.mjs";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const channels = await loadTypeScriptModule(new URL("../src/channels.ts", import.meta.url));
const { isStaleConfig } = await loadTypeScriptModule(new URL("../src/configCommandResult.ts", import.meta.url));

const entry = (id, overrides = {}) => ({
  id,
  kind: id.startsWith("official") ? "official" : "provider",
  providerId: id.startsWith("official") ? "openai" : id.split(":")[1],
  displayName: id.split(":")[1].toUpperCase(),
  defaultModel: null,
  current: false,
  available: true,
  unavailableReason: null,
  ...overrides,
});
const listOf = (channelsList, selectedChannelId = null, notice = null) => ({
  channels: channelsList,
  selectedChannelId,
  effectiveProviderId: "a",
  notice,
});
const initialList = listOf([entry("provider:a", { current: true, defaultModel: "ma" }), entry("provider:b")]);

// 默认 Codex 在运行且使用者确认重启；confirm 为 false 模拟取消。
function harness({ revision = 5, handler, running = true, confirm = true }) {
  const state = {
    config: { settingsRevision: revision, selectedChannelId: null, defaultModelsByChannel: {} },
    list: initialList,
    calls: [],
    confirmations: [],
    restarts: 0,
    notice: undefined,
  };
  const controller = channels.createChannelController({
    call: async (command, args) => {
      state.calls.push({ command, args });
      return handler(command, args, state);
    },
    readConfig: () => state.config,
    // 与 App 的接纳流程一致：旧修订被拒绝。
    adopt: (config) => {
      if (isStaleConfig(state.config, config)) return false;
      state.config = config;
      return true;
    },
    setChannelList: (list) => { state.list = list; },
    setChannelNotice: (notice) => { state.notice = notice; },
    codexRunning: () => running,
    confirmSwitch: async (target) => {
      // 记录确认发生时已发送的命令数，用来证明确认先于切换命令。
      state.confirmations.push({ target, callsBefore: state.calls.length });
      return confirm;
    },
    restart: () => { state.restarts += 1; },
  });
  return { state, controller };
}
const mutation = (list, settingsRevision, restartRequired) => ({ status: "ok", channelList: list, settingsRevision, restartRequired });
const selectedB = listOf([entry("provider:a", { defaultModel: "ma" }), entry("provider:b", { current: true, defaultModel: "mb" })], "provider:b");

test("选择已有默认模型的渠道：只调用选择命令并带当前修订", async () => {
  const { state, controller } = harness({ handler: () => mutation(selectedB, 6, true) });
  const outcome = await controller.select("provider:b");
  assert.deepEqual(state.calls, [{ command: "select_channel", args: { channelId: "provider:b", expectedRevision: 5 } }]);
  assert.deepEqual(outcome, { kind: "applied", restartRequired: true, restart: "started" });
  assert.equal(state.list, selectedB);
  assert.equal(state.config.settingsRevision, 6);
  assert.equal(state.config.selectedChannelId, "provider:b");
  assert.equal(state.config.defaultModelsByChannel["provider:b"], "mb");
});

test("选择没有默认模型的渠道：先保存默认模型，再用返回的修订选择", async () => {
  const savedList = listOf([entry("provider:a", { current: true, defaultModel: "ma" }), entry("provider:b", { defaultModel: "mb" })]);
  const { state, controller } = harness({
    handler: (command) => command === "set_channel_default_model" ? mutation(savedList, 6, false) : mutation(selectedB, 7, true),
  });
  const outcome = await controller.select("provider:b", "mb");
  assert.deepEqual(state.calls, [
    { command: "set_channel_default_model", args: { channelId: "provider:b", model: "mb", expectedRevision: 5 } },
    { command: "select_channel", args: { channelId: "provider:b", expectedRevision: 6 } },
  ]);
  assert.equal(outcome.kind, "applied");
  assert.equal(state.config.settingsRevision, 7);
});

test("跟随用户配置：channelId 为 null 且不保存默认模型", async () => {
  const followed = listOf(initialList.channels, null);
  const { state, controller } = harness({ revision: 8, handler: () => mutation(followed, 9, false) });
  await controller.select(null);
  assert.deepEqual(state.calls, [{ command: "select_channel", args: { channelId: null, expectedRevision: 8 } }]);
  assert.equal(state.config.selectedChannelId, null);
});

test("Codex 运行时切换前先确认；确认后只发一次切换命令，再直接重启一次", async () => {
  const needs = harness({ handler: () => mutation(selectedB, 6, true) });
  await needs.controller.select("provider:b");
  assert.deepEqual(needs.state.confirmations, [{ target: "channel", callsBefore: 0 }], "确认先于任何命令");
  assert.deepEqual(needs.state.calls.map((call) => call.command), ["select_channel"]);
  assert.equal(needs.state.restarts, 1);

  const none = harness({ handler: () => mutation(selectedB, 6, false) });
  const outcome = await none.controller.select("provider:b");
  assert.deepEqual(outcome, { kind: "applied", restartRequired: false, restart: "none" });
  assert.equal(none.state.restarts, 0, "后端不要求重启时不重启");
});

test("取消切换确认：不发送任何命令，也不重启", async () => {
  for (const [label, run] of [
    ["选择渠道", (controller) => controller.select("provider:b")],
    ["保存并切换", (controller) => controller.select("provider:b", "mb")],
    ["跟随用户配置", (controller) => controller.select(null)],
  ]) {
    const { state, controller } = harness({ confirm: false, handler: () => mutation(selectedB, 6, true) });
    const outcome = await run(controller);
    assert.deepEqual(outcome, { kind: "cancelled" }, label);
    assert.deepEqual(state.calls, [], label);
    assert.equal(state.confirmations.length, 1, label);
    assert.equal(state.restarts, 0, label);
    assert.equal(state.config.settingsRevision, 5, label);
  }
  const account = harness({ confirm: false, handler: () => accountSwitch("acct", 6) });
  const switched = await account.controller.switchOfficialAccount("acct");
  assert.deepEqual(switched, { outcome: { kind: "cancelled" }, accounts: null, listError: null });
  assert.deepEqual(account.state.calls, []);
  assert.deepEqual(account.state.confirmations, [{ target: "official-account", callsBefore: 0 }]);
  assert.equal(account.state.restarts, 0);
});

test("Codex 未运行时不确认、直接切换，也不重启，结果标为下次启动生效", async () => {
  // 后端在 Codex 未运行时对 provider 渠道返回 restartRequired: false，提示不能依赖它。
  const channel = harness({ running: false, handler: () => mutation(selectedB, 6, false) });
  const outcome = await channel.controller.select("provider:b");
  assert.deepEqual(outcome, { kind: "applied", restartRequired: false, restart: "next-start" });
  assert.deepEqual(channel.state.confirmations, []);
  assert.deepEqual(channel.state.calls.map((call) => call.command), ["select_channel"]);
  assert.equal(channel.state.restarts, 0);

  const account = harness({ running: false, handler: (command) => command === "set_default_official_account" ? accountSwitch("acct", 6) : officialSelected });
  const switched = await account.controller.switchOfficialAccount("acct");
  assert.deepEqual(switched.outcome, { kind: "applied", restartRequired: true, restart: "next-start" });
  assert.deepEqual(account.state.confirmations, []);
  assert.equal(account.state.calls.filter((call) => call.command === "set_default_official_account").length, 1);
  assert.equal(account.state.restarts, 0);
});

test("单独保存默认模型不确认、不重启", async () => {
  const { state, controller } = harness({ handler: () => mutation(selectedB, 6, true) });
  const outcome = await controller.setDefaultModel("provider:a", "ma-2");
  assert.deepEqual(outcome, { kind: "applied", restartRequired: true, restart: "none" });
  assert.deepEqual(state.confirmations, []);
  assert.equal(state.restarts, 0);
});

// 与 ConfirmationDialogHost 一致：确认时先清除对话框再执行 run，关闭时只清除。
function dialogHost() {
  let current = null;
  const listeners = new Set();
  const set = (next) => { current = next; listeners.forEach((listener) => listener()); };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => current,
    setConfirmation: set,
    confirm: () => { const pending = current; set(null); pending.run(); },
    close: () => set(null),
    listeners,
  };
}
const SWITCH_DIALOG = { action: "restart", title: "切换渠道并重启 Codex？", description: "d", confirmLabel: "切换并重启" };

test("确认对话框包装：确认得到 true，关闭或被替换得到 false，结束后取消订阅", async () => {
  const confirmed = dialogHost();
  const yes = channels.confirmThroughDialog(confirmed, SWITCH_DIALOG);
  assert.equal(confirmed.getSnapshot().title, SWITCH_DIALOG.title);
  confirmed.confirm();
  assert.equal(await yes, true);
  assert.equal(confirmed.listeners.size, 0);

  const closed = dialogHost();
  const no = channels.confirmThroughDialog(closed, SWITCH_DIALOG);
  closed.close();
  assert.equal(await no, false);
  assert.equal(closed.listeners.size, 0);

  const replaced = dialogHost();
  const other = channels.confirmThroughDialog(replaced, SWITCH_DIALOG);
  replaced.setConfirmation({ ...SWITCH_DIALOG, title: "其他确认", run: () => {} });
  assert.equal(await other, false);
});

test("切换失败：保留原渠道与修订，显示后端消息，不触发重启", async () => {
  const message = "请先为渠道设置默认模型";
  const { state, controller } = harness({ handler: () => { throw new Error(message); } });
  const outcome = await controller.select("provider:b");
  assert.deepEqual(outcome, { kind: "failed", message, conflict: false });
  assert.equal(state.list, initialList);
  assert.equal(state.config.settingsRevision, 5);
  assert.equal(state.config.selectedChannelId, null);
  assert.equal(state.restarts, 0);
});

test("保存默认模型失败时不再选择渠道", async () => {
  const { state, controller } = harness({ handler: () => { throw new Error("渠道默认模型不能为空"); } });
  const outcome = await controller.select("provider:b", " ");
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(state.calls.map((call) => call.command), ["set_channel_default_model"]);
  assert.equal(state.list, initialList);
});

test("默认模型已保存但选择失败：采用新修订和列表，当前渠道不变", async () => {
  const savedList = listOf([entry("provider:a", { current: true, defaultModel: "ma" }), entry("provider:b", { defaultModel: "mb" })]);
  const { state, controller } = harness({
    handler: (command) => {
      if (command === "set_channel_default_model") return mutation(savedList, 6, false);
      throw new Error("所选渠道不可用");
    },
  });
  const outcome = await controller.select("provider:b", "mb");
  assert.equal(outcome.kind, "failed");
  assert.equal(state.list, savedList);
  assert.equal(state.config.settingsRevision, 6);
  assert.equal(state.list.channels.find((item) => item.current).id, "provider:a");
  assert.equal(state.restarts, 0);
});

test("版本冲突失败带冲突标记，提示使用者刷新", async () => {
  const { controller } = harness({ handler: () => { throw new Error("Codey 设置已被其他操作更新，请刷新后重试"); } });
  const outcome = await controller.select("provider:b");
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.conflict, true);
});

test("较新的渠道变更接纳后，在途的旧列表响应被忽略", async () => {
  let resolveList;
  const { state, controller } = harness({
    handler: (command) => command === "list_channels"
      ? new Promise((resolve) => { resolveList = resolve; })
      : mutation(selectedB, 6, false),
  });
  const pendingList = controller.refresh();
  await controller.select("provider:b");
  resolveList(listOf([entry("provider:a", { current: true })]));
  assert.deepEqual(await pendingList, { kind: "stale" });
  assert.equal(state.list, selectedB);
});

test("较新的列表请求发出后，更早的列表响应被忽略", async () => {
  const resolvers = [];
  const { state, controller } = harness({
    handler: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const first = controller.refresh();
  const second = controller.refresh();
  const newer = listOf([entry("provider:b", { current: true })]);
  resolvers[1](newer);
  assert.equal((await second).kind, "applied");
  resolvers[0](listOf([entry("provider:a", { current: true })]));
  assert.deepEqual(await first, { kind: "stale" });
  assert.equal(state.list, newer);
});

test("修订低于已接纳修订的变更结果被忽略", async () => {
  const { state, controller } = harness({
    handler: (_command, _args, current) => {
      current.config = { ...current.config, settingsRevision: 9 };
      return mutation(selectedB, 6, true);
    },
  });
  const outcome = await controller.select("provider:b");
  assert.deepEqual(outcome, { kind: "stale" });
  assert.equal(state.list, initialList);
  assert.equal(state.config.settingsRevision, 9);
  assert.equal(state.restarts, 0);
});

test("渠道列表读取失败不改动现有列表", async () => {
  const { state, controller } = harness({ handler: () => { throw new Error("bridge 未连接"); } });
  const outcome = await controller.refresh();
  assert.equal(outcome.kind, "failed");
  assert.equal(state.list, initialList);
});

test("渠道结果并入配置时保留其他渠道的默认模型", () => {
  const merged = channels.mergeChannelResult(
    { settingsRevision: 1, selectedChannelId: null, defaultModelsByChannel: { "provider:gone": "old" } },
    mutation(selectedB, 2, false),
  );
  assert.equal(merged.settingsRevision, 2);
  assert.equal(merged.selectedChannelId, "provider:b");
  assert.deepEqual(merged.defaultModelsByChannel, { "provider:gone": "old", "provider:a": "ma", "provider:b": "mb" });
  const legacy = channels.mergeChannelResult({ settingsRevision: 1 }, mutation(selectedB, 2, false));
  assert.equal(legacy.defaultModelsByChannel["provider:b"], "mb");
});

test("无法选择的渠道：当前、不可用和无稳定账号标识的官方占位", () => {
  assert.equal(channels.canSelectChannel(entry("provider:b")), true);
  assert.equal(channels.canSelectChannel(entry("provider:a", { current: true })), false);
  assert.equal(channels.canSelectChannel(entry("provider:x", { available: false })), false);
  assert.equal(channels.canSelectChannel(entry("official:unavailable")), false);
  assert.equal(channels.needsDefaultModel(entry("provider:b")), true);
  assert.equal(channels.needsDefaultModel(entry("provider:b", { defaultModel: "m" })), false);
});

const accountSwitch = (accountId, settingsRevision, restartRequired = true) => ({
  status: "ok",
  accounts: [{ id: accountId, accountId: `acct-${accountId}`, addedAt: 1, invalid: false, isDefault: true }],
  defaultAccountId: accountId,
  officialAccountAvailable: true,
  officialAccountStatus: "authenticated",
  switchDisabledReason: null,
  accountId,
  restartRequired,
  settingsRevision,
});
const officialSelected = listOf([
  entry("provider:a", { defaultModel: "ma" }),
  entry("official:acct", { current: true, defaultModel: "global-default" }),
], "official:acct");

test("切换官方账号：只带账号标识，接纳新修订与所选渠道，确认后直接重启", async () => {
  const { state, controller } = harness({
    handler: (command) => command === "set_default_official_account" ? accountSwitch("acct", 6) : officialSelected,
  });
  const switched = await controller.switchOfficialAccount("acct");
  assert.deepEqual(state.calls.slice(0, 2), [
    { command: "set_default_official_account", args: { accountId: "acct" } },
    { command: "list_channels", args: {} },
  ]);
  assert.deepEqual(switched.outcome, { kind: "applied", restartRequired: true, restart: "started" });
  assert.equal(switched.accounts.accountId, "acct");
  assert.equal(state.restarts, 1, "切换前已确认，切换成功后直接重启一次");
  assert.equal(state.config.settingsRevision, 6);
  assert.equal(state.config.selectedChannelId, "official:acct");
  assert.equal(state.config.defaultModelsByChannel["official:acct"], "global-default", "后端补上的默认模型进入配置");
  assert.equal(state.list, officialSelected);
  assert.equal(state.calls.some((call) => call.command === "restart_codey"), false);
});

test("切换官方账号后，下一次渠道操作带上新修订，不会触发版本冲突", async () => {
  const { state, controller } = harness({
    handler: (command, args) => {
      if (command === "set_default_official_account") return accountSwitch("acct", 6);
      if (command === "list_channels") return officialSelected;
      if (args.expectedRevision !== 6) throw new Error("Codey 设置已被其他操作更新，请刷新后重试");
      return mutation(selectedB, 7, true);
    },
  });
  await controller.switchOfficialAccount("acct");
  const outcome = await controller.select("provider:b");
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(state.calls.at(-1), { command: "select_channel", args: { channelId: "provider:b", expectedRevision: 6 } });
});

test("切换官方账号失败：不改动配置与列表，不触发重启", async () => {
  const { state, controller } = harness({ handler: () => { throw new Error("找不到官方账号"); } });
  const switched = await controller.switchOfficialAccount("gone");
  assert.deepEqual(switched, { outcome: { kind: "failed", message: "找不到官方账号", conflict: false }, accounts: null, listError: null });
  assert.equal(state.config.settingsRevision, 5);
  assert.equal(state.list, initialList);
  assert.equal(state.restarts, 0);
});

test("切换官方账号后渠道列表读取失败：仍接纳修订与所选渠道并提示重启", async () => {
  const { state, controller } = harness({
    handler: (command) => {
      if (command === "set_default_official_account") return accountSwitch("acct", 6);
      throw new Error("bridge 未连接");
    },
  });
  const switched = await controller.switchOfficialAccount("acct");
  assert.equal(switched.outcome.kind, "applied");
  assert.equal(switched.listError, "bridge 未连接");
  assert.equal(state.config.settingsRevision, 6);
  assert.equal(state.config.selectedChannelId, "official:acct");
  assert.equal(state.list, initialList);
  assert.equal(state.restarts, 1);
});

test("切换官方账号的修订低于已接纳修订：配置不回退，不触发重启，但返回账号列表", async () => {
  const { state, controller } = harness({
    handler: (command, _args, current) => {
      if (command === "set_default_official_account") {
        current.config = { ...current.config, settingsRevision: 9 };
        return accountSwitch("acct", 6);
      }
      return officialSelected;
    },
  });
  const switched = await controller.switchOfficialAccount("acct");
  assert.deepEqual(switched.outcome, { kind: "stale" });
  assert.equal(switched.accounts.accountId, "acct");
  assert.equal(state.config.settingsRevision, 9);
  assert.equal(state.restarts, 0);
});

const FALLBACK = "所选渠道已不可用，已回退到用户配置的默认 provider。";
const withNotice = (notice) => listOf(initialList.channels, null, notice);

test("回退提示以最近到达的响应为准：较晚的运行状态 null 清除列表里的旧提示", async () => {
  const { state, controller } = harness({ handler: () => withNotice(FALLBACK) });
  await controller.refresh();
  assert.equal(state.notice, FALLBACK);
  controller.noteStatusNotice(null);
  assert.equal(state.notice, null);
});

test("回退提示以最近到达的响应为准：较晚的列表 null 清除运行状态里的旧提示", async () => {
  const { state, controller } = harness({ handler: () => withNotice(null) });
  controller.noteStatusNotice(FALLBACK);
  assert.equal(state.notice, FALLBACK);
  await controller.refresh();
  assert.equal(state.notice, null);
});

test("被忽略的旧列表响应不改动回退提示，渠道变更的列表会更新它", async () => {
  let resolveList;
  const { state, controller } = harness({
    handler: (command) => command === "list_channels"
      ? new Promise((resolve) => { resolveList = resolve; })
      : mutation(listOf(selectedB.channels, "provider:b", null), 6, false),
  });
  controller.noteStatusNotice(FALLBACK);
  const pending = controller.refresh();
  await controller.select("provider:b");
  assert.equal(state.notice, null, "渠道变更返回的列表没有提示");
  resolveList(withNotice(FALLBACK));
  assert.equal((await pending).kind, "stale");
  assert.equal(state.notice, null);
});

test("渠道变更已保存后读取当前 provider 失败：错误提示不被成功提示覆盖", async () => {
  const success = { tone: "info", text: "已切换渠道" };
  const failed = await channels.noticeAfterChannelChange(async () => { throw new Error("读取超时"); }, success);
  assert.equal(failed.tone, "error");
  assert.ok(failed.text.includes("读取超时"));
  assert.notEqual(failed, success);
  assert.equal(await channels.noticeAfterChannelChange(async () => {}, success), success);
});

// 用真实的 useRuntimeStatus 与可控计时器驱动后台轮询，确认每个被接纳的响应都会应用回退提示。
function runtimeStatusPolling(context) {
  let cursor = 0, now = 0, timerId = 0, current;
  const hooks = [], effects = [], timers = new Map(), requests = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      const cell = hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      cell.set ??= (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; };
      return [cell.value, cell.set];
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useMemo(factory, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || !same(previous.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (previous && same(previous.deps, deps)) return;
      hooks[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = effect(); });
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener() {}, removeEventListener() {},
  } });
  const realNow = Date.now;
  Date.now = () => now;
  const graph = createModuleGraph(new URL("../src/useRuntimeStatus.ts", import.meta.url), { stubs: {
    react,
    "./api": { invoke: (command, args) => new Promise((resolve) => requests.push({ command, args, resolve })) },
    "./appUtils": { withTimeout: (promise) => promise },
  } });
  context.after(() => {
    hooks.forEach((hook) => hook?.cleanup?.());
    Date.now = realNow;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  const render = (options) => {
    cursor = 0;
    current = graph.exports.useRuntimeStatus({ active: true, embedded: false, ...options });
    effects.splice(0).forEach((effect) => effect());
    return current;
  };
  const tick = async () => {
    const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) return false;
    timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  };
  return { render, tick, requests };
}

test("后台轮询返回的 null 也会清除之间由渠道列表设置的回退提示", async (context) => {
  const { state, controller } = harness({ handler: () => withNotice(FALLBACK) });
  const poll = runtimeStatusPolling(context);
  const options = { onStatusResponse: (next) => controller.noteStatusNotice(next.channelNotice ?? null) };
  poll.render(options).acceptConfigApply({ revision: 1, state: "pending" });
  poll.render(options);
  const reply = async (body) => {
    assert.equal(await poll.tick(), true, "后台轮询应已排队");
    poll.requests.at(-1).resolve({ running: true, channelNotice: null, ...body });
    await new Promise((resolve) => setImmediate(resolve));
    poll.render(options);
  };
  await reply({ configApply: { revision: 1, state: "pending" } });
  assert.equal(state.notice, null);
  await controller.refresh();
  assert.equal(state.notice, FALLBACK, "列表设置了回退提示");
  await reply({ configApply: { revision: 1, state: "applied" } });
  assert.equal(state.notice, null, "第二次后台 null 响应清除提示");
});

test("未被接纳的运行状态响应不触发回退提示回调", async (context) => {
  const poll = runtimeStatusPolling(context);
  const seen = [];
  const hook = poll.render({ active: false, onStatusResponse: (next) => seen.push(next) });
  const pending = hook.refreshStatus();
  poll.requests.at(-1).resolve({ running: true, channelNotice: "x" });
  await pending;
  assert.deepEqual(seen, []);
});

// 编译并运行开发用的模拟接口：只把 Vite 的开发开关替换为 true。
let mockInstance = 0;
async function compileMock(url, root) {
  const source = (await readFile(url, "utf8")).replaceAll("import.meta.env.DEV", "true");
  let out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const parsed = ts.createSourceFile("mock.js", out, ts.ScriptTarget.ES2020, true);
  const replacements = [];
  for (const statement of parsed.statements) {
    const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
    if (!specifier || !specifier.text.startsWith(".")) continue;
    const base = new URL(specifier.text, url);
    let dependency;
    for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
      try { await readFile(new URL(base.href + suffix)); dependency = new URL(base.href + suffix); break; } catch { /* 尝试下一个后缀 */ }
    }
    assert.ok(dependency, `无法解析：${specifier.text}`);
    replacements.push([specifier.getStart(parsed), specifier.end, JSON.stringify(await compileMock(dependency, false))]);
  }
  for (const [start, end, text] of replacements.reverse()) out = out.slice(0, start) + text + out.slice(end);
  if (root) out += `\n//# instance ${++mockInstance}`;
  return `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
}
async function loadMock(search = "", log = () => {}) {
  const savedWindow = globalThis.window;
  const savedLog = console.log;
  globalThis.window = { location: { search }, addEventListener() {}, localStorage: { getItem() {}, setItem() {} } };
  globalThis.document ??= {};
  console.log = () => {};
  try {
    await import(await compileMock(new URL("../src/dev/mockApi.ts", import.meta.url), true));
  } finally {
    console.log = savedLog;
  }
  const api = globalThis.window.__codeyInvokeApi;
  globalThis.window = savedWindow;
  const nativeTimeout = globalThis.setTimeout;
  return async (command, args = {}) => {
    const savedConsole = console.log;
    console.log = log;
    globalThis.setTimeout = (callback) => nativeTimeout(callback, 0);
    try { return await api(command, args); } finally { globalThis.setTimeout = nativeTimeout; console.log = savedConsole; }
  };
}
const failedWith = (message) => ({ status: "failed", message });

test("模拟接口：列表字段、跟随用户配置与回退提示", async () => {
  const call = await loadMock();
  const list = await call("list_channels");
  assert.equal(list.selectedChannelId, null);
  assert.equal(list.notice, null);
  assert.deepEqual(Object.keys(list.channels[0]).sort(),
    ["available", "current", "defaultModel", "displayName", "id", "kind", "providerId", "unavailableReason"]);
  assert.equal((await call("runtime_status")).channelNotice, null);
  const fallback = await loadMock("?channelFallback=1");
  assert.equal((await fallback("list_channels")).notice, FALLBACK);
  assert.equal((await fallback("runtime_status")).channelNotice, FALLBACK);
});

test("模拟接口：校验与后端一致，不可用渠道和非整数修订被拒绝", async () => {
  const call = await loadMock();
  assert.deepEqual(await call("set_channel_default_model", { channelId: "official:unavailable", model: "m", expectedRevision: 0 }),
    failedWith("所选渠道不可用"));
  assert.deepEqual(await call("set_channel_default_model", { channelId: "provider:offline", model: "m", expectedRevision: 0 }),
    failedWith("所选渠道不可用"));
  assert.deepEqual(await call("set_channel_default_model", { channelId: "provider:nope", model: "m", expectedRevision: 0 }),
    failedWith("所选渠道不可用"));
  assert.deepEqual(await call("set_channel_default_model", { channelId: "provider:backup", model: " ", expectedRevision: 0 }),
    failedWith("渠道默认模型不能为空"));
  assert.deepEqual(await call("set_channel_default_model", { channelId: "provider:backup", model: "m", expectedRevision: "0" }),
    failedWith('参数 expectedRevision 无效：invalid type: string "0", expected u64'));
  assert.deepEqual(await call("select_channel", { channelId: null, expectedRevision: 1.5 }),
    failedWith("参数 expectedRevision 无效：invalid type: floating point `1.5`, expected u64"));
  assert.deepEqual(await call("select_channel", { channelId: null, expectedRevision: -1 }),
    failedWith("参数 expectedRevision 无效：invalid value: integer `-1`, expected u64"));
  assert.deepEqual(await call("select_channel", { channelId: null, expectedRevision: null }),
    failedWith("参数 expectedRevision 无效：invalid type: null, expected u64"));
  assert.deepEqual(await call("select_channel", { channelId: null }), failedWith("缺少参数：expectedRevision"));
  assert.deepEqual(await call("select_channel", { expectedRevision: 0 }), failedWith("缺少参数：channelId"));
  assert.deepEqual(await call("set_channel_default_model", { channelId: null, model: "m", expectedRevision: 0 }),
    failedWith("参数 channelId 无效：invalid type: null, expected a string"));
  assert.deepEqual(await call("select_channel", { channelId: "official:unavailable", expectedRevision: 0 }),
    failedWith("所选渠道不可用"));
  assert.deepEqual(await call("select_channel", { channelId: "provider:backup", expectedRevision: 0 }),
    failedWith("请先为渠道设置默认模型"));
  assert.deepEqual(await call("select_channel", { channelId: "provider:backup", expectedRevision: 7 }),
    failedWith("Codey 设置已被其他操作更新，请刷新后重试"));
  assert.equal((await call("list_channels")).channels.find((item) => item.id === "official:unavailable").defaultModel, null);
  assert.equal((await call("load_codey_config")).config.settingsRevision, 0, "失败不改动修订");
});

test("模拟接口：成功路径递增修订，重启后不再要求重启", async () => {
  const call = await loadMock();
  const saved = await call("set_channel_default_model", { channelId: "provider:backup", model: " claude-x ", expectedRevision: 0 });
  assert.equal(saved.status, "ok");
  assert.equal(saved.settingsRevision, 1);
  assert.equal(saved.restartRequired, false);
  assert.equal(saved.channelList.channels.find((item) => item.id === "provider:backup").defaultModel, "claude-x");
  const selected = await call("select_channel", { channelId: "provider:backup", expectedRevision: 1 });
  assert.equal(selected.settingsRevision, 2);
  assert.equal(selected.restartRequired, true);
  assert.equal((await call("load_codey_config")).currentProviderSnapshot.channelId, "provider:backup");
  await call("restart_codey");
  assert.equal((await call("runtime_status")).restartRequired, false);
  const followed = await call("select_channel", { channelId: null, expectedRevision: 2 });
  assert.equal(followed.channelList.selectedChannelId, null);
  assert.equal("channelId" in (await call("load_codey_config")).currentProviderSnapshot, false);
});

test("模拟接口：每个官方账号是一个渠道，账号摘要不含令牌", async () => {
  const call = await loadMock();
  const accounts = await call("list_official_accounts");
  assert.equal(accounts.status, "ok");
  assert.equal(accounts.switchDisabledReason, null);
  assert.doesNotMatch(JSON.stringify(accounts), /token/i);
  const channelIds = (await call("list_channels")).channels.map((item) => item.id);
  for (const item of accounts.accounts) assert.ok(channelIds.includes(`official:${item.id}`), item.id);
});

test("模拟接口：切换官方账号递增修订、选中官方渠道并补上全局默认模型", async () => {
  const call = await loadMock();
  const switched = await call("set_default_official_account", { accountId: "preview-pro" });
  assert.equal(switched.settingsRevision, 1);
  assert.equal(switched.restartRequired, true);
  assert.equal(switched.defaultAccountId, "preview-pro");
  const list = await call("list_channels");
  const current = list.channels.find((item) => item.current);
  assert.equal(current.id, "official:preview-pro");
  assert.equal(current.defaultModel, (await call("load_codey_config")).config.defaultModel);
  assert.deepEqual(await call("set_default_official_account", { accountId: "gone" }), failedWith("找不到官方账号"));
  assert.deepEqual(await call("set_default_official_account", {}), failedWith("缺少参数：accountId"));
});

test("模拟接口：在渠道列表选择库内官方账号的渠道，同样切换 Codex 当前登录的账号", async () => {
  const call = await loadMock();
  await call("set_channel_default_model", { channelId: "official:preview-pro", model: "gpt-x", expectedRevision: 0 });
  const selected = await call("select_channel", { channelId: "official:preview-pro", expectedRevision: 1 });
  assert.equal(selected.restartRequired, true);
  assert.equal((await call("list_official_accounts")).defaultAccountId, "preview-pro");
});

test("模拟接口：凭据存储不是 file 模式时拒绝导入当前登录与切换", async () => {
  const call = await loadMock("?officialSwitchDisabled=1");
  const reason = (await call("list_official_accounts")).switchDisabledReason;
  assert.match(reason, /不是 file 模式/);
  assert.deepEqual(await call("import_current_codex_login"), failedWith(reason));
  assert.deepEqual(await call("set_default_official_account", { accountId: "preview-pro" }), failedWith(reason));
  // 与后端一致：官方渠道显示为不可用，渠道列表也不能绕过禁用原因。
  const official = (await call("list_channels")).channels.filter((item) => item.kind === "official" && item.id !== "official:unavailable");
  assert.ok(official.length > 0);
  for (const item of official) {
    assert.equal(item.available, false, item.id);
    assert.equal(item.unavailableReason, reason, item.id);
  }
  assert.deepEqual(await call("set_channel_default_model", { channelId: "official:preview-pro", model: "gpt-x", expectedRevision: 0 }),
    failedWith("所选渠道不可用"));
  assert.deepEqual(await call("select_channel", { channelId: "official:preview-pro", expectedRevision: 0 }), failedWith("所选渠道不可用"));
  assert.equal((await call("load_codey_config")).config.settingsRevision, 0, "失败不改动修订");
  assert.equal((await call("list_official_accounts")).defaultAccountId, "preview-account", "失败不切换账号");
});

test("模拟接口：粘贴凭据的校验文案与后端一致，日志不记录凭据", async () => {
  const logged = [];
  const call = await loadMock("", (...args) => logged.push(JSON.stringify(args)));
  assert.deepEqual(await call("import_official_account_credential", { credential: "  " }), failedWith("请粘贴刷新令牌或 OAuth JSON"));
  assert.deepEqual(await call("import_official_account_credential", { credential: "{bad" }), failedWith("OAuth JSON 格式无效"));
  assert.deepEqual(await call("import_official_account_credential", { credential: "[]" }), failedWith("OAuth JSON 必须是对象"));
  assert.deepEqual(await call("import_official_account_credential", { credential: "{}" }), failedWith("OAuth JSON 缺少访问令牌或刷新令牌"));
  assert.deepEqual(await call("import_official_account_credential", { credential: "short" }), failedWith("刷新令牌格式无效"));
  const added = await call("import_official_account_credential", { credential: "rt-secret-preview-value-0123456789" });
  assert.equal(added.status, "ok");
  assert.ok(added.accounts.some((item) => item.id === added.accountId));
  assert.ok(logged.length > 0);
  assert.doesNotMatch(logged.join("\n"), /rt-secret-preview-value/);
});

test("模拟接口：账号额度回写只接受最新代次，登录轮询在取消后过期", async () => {
  const call = await loadMock();
  const first = await call("query_official_account_usage", { accountId: "preview-account", forceRefresh: true });
  const second = await call("query_official_account_usage", { accountId: "preview-account", forceRefresh: true });
  assert.ok(second.authGeneration > first.authGeneration);
  assert.deepEqual(await call("store_official_account_usage", { accountId: "preview-account", authGeneration: first.authGeneration, snapshot: {} }),
    failedWith("官方账号状态已变化，忽略旧的额度结果"));
  assert.deepEqual(await call("store_official_account_usage", { accountId: "preview-account", authGeneration: second.authGeneration, snapshot: {} }), { status: "ok" });
  assert.deepEqual(await call("query_official_account_usage", { accountId: "gone" }), { status: "error", message: "找不到官方账号" });

  const started = await call("start_official_account_login");
  assert.equal(started.status, "wait");
  assert.deepEqual(await call("poll_official_account_login", { loginId: started.loginId }), { status: "wait" });
  assert.deepEqual(await call("cancel_official_account_login", { loginId: started.loginId }), { status: "ok" });
  assert.equal((await call("poll_official_account_login", { loginId: started.loginId })).status, "expired");
});

test("模拟接口：移除账号不改动 Codex 当前登录，也不自动切换其他账号", async () => {
  const call = await loadMock();
  const removed = await call("remove_official_account", { accountId: "preview-account" });
  assert.equal(removed.accounts.some((item) => item.id === "preview-account"), false);
  assert.equal(removed.defaultAccountId, null);
  assert.equal(removed.officialAccountAvailable, true, "Codex 登录仍在");
  const reimported = await call("import_current_codex_login");
  assert.equal(reimported.accountId, "preview-account", "移除后可以再次导入当前登录");
});

function section() {
  const ui = autoStubModule("ui");
  const combobox = autoStubModule("combobox");
  const graph = createModuleGraph(new URL("../src/ChannelSection.tsx", import.meta.url), {
    stubs: {
      "./components/ui": ui,
      "./components/ManualModelCombobox": combobox,
      "./overlay.constants": { SETTINGS_OVERLAY_Z_INDEX: 1 },
    },
  });
  const calls = [];
  const base = {
    channelList: null,
    loadError: null,
    actionError: null,
    versionConflict: false,
    notice: null,
    modelOptions: ["ma"],
    popupContainer: null,
    disabled: false,
    onSelect: (...args) => calls.push(["select", ...args]),
    onSetDefaultModel: (...args) => calls.push(["setDefault", ...args]),
    onRefresh: () => calls.push(["refresh"]),
  };
  const render = (props = {}) => {
    graph.restart();
    return graph.exports.ChannelSection({ ...base, ...props });
  };
  const buttons = (tree, label) => collectElements(tree, (node) =>
    elementType(node) === ui.Button && textContent(node).includes(label));
  return { render, calls, buttons, combobox };
}

const fullList = listOf([
  entry("provider:a", { displayName: "主中转", current: true, defaultModel: "ma" }),
  entry("provider:b", { displayName: "备用中转" }),
  entry("provider:offline", { displayName: "离线中转", available: false, unavailableReason: "环境变量 OFFLINE_API_KEY 未设置" }),
  entry("official:acct", { displayName: "官方账号 A", defaultModel: "gpt-x" }),
  entry("official:unavailable", { displayName: "官方账号（未登录）", available: false, unavailableReason: "没有可用的官方账号登录" }),
]);

test("列表显示名称、类型、默认模型、可用性、不可用原因和当前渠道", () => {
  const { render } = section();
  const text = textContent(render({ channelList: fullList }));
  for (const expected of [
    "主中转", "备用中转", "离线中转", "官方账号 A",
    "provider", "官方账号", "当前渠道：主中转", "默认模型：ma", "默认模型：gpt-x",
    "尚未设置默认模型", "不可用", "可用", "环境变量 OFFLINE_API_KEY 未设置", "没有可用的官方账号登录",
  ]) assert.ok(text.includes(expected), `缺少：${expected}`);
  assert.equal(text.split("当前渠道").length - 1, 2, "摘要与当前徽章各出现一次");
});

test("说明控制台是跟随用户配置还是手动选择了渠道", () => {
  const { render, buttons } = section();
  const following = render({ channelList: fullList });
  assert.ok(textContent(following).includes("跟随用户配置的默认 provider"));
  assert.equal(buttons(following, "跟随用户配置").length, 0);

  const chosen = listOf(fullList.channels.map((item) => ({ ...item, current: item.id === "provider:b" })), "provider:b");
  const chosenTree = render({ channelList: chosen });
  assert.ok(textContent(chosenTree).includes("当前渠道：备用中转（已手动选择）"));
  assert.equal(buttons(chosenTree, "跟随用户配置").length, 1);
});

test("跟随用户配置按钮以 null 选择渠道", () => {
  const { render, buttons, calls } = section();
  const chosen = listOf(fullList.channels.map((item) => ({ ...item, current: item.id === "provider:b" })), "provider:b");
  elementProps(buttons(render({ channelList: chosen }), "跟随用户配置")[0]).onPress();
  assert.deepEqual(calls, [["select", null]]);
});

test("当前、不可用和官方占位渠道的切换按钮被禁用", () => {
  const { render, buttons } = section();
  const tree = render({ channelList: fullList });
  const disabledByName = new Map(collectElements(tree, (node) => node.type === "li").map((item) => [
    textContent(item).slice(0, 12),
    buttons(item, "切换到此渠道").map((button) => elementProps(button).disabled),
  ]));
  const states = [...disabledByName.values()].flat();
  assert.deepEqual(states, [true, false, true, false, true]);
});

test("渠道已有默认模型时直接选择", () => {
  const { render, buttons, calls } = section();
  const tree = render({ channelList: fullList });
  const target = collectElements(tree, (node) => node.type === "li" && textContent(node).includes("官方账号 A"))[0];
  elementProps(buttons(target, "切换到此渠道")[0]).onPress();
  assert.deepEqual(calls, [["select", "official:acct"]]);
});

test("渠道没有默认模型时先要求输入，保存并切换后才选择", () => {
  const { render, buttons, calls, combobox } = section();
  const props = { channelList: fullList };
  const target = (tree) => collectElements(tree, (node) => node.type === "li" && textContent(node).includes("备用中转"))[0];
  elementProps(buttons(target(render(props)), "切换到此渠道")[0]).onPress();
  assert.deepEqual(calls, [], "没有默认模型时不能直接选择");

  const editing = render(props);
  const input = collectElements(editing, (node) => elementType(node) === combobox.ManualModelCombobox)[0];
  assert.ok(input, "出现默认模型输入");
  assert.deepEqual(buttons(editing, "保存并切换").map((button) => elementProps(button).disabled), [true]);
  elementProps(input).onChange(" mb ");

  const filled = render(props);
  elementProps(buttons(filled, "保存并切换")[0]).onPress();
  assert.deepEqual(calls, [["select", "provider:b", "mb"]]);
});

test("单独设置默认模型只保存，不切换渠道", () => {
  const { render, buttons, calls, combobox } = section();
  const props = { channelList: fullList };
  const target = (tree) => collectElements(tree, (node) => node.type === "li" && textContent(node).includes("主中转"))[0];
  elementProps(buttons(target(render(props)), "修改默认模型")[0]).onPress();
  const editing = render(props);
  const input = collectElements(editing, (node) => elementType(node) === combobox.ManualModelCombobox)[0];
  assert.equal(elementProps(input).value, "ma");
  assert.deepEqual(elementProps(input).options, ["ma"], "当前渠道复用既有模型选项");
  elementProps(input).onChange("ma-2");
  elementProps(buttons(render(props), "保存默认模型")[0]).onPress();
  assert.deepEqual(calls, [["setDefault", "provider:a", "ma-2"]]);
});

test("回退提示非空时显示，为空时隐藏", () => {
  const { render } = section();
  const notice = "所选渠道已不可用，已回退到用户配置的默认 provider。";
  const shown = render({ channelList: fullList, notice });
  assert.equal(collectElements(shown, (node) => node.props.role === "status").length, 1);
  assert.ok(textContent(shown).includes(notice));
  const hidden = render({ channelList: fullList, notice: null });
  assert.equal(collectElements(hidden, (node) => node.props.role === "status").length, 0);
});

test("失败显示后端消息；版本冲突时给出刷新入口", () => {
  const { render, buttons, calls } = section();
  const plain = render({ channelList: fullList, actionError: "请先为渠道设置默认模型" });
  assert.ok(textContent(plain).includes("请先为渠道设置默认模型"));
  assert.equal(buttons(plain, "刷新后重试").length, 0);

  const message = "Codey 设置已被其他操作更新，请刷新后重试";
  const conflict = render({ channelList: fullList, actionError: message, versionConflict: true });
  assert.ok(textContent(conflict).includes(message));
  elementProps(buttons(conflict, "刷新后重试")[0]).onPress();
  assert.deepEqual(calls, [["refresh"]]);
});

test("渠道列表读取失败时提示并可重新读取", () => {
  const { render, buttons } = section();
  const tree = render({ channelList: null, loadError: "bridge 未连接" });
  assert.ok(textContent(tree).includes("bridge 未连接"));
  assert.equal(buttons(tree, "重新读取").length, 1);
});

test("控制台接线：官方账号与渠道互相刷新，账号切换走渠道控制器与操作锁", async () => {
  const [app, modelSection] = await Promise.all([readSource("src/App.tsx"), readSource("src/ModelSection.tsx")]);
  const switchChannelBody = app.slice(app.indexOf("async function switchChannel("), app.indexOf("async function switchOfficialAccount("));
  assert.match(switchChannelBody, /if \(!reportChannelOutcome\(outcome\)\) return;\s*setOfficialAccountsRefreshKey\(\(key\) => key \+ 1\);/,
    "渠道切换成功后刷新账号列表");
  assert.match(app, /const handleOfficialAccountsChanged = useStableEvent\(\(\) => void refreshChannels\(\)\);/,
    "账号增删后刷新渠道列表");
  const switchAccountBody = app.slice(app.indexOf("async function switchOfficialAccount("), app.indexOf("async function saveChannelDefaultModel("));
  assert.match(switchAccountBody, /if \(dirty \|\| isBusy\) return null;/);
  assert.match(switchAccountBody, /runOperation\("switch-official-account"/);
  assert.match(switchAccountBody, /channelController\.switchOfficialAccount\(accountId\)/);
  assert.doesNotMatch(app, /"set_default_official_account"/, "切换只经由渠道控制器");
  assert.match(app, /models: \(active\) => \(\s*<ModelSection\s+active=\{active\}/);
  const panel = modelSection.match(/<OfficialAccountsPanel[\s\S]*?\/>/)?.[0];
  assert.ok(panel, "ModelSection 渲染官方账号面板");
  assert.match(panel, /active=\{active\}/);
  assert.match(panel, /disabled=\{dirty \|\| isBusy\}/);
  assert.ok(modelSection.indexOf("<ChannelSection") < modelSection.indexOf("<OfficialAccountsPanel"), "面板位于渠道之后");
});

test("控制台接线：重启走既有确认流程，渠道随页面加载读取且不轮询", async () => {
  const [app, modelSection, channelsSource, sectionSource] = await Promise.all([
    readSource("src/App.tsx"),
    readSource("src/ModelSection.tsx"),
    readSource("src/channels.ts"),
    readSource("src/ChannelSection.tsx"),
  ]);
  assert.equal(app.match(/"restart_codey"/g)?.length, 1, "只保留一条重启路径");
  assert.doesNotMatch(channelsSource + sectionSource, /restart_codey|invoke\(/);
  assert.match(app, /codexRunning,\s*confirmSwitch: \(target\) => confirmThroughDialog\(confirmationController, SWITCH_CONFIRMATIONS\[target\]\),\s*restart: \(\) => setRestartAfterSwitchPending\(true\),/);
  assert.match(app, /const codexRunning = useStableEvent\(\(\) => status\.running\);/, "运行状态随渲染更新");
  assert.match(app, /setRestartAfterSwitchPending\(false\);\s*void restartCodex\(\);/, "确认过的切换直接重启，不再二次询问");
  assert.doesNotMatch(app, /渠道已切换，重启 Codex 后/);
  assert.match(app, /outcome\.restart === "next-start"\s*\? "已切换渠道，下次启动 Codex 时生效"/, "未运行时提示下次启动生效");
  assert.match(app, /switched\.outcome\.restart === "next-start"\s*\? "已切换官方账号，下次启动 Codex 时生效"/);
  for (const target of ["channel", "\"official-account\""]) {
    const block = app.slice(app.indexOf(`  ${target}: {`), app.indexOf("},", app.indexOf(`  ${target}: {`)));
    assert.match(block, /\$\{RESTART_INTERRUPTS_TASKS\}/, `${target} 确认保留中断提示`);
  }
  assert.match(app, /const RESTART_INTERRUPTS_TASKS =\s*"[^"]*正在执行的本地任务会被中断/);
  assert.match(app, /refreshRouterSessionDiagnosis\(\),\s*refreshChannels\(\),/);
  assert.match(app, /onSelectChannel=\{handleSelectChannel\}/);
  assert.match(modelSection, /<ChannelSection\b/);
  assert.doesNotMatch(app + channelsSource + sectionSource, /list_channels[^\n]*setInterval|setInterval[^\n]*list_channels/);
  assert.doesNotMatch(channelsSource + sectionSource, /setInterval|setTimeout/);
  assert.doesNotMatch(channelsSource + sectionSource, /线路|本地路由|会话用量|推理强度/);
  assert.match(app, /channelNotice=\{channelNotice\}/);
  assert.doesNotMatch(app, /channelList\?\.notice \?\? status\.channelNotice/);
  assert.match(app, /channelController\.noteStatusNotice\(next\.channelNotice \?\? null\)/);
  assert.match(app, /noticeAfterChannelChange\(refreshProviderAfterChannelChange,/);
});
