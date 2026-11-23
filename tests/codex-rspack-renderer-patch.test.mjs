import assert from "node:assert/strict";
import test from "node:test";

import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

// Codex 26.1029 switched to rspack: every asset is a numeric chunk, string
// literals use double quotes, comparisons put the literal first and imports are
// called as `(0,module.export)(...)`. Fixtures mirror those shapes.
const chunkUrl = "app://-/assets/async/24191.589dcc9878.js";

async function installPatch({ disablePet = false } = {}) {
  delete globalThis.__codeyRendererPatchInstalled;
  (0, eval)(await loadStartupPatchTemplate({ disablePet }));
  const logs = [];
  globalThis.__codeyPatchLog = (record) => logs.push(JSON.parse(record));
  return {
    logs,
    patch(source, url = chunkUrl) {
      return globalThis.__codeyRendererPatchEntry(url, source);
    },
  };
}

test.afterEach(() => {
  delete globalThis.__codeyPatchLog;
  delete globalThis.__codeyModelWhitelistPatch;
});

test("26.1111 model filter retains hidden and access-program restrictions", async () => {
  const { logs, patch } = await installPatch();
  const source = 'const visible=function({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:s,useHiddenModels:o}){let l=s.availableAccessPrograms?.cyber;return("apikey"!==n||!!t||null==l||!(l.length>0)||!!l.includes("standard"))&&(e?.has(s.model)===!0||"codex-auto-review"!==s.model&&(i&&!s.hidden||(o&&!a&&"amazonBedrock"!==n?r.has(s.model)||"apikey"===n&&t&&!s.hidden&&l?.some(e=>"standard"!==e)===!0:!s.hidden)))}';
  const patched = patch(source);
  assert.ok(patched);
  assert.equal(patch(patched), null);
  const visible = Function(`${patched};return visible`)();
  const options = { availableModels: new Set(["hidden"]), useHiddenModels: true };
  const hidden = { model: "hidden", hidden: true };
  assert.equal(visible({ ...options, authMethod: "chatgpt", model: { model: "visible" } }), true);
  assert.equal(visible({ ...options, authMethod: "chatgpt", model: hidden }), true);
  assert.equal(visible({ ...options, authMethod: "apikey", model: hidden }), false);
  assert.equal(visible({ ...options, authMethod: "apikey", model: { model: "restricted", availableAccessPrograms: { cyber: ["restricted"] } } }), false);
  assert.deepEqual(logs, []);
});

test("26.1111 team catalog query delegates filtering and preserves caller and provider reasoning settings", async () => {
  const { logs, patch } = await installPatch();
  const source = 'const q=({authMethod:t,includeUltraReasoningEffort:i=!0,teamCatalog:h},{get:x})=>{let{data:S}=x(y.I2),j=null==S?null:S.config,A=(0,c.cc)(j),L=x(w.t),z=i&&x(v.JW,"1186680773");return{select:({data:r,isTeamCatalog:n=!1})=>({...(0,a.a)({additionalAvailableModels:new Set(),authMethod:t,availableModels:L.availableModels,includeUltraReasoningEffort:z,isCustomModelProvider:A,models:r,useHiddenModels:L.useHiddenModels}),isTeamCatalog:n})}};const bedrock="amazonBedrock"';
  const patched = patch(source);
  assert.ok(patched);
  assert.equal(patch(patched), null);
  const query = Function("y", "c", "w", "v", "a", `${patched};return q`)({ I2: "config" }, { cc: value => value.custom }, { t: "models" }, { JW: "gate" }, { a: value => value });
  for (const custom of [true, false]) for (const caller of [true, false]) for (const gate of [true, false]) {
    const get = key => ({ config: { data: { config: { custom } } }, models: { useHiddenModels: true }, gate })[key];
    const selected = query({ includeUltraReasoningEffort: caller }, { get }).select({ data: ["visible"] });
    assert.equal(selected.includeUltraReasoningEffort, caller && (custom || gate));
    assert.deepEqual(selected.models, ["visible"]);
  }
  assert.deepEqual(logs, []);
});

test("26.1111 memoized tier state retains denial and trigger availability retains the hidden-label condition", async () => {
  const { logs, patch } = await installPatch();
  const state = 'function hook(g,w,f,o){let n,u,d=[];d[3]!==f||d[4]!==w||d[5]!==g?(n=g&&!w&&null!=f?(0,o.W6)(f):null,d[3]=f,d[4]=w,d[5]=g,d[6]=n):n=d[6];let b=n;return d[7]!==w||d[8]!==b?(u={serviceTierAccess:b,isLoading:w},d[7]=w,d[8]=b,d[9]=u):u=d[9],u}';
  const patchedState = patch(state);
  assert.ok(patchedState);
  assert.equal(patch(patchedState), null);
  const hook = Function(`${patchedState};return hook`)();
  const denied = { fast: false, ultrafast: false };
  assert.equal(hook(true, false, denied, { W6: value => value }).serviceTierAccess, denied);
  assert.deepEqual(hook(false, false, null), { serviceTierAccess: { fast: true, ultrafast: true }, isLoading: false });
  assert.equal(hook(true, true, null).isLoading, true);
  const trigger = 'function picker(t9,ni,ob,ov){let ou=t9&&!ni;let tooltip="composer.intelligenceDropdown.tooltip",lz=ou?{openLabel:tooltip,selectedServiceTierIconKind:ob?ov:null}:void 0;return{modelPickerTriggerConfig:lz}}';
  const patchedTrigger = patch(trigger);
  assert.ok(patchedTrigger);
  assert.equal(patch(patchedTrigger), null);
  const picker = Function(`${patchedTrigger};return picker`)();
  assert.equal(picker(false, false, true, "fast").modelPickerTriggerConfig.selectedServiceTierIconKind, "fast");
  assert.equal(picker(true, true, true, "fast").modelPickerTriggerConfig, undefined);
  assert.deepEqual(logs, []);
});

test("rspack view bridge sends through the model route preflight", async () => {
  const { logs, patch } = await installPatch();
  const source = 'const k="codex-message-from-view";function send(e,r,n){r?.sendMessageFromView&&(r.sendMessageFromView(e).catch(t=>{"log-message"!==e.type&&n.push(["Failed to send message from view",e,t])}))}';
  const patched = patch(source);
  assert.ok(patched, "the short-circuit bridge send is rewritten");
  assert.equal(patch(patched), null, "the patch is idempotent");
  const send = Function(`${patched};return send`)();

  const sent = [];
  const bridge = { sendMessageFromView: async (message) => { sent.push(message); } };
  globalThis.__codeyModelWhitelistPatch = {
    rewriteOutgoingMessage: (message) => ({ ...message, routed: true }),
    isBlockedOutgoingMessage: (message) => message.type === "blocked",
    notifyBlockedOutgoingMessage: () => sent.push("blocked-notice"),
    guardDirectBridgeMessage: () => null,
  };
  send({ type: "turn" }, bridge, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ type: "turn", routed: true }]);

  const failures = [];
  send({ type: "turn" }, { sendMessageFromView: async () => { throw Error("transport"); } }, failures);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1, "transport failures keep the native catch");
  send({ type: "turn" }, undefined, failures);
  assert.deepEqual(logs, []);
});

