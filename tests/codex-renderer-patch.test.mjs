import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

// 原样摘自 Codex 26.1007.71326 的 app-initial-1ab6fbe93c4f.js。
// 该缓存版本与用户日志版本不同，只验证已取得的真实函数形态。
const nativeCatalogModelFilterFixture = "function ERi({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:o,useHiddenModels:s}){let c=o.availableAccessPrograms?.cyber;return n===`apikey`&&!t&&c!=null&&c.length>0&&!c.includes(`standard`)?!1:e?.has(o.model)===!0||o.model!==`codex-auto-review`&&(i&&!o.hidden||(s&&!a&&n!==`amazonBedrock`?r.has(o.model)||n===`apikey`&&t&&!o.hidden&&c?.some(e=>e!==`standard`)===!0:!o.hidden))}";

async function captureRendererPatch(source) {
  const records = [];
  const savedLog = globalThis.__codeyPatchLog;
  const savedError = console.error;
  globalThis.__codeyPatchLog = (record) => records.push(JSON.parse(record));
  console.error = () => {};
  try {
    (0, eval)(await loadStartupPatchTemplate());
    const patch = () => globalThis.__codeyRendererPatchEntry(
      "app://-/assets/app-initial-model-filter-diagnostic.js", source,
    ) ?? source;
    const patched = patch();
    assert.equal(patch(), patched, "repeated requests retain the same patch result");
    return { patched, records };
  } finally {
    if (savedLog === undefined) delete globalThis.__codeyPatchLog;
    else globalThis.__codeyPatchLog = savedLog;
    console.error = savedError;
  }
}

