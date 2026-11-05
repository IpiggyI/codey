import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

const normalizeLineEndings = (source) => source.replace(/\r\n/g, "\n");

test("API and ChatGPT auth share model-aware native service-tier controls", async () => {
  try {
    (0, eval)(await loadStartupPatchTemplate());
    assert.equal(globalThis.__codeyRendererPatchInstalled, true);
    const patchAsset = (fixture, url = "app://-/assets/app-initial~native-controls-fixture.js") =>
      Promise.resolve(globalThis.__codeyRendererPatchEntry(url, fixture) ?? fixture);

    const modelSource = [
      "function Ue({authMethod:e,includeUltraReasoningEffort:i,useHiddenModels:o}){",
      "let s=[],c=null,l=o&&e!==`amazonBedrock`,u=i;",
      "return {gate:l,models:s,defaultModel:c,useHiddenModels:o}}",
    ].join("");
    const patchedModel = await patchAsset(modelSource);
    assert.match(patchedModel, /l=o&&e=== `chatgpt`/);
    assert.doesNotMatch(patchedModel, /!==`amazonBedrock`/);
    const modelGate = Function(
      `${patchedModel};return (authMethod) => ` +
        "Ue({authMethod,includeUltraReasoningEffort:true,useHiddenModels:true}).gate;",
    )();
    assert.equal(modelGate("chatgpt"), true);
    assert.equal(modelGate("apikey"), false);

    const nestedAuthModelSource = [
      "function Ue({authMethod:e,includeUltraReasoningEffort:i,useHiddenModels:o}){",
      "let s=[],c=null,l=(o)&&e!==\"amazonBedrock\",u=i;",
      "return {gate:l,models:s,defaultModel:c,useHiddenModels:o}}",
    ].join("");
    const patchedNestedAuthModel = await patchAsset(nestedAuthModelSource);
    assert.match(patchedNestedAuthModel, /l=\(o\)&&e=== `chatgpt`/);
    assert.doesNotMatch(patchedNestedAuthModel, /amazonBedrock/);

    const modelListFilterSource = [
      "function filter({authMethod:e,availableModels:n,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){",
      "let c=[],l=null,u=s&&e!==`amazonBedrock`;",
      "o.forEach(r=>{if(u?n.has(r.model):!r.hidden){c.push(r.model);r.isDefault&&(l=r.model)}});",
      "return {models:c,defaultModel:l,includeUltraReasoningEffort:a}}",
    ].join("");
    const patchedModelListFilter = await patchAsset(
      modelListFilterSource,
      "app://-/assets/model-list-filter-lLUu6272.js",
    );
    assert.match(
      patchedModelListFilter,
      /if\(u\?\(n\.has\(r\.model\)\|\|!r\.hidden\):!r\.hidden\)/,
    );
    assert.match(patchedModelListFilter, /u=s&&e=== `chatgpt`/);
    const filterModels = Function(
      `${patchedModelListFilter};return filter;`,
    )();
    const models = [
      { hidden: false, isDefault: true, model: "gpt-5.6-sol" },
      { hidden: false, isDefault: false, model: "gpt-5.3-codex-spark" },
      { hidden: true, isDefault: false, model: "hidden-preview" },
    ];
    assert.deepEqual(
      filterModels({
        authMethod: "chatgpt",
        availableModels: new Set(["gpt-5.6-sol", "hidden-preview"]),
        includeUltraReasoningEffort: true,
        models,
        useHiddenModels: true,
      }).models,
      ["gpt-5.6-sol", "gpt-5.3-codex-spark", "hidden-preview"],
    );
    assert.deepEqual(
      filterModels({
        authMethod: "apikey",
        availableModels: new Set(["gpt-5.6-sol"]),
        includeUltraReasoningEffort: true,
        models,
        useHiddenModels: true,
      }).models,
      ["gpt-5.6-sol", "gpt-5.3-codex-spark"],
    );
    assert.deepEqual(
      filterModels({
        authMethod: "chatgpt",
        availableModels: new Set(["hidden-preview"]),
        includeUltraReasoningEffort: true,
        models,
        useHiddenModels: false,
      }).models,
      ["gpt-5.6-sol", "gpt-5.3-codex-spark"],
    );

    const strictHiddenModelListFilterSource = [
      "function filterStrict({authMethod:e,availableModels:n,",
      "includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){",
      "let c=[],u=(s)&&e!==\"amazonBedrock\";",
      "o.forEach(r=>{if((u?n.has(r.model):r.hidden!==!0)){c.push(r.model)}});",
      "return {models:c,includeUltraReasoningEffort:a}}",
    ].join("");
    const patchedStrictHiddenModelListFilter = await patchAsset(
      strictHiddenModelListFilterSource,
      "app://-/assets/model-list-filter-strict-hidden.js",
    );
    assert.match(
      patchedStrictHiddenModelListFilter,
      /if\(u\?\(n\.has\(r\.model\)\|\|!r\.hidden\):!r\.hidden\)/,
    );
    assert.match(patchedStrictHiddenModelListFilter, /u=\(s\)&&e=== `chatgpt`/);

    const consolidatedModelListFilterSource = [
      "function filterV2({additionalAvailableModels:e,authMethod:t,availableModels:n,",
      "includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){",
      "let c=[],u=s&&t!==`amazonBedrock`;",
      "o.forEach(r=>{if(e?.has(r.model)===!0||(u?n.has(r.model):!r.hidden)){c.push(r.model)}});",
      "return {models:c,includeUltraReasoningEffort:a}}",
    ].join("");
    const patchedConsolidatedModelListFilter = await patchAsset(
      consolidatedModelListFilterSource,
      "app://-/assets/app-initial-BTphDPeq.js",
    );
    assert.match(
      patchedConsolidatedModelListFilter,
      /if\(u\?\(n\.has\(r\.model\)\|\|!r\.hidden\):!r\.hidden\)/,
    );
    assert.doesNotMatch(
      patchedConsolidatedModelListFilter,
      /e\?\.has\(r\.model\)===!0\|\|/,
    );
    const filterModelsV2 = Function(
      `${patchedConsolidatedModelListFilter};return filterV2;`,
    )();
    assert.deepEqual(
      filterModelsV2({
        additionalAvailableModels: new Set(["gpt-5.3-codex-spark"]),
        authMethod: "apikey",
        availableModels: new Set(["gpt-5.6-sol"]),
        includeUltraReasoningEffort: true,
        models,
        useHiddenModels: true,
      }).models,
      ["gpt-5.6-sol", "gpt-5.3-codex-spark"],
    );

    // Third-party catalogs may not meet Codex's native power-selection threshold.
    // Codey still uses the modern trigger and preserves Codex's native Fast
    // indicators for models that expose the selected speed tier.
    const fastModelPresentationSource = [
      "const nativeModelPickerMarkers=[",
      "`composer.intelligenceDropdown.model.title`,",
      "`composer.intelligenceDropdown.model.rowLabel`];",
      "function triggerConfig(hideLabel,powerSelections){",
      "let workMode=true,compact=workMode&&powerSelections.length>=4,",
      "configEnabled=compact&&!hideLabel,focusTarget=compact?`simple`:`advanced`;",
      "return {focusTarget,modelPickerTriggerConfig:configEnabled?",
      "{showFastServiceTierIndicator:true}:void 0}}",
      "function unrelatedFastShapes(workMode,hideDecoy,compact,otherConfig){",
      "let decoyEnabled=workMode&&!hideDecoy;",
      "if(compact&&otherConfig!=null)return {decoyEnabled};return null}",
      "function unrelatedIconShape(decoyIcon,model,tier){",
      "let decoyResult=decoyIcon!=null&&supports(model,tier)?decoyIcon:null;",
      "return decoyResult}",
      "function nativePicker(input,powerSelections,selectedServiceTierIconKind){",
      "let {modelPickerTriggerConfig:config}=input,workMode=true,",
      "compact=workMode&&powerSelections.length>=4,useCompact=compact,",
      "selectedModel={},selectedServiceTier=`priority`,otherConfig=null;",
      "let selectedIcon=!useCompact&&selectedServiceTierIconKind!=null&&",
      "supports(selectedModel,selectedServiceTier)?selectedServiceTierIconKind:null;",
      "let rowIcon=selectedServiceTierIconKind!==null&&supports(selectedModel,selectedServiceTier)?selectedServiceTierIconKind:null;",
      "let labels={selected:{serviceTierIconKind:selectedIcon},row:{serviceTierIconKind:rowIcon}};",
      "let options=[`gpt-5.5`,`claude-opus-4-8`].map(model=>({",
      "model,selectedServiceTierIconKind:useCompact?null:selectedServiceTierIconKind,stripGptPrefix:useCompact}));",
      "if(compact&&otherConfig!=null)return {kind:`decoy`};",
      "if(compact&&config!=null)return {kind:`solid`,labels,options,rowIcon,selectedIcon};",
      "return {kind:`outline`,labels,options,rowIcon,selectedIcon}}",
      "function supports(){return true}",
    ].join("");
    const patchedFastModelPresentation = await patchAsset(
      fastModelPresentationSource,
      "app://-/assets/codex-composer-adapter-DDUHejoe.js",
    );
    assert.match(patchedFastModelPresentation, /configEnabled=!hideLabel/);
    assert.doesNotMatch(patchedFastModelPresentation, /selectedIcon=null/);
    assert.doesNotMatch(patchedFastModelPresentation, /rowIcon=null/);
    assert.doesNotMatch(
      patchedFastModelPresentation,
      /selectedServiceTierIconKind:null,stripGptPrefix:/,
    );
    assert.match(patchedFastModelPresentation, /if\(config!=null\)/);
    assert.match(
      patchedFastModelPresentation,
      /if\(compact&&otherConfig!=null\)/,
    );
    assert.match(
      patchedFastModelPresentation,
      /decoyResult=decoyIcon!=null&&supports\(model,tier\)\?decoyIcon:null/,
    );
    const nativeModelPicker = Function(
      `${patchedFastModelPresentation};return {nativePicker,triggerConfig};`,
    )();
    const thirdPartyTrigger = nativeModelPicker.triggerConfig(false, []);
    const thirdPartyPresentation = nativeModelPicker.nativePicker(
      {
        modelPickerTriggerConfig:
          thirdPartyTrigger.modelPickerTriggerConfig,
      },
      [],
      "fast",
    );
    assert.ok(thirdPartyTrigger.modelPickerTriggerConfig);
    assert.equal(thirdPartyPresentation.kind, "solid");
    assert.equal(thirdPartyPresentation.rowIcon, "fast");
    assert.equal(thirdPartyPresentation.selectedIcon, "fast");
    assert.ok(thirdPartyPresentation.options.every(
      (option) => option.selectedServiceTierIconKind === "fast",
    ));
    assert.equal(
      nativeModelPicker.triggerConfig(true, []).modelPickerTriggerConfig,
      undefined,
    );

    // Current bundles dropped rowLabel/showFastServiceTierIndicator and put
    // compiled hook caches between the availability flag and trigger config.
    const memoizedTriggerSource = [
      "const marker=`composer.intelligenceDropdown.model.title`;",
      "function triggerConfig(workMode,hideLabel,tier){",
      "let enabled=workMode&&!hideLabel,cache=[];",
      "cache[0]=null;".repeat(340),
      "let config;cache[1]!==enabled?(config=enabled?{selectedServiceTierIconKind:tier,",
      "showDaybreakIndicator:false}:void 0,cache[1]=enabled,cache[2]=config):config=cache[2];",
      "return {modelPickerTriggerConfig:config}}",
      "function picker(input,workMode){let {modelPickerTriggerConfig:config,selectedServiceTierIconKind:icon}=input;",
      "if(workMode&&config!=null)return {kind:`modern`,icon:config.selectedServiceTierIconKind};",
      "return {kind:`legacy`,icon}}",
    ].join("");
    const patchedMemoizedTrigger = await patchAsset(memoizedTriggerSource);
    const modernPicker = Function(`${patchedMemoizedTrigger};return {triggerConfig,picker};`)();
    for (const workMode of [false, true]) {
      for (const tier of [null, "fast"]) {
        assert.deepEqual(
          modernPicker.picker(modernPicker.triggerConfig(workMode, false, tier), workMode),
          { kind: "modern", icon: tier },
        );
      }
      assert.equal(modernPicker.triggerConfig(workMode, true, "fast").modelPickerTriggerConfig, undefined);
    }

    assert.equal(
      await patchAsset(
        "const unrelatedWindowsChunk = true;",
        "app://-/assets/unrelated-windows-chunk.js",
      ),
      "const unrelatedWindowsChunk = true;",
    );
  } finally {
    delete globalThis.__codeyRendererPatchEntry;
    delete globalThis.__codeyRendererPatchInstalled;
    delete globalThis.__CODEY_RENDERER_PATCH_OPTIONS__;
  }
});