test("rspack request client keeps route, identity and model result gates in one chunk", async () => {
  const { logs, patch } = await installPatch();
  const source = [
    'class C{async sendRequest(e,t,n){if(null==this.dispatchMessage)throw Error("AppServerRequestClient is missing a message dispatcher");return this.enqueueRequest(e,t,n)}',
    'enqueueRequest(e,t,n,r=t=>{this.dispatchMessage?.("mcp-request",{request:t,hostId:this.hostId,retainResponse:void 0,source:n?.source,timeoutMs:n?.timeoutMs,widget:n?.widget})},i=null){let a=1;log("mcp_request_enqueued");let{request:o,promise:l}=this.createRequest(e,t,n,i);r(o);return l}',
    'onResult(e,t){let r=this.requestPromises.get(e);r.resolve(t),this.emitRequestLifecycleEvent({type:"completed",hostId:this.hostId,method:r.method,id:e})}}',
  ].join("");
  const patched = patch(source);
  for (const marker of [
    "let __codeyRoute=globalThis.__codeyModelWhitelistPatch?.rewriteOutgoingMessage",
    "globalThis.__codeyModelWhitelistPatch?.trackOutgoingMessage",
    "globalThis.__codeyModelWhitelistPatch?.rewriteIncomingResult",
  ]) assert.ok(patched.includes(marker), marker);
  assert.equal(patch(patched), null);
  Function(patched);
  assert.deepEqual(logs, []);
});

