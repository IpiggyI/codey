import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const paginationModule = new URL(
  "../src/modelPickerPagination.ts",
  import.meta.url,
);

test("model picker filters case-insensitively and pages bounded results", async () => {
  const {
    MODEL_PICKER_PAGE_SIZE,
    filterModelOptions,
    nextVisibleModelCount,
    visibleModelOptions,
  } = await loadTypeScriptModule(paginationModule);
  const models = Array.from({ length: 450 }, (_, index) =>
    index % 2 === 0 ? `Provider-${index}` : `Other-${index}`
  );

  assert.equal(MODEL_PICKER_PAGE_SIZE, 200);
  assert.equal(filterModelOptions(models, "  PROVIDER-2  ")[0], "Provider-2");
  assert.equal(filterModelOptions(models, "provider").length, 225);
  assert.equal(filterModelOptions(models, ""), models);

  const firstPage = visibleModelOptions(models, MODEL_PICKER_PAGE_SIZE);
  assert.equal(firstPage.length, 200);
  assert.equal(nextVisibleModelCount(firstPage.length, models.length), 400);
  assert.equal(nextVisibleModelCount(400, models.length), 450);
  assert.equal(nextVisibleModelCount(450, models.length), 450);

  const officialModels = Array.from({ length: 3 }, (_, index) => ({ slug: `gpt-${index}` }));
  assert.deepEqual(visibleModelOptions(officialModels, 2), officialModels.slice(0, 2));

  const cachedModels = ["Alpha", "Beta"];
  const originalToLowerCase = String.prototype.toLowerCase;
  let lowerCalls = 0;
  String.prototype.toLowerCase = function toLowerCase() {
    lowerCalls += 1;
    return originalToLowerCase.call(this);
  };
  try {
    assert.deepEqual(filterModelOptions(cachedModels, "alp"), ["Alpha"]);
    const afterFirstFilter = lowerCalls;
    assert.deepEqual(filterModelOptions(cachedModels, "bet"), ["Beta"]);
    assert.equal(lowerCalls, afterFirstFilter + 1);
    assert.deepEqual(filterModelOptions(["Gamma"], "alp"), []);
  } finally {
    String.prototype.toLowerCase = originalToLowerCase;
  }
});
