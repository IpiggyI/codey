import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const shortNames = await loadTypeScriptModule(
  new URL("../src/routeShortNames.ts", import.meta.url),
);

test("third-party route short names are required and limited to two characters", () => {
  assert.equal(shortNames.validateThirdPartyRouteShortName(""), "请输入短名称");
  assert.equal(shortNames.validateThirdPartyRouteShortName("中转"), "");
  assert.equal(
    shortNames.validateThirdPartyRouteShortName("中转线"),
    "短名称最多 2 个字符",
  );
  assert.equal(
    shortNames.validateThirdPartyRouteShortName("官"),
    "“官”仅供官方账号使用",
  );
  assert.equal(
    shortNames.validateThirdPartyRouteShortName(
      "中转",
      [{ id: "existing", authMode: "apiKey", officialAccount: false, shortName: "中转" }],
      "draft",
    ),
    "短名称“中转”已被其他线路使用",
  );
});

test("model labels use the fixed official prefix or a route short name", () => {
  const official = {
    authMode: "officialAccount",
    officialAccount: true,
    name: "OpenAI 官方直登",
    shortName: "ignored",
  };
  const relay = {
    authMode: "apiKey",
    officialAccount: false,
    name: "备用中转线路",
    shortName: "备",
  };

  assert.equal(shortNames.prefixedRouteModelName(official, "gpt-5.6-sol"), "[官] gpt-5.6-sol");
  assert.equal(shortNames.prefixedRouteModelName(relay, "claude-opus"), "[备] claude-opus");
  assert.equal(shortNames.fallbackRouteShortName(" 备用中转 "), "备用");
});
