import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("console and overlay no longer host the in-process request log viewer", async () => {
  const [app, modelSection, types, overlay] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/ModelSection.tsx", root), "utf8"),
    readFile(new URL("src/App.types.ts", root), "utf8"),
    readFile(new URL("src/overlay.tsx", root), "utf8"),
  ]);

  assert.doesNotMatch(types, /RouteRequestLogConfig/);
  assert.doesNotMatch(app, /routeRequestLog/);
  assert.doesNotMatch(app, /请求日志记录已实时开启/);
  assert.doesNotMatch(modelSection, /开启日志记录/);
  assert.doesNotMatch(modelSection, /查看请求日志/);
  assert.doesNotMatch(modelSection, /open_route_request_logs/);
  assert.doesNotMatch(overlay, /RequestLogDialog/);
  assert.doesNotMatch(overlay, /\/codey\/request-logs/);
  await assert.rejects(
    () => access(new URL("src/RequestLogDialog.tsx", root), constants.F_OK),
    { code: "ENOENT" },
  );
});
