import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { readSource } from "./helpers/read-source.mjs";

const [dialogSource, appSource, stylesSource, operationsSource] = await Promise.all([
  readSource("src/SystemSettingsDialog.tsx"),
  readSource("src/App.tsx"),
  readSource("src/styles.css"),
  readSource("src/OperationsPanel.tsx"),
]);

// 极简 React 桩：直接执行组件函数，拿到真实渲染出的元素树。
// 树里保留每个组件的 props，因此断言的是事件接线与可见文案，而不是源码字符串。
const ELEMENT = Symbol("codey-test-element");
const isElement = (value) => Boolean(value && value[ELEMENT]);
const elementProps = (node) => (isElement(node) ? node.props : undefined);
const elementType = (node) => (isElement(node) ? node.type : undefined);
const makeElement = (type, props, key) => ({
  [ELEMENT]: true,
  type,
  props: key === undefined ? { ...props } : { ...props, key },
});

function createStub(name) {
  const target = function StubComponent() {
    return null;
  };
  Object.defineProperty(target, "name", { value: name });
  return target;
}

function autoStubModule(prefix) {
  const stubs = new Map();
  return new Proxy({}, {
    get(_target, key) {
      const name = `${prefix}:${String(key)}`;
      if (!stubs.has(name)) stubs.set(name, createStub(name));
      return stubs.get(name);
    },
  });
}

function collectElements(node, predicate = () => true) {
  const found = [];
  const visit = (current) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!isElement(current)) return;
    if (predicate(current)) found.push(current);
    visit(current.props.children);
  };
  visit(node);
  return found;
}

function textContent(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isElement(node) ? textContent(node.props.children) : "";
}

const ui = autoStubModule("ui");
const icons = autoStubModule("icon");

// 每次 loadDialog 得到独立的 React 状态；useEffect 只记录回调，由测试决定何时执行。
function loadDialog() {
  let cursor = 0;
  let states = [];
  let effect = null;
  const react = {
    memo: (component) => component,
    useRef: (initial) => ({ current: initial }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [
        states[index],
        (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        },
      ];
    },
    useEffect(callback, deps) {
      effect = { callback, deps };
    },
  };
  const jsxRuntime = {
    jsx: (type, props, key) => makeElement(type, props ?? {}, key),
    jsxs: (type, props, key) => makeElement(type, props ?? {}, key),
  };
  const stubs = { "./components/ui": ui, "@tabler/icons-react": icons };
  const load = (url) => {
    const compiled = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const require = (specifier) => {
      if (specifier === "react") return react;
      if (specifier === "react/jsx-runtime") return jsxRuntime;
      if (specifier in stubs) return stubs[specifier];
      if (!specifier.startsWith(".")) throw new Error(`未处理的模块依赖：${specifier}`);
      const base = new URL(specifier, url).href;
      const resolved = [`${base}.ts`, `${base}.tsx`].find((candidate) => {
        try {
          return statSync(fileURLToPath(candidate)).isFile();
        } catch {
          return false;
        }
      });
      if (!resolved) throw new Error(`无法解析依赖：${specifier}`);
      return load(new URL(resolved));
    };
    const module = { exports: {} };
    new Function("require", "exports", "module", compiled)(require, module.exports, module);
    return module.exports;
  };
  const exports = load(new URL("../src/SystemSettingsDialog.tsx", import.meta.url));
  return {
    SystemSettingsDialog: exports.SystemSettingsDialog,
    restart: () => { cursor = 0; },
    effect: () => effect,
  };
}

const clipboardWrites = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText(value) {
        clipboardWrites.push(value);
        return Promise.resolve();
      },
    },
  },
});

const byLabel = (tree, label) =>
  collectElements(tree, (element) => elementProps(element)["aria-label"] === label);
const byText = (tree, text) =>
  collectElements(
    tree,
    (element) =>
      typeof elementProps(element).onPress === "function" &&
      textContent(element).replace(/\s+/g, "") === text,
  );
const hasCheckIcon = (element) =>
  collectElements(element, (child) => elementType(child) === icons.IconCheck).length > 0;
const statusLines = (tree) =>
  collectElements(tree, (element) => elementProps(element).role === "status").map(textContent);
const settle = () => new Promise(setImmediate);

