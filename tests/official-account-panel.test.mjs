import assert from "node:assert/strict";
import test from "node:test";

import { readSource } from "./helpers/read-source.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const account = (id, overrides = {}) => ({
  id,
  accountId: `acct-${id}`,
  addedAt: 1,
  invalid: false,
  isDefault: false,
  email: `${id}@example.invalid`,
  ...overrides,
});
const viewOf = (accounts, overrides = {}) => ({
  accounts,
  defaultAccountId: accounts.find((item) => item.isDefault)?.id ?? null,
  officialAccountAvailable: true,
  officialAccountStatus: "authenticated",
  switchDisabledReason: null,
  ...overrides,
});
const listResult = (accounts) => ({ status: "ok", ...viewOf(accounts) });
const started = (loginId, authUrl = "https://auth.example.invalid/authorize", overrides = {}) => ({
  status: "wait", loginId, authUrl, browserOpened: true, callbackListening: true, callbackError: null, ...overrides,
});

function panel({ view = viewOf([account("cur", { isDefault: true, planType: "plus" }), account("other", { planType: "prolite" })]), invoke } = {}) {
  const ui = autoStubModule("ui");
  const calls = { invoke: [], apply: [], refresh: 0, changed: 0, switch: [], confirmations: [], notices: [], usage: [] };
  const hook = {
    view,
    loadError: "",
    accountSwitched: false,
    usages: {},
    usageLoading: {},
    apply: (result) => calls.apply.push(result),
    refresh: async () => { calls.refresh += 1; },
    refreshUsage: async (id) => { calls.usage.push(id); },
  };
  let pollOptions;
  const graph = createModuleGraph(new URL("../src/OfficialAccountsPanel.tsx", import.meta.url), {
    stubs: {
      "./components/ui": ui,
      "./api": { invoke: async (command, args = {}) => {
        calls.invoke.push({ command, args });
        if (invoke) return invoke(command, args);
        return listResult([]);
      } },
      "./useOfficialAccounts": { useOfficialAccounts: () => hook },
      "./useOfficialAccountLoginPoll": { useOfficialAccountLoginPoll: (options) => { pollOptions = options; } },
    },
  });
  let switchResult = listResult([]);
  const props = {
    active: true,
    disabled: false,
    refreshKey: 0,
    popupContainer: null,
    onSwitch: async (id) => { calls.switch.push(id); return switchResult; },
    onAccountsChanged: () => { calls.changed += 1; },
    onNotice: (notice) => calls.notices.push(notice),
    onRequestConfirmation: (confirmation) => calls.confirmations.push(confirmation),
  };
  const render = (overrides = {}) => {
    graph.restart();
    return graph.exports.OfficialAccountsPanel({ ...props, ...overrides });
  };
  const buttons = (tree, label) => collectElements(tree, (node) =>
    elementType(node) === ui.Button && textContent(node).includes(label));
  const exactButton = (tree, label) => collectElements(tree, (node) =>
    elementType(node) === ui.Button && textContent(node) === label)[0];
  const card = (tree, text) => collectElements(tree, (node) => node.type === "li" && textContent(node).includes(text))[0];
  return {
    ui, graph, hook, calls, render, buttons, exactButton, card,
    poll: () => pollOptions,
    setSwitchResult: (value) => { switchResult = value; },
    exports: graph.exports,
  };
}

test("账号列表显示邮箱、套餐标签、当前账号、失效状态和上次刷新", () => {
  const { render } = panel({ view: viewOf([
    account("cur", { isDefault: true, planType: "plus", lastRefresh: "2026-10-27T08:00:00Z" }),
    account("pro", { planType: "pro" }),
    account("bad", { invalid: true }),
  ]) });
  const text = textContent(render());
  for (const expected of [
    "cur@example.invalid", "pro@example.invalid", "bad@example.invalid", "Plus", "Pro 200",
    "当前账号", "已失效", "上次刷新：", "账号凭据已失效",
  ]) assert.ok(text.includes(expected), `缺少：${expected}`);
});

