import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { serviceTierEnvironment } from "./helpers/service-tier-environment.mjs";

const { chromium } = await import(process.env.CODEY_PLAYWRIGHT_MODULE || "playwright");
const native = await readFile(new URL("./fixtures/codex-service-tier.js", import.meta.url), "utf8");
const keys = Object.keys(serviceTierEnvironment());
const moduleSource = `const {${keys.join(",")}}=window.nativeTierEnvironment;
  ${native}\nconst mke=yjt,KGe=vjt;export {Mq as read,whi as select};`;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const moduleUrl = `/app-initial-fixture.js${url.pathname === "/incompatible" ? "?incompatible" : ""}`;
  response.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/html");
  response.end(url.pathname.endsWith(".js")
    ? (url.search ? moduleSource.replaceAll("serviceTierForRequest:", "unknown:") : moduleSource)
    : `<link rel="modulepreload" href="${moduleUrl}"><body><div id="root"></div><script>
      window.nativeTierEnvironment=(${serviceTierEnvironment.toString()})();
      document.querySelector('#root').__reactFiber$fixture={memoizedState:window.nativeTierEnvironment.scope};
      </script><script type="module">window.nativeTier=await import('${moduleUrl}');
      performance.clearResourceTimings();window.ready=true;</script>`);
});
let userData, context;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  userData = await mkdtemp(join(tmpdir(), "codey-service-tier-"));
  context = await chromium.launchPersistentContext(userData, { headless: true,
    executablePath: process.env.CODEY_CHROMIUM_EXECUTABLE,
    args: ["--remote-debugging-port=0"] });
  const page = context.pages()[0];
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => window.ready);
  const port = (await readFile(join(userData, "DevToolsActivePort"), "utf8")).split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((target) => target.type === "page" && target.url.startsWith(url));
  const child = spawn("cargo", ["test", "-p", "codey", "--lib",
    "cdp::service_tier::tests::browser_install", "--", "--ignored", "--exact"], {
    stdio: "inherit", env: { ...process.env, CODEY_TIER_TEST_WS: target.webSocketDebuggerUrl,
      CODEY_TIER_TEST_URL: url, CODEY_APP_STATE_DIR: join(userData, "codey-state") },
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, "production Rust installer must pass in the isolated browser");
} finally {
  try { await context?.close(); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    if (userData) await rm(userData, { recursive: true, force: true });
  }
}