test("rspack hosted manager marker and completed thread reconciliation follow reversed null checks", async () => {
  const { logs, patch } = await installPatch();
  const hosted = 'function E(e){let O=v.appServices.appServerManagers;if(null==O)throw Error("Desktop host did not provide its AppServerManager service");return O.dup()}';
  const hostedPatched = patch(hosted);
  delete globalThis.__codeyAppServerManagerHosted;
  const connect = Function("v", `${hostedPatched};return E`);
  assert.throws(() => connect({ appServices: {} })(), /did not provide/);
  assert.equal(globalThis.__codeyAppServerManagerHosted, undefined);
  assert.equal(connect({ appServices: { appServerManagers: { dup: () => "dup" } } })(), "dup");
  assert.equal(globalThis.__codeyAppServerManagerHosted, true);
  delete globalThis.__codeyAppServerManagerHosted;

  const manager = [
    "class M{getHostId(){return\"local\"}getConversation(e){return this.threadStore.getConversation(e)}getStreamRole(e){}updateConversationState(e,t){}getConversationStreamRevision(e){}",
    "clear(){this.inactiveThreadUnsubscriber.clearConversationStreamOwnership(1)}",
    "getHasInProgressLocalConversation({exceptConversationId:e}={}){for(let t of this.threadStore.getRecentConversationIds()){if(t===e)continue;let n=this.conversations.get(t);if(null!=n&&el(n))return!0}return!1}}",
  ].join("");
  const managerPatched = patch(manager);
  assert.match(managerPatched, /async codeyReconcileCompletedConversation\(/);
  assert.match(managerPatched, /&&el\(__codeyConversation\)&&/, "the native in-progress predicate is reused");
  Function(managerPatched);
  assert.deepEqual(logs, []);
});

test("rspack service tier gates grant tiers declared by the model catalog", async () => {
  const { logs, patch } = await installPatch();
  const access = 'let o="default";function i(e){let t=e.requirements?.featureRequirements;return{ultrafast:"supportsIndependentSpeedModes"in e?t?.ultrafast_mode!==!1:!1}}function s(e,t){if(null==e||e===o)return!0;if(null==t)return!1;let n=l(e);return"flex"===e||t[n??"fast"]}function l(e){return e}';
  const accessCheck = Function(`${patch(access)};return s`)();
  assert.equal(accessCheck("fast", { fast: false }), false);
  assert.equal(accessCheck("ultrafast", null), true);

  const state = 'function U(c,_,p,g,h,s,r,n){let t,a,u;let{data:m,isPending:x}=n(s.b9,t),b=!!_?.isLoading||g&&x;c[3]!==m||c[4]!==b||c[5]!==g?(a=g&&!b&&null!=m?(0,r.W6)(m):null,c[3]=m,c[4]=b,c[5]=g,c[6]=a):a=c[6];let y=a;return c[7]!==b||c[8]!==y?(u={serviceTierAccess:y,isLoading:b},c[7]=b,c[8]=y,c[9]=u):u=c[9],u}';
  const hook = Function(`${patch(state)};return U`)();
  const result = hook([], { isLoading: false }, null, false, null, {}, { W6: () => "native" }, () => ({ data: null, isPending: false }));
  assert.deepEqual({ ...result.serviceTierAccess }, { fast: true, ultrafast: true }, "API key logins keep the speed control");
  assert.deepEqual(logs, []);
});

test("rspack Ultra reasoning gate accepts module-member feature ids", async () => {
  const { logs, patch } = await installPatch();
  const source = 'const q=({includeUltraReasoningEffort:l,isCustomModelProvider:i,limit:u,modelCatalogPath:c},{get:v,queryClient:I})=>{let k=null!=c,O=l&&v(b.JW,"1186680773");return{queryKey:[k],ultra:O}};';
  const patched = patch(source);
  assert.match(patched, /O=l&&\(i\|\|v\(b\.JW,"1186680773"\)\)/);
  const query = Function("b", `${patched};return q`)({ JW: "gate" });
  const get = () => false;
  assert.equal(query({ includeUltraReasoningEffort: true, isCustomModelProvider: true }, { get }).ultra, true);
  assert.equal(query({ includeUltraReasoningEffort: true, isCustomModelProvider: false }, { get }).ultra, false);
  assert.equal(query({ includeUltraReasoningEffort: false, isCustomModelProvider: true }, { get }).ultra, false);
  assert.deepEqual(logs, []);
});

test("rspack telemetry patches skip heartbeat snapshots and interaction sampling", async () => {
  const { logs, patch } = await installPatch();
  const snapshot = 'async function h(e,t){switch(e.type){case"electron-app-state-snapshot-request":{let a=await t.collectAppStateSnapshot(e.hostId,e.reason);if(null==a)break;t.dispatchMessage("electron-app-state-snapshot-response",{requestId:e.requestId,snapshot:a});break}default:return"other"}return"replied"}';
  const patchedSnapshot = patch(snapshot);
  assert.equal(patch(patchedSnapshot), null);
  const handle = Function(`${patchedSnapshot};return h`)();
  const calls = [];
  const host = { collectAppStateSnapshot: async (...args) => (calls.push(args), {}), dispatchMessage: (...args) => calls.push(args) };
  assert.equal(await handle({ type: "electron-app-state-snapshot-request", hostId: "local", reason: "heartbeat" }, host), "replied");
  assert.deepEqual(calls, [], "the 30 s heartbeat no longer collects a snapshot");
  await handle({ type: "electron-app-state-snapshot-request", hostId: "local", reason: "feedback" }, host);
  assert.equal(calls.length, 2, "other diagnostic reasons still reply");

  const interactions = 'class R{constructor(){this.activeInteractions=new Map}begin(E,n){return{cpuSampling:"dropped"===E||!0===n.backfilled?null:this.beginCpuSampling()}}beginCpuSampling(){return"sampling"}ensureHeartbeat(){null==this.heartbeatTimer&&(this.heartbeatTimer=setInterval(()=>{let e=this.now(),t=this.wallNow();for(let n of this.activeInteractions.values())this.recordHeartbeat(n,e,t)},1e3))}}';
  const Recorder = Function(`${patch(interactions)};return R`)();
  const recorder = new Recorder();
  assert.equal(recorder.begin("sampled", {}).cpuSampling, null);
  recorder.ensureHeartbeat();
  assert.equal(recorder.heartbeatTimer, undefined, "no 1 Hz heartbeat timer is started");
  assert.deepEqual(logs, []);
});

test("rspack checkout prewarm and avatar overlay prewarm stay off until shown", async () => {
  const { logs, patch } = await installPatch({ disablePet: true });
  const pricing = 'function ue(K,Z,q,et,Q,ee,j,P,y){let m;m=!(0,P.$t)()&&"chatgpt"===K&&!Z&&null!=q&&!et&&Q?.structure==="personal"&&(0,y.XM)(ee,j,{disableExposureLog:!0}).get("use_embedded_checkout",!1)?function({currentPlan:e,url:t}){return new URL(t).href}:null;return{forcePricingRefreshInBackground:!0,search:m}}';
  const credit = 'function U(H,F){let c,g,u={useLayoutEffect(){}};if((0,u.useLayoutEffect)(c,g),!H&&(!F||!({get:()=>F}).get("use_embedded_credit_checkout",!1)))return null;return{isPrewarm:!H}}';
  const patched = patch(`${pricing}${credit}`);
  const pricingHook = Function(`${patched};return ue`)();
  const eligible = ["chatgpt", false, {}, false, { structure: "personal" }, null, null, { $t: () => false }, { XM: () => ({ get: () => true }) }];
  assert.equal(pricingHook(...eligible).search, null, "no hidden pricing page is preloaded");
  const creditHook = Function(`${patched};return U`)();
  assert.equal(creditHook(false, true), null, "no hidden credit page is mounted");
  assert.deepEqual({ ...creditHook(true, true) }, { isPrewarm: false }, "a presented credit page still loads");

  const runtime = '(0,u.useEffect)(()=>{l||t0.O1.dispatchMessage("electron-avatar-overlay-restore-ready",{onDemandEnabled:k,shouldPrewarmAvatarOverlay:t&&eP})},[k,t,l,eP]);';
  assert.match(patch(runtime), /\{onDemandEnabled:k,shouldPrewarmAvatarOverlay:!1\}/);
  assert.deepEqual(logs, []);
});

test("rspack combined checkout webview mounts only when a checkout is shown", async () => {
  const { logs, patch } = await installPatch();
  // Codex 26.1106 mounts one hidden prewarm webview whenever a checkout is
  // shown or either embedded checkout experiment is on.
  const checkout = 'function Q(W,O,$,M,v,l,C){let I=O?.get("use_embedded_checkout",!1)===!0&&null!=(0,l.bc$)(C(M(),v),v),z=$&&O?.get("use_embedded_credit_checkout",!1)===!0;let G=null!=W||I||z;return G?{isPrewarm:!0}:null}';
  const patched = patch(checkout);
  assert.ok(patched, "the combined checkout gate is rewritten");
  assert.equal(patch(patched), null, "the patch is idempotent");
  const mount = Function(`${patched};return Q`)();
  const experiments = [{ get: () => true }, true, () => "/pricing", "https://chatgpt.com", { bc$: () => "url" }, (url) => url];
  assert.equal(mount(null, ...experiments), null, "no hidden checkout page is mounted for experiment accounts");
  assert.deepEqual(mount("?url=checkout", ...experiments), { isPrewarm: true }, "a shown checkout still loads");
  assert.deepEqual(logs, []);
});

test("native draft speed defaults preserve the saved user tier", async () => {
  const { logs, patch } = await installPatch();
  const factory = 'let c=(0,a.createContext)(void 0),p=(0,i.bD)(l.u,e=>({isManuallyChanged:!1,modelSettings:null,serviceTier:null}));function h(e){return{isNewThreadDraft:e}}';
  assert.equal(patch(factory), null, "a draft override would replace the saved explicit tier");
  const factoryPatched = factory;
  const makeDraft = Function("a", "i", "l", `${factoryPatched};return p`)(
    { createContext: () => null },
    { bD: (_atom, create) => create },
    { u: null },
  );
  assert.deepEqual(makeDraft(), { isManuallyChanged: false, modelSettings: null, serviceTier: null });

  assert.deepEqual(logs, []);
});

test("unrelated rspack chunks are skipped by the patch anchors", async () => {
  const { logs, patch } = await installPatch();
  assert.equal(patch('export const __rspack_esm_id=1;export const __webpack_modules__={a(e,t){t.A="icon"}};'), null);
  assert.equal(
    patch('(0,u.useEffect)(()=>{l||t0.O1.dispatchMessage("electron-avatar-overlay-restore-ready",{onDemandEnabled:k,shouldPrewarmAvatarOverlay:t&&eP})},[k,t,l,eP]);'),
    null,
    "pet-only anchors stay inactive when pet slimming is disabled",
  );
  assert.deepEqual(logs, []);
});

test("rspack CheckoutPersonalWebviewHost skips background prewarm and renders only presented checkout", async () => {
  const { logs, patch } = await installPatch();
  const source = [
    'const r={c:(n)=>Array(n).fill(Symbol.for("react.memo_cache_sentinel"))},a={Fragment:"Fragment",jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},v={O1:{dispatchMessage(){}}};',
    'function M(searchArg,useCheckout,useCredit){let s=(0,r.c)(10),W=searchArg,N=useCheckout,z=useCredit,v="https://chatgpt.com",R="u1",k="a1";let F=JSON.stringify([R,k,v]),G=null!=W||N||z;return(0,a.jsx)(A,{chatGptOrigin:v,enabled:G,search:W},F)}',
    'function A(e){let u=(0,r.c)(15),{chatGptOrigin:c,enabled:d,search:h}=e,m="part",f="prewarm=1";if(v.O1.dispatchMessage("checkout-webview-presentation-changed",{partition:m,url:h}),!d)return null;let i=(0,a.jsx)("div",{"aria-hidden":!0,inert:!0,className:"pointer-events-none invisible fixed inset-0",children:(0,a.jsx)(W,{isPrewarm:!0,partition:m,search:f})}),l=null==h?null:(0,a.jsx)("div",{className:"fixed inset-0 z-30",children:(0,a.jsx)(W,{partition:m,search:h},h)});return(0,a.jsxs)(a.Fragment,{children:[i,l]})}',
    'function W(props){return props}',
  ].join("");
  const url = "app://-/assets/async/162421.5b98cfa6cf.js";
  const patched = patch(source, url);
  assert.ok(patched, "CheckoutPersonalWebviewHost chunk should be patched");
  assert.ok(patched.includes("/*codey-personal-checkout-prewarm*/"));
  assert.equal(patch(patched, url), null, "the patch is idempotent");
  const { M, A } = Function(`${patched};return{M,A}`)();
  const hiddenHost = M(null, true, true);
  assert.equal(hiddenHost.props.enabled, false, "embedded checkout experiments no longer enable background prewarm");
  assert.equal(A(hiddenHost.props), null, "disabled host mounts nothing");

  const activeHost = M("?accountId=personal&url=https%3A%2F%2Fchatgpt.com%2F%23pricing", true, true);
  assert.equal(activeHost.props.enabled, true, "explicit checkout navigation still enables the host");
  const rendered = A(activeHost.props);
  assert.equal(rendered.props.children[0], null, "hidden isPrewarm webview wrapper is skipped");
  assert.equal(rendered.props.children[1].props.children.props.search, activeHost.props.search, "presented checkout webview still renders");
  assert.deepEqual(logs, []);
});

test("rspack performance gates cap pierre workers and skip orbit preload, route prefetch, LoAF observers, and pending sampler", async () => {
  const { logs, patch } = await installPatch();

  // 1. Pierre syntax highlight worker pool: poolSize 4 -> 1; poolSize 1 stays untouched.
  const pierreUrl = "app://-/assets/async/517695.46b78d24c8.js";
  const pierreSource = "function k(){return{}}function render(){let t={workerFactory:k,poolSize:4,totalASTLRUCacheSize:100};return t}";
  const patchedPierre = patch(pierreSource, pierreUrl);
  assert.ok(patchedPierre?.includes("/*codey-pierre-pool-size*/1"));
  assert.equal(patch(patchedPierre, pierreUrl), null);
  assert.equal(Function(`${patchedPierre};return render()`)().poolSize, 1);
  assert.equal(patch(pierreSource.replace("poolSize:4", "poolSize:1"), pierreUrl), null);

  // 2. Orbit character preload iframe: d() becomes a callable no-op while preserving Oz/iE.
  const orbitUrl = "app://-/assets/async/198194.4d5c9b6c90.js";
  const orbitSource = 'var o={a:()=>"/frame.html"},c={prefetch(){spy.prefetch+=1}},s={s(){spy.s+=1}},l=!1,a={d(_t,_e,exports){exports.Oz=function(){d(),(0,s.s)()},exports.iE=d}};function d(){let e=(0,o.a)();if("u"<typeof document||null==e||(c.prefetch(),l))return;l=!0;let t=document.createElement("iframe"),a=new URL(e,document.baseURI);a.searchParams.set("preload",""),t.src=a.href,t.hidden=!0,t.setAttribute("sandbox","allow-scripts allow-same-origin"),t.allow="cross-origin-isolated";let n=new AbortController,r=window.setTimeout(i,3e4);function i(){window.clearTimeout(r),n.abort(),t.remove()}window.addEventListener("message",e=>{e.source===t.contentWindow&&e.origin===window.location.origin&&"orbit-character-preloaded"===e.data&&i()},{signal:n.signal}),window.addEventListener("pagehide",i,{once:!0,signal:n.signal}),document.body.append(t)}const out={};a.d(null,null,out);';
  const patchedOrbit = patch(orbitSource, orbitUrl);
  assert.ok(patchedOrbit?.includes("/*codey-orbit-preload-skip*/"));
  assert.equal(patch(patchedOrbit, orbitUrl), null);
  const appended = [];
  const spy = { prefetch: 0, s: 0 };
  const api = Function(
    "spy",
    "document",
    "window",
    `${patchedOrbit};return out`,
  )(
    spy,
    { baseURI: "https://example.invalid/", createElement: () => ({}), body: { append: (el) => appended.push(el) } },
    { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, location: { origin: "https://example.invalid" } },
  );
  api.Oz();
  api.iE();
  assert.equal(spy.prefetch, 0);
  assert.equal(spy.s, 1);
  assert.equal(appended.length, 0);

  // 3. Startup secondary route prefetch: e_() becomes a no-op without prefetching settings/dialog chunks.
  const prefetchUrl = "app://-/assets/async/55935.5583618e49.js";
  const prefetchSource = 'function e_(){ea.x.prefetch(),function(){for(let e of(O.B.prefetch(),["general-settings","appearance","keyboard-shortcuts"]))(0,en.OU)(e).catch(()=>void 0);Promise.all([t.e(1),t.e(2)]).then(t.bind(t,"njHN")).catch(()=>void 0)}()}';
  const patchedPrefetch = patch(prefetchSource, prefetchUrl);
  assert.ok(patchedPrefetch?.includes("/*codey-startup-prefetch-skip*/"));
  assert.equal(patch(patchedPrefetch, prefetchUrl), null);
  let prefetchCalls = 0;
  Function("ea", "O", "en", "t", `${patchedPrefetch};e_();`)(
    { x: { prefetch() { prefetchCalls += 1; } } },
    { B: { prefetch() { prefetchCalls += 1; } } },
    { OU: async () => { prefetchCalls += 1; } },
    { e() { prefetchCalls += 1; return Promise.resolve(); }, bind() {} },
  );
  assert.equal(prefetchCalls, 0);

  // 4. Sentry LoAF + longtask observer: neither PerformanceObserver nor nZ("longtask") runs, while sibling steps still execute.
  const sentryUrl = "app://-/assets/async/907538.0572f09d40.js";
  const sentrySource = 'function setup(){let ran=[],u=true,l=true,w={PerformanceObserver:class{constructor(){ran.push("po")}observe(){ran.push("observe")}}},PerformanceObserver={supportedEntryTypes:["long-animation-frame"]},e7="op";nZ=(kind)=>{ran.push(kind)};return o&&n7()&&eC()&&nZ("element"),u&&w.PerformanceObserver&&PerformanceObserver.supportedEntryTypes&&PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")?new PerformanceObserver(e=>{let t=tk();if(t)for(let n of e.getEntries()){n6(t,0,0,{attributes:{[e7]:"auto.ui.browser.metrics"}})}}).observe({type:"long-animation-frame",buffered:!0}):l&&nZ("longtask",({entries:e})=>{let t=tk();if(!t)return;let{op:n,start_timestamp:r}=tA(t);for(let i of e){let a=i.duration;n6(t,0,a,{name:"Main UI thread blocked",op:"ui.long-task",attributes:{[e7]:"auto.ui.browser.metrics"}})}}),_&&ran.push("after"),ran}';
  const patchedSentry = patch(sentrySource, sentryUrl);
  assert.ok(patchedSentry?.includes("/*codey-sentry-loaf-skip*/"));
  assert.equal(patch(patchedSentry, sentryUrl), null);
  const sentryRan = Function("o", "_", "n7", "eC", "tk", "tA", "n6", `${patchedSentry};return setup()`)(
    true, true, () => true, () => true, () => null, () => ({}), () => {},
  );
  assert.deepEqual(sentryRan, ["element", "after"]);

  // 5. Interaction LoAF + longtask observers: ensureObserver returns false cleanly.
  const interactionUrl = "app://-/assets/async/956370.aff5cce818.js";
  const interactionSource = 'class Tracker{start(){let n=this.ensureObserver("longtask"),i=this.ensureObserver("long-animation-frame");return{longAnimationFrameSupported:i,longTaskSupported:n}}ensureObserver(e){try{if(!this.isSupported(e))return!1}catch{return!1}if(null!=("longtask"===e?this.longTaskObserver:this.longAnimationFrameObserver))return!0;try{let t="longtask"===e?this.longTaskEntries:this.longAnimationFrameEntries,n=this.createObserver(e,e=>{t.push(...e)});return n.observe({buffered:!0,type:e}),"longtask"===e?this.longTaskObserver=n:this.longAnimationFrameObserver=n,!0}catch{return!1}}}';
  const patchedInteraction = patch(interactionSource, interactionUrl);
  assert.ok(patchedInteraction?.includes("/*codey-interaction-loaf-skip*/"));
  assert.equal(patch(patchedInteraction, interactionUrl), null);
  let createdObservers = 0;
  const Tracker = Function(`${patchedInteraction};return Tracker`)();
  const tracker = new Tracker();
  tracker.isSupported = () => true;
  tracker.createObserver = () => { createdObservers += 1; return { observe() {} }; };
  assert.deepEqual(tracker.start(), { longAnimationFrameSupported: false, longTaskSupported: false });
  assert.equal(createdObservers, 0);

  // 6. Codex pages pending observation sampler: 10s interval & doc listeners skipped, sendHeartbeat preserved.
  const pagesSource = 'function startObs(s,e,C){let r,n,l=()=>{},u=()=>{},d=()=>{};return n=C,s.add(n),1===s.size&&(r=setInterval(()=>{for(let e of[...s])e.sample()},1e4),document.addEventListener("visibilitychange",l),document.addEventListener("freeze",u),window.addEventListener("pagehide",d,!0)),e.count("codex_pages",`${p}_started`)}function afterObs(){return {p_pending_age_ms:"pending_age_ms",m:"_pending_observations"}}';
  const pagesWithHeartbeat = `${pagesSource}class Sync{sendHeartbeat=()=>{this.metrics.count("codex_pages","edit_pending_observations",{},0)}}`;
  const patchedPages = patch(pagesWithHeartbeat, sentryUrl);
  assert.ok(patchedPages?.includes("/*codey-pending-observations-sampler-skip*/"));
  assert.match(patchedPages, /sendHeartbeat=\(\)=>\{this\.metrics\.count/);
  assert.equal(patch(patchedPages, sentryUrl), null);
  let intervals = 0;
  let listeners = 0;
  const events = [];
  Function("p", "document", "window", "setInterval", "events", `${patchedPages};startObs(new Set,{count:(a,b)=>events.push([a,b])},{sample(){}})`)(
    "open",
    { addEventListener() { listeners += 1; } },
    { addEventListener() { listeners += 1; } },
    () => { intervals += 1; return 1; },
    events,
  );
  assert.equal(intervals, 0);
  assert.equal(listeners, 0);
  assert.deepEqual(events, [["codex_pages", "open_started"]]);

  assert.deepEqual(logs, []);
});

test("rspack Statsig startup gates bound post-login bootstrap, skip remote identity stall, and cap async client init", async () => {
  const { logs, patch } = await installPatch();
  const url = "app://-/assets/async/907538.0572f09d40.js";

  // 1. Post-login bootstrap timeout: 62500ms deadline -> 5000ms (5e3), 1e4 attempt timeout -> 4500ms.
  const bootstrapSource =
    'async function runBootstrap(){let n,r={auth:0,request:0},i=new AbortController,a=setTimeout(()=>{i.abort(new Ny("req_failed",Error("Reached the post-login Statsig bootstrap deadline")))},62500);try{return await async function(u){let d,h=new AbortController,_=u?AbortSignal.any([h.signal,u]):h.signal;function m(){clearTimeout(d),d=setTimeout(()=>{h.abort(Error("Timed out while fetching post-login Statsig bootstrap"))},1e4)}return m(),_.aborted}(i.signal)}finally{clearTimeout(n),clearTimeout(a)}}';
  const patchedBootstrap = patch(bootstrapSource, url);
  assert.ok(patchedBootstrap?.includes("/*codey-statsig-bootstrap-deadline*/5e3"));
  assert.ok(patchedBootstrap?.includes("/*codey-statsig-bootstrap-attempt*/4500"));
  assert.equal(patch(patchedBootstrap, url), null, "bootstrap timeout patch is idempotent");
  const recordedDelays = [];
  await Function(
    "Ny",
    "c",
    "setTimeout",
    "clearTimeout",
    `${patchedBootstrap};return runBootstrap();`,
  )(
    class extends Error {},
    {},
    (fn, ms) => {
      recordedDelays.push(ms);
      return { fn, ms };
    },
    () => {},
  );
  assert.deepEqual(recordedDelays, [5000, 4500]);

  // 2. Fallback identity non-blocking: skips remote accounts/check wait while keeping local token wait.
  const identitySource =
    'function nJ(e){let t,n,r,i=(0,l.c)(17),{currentAccount:c,children:v}=e;let{data:y,isLoading:I,hasEverErrored:T}=useAccounts(void 0,t);let{isLoading:C}=useAccountInfo(n),A=c??y;if(C||I&&!T){let e;return i[2]===S?(e=jsx(Loader,{debugName:"CodexStatsigProvider.async.identity"}),i[2]=e):e=i[2],e}return i[3]=jsx(Fallback,{currentAccount:A,children:v}),i[3]}';
  const patchedIdentity = patch(identitySource, url);
  assert.ok(patchedIdentity?.includes("/*codey-statsig-identity-nonblocking*/"));
  assert.equal(patch(patchedIdentity, url), null, "identity non-blocking patch is idempotent");
  const runIdentity = ({ localLoading, accountsLoading, errored, accountsData }) =>
    Function(
      "l",
      "S",
      "jsx",
      "Loader",
      "Fallback",
      "useAccounts",
      "useAccountInfo",
      `${patchedIdentity};return nJ({currentAccount:undefined,children:"routes"});`,
    )(
      { c: (n) => Array(n).fill(Symbol.for("react.memo_cache_sentinel")) },
      Symbol.for("react.memo_cache_sentinel"),
      (type, props) => ({ type, props }),
      "Loader",
      "Fallback",
      () => ({ data: accountsData, isLoading: accountsLoading, hasEverErrored: errored }),
      () => ({ isLoading: localLoading }),
    );
  const localWaiting = runIdentity({
    localLoading: true,
    accountsLoading: false,
    errored: false,
    accountsData: undefined,
  });
  assert.equal(localWaiting.type, "Loader");
  assert.equal(localWaiting.props.debugName, "CodexStatsigProvider.async.identity");
  const remoteStalled = runIdentity({
    localLoading: false,
    accountsLoading: true,
    errored: false,
    accountsData: { id: "cached-account" },
  });
  assert.equal(remoteStalled.type, "Fallback");
  assert.deepEqual(remoteStalled.props.currentAccount, { id: "cached-account" });
  assert.equal(remoteStalled.props.children, "routes");

  // 3. Fallback async Statsig client init cap: fast init finishes cleanly; stalled init finalizes Ready at 1500ms.
  const asyncInitSource =
    'const t={};t.useStatsigInternalClientFactoryAsync=function(e,t){let n=(0,i.useMemo)(()=>{var n;return null!=(n=(0,r._getInstance)(t.sdkKey))?n:e(t)},[]),[a,s]=(0,i.useState)("Ready"!==n.loadingStatus);return(0,i.useMemo)(()=>{"Ready"!==n.loadingStatus&&n.initializeAsync().catch(r.Log.error).finally(()=>s(!1))},[]),{client:n,isLoading:a}}';
  const patchedAsync = patch(asyncInitSource, url);
  assert.ok(patchedAsync?.includes("/*codey-statsig-async-init-cap*/"));
  assert.equal(patch(patchedAsync, url), null, "async init cap patch is idempotent");

  const runAsyncFactory = ({ resolveImmediately }) => {
    let resolveInit;
    const finalizedWith = [];
    const loadingChanges = [];
    const timers = new Map();
    const clearedTimers = [];
    let nextTimerId = 1;
    const client = {
      loadingStatus: "Loading",
      initializeAsync: () =>
        new Promise((resolve) => {
          resolveInit = () => {
            client.loadingStatus = "Ready";
            resolve({ success: true });
          };
          if (resolveImmediately) resolveInit();
        }),
      _finalizeUpdate(values) {
        finalizedWith.push(values);
        client.loadingStatus = "Ready";
      },
    };
    const api = Function(
      "client",
      "i",
      "r",
      "setTimeout",
      "clearTimeout",
      `${patchedAsync};return t.useStatsigInternalClientFactoryAsync(()=>client,{sdkKey:"k"});`,
    )(
      client,
      {
        useMemo: (fn) => fn(),
        useState: (initial) => [
          initial,
          (next) => {
            loadingChanges.push(next);
          },
        ],
      },
      {
        _getInstance: () => null,
        Log: { error() {} },
      },
      (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      (id) => {
        clearedTimers.push(id);
        timers.delete(id);
      },
    );
    return { api, client, finalizedWith, loadingChanges, timers, clearedTimers, resolveInit: () => resolveInit() };
  };

  const fast = runAsyncFactory({ resolveImmediately: true });
  assert.equal(fast.api.client, fast.client);
  assert.equal(fast.api.isLoading, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fast.finalizedWith, []);
  assert.deepEqual(fast.loadingChanges, [false]);
  assert.equal(fast.timers.size, 0);
  assert.deepEqual(fast.clearedTimers, [1]);

  const stalled = runAsyncFactory({ resolveImmediately: false });
  assert.equal(stalled.timers.get(1)?.ms, 1500);
  assert.deepEqual(stalled.finalizedWith, []);
  assert.deepEqual(stalled.loadingChanges, []);
  stalled.timers.get(1).fn();
  assert.deepEqual(stalled.finalizedWith, [null]);
  assert.equal(stalled.client.loadingStatus, "Ready");
  assert.deepEqual(stalled.loadingChanges, [false]);
  stalled.resolveInit();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stalled.finalizedWith, [null]);
  assert.deepEqual(stalled.loadingChanges, [false]);

  assert.deepEqual(logs, []);
});

test("real request reader clears a stale Fast tier after changing models", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch } = await installPatch();
  const request = await readFile(new URL("./fixtures/codex-service-tier.js", import.meta.url), "utf8");
  const shared = await readFile(new URL("./fixtures/codex-service-tier-shared.js", import.meta.url), "utf8");
  const native = runInNewContext(`${shared};({DS:p,Pd:d,E_:m,W6:i,uw:s})`);
  const models = [
    { model: "fast-model", serviceTiers: [{ id: "priority", name: "Fast" }] },
    { model: "standard-model", serviceTiers: [] },
  ];
  const scope = { get: () => ({ type: "fromConfig" }), query: { setData() {} } };
  const read = runInNewContext(`${patch(request) ?? request};c`, {
    d: { ...native, qh: (selection) => selection.serviceTier }, r: native,
    i: { V: () => ({ sendRequest: async () => ({ data: models }) }) },
    a: { QN: "selection" }, o: { s: async () => "chatgpt" },
    l: { Wr: async () => ({ requirements: { featureRequirements: { fast_mode: true } } }) },
    s: { ig: async () => ({ config: { model: "standard-model", service_tier: "priority" } }), Y$: (value) => value },
    u: { v: { error: (message) => { throw Error(message); } } },
  });
  assert.equal(await read(scope, "local", "fast-model", "priority"), "priority");
  assert.equal(await read(scope, "local", "standard-model", "priority"), null);
  assert.equal(await read(scope, "local", "standard-model"), null);
  scope.get = () => ({ type: "custom", serviceTier: "priority" });
  assert.equal(await read(scope, "local", "standard-model"), null);
});

