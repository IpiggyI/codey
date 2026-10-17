import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/codey-inject.js", import.meta.url), "utf8");
const start = source.indexOf("  const messageDeletionMethods = {");
const end = source.indexOf("  const isLocalMessageDeletionManager", start);
assert.ok(start >= 0 && end > start);
const declaredStart = source.indexOf("  const declaredMethod =");
const declaredEnd = source.indexOf("  const appServerManagerRegistryResolverFromModule", declaredStart);
const methods = Function(`${source.slice(declaredStart, declaredEnd)}\n${source.slice(start, end)}; return messageDeletionMethods;`)();

function fixture({ canonical = false, historyMode = "paginated", version = "0.163.0-alpha.10.2" } = {}) {
  const first = { turnId: "turn-1", status: "completed", items: [] };
  const second = { turnId: "turn-2", status: "completed", items: [] };
  const conversation = {
    id: "session-1",
    title: "保留标题",
    turns: [first, second],
    historyMode,
    requests: [],
    resumeState: "resumed",
    threadRuntimeStatus: { type: "idle" },
    turnsPagination: { olderCursor: "cursor-1", hasLoadedOldest: false },
    latestModel: "model-1",
  };
  if (canonical) {
    conversation.turnHistory = {
      kind: "canonical",
      history: {
        generation: 4,
        isComplete: false,
        entitiesByKey: { "turn:turn-1": first, "turn:turn-2": second },
        islands: [{
          id: "tail:4",
          entries: [
            { key: "turn:turn-1", value: "turn:turn-1" },
            { key: "turn:turn-2", value: "turn:turn-2" },
          ],
          olderBoundary: { status: "available", handle: { cursor: "cursor-1" } },
          newerBoundary: { status: "exhausted" },
        }],
      },
    };
  }
  const requests = [];
  const applications = [];
  const response = { thread: { id: conversation.id } };
  const manager = {
    ...methods,
    role: { role: "owner" },
    getConversation(sessionId) {
      assert.equal(sessionId, conversation.id);
      return conversation;
    },
    getStreamRole() { return this.role; },
    getCachedConversations() { return [conversation]; },
    requestClient: { getAppServerVersion() { return version; } },
    async sendRequest(method, params) { requests.push({ method, params }); return response; },
    applyRevertResponseToConversation(payload) { applications.push(payload); },
    applyRollbackResponseToConversation(payload) { applications.push(payload); },
    updateConversationState(sessionId, update) {
      assert.equal(sessionId, conversation.id);
      update(conversation);
    },
    inactiveThreadUnsubscriber: {
      clearConversationStreamOwnership(sessionId) {
        assert.equal(sessionId, conversation.id);
        manager.role = null;
      },
    },
    discardConversationFromCache() { assert.fail("must retain mounted conversation"); },
    resumeConversation() { assert.fail("must not reload the conversation"); },
  };
  return { conversation, manager, requests, applications, response, first, second };
}

test("preparing middle deletion checks the window without changing the subscription or history", async () => {
  const { manager, conversation, requests } = fixture({ canonical: true });
  const before = structuredClone(conversation);
  await manager.prepare(conversation.id);
  assert.deepEqual(conversation, before);
  assert.deepEqual(requests, []);
});

test("suffix deletion reverts from the earliest selected turn and applies the native response", async () => {
  const { manager, conversation, requests, applications, response, first, second } = fixture();
  assert.equal(manager.plan(conversation.id, ["turn-2", "turn-1"]).kind, "suffix");
  await manager.revert(conversation.id, ["turn-2", "turn-1"]);
  assert.deepEqual(requests, [{ method: "thread/revert", params: { threadId: conversation.id, beforeTurnId: "turn-1" } }]);
  assert.deepEqual(applications, [{ conversationId: conversation.id, response, revertedTurns: [first, second] }]);
  assert.equal(applications[0].revertedTurns[0], first);
  assert.equal(conversation.resumeState, "resumed");
  assert.equal(manager.role.role, "owner");
});

test("non-paginated suffix deletion uses the legacy pair even when revert is available", async () => {
  const { manager, conversation, requests, applications, response } = fixture({ historyMode: "full" });
  await manager.revert(conversation.id, ["turn-2"]);
  assert.deepEqual(requests, [{ method: "thread/rollback", params: { threadId: conversation.id, numTurns: 1 } }]);
  assert.equal(applications[0].conversationState, conversation);
  assert.equal(applications[0].rollbackResponse, response);
});