test("starting or restarting Codex replaces the old runtime with one managed by Codey", async () => {
  const [runtimeSource, launcherSource, launcherProcessSource, launcherPlatformSource, appSource] =
    await Promise.all([
    readFile(new URL("../backend/src/commands/runtime.rs", import.meta.url), "utf8")
      .then(normalizeLineEndings),
    readFile(new URL("../backend/src/launcher.rs", import.meta.url), "utf8")
      .then(normalizeLineEndings),
    readFile(
      new URL("../backend/src/launcher/process.rs", import.meta.url),
      "utf8",
    ).then(normalizeLineEndings),
    readFile(
      new URL("../backend/src/launcher/platform.rs", import.meta.url),
      "utf8",
    ).then(normalizeLineEndings),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);
  const launcherModules =
    `${launcherSource}\n${launcherProcessSource}\n${launcherPlatformSource}`;
  const restartFlow = runtimeSource.slice(
    runtimeSource.indexOf("pub async fn schedule_restart_codey_runtime"),
    runtimeSource.indexOf("pub async fn stop_codey_runtime"),
  );
  const prepareLaunchFlow = launcherProcessSource.slice(
    launcherProcessSource.indexOf("async fn prepare_codex_for_launch"),
    launcherProcessSource.indexOf("fn startup_patch_detail"),
  );

  assert.match(restartFlow, /runtime_operation\.lock\(\)/);
  assert.match(restartFlow, /stop_codey_runtime_locked\(&restart_state\)/);
  assert.match(restartFlow, /launch_codey_inner_locked\(&restart_state\)/);
  assert.match(restartFlow, /runtime_generation/);
  assert.match(restartFlow, /restart_task/);
  assert.match(restartFlow, /oneshot::channel\(\)/);
  assert.match(restartFlow, /is_shutting_down\(\)/);
  assert.match(
    restartFlow,
    /request_shutdown_with_reason\(super::AppShutdownReason::RuntimeRestartFailed\)/,
  );
  assert.match(
    runtimeSource,
    /pub async fn begin_shutdown[\s\S]*?cancel\.send\(\(\)\)[\s\S]*?task\.await/,
  );
  // 当前运行代、崩溃恢复与退出竞争由 Rust 生命周期测试验证。
  assert.match(
    launcherModules,
    /stop_codex_processes\(\s*&self\.codex_app_path,[\s\S]*?self\.process_id,[\s\S]*?self\.process_group_id/,
  );
  assert.match(
    prepareLaunchFlow,
    /stop_running_windows_codex_instances\(app_dir\)[\s\S]*?\.await[\s\S]*?if !stopped\.is_empty\(\)/,
  );
  assert.match(
    prepareLaunchFlow,
    /if macos_codex_is_running\(app_dir\)\.await\? \{[\s\S]*?terminate_unix_codex_processes\(app_dir, None, None, None\)[\s\S]*?\.await/,
  );
  assert.doesNotMatch(prepareLaunchFlow, /anyhow::bail!/);
  assert.match(launcherModules, /build_codex_executable\(app_dir\)/);
  assert.match(launcherModules, /owned_unix_codex_process_ids/);
  assert.match(launcherModules, /libc::SIGKILL/);
  assert.doesNotMatch(runtimeSource, /"close_codex"/);
  assert.doesNotMatch(runtimeSource, /show_manual_relaunch_prompt/);
  assert.match(appSource, /await withTimeout\(invoke\("restart_codey"\),/);
  assert.match(appSource, /Codey 将自动重新拉起客户端/);
  assert.doesNotMatch(appSource, /关闭 Codex/);
});