// 渲染对话框并模拟「打开 -> 读取运行状态」：run() 执行打开时的副作用，render() 重新取树。
function openDialog(overrides = {}) {
  const calls = { refresh: 0, repair: 0, openChange: [] };
  const harness = loadDialog();
  const props = {
    open: true,
    onOpenChange: (open) => calls.openChange.push(open),
    container: null,
    appVersion: "1.1.1",
    codexAppVersion: "0.4.0",
    codexAppPath: "C:\\Codex\\Codex.exe",
    onRefreshStatus: async () => { calls.refresh += 1; },
    isBusy: false,
    busy: null,
    onRepairCodexConfig: () => { calls.repair += 1; },
    configRepairNotice: null,
    ...overrides,
  };
  const render = () => {
    harness.restart();
    return harness.SystemSettingsDialog(props);
  };
  let cleanup;
  return {
    calls,
    props,
    render,
    firstRender: render(),
    runEffect: () => {
      cleanup?.();
      cleanup = harness.effect().callback();
      return cleanup;
    },
    closeEffect: () => cleanup?.(),
  };
}

test("读取完成后显示 Codey 版本、Codex 版本和 Codex 目录", async () => {
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  const tree = dialog.render();
  const text = textContent(tree);
  assert.equal(dialog.calls.refresh, 1);
  assert.match(text, /系统设置与偏好/);
  assert.match(text, /Codey 版本\s*v1\.1\.1/);
  assert.match(text, /Codex 版本\s*v0\.4\.0/);
  assert.ok(text.includes("C:\\Codex\\Codex.exe"));
  assert.doesNotMatch(text, /读取中|读取失败|未运行/);
});

test("Codex 版本带 v 前缀时不重复添加，Codey 版本缺失时使用默认值", async () => {
  const dialog = openDialog({ codexAppVersion: " v0.5.1 ", appVersion: undefined });
  dialog.runEffect();
  await settle();
  const text = textContent(dialog.render());
  assert.match(text, /Codex 版本\s*v0\.5\.1/);
  assert.match(text, /Codey 版本\s*v0\.2\.0/);
});

for (const missing of [undefined, "", "   "]) {
  test(`Codex 没有运行或没检测到时显示「未运行 / 未检测到」(${JSON.stringify(missing)})`, async () => {
    const dialog = openDialog({ codexAppVersion: missing });
    dialog.runEffect();
    await settle();
    const text = textContent(dialog.render());
    assert.match(text, /Codex 版本\s*未运行 \/ 未检测到/);
    assert.doesNotMatch(text, /读取失败/);
  });
}

test("打开时显示「读取中…」，读取完成后换成真实值", async () => {
  let finish;
  const dialog = openDialog({
    onRefreshStatus: () => new Promise((resolve) => { finish = resolve; }),
  });
  assert.match(textContent(dialog.firstRender), /Codex 版本\s*读取中…/);
  dialog.runEffect();
  await settle();
  assert.match(textContent(dialog.render()), /Codex 版本\s*读取中…/);
  finish();
  await settle();
  const text = textContent(dialog.render());
  assert.match(text, /Codex 版本\s*v0\.4\.0/);
  assert.doesNotMatch(text, /读取中/);
});

test("关闭时不读取运行状态", () => {
  let reads = 0;
  const dialog = openDialog({
    open: false,
    onRefreshStatus: async () => { reads += 1; },
  });
  assert.equal(dialog.runEffect(), undefined);
  assert.equal(reads, 0);
});

for (const [label, error, expected] of [
  ["Error 对象", new Error("运行状态查询超时，请重新查询"), "运行状态查询超时，请重新查询"],
  ["字符串", "后端未响应", "后端未响应"],
  ["空白原因", new Error("  "), "暂时无法读取 Codex 信息，请稍后重试。"],
  ["无原因", null, "暂时无法读取 Codex 信息，请稍后重试。"],
]) {
  test(`读取失败时显示原因：${label}`, async () => {
    const dialog = openDialog({ onRefreshStatus: async () => { throw error; } });
    dialog.runEffect();
    await settle();
    const tree = dialog.render();
    const text = textContent(tree);
    assert.match(text, /Codex 版本\s*读取失败/);
    assert.doesNotMatch(text, /读取中/);
    assert.ok(statusLines(tree).includes(expected), `缺少原因：${expected}`);
  });
}

