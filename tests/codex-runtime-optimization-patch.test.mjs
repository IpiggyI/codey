import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import vm from "node:vm";

const normalizeLineEndings = (source) => source.replace(/\r\n/g, "\n");
// Desktop's shared transport applies its own transform before serialization.
const appServerTransportFixture = `globalThis.Transport=class {
  constructor(options){this.options=options}
  sendMessage(e){let n=this.options.getConnection(),a=this.options.transformOutgoingMessage==null?e:this.options.transformOutgoingMessage(e);n.send(JSON.stringify(a))}
};`;

async function loadPatchExpression(
  runtimeConfigOverrides = [],
  subagentGateActive = runtimeConfigOverrides.includes("features.hooks=true"),
  requireAppServerRuntimeOverrideValidation = false,
) {
  const template = normalizeLineEndings(await readFile(
    new URL("../backend/src/codex_startup_patch.js", import.meta.url),
    "utf8",
  ));
  assert.ok(template, "startup patch template should be readable by the regression test");
  return template
    .replaceAll(
      '"__CODEY_RUNTIME_CONFIG_OVERRIDES__"',
      JSON.stringify(runtimeConfigOverrides),
    )
    .replaceAll("__DISABLE_PET__", "false")
    .replaceAll(
      "__SUBAGENT_GATE_ACTIVE__",
      subagentGateActive ? "true" : "false",
    )
    .replaceAll(
      "__REQUIRE_APP_SERVER_RUNTIME_OVERRIDES__",
      requireAppServerRuntimeOverrideValidation ? "true" : "false",
    );
}

async function loadPatchInIsolatedContext(runtimeConfigOverrides, contextOverrides = {}, installMessagePatch = true) {
  const Module = process.getBuiltinModule("module");
  const originalLoad = Module._load;
  const originalJsExtension = Module._extensions[".js"];
  const workerThreads = process.getBuiltinModule("worker_threads");
  const NativeWorker = workerThreads.Worker;
  const childProcess = process.getBuiltinModule("child_process");
  const originalSpawn = childProcess.spawn;
  const spawnCalls = [];
  childProcess.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: 4242 };
  };
  const context = {
    clearTimeout,
    console,
    process: { ...process, env: { ...process.env } },
    Promise,
    setImmediate,
    setTimeout,
    ...contextOverrides,
  };
  context.globalThis = context;
  const restore = () => {
    childProcess.spawn = originalSpawn;
    Module._load = originalLoad;
    Module._extensions[".js"] = originalJsExtension;
    workerThreads.Worker = NativeWorker;
    Module.syncBuiltinESMExports?.();
  };
  try {
    const result = vm.runInNewContext(
      await loadPatchExpression(
        runtimeConfigOverrides,
        runtimeConfigOverrides.includes("features.hooks=true"),
        true,
      ),
      context,
    );
    if (installMessagePatch) {
      context.__CODEY_PATCH_CODEX_APP_SERVER_MESSAGES__(appServerTransportFixture);
    }
    return {
      context,
      result,
      restore,
      spawnCalls,
    };
  } catch (error) {
    restore();
    throw error;
  }
}

