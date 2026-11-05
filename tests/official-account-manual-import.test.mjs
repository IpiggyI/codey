import assert from "node:assert/strict";
import test from "node:test";

import { readSource } from "./helpers/read-source.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const [panelSource, api, mockApi] = await Promise.all([
  readSource("src/OfficialAccountsPanel.tsx"),
  readSource("src/api.ts"),
  readSource("src/dev/mockApi.ts"),
]);

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
const listResult = (accounts) => ({
  status: "ok",
  accounts,
  defaultAccountId: accounts.find((item) => item.isDefault)?.id ?? null,
  officialAccountAvailable: true,
  officialAccountStatus: "authenticated",
  switchDisabledReason: null,
});

function panel({ invoke } = {}) {
  const ui = autoStubModule("ui");
  const calls = { invoke: [], downloads: [], notices: [], changed: 0 };
  const view = listResult([account("cur", { isDefault: true }), account("other")]);
  const hook = {
    view,
    loadError: "",
    accountSwitched: false,
    usages: {},
    usageLoading: {},
    apply: () => {},
    refresh: async () => {},
    refreshUsage: async () => {},
  };
  const graph = createModuleGraph(new URL("../src/OfficialAccountsPanel.tsx", import.meta.url), {
    stubs: {
      "./components/ui": ui,
      "./api": { invoke: async (command, args = {}) => {
        calls.invoke.push({ command, args });
        return invoke ? invoke(command, args) : listResult([]);
      } },
      "./features/codex-extensions/download": {
        downloadResource: (...args) => calls.downloads.push(args),
      },
      "./useOfficialAccounts": { useOfficialAccounts: () => hook },
      "./useOfficialAccountLoginPoll": { useOfficialAccountLoginPoll: () => {} },
    },
  });
  const props = {
    active: true,
    disabled: false,
    refreshKey: 0,
    popupContainer: null,
    onSwitch: async () => null,
    onAccountsChanged: () => { calls.changed += 1; },
    onNotice: (notice) => calls.notices.push(notice),
    onRequestConfirmation: () => {},
  };
  const render = () => {
    graph.restart();
    return graph.exports.OfficialAccountsPanel(props);
  };
  const exactButton = (tree, label) => collectElements(tree, (node) =>
    elementType(node) === ui.Button && textContent(node) === label)[0];
  const card = (tree, text) => collectElements(tree, (node) => node.type === "li" && textContent(node).includes(text))[0];
  const fileInput = (tree) => collectElements(tree, (node) => node.type === "input" && node.props.type === "file")[0];
  const textarea = (tree) => collectElements(tree, (node) => node.type === "textarea")[0];
  const alerts = (tree) => collectElements(tree, (node) => node.props.role === "alert").map(textContent);
  const pickFile = (file) => elementProps(fileInput(render())).onChange({ target: { files: [file], value: "x" } });
  return { ui, calls, render, exactButton, card, fileInput, textarea, alerts, pickFile };
}

const jsonFile = (content, overrides = {}) => ({
  name: "codey-official-other.json",
  size: content.length,
  text: async () => content,
  ...overrides,
});

test("添加官方账号可以选择账号文件，也可以手动粘贴刷新令牌或 OAuth JSON", () => {
  assert.match(panelSource, /type="file"/);
  assert.match(panelSource, /accept="\.json,application\/json"/);
  assert.match(panelSource, /const content = await file\.text\(\)/);
  assert.match(panelSource, /const request = \+\+manualFileRead\.current/);
  assert.match(panelSource, /setManualInput\(content\)/);
  assert.match(panelSource, /"import_official_account_credential", \{ credential \}/);
  assert.match(panelSource, /MANUAL_CREDENTIAL_MAX_BYTES = 64 \* 1024/);
  assert.match(api, /"import_official_account_credential"/);
  assert.match(mockApi, /command === "import_official_account_credential"/);
});

