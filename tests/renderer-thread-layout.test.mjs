import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

const assetUrl = "app://-/assets/async/418532.084e06d418.js";
const patchScript = await loadStartupPatchTemplate();
function patch(source) {
  const logs = [];
  const install = runInNewContext(`${patchScript};__codeyRendererPatchEntry`, {
    URL, __codeyPatchLog: (record) => logs.push(record),
  });
  const result = install(assetUrl, source);
  assert.ok(result);
  assert.equal(install(assetUrl, result), null);
  assert.deepEqual(logs, []);
  return result;
}

const resizeController = [
  'function resize(view,previous,mode,pinned,follow,k,scroll){let s=previous!==view.clientHeight;if(previous=view.clientHeight,s&&0===previous)return "zero";',
  'let p=(0,k.IA)(view);if("top"===mode&&pinned.current[mode])return void scroll(Math.max(0,view.scrollHeight-view.clientHeight),"instant");',
  'if("bottom"===mode&&!follow)return [s,previous,p];return p}const fields={previousViewportHeightPx:"threadScroll.initialRead"};',
].join("");
// 26.1111 把恢复距离交给保存函数后再恢复。
const legacyScrollController = [
  'function restore(r,mode,prev,saved,fallback,anchor,footer,store,tracer,k,readBack){',
  'let t=null!=prev&&(!prev.active||"top"===prev.scrollOrigin),n=null==saved?fallback:Math.max(0,r.scrollHeight-r.clientHeight-saved);',
  '"top"===mode?n=Math.max(0,r.scrollHeight-r.clientHeight):t&&null!=anchor.current&&(n=anchor.current+(footer()?.getHeightPx()??0)),store(n),(0,tracer.S)("threadScroll.restore",()=>(0,k.it)(r,n)),readBack((0,k.IA)(r))}',
  resizeController,
].join("");
// 26.1117 恢复前先读取 scrollTop，不再调用保存函数。
const scrollController = [
  'function restore(r,mode,prev,saved,fallback,anchor,footer,store,tracer,k,readBack){',
  'let t=null!=prev&&(!prev.active||"top"===prev.scrollOrigin),n=null==saved?fallback:Math.max(0,r.scrollHeight-r.clientHeight-saved);',
  '"top"===mode?n=Math.max(0,r.scrollHeight-r.clientHeight):t&&null!=anchor.current&&(n=anchor.current+(footer()?.getHeightPx()??0));let before=r.scrollTop;(0,tracer.S)("threadScroll.restore",()=>(0,k.it)(r,n)),store(n,before),readBack((0,k.IA)(r))}',
  resizeController,
].join("");

for (const [version, controller] of [["26.1111", legacyScrollController], ["26.1117", scrollController]]) {
  test(`${version} scroll restoration selects the native distance before reading dimensions and reads back after scrolling`, () => {
    const patched = patch(controller);
    assert.ok(patched.includes("/*codey-scroll-restore-distance*/"));
    const run = (source, scenario) => {
      const restore = runInNewContext(`${source};restore`);
      const { mode, previous, saved, anchor } = scenario;
      let reads = 0;
      let height = 180;
      const view = { get scrollHeight() { reads++; return height; }, clientHeight: 100, scrollTop: 0 };
      const trace = [];
      const k = {
        it(el, distance) { el.scrollTop = Math.round(Math.max(0, el.scrollHeight - el.clientHeight - distance)); },
        IA(el) { return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop); },
      };
      restore(view, mode, previous, saved, 33, { current: anchor }, () => ({ getHeightPx: () => 8 }),
        (n) => { trace.push(n); height += 40; }, { S: (_label, fn) => fn() }, k, (n) => trace.push(n));
      return { trace, scrollTop: view.scrollTop, reads };
    };
    for (const scenario of [
      { mode: "top", previous: null, saved: 17, anchor: null, savedReads: 1 },
      { mode: "bottom", previous: { active: false }, saved: 17, anchor: 0, savedReads: 1 },
      { mode: "bottom", previous: null, saved: 17.5, anchor: null, savedReads: 0 },
      { mode: "bottom", previous: null, saved: null, anchor: null, savedReads: 0 },
    ]) {
      const before = run(controller, scenario);
      const after = run(patched, scenario);
      assert.deepEqual(after, { ...before, reads: before.reads - scenario.savedReads });
    }
  });
}

test("resize reads viewport height once per comparison and preserves pinned scrolling and zero-height handling", () => {
  const resize = runInNewContext(`${patch(scrollController)};resize`);
  let height = 80;
  let reads = 0;
  let distanceReads = 0;
  const view = { scrollHeight: 200, get clientHeight() { reads++; return height; } };
  const k = { IA() { distanceReads++; return 41; } };
  const scrolls = [];
  const scrolled = (...args) => scrolls.push(args);
  const pinned = { current: { top: true } };
  assert.deepEqual(Array.from(resize(view, 80, "bottom", pinned, false, k, scrolled)), [false, 80, 41]);
  assert.equal(reads, 1);
  height = 90;
  resize(view, 80, "top", pinned, false, k, scrolled);
  assert.deepEqual(scrolls, [[110, "instant"]]);
  assert.equal(distanceReads, 1);
  height = 0;
  assert.equal(resize(view, 90, "bottom", pinned, false, k, scrolled), "zero");
  assert.equal(distanceReads, 1);
});