test("账号卡片优先显示账号额度返回的当前套餐", () => {
  const { render, card, hook } = panel();
  hook.usages = { other: { status: "ok", snapshot: { fetchedAt: 1, planType: "pro" } } };
  const tree = render();
  assert.ok(textContent(card(tree, "other@")).includes("Pro 200"));
  assert.doesNotMatch(textContent(card(tree, "other@")), /Pro 100/);
  hook.usages = { other: { status: "error", message: "找不到官方账号" } };
  assert.ok(textContent(card(render(), "other@")).includes("Pro 100"), "查询失败时沿用账号记录的套餐");
});

test("只有有效的非当前账号可以切换，切换按钮带说明重启的悬浮提示", () => {
  const { render, buttons, card, exports } = panel({ view: viewOf([
    account("cur", { isDefault: true }), account("other"), account("bad", { invalid: true }),
  ]) });
  const tree = render();
  const state = (name) => elementProps(buttons(card(tree, name), "切换到此账号")[0]);
  assert.equal(state("cur@").disabled, true);
  assert.equal(state("other@").disabled, false);
  assert.equal(state("bad@").disabled, true);
  assert.equal(state("other@").title, exports.SWITCH_TIP);
  assert.match(exports.SWITCH_TIP, /改写为该账号/);
  assert.match(exports.SWITCH_TIP, /重启 Codex/);
});

test("切换交给 App：面板不自带确认，只有 App 的重启确认一处询问；接纳返回的账号列表", async () => {
  const { render, buttons, card, calls } = panel();
  elementProps(buttons(card(render(), "other@"), "切换到此账号")[0]).onPress();
  assert.deepEqual(calls.confirmations, [], "面板不再弹出第二个确认");
  assert.deepEqual(calls.switch, ["other"]);
  await flush();
  assert.equal(calls.apply.length, 1, "切换返回的账号列表被接纳");
});

test("当前账号换成另一个账号后显示新开对话的提示", () => {
  const { render, hook, exports } = panel();
  assert.equal(collectElements(render(), (node) => node.props.role === "status").length, 0);
  hook.accountSwitched = true;
  const after = render();
  assert.ok(textContent(after).includes(exports.SESSION_NOTICE));
  assert.equal(collectElements(after, (node) => node.props.role === "status").length, 1);
});

test("切换取消或没有成功时重新读取账号列表，不显示新开对话的提示", async () => {
  const { render, buttons, card, calls, setSwitchResult } = panel();
  setSwitchResult(null);
  elementProps(buttons(card(render(), "other@"), "切换到此账号")[0]).onPress();
  await flush();
  assert.equal(calls.refresh, 1);
  assert.equal(calls.apply.length, 0);
  assert.doesNotMatch(textContent(render()), /新开对话/);
});

test("凭据存储不是 file 模式时，切换和导入当前登录被禁用并显示原因", () => {
  const reason = "Codex 凭据存储不是 file 模式，不能导入当前登录或切换官方账号";
  const { render, buttons } = panel({ view: viewOf([account("cur", { isDefault: true }), account("other")], { switchDisabledReason: reason }) });
  const tree = render();
  assert.deepEqual(buttons(tree, "切换到此账号").map((button) => elementProps(button).disabled), [true, true]);
  assert.equal(elementProps(buttons(tree, "导入当前登录")[0]).disabled, true);
  assert.equal(elementProps(buttons(tree, "浏览器登录添加")[0]).disabled, false, "其他添加方式不受影响");
  const alerts = collectElements(tree, (node) => node.props.role === "alert");
  assert.ok(alerts.some((node) => textContent(node) === reason), "原因作为可见文本显示");
});

