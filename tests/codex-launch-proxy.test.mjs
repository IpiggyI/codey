import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const root = new URL("../", import.meta.url);

test("codex launch proxy validator matches the launch-time constraints", async () => {
  const { validateCodexLaunchProxy } = await loadTypeScriptModule(
    new URL("../src/urlValidation.ts", import.meta.url),
  );

  for (const accepted of [
    "",
    "  ",
    "http://127.0.0.1:7890",
    "https://proxy.example.com:8443",
    "https://proxy.example.com",
    "socks5://127.0.0.1:1080",
    "socks5h://proxy.example.com:1080",
    "http://[::1]:7890",
    // 凭据交给本地认证中继，不交给 Chromium 命令行。
    "http://user:pass@proxy.example.com:8080",
    "socks5://user@127.0.0.1:1080",
    // 百分号解码按原始字节计数：86 个 %FF 是 86 字节，不要求是合法 UTF-8。
    `socks5://${"%FF".repeat(86)}@127.0.0.1:1080`,
    `socks5://${"%ff".repeat(255)}@127.0.0.1:1080`,
  ]) {
    assert.equal(validateCodexLaunchProxy(accepted), "", accepted);
  }

  for (const rejected of [
    // 只允许协议、地址、端口和认证信息。
    "http://127.0.0.1:7890/v1",
    "socks5://127.0.0.1:1080/v1",
    "http://127.0.0.1:7890?x=1",
    "http://127.0.0.1:7890#frag",
    // 空的 ? 或 # 也算存在查询或片段，后端同样拒绝。
    "http://proxy.example:7890?",
    "http://proxy.example:7890#",
    "socks5://127.0.0.1:1080?",
    "socks5://127.0.0.1:1080#",
    // SOCKS 必须显式端口。
    "socks5://127.0.0.1",
    "socks5h://proxy.example.com",
    "socks5://user:pass@proxy.example.com",
    // RFC 1929 的用户名和密码各限 255 字节。
    `socks5://${"u".repeat(256)}@127.0.0.1:1080`,
    `socks5h://user:${"p".repeat(256)}@127.0.0.1:1080`,
    `socks5://${"%FF".repeat(256)}@127.0.0.1:1080`,
    `socks5://user:${"%41".repeat(256)}@127.0.0.1:1080`,
    // 未指定地址与链路本地地址，后端同样拒绝。
    "http://0.0.0.0:7890",
    "socks5://0.0.0.0:1080",
    "http://169.254.1.1:7890",
    "http://[::]:7890",
    "http://[fe80::1]:7890",
    // 协议与格式。
    "ftp://proxy.example.com:21",
    "127.0.0.1:7890",
    "not a url",
  ]) {
    assert.notEqual(validateCodexLaunchProxy(rejected), "", rejected);
  }
});

test("socks launch proxy without a port reports the port error", async () => {
  const { validateCodexLaunchProxy } = await loadTypeScriptModule(
    new URL("../src/urlValidation.ts", import.meta.url),
  );

  for (const portless of ["socks5://127.0.0.1", "socks5h://proxy.example.com"]) {
    assert.equal(
      validateCodexLaunchProxy(portless),
      "Codex 启动代理的 SOCKS 地址必须带端口",
      portless,
    );
  }
  assert.equal(validateCodexLaunchProxy("socks5://127.0.0.1:1080"), "");
});

test("launch proxy credentials are detected only on valid addresses", async () => {
  const { codexLaunchProxyHasCredentials } = await loadTypeScriptModule(
    new URL("../src/urlValidation.ts", import.meta.url),
  );

  for (const credentialed of [
    "http://user:pass@proxy.example.com:8080",
    "socks5://user@127.0.0.1:1080",
  ]) {
    assert.equal(codexLaunchProxyHasCredentials(credentialed), true, credentialed);
  }
  for (const plain of ["", "http://127.0.0.1:7890", "socks5://127.0.0.1:1080", "socks5://u:p@host"]) {
    assert.equal(codexLaunchProxyHasCredentials(plain), false, plain);
  }
});

