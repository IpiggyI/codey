import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

// Node's test runner has no CSSStyleSheet. Record replaceSync input so this
// file can lock the :root → :host rewrite without a CSSOM.
class RecordingStyleSheet {
  constructor() {
    this.cssRules = [];
  }

  replaceSync(css) {
    this.replacedCss = String(css);
  }

  insertRule(rule, index = this.cssRules.length) {
    this.cssRules.splice(index, 0, { cssText: String(rule) });
    return index;
  }
}

test("shadowStyleSheet rewrites :root to :host in every stylesheet argument", async () => {
  const previousStyleSheet = globalThis.CSSStyleSheet;
  globalThis.CSSStyleSheet = RecordingStyleSheet;

  try {
    const { shadowStyleSheet } = await loadTypeScriptModule(
      new URL("../src/shadowStyles.ts", import.meta.url),
    );
    const utilityCss = ":root { --tw-token: 1px; }";
    const mantineCss = ":root { --mantine-color-body: #fff; }";
    const forkCss = ":root { --mac-blue: #007aff; }";
    const sheet = shadowStyleSheet(utilityCss, mantineCss, forkCss);
    const scoped = sheet.replacedCss;

    assert.doesNotMatch(scoped, /:root\b/);
    assert.match(scoped, /:host\s*\{\s*--tw-token:\s*1px;/);
    assert.match(scoped, /:host\s*\{\s*--mantine-color-body:\s*#fff;/);
    assert.match(scoped, /:host\s*\{\s*--mac-blue:\s*#007aff;/);
  } finally {
    if (previousStyleSheet === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = previousStyleSheet;
  }
});