test("移除账号只在确认后执行，并刷新渠道列表", async () => {
  const { render, buttons, card, calls } = panel({ invoke: () => listResult([account("cur", { isDefault: true })]) });
  elementProps(buttons(card(render(), "other@"), "移除")[0]).onPress();
  assert.deepEqual(calls.invoke, [], "确认前不调用后端");
  const [confirmation] = calls.confirmations;
  assert.equal(confirmation.action, "delete-official-account");
  confirmation.run();
  await flush();
  assert.deepEqual(calls.invoke, [{ command: "remove_official_account", args: { accountId: "other" } }]);
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.changed, 1, "移除后刷新渠道列表");
});

test("移除当前账号的确认说明不会退出 Codex 登录", () => {
  const { render, buttons, card, calls } = panel();
  elementProps(buttons(card(render(), "cur@"), "移除")[0]).onPress();
  assert.match(calls.confirmations[0].description, /不会退出 Codex 登录/);
});

test("导入当前登录后接纳账号列表并刷新渠道列表；失败显示后端消息且不刷新", async () => {
  const ok = panel({ invoke: () => listResult([account("cur", { isDefault: true })]) });
  elementProps(ok.buttons(ok.render(), "导入当前登录")[0]).onPress();
  await flush();
  assert.deepEqual(ok.calls.invoke, [{ command: "import_current_codex_login", args: {} }]);
  assert.equal(ok.calls.apply.length, 1);
  assert.equal(ok.calls.changed, 1);

  const failed = panel({ invoke: () => { throw new Error("当前 Codex 没有官方登录"); } });
  elementProps(failed.buttons(failed.render(), "导入当前登录")[0]).onPress();
  await flush();
  assert.equal(failed.calls.changed, 0);
  assert.deepEqual(failed.calls.notices, [{ tone: "error", text: "当前 Codex 没有官方登录" }]);
});

test("粘贴凭据：提交去除首尾空白的输入，格式错误时在对话框内显示后端消息", async () => {
  let reply = () => { throw new Error("刷新令牌格式无效"); };
  const manualDialog = (tree) => collectElements(tree, (node) =>
    elementType(node) === ui.Dialog && collectElements(node, (child) => child.type === "textarea").length > 0)[0];
  const { ui, render, buttons, exactButton, calls } = panel({ invoke: (...args) => reply(...args) });
  elementProps(buttons(render(), "粘贴凭据")[0]).onPress();
  const textarea = collectElements(render(), (node) => node.type === "textarea")[0];
  elementProps(textarea).onChange({ target: { value: "  bad-token  " } });
  elementProps(exactButton(render(), "添加")).onPress();
  await flush();
  assert.deepEqual(calls.invoke, [{ command: "import_official_account_credential", args: { credential: "bad-token" } }]);
  const failedTree = render();
  assert.equal(elementProps(manualDialog(failedTree)).open, true, "失败时对话框保持打开");
  assert.ok(collectElements(failedTree, (node) => node.props.role === "alert").some((node) => textContent(node) === "刷新令牌格式无效"));
  assert.equal(calls.changed, 0);

  reply = () => listResult([account("new")]);
  elementProps(exactButton(render(), "添加")).onPress();
  await flush();
  assert.equal(calls.changed, 1);
  assert.equal(elementProps(manualDialog(render())).open, false, "成功后关闭对话框");
});

test("浏览器登录：未打开浏览器时显示授权地址与有效期，成功后关闭并刷新渠道列表", async () => {
  const { render, buttons, calls, poll } = panel({ invoke: (command) => command === "start_official_account_login"
    ? { ...started("login-1", "https://auth.example.invalid/authorize"), browserOpened: false }
    : { status: "ok" } });
  elementProps(buttons(render(), "浏览器登录添加")[0]).onPress();
  await flush();
  const tree = render();
  const text = textContent(tree);
  assert.ok(text.includes("https://auth.example.invalid/authorize"));
  assert.ok(text.includes("未能自动打开浏览器"));
  assert.match(text, /登录链接在 .+ 前有效/);
  assert.equal(poll().loginId, "login-1");

  poll().onFailure("登录回调端口 127.0.0.1:1455 已被占用");
  assert.ok(textContent(render()).includes("已被占用"));

  poll().onSuccess(listResult([account("new")]));
  render();
  assert.equal(poll().loginId, undefined, "成功后停止轮询");
  assert.equal(calls.changed, 1);
});

