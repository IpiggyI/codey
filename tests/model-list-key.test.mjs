import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/modelRoutes.ts", import.meta.url), "utf8");
const start = source.indexOf("export function modelListKey");
const end = source.indexOf("export function stripRouteAlias");
assert.ok(start >= 0 && end > start, "modelRoutes.ts must export modelListKey before stripRouteAlias");
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const routes = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const snapshot = {
  id: "relay",
  baseUrl: "https://relay.example/v1",
  wireApi: "responses",
  usesOfficialAccountAuth: false,
  ownershipKey: "relay#889271d70d18",
};

test("model list key is the current provider ownership key", () => {
  assert.equal(routes.modelListKey(snapshot), "relay#889271d70d18");
});

test("a different address still uses that snapshot's ownership key", () => {
  assert.equal(
    routes.modelListKey({
      ...snapshot,
      baseUrl: "https://other.example/v1",
      ownershipKey: "relay#a3d9c9d847e2",
    }),
    "relay#a3d9c9d847e2",
  );
});