test("startup patch disables Codex analytics and trims diagnostic polling", async () => {
  const Module = process.getBuiltinModule("module");
  const childProcess = process.getBuiltinModule("child_process");
  const workerThreads = process.getBuiltinModule("worker_threads");
  const originalLoad = Module._load;
  const originalJsExtension = Module._extensions[".js"];
  const originalSpawn = childProcess.spawn;
  const NativeWorker = workerThreads.Worker;
  const spawnCalls = [];
  const ipcHandlers = new Map();
  const fakeIpcMain = new EventEmitter();
  fakeIpcMain.handle = (channel, handler) => {
    ipcHandlers.set(channel, handler);
  };
  const fakeElectron = {
    BrowserWindow: class BrowserWindow {},
    ipcMain: fakeIpcMain,
  };
  Module._load = function testElectronLoader(request) {
    if (request === "electron") return fakeElectron;
    return Reflect.apply(originalLoad, this, arguments);
  };
  childProcess.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: 42 };
  };

  try {
    const runtimeConfigOverrides = [
      "features.hooks=true",
      'model_provider="codey_global"',
      'model_providers.codey_global.base_url="http://127.0.0.1:61818/v1"',
      'developer_instructions="Codey route"',
      'mcp_servers.codey_fastctx.command="C:\\\\Program Files\\\\Codey\\\\codey-fastctx.exe"',
      'agents.default.config_file="D:\\\\Codey\\\\runtime\\\\default.toml"',
      'hooks.state."C:\\\\Users\\\\Kim\\\\.codex\\\\hooks.json:pre_tool_use:1:0".trusted_hash="sha256:test"',
      '__CODEY_WSL_ONLY__:hooks.state."C:\\\\Users\\\\Kim\\\\.codex\\\\hooks.json:pre_tool_use:1:0".trusted_hash="sha256:wsl"',
      `hooks.PreToolUse=[{ hooks = [{ type = "command", command = "'C:\\\\Program Files\\\\Codey\\\\codey.exe' --codey-subagent-gate-hook" }] }]`,
    ];
    const nativeRuntimeConfigOverrides = runtimeConfigOverrides.filter(
      (config) => !config.startsWith("__CODEY_WSL_ONLY__:"),
    );
    const expression = await loadPatchExpression(runtimeConfigOverrides);
    assert.equal((0, eval)(expression), "codey-startup-patch-installed-v39");
    const patchedElectron = Module._load("electron");
    const passthroughGitHandler = () => "git-handler";
    const passthroughMessageHandler = () => "message-handler";
    patchedElectron.ipcMain.handle(
      "codex_desktop:worker:git:from-view",
      passthroughGitHandler,
    );
    patchedElectron.ipcMain.handle(
      "codex_desktop:message-from-view",
      passthroughMessageHandler,
    );
    assert.equal(
      ipcHandlers.get("codex_desktop:worker:git:from-view"),
      passthroughGitHandler,
    );
    assert.equal(
      ipcHandlers.get("codex_desktop:message-from-view"),
      passthroughMessageHandler,
    );

    const desktopMcpConfig =
      'mcp_servers.codex_app={ command = "/opt/codex-app-mcp", args = ["server.mjs"] }';
    const directArgs = [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "-c",
      desktopMcpConfig,
    ];
    childProcess.spawn("/Applications/ChatGPT.app/Contents/Resources/codex", directArgs);
    assert.deepEqual(spawnCalls.at(-1)[1], [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "-c",
      desktopMcpConfig,
      "-c",
      "analytics.enabled=false",
      ...nativeRuntimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);
    const fastctxRuntimeConfig = nativeRuntimeConfigOverrides.find((config) =>
      config.startsWith("mcp_servers.codey_fastctx.command="),
    );
    assert.ok(fastctxRuntimeConfig);
    assert.ok(
      spawnCalls.at(-1)[1].indexOf(fastctxRuntimeConfig) >
        spawnCalls.at(-1)[1].indexOf(desktopMcpConfig),
    );
    assert.equal(
      spawnCalls.at(-1)[2].env.CODEY_SUBAGENT_GATE_ACTIVE,
      "1",
    );
    const subagentGateRuntimeId =
      spawnCalls.at(-1)[2].env.CODEY_SUBAGENT_GATE_RUNTIME_ID;
    assert.match(subagentGateRuntimeId, /^[A-Za-z0-9-]+$/);
    const alreadyPatchedDirectArgs = spawnCalls.at(-1)[1];
    childProcess.spawn("codex", alreadyPatchedDirectArgs);
    assert.equal(spawnCalls.at(-1)[1], alreadyPatchedDirectArgs);
    assert.equal(
      spawnCalls.at(-1)[2].env.CODEY_SUBAGENT_GATE_ACTIVE,
      "1",
    );
    assert.equal(
      spawnCalls.at(-1)[2].env.CODEY_SUBAGENT_GATE_RUNTIME_ID,
      subagentGateRuntimeId,
    );

    const wrappedAppServerArgs = [
      "/opt/codey/codex.js",
      "-c",
      'model_provider="stale_provider"',
      "--config",
      'model_providers.codey_global.base_url="https://stale.example/v1"',
      "app-server",
      "--analytics-default-enabled",
    ];
    childProcess.spawn(process.execPath, wrappedAppServerArgs);
    const patchedWrappedAppServerArgs = spawnCalls.at(-1)[1];
    assert.deepEqual(patchedWrappedAppServerArgs, [
      "/opt/codey/codex.js",
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...nativeRuntimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);
    assert.equal(
      patchedWrappedAppServerArgs.filter(
        (argument) => argument === 'model_provider="codey_global"',
      ).length,
      1,
    );
    assert.equal(
      patchedWrappedAppServerArgs.some((argument) =>
        String(argument).includes("stale_provider") ||
        String(argument).includes("stale.example")
      ),
      false,
    );
    assert.equal(
      spawnCalls.at(-1)[2].env.CODEY_SUBAGENT_GATE_ACTIVE,
      "1",
    );

    const configuredArgs = [
      "-c",
      "analytics.enabled=true",
      "app-server",
      "--analytics-default-enabled",
    ];
    childProcess.spawn("codex", configuredArgs);
    assert.deepEqual(spawnCalls.at(-1)[1], [
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...nativeRuntimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);

    const argsWithoutLegacyAnalyticsFlag = ["app-server"];
    childProcess.spawn("codex", argsWithoutLegacyAnalyticsFlag);
    assert.deepEqual(spawnCalls.at(-1)[1], [
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...nativeRuntimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);

    const shellCommand = [
      "source /etc/profile;",
      "exec /usr/bin/codex -c features.code_mode_host=true",
      "app-server --analytics-default-enabled",
      `-c '${desktopMcpConfig}'`,
    ].join(" ");
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      shellCommand,
    ]);
    const patchedShellCommand = spawnCalls.at(-1)[1].at(-1);
    assert.doesNotMatch(patchedShellCommand, /--analytics-default-enabled/);
    assert.match(
      patchedShellCommand,
      /CODEY_SUBAGENT_GATE_ACTIVE=1 exec \/usr\/bin\/codex/,
    );
    assert.match(
      patchedShellCommand,
      new RegExp(
        `CODEY_SUBAGENT_GATE_RUNTIME_ID='${subagentGateRuntimeId}' ` +
          "CODEY_SUBAGENT_GATE_ACTIVE=1",
      ),
    );
    assert.match(
      patchedShellCommand,
      /-c 'mcp_servers\.codey_fastctx\.command="\/mnt\/c\/Program Files\/Codey\/codey-fastctx\.exe"'/,
    );
    assert.ok(
      patchedShellCommand.indexOf("app-server") <
        patchedShellCommand.indexOf("mcp_servers.codey_fastctx.command="),
    );
    assert.ok(
      patchedShellCommand.indexOf("mcp_servers.codey_fastctx.command=") <
        patchedShellCommand.indexOf(desktopMcpConfig),
    );
    assert.match(
      patchedShellCommand,
      /-c 'agents\.default\.config_file="\/mnt\/d\/Codey\/runtime\/default\.toml"'/,
    );
    assert.match(
      patchedShellCommand,
      /-c 'hooks\.state\."\/mnt\/c\/Users\/Kim\/\.codex\/hooks\.json:pre_tool_use:1:0"\.trusted_hash="sha256:wsl"'/,
    );
    assert.doesNotMatch(patchedShellCommand, /sha256:test/);
    assert.match(
      patchedShellCommand,
      /\/mnt\/c\/Program Files\/Codey\/codey\.exe/,
    );
    assert.doesNotMatch(patchedShellCommand, /[A-Za-z]:\\\\/);
    const alreadyPatchedShellArgs = spawnCalls.at(-1)[1];
    childProcess.spawn("wsl.exe", alreadyPatchedShellArgs);
    assert.equal(spawnCalls.at(-1)[1], alreadyPatchedShellArgs);

    const configuredShellCommand = [
      "source /etc/profile;",
      "exec /usr/bin/codex --config=analytics.enabled=custom",
      "app-server --analytics-default-enabled",
    ].join(" ");
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      configuredShellCommand,
    ]);
    const patchedConfiguredShellCommand = spawnCalls.at(-1)[1].at(-1);
    assert.match(
      patchedConfiguredShellCommand,
      /CODEY_SUBAGENT_GATE_ACTIVE=1 exec \/usr\/bin\/codex/,
    );
    assert.match(
      patchedConfiguredShellCommand,
      /-c 'analytics\.enabled=false'/,
    );
    assert.equal(
      patchedConfiguredShellCommand.match(/analytics\.enabled=false/g)?.length,
      1,
    );

    const shellWithoutLegacyAnalyticsFlag =
      "source /etc/profile; exec /usr/bin/codex app-server";
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      shellWithoutLegacyAnalyticsFlag,
    ]);
    assert.match(
      spawnCalls.at(-1)[1].at(-1),
      /CODEY_SUBAGENT_GATE_ACTIVE=1 exec \/usr\/bin\/codex/,
    );
    assert.match(
      spawnCalls.at(-1)[1].at(-1),
      /-c 'analytics\.enabled=false'/,
    );

    const unrelatedArgs = ["--version"];
    childProcess.spawn("git", unrelatedArgs);
    assert.equal(spawnCalls.at(-1)[1], unrelatedArgs);

    const unrelatedShell = "echo 'app-server --analytics-default-enabled'";
    childProcess.spawn("bash", ["-lc", unrelatedShell]);
    assert.equal(spawnCalls.at(-1)[1].at(-1), unrelatedShell);

    const unrelatedWslShell =
      "source /etc/profile; exec /usr/bin/echo 'app-server --analytics-default-enabled'";
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      unrelatedWslShell,
    ]);
    assert.equal(spawnCalls.at(-1)[1].at(-1), unrelatedWslShell);

    const runtimeManagedAppServerArgs = ["app-server", "--analytics-default-enabled"];
    childProcess.spawn("node", runtimeManagedAppServerArgs);
    assert.deepEqual(spawnCalls.at(-1)[1], [
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...nativeRuntimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);

    const spawnOptions = { cwd: "/tmp" };
    childProcess.spawn("git", spawnOptions);
    assert.equal(spawnCalls.at(-1).length, 2);
    assert.equal(spawnCalls.at(-1)[1], spawnOptions);
    assert.equal(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.appServerAnalyticsPatchCount,
      8,
    );
    assert.equal(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.complete,
      true,
    );
    assert.equal(
      await globalThis.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__(),
      "codey-app-server-runtime-overrides-verified",
    );

    const desktopAnalyticsFixture = [
      "let u={},g={get(){return Promise.resolve({})}},",
      "d={analyticsEnabled:u!=null&&u.analytics?.enabled!==!1};",
      "p.postMessage({type:`worker-analytics-enabled-update`,",
      "enabled:e.analytics?.enabled!==!1});",
      "T=new Transport({analyticsEnabled:g.get().then(",
      "e=>e.analytics?.enabled!==!1)}),",
      "E=new Reporter({source:`codex-desktop`,transport:T});",
    ].join("");
    const patchedDesktopAnalytics =
      globalThis.__CODEY_PATCH_CODEX_MAIN_DESKTOP_ANALYTICS__(
        desktopAnalyticsFixture,
      );
    assert.equal(
      patchedDesktopAnalytics.match(/analyticsEnabled:!1/g)?.length,
      2,
    );
    assert.match(
      patchedDesktopAnalytics,
      /worker-analytics-enabled-update`,enabled:!1/,
    );
    assert.doesNotMatch(
      patchedDesktopAnalytics,
      /analytics\?\.enabled!==!1/,
    );

    const doubleQuotedDesktopAnalyticsFixture =
      desktopAnalyticsFixture.replaceAll("`", '"');
    const patchedDoubleQuotedDesktopAnalytics =
      globalThis.__CODEY_PATCH_CODEX_MAIN_DESKTOP_ANALYTICS__(
        doubleQuotedDesktopAnalyticsFixture,
      );
    assert.equal(
      patchedDoubleQuotedDesktopAnalytics.match(/analyticsEnabled:!1/g)?.length,
      2,
    );
    assert.match(
      patchedDoubleQuotedDesktopAnalytics,
      /worker-analytics-enabled-update",enabled:!1/,
    );
    assert.doesNotMatch(
      patchedDoubleQuotedDesktopAnalytics,
      /analytics\?\.enabled!==!1/,
    );

    const desktopAnalyticsWithoutReporterFixture =
      desktopAnalyticsFixture.replace(
        "E=new Reporter({source:`codex-desktop`,transport:T});",
        "",
      );
    const patchedDesktopAnalyticsWithoutReporter =
      globalThis.__CODEY_PATCH_CODEX_MAIN_DESKTOP_ANALYTICS__(
        desktopAnalyticsWithoutReporterFixture,
      );
    assert.equal(
      patchedDesktopAnalyticsWithoutReporter.match(/analyticsEnabled:!1/g)
        ?.length,
      2,
    );
    assert.doesNotMatch(
      patchedDesktopAnalyticsWithoutReporter,
      /analytics\?\.enabled!==!1/,
    );

    const incompatibleDesktopAnalyticsFixture =
      "const analyticsEnabledFromNewBundleShape = true;";
    const degradedDesktopAnalytics =
      globalThis.__CODEY_APPLY_OPTIONAL_MAIN_BUNDLE_PATCH__(
        "desktopCesAnalytics",
        globalThis.__CODEY_PATCH_CODEX_MAIN_DESKTOP_ANALYTICS__,
        incompatibleDesktopAnalyticsFixture,
      );
    assert.equal(
      degradedDesktopAnalytics,
      incompatibleDesktopAnalyticsFixture,
    );
    assert.equal(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.disableDesktopCesAnalytics,
      false,
    );
    assert.deepEqual(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.optionalMainBundlePatchFailures,
      [{
        name: "desktopCesAnalytics",
        message: "Codey desktop analytics matches 0/0/0",
      }],
    );

    globalThis.__CODEY_APPLY_OPTIONAL_MAIN_BUNDLE_PATCH__(
      "desktopCesAnalytics",
      globalThis.__CODEY_PATCH_CODEX_MAIN_DESKTOP_ANALYTICS__,
      desktopAnalyticsFixture,
    );
    assert.equal(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.disableDesktopCesAnalytics,
      true,
    );
    assert.deepEqual(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__.optionalMainBundlePatchFailures,
      [],
    );

    const fixture = [
      "let Oe={},",
      "ke=()=>{Oe.reconcileExternalPluginState(`focus`)};",
      "l.app.on(`browser-window-focus`,ke);",
      "P.add(()=>{l.app.off(`browser-window-focus`,ke)});",
    ].join("");
    const patchedFixture =
      globalThis.__CODEY_PATCH_CODEX_MAIN_FOCUS_RECONCILE__(fixture);
    assert.match(
      patchedFixture,
      /ke=globalThis\.__CODEY_THROTTLE_EXTERNAL_PLUGIN_FOCUS_RECONCILE__/,
    );
    assert.match(patchedFixture, /ke\.cancel\?\.\(\)/);

    const reconciles = [];
    const throttled =
      globalThis.__CODEY_THROTTLE_EXTERNAL_PLUGIN_FOCUS_RECONCILE__(
        (value) => reconciles.push(value),
        20,
      );
    throttled("leading");
    throttled("middle");
    throttled("trailing");
    assert.deepEqual(reconciles, ["leading"]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(reconciles, ["leading", "trailing"]);
    assert.equal(
      globalThis.__CODEY_CODEX_STARTUP_PATCH__
        .externalPluginFocusReconcileSuppressedCount,
      2,
    );

    const cancelledReconciles = [];
    const cancelled =
      globalThis.__CODEY_THROTTLE_EXTERNAL_PLUGIN_FOCUS_RECONCILE__(
        (value) => cancelledReconciles.push(value),
        20,
      );
    cancelled("leading");
    cancelled("trailing");
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(cancelledReconciles, ["leading"]);

    const heartbeatFixture = [
      "class Sampler{constructor(){",
      "this.appStateHeartbeat=setInterval(()=>{",
      "this.requestAppStateSnapshot(`heartbeat`)",
      "},gX),this.appStateHeartbeat.unref()",
      "}dispose(){clearInterval(this.appStateHeartbeat)}",
      "requestAppStateSnapshot(e){",
      "send({type:`electron-app-state-snapshot-request`,reason:e})",
      "}}",
    ].join("");
    const patchedHeartbeat =
      globalThis.__CODEY_PATCH_CODEX_MAIN_APP_STATE_HEARTBEAT__(
        heartbeatFixture,
      );
    assert.match(patchedHeartbeat, /this\.appStateHeartbeat=null/);
    assert.doesNotMatch(patchedHeartbeat, /appStateHeartbeat=setInterval/);
    assert.match(
      patchedHeartbeat,
      /requestAppStateSnapshot\(e\).*electron-app-state-snapshot-request/,
    );
  } finally {
    childProcess.spawn = originalSpawn;
    workerThreads.Worker = NativeWorker;
    Module.syncBuiltinESMExports?.();
    Module._load = originalLoad;
    Module._extensions[".js"] = originalJsExtension;
  }
});