test("paginated suffix deletion never rolls back an unknown revert method", async () => {
  for (const error of [Object.assign(new Error("Method not found"), { code: -32601 }), new Error("unknown method thread/revert")]) {
    const { manager, conversation, requests, applications } = fixture();
    const send = manager.sendRequest;
    manager.sendRequest = async (method, params) => {
      if (method === "thread/revert") { requests.push({ method, params }); throw error; }
      return send(method, params);
    };
    await assert.rejects(manager.revert(conversation.id, ["turn-1", "turn-2"]), (actual) => actual === error);
    assert.deepEqual(requests.map(({ method }) => method), ["thread/revert"]);
    assert.deepEqual(applications, []);
  }
});

test("paginated suffix deletion requires a confirmed threadRevert version", async () => {
  for (const version of [null, "", "invalid", "0.147.9", "0.148.0-alpha.12", "0.148.0-alpha", "0.148.0-12"]) {
    const { manager, conversation, requests, applications } = fixture({ version });
    await assert.rejects(manager.revert(conversation.id, ["turn-2"]), /无法确认.*撤回能力/);
    assert.deepEqual(requests, [], String(version));
    assert.deepEqual(applications, []);
  }
  const runtime = fixture();
  delete runtime.manager.requestClient;
  await assert.rejects(runtime.manager.revert("session-1", ["turn-2"]), /无法确认.*撤回能力/);
  assert.deepEqual(runtime.requests, []);
});

test("paginated suffix deletion accepts the native version boundary and development version", async () => {
  for (const version of ["0.0.0", "0.148.0-alpha.13", "0.148.0-alpha.13.1", "0.148.0-alpha.14", "0.148.0-beta.1", "0.148.0", "0.148.1", "0.149.0", "1.0.0"]) {
    const { manager, conversation, requests } = fixture({ version });
    await manager.revert(conversation.id, ["turn-2"]);
    assert.deepEqual(requests.map(({ method }) => method), ["thread/revert"], version);
  }
});

test("paginated suffix deletion without a revert applier never uses rollback", async () => {
  const { manager, requests } = fixture();
  delete manager.applyRevertResponseToConversation;
  await assert.rejects(manager.revert("session-1", ["turn-2"]), /不支持.*末尾/);
  assert.deepEqual(requests, []);
});

test("non-paginated suffix deletion requires its rollback applier", async () => {
  const { manager, requests } = fixture({ historyMode: "full" });
  delete manager.applyRollbackResponseToConversation;
  await assert.rejects(manager.revert("session-1", ["turn-2"]), /不支持.*末尾/);
  assert.deepEqual(requests, []);
});

test("suffix deletion fails without a native pair or on an ordinary server error", async () => {
  const unavailable = fixture();
  delete unavailable.manager.applyRevertResponseToConversation;
  delete unavailable.manager.applyRollbackResponseToConversation;
  await assert.rejects(unavailable.manager.revert("session-1", ["turn-2"]), /不支持.*末尾/);
  assert.deepEqual(unavailable.requests, []);
  const failed = fixture();
  failed.manager.sendRequest = async (method) => { failed.requests.push(method); throw new Error("permission denied"); };
  await assert.rejects(failed.manager.revert("session-1", ["turn-2"]), /permission denied/);
  assert.deepEqual(failed.requests, ["thread/revert"]);
  assert.deepEqual(failed.applications, []);
});

test("a failed revert response application never invokes legacy rollback", async () => {
  const { manager, conversation, requests } = fixture();
  manager.applyRevertResponseToConversation = () => { throw new Error("Method not found while applying state"); };
  await assert.rejects(manager.revert(conversation.id, ["turn-2"]), /applying state/);
  assert.deepEqual(requests.map(({ method }) => method), ["thread/revert"]);
});

test("canonical suffix uses island order and preserves turn objects", async () => {
  const { manager, conversation, first, second } = fixture({ canonical: true });
  conversation.turnHistory.history.entitiesByKey = { "turn:turn-2": second, "turn:turn-1": first };
  const plan = manager.plan(conversation.id, ["turn-2"]);
  assert.equal(plan.kind, "suffix");
  assert.deepEqual(plan.revertedTurns, [second]);
  assert.equal(manager.plan(conversation.id, ["turn-1"]).kind, "middle");
  await manager.revert(conversation.id, ["turn-2"]);
});

