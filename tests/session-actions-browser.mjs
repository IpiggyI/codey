import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const { chromium } = await import(process.env.CODEY_PLAYWRIGHT_MODULE || "playwright");
const bundle = await build({
  configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  build: { write: false, minify: false, lib: {
    entry: fileURLToPath(new URL("./fixtures/sidebar-actions.jsx", import.meta.url)),
    name: "SidebarFixture", formats: ["iife"],
  } },
});
const source = await readFile(process.env.CODEY_SESSION_TOOLS_SCRIPT
  || new URL("../public/codey-inject.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEY_CHROMIUM_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<style>
    body { margin: 24px; }
    .native-row { position: relative; width: 260px; height: 36px; }
    .native-actions { display: flex; align-items: center; gap: 8px; width: 52px; height: 100%; position: absolute; right: 0; top: 0; opacity: 0; }
    .native-row:hover .native-actions, .native-row:has(:focus-visible) .native-actions { opacity: 1; }
    .native-action { width: 24px; height: 24px; border: 0; padding: 0; }
    .native-inner { display: flex; align-items: center; justify-content: center; }
    .native-inner svg { width: 14px; height: 14px; }
    .contents { display: contents; }
  </style><div id="root"></div>`);
  await page.addScriptTag({ content: [bundle].flat()[0].output.find((output) => output.type === "chunk").code });
  const ancestryDepth = await page.locator('[aria-haspopup="menu"]').evaluate((menu) => {
    let fiber = menu[Object.keys(menu).find((key) => key.startsWith("__reactFiber"))];
    let depth = 0;
    for (; fiber; fiber = fiber.return) depth += 1;
    return depth;
  });
  assert.equal(ancestryDepth, 312, "match the installed Codex menu ancestry");
  await page.addScriptTag({ content: source });
  assert.deepEqual(errors, [], "fixture and injection must load without errors");
  const row = page.locator("[data-app-action-sidebar-thread-row]");
  const archive = page.locator("[data-codey-session-archive]");
  await archive.waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".native-actions").evaluate((node) => getComputedStyle(node).opacity), "0");
  await row.hover();
  const labels = await row.locator("button").evaluateAll((buttons) => buttons.filter((button) => {
    const rect = button.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === button;
  }).map((button) => button.getAttribute("aria-label")));
  assert.deepEqual(labels, ["置顶聊天", "导出会话数据", "归档会话", "删除会话"]);
  const rects = await row.locator("button:not([aria-haspopup=menu])").evaluateAll((buttons) => buttons.map((b) => {
    const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height };
  }));
  for (let i = 1; i < rects.length; i += 1) {
    assert.ok(rects[i].left >= rects[i - 1].right, "actions must not overlap");
    assert.equal(rects[i].top, rects[0].top);
    assert.equal(rects[i].height, 24);
  }
  await row.getByRole("button", { name: "置顶聊天" }).click();
  await archive.click();
  await page.getByRole("dialog", { name: "原生归档确认" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.actionEvents), ["pin:thread-1"]);
  await page.getByRole("button", { name: "确认归档" }).click();
  assert.deepEqual(await page.evaluate(() => window.actionEvents), ["pin:thread-1", "archive:thread-1"]);

  // React reuses this row; clicks must target the new conversation and callback.
  await page.evaluate(() => window.renderThread({ mode: "work", id: "thread-2", running: false }));
  await archive.click();
  assert.equal(await page.evaluate(() => window.actionEvents.at(-1)), "archive:thread-2");
  await row.getByRole("button", { name: "导出会话数据" }).click();
  await page.waitForFunction(() => window.bridgeEvents.some(({ path }) => path === "/session/export/finish"));
  assert.equal(await page.evaluate(() => window.bridgeEvents.find(({ path }) => path === "/session/export/start").payload.sessionId), "thread-2");
  await row.getByRole("button", { name: "删除会话", exact: true }).click();
  await page.locator("#codey-session-delete-popover").waitFor();
  assert.equal(await page.evaluate(() => window.bridgeEvents.some(({ path }) => path === "/session/delete")), false);
  await page.keyboard.press("Escape");

  await row.click({ button: "right", position: { x: 20, y: 15 } });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  assert.equal(await page.evaluate(() => window.actionEvents.at(-1)), "rename:thread-2");
  await row.focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "聊天操作");
  assert.equal(await page.locator("[data-codey-session-menu]").evaluate((node) => getComputedStyle(node).clipPath), "none");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.mouse.move(650, 550);
  await archive.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.actionEvents.at(-1)), "archive:thread-2");

  for (const mode of ["codex", "work", "codex", "work"]) {
    await page.evaluate((mode) => {
      window.renderThread({ mode, id: "thread-2", running: false });
    }, mode);
    await page.waitForFunction((mode) => document.querySelectorAll("[data-codey-session-archive]").length === (mode === "work" ? 1 : 0), mode);
    await page.evaluate(() => { window.__codeyInstallSessionActions(); window.__codeyInstallSessionActions(); });
    assert.equal(await row.locator("[data-codey-session-export]").count(), 1);
    assert.equal(await row.locator("[data-codey-session-delete]").count(), 1);
    assert.equal(await row.locator("[data-codey-session-archive]").count(), mode === "work" ? 1 : 0);
  }
  await page.evaluate(() => {
    window.renderThread({ mode: "work", id: "thread-3", loading: true });
  });
  await archive.waitFor({ state: "detached" });
  assert.equal(await archive.count(), 0);
  assert.equal(await row.locator("[data-codey-session-menu]").count(), 0);
  await page.evaluate(() => window.renderThread({ mode: "work", id: "thread-3", loading: false }));
  await archive.waitFor();
  await page.evaluate(() => window.__codeySessionToolsInstall.dispose());
  assert.equal(await archive.count(), 0);
  assert.equal(await row.locator("[data-codey-session-menu]").count(), 0);
  await page.addScriptTag({ content: source });
  await archive.waitFor();
  assert.deepEqual(errors, []);
  console.log("Work/Codex hover layout, native confirmation, current React callbacks, export identity, delete confirmation, menu access and rerender checks passed");
} finally {
  await browser.close();
}
