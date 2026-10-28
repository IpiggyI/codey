import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const requests = await loadTypeScriptModule(new URL("../src/officialAccountsRequests.ts", import.meta.url));

const account = (id, overrides = {}) => ({
  id,
  accountId: `acct-${id}`,
  addedAt: 1,
  invalid: false,
  isDefault: false,
  email: `${id}@example.invalid`,
  ...overrides,
});
const payload = (accounts, overrides = {}) => ({
  status: "ok",
  accounts,
  defaultAccountId: null,
  officialAccountAvailable: true,
  officialAccountStatus: "authenticated",
  switchDisabledReason: null,
  ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("账号列表：较新的列表请求发出后，更早的响应被忽略", async () => {
  const pending = [];
  const views = [];
  const list = requests.createAccountListState({
    call: () => { const next = deferred(); pending.push(next); return next.promise; },
    onView: (view) => views.push(view),
    onError: (message) => views.push({ error: message }),
  });
  const first = list.refresh();
  const second = list.refresh();
  pending[1].resolve(payload([account("b")]));
  await second;
  pending[0].resolve(payload([account("a")]));
  await first;
  assert.deepEqual(views.map((view) => view.accounts.map((item) => item.id)), [["b"]]);
});

test("账号列表：账号变更结果使在途的列表请求作废", async () => {
  const pending = deferred();
  const views = [];
  const list = requests.createAccountListState({
    call: () => pending.promise,
    onView: (view) => views.push(view),
    onError: () => assert.fail("不应报告错误"),
  });
  const inFlight = list.refresh();
  list.apply(payload([account("added")]));
  pending.resolve(payload([]));
  await inFlight;
  assert.deepEqual(views.map((view) => view.accounts.map((item) => item.id)), [["added"]]);
});

test("账号列表：当前账号换成另一个库内账号时报告切换，首次读取、不变或清空时不报告", async () => {
  let reply = payload([account("a"), account("b")], { defaultAccountId: "a" });
  const seen = [];
  const list = requests.createAccountListState({
    call: async () => reply,
    onView: (view, switched) => seen.push([view.defaultAccountId, switched]),
    onError: () => assert.fail("不应报告错误"),
  });
  await list.refresh();
  await list.refresh();
  list.apply(payload([account("a"), account("b")], { defaultAccountId: "b" }));
  reply = payload([account("a"), account("b")], { defaultAccountId: "a" });
  await list.refresh();
  list.apply(payload([account("b")], { defaultAccountId: null }));
  assert.deepEqual(seen, [["a", false], ["a", false], ["b", true], ["a", true], [null, false]]);
});

test("账号列表：卸载后到达的响应和错误都被忽略", async () => {
  const pending = deferred();
  let called = 0;
  const list = requests.createAccountListState({
    call: () => pending.promise,
    onView: () => { called += 1; },
    onError: () => { called += 1; },
  });
  const inFlight = list.refresh();
  list.dispose();
  pending.reject(new Error("bridge 已断开"));
  await inFlight;
  assert.equal(called, 0);
});

test("账号摘要只保留声明的字段，误带的凭据字段不进入界面状态", () => {
  const view = requests.accountsView(payload([
    account("a", { tokens: { access_token: "secret-access" }, refresh_token: "secret-refresh", planType: "plus" }),
  ], { switchDisabledReason: "原因", auth: { tokens: {} } }));
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /secret-|tokens|refresh_token|access_token/);
  assert.equal(view.accounts[0].planType, "plus");
  assert.equal(view.switchDisabledReason, "原因");
  assert.throws(() => requests.accountsView({ status: "ok" }), /官方账号列表格式无效/);
  const errors = [];
  const list = requests.createAccountListState({ call: async () => ({}), onView: () => assert.fail("格式无效时不接纳"), onError: (message) => errors.push(message) });
  list.apply({ status: "ok" });
  assert.deepEqual(errors, ["官方账号列表格式无效，请重新读取"]);
});

function usageHarness(handler) {
  const calls = [];
  const usages = [];
  const loading = [];
  const tracker = requests.createUsageTracker({
    call: async (command, args) => {
      calls.push({ command, args });
      return handler(command, args, calls);
    },
    onUsage: (accountId, view) => usages.push([accountId, view]),
    onLoading: (accountId, value) => loading.push([accountId, value]),
  });
  return { tracker, calls, usages, loading };
}
const usageResult = (fetchedAt, authGeneration, extra = {}) => ({
  status: "ok",
  authGeneration,
  fetchedAt,
  planType: "plus",
  primary: { usedPercent: 10, windowMinutes: 300 },
  ...extra,
});

test("账号额度：用自己的账号查询，并以返回的凭据代次回写，回写的快照不含状态字段", async () => {
  const { tracker, calls, usages, loading } = usageHarness((command) =>
    command === "query_official_account_usage" ? usageResult(10, 7) : { status: "ok" });
  await tracker.refresh("a", true);
  assert.deepEqual(calls, [
    { command: "query_official_account_usage", args: { accountId: "a", forceRefresh: true } },
    {
      command: "store_official_account_usage",
      args: { accountId: "a", authGeneration: 7, snapshot: { fetchedAt: 10, planType: "plus", primary: { usedPercent: 10, windowMinutes: 300 } } },
    },
  ]);
  assert.deepEqual(usages, [["a", { status: "ok", snapshot: { fetchedAt: 10, planType: "plus", primary: { usedPercent: 10, windowMinutes: 300 } } }]]);
  assert.deepEqual(loading, [["a", true], ["a", false]]);
});

test("账号额度：较早发出的请求晚到时不覆盖较新的结果", async () => {
  const queries = [];
  const { tracker, usages } = usageHarness((command) => {
    if (command !== "query_official_account_usage") return { status: "ok" };
    const next = deferred();
    queries.push(next);
    return next.promise;
  });
  const older = tracker.refresh("a", false);
  const newer = tracker.refresh("a", true);
  await flush();
  queries[1].resolve(usageResult(20, 2));
  await newer;
  queries[0].resolve(usageResult(10, 1));
  await older;
  assert.deepEqual(usages.map(([, view]) => view.snapshot.fetchedAt), [20]);
});

test("账号额度：较早发出的请求晚到时，即使凭据代次不低或返回错误，也不覆盖较新的结果", async () => {
  const queries = [];
  const { tracker, usages, loading } = usageHarness((command) => {
    if (command !== "query_official_account_usage") return { status: "ok" };
    const next = deferred();
    queries.push(next);
    return next.promise;
  });
  const older = tracker.refresh("a", false);
  const middle = tracker.refresh("a", false);
  const newer = tracker.refresh("a", true);
  await flush();
  queries[2].resolve(usageResult(30, 4));
  await newer;
  queries[0].resolve({ status: "error", message: "账号额度查询超时" });
  queries[1].resolve(usageResult(25, 4));
  await Promise.all([older, middle]);
  assert.deepEqual(usages, [["a", { status: "ok", snapshot: { fetchedAt: 30, planType: "plus", primary: { usedPercent: 10, windowMinutes: 300 } } }]]);
  assert.deepEqual(loading.at(-1), ["a", false]);
});

test("账号额度：凭据代次低于已显示结果的响应被忽略，且不回写", async () => {
  let generation = 5;
  const { tracker, usages, calls } = usageHarness((command) =>
    command === "query_official_account_usage" ? usageResult(generation, generation) : { status: "ok" });
  await tracker.refresh("a", false);
  generation = 3;
  await tracker.refresh("a", false);
  assert.deepEqual(usages.map(([, view]) => view.snapshot.fetchedAt), [5]);
  assert.equal(calls.filter((call) => call.command === "store_official_account_usage").length, 1);
});

test("账号额度：不同账号互不作废", async () => {
  const queries = new Map();
  const { tracker, usages } = usageHarness((command, args) => {
    if (command !== "query_official_account_usage") return { status: "ok" };
    const next = deferred();
    queries.set(args.accountId, next);
    return next.promise;
  });
  const a = tracker.refresh("a", false);
  const b = tracker.refresh("b", false);
  await flush();
  queries.get("b").resolve(usageResult(2, 2));
  queries.get("a").resolve(usageResult(1, 1));
  await Promise.all([a, b]);
  assert.deepEqual(usages.map(([id]) => id).sort(), ["a", "b"]);
});

test("账号额度：查询返回 error 形状或回写被拒绝时显示后端消息", async () => {
  const failing = usageHarness(() => ({ status: "error", message: "找不到官方账号" }));
  await failing.tracker.refresh("gone", false);
  assert.deepEqual(failing.usages, [["gone", { status: "error", message: "找不到官方账号" }]]);
  assert.equal(failing.calls.length, 1, "失败的查询不回写");

  const rejected = usageHarness((command) => {
    if (command === "query_official_account_usage") return usageResult(1, 1);
    throw new Error("官方账号状态已变化，忽略旧的额度结果");
  });
  await rejected.tracker.refresh("a", false);
  assert.deepEqual(rejected.usages, [["a", { status: "error", message: "官方账号状态已变化，忽略旧的额度结果" }]]);
});

function pollHarness(responses) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const outcomes = [];
  const poll = requests.createLoginPoll({
    call: async (command, args) => {
      calls.push({ command, args });
      const next = responses(args.loginId, calls.length);
      if (next instanceof Error) throw next;
      return next;
    },
    onSuccess: (result) => outcomes.push(["success", result]),
    onFailure: (message) => outcomes.push(["failure", message]),
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimer: (id) => timers.delete(id),
  });
  const tick = async () => {
    const [id, callback] = [...timers][0] ?? [];
    if (!callback) return false;
    timers.delete(id);
    callback();
    await flush();
    return true;
  };
  return { poll, calls, timers, outcomes, tick };
}

