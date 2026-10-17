// Codex 渲染进程资产源补丁。原本是主进程 protocol.handle 里对 app:// 响应
// 做改写的纯函数部分；Electron fuse 关闭后主进程注入不可用，改由 CDP Fetch 会话
// 在响应暂停时逐资产调用 globalThis.__codeyRendererPatchEntry 完成同样的改写。
// 本文件只依赖页面 JS 环境，不使用任何 Node/Electron API。
(() => {
  const rendererPatchOptions =
    typeof globalThis.__CODEY_RENDERER_PATCH_OPTIONS__ === "object" &&
    globalThis.__CODEY_RENDERER_PATCH_OPTIONS__ !== null
      ? globalThis.__CODEY_RENDERER_PATCH_OPTIONS__
      : {};
  const disablePet = rendererPatchOptions.disablePet === true;
  const threadOwnerDiscoveryTimeoutMs = 150;
  // 渲染进程没有 --codey-record-error 子进程可写：补丁失败经 CDP
  // Runtime.addBinding 暴露的 __codeyPatchLog 回传给 Rust 记录。
  const recordCodeyPatchFailure = (operation, error, context = {}) => {
    try {
      const message = error instanceof Error
        ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error || "unknown patch failure");
      const record = JSON.stringify({ operation, message, context });
      const reporter = globalThis.__codeyPatchLog;
      if (typeof reporter === "function") {
        reporter(record);
      } else {
        console.error("[Codey]", record);
      }
    } catch {}
  };
  const maxRendererPatchFingerprints = 64;
  const rendererPatchFailuresByFingerprint = new Map();
  let activeRendererPatchFailures = null;
  // 指纹只作补丁结果缓存键，不需要加密强度；原主进程版用 sha256，
  // 页面里用同步 FNV-1a 变体即可，省掉 async crypto.subtle。
  const rendererPatchFingerprint = (source) => {
    try {
      let hash = 0xcbf29ce484222325n;
      for (let index = 0; index < source.length; index += 1) {
        hash ^= BigInt(source.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      return `${source.length}:${hash.toString(36)}`;
    } catch {
      // 指纹仅用于减少重复计算；无法生成时保留兼容行为，避免错误命中缓存。
      return null;
    }
  };
  const rendererPatchFailuresForSource = (source) => {
    const fingerprint = rendererPatchFingerprint(source);
    if (fingerprint == null) return null;
    const existing = rendererPatchFailuresByFingerprint.get(fingerprint);
    if (existing) {
      // 更新插入顺序，优先淘汰最久未使用的记录。
      rendererPatchFailuresByFingerprint.delete(fingerprint);
      rendererPatchFailuresByFingerprint.set(fingerprint, existing);
      return existing;
    }
    const failures = new Set();
    rendererPatchFailuresByFingerprint.set(fingerprint, failures);
    while (rendererPatchFailuresByFingerprint.size > maxRendererPatchFingerprints) {
      const oldest = rendererPatchFailuresByFingerprint.keys().next().value;
      rendererPatchFailuresByFingerprint.delete(oldest);
    }
    return failures;
  };
  // 各渲染器门控相互独立。压缩代码的锚点可能随版本或平台变化；
  // 单个门控失配时记录错误并跳过，继续应用其余门控。
  // 日志附带相邻锚点的可打印源码片段，便于适配现场资源。
  const rendererGateDiagnosticAnchors = [
    "`composer.toggleFastMode`",
    "composer.speedSlashCommand.disableDescription",
    "isServiceTierAllowed",
    "selectedServiceTier",
    "featureRequirements?.fast_mode",
    "useHiddenModels",
    "availableOptions.length",
    "includeUltraReasoningEffort",
    "isCustomModelProvider",
  ];
  const rendererGateFailureExcerpts = (source) => {
    const excerpts = [];
    for (const anchor of rendererGateDiagnosticAnchors) {
      if (excerpts.length >= 2) break;
      const index = source.indexOf(anchor);
      if (index < 0) continue;
      excerpts.push(
        source
          .slice(Math.max(0, index - 150), index + anchor.length + 190)
          .replace(/[^\x20-\x7E]/g, "?"),
      );
    }
    return excerpts;
  };
  const recordIncompatibleRendererGate = (source, name, matchCount) => {
    activeRendererPatchFailures?.add(name);
    const message =
      `Codey skipped an incompatible Codex renderer patch: ${name} gate matched ${matchCount} times`;
    const context = { matchCount };
    const excerpts = rendererGateFailureExcerpts(source);
    if (excerpts.length) context.excerpts = excerpts;
    recordCodeyPatchFailure(`renderer_patch:${name}`, message, context);
    try {
      console.error(message);
    } catch {}
    return source;
  };
  const replaceUniqueRendererGate = (source, pattern, replacement, name) => {
    // 页面重载或恢复会再次请求同一资产。已确认失配的门控直接跳过，
    // 避免重复扫描整份源码和记录相同错误。
    if (activeRendererPatchFailures?.has(name)) return source;
    const gates = Array.isArray(pattern) ? pattern : [{ pattern, replacement }];
    let matchCount = 0;
    let patched = source;
    for (const gate of gates) {
      let gateCount = 0;
      const candidate = source.replace(gate.pattern, (...args) => {
        gateCount += 1;
        return typeof gate.replacement === "function"
          ? gate.replacement(...args)
          : gate.replacement;
      });
      if (gateCount > 0 && matchCount === 0) patched = candidate;
      matchCount += gateCount;
    }
    if (matchCount !== 1) {
      return recordIncompatibleRendererGate(source, name, matchCount);
    }
    return patched;
  };
  const replaceNearestRendererGateBeforeAnchor = (
    source,
    pattern,
    replacement,
    name,
    anchor,
    maximumDistance,
  ) => {
    if (activeRendererPatchFailures?.has(name)) return source;
    const anchorIndexes = [];
    for (
      let index = source.indexOf(anchor);
      index >= 0;
      index = source.indexOf(anchor, index + anchor.length)
    ) anchorIndexes.push(index);
    if (anchorIndexes.length !== 1) {
      return recordIncompatibleRendererGate(source, name, anchorIndexes.length);
    }

    const anchorIndex = anchorIndexes[0];
    const scopeStart = Math.max(0, anchorIndex - maximumDistance);
    const scope = source.slice(scopeStart, anchorIndex + anchor.length);
    const gates = Array.isArray(pattern) ? pattern : [{ pattern, replacement }];
    const candidates = [];
    for (const gate of gates) {
      scope.replace(gate.pattern, (...args) => {
        candidates.push({ args, gate, offset: args.at(-2) });
        return args[0];
      });
    }
    if (candidates.length === 0) {
      return recordIncompatibleRendererGate(source, name, 0);
    }

    const nearestOffset = Math.max(
      ...candidates.map((candidate) => candidate.offset),
    );
    const nearestCandidates = candidates.filter(
      (candidate) => candidate.offset === nearestOffset,
    );
    if (nearestCandidates.length !== 1) {
      return recordIncompatibleRendererGate(
        source,
        name,
        nearestCandidates.length,
      );
    }

    const [{ args, gate, offset }] = nearestCandidates;
    const effectiveReplacement = gate.replacement ?? replacement;
    const replaced = typeof effectiveReplacement === "function"
      ? effectiveReplacement(...args)
      : effectiveReplacement;
    const absoluteOffset = scopeStart + offset;
    return source.slice(0, absoluteOffset) +
      replaced +
      source.slice(absoluteOffset + args[0].length);
  };
  const rendererHasNativeCustomProviderModelAccess = (source) =>
    /function\s+[$A-Z_a-z][$\w]*\(\{[^}]*isCustomModelProvider\s*:\s*([$A-Z_a-z][$\w]*)[^}]*model\s*:\s*([$A-Z_a-z][$\w]*)[^}]*useHiddenModels\s*:\s*([$A-Z_a-z][$\w]*)[^}]*\}\)\s*\{\s*return[\s\S]{0,512}?\3\s*&&\s*!\s*\1\s*&&[\s\S]{0,256}?\?\s*[$A-Z_a-z][$\w]*\.has\(\s*\2\.model\s*\)\s*:\s*!\s*\2\.hidden\s*\)*\s*\}/.test(
      source,
    );
  const replacePetRendererImportWithStubs = (match, importClause) => {
    if (typeof importClause !== "string" || importClause.trim() === "") {
      return "";
    }
    const localBindings = [];
    const rememberBinding = (binding) => {
      if (
        /^[$A-Z_a-z][$\w]*$/.test(binding)
        && !localBindings.includes(binding)
      ) {
        localBindings.push(binding);
      }
    };
    const defaultBinding = importClause.match(/^\s*([$A-Z_a-z][$\w]*)/);
    if (defaultBinding) rememberBinding(defaultBinding[1]);
    for (const specifier of importClause.matchAll(
      /(?:^|[,{])\s*([$A-Z_a-z][$\w]*)(?:\s+as\s+([$A-Z_a-z][$\w]*))?\s*(?=[,}])/g,
    )) {
      rememberBinding(specifier[2] ?? specifier[1]);
    }
    for (const namespace of importClause.matchAll(
      /\*\s+as\s+([$A-Z_a-z][$\w]*)/g,
    )) {
      rememberBinding(namespace[1]);
    }
    if (!localBindings.length) {
      const message =
        "Codey could not identify Codex pet settings renderer import bindings";
      recordCodeyPatchFailure("renderer_patch:pet settings avatar resources", message);
      try {
        console.error(message);
      } catch {}
      return match;
    }
    const [firstBinding, ...aliases] = localBindings;
    const aliasDeclarations = aliases
      .map((binding) => `,${binding}=${firstBinding}`)
      .join("");
    return `const ${firstBinding}=(()=>{const target=function(){return null};return new Proxy(target,{get(target,property,receiver){if(property===Symbol.iterator)return function*(){};if(property===\`map\`||property===\`filter\`||property===\`flatMap\`||property===\`slice\`)return()=>[];if(property===\`then\`)return void 0;return Reflect.get(target,property,receiver)},construct(){return{}}})})()${aliasDeclarations};`;
  };
  // 旧版设置页只导入 codex-avatar；新版把预览拆到按钮、宠物资源表和
  // 头像选项钩子。设置页可能同时导入多份资源，因此替换所有匹配项。
  const petRendererResourceImport =
    /import(?:\s*([^;"']+?)\s*from)?\s*["']\.\/(?:codex-avatar|codex-pet-assets|avatar-mascot-button|use-avatar-options)(?:[~-][^/"']*)?\.js["']/;
  const petRendererResourceImportAll = new RegExp(
    petRendererResourceImport.source,
    "g",
  );
  const replacePetRendererResourceImports = (source, name) => {
    if (activeRendererPatchFailures?.has(name)) return source;
    let count = 0;
    const patched = source.replace(petRendererResourceImportAll, (...args) => {
      count += 1;
      return replacePetRendererImportWithStubs(...args);
    });
    if (count === 0) return recordIncompatibleRendererGate(source, name, count);
    return patched;
  };
  const threadOwnerDiscoveryExpression = (
    coordinationName,
    hostIdName,
    conversationIdName,
  ) =>
    [
      "await (globalThis.__CODEY_THREAD_OWNER_DISCOVERY_V2__??=(()=>{",
      "const requestsByClient=new WeakMap;",
      "return{find(client,hostId,conversationId){",
      "let requests=requestsByClient.get(client);",
      "if(requests==null){requests=new Map;requestsByClient.set(client,requests)}",
      "const key=String(hostId)+String.fromCharCode(0)+String(conversationId);",
      "const existing=requests.get(key);",
      "if(existing!=null)return existing;",
      "let settled=false,timer;",
      "const lookup=Promise.resolve().then(()=>client.findThreadOwner({hostId,conversationId}));",
      "const request=new Promise((resolve,reject)=>{",
      `timer=globalThis.setTimeout(()=>{if(settled)return;settled=true;resolve(null)},${threadOwnerDiscoveryTimeoutMs});`,
      "lookup.then(owner=>{",
      "if(settled)return;",
      "settled=true;globalThis.clearTimeout(timer);",
      "resolve(owner)",
      "},error=>{",
      "if(settled)return;",
      "settled=true;globalThis.clearTimeout(timer);reject(error)",
      "})",
      "}).finally(()=>{if(requests.get(key)===request)requests.delete(key)});",
      "requests.set(key,request);",
      "return request",
      "}}",
      "})()).find(",
      `${coordinationName}.clientCoordination,${hostIdName},${conversationIdName})`,
    ].join("");
  const patchCodexRendererAsset = (source) => {
    let patched = source;
    let nativeCustomProviderModelAccess = false;
    if (
      source.includes("codex-message-from-view")
      && source.includes("sendMessageFromView")
      && source.includes("Failed to send message from view")
    ) {
      // 原生渲染器先通过 Electron 发送请求，再发出视图事件。
      // 在桥接边界调用可选改写，使模型目录跟踪能够观察实际发送的消息。
      patched = replaceUniqueRendererGate(
        patched,
        /if\(([$A-Z_a-z][$\w]*)\?\.sendMessageFromView\)\{let ([$A-Z_a-z][$\w]*)=([$A-Z_a-z][$\w]*);\1\.sendMessageFromView\(\2\)\.catch\(([$A-Z_a-z][$\w]*)=>\{/g,
        (_match, bridgeName, messageName, sourceName, errorName) =>
          `if(${bridgeName}?.sendMessageFromView){let ${messageName}=globalThis.__codeyModelWhitelistPatch?.rewriteOutgoingMessage?.(${sourceName})??${sourceName};${bridgeName}.sendMessageFromView(${messageName}).catch(${errorName}=>{`,
        "model route bridge preflight",
      );
    }
    if (
      source.includes("AppServerRequestClient is missing a message dispatcher")
      && source.includes("mcp_request_enqueued")
      && source.includes("this.dispatchMessage?.(`mcp-request`")
    ) {
      // 当前 Codex 可直接通过 AppServerRequestClient 创建会话。
      // 入队时的可选改写只供模型目录跟踪使用，不能改变用户的请求目的地。
      patched = replaceUniqueRendererGate(
        patched,
        /(enqueueRequest\(([$A-Z_a-z][$\w]*),([$A-Z_a-z][$\w]*),([$A-Z_a-z][$\w]*),([$A-Z_a-z][$\w]*)=[$A-Z_a-z][$\w]*=>\{this\.dispatchMessage\?\.\(`mcp-request`,\{request:[$A-Z_a-z][$\w]*,hostId:this\.hostId,[\s\S]{0,700}?widget:\4\?\.widget\}\)\},[$A-Z_a-z][$\w]*=null\)\{)let /g,
        (_match, prefix, methodName, paramsName) =>
          `${prefix}let __codeyRoute=globalThis.__codeyModelWhitelistPatch?.rewriteOutgoingMessage?.({type:\`mcp-request\`,request:{method:${methodName},params:${paramsName}}});if(__codeyRoute?.request){${methodName}=__codeyRoute.request.method??${methodName},${paramsName}=__codeyRoute.request.params??${paramsName}}let `,
        "app server request route preflight",
      );
      // 预检发生在分配请求编号之前；创建后登记实际请求以关联模型目录回复，
      // 保留用户的 modelProvider。
      patched = replaceUniqueRendererGate(
        patched,
        /(let\{request:([$A-Z_a-z][$\w]*),promise:[$A-Z_a-z][$\w]*\}=this\.createRequest\([^;]{1,256}\);)/g,
        (_match, createRequest, requestName) =>
          `${createRequest}globalThis.__codeyModelWhitelistPatch?.trackOutgoingMessage?.({type:\`mcp-request\`,request:${requestName}});`,
        "app server request identity tracking",
      );
      // 异步结果的使用方先于诊断事件更新 React Query。
      // 在结果解析边界改写模型目录，避免原生结果覆盖当前线路目录。
      patched = replaceUniqueRendererGate(
        patched,
        /(([$A-Z_a-z][$\w]*)\.resolve\()([$A-Z_a-z][$\w]*)(\),this\.emitRequestLifecycleEvent\(\{type:`completed`,hostId:this\.hostId,method:\2\.method)/g,
        (_match, prefix, requestName, resultName, suffix) =>
          `${prefix}${resultName}=globalThis.__codeyModelWhitelistPatch?.rewriteIncomingResult?.(${requestName}.method,${resultName})??${resultName}${suffix}`,
        "app server model result rewrite",
      );
    }
    if (
      disablePet
      && /settings\.(?:(?:appearance|personalization)\.)?(?:pets|mini)(?:[."`]|$)/.test(source)
      && petRendererResourceImport.test(source)
    ) {
      // 宠物设置页静态导入预览相关资源，挂载后隐藏控件无法阻止资源加载。
      // 将设置页依赖替换成可调用、可迭代的空实现；语音仍使用共享头像浮层。
      patched = replacePetRendererResourceImports(
        patched,
        "pet settings avatar resources",
      );
    }
    if (
      source.includes("72216192") &&
      source.includes("enable_i18n") &&
      source.includes("locale_source") &&
      source.includes(".localeOverride")
    ) {
      // 在首次渲染前确定中文。后续注入仍保存语言覆盖值，
      // 但首次路由可能已选择并缓存英语消息。
      patched = replaceUniqueRendererGate(
        patched,
        [{
          pattern: /let\s+([$A-Z_a-z][$\w]*)\s*=\s*([$A-Z_a-z][$\w]*)\s*,\s*([$A-Z_a-z][$\w]*)\s*=\s*([$A-Z_a-z][$\w]*)\?\.\s*get\(\s*`locale_source`\s*,\s*`IDE`\s*\)\s*,\s*([$A-Z_a-z][$\w]*)\s*=\s*([$A-Z_a-z][$\w]*)\(\s*([$A-Z_a-z][$\w]*)\.localeOverride\s*\)/g,
          replacement: (_match, enabled, _gate, localeSource, _config, override) =>
            `let ${enabled}=(globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__=!0),${localeSource}=\`SYSTEM\`,${override}=\`zh-CN\``,
        }, {
          pattern: /let ([$A-Z_a-z][$\w]*)=([$A-Z_a-z][$\w]*),([$A-Z_a-z][$\w]*)=([$A-Z_a-z][$\w]*)\?\.get\(`locale_source`,`IDE`\),([$A-Z_a-z][$\w]*=([$A-Z_a-z][$\w]*)\?\.ideLocale,[$A-Z_a-z][$\w]*=\6\?\.systemLocale,[$A-Z_a-z][$\w]*=[$A-Z_a-z][$\w]*\(([$A-Z_a-z][$\w]*)\))/g,
          replacement: (_match, enabled, _gate, localeSource, _config, resolution, _data, override) =>
            `${override}=\`zh-CN\`;let ${enabled}=(globalThis.__CODEY_DEFAULT_CHINESE_LOCALE_RENDERER_PATCH__=!0),${localeSource}=\`SYSTEM\`,${resolution}`,
        }],
        undefined,
        "default Chinese locale",
      );
    }
    if (
      source.includes("maybe_resume_owner_discovery_failed")
      && source.includes("followExistingOwner")
      && source.includes(".clientCoordination.findThreadOwner")
    ) {
      // 所有者发现用于复用其他窗口的消息流；只合并尚未完成的重复查询。
      // 已完成的结果可能随所有者断开而过期，每次恢复都重新确认。
      // 查询只等待一个短窗口，随后允许本地恢复。
      patched = replaceUniqueRendererGate(
        patched,
        /await\s+([$A-Z_a-z][$\w]*)\.clientCoordination\.findThreadOwner\(\{\s*hostId\s*:\s*([$A-Z_a-z][$\w]*)\s*,\s*conversationId\s*:\s*([$A-Z_a-z][$\w]*)\s*\}\)/g,
        (_match, coordinationName, hostIdName, conversationIdName) =>
          threadOwnerDiscoveryExpression(
            coordinationName,
            hostIdName,
            conversationIdName,
          ),
        "thread owner discovery coalescing",
      );
    }
    if (
      !source.includes("codeyReconcileCompletedConversation")
      && source.includes("isLocalConversationInProgress")
      && source.includes("inactiveThreadUnsubscriber.clearConversationStreamOwnership")
      && source.includes("getConversationStreamRevision")
      && source.includes("async resumeConversation(")
    ) {
      // 渲染器可能漏掉完成通知，仍保留进行中的轮次和消息流角色。
      // 两次核对服务端状态，排除并发修订和跟随窗口，再沿重连路径恢复分页历史。
      patched = replaceUniqueRendererGate(
        patched,
        /async resumeConversation\(([$A-Z_a-z][$\w]*)\)\{await this\.maybeResumeConversation\(\1\);/g,
        (_match, paramsName) =>
          `async codeyReconcileCompletedConversation(${paramsName}){let __codeyConversationId=${paramsName}?.conversationId,__codeyConversation=__codeyConversationId==null?null:this.getConversation(__codeyConversationId);if(__codeyConversationId==null||__codeyConversation==null||!this.productPolicy.runtimePolicy.isLocalConversationInProgress(__codeyConversation)||this.getStreamRole(__codeyConversationId)?.role===\`follower\`)return!1;let __codeyRevision=this.getConversationStreamRevision(__codeyConversationId),__codeyReadStatus=async()=>{let __codeyResponse=await this.sendRequest(\`thread/read\`,{threadId:__codeyConversationId,includeTurns:!1}),__codeyStatus=__codeyResponse?.thread?.status;return typeof __codeyStatus===\`string\`?__codeyStatus:__codeyStatus?.type},__codeyStatus=await __codeyReadStatus();if(__codeyStatus!==\`idle\`&&__codeyStatus!==\`error\`)return!1;await new Promise(__codeyResolve=>setTimeout(__codeyResolve,250));if(await __codeyReadStatus()!==__codeyStatus||this.getConversationStreamRevision(__codeyConversationId)!==__codeyRevision)return!1;__codeyConversation=this.getConversation(__codeyConversationId);if(__codeyConversation==null||!this.productPolicy.runtimePolicy.isLocalConversationInProgress(__codeyConversation)||this.getStreamRole(__codeyConversationId)?.role===\`follower\`)return!1;this.inactiveThreadUnsubscriber.clearConversationStreamOwnership(__codeyConversationId);this.updateConversationState(__codeyConversationId,__codeyState=>{__codeyState.resumeState=\`needs_resume\`},!1);await this.maybeResumeConversation(${paramsName});__codeyConversation=this.getConversation(__codeyConversationId);return __codeyConversation!=null&&!this.productPolicy.runtimePolicy.isLocalConversationInProgress(__codeyConversation)}async resumeConversation(${paramsName}){await this.maybeResumeConversation(${paramsName});`,
        "completed thread reconciliation",
      );
    }
    if (
      source.includes("useHiddenModels:") &&
      source.includes("availableModels:") &&
      source.includes("includeUltraReasoningEffort") &&
      source.includes("amazonBedrock")
    ) {
      // 新版 Codex 已为自定义提供方跳过原生白名单并使用模型可见性。
      // 识别这一兼容形式，避免误报。
      nativeCustomProviderModelAccess =
        rendererHasNativeCustomProviderModelAccess(source);
      if (!nativeCustomProviderModelAccess) {
        patched = replaceUniqueRendererGate(
          patched,
          /if\s*\(\s*\(*\s*(?:[$A-Z_a-z][$\w]*\s*(?:\?\.|\.)\s*has\(\s*[$A-Z_a-z][$\w]*\.model\s*\)\s*(?:===\s*!0)?\s*\|\|\s*)?\(?\s*([$A-Z_a-z][$\w]*)\s*\?\s*([$A-Z_a-z][$\w]*)\.has\(\s*([$A-Z_a-z][$\w]*)\.model\s*\)\s*:\s*(?:!\s*\3\.hidden|\3\.hidden\s*!==\s*!0|\3\.hidden\s*===\s*!1)\s*\)?\s*\)*\s*\)/g,
          (_match, useAllowlistName, allowlistName, modelName) =>
            `if(${useAllowlistName}?(${allowlistName}.has(${modelName}.model)||!${modelName}.hidden):!${modelName}.hidden)`,
          "model allowlist",
        );
      }
    }
    if (
      source.includes("useHiddenModels:") &&
      source.includes("includeUltraReasoningEffort") &&
      source.includes("amazonBedrock") &&
      !nativeCustomProviderModelAccess
    ) {
      patched = replaceUniqueRendererGate(
        patched,
        /(\b[$A-Z_a-z][$\w]*\s*=\s*\(?\s*[$A-Z_a-z][$\w]*(?:\s*(?:\?\.|\.)\s*[$A-Z_a-z][$\w]*)?\s*\)?\s*&&\s*)\(?\s*([$A-Z_a-z][$\w]*(?:\s*(?:\?\.|\.)\s*[$A-Z_a-z][$\w]*)?)\s*(?:!==|!=)\s*(["'`])amazonBedrock\3\s*\)?/g,
        (_match, visibilityPrefix, authMethodExpression) =>
          `${visibilityPrefix}${authMethodExpression}=== \`chatgpt\``,
        "model visibility",
      );
    }
    if (
      source.includes("isServiceTierAllowed") &&
      source.includes("featureRequirements?.fast_mode") &&
      source.includes("authMethod:")
    ) {
      // 模型的速度档决定是否显示控件，账号权限及其加载状态不能隐藏控件。
      patched = replaceUniqueRendererGate(
        patched,
        /(\b([$A-Z_a-z][$\w]*)\s*=\s*)([$A-Z_a-z][$\w]*)\s*&&\s*!([$A-Z_a-z][$\w]*)\s*&&\s*([$A-Z_a-z][$\w]*)\s*!=\s*null\s*&&\s*\5\?\.requirements\?\.featureRequirements\?\.fast_mode\s*!==\s*!1/g,
        (_match, assignment) => `${assignment}!0`,
        "service tier UI",
      );
    }
    if (
      source.includes("isServiceTierAllowed") &&
      source.includes("serviceTierForRequest:") &&
      source.includes("availableOptions:")
    ) {
      // 保留按模型解析速度档的逻辑，移除账号权限参数，兼容权限提供方结构变化。
      patched = replaceUniqueRendererGate(
        patched,
        /(\?\s*)([$A-Z_a-z][$\w]*)\s*\?\s*([$A-Z_a-z][$\w]*)\s*:\s*null\s*:\s*([$A-Z_a-z][$\w]*)\(\s*([$A-Z_a-z][$\w]*)\s*,\s*\3\s*,\s*\2\s*\)/g,
        (_match, _questionMark, _isAllowedName, tierName, resolverName, modelName) =>
          `?${tierName}:${resolverName}(${modelName},${tierName})`,
        "service tier selection permission",
      );
      // 请求复用原生归一化后的速度档；切换到不支持该速度档的模型时使用空值。
      patched = replaceUniqueRendererGate(
        patched,
        /(\b([$A-Z_a-z][$\w]*)\s*=\s*([$A-Z_a-z][$\w]*)\s*==\s*null\s*\?\s*null\s*:\s*([$A-Z_a-z][$\w]*)\(\s*([$A-Z_a-z][$\w]*)\s*,\s*\3\s*\))(?=\s*;\s*let\s+[$A-Z_a-z][$\w]*\s*=\s*[$A-Z_a-z][$\w]*\(\s*\3\s*\?\?\s*null\s*\))/g,
        (_match, selectedExpression, selectedName, requestTierName) =>
          `${selectedExpression},${requestTierName}=${selectedName}`,
        "service tier model validation",
      );
      // 账号权限查询可独立于模型目录等待，不能把它计为速度选项仍在加载。
      patched = replaceUniqueRendererGate(
        patched,
        /(\b([$A-Z_a-z][$\w]*)\s*=\s*([$A-Z_a-z][$\w]*)\.isLoading\s*\|\|\s*([$A-Z_a-z][$\w]*)\s*\|\|\s*([$A-Z_a-z][$\w]*)\.isLoading(?:\s*\|\|\s*[$A-Z_a-z][$\w]*\?\.isLoading\s*===\s*!0)?)\s*\|\|\s*[$A-Z_a-z][$\w]*\s*==\s*null\s*&&\s*[$A-Z_a-z][$\w]*(?=\s*,)/g,
        (_match, modelLoadingExpression) => modelLoadingExpression,
        "service tier entitlement loading",
      );
    }
    if (
      source.includes("composer.toggleFastMode") &&
      source.includes("isServiceTierAllowed") &&
      source.includes("availableOptions.length")
    ) {
      // 根据当前模型提供的速度档决定是否显示速度控件。
      patched = replaceNearestRendererGateBeforeAnchor(
        patched,
        [
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?\s*&&\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*[$A-Z_a-z][$\w]*(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (_match, assignment, _resultName, settingsName, draftName) =>
              `${assignment}${settingsName}.availableOptions.length>1&&!${draftName}`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?\s*&&\s*[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (_match, assignment, _resultName, settingsName, draftName) =>
              `${assignment}${settingsName}.availableOptions.length>1&&!${draftName}`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?\s*&&\s*[$A-Z_a-z][$\w]*(?!\s*&&\s*!)(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (_match, assignment, _resultName, settingsName) =>
              `${assignment}${settingsName}.availableOptions.length>1`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*)\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?\s*&&\s*[$A-Z_a-z][$\w]*(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (
              _match,
              preservedPrefix,
              _resultName,
              _draftName,
              settingsName,
            ) => `${preservedPrefix}${settingsName}.availableOptions.length>1`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (
              _match,
              assignment,
              _resultName,
              draftName,
              settingsName,
            ) => `${assignment}!${draftName}&&${settingsName}.availableOptions.length>1`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)[$A-Z_a-z][$\w]*\s*&&\s*\(?\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1\s*\)?\s*&&\s*!\s*([$A-Z_a-z][$\w]*)(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (
              _match,
              assignment,
              _resultName,
              settingsName,
              draftName,
            ) => `${assignment}${settingsName}.availableOptions.length>1&&!${draftName}`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)[$A-Z_a-z][$\w]*\s*&&\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (_match, assignment, _resultName, settingsName) =>
              `${assignment}${settingsName}.availableOptions.length>1`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*)[$A-Z_a-z][$\w]*\s*&&\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*>\s*1(?=\s*[,;][\s\S]{0,8192}?`composer\.toggleFastMode`)/g,
            replacement: (
              _match,
              preservedPrefix,
              _resultName,
              _draftName,
              settingsName,
            ) => `${preservedPrefix}${settingsName}.availableOptions.length>1`,
          },
        ],
        undefined,
        "model-aware service tier control",
        "`composer.toggleFastMode`",
        8192,
      );
      if (source.includes("!=null")) {
        patched = replaceUniqueRendererGate(
          patched,
          [
            {
              pattern: /(`composer\.toggleFastMode`[\s\S]{0,4096}?\{\s*enabled\s*:\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*([$A-Z_a-z][$\w]*)\s*!=\s*null/g,
              replacement: (_match, prefix, loadingName, fastOptionName) =>
                `${prefix}!${loadingName}&&${fastOptionName}!=null`,
            },
            {
              pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)\s*&&\s*([$A-Z_a-z][$\w]*)\s*!=\s*null(?=\s*[,;][\s\S]{0,4096}?\{\s*enabled\s*:\s*\2\s*\}[\s\S]{0,4096}?`composer\.toggleFastMode`)/g,
              replacement: (
                _match,
                preservedPrefix,
                _resultName,
                _draftName,
                loadingName,
                fastOptionName,
              ) => `${preservedPrefix}!${loadingName}&&${fastOptionName}!=null`,
            },
          ],
          undefined,
          "model-aware Fast toggle",
        );
      }
    }
    if (
      source.includes("composer.speedSlashCommand.disableDescription") &&
      source.includes("isServiceTierAllowed") &&
      source.includes("availableOptions.map")
    ) {
      // 这些命令只为模型提供的速度档创建。
      patched = replaceUniqueRendererGate(
        patched,
        /(enabled\s*:\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)\.isLoading(?=\s*,\s*isSelected\s*:)/g,
        (_match, assignment, settingsName) =>
          `${assignment}!${settingsName}.isLoading`,
        "model-aware service tier commands",
      );
    }
    if (
      source.includes("isServiceTierAllowed") &&
      /availableOptions\.length\s*<=\s*1/.test(source) &&
      source.includes("selectedServiceTier")
    ) {
      patched = replaceUniqueRendererGate(
        patched,
        /if\s*\(\s*!\s*([$A-Z_a-z][$\w]*)\s*\|\|\s*([$A-Z_a-z][$\w]*)\.availableOptions\.length\s*<=\s*1\s*\)\s*return\s+null/g,
        (_match, _isAllowedName, settingsName) =>
          `if(${settingsName}.availableOptions.length<=1)return null`,
        "service tier settings UI",
      );
    }
    if (
      source.includes("Failed to load config requirements for service tier") &&
      source.includes("featureRequirements?.fast_mode")
    ) {
      // 账号权限查询不能移除当前模型已支持的请求速度档。
      patched = replaceUniqueRendererGate(
        patched,
        /if\s*\(\s*\(\s*await\s+([$A-Z_a-z][$\w]*)\(\s*\)\s*\)\.requirements\?\.featureRequirements\?\.fast_mode\s*===\s*!1\s*\)\s*return\s+null/g,
        "",
        "service tier request sanitizer",
      );
    }
    if (
      source.includes("Failed to read service tier for request") &&
      source.includes("featureRequirements?.fast_mode")
    ) {
      patched = replaceUniqueRendererGate(
        patched,
        /async\s+function\s+([$A-Z_a-z][$\w]*)\(\s*([$A-Z_a-z][$\w]*)\s*,\s*([$A-Z_a-z][$\w]*)\s*\)\s*\{\s*let\s+([$A-Z_a-z][$\w]*)\s*=\s*await\s+[$A-Z_a-z][$\w]*\(\s*\2\s*,\s*\3\s*\)\s*;\s*if\s*\(\s*\4\s*!==\s*`chatgpt`(?:\s*&&\s*\4\s*!==\s*`personalAccessToken`)?\s*\)\s*return\s*!1\s*;[\s\S]{0,768}?\.requirements\?\.featureRequirements\?\.fast_mode\s*!==\s*!1\s*\}/g,
        (_match, functionName, firstArgumentName, secondArgumentName) =>
          `async function ${functionName}(${firstArgumentName},${secondArgumentName}){return!0}`,
        "service tier request entitlement",
      );
    }
    if (
      source.includes("composer.intelligenceDropdown.model.title") &&
      source.includes("modelPickerTriggerConfig:") &&
      source.includes("selectedServiceTierIconKind:")
    ) {
      // 所有线路和模型使用新版入口，兼容新版缓存入口配置及移除旧字段的结构。
      patched = replaceUniqueRendererGate(
        patched,
        [
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)(?=\s*,[\s\S]{0,8192}?modelPickerTriggerConfig\s*:\s*\2\s*\?)/g,
            replacement: (
              _match,
              assignment,
              _triggerConfigName,
              hideLabelName,
            ) => `${assignment}!${hideLabelName}`,
          },
          {
            pattern: /(\b([$A-Z_a-z][$\w]*)\s*=\s*)[$A-Z_a-z][$\w]*\s*&&\s*!\s*([$A-Z_a-z][$\w]*)(?=\s*,[\s\S]{0,12288}?\b([$A-Z_a-z][$\w]*)\s*=\s*\2\s*\?\s*\{[\s\S]{0,2048}?selectedServiceTierIconKind\s*:[\s\S]{0,8192}?modelPickerTriggerConfig\s*:\s*\4\b)/g,
            replacement: (
              _match,
              assignment,
              _triggerConfigName,
              hideLabelName,
            ) => `${assignment}!${hideLabelName}`,
          },
        ],
        undefined,
        "fast model trigger availability",
      );
      // 保留原生 Fast 标识；原生模型和速度档检查会隐藏不支持的标识。
      patched = replaceUniqueRendererGate(
        patched,
        /(modelPickerTriggerConfig\s*:\s*([$A-Z_a-z][$\w]*)\s*[,}][\s\S]{0,2048}?selectedServiceTierIconKind\s*:[\s\S]{0,12288}?)if\s*\(\s*[$A-Z_a-z][$\w]*\s*&&\s*\2\s*!=\s*null\s*\)|if\s*\(\s*[$A-Z_a-z][$\w]*\s*&&\s*modelPickerTriggerConfig\s*!=\s*null\s*\)/g,
        (_match, aliasedPrefix, triggerConfigName) =>
          aliasedPrefix == null
            ? "if(modelPickerTriggerConfig!=null)"
            : `${aliasedPrefix}if(${triggerConfigName}!=null)`,
        "fast model trigger fallback",
      );
    }
    if (
      source.includes("activeInteractions=new Map") &&
      source.includes("beginCpuSampling") &&
      source.includes(
        "ensureHeartbeat(){this.heartbeatTimer??=setInterval",
      ) &&
      source.includes("rendererProcessCpuPercentAvg")
    ) {
      // Codey 启动时已关闭分析；保留交互生命周期，
      // 去掉会被丢弃的处理器采样和每秒心跳。
      patched = replaceUniqueRendererGate(
        patched,
        /cpuSampling:([$A-Z_a-z][$\w]*)===`dropped`\|\|([$A-Z_a-z][$\w]*)\.backfilled===!0\?null:this\.beginCpuSampling\(\)/g,
        "cpuSampling:null",
        "interaction CPU sampling",
      );
      patched = replaceUniqueRendererGate(
        patched,
        /ensureHeartbeat\(\)\{this\.heartbeatTimer\?\?=setInterval\(\(\)=>\{let ([$A-Z_a-z][$\w]*)=this\.now\(\),([$A-Z_a-z][$\w]*)=this\.wallNow\(\);for\(let ([$A-Z_a-z][$\w]*) of this\.activeInteractions\.values\(\)\)this\.recordHeartbeat\(\3,\1,\2\)\},([$A-Z_a-z][$\w]*)\)\}/g,
        "ensureHeartbeat(){}",
        "interaction heartbeat",
      );
    }
    return patched;
  };
  const discoveredCodexRendererAssets = new Set();
  const maximumDiscoveredCodexRendererAssets = 128;
  const rememberCodexRendererAsset = (baseUrl, specifier) => {
    try {
      const url = new URL(specifier, baseUrl);
      if (
        url.protocol !== "app:" ||
        !url.pathname.includes("/assets/") ||
        !/\.(?:c|m)?js$/i.test(url.pathname)
      ) return;
      discoveredCodexRendererAssets.delete(url.pathname);
      discoveredCodexRendererAssets.add(url.pathname);
      while (
        discoveredCodexRendererAssets.size >
        maximumDiscoveredCodexRendererAssets
      ) {
        const oldest = discoveredCodexRendererAssets.keys().next().value;
        if (oldest === undefined) break;
        discoveredCodexRendererAssets.delete(oldest);
      }
    } catch {}
  };
  const discoverCodexRendererAssets = (baseUrl, source) => {
    for (const match of source.matchAll(
      /\b(?:src|href)\s*=\s*(["'])([^"']+\.(?:c|m)?js(?:[?#][^"']*)?)\1/gi,
    )) rememberCodexRendererAsset(baseUrl, match[2]);
  };
  const isCodexRendererBootstrapUrl = (requestUrl) => {
    try {
      const url = new URL(requestUrl);
      return url.protocol === "app:" && /\/index\.html$/i.test(url.pathname);
    } catch {
      return false;
    }
  };
  const isCodexRendererAssetUrl = (requestUrl) => {
    try {
      const url = new URL(requestUrl);
      return (
        url.protocol === "app:" &&
        url.pathname.includes("/assets/") &&
        (
          /\/(?:(?:app-initial|app-shared|codex-composer-adapter|general-settings|model-list-filter|windows-model-controls|use-service-tier-settings|read-service-tier-for-request|subagent-activity-chip-group)(?:[~-][^/]*)?)\.(?:c|m)?js$/i.test(
            url.pathname,
          ) ||
          (
            disablePet &&
            /\/(?:(?:appearance-settings|pet-settings|pets-settings)(?:[~-][^/]*)?)\.(?:c|m)?js$/i.test(
              url.pathname,
            )
          ) ||
          discoveredCodexRendererAssets.has(url.pathname)
        )
      );
    } catch {
      return false;
    }
  };
  // CDP Fetch 拦截入口：输入响应体文本，返回改写后的文本；null 表示放行原响应。
  // index.html 只用于发现资产清单，不写回。
  globalThis.__codeyRendererPatchEntry = (requestUrl, source) => {
    try {
      if (typeof requestUrl !== "string" || typeof source !== "string") {
        return null;
      }
      if (isCodexRendererBootstrapUrl(requestUrl)) {
        try {
          discoverCodexRendererAssets(requestUrl, source);
        } catch (error) {
          recordCodeyPatchFailure("renderer_patch:asset discovery", error, {
            requestUrl,
          });
        }
        return null;
      }
      if (!isCodexRendererAssetUrl(requestUrl)) return null;
      let patched;
      const previousRendererPatchFailures = activeRendererPatchFailures;
      activeRendererPatchFailures = rendererPatchFailuresForSource(source);
      try {
        patched = patchCodexRendererAsset(source);
      } catch (error) {
        // 渲染器压缩代码会随版本变化。可选界面补丁失败时放行原响应，
        // 避免模块请求失败导致启动页停留。
        recordCodeyPatchFailure("patch_codex_renderer_asset", error, {
          requestUrl,
        });
        try {
          console.error("Codey skipped an incompatible Codex renderer patch", error);
        } catch {}
        return null;
      } finally {
        activeRendererPatchFailures = previousRendererPatchFailures;
      }
      return patched === source ? null : patched;
    } catch (error) {
      try {
        console.error("[Codey] renderer asset patch entry failed", error);
      } catch {}
      return null;
    }
  };
  globalThis.__codeyRendererPatchInstalled = true;
})();