test("startup patch fails closed when app-server runtime override injection is never observed", async () => {
  const runtimeConfigOverrides = [
    'model_catalog_json="/tmp/codey-catalog.json"',
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'features.multi_agent=true',
    'service_tier="flex"',
  ];
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides, {
    setTimeout(callback) {
      queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });

  try {
    assert.match(
      await loadPatchExpression(runtimeConfigOverrides, false, true),
      /appServerRuntimeOverrideTimeoutMs = 20_000/,
    );
    assert.equal(runtime.result, "codey-startup-patch-installed-v39");    assert.equal(
      runtime.context.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.observed,
      false,
    );
    await assert.rejects(
      runtime.context.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__(),
      (error) => {
        assert.match(
          error.message,
          /当前 Codex 版本的 app-server 启动参数结构与 Codey 不兼容/,
        );
        assert.match(error.message, /model_catalog_json/);
        assert.doesNotMatch(error.message, /codey_router/);
        return true;
      },
    );
  } finally {
    runtime.restore();
  }
});

test("startup patch keeps Codey MCP servers in the app-server config layer", async () => {
  const childProcess = process.getBuiltinModule("child_process");
  const runtimeConfigOverrides = [
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'mcp_servers.codey_fastctx.args=["--codey-fastctx-mcp"]',
    'mcp_servers.codey_subagent_control.command="/opt/codey"',
  ];
  const desktopMcpConfig =
    'mcp_servers.codex_app={ command = "/opt/codex-app-mcp", args = ["server.mjs"] }';
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides);

  try {
    childProcess.spawn("codex", [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "-c",
      desktopMcpConfig,
    ]);
    const rewritten = Array.from(runtime.spawnCalls.at(-1)[1]);
    const appServerIndex = rewritten.indexOf("app-server");
    const desktopMcpIndex = rewritten.indexOf(desktopMcpConfig);

    assert.ok(appServerIndex >= 0);
    assert.ok(desktopMcpIndex > appServerIndex);
    for (const config of runtimeConfigOverrides) {
      const configIndex = rewritten.indexOf(config);
      assert.ok(
        configIndex > appServerIndex,
        `${config} must follow app-server`,
      );
      assert.ok(
        configIndex > desktopMcpIndex,
        `${config} must follow Desktop's overrides in the same config layer`,
      );
    }
    assert.equal(
      runtime.context.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.complete,
      true,
    );
  } finally {
    runtime.restore();
  }
});

