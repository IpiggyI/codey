import assert from "node:assert/strict";
import test from "node:test";

import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { configApplyBannerVisible } = createModuleGraph(new URL("../src/configApply.ts", import.meta.url)).exports;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// 保留 hook 状态和 effect 清理，并用可控计时器驱动真实的运行状态轮询。
function runtimeStatusHarness(context) {
  let cursor = 0, now = 0, timerId = 0, current;
  const hooks = [], effects = [], timers = new Map(), requests = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      const cell = hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      cell.set ??= next => { cell.value = typeof next === "function" ? next(cell.value) : next; };
      return [cell.value, cell.set];
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useMemo(factory, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || !same(previous.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (previous && same(previous.deps, deps)) return;
      hooks[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = effect(); });
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    addEventListener() {}, removeEventListener() {},
  } });
  const realNow = Date.now;
  Date.now = () => now;
  const graph = createModuleGraph(new URL("../src/useRuntimeStatus.ts", import.meta.url), { stubs: {
    react,
    "./api": { invoke: (command, args) => { const call = { command, args, ...deferred() }; requests.push(call); return call.promise; } },
    "./appUtils": { withTimeout: promise => promise },
  } });
  const render = () => {
    cursor = 0;
    current = graph.exports.useRuntimeStatus({ active: true, embedded: false });
    effects.splice(0).forEach(effect => effect());
    return current;
  };
  const tick = async () => {
    const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) return false;
    timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
    await flush();
    return true;
  };
  context.after(() => {
    hooks.forEach(hook => hook?.cleanup?.());
    Date.now = realNow;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  render();
  return { render, tick, timers, requests, get current() { return current; } };
}

test("an older runtime status response cannot replace a newer accepted application", async context => {
  const h = runtimeStatusHarness(context);
  const late = h.current.refreshStatus();
  h.current.acceptConfigApply({ revision: 2, state: "pending" });
  h.render();
  h.requests[0].resolve({ running: true, configApply: { revision: 1, state: "failed", error: "旧错误" }, restartRequired: true });
  await late; await flush(); h.render();
  assert.deepEqual(h.current.status.configApply, { revision: 2, state: "pending" });
  assert.notEqual(h.current.status.restartRequired, true);
});

test("a late pending reply cannot reopen an application that already completed", async context => {
  const h = runtimeStatusHarness(context);
  h.current.acceptConfigApply({ revision: 3, state: "applied" });
  assert.deepEqual(h.current.acceptConfigApply({ revision: 3, state: "pending" }), { revision: 3, state: "applied" });
  h.render();
  assert.equal(h.current.status.configApply.state, "applied");
  assert.equal(h.timers.size, 0, "a completed application does not poll");
});

test("two saves in a row poll until the later save finishes and then stop", async context => {
  const h = runtimeStatusHarness(context);
  h.current.acceptConfigApply({ revision: 1, state: "pending" });
  h.current.acceptConfigApply({ revision: 2, state: "pending" });
  h.render();
  assert.equal(configApplyBannerVisible(h.current.status.configApply, h.current.configApplyError), true);
  const replies = [
    { revision: 1, state: "applied" },
    { revision: 2, state: "pending" },
    { revision: 2, state: "applied" },
  ];
  while (await h.tick()) {
    const request = h.requests.at(-1);
    assert.equal(request.command, "runtime_status");
    assert.deepEqual(request.args, { refreshInjectionStatus: false });
    request.resolve({ running: true, configApply: replies.shift() });
    await flush(); h.render();
  }
  assert.deepEqual(replies, []);
  assert.deepEqual(h.current.status.configApply, { revision: 2, state: "applied" });
  assert.equal(configApplyBannerVisible(h.current.status.configApply, h.current.configApplyError), false);
  assert.equal(h.timers.size, 0);
});

test("a failed application keeps the banner with its reason and stops polling", async context => {
  const h = runtimeStatusHarness(context);
  h.current.acceptConfigApply({ revision: 4, state: "pending" });
  h.render();
  assert.equal(await h.tick(), true);
  h.requests.at(-1).resolve({ running: true, configApply: { revision: 4, state: "failed", error: "连接中断" } });
  await flush(); h.render();
  assert.equal(h.current.status.configApply.error, "连接中断");
  assert.equal(configApplyBannerVisible(h.current.status.configApply, h.current.configApplyError), true);
  assert.equal(h.timers.size, 0);
});