test("launch proxy input lives in the Codex feature policy card", async () => {
  const [cardSource, typesSource, mockSource] = await Promise.all([
    readFile(new URL("src/FeaturePolicyCard.tsx", root), "utf8"),
    readFile(new URL("src/App.types.ts", root), "utf8"),
    readFile(new URL("src/dev/mockApi.ts", root), "utf8"),
  ]);

  assert.match(typesSource, /codexLaunchProxy: string/);
  assert.match(mockSource, /codexLaunchProxy: ""/);
  // 启动代理是与「Codex 功能策略」平级的独立区块，排在它前面。
  assert.match(
    cardSource,
    /secondary-section launch-proxy-section" aria-labelledby="launch-proxy-title"[\s\S]*?Codex 启动代理[\s\S]*?aria-labelledby="runtime-title"/,
  );
  assert.match(cardSource, /codexLaunchProxy: event\.target\.value/);
  assert.match(cardSource, /aria-invalid=\{Boolean\(launchProxyError\)\}/);
  assert.match(cardSource, /validateCodexLaunchProxy\(launchProxy\)/);
  assert.match(cardSource, /重启 Codex 后生效/);
  // 留空表示 Codey 不修改代理设置，不代表 Codex 不走代理。
  assert.match(cardSource, /placeholder="留空时 Codey 不修改代理设置，例如 http:\/\/127\.0\.0\.1:7890"/);
  assert.doesNotMatch(cardSource, /留空不走代理/);
  // 校验错误通过 aria-describedby 关联到输入框。
  assert.match(
    cardSource,
    /aria-describedby=\{[\s\S]*?"codex-launch-proxy-error"[\s\S]*?\}[\s\S]*?id="codex-launch-proxy-error"/,
  );
  // 带凭据代理的安全影响写在说明里：其他本机进程可免凭据使用。
  assert.match(cardSource, /本机其他进程也能通过它免凭据使用这个代理/);
});

test("launch proxy reaches Chromium arguments, spawn environment and restart detection", async () => {
  const [configSource, commandsSource, processSource, proxySource] =
    await Promise.all([
      readFile(new URL("backend/src/config.rs", root), "utf8"),
      readFile(new URL("backend/src/commands.rs", root), "utf8"),
      readFile(new URL("backend/src/launcher/process.rs", root), "utf8"),
      readFile(new URL("backend/src/launch_proxy.rs", root), "utf8"),
    ]);

  assert.match(configSource, /pub codex_launch_proxy: String/);
  assert.match(configSource, /fn validate_codex_launch_proxy/);
  assert.match(commandsSource, /validate_codex_launch_proxy\(codex_launch_proxy\)/);
  assert.match(
    commandsSource,
    /applied\.codex_launch_proxy != current\.codex_launch_proxy/,
  );
  assert.match(processSource, /proxy\.chromium_argument\(\)/);
  assert.match(proxySource, /--proxy-server=/);
  assert.match(proxySource, /"socks5"[\s\S]{0,40}else/);
  assert.match(proxySource, /"HTTP_PROXY"/);
  assert.match(proxySource, /"NO_PROXY"/);
  assert.match(
    processSource,
    /launch_proxy_environment[\s\S]*launch_environment.extend/,
  );
  assert.match(
    processSource,
    /spawn_command\(command, launch_proxy_environment\.as_deref\(\)\.unwrap_or\(&\[\]\)\)/,
  );
});

test("credentialed launch proxy goes through the local auth relay", async () => {
  const [proxySource, relaySource, launcherSource] = await Promise.all([
    readFile(new URL("backend/src/launch_proxy.rs", root), "utf8"),
    readFile(new URL("backend/src/launch_proxy_relay.rs", root), "utf8"),
    readFile(new URL("backend/src/launcher.rs", root), "utf8"),
  ]);

  // 带凭据的上游解析为中继计划，启动时落成回环地址，客户端与子进程都
  // 拿不到凭据。
  assert.match(proxySource, /LaunchProxyPlan::Relayed/);
  assert.match(proxySource, /fn relayed\(port: u16\)/);
  assert.match(proxySource, /http:\/\/127\.0\.0\.1:\{port\}/);
  assert.match(launcherSource, /plan\.start\(\)\.await/);
  // 中继向上游注入认证：http(s) 走 Proxy-Authorization，socks5 走 RFC 1929。
  assert.match(relaySource, /Proxy-Authorization/);
  assert.match(relaySource, /0x02|method.*auth|socks5_negotiate/);
  assert.match(relaySource, /pub\(crate\) async fn ensure_running/);
});