test("浏览器登录：重新开始的请求返回前关闭对话框，晚到的响应不再打开对话框，并释放其登录会话", async () => {
  const starts = [];
  const { ui, render, buttons, calls, poll } = panel({ invoke: (command) => {
    if (command !== "start_official_account_login") return { status: "ok" };
    let resolve;
    const promise = new Promise((ok) => { resolve = ok; });
    starts.push(resolve);
    return promise;
  } });
  const loginDialog = (tree) => collectElements(tree, (node) =>
    elementType(node) === ui.Dialog && textContent(node).includes("添加官方账号"))[0];
  elementProps(buttons(render(), "浏览器登录添加")[0]).onPress();
  starts[0](started("login-1", "https://auth.example.invalid/1"));
  await flush();
  render();
  poll().onFailure("登录等待超时，请重新开始添加账号");
  elementProps(buttons(render(), "重新开始")[0]).onPress();
  elementProps(loginDialog(render())).onOpenChange(false);
  await flush();
  starts[1](started("login-2", "https://auth.example.invalid/2"));
  await flush();
  const tree = render();
  assert.equal(elementProps(loginDialog(tree)).open, false, "晚到的响应不打开对话框");
  assert.equal(poll().loginId, undefined, "晚到的响应不开始轮询");
  const cancelled = calls.invoke.filter((call) => call.command === "cancel_official_account_login").map((call) => call.args.loginId);
  assert.deepEqual(cancelled, ["login-1", "login-2"]);
});

// 开始登录并返回对话框相关的查找函数；submit 决定回调地址提交的结果。
async function loginDialog({ start = {}, submit } = {}) {
  const harness = panel({ invoke: (command, args) => {
    if (command === "start_official_account_login") return started("login-1", "https://auth.example.invalid/authorize", start);
    if (command === "submit_official_account_login_callback") return submit(args);
    return { status: "ok" };
  } });
  elementProps(harness.buttons(harness.render(), "浏览器登录添加")[0]).onPress();
  await flush();
  const dialog = (tree) => collectElements(tree, (node) =>
    elementType(node) === harness.ui.Dialog && textContent(node).includes("添加官方账号"))[0];
  const field = (tree) => collectElements(tree, (node) => node.type === "textarea" && node.props["aria-label"] === "回调地址")[0];
  const type = (value) => elementProps(field(harness.render())).onChange({ target: { value } });
  const alerts = (tree) => collectElements(dialog(tree), (node) => node.props.role === "alert").map(textContent);
  const submitButton = (tree) => harness.exactButton(tree, "提交回调地址");
  return { ...harness, dialog, field, type, alerts, submitButton };
}
const CALLBACK = "http://localhost:1455/auth/callback?code=one-time-code-value&state=abc";

test("浏览器登录：浏览器已打开时也显示可复制的授权链接和复制按钮", async () => {
  const { render, exactButton } = await loginDialog();
  const tree = render();
  const text = textContent(tree);
  assert.ok(text.includes("https://auth.example.invalid/authorize"));
  assert.ok(text.includes("已在浏览器打开 ChatGPT 登录页"));
  assert.ok(text.includes("账号会自动加入列表"));
  assert.ok(exactButton(tree, "复制登录链接"));
});

test("浏览器登录：始终提供回调地址输入框和说明，空输入或提交中时提交按钮禁用", async () => {
  let release;
  const { render, field, type, submitButton } = await loginDialog({
    submit: () => new Promise((resolve) => { release = resolve; }),
  });
  const text = textContent(render());
  assert.ok(text.includes("http://localhost:1455/auth/callback"));
  assert.ok(text.includes("地址栏"));
  assert.ok(field(render()), "有回调地址输入框");
  assert.equal(elementProps(submitButton(render())).disabled, true, "空输入时禁用");
  type("   ");
  assert.equal(elementProps(submitButton(render())).disabled, true, "只有空白时禁用");
  type(CALLBACK);
  assert.equal(elementProps(submitButton(render())).disabled, false);
  elementProps(submitButton(render())).onPress();
  await flush();
  assert.equal(elementProps(submitButton(render())).disabled, true, "提交中禁用");
  assert.equal(elementProps(field(render())).disabled, true, "提交中输入框禁用");
  release(listResult([account("new")]));
  await flush();
});

