import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const [modelSection, app] = await Promise.all([
  readFile(new URL("src/ModelSection.tsx", root), "utf8"),
  readFile(new URL("src/App.tsx", root), "utf8"),
]);

test("console has no controls that write Codex provider or saved route config", () => {
  assert.doesNotMatch(modelSection, /新增线路/);
  assert.doesNotMatch(modelSection, /编辑线路/);
  assert.doesNotMatch(modelSection, /删除线路/);
  assert.doesNotMatch(modelSection, /保存线路/);
  assert.doesNotMatch(modelSection, /openNewRouteDialog/);
  assert.doesNotMatch(modelSection, /id="route-short-name-input"/);
  assert.doesNotMatch(modelSection, /id="route-key-input"/);
  assert.doesNotMatch(modelSection, /id="route-url-input"/);
  assert.doesNotMatch(modelSection, /aria-label="WebSocket"/);
  assert.doesNotMatch(modelSection, /aria-labelledby="route-protocol-label"/);
  assert.doesNotMatch(modelSection, /onSaveRoute/);
  assert.doesNotMatch(modelSection, /onDeleteRoute/);
  assert.doesNotMatch(app, /onSaveRoute=\{handleSaveRoute\}/);
  assert.doesNotMatch(app, /onDeleteRoute=\{handleDeleteRoute\}/);
  assert.doesNotMatch(app, /action: "delete-route"/);
});

test("current provider is shown read-only with id, address, wire format and auth", () => {
  assert.match(modelSection, /aria-label="当前 Codex provider"/);
  assert.match(modelSection, /当前 Codex provider/);
  assert.match(modelSection, /\{currentProviderSnapshot\.id\}/);
  assert.match(modelSection, /\{currentProviderSnapshot\.baseUrl \|\| "（默认）"\}/);
  assert.match(modelSection, /\{currentProviderSnapshot\.wireApi\}/);
  assert.match(
    modelSection,
    /\{currentProviderSnapshot\.usesOfficialAccountAuth \? "是" : "否"\}/,
  );
  assert.match(modelSection, /只读来自你的 Codex 配置，Codey 不会改写它/);
});

test("saved profiles from other devices only appear when they match the current provider fingerprint", () => {
  assert.doesNotMatch(modelSection, /供应商线路/);
  assert.doesNotMatch(modelSection, /aria-label="线路列表"/);
  assert.doesNotMatch(modelSection, /className="route-list-pane"/);
  assert.match(
    modelSection,
    /modelListKey\(profile, currentProviderSnapshot\) === currentProviderSnapshot\.ownershipKey/,
  );
});