test("登录会话：同一次登录只收尾一次，旧登录和关闭之后的结果被拒绝", () => {
  const session = requests.createLoginSession();
  assert.equal(session.active(), null);
  assert.equal(session.finish("login-1"), false, "没有进行中的登录");
  session.begin("login-1");
  assert.equal(session.active(), "login-1");
  assert.equal(session.finish("login-1"), true, "第一个到达的结果收尾");
  assert.equal(session.finish("login-1"), false, "之后到达的结果被拒绝");
  assert.equal(session.active(), null);

  session.begin("login-1");
  session.begin("login-2");
  assert.equal(session.finish("login-1"), false, "被新登录替换的旧登录");
  session.clear();
  assert.equal(session.finish("login-2"), false, "关闭对话框之后");
});

test("登录轮询：等待时继续轮询，成功后停止", async () => {
  const { poll, calls, timers, outcomes, tick } = pollHarness((_id, count) =>
    count < 3 ? { status: "wait" } : payload([account("new")], { accountId: "new" }));
  poll.start("login-1");
  await flush();
  assert.equal(await tick(), true);
  assert.equal(await tick(), true);
  assert.equal(calls.length, 3);
  assert.equal(outcomes[0][0], "success");
  assert.equal(timers.size, 0, "终态后不再排队");
  assert.equal(await tick(), false);
});