test("关闭后迟到的读取结果被忽略，重新打开会重新读取", async () => {
  const pending = [];
  const dialog = openDialog({
    onRefreshStatus: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  });
  dialog.runEffect();
  dialog.closeEffect();
  pending[0].reject(new Error("旧请求失败"));
  await settle();
  const stale = textContent(dialog.render());
  assert.match(stale, /读取中…/);
  assert.doesNotMatch(stale, /旧请求失败|读取失败/);

  dialog.runEffect();
  assert.equal(pending.length, 2);
  pending[1].resolve();
  await settle();
  assert.match(textContent(dialog.render()), /Codex 版本\s*v0\.4\.0/);
});

test("复制路径成功：写入剪贴板、显示已复制反馈，一段时间后恢复", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clipboardWrites.length = 0;
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  const tree = dialog.render();
  const [copy] = byLabel(tree, "复制 Codex 路径");
  assert.ok(copy, "复制按钮必须带 aria-label");
  assert.equal(elementType(copy), ui.Button);
  assert.equal(hasCheckIcon(copy), false);
  assert.deepEqual(statusLines(tree), []);

  await elementProps(copy).onPress();
  assert.deepEqual(clipboardWrites, ["C:\\Codex\\Codex.exe"]);
  const copied = dialog.render();
  assert.equal(hasCheckIcon(byLabel(copied, "复制 Codex 路径")[0]), true);
  assert.deepEqual(statusLines(copied), ["已复制到剪贴板"]);
  assert.equal(
    collectElements(copied, (e) => elementProps(e).content === "已复制到剪贴板").length,
    1,
  );

  t.mock.timers.tick(3000);
  const reset = dialog.render();
  assert.equal(hasCheckIcon(byLabel(reset, "复制 Codex 路径")[0]), false);
  assert.deepEqual(statusLines(reset), []);
});

test("未配置 Codex 目录时复制默认路径", async () => {
  clipboardWrites.length = 0;
  const dialog = openDialog({ codexAppPath: "" });
  dialog.runEffect();
  await settle();
  const tree = dialog.render();
  assert.ok(textContent(tree).includes("/Applications/ChatGPT.app"));
  await elementProps(byLabel(tree, "复制 Codex 路径")[0]).onPress();
  assert.deepEqual(clipboardWrites, ["/Applications/ChatGPT.app"]);
});

test("复制路径失败：不显示成功反馈，给出失败提示", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  t.mock.method(navigator.clipboard, "writeText", async () => { throw new Error("denied"); });
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  await elementProps(byLabel(dialog.render(), "复制 Codex 路径")[0]).onPress();
  const tree = dialog.render();
  assert.equal(hasCheckIcon(byLabel(tree, "复制 Codex 路径")[0]), false);
  assert.deepEqual(statusLines(tree), ["复制失败，请选中路径手动复制"]);
  assert.equal(
    collectElements(tree, (e) => elementProps(e).content === "复制失败，请选中路径手动复制").length,
    1,
  );
  assert.equal(console.error.mock.callCount(), 1);

  t.mock.timers.tick(3000);
  assert.deepEqual(statusLines(dialog.render()), []);
});

test("重新打开对话框时清除上一次的复制反馈", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  await elementProps(byLabel(dialog.render(), "复制 Codex 路径")[0]).onPress();
  assert.deepEqual(statusLines(dialog.render()), ["已复制到剪贴板"]);
  dialog.runEffect();
  assert.deepEqual(statusLines(dialog.render()), []);
});

test("对话框不含设备号行，也没有更新策略入口", async () => {
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  const text = textContent(dialog.render());
  assert.doesNotMatch(text, /设备号|尚未登记/);
  assert.doesNotMatch(text, /更新策略|稳定版|实验版|不检查/);
  assert.equal(byLabel(dialog.render(), "复制设备号").length, 0);
  assert.equal(byLabel(dialog.render(), "重新读取设备号").length, 0);

  assert.doesNotMatch(dialogSource, /machine|device|设备号|get_device/i);
  assert.doesNotMatch(dialogSource, /Tabs|更新策略|UpdatePolicy/);
});

