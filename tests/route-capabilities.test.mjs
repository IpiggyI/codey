import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleUrl(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  for (const dependency of [...code.matchAll(/from "\.\/(\w+)"/g)]) {
    code = code.replace(dependency[0], `from "${await moduleUrl(dependency[1])}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

test("current-provider subagent options come from the snapshot ownership key", async () => {
  const { buildCurrentProviderSubagentModelOptions } = await import(await moduleUrl("subagentModels"));
  const config = {
    selectedModelsByProvider: { "provider-a": ["model"], "provider-b": ["other"] },
    declaredOfficialModelsByProvider: {},
  };
  const options = buildCurrentProviderSubagentModelOptions(
    config,
    { officialModels: [], officialModelIds: [] },
    true,
    {
      id: "provider-a",
      ownershipKey: "provider-a",
      usesOfficialAccountAuth: false,
    },
  );
  assert.deepEqual(options.map((option) => option.value), ["model"]);
});

test("preview configuration persists and prunes model context declarations", async () => {
  const [mockSource, selectionSource, appSource] = await Promise.all([
    readFile(new URL("../src/dev/mockApi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/useModelSelection.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(mockSource, /supports1MContextByProvider: \{\}/);
  assert.match(mockSource, /modelContextByProvider: \{\}/);
  assert.match(appSource, /supports1MContextModels/);
  assert.match(
    selectionSource,
    /modelContexts: Object\.fromEntries\(Object\.entries\(draftModelContexts\)\.filter/,
  );
});