test("Codex 26.1103 inline request reader clears a stale Fast tier after changing models", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const request = await readFile(new URL("./fixtures/codex-service-tier-26.1103.js", import.meta.url), "utf8");
  const shared = await readFile(new URL("./fixtures/codex-service-tier-shared.js", import.meta.url), "utf8");
  const native = runInNewContext(`${shared};({DS:p,Pd:d,E_:m,W6:i,uw:s})`);
  const models = [
    { model: "fast-model", serviceTiers: [{ id: "priority", name: "Fast" }] },
    { model: "standard-model", serviceTiers: [] },
  ];
  const scope = { get: () => ({ type: "fromConfig" }), query: { setData() {} } };
  const patched = patch(request);
  assert.equal(typeof patched, "string");
  assert.equal(patch(patched), null);
  const read = runInNewContext(patched, {
    u: { ...native, qh: (selection) => selection.serviceTier }, r: native,
    i: { V: () => ({ sendRequest: async () => ({ data: models }) }) },
    a: { QN: "selection" }, l: { s: async () => "chatgpt" },
    s: { Wr: async () => ({ requirements: { featureRequirements: { fast_mode: true } } }), b9: "requirements" },
    o: { ig: async () => ({ config: { model: "standard-model", service_tier: "priority" } }), Y$: (value) => value },
    d: { v: { error: (message) => { throw Error(message); } } },
  });
  assert.equal(await read(scope, "local", "fast-model", "priority"), "priority");
  assert.equal(await read(scope, "local", "standard-model", "priority"), null);
  assert.equal(await read(scope, "local", "standard-model"), null);
  scope.get = () => ({ type: "custom", serviceTier: "priority" });
  assert.equal(await read(scope, "local", "standard-model"), null);
  assert.deepEqual(logs, []);
});