test("an unmatched live turn before a canonical anchor is a middle selection", async () => {
  for (const insertAt of [0, 1]) {
    const { manager, conversation, first, second, requests } = fixture({ canonical: true });
    const live = { turnId: "live-before", status: "completed", items: [] };
    conversation.turns.splice(insertAt, 0, live);
    const expected = insertAt === 0 ? [live, first, second] : [first, live, second];
    assert.deepEqual(manager.entries(conversation).map(({ turn }) => turn), expected);
    assert.equal(manager.plan(conversation.id, [live.turnId]).kind, "middle");
    assert.equal(manager.plan(conversation.id, [second.turnId]).kind, "suffix");
    await assert.rejects(manager.revert(conversation.id, [live.turnId]), /已不在会话末尾/);
    assert.deepEqual(requests, []);
  }
});

test("a genuinely trailing unmatched live turn remains a suffix selection", async () => {
  const { manager, conversation, first, second, requests, applications } = fixture({ canonical: true });
  const live = { turnId: "live-after", status: "completed", items: [] };
  conversation.turns.push(live);
  assert.deepEqual(manager.entries(conversation).map(({ turn }) => turn), [first, second, live]);
  assert.equal(manager.plan(conversation.id, [live.turnId]).kind, "suffix");
  await manager.revert(conversation.id, [live.turnId]);
  assert.equal(requests[0].params.beforeTurnId, live.turnId);
  assert.deepEqual(applications[0].revertedTurns, [live]);
});

test("an unmatched live turn without a canonical anchor is never classified as suffix", () => {
  const { manager, conversation, requests } = fixture({ canonical: true });
  conversation.turns = [{ turnId: "live-unknown", status: "completed", items: [] }];
  assert.equal(manager.plan(conversation.id, ["live-unknown"]).kind, "middle");
  assert.deepEqual(requests, []);
});

test("unresolved suffix identifiers and missing selections never send native requests", async () => {
  const { manager, conversation, requests } = fixture({ canonical: true });
  const history = conversation.turnHistory.history;
  history.entitiesByKey["tail:4:local:0"] = { turnId: null, status: "completed" };
  history.islands[0].entries.push({ value: "tail:4:local:0" });
  await assert.rejects(manager.revert(conversation.id, ["history-content:tail:4:local:0"]), /标识/);
  assert.throws(() => manager.plan(conversation.id, ["missing"]), /识别/);
  assert.deepEqual(requests, []);
});

test("suffix selection cannot cross an unloaded canonical history gap", () => {
  const { manager, conversation, requests } = fixture({ canonical: true });
  const history = conversation.turnHistory.history;
  const firstIsland = history.islands[0];
  const entry = firstIsland.entries.pop();
  firstIsland.newerBoundary = { status: "available" };
  history.islands.push({ entries: [entry], newerBoundary: { status: "exhausted" } });
  assert.throws(() => manager.plan(conversation.id, ["turn-1", "turn-2"]), /尚未完整加载/);
  assert.equal(manager.plan(conversation.id, ["turn-2"]).kind, "suffix");
  assert.equal(manager.plan(conversation.id, ["turn-1"]).kind, "middle");
  assert.deepEqual(requests, []);
});

test("middle deletion fails safely when the window's conversations cannot be inspected", async () => {
  const { manager, conversation, requests } = fixture();
  delete manager.getCachedConversations;
  await assert.rejects(manager.prepare(conversation.id), /无法检查.*任务状态/);
  assert.deepEqual(requests, []);
});

test("middle deletion refuses a running task in another cached conversation", async () => {
  for (const active of [
    { threadRuntimeStatus: { type: "active" } },
    { requests: [{ id: "pending" }] },
    { turns: [{ status: "inProgress" }] },
    { turnHistory: { history: { entitiesByKey: { older: { status: "inProgress" } } } } },
  ]) {
    const { manager, conversation, requests } = fixture();
    manager.getCachedConversations = () => [conversation, { id: "other", ...active }];
    await assert.rejects(manager.prepare(conversation.id), /窗口.*任务.*运行/);
    assert.deepEqual(requests, []);
  }
});