test("对话框提供「修复 Codex 配置」行与「修复」按钮，按下只通知 App，不自行发送命令", async () => {
  const dialog = openDialog();
  dialog.runEffect();
  await settle();
  const tree = dialog.render();
  assert.match(textContent(tree), /修复 Codex 配置/);
  const [repair] = byText(tree, "修复");
  assert.ok(repair, "必须有「修复」按钮");
  assert.equal(elementType(repair), ui.Button);
  assert.equal(elementProps(repair).disabled, false);
  // 只有 onPress 同时覆盖鼠标与键盘。
  assert.equal(elementProps(repair).onClick, undefined);
  assert.equal(dialog.calls.repair, 0);
  elementProps(repair).onPress();
  assert.equal(dialog.calls.repair, 1);
});

test("修复进行中：按钮显示「修复中…」并禁用，其他操作忙碌时同样禁用", async () => {
  const running = openDialog({ isBusy: true, busy: "repair-codex-config" });
  running.runEffect();
  await settle();
  const runningTree = running.render();
  const [button] = byText(runningTree, "修复中…");
  assert.ok(button, "忙碌时按钮文案为「修复中…」");
  assert.equal(elementProps(button).disabled, true);
  assert.equal(byText(runningTree, "修复").length, 0);

  const other = openDialog({ isBusy: true, busy: "save" });
  other.runEffect();
  await settle();
  const [idle] = byText(other.render(), "修复");
  assert.ok(idle, "其他操作忙碌时仍显示「修复」");
  assert.equal(elementProps(idle).disabled, true);
});

test("修复结果按原文显示：成功与失败各自带 role=status，未修复时没有结果行", async () => {
  const none = openDialog();
  none.runEffect();
  await settle();
  assert.deepEqual(statusLines(none.render()), []);

  const success = "修复成功，请从 Codey 重启 Codex 使修改生效。\n已创建配置文件；备份位置：C:\\Codey\\backup\\config.toml";
  const ok = openDialog({ configRepairNotice: { tone: "success", text: success } });
  ok.runEffect();
  await settle();
  assert.deepEqual(statusLines(ok.render()), [success]);

  const failure = "Codex 配置修复未完成：解析配置失败，第 3 行 TOML 语法无效。请查看 Codey 错误日志；连接中断时可重新检查执行结果。";
  const bad = openDialog({ configRepairNotice: { tone: "error", text: failure } });
  bad.runEffect();
  await settle();
  const [line] = collectElements(
    bad.render(),
    (e) => elementProps(e).role === "status" && textContent(e) === failure,
  );
  assert.ok(line, "失败原因必须原样显示");
  assert.match(elementProps(line).className, /text-danger/);
});