test("Codex 26.1117 provider-scoped request reader validates tiers against that provider's models", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const request = await readFile(new URL("./fixtures/codex-service-tier-26.1117.js", import.meta.url), "utf8");
  const shared = await readFile(new URL("./fixtures/codex-service-tier-shared.js", import.meta.url), "utf8");
  const native = runInNewContext(`${shared};({DS:p,Pd:d,E_:m,W6:i,uw:s})`);
  const catalogs = {
    "provider-a": [{ model: "shared-model", serviceTiers: [{ id: "priority", name: "Fast" }] }],
    "provider-b": [{ model: "shared-model", serviceTiers: [] }],
  };
  const listed = [];
  const scope = { get: () => ({ type: "fromConfig" }), query: { setData() {} } };
  const patched = patch(request);
  assert.equal(typeof patched, "string");
  assert.equal(patch(patched), null);
  const read = runInNewContext(patched, {
    d: { ...native, qh: (selection) => selection.serviceTier }, r: native,
    o: { V: () => ({ sendRequest: async (method, params) => { listed.push(params.modelProvider); return { data: catalogs[params.modelProvider] ?? [] }; } }) },
    i: { QN: "selection" }, a: { s: async () => "chatgpt" },
    s: { Wr: async () => ({ requirements: { featureRequirements: { fast_mode: true } } }), b9: "requirements" },
    l: { ig: async () => ({ config: { model: "shared-model", service_tier: "priority" } }), Y$: (value) => value },
    c: { v: { error: (message) => { throw Error(message); } } },
  });
  assert.equal(await read(scope, "local", "shared-model", "priority", "provider-a"), "priority");
  assert.equal(await read(scope, "local", "shared-model", "priority", "provider-b"), null);
  assert.equal(await read(scope, "local", undefined, undefined, "provider-b"), null, "the configured tier is checked too");
  assert.deepEqual(listed, ["provider-a", "provider-b", "provider-b"], "every lookup keeps the caller's provider");
  assert.deepEqual(logs, []);
});