test("登录轮询：取消后不再轮询，在途响应被忽略", async () => {
  const pending = deferred();
  const { poll, calls, timers, outcomes } = pollHarness(() => pending.promise);
  poll.start("login-1");
  poll.stop();
  pending.resolve({ status: "wait" });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(outcomes, []);
});

test("登录轮询：已排队的下一次轮询在取消时被清除", async () => {
  const { poll, calls, timers, tick } = pollHarness(() => ({ status: "wait" }));
  poll.start("login-1");
  await flush();
  assert.equal(timers.size, 1);
  poll.stop();
  assert.equal(timers.size, 0);
  assert.equal(await tick(), false);
  assert.equal(calls.length, 1);
});

test("登录轮询：被新登录替换的 loginId 的结果被忽略", async () => {
  const pending = new Map();
  const { poll, outcomes } = pollHarness((loginId) => {
    const next = deferred();
    pending.set(loginId, next);
    return next.promise;
  });
  poll.start("old");
  poll.start("new");
  pending.get("old").resolve(payload([account("old")]));
  await flush();
  assert.deepEqual(outcomes, []);
  pending.get("new").resolve({ status: "expired", message: "登录已过期或已取消，请重新添加账号" });
  await flush();
  assert.deepEqual(outcomes, [["failure", "登录已过期或已取消，请重新添加账号"]]);
});