test("浏览器登录：回调端口无法监听时说明无法自动完成、显示后端原因，粘贴提交成为主要操作", async () => {
  const reason = "登录回调端口已被其他程序占用";
  const { render, type, submitButton } = await loginDialog({ start: { callbackListening: false, callbackError: reason } });
  const tree = render();
  const text = textContent(tree);
  assert.ok(text.includes("无法自动完成登录"));
  assert.ok(text.includes(reason));
  assert.doesNotMatch(text, /自动加入列表/, "不再承诺自动加入账号");
  type(CALLBACK);
  assert.notEqual(elementProps(submitButton(render())).variant, "outline", "提交按钮是主要按钮");
  const listening = await loginDialog();
  assert.equal(elementProps(listening.submitButton(listening.render())).variant, "outline");
  assert.doesNotMatch(textContent(listening.render()), /无法自动完成登录/);
});

test("浏览器登录：提交回调地址成功后与轮询成功一样收尾，晚到的轮询结果被忽略", async () => {
  const { render, calls, poll, dialog, type, submitButton } = await loginDialog({
    submit: () => listResult([account("new")]),
  });
  render();
  const stale = poll();
  assert.equal(stale.loginId, "login-1");
  type(`  ${CALLBACK}  `);
  elementProps(submitButton(render())).onPress();
  await flush();
  const submits = calls.invoke.filter((call) => call.command === "submit_official_account_login_callback");
  assert.deepEqual(submits, [{ command: "submit_official_account_login_callback", args: { loginId: "login-1", callbackUrl: CALLBACK } }]);
  const tree = render();
  assert.equal(elementProps(dialog(tree)).open, false, "成功后关闭对话框");
  assert.equal(poll().loginId, undefined, "成功后停止轮询");
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.changed, 1);
  assert.deepEqual(calls.notices, [{ tone: "success", text: "官方账号已添加" }]);
  assert.equal(calls.invoke.some((call) => call.command === "cancel_official_account_login"), false);

  stale.onSuccess(listResult([account("late")]));
  stale.onFailure("登录已过期，请重新开始");
  render();
  assert.equal(calls.apply.length, 1, "晚到的轮询成功不再接纳账号");
  assert.equal(calls.changed, 1);
  assert.equal(calls.notices.length, 1, "不重复提示");
  assert.deepEqual(collectElements(render(), (node) => node.props.role === "alert"), [], "晚到的轮询失败不显示");
  assert.doesNotMatch(JSON.stringify(calls.notices), /one-time-code-value/, "提示不回显回调地址");
});

test("浏览器登录：提交回调地址失败时显示后端消息并保持登录打开，可以重新粘贴", async () => {
  let reply = () => { throw new Error("回调地址与本次登录不匹配"); };
  const { render, calls, poll, dialog, alerts, type, submitButton } = await loginDialog({ submit: () => reply() });
  type(CALLBACK);
  elementProps(submitButton(render())).onPress();
  await flush();
  const tree = render();
  assert.equal(elementProps(dialog(tree)).open, true, "失败时对话框保持打开");
  assert.ok(alerts(tree).includes("回调地址与本次登录不匹配"));
  assert.equal(poll().loginId, "login-1", "登录和轮询继续");
  assert.equal(calls.invoke.some((call) => call.command === "cancel_official_account_login"), false, "失败不取消登录");
  assert.equal(calls.changed, 0);
  assert.equal(calls.notices.length, 0);
  assert.equal(elementProps(submitButton(tree)).disabled, false, "输入保留，可再次提交");

  reply = () => listResult([account("new")]);
  elementProps(submitButton(render())).onPress();
  await flush();
  assert.equal(elementProps(dialog(render())).open, false);
  assert.equal(calls.changed, 1);
  assert.deepEqual(alerts(render()), []);
});