test("in-place deletion retains unselected turn objects and conversation metadata", () => {
  const { manager, conversation, second } = fixture();
  const pagination = conversation.turnsPagination;
  manager.finish(conversation.id, ["turn-1"]);
  assert.deepEqual(conversation.turns, [second]);
  assert.equal(conversation.turns[0], second);
  assert.equal(conversation.turnsPagination, pagination);
  assert.equal(conversation.title, "保留标题");
  assert.equal(conversation.latestModel, "model-1");
  assert.equal(conversation.resumeState, "needs_resume");
  assert.equal(manager.role, null);
});

test("canonical deletion invalidates pending pages while retaining pagination boundaries", () => {
  const { manager, conversation, second } = fixture({ canonical: true });
  const history = conversation.turnHistory.history;
  const island = history.islands[0];
  const olderBoundary = island.olderBoundary;
  const retainedEntry = island.entries[1];
  manager.finish(conversation.id, ["turn-1"]);
  assert.equal(history.generation, 5);
  assert.equal(history.islands[0], island);
  assert.equal(island.olderBoundary, olderBoundary);
  assert.equal(island.entries[0], retainedEntry);
  assert.deepEqual(Object.keys(history.entitiesByKey), ["turn:turn-2"]);
  assert.equal(history.entitiesByKey["turn:turn-2"], second);
  assert.deepEqual(conversation.turns, [second]);
});

test("canonical deletion matches unresolved tail selectors without deleting adjacent records", () => {
  const { manager, conversation } = fixture({ canonical: true });
  const history = conversation.turnHistory.history;
  const unresolvedTurn = { turnId: null, items: [] };
  history.entitiesByKey["tail:4:local:0"] = unresolvedTurn;
  conversation.turns.push(unresolvedTurn);
  history.islands[0].entries.push({ key: "tail:4:local:0", value: "tail:4:local:0" });
  manager.finish(conversation.id, ["history-content:tail:4:local:0"]);
  assert.deepEqual(Object.keys(history.entitiesByKey), ["turn:turn-1", "turn:turn-2"]);
  assert.equal(history.islands[0].entries.length, 2);
  assert.equal(conversation.turns.length, 2);
});

test("deleting all loaded turns retains history boundaries and permits later continuation", () => {
  const { manager, conversation } = fixture({ canonical: true });
  const island = conversation.turnHistory.history.islands[0];
  manager.finish(conversation.id, ["turn-1", "turn-2"]);
  assert.deepEqual(conversation.turns, []);
  assert.deepEqual(conversation.turnHistory.history.entitiesByKey, {});
  assert.deepEqual(island.entries, []);
  assert.equal(conversation.turnHistory.history.islands[0], island);
  assert.equal(conversation.resumeState, "needs_resume");
});

test("preparing deletion rejects active tasks followers and unsupported history without sending requests", async () => {
  for (const configure of [
    ({ conversation }) => { conversation.threadRuntimeStatus = { type: "active" }; },
    ({ conversation }) => { conversation.turns[0].status = "inProgress"; },
    ({ conversation }) => { conversation.requests.push({ id: "pending" }); },
    ({ manager }) => { manager.role = { role: "follower" }; },
    ({ conversation }) => { conversation.turnHistory = { kind: "unknown" }; },
  ]) {
    const runtime = fixture();
    configure(runtime);
    const before = structuredClone(runtime.conversation);
    await assert.rejects(runtime.manager.prepare(runtime.conversation.id));
    assert.deepEqual(runtime.requests, []);
    assert.deepEqual(runtime.conversation, before);
  }
});

test("suffix deletion rechecks tasks ownership and history before sending a request", async () => {
  for (const configure of [
    ({ conversation }) => { conversation.threadRuntimeStatus = { type: "active" }; },
    ({ conversation }) => { conversation.requests.push({ id: "started" }); },
    ({ conversation }) => { conversation.turns.push({ turnId: "new", status: "inProgress" }); },
    ({ manager }) => { manager.role = { role: "follower" }; },
    ({ conversation }) => { conversation.turnHistory = { kind: "unsupported" }; },
  ]) {
    const runtime = fixture();
    configure(runtime);
    await assert.rejects(runtime.manager.revert(runtime.conversation.id, ["turn-2"]));
    assert.deepEqual(runtime.requests, []);
    assert.equal(runtime.conversation.resumeState, "resumed");
  }
});
