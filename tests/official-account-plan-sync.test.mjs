import assert from "node:assert/strict";
import test from "node:test";

import { autoStubModule, createModuleGraph } from "./helpers/jsx-tree.mjs";

const { formatPlan, isProPlan, planTagClass } = createModuleGraph(
  new URL("../src/OfficialAccountsPanel.tsx", import.meta.url),
  { stubs: { "./components/ui": autoStubModule("ui"), "./api": { invoke: async () => ({}) } } },
).exports;

test("官方 Pro 套餐与明确数字别名显示对应档位与分档徽标", () => {
  for (const [value, expected, tier] of [
    ["prolite", "Pro 100", "100"], ["pro", "Pro 200", "200"], ["promax", "Pro 500", "500"],
    [" PROLITE ", "Pro 100", "100"], [" Pro ", "Pro 200", "200"], [" PROMAX ", "Pro 500", "500"],
    ["pro100", "Pro 100", "100"], ["pro200", "Pro 200", "200"], ["pro500", "Pro 500", "500"],
    [" Pro $100 ", "Pro 100", "100"], ["pro_200", "Pro 200", "200"], ["PRO-500", "Pro 500", "500"],
    // Pro 5x 与 Pro 20x 分别对应 100 与 200 档的徽标。
    ["5x", "Pro 5x", "100"], ["pro5x", "Pro 5x", "100"], ["Pro 5x", "Pro 5x", "100"],
    ["pro20x", "Pro 20x", "200"], ["PRO_20X", "Pro 20x", "200"],
  ]) {
    assert.equal(formatPlan(value), expected, value);
    assert.equal(isProPlan(value), true, value);
    assert.equal(planTagClass(value), `official-account-plan-badge is-pro is-pro-${tier}`, value);
  }
});

test("其它套餐保持原有名称与徽标，未知值不会被推断成 Pro 档位", () => {
  for (const [value, expected, tone] of [
    ["free", "Free", "default"], [" PLUS ", "Plus", "plus"],
    ["team", "Team", "team"], ["business", "Business", "team"],
    ["enterprise", "Enterprise", "team"], ["edu", "Edu", "default"],
    [undefined, "", "default"], ["", "", "default"], ["  ", "", "default"],
    ["business_prolite", "business_prolite", "default"],
    ["pro500_extra", "pro500_extra", "default"], ["pro50", "pro50", "default"],
    ["pro10x", "pro10x", "default"],
    [" FuturePlan ", "FuturePlan", "default"],
    ["constructor", "constructor", "default"], ["__proto__", "__proto__", "default"],
  ]) {
    assert.equal(formatPlan(value), expected, value);
    assert.equal(isProPlan(value), false, value);
    assert.equal(planTagClass(value), `official-account-plan-badge is-${tone}`, value);
  }
});
