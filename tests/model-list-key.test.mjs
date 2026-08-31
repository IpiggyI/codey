import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/modelRoutes.ts", import.meta.url), "utf8");
const start = source.indexOf("export function routeProviderId");
const end = source.indexOf("function encodeRouteComponent");
assert.ok(start >= 0 && end > start, "modelRoutes.ts must export modelListKey before encodeRouteComponent");
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

test("same provider id with a different address keeps the old map key", () => {
  const profile = {
    id: "route-relay",
    sourceProviderId: "relay",
    baseUrl: "https://other.example/v1",
    authMode: "apiKey",
    officialAccount: false,
  };
  assert.equal(routes.modelListKey(profile, snapshot), "relay");
});

test("matching provider id and address uses the fingerprint ownership key", () => {
  const profile = {
    id: "route-relay",
    sourceProviderId: "relay",
    baseUrl: "https://relay.example/v1/",
    authMode: "apiKey",
    officialAccount: false,
  };
  assert.equal(routes.modelListKey(profile, snapshot), "relay#889271d70d18");
});