test("Codex 26.1117 request client keeps the abort check after the route preflight", async () => {
  const { logs, patch } = await installPatch();
  const source = [
    'class C{async sendRequest(e,t,n){if(null==this.dispatchMessage)throw Error("AppServerRequestClient is missing a message dispatcher");return this.enqueueRequest(e,t,n)}',
    'enqueueRequest(e,t,n,r=t=>{this.dispatchMessage?.("mcp-request",{request:t,hostId:this.hostId,retainResponse:void 0,source:n?.source,timeoutMs:n?.timeoutMs,widget:n?.widget})},i=null,a){if(a?.aborted)return Promise.reject(Error("App-server request cancelled"));let s=1;log("mcp_request_enqueued");let{request:o,promise:l}=this.createRequest(e,t,n,i);r(o);return l}',
    'createRequest(e,t){return{request:{method:e,params:t},promise:Promise.resolve([e,t])}}',
    'onResult(e,t){let r=this.requestPromises.get(e);r.resolve(t),this.emitRequestLifecycleEvent({type:"completed",hostId:this.hostId,method:r.method,id:e})}}',
  ].join("");
  const patched = patch(source);
  assert.ok(patched.includes("let __codeyRoute=globalThis.__codeyModelWhitelistPatch?.rewriteOutgoingMessage"));
  assert.equal(patch(patched), null);
  const Client = Function("log", `${patched};return C`)(() => {});
  const client = new Client();
  client.dispatchMessage = () => {};
  globalThis.__codeyModelWhitelistPatch = {
    rewriteOutgoingMessage: (message) => ({ ...message, request: { ...message.request, params: { routed: true } } }),
  };
  assert.deepEqual(await client.enqueueRequest("model/list", {}, {}), ["model/list", { routed: true }]);
  await assert.rejects(client.enqueueRequest("model/list", {}, {}, undefined, null, { aborted: true }), /cancelled/);
  assert.deepEqual(logs, []);
});