test("官方账号可以导出服务端命名的 JSON 账号文件", () => {
  assert.match(api, /"export_official_account_credential"/);
  assert.match(mockApi, /command === "export_official_account_credential"/);
  assert.match(panelSource, /invoke<OfficialAccountCredentialExport>/);
  assert.match(panelSource, /downloadResource\(result\.fileName, result\.content/);
  assert.match(panelSource, /请妥善保管，不要分享给他人/);
});

test("导出：以账号 id 调用后端，并把返回的 content 以返回的 fileName 保存", async () => {
  const content = '{"auth":{"tokens":{"refresh_token":"secret-refresh-token"}}}';
  const { calls, render, exactButton, card } = panel({
    invoke: () => ({ status: "ok", fileName: "codey-official-other.json", content }),
  });
  elementProps(exactButton(card(render(), "other@"), "导出账号文件")).onPress();
  await flush();
  assert.deepEqual(calls.invoke, [{ command: "export_official_account_credential", args: { accountId: "other" } }]);
  assert.deepEqual(calls.downloads, [["codey-official-other.json", content, "application/json;charset=utf-8"]]);
  assert.deepEqual(calls.notices, [{ tone: "success", text: "账号文件已导出，请妥善保管，不要分享给他人" }]);
  assert.doesNotMatch(JSON.stringify(calls.notices) + textContent(render()), /secret-refresh-token/, "凭据不进入提示或界面");
  assert.equal(elementProps(exactButton(card(render(), "other@"), "导出账号文件")).loading, false, "完成后恢复按钮");
});

test("导出：后端失败时显示后端消息且不保存文件；返回内容无效时同样不保存", async () => {
  const failing = panel({ invoke: () => { throw new Error("未找到要导出的官方账号"); } });
  elementProps(failing.exactButton(failing.card(failing.render(), "other@"), "导出账号文件")).onPress();
  await flush();
  assert.deepEqual(failing.calls.notices, [{ tone: "error", text: "未找到要导出的官方账号" }]);
  assert.deepEqual(failing.calls.downloads, []);

  for (const reply of [
    { status: "ok", fileName: "", content: "{}" },
    { status: "ok", fileName: "a.json", content: "  " },
    { status: "ok", fileName: "a.json" },
  ]) {
    const invalid = panel({ invoke: () => reply });
    elementProps(invalid.exactButton(invalid.card(invalid.render(), "other@"), "导出账号文件")).onPress();
    await flush();
    assert.deepEqual(invalid.calls.notices, [{ tone: "error", text: "账号文件内容无效，请重试" }]);
    assert.deepEqual(invalid.calls.downloads, []);
  }
});

test("导出：进行中其他账号操作被禁用，期间导出按钮显示加载", async () => {
  let release;
  const { render, exactButton, card } = panel({
    invoke: () => new Promise((resolve) => { release = resolve; }),
  });
  elementProps(exactButton(card(render(), "other@"), "导出账号文件")).onPress();
  const tree = render();
  assert.equal(elementProps(exactButton(card(tree, "other@"), "导出账号文件")).loading, true);
  assert.equal(elementProps(exactButton(card(tree, "cur@"), "导出账号文件")).disabled, true);
  release({ status: "ok", fileName: "a.json", content: "{}" });
  await flush();
  assert.equal(elementProps(exactButton(card(render(), "cur@"), "导出账号文件")).disabled, false);
});

test("选择账号文件：内容进入输入框并提示已载入，添加时提交去除首尾空白的内容", async () => {
  const { calls, render, textarea, exactButton, pickFile } = panel({ invoke: () => listResult([account("new")]) });
  elementProps(exactButton(render(), "粘贴凭据")).onPress();
  await pickFile(jsonFile('  {"refresh_token":"abc"}\n'));
  const tree = render();
  assert.equal(elementProps(textarea(tree)).value, '  {"refresh_token":"abc"}\n');
  assert.match(textContent(tree), /已载入 codey-official-other\.json，请检查内容后添加/);
  elementProps(exactButton(tree, "添加")).onPress();
  await flush();
  assert.deepEqual(calls.invoke, [{ command: "import_official_account_credential", args: { credential: '{"refresh_token":"abc"}' } }]);
  assert.equal(calls.changed, 1);
});

test("选择账号文件：非 .json 或超过 64 KiB 的文件被拒绝，不调用后端", async () => {
  const { calls, render, textarea, alerts, exactButton, pickFile } = panel();
  elementProps(exactButton(render(), "粘贴凭据")).onPress();
  await pickFile(jsonFile("{}", { name: "account.txt" }));
  assert.deepEqual(alerts(render()), ["请选择 .json 格式的账号文件"]);
  await pickFile(jsonFile("{}", { size: 64 * 1024 + 1 }));
  assert.deepEqual(alerts(render()), ["账号文件不能超过 64 KiB"]);
  await pickFile(jsonFile("{}", { text: async () => { throw new Error("磁盘错误"); } }));
  assert.deepEqual(alerts(render()), ["磁盘错误"]);
  assert.equal(elementProps(textarea(render())).value, "");
  assert.equal(elementProps(exactButton(render(), "添加")).disabled, true);
  assert.deepEqual(calls.invoke, []);
});

test("选择账号文件：读取期间禁止添加，晚到的读取结果在重新选择、编辑或关闭后被丢弃", async () => {
  const { ui, render, textarea, exactButton, fileInput, pickFile } = panel();
  elementProps(exactButton(render(), "粘贴凭据")).onPress();
  const manualDialog = (tree) => collectElements(tree, (node) =>
    elementType(node) === ui.Dialog && collectElements(node, (child) => child.type === "textarea").length > 0)[0];

  let releaseFirst;
  const first = pickFile(jsonFile("first", { text: () => new Promise((resolve) => { releaseFirst = resolve; }) }));
  assert.equal(elementProps(exactButton(render(), "添加")).disabled, true, "读取中禁用添加");
  assert.equal(elementProps(fileInput(render())).disabled, true);
  await pickFile(jsonFile("second", { name: "second.json" }));
  releaseFirst("first");
  await first;
  assert.equal(elementProps(textarea(render())).value, "second", "旧读取不覆盖新选择");

  let releaseEdit;
  const edited = pickFile(jsonFile("late", { text: () => new Promise((resolve) => { releaseEdit = resolve; }) }));
  elementProps(textarea(render())).onChange({ target: { value: "typed" } });
  releaseEdit("late");
  await edited;
  const tree = render();
  assert.equal(elementProps(textarea(tree)).value, "typed", "手动编辑后晚到的读取被丢弃");
  assert.doesNotMatch(textContent(tree), /已载入/);

  let releaseClose;
  const closed = pickFile(jsonFile("closed", { text: () => new Promise((resolve) => { releaseClose = resolve; }) }));
  elementProps(manualDialog(render())).onOpenChange(false);
  releaseClose("closed");
  await closed;
  assert.equal(elementProps(manualDialog(render())).open, false);
  assert.doesNotMatch(textContent(render()), /已载入/, "关闭后晚到的读取被丢弃");
  elementProps(exactButton(render(), "粘贴凭据")).onPress();
  assert.equal(elementProps(textarea(render())).value, "", "重新打开时输入框为空");
});