test("startup patch resolves app-server runtime override validation after the matching spawn", async () => {
  const childProcess = process.getBuiltinModule("child_process");
  const runtimeConfigOverrides = [
    'model_catalog_json="/tmp/codey-catalog.json"',
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'features.multi_agent=true',
  ];
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides);

  try {
    const pending =
      runtime.context.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__();
    childProcess.spawn("codex", ["app-server"]);
    assert.equal(
      await pending,
      "codey-app-server-runtime-overrides-verified",
    );
    assert.deepEqual(Array.from(runtime.spawnCalls.at(-1)[1]), [
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...runtimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);
    assert.equal(
      runtime.context.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.complete,
      true,
    );
  } finally {
    runtime.restore();
  }
});

test("startup patch tolerates duplicate Codex analytics flags while injecting runtime overrides", async () => {
  const childProcess = process.getBuiltinModule("child_process");
  const runtimeConfigOverrides = [
    'model_catalog_json="/tmp/codey-catalog.json"',
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'features.multi_agent=true',
  ];
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides);

  try {
    const pending =
      runtime.context.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__();
    childProcess.spawn("codex", [
      "app-server",
      "--analytics-default-enabled",
      "--analytics-default-enabled",
    ]);
    assert.equal(
      await pending,
      "codey-app-server-runtime-overrides-verified",
    );
    assert.deepEqual(Array.from(runtime.spawnCalls.at(-1)[1]), [
      "app-server",
      "-c",
      "analytics.enabled=false",
      ...runtimeConfigOverrides.flatMap((config) => ["-c", config]),
    ]);
    assert.equal(
      runtime.context.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.complete,
      true,
    );
  } finally {
    runtime.restore();
  }
});