test("Codex 26.1117 manager registry and reconciliation use history attachment and the active turn", async () => {
  const { logs, patch } = await installPatch();
  const manager = [
    "class M{getHostId(){return\"local\"}getConversation(e){return this.threadStore.getConversation(e)}hasLocalHistorySubscription(e){return this.streamState.hasLocalHistorySubscription(e)}",
    "updateConversationState(e,t){t(this.threadStore.getConversation(e))}getThreadExecutionState(e,t){let n=this.getConversation(e);return null==n?null:{inProgress:el(n),activeTurnId:n.activeTurnId??null}}",
    "async sendRequest(e,t){return this.reads.shift()}async resumeConversation(e){this.resumed.push(e);this.threadStore.getConversation(e.conversationId).running=!1}",
    "clear(){this.inactiveThreadUnsubscriber.clearConversationStreamOwnership(1)}",
    "getHasInProgressLocalConversation({exceptConversationId:e}={}){for(let t of this.threadStore.getRecentConversationIds()){if(t===e)continue;let n=this.conversations.get(t);if(null!=n&&el(n))return!0}return!1}}",
  ].join("");
  const patched = patch(manager);
  assert.match(patched, /codey-app-server-manager-registry/);
  assert.match(patched, /async codeyReconcileCompletedConversation\(/);
  assert.equal(patch(patched), null);
  const Manager = Function("el", `${patched};return M`)((conversation) => conversation.running === true);
  const create = ({ attached = true, activeTurnId = "turn-1" } = {}) => {
    const conversation = { running: true, activeTurnId, cwd: "/work" };
    const instance = new Manager();
    Object.assign(instance, {
      threadStore: { getConversation: () => conversation },
      streamState: { hasLocalHistorySubscription: () => attached },
      inactiveThreadUnsubscriber: { clearConversationStreamOwnership: () => { instance.cleared = true; } },
      reads: [{ thread: { status: { type: "idle" } } }, { thread: { status: { type: "idle" } } }],
      resumed: [],
    });
    return { instance, conversation };
  };
  delete globalThis.__codeyAppServerManagers;
  const owned = create();
  owned.instance.getConversation("thread-1");
  assert.equal(globalThis.__codeyAppServerManagers.get("local"), owned.instance);
  assert.equal(await owned.instance.codeyReconcileCompletedConversation({ conversationId: "thread-1" }), true);
  assert.equal(owned.instance.cleared, true);
  assert.equal(owned.conversation.resumeState, "needs_resume");
  assert.deepEqual(owned.instance.resumed.map((params) => params.workspaceRoots), [["/work"]]);
  for (const options of [{ attached: false }, { activeTurnId: null }]) {
    const skipped = create(options);
    assert.equal(await skipped.instance.codeyReconcileCompletedConversation({ conversationId: "thread-1" }), false);
    assert.equal(skipped.instance.cleared, undefined, JSON.stringify(options));
  }
  delete globalThis.__codeyAppServerManagers;
  assert.deepEqual(logs, []);
});

test("real shared permissions grant null access and preserve explicit account denial", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const source = await readFile(new URL("./fixtures/codex-service-tier-shared.js", import.meta.url), "utf8");
  const check = runInNewContext(`${patch(source)};s`);
  assert.equal(check("priority", null), true);
  assert.equal(check("ultrafast", null), true);
  assert.equal(check("priority", { fast: false, ultrafast: true }), false);
  assert.equal(check("ultrafast", { fast: true, ultrafast: false }), false);
  assert.equal(check("priority", { fast: true }), true);
  assert.equal(check("default", { fast: false }), true);
  assert.equal(check("flex", { fast: false }), true);
  assert.deepEqual(logs, []);
});