test("登录轮询：失败形状（抛出）显示后端原因并停止", async () => {
  const { poll, timers, outcomes } = pollHarness(() => new Error("登录回调端口 127.0.0.1:1455 已被占用"));
  poll.start("login-1");
  await flush();
  assert.deepEqual(outcomes, [["failure", "登录回调端口 127.0.0.1:1455 已被占用"]]);
  assert.equal(timers.size, 0);
});

// 用可执行副作用的极简 React 驱动 hook，确认刷新信号、页面激活状态和卸载清理的接线。
function hookHarness(context, { entry = "../src/useOfficialAccounts.ts", exportName = "useOfficialAccounts", invoke, window: fakeWindow } = {}) {
  let cursor = 0;
  const hooks = [], effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      const cell = hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      cell.set ??= (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; };
      return [cell.value, cell.set];
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useCallback(callback, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || !same(previous.deps, deps)) hooks[index] = { deps, value: callback };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (previous && same(previous.deps, deps)) return;
      hooks[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = effect(); });
    },
  };
  const calls = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (fakeWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  const graph = createModuleGraph(new URL(entry, import.meta.url), { stubs: {
    react,
    "./api": { invoke: async (command, args) => {
      calls.push({ command, args });
      return invoke(command, args, calls);
    } },
  } });
  const unmount = () => hooks.forEach((hook) => { hook?.cleanup?.(); if (hook) hook.cleanup = undefined; });
  context.after(() => {
    unmount();
    if (fakeWindow) {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete globalThis.window;
    }
  });
  const render = async (options) => {
    cursor = 0;
    const result = graph.exports[exportName](options);
    effects.splice(0).forEach((effect) => effect());
    await flush();
    return result;
  };
  return { render, calls, unmount };
}

test("账号列表 hook：刷新信号变化时重新读取，页面未打开时不查询账号额度", async (context) => {
  let current = "a";
  const { render, calls } = hookHarness(context, { invoke: (command) => {
    if (command === "list_official_accounts") {
      return payload([account("a"), account("b"), account("x", { invalid: true })], { defaultAccountId: current });
    }
    if (command === "query_official_account_usage") return usageResult(1, 1);
    return { status: "ok" };
  } });
  await render({ active: false, refreshKey: 0 });
  assert.equal((await render({ active: false, refreshKey: 0 })).accountSwitched, false);
  assert.deepEqual(calls.map((call) => call.command), ["list_official_accounts"]);
  // 渠道列表切到另一个官方账号后，App 递增刷新信号。
  current = "b";
  await render({ active: false, refreshKey: 1 });
  assert.deepEqual(calls.map((call) => call.command), ["list_official_accounts", "list_official_accounts"]);
  assert.equal((await render({ active: false, refreshKey: 1 })).accountSwitched, true, "从渠道列表切换账号也显示新开对话的提示");
  await render({ active: true, refreshKey: 1 });
  // 账号之间间隔 200 毫秒查询。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const queried = calls.filter((call) => call.command === "query_official_account_usage");
  assert.deepEqual(queried.map((call) => call.args.accountId), ["a", "b"], "失效账号不查询账号额度");
});

test("登录轮询 hook：卸载时清除已排队的轮询，之后不再请求", async (context) => {
  const timers = new Map();
  let timerId = 0;
  const { render, calls, unmount } = hookHarness(context, {
    entry: "../src/useOfficialAccountLoginPoll.ts",
    exportName: "useOfficialAccountLoginPoll",
    invoke: () => ({ status: "wait" }),
    window: {
      setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  const options = { loginId: "login-1", onSuccess: () => assert.fail("不应成功"), onFailure: () => assert.fail("不应失败") };
  await render(options);
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 1, "等待中排队下一次轮询");
  unmount();
  assert.equal(timers.size, 0, "卸载时清除排队的轮询");
  await flush();
  assert.equal(calls.length, 1);
});

test("登录轮询 hook：loginId 清空时停止轮询", async (context) => {
  const timers = new Map();
  let timerId = 0;
  const { render, calls } = hookHarness(context, {
    entry: "../src/useOfficialAccountLoginPoll.ts",
    exportName: "useOfficialAccountLoginPoll",
    invoke: () => ({ status: "wait" }),
    window: {
      setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  const options = { onSuccess: () => {}, onFailure: () => {} };
  await render({ ...options, loginId: "login-1" });
  await render({ ...options, loginId: undefined });
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 1);
});
