import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("subagent settings expose the three supported role controls", async () => {
  const [featurePolicySource, modelHookSource, modelOptionsSource, comboboxSource, modelWhitelistSource] = await Promise.all([
    readFile(new URL("src/FeaturePolicyCard.tsx", root), "utf8"),
    readFile(new URL("src/useModelSelection.ts", root), "utf8"),
    readFile(new URL("src/subagentModels.ts", root), "utf8"),
    readFile(new URL("src/components/ModelCombobox.tsx", root), "utf8"),
    readFile(new URL("public/model-whitelist-inject.js", root), "utf8"),
  ]);

  assert.match(featurePolicySource, /checked=\{config\.subagentOptimization\}/);
  assert.match(
    featurePolicySource,
    /onCheckedChange=\{\(checked\) =>\s*onSubagentOptimizationChange\(checked\)\s*\}/,
  );
  for (const [id, name] of [
    ["codey_explorer", "检索"],
    ["codey_reviewer", "复核"],
    ["codey_worker", "开发"],
  ]) {
    assert.match(featurePolicySource, new RegExp(`id: "${id}"`));
    assert.match(featurePolicySource, new RegExp(`name: "${name}"`));
  }
  assert.equal(featurePolicySource.match(/^\s+id: "codey_\w+",$/gm)?.length, 3, "只有三个角色");
  assert.doesNotMatch(featurePolicySource, /codey_(quick_scan|deep_research|visual_analysis|visual_worker)/);
  assert.match(featurePolicySource, /config\.subagentRoles\[task\.id\]/);
  assert.match(featurePolicySource, /checked=\{selection\.enabled\}/);
  assert.match(featurePolicySource, /onCheckedChange=\{\(enabled\) => updateRole\(\{ enabled \}\)\}/);
  assert.match(featurePolicySource, /各角色工具权限一致/);
  assert.match(featurePolicySource, /仅由提示词引导，不强制约束/);
  assert.match(featurePolicySource, /实际操作仍受 Codex 原生权限约束/);
  assert.doesNotMatch(featurePolicySource, /"可写"|"只读"|默认只读|默认可写|WRITABLE_SUBAGENT_ROLE_IDS|enabledReadOnlyRoleNames|请先启用至少一个只读角色/);
  assert.match(featurePolicySource, /roleDisabled/);
  assert.doesNotMatch(featurePolicySource, /关闭全部可写角色/);
  assert.doesNotMatch(featurePolicySource, /disableWritableRoles/);
  assert.match(featurePolicySource, /<ModelCombobox/);
  assert.match(featurePolicySource, /showLaneIdentity=\{false\}/);
  assert.match(featurePolicySource, /待重选/);
  assert.match(featurePolicySource, /当前 provider 清单/);
  assert.match(featurePolicySource, /resolveCurrentProviderModelOption/);
  assert.doesNotMatch(featurePolicySource, /所有线路均暂无模型/);
  assert.match(featurePolicySource, /from "\.\/components\/ui"/);
  assert.match(featurePolicySource, /import \{ Card, Table \} from "@heroui\/react"/);
  assert.doesNotMatch(featurePolicySource, /from "\.\/components\/mantine"/);
  assert.doesNotMatch(featurePolicySource, /from "\.\/mantine"/);
  assert.doesNotMatch(featurePolicySource, /@mantine\/core/);
  assert.match(
    modelHookSource,
    /buildCurrentProviderSubagentModelOptions\(\s*config,\s*modelState,\s*officialAccountAvailable,\s*currentProviderSnapshot/,
  );
  assert.doesNotMatch(
    modelHookSource,
    /buildSubagentModelOptions\(\s*config,\s*modelState,\s*officialAccountAvailable/,
  );
  assert.match(modelOptionsSource, /export function buildCurrentProviderSubagentModelOptions/);
  assert.match(modelOptionsSource, /value: modelId/);
  assert.doesNotMatch(modelOptionsSource, /for \(const profile of config\.profiles\)/);
  assert.doesNotMatch(modelOptionsSource, /routeModelAlias/);
  assert.doesNotMatch(modelOptionsSource, /routeDisplayPrefix/);
  assert.match(modelOptionsSource, /const usesOfficialMetadata = official/);
  assert.match(
    modelOptionsSource,
    /THIRD_PARTY_REASONING_EFFORTS\s*=\s*\["low",\s*"medium",\s*"high",\s*"xhigh"\]/,
  );
  assert.match(
    modelOptionsSource,
    /THIRD_PARTY_REASONING_EFFORT_ALLOWLIST\s*=\s*\[\s*"low",\s*"medium",\s*"high",\s*"xhigh",\s*"max",\s*"ultra"/,
  );
  assert.match(modelOptionsSource, /modelState\.thirdPartyModelMetadata/);
  assert.match(modelOptionsSource, /resolveSubagentModelOption/);
  assert.match(modelOptionsSource, /resolveCurrentProviderModelOption/);
  assert.match(comboboxSource, /from "@heroui\/react"/);
  assert.match(comboboxSource, /<ComboBox/);
  assert.match(comboboxSource, /搜索模型/);
  assert.doesNotMatch(comboboxSource, /搜索模型或线路/);
  assert.match(comboboxSource, /待重选/);
  assert.match(comboboxSource, /<ListBox\.Section/);
  assert.doesNotMatch(comboboxSource, /from "\.\/mantine"/);
  assert.match(modelWhitelistSource, /replaceNativeModelDisplayText/);
  assert.match(modelWhitelistSource, /modelPresentation\(modelName\)\.displayName/);
  assert.match(modelWhitelistSource, /scheduleNativeModelDisplayText/);
});