test("startup patch tolerates duplicate analytics flags in WSL app-server commands", async () => {
  const childProcess = process.getBuiltinModule("child_process");
  const runtimeConfigOverrides = [
    'model_catalog_json="/tmp/codey-catalog.json"',
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'features.multi_agent=true',
  ];
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides);

  try {
    const pending =
      runtime.context.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__();
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      [
        "source /etc/profile;",
        "exec /usr/bin/codex app-server",
        "--analytics-default-enabled --analytics-default-enabled",
      ].join(" "),
    ]);
    assert.equal(
      await pending,
      "codey-app-server-runtime-overrides-verified",
    );
    const patchedCommand = runtime.spawnCalls.at(-1)[1].at(-1);
    assert.doesNotMatch(patchedCommand, /--analytics-default-enabled/);
    assert.match(patchedCommand, /-c 'analytics\.enabled=false'/);
    for (const config of runtimeConfigOverrides) {
      assert.ok(patchedCommand.includes(`-c '${config}'`), patchedCommand);
    }
  } finally {
    runtime.restore();
  }
});

test("startup patch validates runtime overrides injected into a WSL app-server command", async () => {
  const childProcess = process.getBuiltinModule("child_process");
  const runtimeConfigOverrides = [
    'model_catalog_json="/tmp/codey-catalog.json"',
    'mcp_servers.codey_fastctx.command="/opt/codey-fastctx"',
    'features.multi_agent=true',
  ];
  const desktopMcpConfig =
    'mcp_servers.codex_app={ command = "/opt/codex-app-mcp" }';
  const runtime = await loadPatchInIsolatedContext(runtimeConfigOverrides);

  try {
    const pending =
      runtime.context.__CODEY_AWAIT_CODEX_APP_SERVER_RUNTIME_OVERRIDES__();
    childProcess.spawn("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "/usr/bin/bash",
      "-lc",
      `source /etc/profile; exec /usr/bin/codex app-server -c '${desktopMcpConfig}'`,
    ]);
    assert.equal(
      await pending,
      "codey-app-server-runtime-overrides-verified",
    );
    const patchedCommand = runtime.spawnCalls.at(-1)[1].at(-1);
    assert.match(patchedCommand, /-c 'analytics\.enabled=false'/);
    const appServerIndex = patchedCommand.indexOf("app-server");
    const desktopMcpIndex = patchedCommand.indexOf(desktopMcpConfig);
    for (const config of runtimeConfigOverrides) {
      assert.ok(patchedCommand.includes(`-c '${config}'`), patchedCommand);
      assert.ok(patchedCommand.indexOf(config) > appServerIndex, patchedCommand);
      assert.ok(patchedCommand.indexOf(config) < desktopMcpIndex, patchedCommand);
    }
    assert.equal(
      runtime.context.__CODEY_CODEX_STARTUP_PATCH__.appServerRuntimeOverrides.mode,
      "wsl-shell",
    );
  } finally {
    runtime.restore();
  }
});
