import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [modelSectionSource, typeSource] = await Promise.all([
  readFile(new URL("../src/ModelSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.types.ts", import.meta.url), "utf8"),
]);

test("settings no longer expose a per-route native Web Search switch", () => {
  assert.doesNotMatch(typeSource, /supportsNativeWebSearch/);
  assert.doesNotMatch(modelSectionSource, /supportsNativeWebSearch/);
  assert.doesNotMatch(modelSectionSource, /原生网页搜索/);
});