// 从 App.tsx 取出确认与修复两个函数，接上桩后真实执行，验证「未确认不发送」。
function loadRepairFlow(invoke) {
  const sourceFile = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const picked = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      ["askRepairCodexConfig", "repairCodexConfig"].includes(node.name?.text)
    ) {
      picked.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.equal(picked.length, 2, "App.tsx 必须同时包含 askRepairCodexConfig 与 repairCodexConfig");
  const compile = (code) => ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { errorText } = (() => {
    const module = { exports: {} };
    new Function("exports", "module", ts.transpileModule(
      readFileSync(fileURLToPath(new URL("../src/appUtils.ts", import.meta.url)), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText)(module.exports, module);
    return module.exports;
  })();
  const log = { confirmations: [], notices: [], repairNotices: [], busy: [] };
  const build = new Function(
    "invoke", "isBusy", "setConfirmation", "setNotice", "setConfigRepairNotice", "runOperation", "errorText",
    `${compile(picked.join("\n"))}\nreturn { askRepairCodexConfig, repairCodexConfig };`,
  );
  const flow = build(
    invoke,
    false,
    (confirmation) => log.confirmations.push(confirmation),
    (notice) => log.notices.push(notice),
    (notice) => log.repairNotices.push(notice),
    async (name, action) => {
      log.busy.push(name);
      await action();
    },
    errorText,
  );
  return { ...flow, log };
}

test("修复流程：确认前不调用 repair_codex_config，确认后才发送", async () => {
  const sent = [];
  const flow = loadRepairFlow(async (command, args) => {
    sent.push([command, args]);
    return { message: "已创建配置文件", configPath: "C:\\Users\\a\\.codex\\config.toml", repaired: true, backupPath: null };
  });
  flow.askRepairCodexConfig();
  await settle();
  assert.deepEqual(sent, [], "未确认时不得发送命令");
  assert.deepEqual(flow.log.busy, [], "未确认时不得进入忙碌状态");
  assert.equal(flow.log.confirmations.length, 1);
  const [confirmation] = flow.log.confirmations;
  assert.equal(confirmation.action, "repair-codex-config");
  assert.equal(confirmation.title, "修复 Codex 配置？");
  assert.equal(confirmation.confirmLabel, "确认修复");
  assert.match(confirmation.description, /修改已有配置前自动备份/);
  assert.match(confirmation.description, /从 Codey 重启 Codex/);

  confirmation.run();
  await settle();
  assert.deepEqual(sent, [["repair_codex_config", undefined]]);
  assert.deepEqual(flow.log.busy, ["repair-codex-config"]);
});

test("修复流程：成功时显示后端消息与配置路径，备份位置在消息或 backupPath 中原样出现", async () => {
  const message = "已创建配置文件。备份位置：C:\\Codey\\backup\\config.toml";
  const flow = loadRepairFlow(async () => ({
    message,
    configPath: "C:\\Users\\a\\.codex\\config.toml",
    repaired: true,
    backupPath: null,
  }));
  flow.askRepairCodexConfig();
  flow.log.confirmations[0].run();
  await settle();
  const [progress, done] = flow.log.repairNotices;
  assert.deepEqual(progress, { tone: "info", text: "正在检查并修复 Codex 配置…" });
  assert.equal(done.tone, "success");
  assert.ok(done.text.includes(message), "后端消息必须原样显示");
  assert.ok(done.text.startsWith("修复成功，请从 Codey 重启 Codex 使修改生效。"));
  assert.ok(done.text.includes("配置文件：C:\\Users\\a\\.codex\\config.toml"));
  assert.deepEqual(flow.log.notices, flow.log.repairNotices);
});

test("修复流程：后端消息已含备份位置与重启提示时，备份路径和重启提示各只出现一次", async () => {
  const backup = "C:\\Codey\\backup\\config.toml.bak";
  const message = `配置修复完成，请从 Codey 重启 Codex；原文件备份：${backup}`;
  const flow = loadRepairFlow(async () => ({
    message,
    configPath: "C:\\Users\\a\\.codex\\config.toml",
    repaired: true,
    backupPath: backup,
  }));
  flow.askRepairCodexConfig();
  flow.log.confirmations[0].run();
  await settle();
  const done = flow.log.repairNotices.at(-1);
  assert.equal(done.tone, "success");
  assert.ok(done.text.includes(message), "后端消息必须原样显示");
  assert.equal(done.text.split(backup).length - 1, 1, "备份路径只能出现一次");
  assert.equal(done.text.split("重启 Codex").length - 1, 1, "重启提示只能出现一次");
});

test("修复流程：无需修改时不提示重启，失败时显示后端返回的错误", async () => {
  const unchanged = loadRepairFlow(async () => ({
    message: "",
    configPath: "C:\\c.toml",
    repaired: false,
    backupPath: "C:\\b.toml",
  }));
  unchanged.askRepairCodexConfig();
  unchanged.log.confirmations[0].run();
  await settle();
  const ok = unchanged.log.repairNotices.at(-1);
  assert.equal(ok.tone, "success");
  assert.doesNotMatch(ok.text, /请从 Codey 重启 Codex/);
  assert.ok(ok.text.includes("Codex 配置检查通过，无需修改"));
  assert.ok(ok.text.includes("备份文件：C:\\b.toml"));

  const reason = "解析配置：第 3 行 TOML 语法无效（C:\\c.toml）";
  const failing = loadRepairFlow(async () => { throw new Error(reason); });
  failing.askRepairCodexConfig();
  failing.log.confirmations[0].run();
  await settle();
  const bad = failing.log.repairNotices.at(-1);
  assert.equal(bad.tone, "error");
  assert.ok(bad.text.includes(reason), "后端错误消息必须原样显示");
  assert.match(bad.text, /^Codex 配置修复未完成：/);
  assert.deepEqual(failing.log.notices.at(-1), bad);
});

test("App 把修复入口接到对话框，api 白名单与确认动作类型包含修复命令", async () => {
  assert.match(appSource, /onRepairCodexConfig=\{askRepairCodexConfig\}/);
  assert.match(appSource, /configRepairNotice=\{configRepairNotice\}/);
  assert.match(appSource, /isBusy=\{isBusy\}\s+busy=\{busy\}\s+onRepairCodexConfig/);
  // 修复命令只出现在 repairCodexConfig 内；运行面板不再提供第二个入口。
  assert.equal(appSource.match(/"repair_codex_config"/g)?.length, 1);
  assert.doesNotMatch(operationsSource, /repair_codex_config|onRepairCodexConfig|修复 Codex 配置/);
  const [api, types] = await Promise.all([readSource("src/api.ts"), readSource("src/App.types.ts")]);
  assert.match(api, /"repair_codex_config",\n\] as const/);
  assert.match(types, /\| "repair-codex-config"/);
});

test("对话框只读：不引入 invoke，唯一的外部调用是只读的状态刷新回调", () => {
  assert.doesNotMatch(dialogSource, /from "\.\/api"/);
  assert.doesNotMatch(dialogSource, /\binvoke\b/);
  assert.match(dialogSource, /onRefreshStatus\(\)/);
});

test("键盘操作：关闭由对话框接管，完成按钮是可聚焦的 Button", async () => {
  const dialog = openDialog();
  const tree = dialog.render();
  const [root] = collectElements(tree, (e) => elementType(e) === ui.Dialog);
  assert.ok(root, "必须使用 Dialog，Esc 与遮罩点击由它统一关闭");
  assert.equal(elementProps(root).open, true);
  assert.equal(elementProps(root).onOpenChange, dialog.props.onOpenChange);

  const [done] = byText(tree, "完成");
  assert.ok(done, "必须有完成按钮");
  assert.equal(elementType(done), ui.Button);
  elementProps(done).onPress();
  assert.deepEqual(dialog.calls.openChange, [false]);

  // 页面里的 Button 只有 onPress 才同时覆盖鼠标与键盘（Enter / Space）。
  const clickOnly = collectElements(tree, (e) =>
    elementType(e) === ui.Button && typeof elementProps(e).onClick === "function");
  assert.deepEqual(clickOnly, []);
});

test("App 在页头提供入口，并把对话框接到只读状态刷新", () => {
  assert.match(appSource, /import \{ SystemSettingsDialog \} from "\.\/SystemSettingsDialog"/);
  assert.match(
    appSource,
    /aria-label="系统设置与偏好"[\s\S]{0,200}onPress=\{\(\) => setSystemSettingsOpen\(true\)\}/,
  );
  assert.match(appSource, /<SystemSettingsDialog[\s\S]*open=\{systemSettingsOpen\}/);
  assert.match(appSource, /onOpenChange=\{setSystemSettingsOpen\}/);
  assert.match(appSource, /container=\{portalContainer\}/);
  assert.match(appSource, /appVersion=\{status\.appVersion\}/);
  assert.match(appSource, /codexAppVersion=\{status\.codexAppVersion\}/);
  assert.match(appSource, /codexAppPath=\{config\.codexAppPath \|\| status\.codexAppPath\}/);
  assert.match(appSource, /onRefreshStatus=\{refreshStatus\}/);
  assert.doesNotMatch(appSource, /get_device_machine_no/);
});

test("Codex 版本与目录移入对话框，运行面板不再重复显示", () => {
  assert.doesNotMatch(operationsSource, /codex-version-tag|codexVersionLabel|Codex 版本未知/);
  assert.doesNotMatch(operationsSource, /header-path-display|Codex 应用路径|codexAppPath/);
  assert.match(operationsSource, /<h2 id="operations-title">Codex 运行状态<\/h2>/);
  assert.match(appSource, /v\{status\.appVersion \|\| "0\.2\.0"\}/);
});

test("样式定义系统设置对话框的版本栏、目录框与反馈行", () => {
  for (const selector of [
    "system-settings-body",
    "system-settings-card",
    "system-settings-versions",
    "system-settings-path-box",
    "system-settings-copy-feedback",
  ]) {
    assert.match(stylesSource, new RegExp(`\\.${selector}\\b[^{]*\\{`));
  }
  for (const className of ["system-settings-card", "system-settings-copy"]) {
    assert.ok(dialogSource.includes(className), className);
  }
});