test("model failure excerpts select filter code ahead of unrelated Fast anchors and remain bounded", async () => {
  const driftedFilter = nativeCatalogModelFilterFixture.replace("s&&!a&&", "s&&a&&");
  const source = [
    "const unrelated=`composer.toggleFastMode`,selectedServiceTier=`fast`;",
    "/* unrelated static asset region */".repeat(80),
    "const includeUltraReasoningEffort=true;",
    driftedFilter,
    "/* 模型过滤之后的静态代码 */",
    "/* unrelated static asset region */".repeat(80),
    "const isServiceTierAllowed=true;",
    "function settingsView(){if(!allowed||settings.availableOptions.length<=1)return null;return selectedServiceTier}",
  ].join("");
  const { patched, records } = await captureRendererPatch(source);
  assert.deepEqual(records.map(({ operation }) => operation), [
    "renderer_patch:model allowlist", "renderer_patch:model visibility",
    "renderer_patch:model-aware service tier control", "renderer_patch:model-aware Fast toggle",
  ], "each failed gate is recorded only once despite repeated requests");
  for (const { context } of records.slice(2)) {
    assert.match(context.excerpts.join("\n"), /composer\.toggleFastMode|selectedServiceTier/,
      "other gates retain their general diagnostic anchors");
  }
  assert.ok(patched.includes(driftedFilter), "unrecognized model rules remain unchanged");
  assert.match(patched, /if\(settings\.availableOptions\.length<=1\)return null/,
    "a failed model gate still permits an independent compatible patch");
  for (const { context } of records.slice(0, 2)) {
    assert.equal(context.matchCount, 0);
    assert.ok(context.excerpts.length > 0 && context.excerpts.length <= 2);
    for (const excerpt of context.excerpts) {
      assert.ok(excerpt.length > 0 && excerpt.length <= 640);
      assert.match(excerpt, /^[\x20-\x7E]+$/);
      assert.doesNotMatch(excerpt, /composer\.toggleFastMode|selectedServiceTier/);
    }
    const excerpt = context.excerpts.join("\n");
    assert.match(excerpt, /function ERi\(/);
    assert.match(excerpt, /r\.has\(o\.model\)/);
    assert.match(excerpt, /!o\.hidden/);
    assert.match(excerpt, /amazonBedrock/);
  }
});

test("native catalog model access keeps official, custom and hidden-model rules unchanged", async () => {
  const source = `const includeUltraReasoningEffort=true;${nativeCatalogModelFilterFixture}`;
  const { patched, records } = await captureRendererPatch(source);
  assert.equal(patched, source, "native access rules need no source rewrite");
  assert.deepEqual(records, [], "the real catalog-aware shape is not a compatibility failure");
  const filter = Function(`${patched};return ERi`)();
  const cases = [
    { label: "custom visible model bypasses the native allowlist", custom: true, expected: true },
    { label: "custom hidden model stays hidden even when allowlisted", custom: true, hidden: true, listed: true, expected: false },
    { label: "official visible model still requires the allowlist", expected: false },
    { label: "official allowlisted model is visible", listed: true, expected: true },
    { label: "official allowlisted hidden model is available", hidden: true, listed: true, expected: true },
    { label: "configured catalog permits a visible official model", catalog: true, expected: true },
    { label: "configured catalog does not expose a hidden custom model", custom: true, hidden: true, catalog: true, expected: false },
    { label: "Bedrock retains the visibility fallback", auth: "amazonBedrock", expected: true },
    { label: "API key cyber restriction remains before the custom-provider bypass", auth: "apikey", custom: true, cyber: ["cyber"], expected: false },
    { label: "supported API key cyber access retains its native branch", auth: "apikey", daybreak: true, cyber: ["cyber"], expected: true },
    { label: "auto-review is still excluded", custom: true, model: "codex-auto-review", expected: false },
    { label: "explicit additional availability is preserved", custom: true, hidden: true, additional: true, expected: true },
  ];
  for (const entry of cases) {
    const model = entry.model ?? "candidate";
    assert.equal(filter({
      additionalAvailableModels: new Set(entry.additional ? [model] : []),
      apiKeyDaybreakSupported: entry.daybreak ?? false,
      authMethod: entry.auth ?? "chatgpt",
      availableModels: new Set(entry.listed ? [model] : []),
      hasConfiguredModelCatalog: entry.catalog ?? false,
      isCustomModelProvider: entry.custom ?? false,
      model: { model, hidden: entry.hidden ?? false, availableAccessPrograms: { cyber: entry.cyber } },
      useHiddenModels: true,
    }), entry.expected, entry.label);
  }
});

test("similar model filters without the confirmed custom-provider bypass are still diagnosed", async () => {
  for (const filter of [
    nativeCatalogModelFilterFixture.replace("s&&!a&&", "s&&"),
    nativeCatalogModelFilterFixture.replace("s&&!a&&", "s&&a&&"),
    nativeCatalogModelFilterFixture.replace(":!o.hidden))", ":!o.hidden&&!a))"),
  ]) {
    const source = `const includeUltraReasoningEffort=true;${filter}`;
    const { patched, records } = await captureRendererPatch(source);
    assert.equal(patched, source);
    assert.deepEqual(records.map(({ operation }) => operation), [
      "renderer_patch:model allowlist", "renderer_patch:model visibility",
    ]);
  }
});

test("an incompatible optional renderer patch never blocks the Codex module response", async () => {
  const patchRecords = [];
  const patchErrors = [];
  const nativePatchLog = globalThis.__codeyPatchLog;
  const nativeConsoleError = console.error;
  globalThis.__codeyPatchLog = (record) => {
    patchRecords.push(JSON.parse(record));
  };
  console.error = (...args) => {
    patchErrors.push(args);
  };

  try {
    (0, eval)(await loadStartupPatchTemplate({ disablePet: true }));
    assert.equal(globalThis.__codeyRendererPatchInstalled, true);
    // Fetch interception entry: patched text means the response is rewritten,
    // null means the paused asset is fulfilled with its original body.
    const patch = (url, source) =>
      globalThis.__codeyRendererPatchEntry(url, source) ?? source;

    const incompatibleSource = [
      "useHiddenModels:",
      "availableModels:",
      "includeUltraReasoningEffort",
      "amazonBedrock",
    ].join(" ");
    const response = patch(
      "app://-/assets/app-initial-new-codex-build.js",
      incompatibleSource,
    );
    // Each incompatible gate is skipped independently (and logged) instead of one
    // throw discarding every gate on the asset. The response is never blocked and
    // the source is returned unchanged when nothing matched.
    assert.equal(response, incompatibleSource);
    assert.ok(patchErrors.length >= 1);
    for (const [message] of patchErrors) {
      assert.match(String(message), /incompatible Codex renderer patch/);
    }
    assert.deepEqual(
      patchRecords.map(({ operation }) => operation),
      [
        "renderer_patch:model allowlist",
        "renderer_patch:model visibility",
      ],
    );
    // Every skipped gate must carry printable excerpts around its neighborhood
    // anchors so an incompatible field bundle can be adapted without access to
    // that exact build.
    for (const record of patchRecords) {
      assert.equal(record.context.matchCount, 0);
      assert.ok(
        Array.isArray(record.context.excerpts) &&
          record.context.excerpts.length > 0 &&
          record.context.excerpts.every((excerpt) => excerpt.length > 0),
        `${record.operation} must carry anchor excerpts for field diagnosis`,
      );
      assert.match(
        record.context.excerpts.join("\n"),
        /useHiddenModels|includeUltraReasoningEffort/,
      );
    }

    const repeatedResponse = patch(
      "app://-/assets/app-initial-new-codex-build.js",
      incompatibleSource,
    );
    assert.equal(repeatedResponse, incompatibleSource);
    assert.equal(
      patchErrors.length,
      2,
      "the same incompatible source must not rerun failed renderer gates",
    );
    assert.equal(
      patchRecords.length,
      2,
      "the same incompatible source must not report the same gates again",
    );

    const currentRendererSource = [
      "const includeUltraReasoningEffort=!0,isServiceTierAllowed=!0;",
      "function currentModelFilter({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:r,model:i,useHiddenModels:a}){",
      "return e?.has(i.model)===!0||i.model!==`codex-auto-review`&&",
      "(a&&!r&&t!==`amazonBedrock`?n.has(i.model):!i.hidden)}",
      "function currentComposer(){",
      "let w=!1,F=!0,K=!1,xe=`fast`,M={availableOptions:[{value:`fast`}]};",
      "let Ee=!w&&F&&M.availableOptions.length>1;",
      "let Re=!w&&F&&!K&&xe!=null,ze={enabled:Re};",
      "OQ(`composer.toggleFastMode`,()=>{},ze);",
      "let de=!0,r=!1,pe=de&&!r,Se=`fast`,V=()=>{},H=()=>{},U=()=>{},z=!1,B={},te=[];",
      "let Ze=pe?{labelCandidates:te,onBlur:V,onPointerDown:H,onPointerLeave:U,",
      "selectedServiceTierIconKind:Se,showFastServiceTierIndicator:!0,tooltipOpen:z,triggerRef:B}:void 0;",
      "let view={modelPickerTriggerConfig:Ze,selectedServiceTierIconKind:Se};",
      "if(de&&Ze!=null)view.ready=!0;return {Ee,Re,pe,view}}",
      "`composer.intelligenceDropdown.model.title`;",
      "`composer.intelligenceDropdown.model.rowLabel`;",
    ].join("");
    const patchedCurrentRendererSource = patch(
      "app://-/assets/app-initial-current-codex-build.js",
      currentRendererSource,
    );
    assert.match(
      patchedCurrentRendererSource,
      /Ee=!w&&M\.availableOptions\.length>1/,
    );
    assert.match(patchedCurrentRendererSource, /Re=!w&&!K&&xe!=null/);
    assert.match(patchedCurrentRendererSource, /pe=!r/);
    assert.match(patchedCurrentRendererSource, /if\(Ze!=null\)/);
    assert.equal(
      patchErrors.length,
      2,
      "native-compatible model access and current Fast controls must not log skips",
    );

    const serviceTierControlGateOrderings = [
      "settings.availableOptions.length>1&&!draft&&allowed",
      "settings.availableOptions.length>1&&allowed&&!draft",
      "!draft&&settings.availableOptions.length>1&&allowed",
      "!draft&&allowed&&settings.availableOptions.length>1",
      "allowed&&!draft&&settings.availableOptions.length>1",
      "allowed&&settings.availableOptions.length>1&&!draft",
    ];
    for (const [index, gate] of serviceTierControlGateOrderings.entries()) {
      const reorderedServiceTierControlSource = [
        "const isServiceTierAllowed=!0;",
        "function nextComposer(){",
        "let draft=!1,allowed=!0,settings={availableOptions:[{value:`fast`},{value:`auto`}]};",
        "let loading=!1,fastOption=`fast`;",
        `let show=${gate};`,
        "OQ(`composer.toggleFastMode`,()=>{},{enabled:allowed&&!loading&&fastOption!=null});",
        "return show}",
      ].join("");
      const patchedReorderedServiceTierControlSource = patch(
        `app://-/assets/app-initial-reordered-service-tier-control-${index}.js`,
        reorderedServiceTierControlSource,
      );
      assert.match(
        patchedReorderedServiceTierControlSource,
        /show=(?:settings\.availableOptions\.length>1&&!draft|!draft&&settings\.availableOptions\.length>1)/,
      );
      assert.doesNotMatch(
        patchedReorderedServiceTierControlSource,
        /show=[^;]*allowed/,
      );
      assert.match(
        patchedReorderedServiceTierControlSource,
        /enabled:!loading&&fastOption!=null/,
      );
      assert.equal(
        patchErrors.length,
        2,
        "reordered service-tier control gates must patch without compatibility errors",
      );
    }

    // Electron 151 hoists the toggle gate into a memoized variable and can
    // place over 2KB of memo-cache code between the `availableOptions`
    // assignment and the `composer.toggleFastMode` registration.
    const memoizedGap = "t[99]===e?t[100]:(d(e),t[99]=e,t[100]=1),".repeat(90);
    const electron151ServiceTierSource = [
      "const isServiceTierAllowed=!0;",
      "let{isServiceTierAllowed:I}=G7o(F),N={availableOptions:[{value:`fast`}]};",
      "let w=!1,q=!1,Se=`fast`,Re=()=>{};",
      `let De=!w&&I&&N.availableOptions.length>1,${memoizedGap}`,
      "let ze=!w&&I&&!q&&Se!=null,Be;",
      "t[45]===ze?Be=t[46]:(Be={enabled:ze},t[45]=ze,t[46]=Be),",
      "U$(`composer.toggleFastMode`,Re,Be);",
    ].join("");
    const patchedElectron151Source = patch(
      "app://-/assets/app-initial-electron151-service-tier.js",
      electron151ServiceTierSource,
    );
    assert.match(
      patchedElectron151Source,
      /De=!w&&N\.availableOptions\.length>1/,
    );
    assert.doesNotMatch(
      patchedElectron151Source,
      /De=[^,]*&&I&&/,
      "the entitlement flag must be dropped from the model-aware gate",
    );
    assert.match(patchedElectron151Source, /ze=!w&&!q&&Se!=null/);
    assert.match(patchedElectron151Source, /\{enabled:ze\}/);
    assert.equal(
      patchErrors.length,
      2,
      "Electron 151 memoized service-tier gates must patch without compatibility errors",
    );

    // The wider Electron 151 window can also contain an unrelated, earlier
    // assignment with the same minified shape. Only the gate nearest the unique
    // toggle registration belongs to that control.
    const scopedMemoizedGap =
      "cache[99]===model?cache[100]:(touch(model),cache[99]=model,cache[100]=1);"
        .repeat(48);
    assert.ok(scopedMemoizedGap.length > 2048);
    const scopedServiceTierSource = [
      "const isServiceTierAllowed=!1;",
      "function unrelatedComposer(){",
      "let draft=!1,allowed=!1,settings={availableOptions:[1,2]};",
      "let unrelated=!draft&&allowed&&settings.availableOptions.length>1;",
      "return unrelated}",
      "function scopedComposer(OQ){",
      "let draft=!1,allowed=isServiceTierAllowed,settings={availableOptions:[1,2]};",
      "let show=!draft&&allowed&&settings.availableOptions.length>1;",
      "const cache=[],model={},touch=()=>{};",
      scopedMemoizedGap,
      "OQ(`composer.toggleFastMode`,()=>{},{enabled:show});return show}",
    ].join("");
    const patchedScopedServiceTierSource = patch(
      "app://-/assets/app-initial-scoped-service-tier.js",
      scopedServiceTierSource,
    );
    assert.match(
      patchedScopedServiceTierSource,
      /unrelated=!draft&&allowed&&settings\.availableOptions\.length>1/,
    );
    assert.match(
      patchedScopedServiceTierSource,
      /show=!draft&&settings\.availableOptions\.length>1/,
    );
    assert.doesNotThrow(() => Function(patchedScopedServiceTierSource));
    const scopedServiceTierResults = Function(
      `${patchedScopedServiceTierSource};return [` +
        "unrelatedComposer(),scopedComposer(()=>{})]",
    )();
    assert.deepEqual(scopedServiceTierResults, [false, true]);
    assert.equal(
      patchErrors.length,
      2,
      "an earlier same-shaped gate must not make the scoped Fast patch ambiguous",
    );

    // Electron 151 minifies `return!1` without a space and interleaves the
    // entitlement cache write between the chatgpt check and the fast_mode
    // requirement lookup.
    const electron151EntitlementSource = [
      "zp.error(`Failed to read service tier for request`,{safe:{},sensitive:{}});",
      "async function YHr(e,t){",
      "let n=await KHr(e,t);",
      "if(n!==`chatgpt`)return!1;",
      "let r=await N2t(e,t,{priority:`critical`});",
      "return e.query.setData(rx,{authMethod:n,hostId:t},r),",
      "r.requirements?.featureRequirements?.fast_mode!==!1}",
    ].join("");
    const patchedEntitlementSource = patch(
      "app://-/assets/app-initial-electron151-entitlement.js",
      electron151EntitlementSource,
    );
    assert.match(
      patchedEntitlementSource,
      /async function YHr\(e,t\)\{return!0\}/,
    );
    assert.doesNotMatch(patchedEntitlementSource, /chatgpt/);
    assert.equal(
      patchErrors.length,
      2,
      "the minified entitlement probe must patch without compatibility errors",
    );

    const routeBridgeSource = [
      "const routeLog={warning(){}};",
      "const routeTransport={postMessage:e=>{let t=!1,n=window.electronBridge;",
      "if(n?.sendMessageFromView){let r=e;n.sendMessageFromView(r).catch(t=>{",
      "r.type!==`log-message`&&routeLog.warning(`Failed to send message from view`,{message:e,error:t})",
      "}),t=!0}",
      "let r=new CustomEvent(`codex-message-from-view`,{detail:e});",
      "t&&(r.__codexForwardedViaBridge=!0),window.dispatchEvent(r)}};",
    ].join("");
    const patchedRouteBridgeSource = patch(
      "app://-/assets/app-initial-route-bridge.js",
      routeBridgeSource,
    );
    assert.match(
      patchedRouteBridgeSource,
      /globalThis\.__codeyModelWhitelistPatch\?\.rewriteOutgoingMessage\?\.\(e\)\?\?e/,
    );
    const sentMessages = [];
    const testRouteWindow = {
      electronBridge: {
        async sendMessageFromView(message) {
          sentMessages.push(message);
        },
      },
      dispatchEvent() {},
    };
    const routeGlobal = {
      __codeyModelWhitelistPatch: {
        rewriteOutgoingMessage(message) {
          return { ...message, tracked: true };
        },
      },
    };
    const routeTransport = Function(
      "window",
      "globalThis",
      "CustomEvent",
      `${patchedRouteBridgeSource};return routeTransport`,
    )(
      testRouteWindow,
      routeGlobal,
      class CustomEvent {
        constructor(type, init) {
          this.type = type;
          this.detail = init.detail;
        }
      },
    );
    routeTransport.postMessage({ type: "mcp-request", modelProvider: "openai" });
    await Promise.resolve();
    assert.deepEqual(sentMessages, [{
      type: "mcp-request",
      modelProvider: "openai",
      tracked: true,
    }]);
    routeTransport.postMessage({ type: "mcp-request", modelProvider: "openai" });
    await Promise.resolve();
    assert.deepEqual(sentMessages, [
      { type: "mcp-request", modelProvider: "openai", tracked: true },
      { type: "mcp-request", modelProvider: "openai", tracked: true },
    ]);
    assert.doesNotMatch(patchedRouteBridgeSource, /isBlockedOutgoingMessage/);
    assert.doesNotMatch(patchedRouteBridgeSource, /codey_router/);
    assert.equal(
      patchErrors.length,
      2,
      "the current Codex bridge preflight must patch without compatibility errors",
    );

    const appServerRequestSource = [
      "class AppServerRequestClient{",
      "constructor(){this.hostId=`local`;this.sent=[];this.queuedRequests=[];this.requestPromises=new Map();this.useHostRequestScheduler=!1;this.dispatchMessage=(e,t)=>this.sent.push({type:e,payload:t})}",
      "createRequest(e,t,n,r=null){return{request:{id:`req-1`,method:e,params:t},promise:Promise.resolve({ok:!0})}}",
      "startRequest(){} onError(){} pumpQueue(){let e=this.queuedRequests.shift();e?.dispatch()}",
      "enqueueRequest(e,t,n,r=t=>{this.dispatchMessage?.(`mcp-request`,{request:t,hostId:this.hostId,...t.trace==null?{}:{dispatchedAtMs:Date.now()},priority:Mjt(e,n),source:Ejt(e,n?.source),timeoutMs:n?.timeoutMs,expiresAtMs:n?.timeoutMs!=null&&n.timeoutMs>0?Date.now()+n.timeoutMs:void 0,widget:n?.widget})},i=null){let a=Mjt(e,n),o=Ejt(e,n?.source);let{request:s,promise:c}=this.createRequest(e,t,n,i);return this.queuedRequests.push({dispatch:()=>{this.startRequest(s);try{r(s)}catch(e){this.onError(s.id,e)}},priority:a}),this.pumpQueue(),c}",
      "emitRequestLifecycleEvent(){}",
      "onResult(e,t){let r=this.requestPromises.get(e);if(r){this.requestPromises.delete(e),r.resolve(t),this.emitRequestLifecycleEvent({type:`completed`,hostId:this.hostId,method:r.method})}}",
      "async sendRequest(e,t,n){return this.enqueueRequest(e,t,n)}",
      "}",
      "function Mjt(){return `critical`}function Ejt(){return `source`}",
      "const appServerPatchSignals=`AppServerRequestClient is missing a message dispatcher mcp_request_enqueued`;",
    ].join("");
    const patchedAppServerRequestSource = patch(
      "app://-/assets/app-initial-app-server-request-current-build.js",
      appServerRequestSource,
    );
    assert.match(
      patchedAppServerRequestSource,
      /__codeyModelWhitelistPatch\?\.rewriteOutgoingMessage/,
    );
    const routedAppServerTypes = [];
    const trackedAppServerMessages = [];
    const appServerGlobal = {
      __codeyModelWhitelistPatch: {
        rewriteOutgoingMessage(detail) {
          routedAppServerTypes.push(detail.type);
          return detail;
        },
        trackOutgoingMessage(detail) {
          trackedAppServerMessages.push(detail);
        },
        rewriteIncomingResult(method, result) {
          return method === "model/list"
            ? { ...result, data: [...result.data, { model: "route/model" }] }
            : result;
        },
      },
    };
    const AppServerRequestClient = Function(
      "globalThis",
      "Date",
      `${patchedAppServerRequestSource};return AppServerRequestClient`,
    )(appServerGlobal, Date);
    const requestClient = new AppServerRequestClient();
    await requestClient.enqueueRequest("thread/start", {
      model: "gpt-5.5",
      model_provider: "openai",
    }, {});
    assert.deepEqual(requestClient.sent[0].payload.request.params, {
      model: "gpt-5.5",
      model_provider: "openai",
    });
    await requestClient.enqueueRequest("thread/start", {
      model: "gpt-5.5",
      model_provider: "openai",
    }, {}, (request) => {
      requestClient.dispatchMessage?.("thread-prewarm-start", {
        request,
        hostId: requestClient.hostId,
      });
    });
    assert.equal(routedAppServerTypes.at(-1), "mcp-request");
    assert.deepEqual(requestClient.sent[1].payload.request.params, {
      model: "gpt-5.5",
      model_provider: "openai",
    });
    await requestClient.enqueueRequest("thread/start", { model: "gpt-5.5" }, {});
    assert.equal(requestClient.sent.length, 3);
    assert.equal(trackedAppServerMessages.length, 3);
    assert.deepEqual(trackedAppServerMessages[0], {
      type: "mcp-request",
      request: requestClient.sent[0].payload.request,
    });
    const modelListResults = [];
    requestClient.requestPromises.set("model-list", {
      method: "model/list",
      resolve(result) {
        modelListResults.push(result);
      },
    });
    requestClient.onResult("model-list", { data: [{ model: "gpt-5.6-sol" }] });
    assert.deepEqual(modelListResults, [{
      data: [{ model: "gpt-5.6-sol" }, { model: "route/model" }],
    }]);
    assert.doesNotMatch(patchedAppServerRequestSource, /codey_router/);
    assert.doesNotMatch(patchedAppServerRequestSource, /Codey blocked cross-provider/);
    assert.equal(
      patchErrors.length,
      2,
      "the AppServerRequestClient route preflight must patch without compatibility errors",
    );

    const petSettingsSource = [
      "import{AvatarPreview as P,builtInPets as L}",
      "from\"./codex-avatar-BpKnWN_W.js\";",
      "const petSettingsId=`settings.appearance.pets.title`;",
      "function renderPetSettings(){return [P(),L.map(()=>1),petSettingsId]}",
    ].join("");
    const patchedPetSettingsSource = patch(
      "app://-/assets/general-settings-current-build.js",
      petSettingsSource,
    );
    assert.doesNotMatch(patchedPetSettingsSource, /codex-avatar-/);
    assert.match(
      patchedPetSettingsSource,
      /const P=\(\(\)=>\{const target=function\(\)\{return null\}/,
    );
    const renderPetSettings = Function(
      `${patchedPetSettingsSource};return renderPetSettings`,
    )();
    assert.deepEqual(renderPetSettings(), [
      null,
      [],
      "settings.appearance.pets.title",
    ]);

    const sideEffectPetSettingsSource = [
      "import\"./codex-avatar-next-build.js\";",
      "const petSettingsId=`settings.pets.title`;",
    ].join("");
    const patchedSideEffectPetSettingsSource = patch(
      "app://-/assets/pet-settings-next-build.js",
      sideEffectPetSettingsSource,
    );
    assert.doesNotMatch(patchedSideEffectPetSettingsSource, /codex-avatar-/);
    assert.match(
      patchedSideEffectPetSettingsSource,
      /const petSettingsId=`settings\.pets\.title`/,
    );

    // Current Codex builds split the pets/Mini preview across three chunks and
    // drop the semicolon after each import, so every one of them has to be
    // stubbed from the same settings route chunk.
    const currentPetSettingsSource = [
      "import{f as Rt,m as zt,r as Bt,t as Vt}from\"./avatar-mascot-button-7586001b9adf.js\"",
      "import{n as Ht,t as Ut}from\"./codex-pet-assets-5f01c10f2955.js\"",
      "import{n as Yt,t as Xt}from\"./use-avatar-options-fda035de15fb.js\"",
      "const miniSettingsId=`settings.mini.show`;",
      "function renderMiniSettings(){return [Rt(),Ht(),Yt(),miniSettingsId]}",
    ].join("\n");
    const patchedCurrentPetSettingsSource = patch(
      "app://-/assets/pets-settings-route-551771c3ecb9.js",
      currentPetSettingsSource,
    );
    assert.doesNotMatch(
      patchedCurrentPetSettingsSource,
      /(avatar-mascot-button|codex-pet-assets|use-avatar-options)-/,
    );
    const renderMiniSettings = Function(
      `${patchedCurrentPetSettingsSource};return renderMiniSettings`,
    )();
    assert.deepEqual(renderMiniSettings(), [
      null,
      null,
      null,
      "settings.mini.show",
    ]);

    const localeSource = [
      "function resolveLocale(a,bp,Au){",
      "const dynamicConfigId=`72216192`,enableI18n=`enable_i18n`;",
      "let o=a?.get(enableI18n,!1);",
      "let s=o,c=a?.get(`locale_source`,`IDE`),l=bp(Au.localeOverride);",
      "return {enabled:s,source:c,locale:l}}",
    ].join("");
    // Current builds resolve the locale in the host-services chunk.
    const patchedLocaleSource = patch(
      "app://-/assets/initialize-app-host-services-b944587b60fb.js",
      localeSource,
    );
    assert.match(
      patchedLocaleSource,
      /__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__=!0/,
    );
    assert.doesNotMatch(
      patchedLocaleSource,
      /let s=o,c=a\?\.get\(`locale_source`,`IDE`\),l=bp\(Au\.localeOverride\)/,
    );
    delete globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__;
    const resolveLocale = Function(`${patchedLocaleSource};return resolveLocale`)();
    assert.deepEqual(
      resolveLocale(
        { get: () => false },
        () => "en-US",
        { localeOverride: {} },
      ),
      { enabled: true, source: "SYSTEM", locale: "zh-CN" },
    );
    assert.equal(
      globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__,
      true,
    );
    delete globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__;

    const localePropsSource = [
      "function provider(E){return E.localeOverride}",
      "function resolveProps(a,o,r,H3){const dynamicConfigId=`72216192`;",
      "let s=o?.get(`enable_i18n`,!1);",
      "let c=s,l=o?.get(`locale_source`,`IDE`),u=a?.ideLocale,d=a?.systemLocale,f=H3(r),p;",
      "bb0:{if(r){p=r;break bb0}if(l===`SYSTEM`){p=d;break bb0}p=u}",
      "return {enabled:c,source:l,locale:p,english:f}}",
    ].join("");
    const patchedLocaleProps = patch(
      "app://-/assets/app-initial-26903.js",
      localePropsSource,
    );
    const resolveProps = Function(`${patchedLocaleProps};return resolveProps`)();
    for (const override of [undefined, "en-US"]) {
      assert.deepEqual(
        resolveProps({ ideLocale: "en-US", systemLocale: "en-US" }, { get: () => false }, override,
          (locale) => locale?.startsWith("en") ?? false),
        { enabled: true, source: "SYSTEM", locale: "zh-CN", english: false },
      );
    }
    assert.equal(globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__, true);
    delete globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__;

    const ownerDiscoverySource = [
      "async function maybeResume(Bm,f,n,t){",
      "if(t.followExistingOwner===!0&&f===`local`&&Bm?.clientCoordination!=null){",
      "let owner=null;",
      "try{owner=await Bm.clientCoordination.findThreadOwner({hostId:f,conversationId:n})}",
      "catch(error){console.warn(`maybe_resume_owner_discovery_failed`,error)}",
      "return owner}",
      "return null}",
    ].join("");
    const patchedOwnerDiscoverySource = patch(
      "app://-/assets/app-initial-BHB6SClA.js",
      ownerDiscoverySource,
    );
    assert.match(
      patchedOwnerDiscoverySource,
      /__CODEY_THREAD_OWNER_DISCOVERY_V2__/,
    );
    assert.match(
      patchedOwnerDiscoverySource,
      /setTimeout\(\(\)=>\{if\(settled\)return;settled=true;resolve\(null\)\},150\)/,
    );
    assert.doesNotMatch(patchedOwnerDiscoverySource, /expiresAt|\.cache/);
    assert.doesNotMatch(
      patchedOwnerDiscoverySource,
      /owner=await Bm\.clientCoordination\.findThreadOwner/,
    );
    delete globalThis.__CODEY_THREAD_OWNER_DISCOVERY_V2__;
    const maybeResume = Function(
      `${patchedOwnerDiscoverySource};return maybeResume`,
    )();
    const ownerNativeSetTimeout = globalThis.setTimeout;
    const ownerNativeClearTimeout = globalThis.clearTimeout;
    let scheduledOwnerTimers = 0;
    globalThis.setTimeout = (callback, delay, ...args) => {
      scheduledOwnerTimers += 1;
      return ownerNativeSetTimeout(callback, delay, ...args);
    };
    globalThis.clearTimeout = (timer) => ownerNativeClearTimeout(timer);
    let ownerLookupCalls = 0;
    let currentOwner = "existing-owner";
    const primaryCoordination = {
      async findThreadOwner() {
        ownerLookupCalls += 1;
        return currentOwner;
      },
    };
    try {
      assert.equal(
        await maybeResume(
          { clientCoordination: primaryCoordination },
          "local",
          "thread-1",
          { followExistingOwner: true },
        ),
        "existing-owner",
      );
      assert.equal(ownerLookupCalls, 1);
      assert.equal(scheduledOwnerTimers, 1);

      // A settled positive answer must not be reused. The owner may have
      // disconnected before the next hydration attempt, and returning its
      // stale client ID would skip local thread hydration indefinitely.
      currentOwner = null;
      assert.equal(
        await maybeResume(
          { clientCoordination: primaryCoordination },
          "local",
          "thread-1",
          { followExistingOwner: true },
        ),
        null,
      );
      assert.equal(ownerLookupCalls, 2);
      assert.equal(scheduledOwnerTimers, 2);

      // A separate window/client never shares in-flight discovery state.
      let overlayLookupCalls = 0;
      assert.equal(
        await maybeResume(
          {
            clientCoordination: {
              async findThreadOwner() {
                overlayLookupCalls += 1;
                return "overlay-owner";
              },
            },
          },
          "local",
          "thread-1",
          { followExistingOwner: true },
        ),
        "overlay-owner",
      );
      assert.equal(overlayLookupCalls, 1);
      assert.equal(scheduledOwnerTimers, 3);
    } finally {
      globalThis.setTimeout = ownerNativeSetTimeout;
      globalThis.clearTimeout = ownerNativeClearTimeout;
      delete globalThis.__CODEY_THREAD_OWNER_DISCOVERY_V2__;
    }

    // Concurrent hydration attempts in the same renderer share one discovery.
    let resolveSharedOwner;
    let sharedLookupCalls = 0;
    const sharedOwner = new Promise((resolve) => {
      resolveSharedOwner = resolve;
    });
    const sharedCoordination = {
      findThreadOwner() {
        sharedLookupCalls += 1;
        return sharedOwner;
      },
    };
    const sharedOwnerFirst = maybeResume(
      { clientCoordination: sharedCoordination },
      "local",
      "thread-shared",
      { followExistingOwner: true },
    );
    const sharedOwnerSecond = maybeResume(
      { clientCoordination: sharedCoordination },
      "local",
      "thread-shared",
      { followExistingOwner: true },
    );
    await Promise.resolve();
    assert.equal(sharedLookupCalls, 1);
    resolveSharedOwner("shared-owner");
    assert.deepEqual(
      await Promise.all([sharedOwnerFirst, sharedOwnerSecond]),
      ["shared-owner", "shared-owner"],
    );
    delete globalThis.__CODEY_THREAD_OWNER_DISCOVERY_V2__;

    // A timeout is uncertainty, not a negative cache entry. The next attempt
    // must retry discovery and can immediately observe a newly available owner.
    const timeoutCallbacks = [];
    let timeoutLookupCalls = 0;
    globalThis.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timeoutCallbacks.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      timer.cleared = true;
    };
    const timeoutCoordination = {
      findThreadOwner() {
        timeoutLookupCalls += 1;
        if (timeoutLookupCalls === 1) return new Promise(() => {});
        return Promise.resolve("owner-after-timeout");
      },
    };
    try {
      const timedOutOwner = maybeResume(
        { clientCoordination: timeoutCoordination },
        "local",
        "thread-timeout",
        { followExistingOwner: true },
      );
      assert.equal(timeoutCallbacks.length, 1);
      assert.equal(timeoutCallbacks[0].delay, 150);
      timeoutCallbacks[0].callback();
      assert.equal(await timedOutOwner, null);

      assert.equal(
        await maybeResume(
          { clientCoordination: timeoutCoordination },
          "local",
          "thread-timeout",
          { followExistingOwner: true },
        ),
        "owner-after-timeout",
      );
      assert.equal(timeoutLookupCalls, 2);
      assert.equal(timeoutCallbacks.length, 2);
      assert.equal(timeoutCallbacks[1].cleared, true);
    } finally {
      globalThis.setTimeout = ownerNativeSetTimeout;
      globalThis.clearTimeout = ownerNativeClearTimeout;
      delete globalThis.__CODEY_THREAD_OWNER_DISCOVERY_V2__;
    }

    // Codex 26.1013 shape: the in-progress predicate is a module function used
    // by getHasInProgressLocalConversation; resume runs through the public
    // resumeConversation entry.
    const completedReconciliationSource = [
      "function isRunning(e){return e.inProgress===!0}",
      "class RunningManager{",
      "constructor(){this.conversation={inProgress:!0,resumeState:`resumed`,cwd:`/repo`};",
      "this.threadStore={getConversation:()=>this.conversation,getRecentConversationIds:()=>[`thread`]};",
      "this.role={role:`owner`};this.revision=1;this.statuses=[{type:`idle`},{type:`idle`}];this.events=[];",
      "this.inactiveThreadUnsubscriber={clearConversationStreamOwnership:e=>{this.events.push(`clear:${e}`);this.role=null}}}",
      "get conversations(){return new Map([[`thread`,this.conversation]])}",
      "getHostId(){return`local`}",
      "getConversation(e){return this.threadStore.getConversation(e)}",
      "getConversationStreamRevision(){return this.revision}",
      "getStreamRole(){return this.role}",
      "async sendRequest(e,t){this.events.push(`read:${e}:${t.threadId}:${t.includeTurns}`);return{thread:{status:this.statuses.shift()??{type:`idle`}}}}",
      "updateConversationState(e,t,n){this.events.push(`state:${e}:${n}`);t(this.conversation)}",
      "async resumeConversation(e){this.events.push(`resume:${e.conversationId}:${e.workspaceRoots.join()}`);this.conversation.inProgress=!1;this.role={role:`owner`};return{status:`ready`}}",
      "getHasInProgressLocalConversation({exceptConversationId:e}={}){for(let t of this.threadStore.getRecentConversationIds()){if(t===e)continue;let n=this.conversations.get(t);if(n!=null&&isRunning(n))return!0}return!1}",
      "releaseOwnedThread(e){this.inactiveThreadUnsubscriber.clearConversationStreamOwnership(e)}",
      "}",
    ].join("");
    const patchedCompletedReconciliationSource = patch(
      "app://-/assets/app-initial-BHB6SClA.js",
      completedReconciliationSource,
    );
    assert.match(
      patchedCompletedReconciliationSource,
      /async codeyReconcileCompletedConversation\(/,
    );
    const RunningManager = Function(
      `${patchedCompletedReconciliationSource};return RunningManager`,
    )();
    delete globalThis.__codeyAppServerManagers;
    const registeredManager = new RunningManager();
    registeredManager.getConversation("thread");
    assert.equal(globalThis.__codeyAppServerManagers.get("local"), registeredManager);
    const disposedManager = new RunningManager();
    disposedManager.disposed = true;
    assert.equal(disposedManager.getConversation("thread"), disposedManager.conversation);
    assert.equal(globalThis.__codeyAppServerManagers.get("local"), registeredManager);
    delete globalThis.__codeyAppServerManagers;
    const reconcileNativeSetTimeout = globalThis.setTimeout;
    const reconcileDelays = [];
    globalThis.setTimeout = (callback, delay) => {
      reconcileDelays.push(delay);
      callback();
      return 1;
    };
    try {
      const completedManager = new RunningManager();
      assert.equal(completedManager.getHasInProgressLocalConversation(), true);
      assert.equal(
        await completedManager.codeyReconcileCompletedConversation({
          conversationId: "thread-completed",
          workspaceRoots: [],
        }),
        true,
      );
      assert.deepEqual(completedManager.events, [
        "read:thread/read:thread-completed:false",
        "read:thread/read:thread-completed:false",
        "clear:thread-completed",
        "state:thread-completed:false",
        "resume:thread-completed:/repo",
      ]);
      assert.deepEqual(reconcileDelays, [250]);
      assert.equal(completedManager.conversation.resumeState, "needs_resume");
      assert.deepEqual(completedManager.role, { role: "owner" });

      const activeManager = new RunningManager();
      activeManager.statuses = [{ type: "active" }];
      assert.equal(
        await activeManager.codeyReconcileCompletedConversation({
          conversationId: "thread-running",
        }),
        false,
      );
      assert.deepEqual(activeManager.events, [
        "read:thread/read:thread-running:false",
      ]);

      const changedRevisionManager = new RunningManager();
      const sendRequest = changedRevisionManager.sendRequest.bind(changedRevisionManager);
      changedRevisionManager.sendRequest = async (...args) => {
        const response = await sendRequest(...args);
        if (changedRevisionManager.events.length === 2) {
          changedRevisionManager.revision += 1;
        }
        return response;
      };
      assert.equal(
        await changedRevisionManager.codeyReconcileCompletedConversation({
          conversationId: "thread-updated",
        }),
        false,
      );
      assert.deepEqual(changedRevisionManager.events, [
        "read:thread/read:thread-updated:false",
        "read:thread/read:thread-updated:false",
      ]);

      const idleManager = new RunningManager();
      idleManager.conversation.inProgress = false;
      assert.equal(
        await idleManager.codeyReconcileCompletedConversation({ conversationId: "thread-idle" }),
        false,
      );
      assert.deepEqual(idleManager.events, []);

      // A submitted turn the server has not confirmed yet is not stale.
      const submittingManager = new RunningManager();
      submittingManager.conversation.unconfirmedTurnSubmissions = [{ terminal: false }];
      assert.equal(
        await submittingManager.codeyReconcileCompletedConversation({
          conversationId: "thread-submitting",
        }),
        false,
      );
      assert.deepEqual(submittingManager.events, []);

      const followerManager = new RunningManager();
      followerManager.role = { role: "follower", ownerClientId: "other-window" };
      assert.equal(
        await followerManager.codeyReconcileCompletedConversation({
          conversationId: "thread-followed",
        }),
        false,
      );
      assert.deepEqual(followerManager.events, []);
    } finally {
      globalThis.setTimeout = reconcileNativeSetTimeout;
    }

    const interactionPerformanceSource = [
      "Hcn=class{activeInteractions=new Map;beginCpuSampling;",
      "start(e,n,u){let d={activeKey:e,",
      "cpuSampling:u===`dropped`||n.backfilled===!0?null:this.beginCpuSampling(),",
      "name:e};return this.activeInteractions.set(e,d),this.ensureHeartbeat(),d}",
      "ensureHeartbeat(){this.heartbeatTimer??=setInterval(()=>{",
      "let e=this.now(),t=this.wallNow();",
      "for(let n of this.activeInteractions.values())",
      "this.recordHeartbeat(n,e,t)},Vcn)}",
      "recordHeartbeat(e,t,n){return [e,t,n]}};",
      "function unrelated(){return beginCpuSampling()}",
    ].join("");
    const patchedInteractionPerformance = patch(
      "app://-/assets/app-initial-BHB6SClA.js",
      interactionPerformanceSource,
    );
    assert.match(patchedInteractionPerformance, /cpuSampling:null/);
    assert.match(patchedInteractionPerformance, /ensureHeartbeat\(\)\{\}/);
    assert.doesNotMatch(
      patchedInteractionPerformance,
      /heartbeatTimer\?\?=setInterval/,
    );
    assert.doesNotMatch(
      patchedInteractionPerformance,
      /cpuSampling:[^,}]*this\.beginCpuSampling\(\)/,
    );
    assert.match(
      patchedInteractionPerformance,
      /function unrelated\(\)\{return beginCpuSampling\(\)\}/,
    );

    // Only the first (fully incompatible) bundle logged skips — two gates whose
    // anchors were present but whose shapes did not match. The interaction
    // bundle patched cleanly, so no further skips were logged.
    assert.equal(patchErrors.length, 2);

    const productionRendererAsset = process.env.CODEY_RENDERER_ASSET;
    if (productionRendererAsset) {
      const productionSource = await readFile(productionRendererAsset, "utf8");
      const previousRecordCount = patchRecords.length;
      const patchedProductionSource = patch(
        "app://-/assets/app-initial-production-build.js",
        productionSource,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.notEqual(
        patchedProductionSource,
        productionSource,
        "the production renderer asset should receive compatible Codey gates",
      );
      if (productionSource.includes("locale_source")) {
        assert.match(patchedProductionSource, /__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__=!0/);
      }
      const unexpectedGateFailures = patchRecords
        .slice(previousRecordCount)
        .filter(({ operation }) => ![
          "renderer_patch:model allowlist",
          "renderer_patch:model visibility",
        ].includes(operation));
      assert.deepEqual(
        unexpectedGateFailures,
        [],
        "the production renderer may skip only unchanged model access gates",
      );

    }
  } finally {
    delete globalThis.__codeyRendererPatchEntry;
    delete globalThis.__codeyRendererPatchInstalled;
    delete globalThis.__CODEY_RENDERER_PATCH_OPTIONS__;
    console.error = nativeConsoleError;
    if (nativePatchLog === undefined) {
      delete globalThis.__codeyPatchLog;
    } else {
      globalThis.__codeyPatchLog = nativePatchLog;
    }
  }
});