test("all nine real access hooks grant only null native access and retain loading state", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const fixtureDir = new URL("./fixtures/", import.meta.url);
  const files = (await readdir(fixtureDir)).filter(name => name.startsWith("codex-service-tier-access-"));
  assert.equal(files.length, 9);
  const shared = await readFile(new URL("codex-service-tier-shared.js", fixtureDir), "utf8");
  const requirementsAccess = runInNewContext(`${shared};i`);
  for (const file of files) {
    const source = await readFile(new URL(file, fixtureDir), "utf8");
    const patched = patch(source);
    assert.equal(typeof patched, "string", file);
    const name = source.match(/function (\w+)\(e\)/)[1];
    for (const authMethod of ["apikey", "chatgpt", "personalAccessToken", "amazonBedrock"]) {
      for (const pending of [false, true]) {
        for (const requirements of [null, { requirements: { featureRequirements: { fast_mode: false } } }]) {
          const cache = [];
          let nativeAccess;
          const module = {
            c: () => cache, Ul: () => "local", Dc: "host", b9: "requirements",
            tn: () => ({ authMethod, isLoading: false }),
            _U: () => ({ data: requirements, isPending: pending }),
            W6: (value) => (nativeAccess = requirementsAccess(value)),
          };
          const imports = Object.fromEntries([...source.matchAll(/\b(\w+)\.(?:c|Ul|Dc|b9|tn|_U|W6)\b/g)].map(match => [match[1], module]));
          const hook = runInNewContext(`${patched};${name}`, imports);
          const result = hook({ hostId: "local" });
          assert.equal(result.isLoading, authMethod !== "apikey" && pending, file);
          if (nativeAccess) {
            assert.equal(result.serviceTierAccess, nativeAccess, "retain the native non-null object identity");
            assert.equal(result.serviceTierAccess.fast, false, file);
          } else {
            assert.deepEqual({ ...result.serviceTierAccess }, { fast: true, ultrafast: true }, file);
          }
          assert.equal(hook({ hostId: "local" }), result, "React memoization remains stable");
        }
      }
    }
  }
  assert.deepEqual(logs, []);
});

test("real model filter keeps hidden and restricted models while admitting visible catalog models", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const source = await readFile(new URL("./fixtures/codex-model-filter.js", import.meta.url), "utf8");
  const filter = runInNewContext(`${patch(source)};i`, { r: { eE: () => true } });
  const models = [
    { model: "visible", hidden: false, supportedReasoningEfforts: [] },
    { model: "hidden", hidden: true, supportedReasoningEfforts: [] },
    { model: "restricted", hidden: false, availableAccessPrograms: { cyber: ["cyber"] }, supportedReasoningEfforts: [] },
  ];
  const options = { availableModels: new Set(["hidden"]), enabledReasoningEfforts: new Set(), useHiddenModels: true, models };
  assert.deepEqual(Array.from(filter({ ...options, authMethod: "chatgpt" }).models, model => model.model), ["visible", "hidden", "restricted"]);
  assert.deepEqual(Array.from(filter({ ...options, authMethod: "apikey" }).models, model => model.model), ["visible"]);
  assert.deepEqual(logs, []);
});

test("real locale gate selects Chinese before the first render", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { patch, logs } = await installPatch();
  const source = await readFile(new URL("./fixtures/codex-locale.js", import.meta.url), "utf8");
  const patched = patch(source);
  assert.equal(typeof patched, "string");
  Function(patched);
  const prefix = patched.slice(0, patched.indexOf("e:{"));
  const resolve = runInNewContext(`${prefix}return{enabled:M,source:L,override:P}};I`, {
    i: { c: () => [] }, s: { gh() {}, Ul: () => ({ data: { ideLocale: "en-US", systemLocale: "en-US" } }) },
    d: {}, m: {}, p: { Ou: () => ({ get: (_key, fallback) => fallback }) }, g: { sd: () => false },
  });
  assert.deepEqual({ ...resolve({}) }, { enabled: true, source: "SYSTEM", override: "zh-CN" });
  assert.deepEqual(logs, []);
});

test("rspack stylesheet assets rewrite data-state :has() rules without touching unrelated css", async () => {
  const { logs, patch } = await installPatch();
  const mainCss = [
    ".group-has-\\[\\[data-state\\=open\\]\\]\\:opacity-100:is(:where(.group):has([data-state=open]) *){opacity:1}",
    ".group-has-\\[\\[data-state\\=open\\]\\]\\/project-source\\:opacity-100:is(:where(.group\\/project-source):has([data-state=open]) *){opacity:1}",
    ".group-has-\\[\\[aria-expanded\\=true\\]\\,\\[data-state\\=open\\]\\]\\:opacity-100:is(:where(.group):has([aria-expanded=true],[data-state=open]) *){opacity:1}",
    ".has-\\[\\[data-state\\=open\\]\\]\\:opacity-100:has([data-state=open]){opacity:1}",
    ".has-\\[button\\[data-state\\=open\\]\\]\\:opacity-100:has(:is(button[data-state=open])){opacity:1}",
  ].join("");
  const patchedMain = patch(mainCss, "app://-/assets/async/e77f816560c6.css");
  assert.ok(patchedMain, "hashed async stylesheet should be patched");
  assert.doesNotMatch(patchedMain, /:has\([^)]*data-state/);
  assert.match(patchedMain, /:where\(\.group\)\[data-codey-open-within\]/);
  assert.match(patchedMain, /:where\(\.group\\\/project-source\)\[data-codey-open-within\]/);
  assert.match(
    patchedMain,
    /:where\(\.group\):is\(:has\(\[aria-expanded=true\]\),\[data-codey-open-within\]\)/,
  );
  assert.match(patchedMain, /\.has-\\\[\\\[data-state\\=open\\\]\\\]\\:opacity-100\[data-codey-open-within\]/);
  assert.match(patchedMain, /\.has-\\\[button\\\[data-state\\=open\\\]\\\]\\:opacity-100\[data-codey-open-within\]/);
  assert.match(patchedMain, /:root\{--codey-css-open-state-has-patched:1\}/);
  assert.equal(
    patch(patchedMain, "app://-/assets/async/e77f816560c6.css"),
    null,
    "patched stylesheet is idempotent",
  );

  const notHasCss = ".a:not(:has([data-state=\"open\"])){opacity:1}.b:not(:has(:is(button[data-state='open']))){opacity:1}.c:not(:focus-within):not(:has( [ data-state = open ] )){opacity:1}";
  const patchedNotHas = patch(notHasCss, "app://-/assets/async/not-has-0123abcd.css");
  assert.ok(patchedNotHas);
  assert.match(
    patchedNotHas,
    /^\.a:not\(\[data-codey-open-within\]\)\{opacity:1\}\.b:not\(\[data-codey-open-within\]\)\{opacity:1\}\.c:not\(:focus-within\):not\(\[data-codey-open-within\]\)\{opacity:1\}\n/,
  );

  const cardCss = ":where(.card-ineZLT):has(>[data-state=open]),:where(.card-ineZLT>*):has(>[data-state=open]){opacity:1!important}";
  const patchedCard = patch(cardCss, "app://-/assets/async/166572aa20c2.css");
  assert.ok(patchedCard);
  assert.doesNotMatch(patchedCard, /:has\([^)]*data-state/);
  assert.match(
    patchedCard,
    /:where\(\.card-ineZLT\)\[data-codey-open-within\],:where\(\.card-ineZLT>\*\)\[data-codey-open-within\]/,
  );

  assert.equal(
    patch(".plain{color:red}[data-state=open]{opacity:1}", "app://-/assets/async/9012f383f623.css"),
    null,
    "stylesheets without :has(...data-state...) pass through unchanged",
  );
  assert.equal(
    patch(mainCss, "app://-/assets/unhashed.css"),
    null,
    "unhashed css urls are ignored",
  );
  assert.deepEqual(logs, []);
});