test("浏览器登录：重新开始后输入框和上一次的提交错误被清空", async () => {
  const { render, buttons, poll, alerts, field, type, submitButton } = await loginDialog({
    submit: () => { throw new Error("回调地址缺少授权码"); },
  });
  type(CALLBACK);
  elementProps(submitButton(render())).onPress();
  await flush();
  poll().onFailure("登录等待超时，请重新开始添加账号");
  assert.equal(field(render()), undefined, "登录失败后不再提供输入框");
  elementProps(buttons(render(), "重新开始")[0]).onPress();
  await flush();
  const tree = render();
  assert.equal(elementProps(field(tree)).value, "");
  assert.deepEqual(alerts(tree), []);
});

test("浏览器登录：取消时调用后端取消并停止轮询", async () => {
  const { render, buttons, calls, poll } = panel({ invoke: (command) => command === "start_official_account_login"
    ? started("login-2", "https://auth.example.invalid/a")
    : { status: "ok" } });
  elementProps(buttons(render(), "浏览器登录添加")[0]).onPress();
  await flush();
  assert.match(textContent(render()), /auth\.example\.invalid\/a/, "已打开浏览器时也显示授权地址");
  elementProps(buttons(render(), "取消")[0]).onPress();
  await flush();
  render();
  assert.equal(poll().loginId, undefined);
  assert.deepEqual(calls.invoke.at(-1), { command: "cancel_official_account_login", args: { loginId: "login-2" } });
});

test("外部忙碌或有未保存修改时，账号操作全部禁用", () => {
  const { render, buttons } = panel();
  const tree = render({ disabled: true });
  for (const label of ["导入当前登录", "粘贴凭据", "浏览器登录添加", "切换到此账号", "刷新账号额度", "移除"]) {
    assert.ok(buttons(tree, label).every((button) => elementProps(button).disabled), label);
  }
});

test("刷新账号额度按钮强制查询该账号", () => {
  const { render, buttons, card, calls } = panel();
  elementProps(buttons(card(render(), "other@"), "刷新账号额度")[0]).onPress();
  assert.deepEqual(calls.usage, ["other"]);
});

test("渲染结果不含令牌：账号对象误带凭据字段时也不显示", () => {
  const leaked = account("leak", { tokens: { access_token: "secret-access-value" }, refresh_token: "secret-refresh-value" });
  const { render } = panel({ view: viewOf([leaked]) });
  const serialized = JSON.stringify(render(), (_key, value) => typeof value === "function" ? undefined : value);
  assert.doesNotMatch(serialized, /secret-access-value|secret-refresh-value/);
});

test("前端类型不声明令牌字段", async () => {
  const types = await readSource("src/App.types.ts");
  const block = (name) => types.slice(types.indexOf(`export type ${name} =`), types.indexOf("};", types.indexOf(`export type ${name} =`)));
  for (const name of ["OfficialAccount", "OfficialAccountsResult", "OfficialAccountSwitchResult", "OfficialUsageSnapshot"]) {
    assert.ok(types.includes(`export type ${name} =`), name);
    assert.doesNotMatch(block(name), /token|auth_mode|tokens/i, name);
  }
});

test("不提供按账号分流、官方直连与路由入口", async () => {
  const sources = await Promise.all([
    "src/OfficialAccountsPanel.tsx", "src/officialAccountsRequests.ts", "src/useOfficialAccounts.ts", "src/useOfficialAccountLoginPoll.ts",
  ].map(readSource));
  for (const source of sources) {
    assert.doesNotMatch(source, /siwc|refresh_official_account_routes|officialRouteSettings|线路|本地路由/i);
  }
});
