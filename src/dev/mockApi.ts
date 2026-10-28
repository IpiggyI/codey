// Development-only preview data and a mock Codey bridge API. Loaded from
// main.tsx via a dynamic import that only exists in Vite dev builds, so this
// module never ships in the production overlay.
import type {
  ChannelEntry,
  ChannelList,
  ProviderStatus,
  Config,
  ConfigApplyStatus,
  ModelState,
} from "../App.types";
import {
  AUTO_REVIEW_MODEL,
  includesModelId,
  modelIdsEqual,
  modelKey,
  uniqueModelIds,
} from "../modelIds";
import { validateNtfyTopic } from "../notifications/types";
import { createCodexExtensionsPreview } from "./codexExtensionsMock";
import { previewOfficialModels, previewUpstreamModels } from "../previewModels";
import {
  previewCrashpadPendingStats,
  previewTraceLogStats,
} from "../previewTraceLogStats";

// 在 Vite 开发模式下，若未通过 Codey Bridge/Token 访问，自动注入 Mock 接口方便 UI 调试
if (import.meta.env.DEV) {
  if (!window.__codeyInvokeApi) {
    console.log("[Dev Mode] Auto-injecting Codey Mock API");
    const previewClientPlatform =
      new URLSearchParams(window.location.search).get("platform") === "windows"
        ? "windows"
        : "macos";
    const configRepairPreview = new URLSearchParams(window.location.search).get("configRepair");
    const channelFallbackPreview = new URLSearchParams(window.location.search).get("channelFallback") === "1";
    const previewEndpoints = {
      primary: "https://primary.example.invalid/v1",
      backup: "https://backup.example.invalid/v1",
      feishu: "https://webhook.example.invalid/feishu/preview-only",
      wecom: "https://webhook.example.invalid/wecom/preview-only?key=preview",
      ntfy: "https://ntfy.example.invalid",
    } as const;
    type PreviewProfile = {
      id: string;
      name: string;
      shortName: string;
      baseUrl: string;
      apiKey: string;
      upstreamProtocol: "openaiResponses" | "openaiChatCompletions";
      authMode: "apiKey" | "officialAccount";
      apiKeyConfigured: boolean;
      clearApiKey: boolean;
      sourceProviderId?: string;
      officialAccount: boolean;
      supportsRemoteCompaction: boolean;
      supportsNativeWebSearch: boolean;
      supportsAutoReview: boolean;
    };
    let previewActiveProfileId = "primary";
    let previewComputerUseReady = false;
    // 预览中保存后先返回应用中，下一次运行状态查询时完成应用。
    let previewConfigApply: ConfigApplyStatus | null = null;
    let previewRoutes: PreviewProfile[] = [
        {
          id: "primary",
          name: "主力代理 (ChatGPT)",
          shortName: "主",
          baseUrl: previewEndpoints.primary,
          apiKey: "preview-route-primary-key",
          upstreamProtocol: "openaiResponses",
          authMode: "apiKey",
          apiKeyConfigured: true,
          clearApiKey: false,
          sourceProviderId: "primary",
          officialAccount: false,
          supportsRemoteCompaction: false,
          supportsNativeWebSearch: false,
          supportsAutoReview: false,
        },
        {
          id: "backup",
          name: "备用中转 (Claude)",
          shortName: "备",
          baseUrl: previewEndpoints.backup,
          apiKey: "preview-route-backup-key",
          upstreamProtocol: "openaiChatCompletions",
          authMode: "apiKey",
          apiKeyConfigured: true,
          clearApiKey: false,
          sourceProviderId: "backup",
          officialAccount: false,
          supportsRemoteCompaction: false,
          supportsNativeWebSearch: false,
          supportsAutoReview: false,
        },
    ];
    let previewConfig: Config = {
      settingsRevision: 0,
      webhook: {
        channels: [
          {
            id: "preview-feishu",
            kind: "feishu" as const,
            enabled: true,
            url: previewEndpoints.feishu,
            urlConfigured: true,
            clearUrl: false,
            botToken: "",
            botTokenConfigured: false,
            clearBotToken: false,
            contextToken: "",
            contextTokenConfigured: false,
            clearContextToken: false,
            chatId: "",
          },
          {
            id: "preview-wecom",
            kind: "wecom" as const,
            enabled: true,
            url: previewEndpoints.wecom,
            urlConfigured: true,
            clearUrl: false,
            botToken: "",
            botTokenConfigured: false,
            clearBotToken: false,
            contextToken: "",
            contextTokenConfigured: false,
            clearContextToken: false,
            chatId: "",
          },
          {
            id: "preview-telegram",
            kind: "telegram" as const,
            enabled: false,
            url: "",
            urlConfigured: false,
            clearUrl: false,
            botToken: "",
            botTokenConfigured: true,
            clearBotToken: false,
            contextToken: "",
            contextTokenConfigured: false,
            clearContextToken: false,
            chatId: "preview-chat-id",
          },
          {
            id: "preview-ntfy",
            kind: "ntfy" as const,
            enabled: true,
            url: previewEndpoints.ntfy,
            urlConfigured: true,
            clearUrl: false,
            botToken: "",
            botTokenConfigured: false,
            clearBotToken: false,
            contextToken: "",
            contextTokenConfigured: false,
            clearContextToken: false,
            chatId: "preview-ntfy-topic",
          },
        ],
      },
      promptOptimization: {
        enabled: true,
        mode: "currentProvider",
        baseUrl: previewEndpoints.primary,
        apiKey: "preview-prompt-optimization-key",
        apiKeyConfigured: true,
        clearApiKey: false,
        model: "provider-fast-coder",
        upstreamProtocol: "openaiResponses",
        instruction: "",
      },
      codexAppPath: "/Applications/ChatGPT.app",
      userScripts: [],
      selectedModelsByProvider: {
        primary: ["provider-fast-coder", "claude-sonnet-4-5"],
        backup: ["claude-sonnet-4-5", "claude-opus-4-1"],
      },
      supports1MContextByProvider: {},
      modelContextByProvider: {},
      manualThirdPartyModelsByProvider: {
        primary: ["provider-fast-coder"],
      },
      declaredOfficialModelsByProvider: {} as Record<string, string[]>,
      upstreamModelsByProvider: {
        primary: previewUpstreamModels,
        backup: ["claude-sonnet-4-5", "claude-opus-4-1"],
      },
      defaultModel: "provider-fast-coder",
      disableTraceLogWrites: true,
      protectCrashpadPending: true,
      slimCodexPet: true,
      gpuLaunchMode: "off" as const,
      codexLaunchProxy: "",
      fastContextTools: false,
      subagentOptimization: false,
      subagentModel: "gpt-5.6-terra",
      subagentReasoningEffort: "medium",
      subagentRoles: {
        codey_quick_scan: { enabled: true, model: "gpt-5.6-sol", reasoningEffort: "low" },
        codey_deep_research: { enabled: true, model: "gpt-5.6-sol", reasoningEffort: "high" },
        codey_visual_analysis: {
          enabled: true,
          model: "claude-sonnet-4-5",
          reasoningEffort: "high",
        },
        codey_worker: { enabled: true, model: "provider-fast-coder", reasoningEffort: "medium" },
        codey_visual_worker: { enabled: true, model: "gpt-5.6-sol", reasoningEffort: "high" },
        default: { enabled: true, model: "gpt-5.6-sol", reasoningEffort: "medium" },
      },
      hideFullAccessWarning: false,
      showAccountUsageInHeader: true,
      quotaUnlockEnabled: true,
      cacheValidMinutes: 30,
      // ?channelFallback=1 预览所选渠道已从用户配置中删除时的回退提示。
      selectedChannelId: channelFallbackPreview ? "provider:removed" : null,
      defaultModelsByChannel: {},
    };
    let previewModelState: ModelState = {
      officialModels: previewOfficialModels.map((model) => ({
        ...model,
        supported: includesModelId(previewUpstreamModels, model.slug),
      })),
      officialModelIds: previewOfficialModels.map((model) => model.slug),
      thirdPartyModels: ["provider-fast-coder", "claude-sonnet-4-5"],
      manualThirdPartyModels: ["provider-fast-coder"],
      upstreamModels: previewUpstreamModels,
      defaultModel: "gpt-5.6-sol",
    };
    const routeProviderId = (profile: PreviewProfile) =>
      profile.sourceProviderId || profile.id;
    const activePreviewProfile = () =>
      previewRoutes.find(
        (profile) => profile.id === previewActiveProfileId,
      ) || previewRoutes[0];
    const previewProviderStatus = (): ProviderStatus => {
      const profile = activePreviewProfile();
      return {
        changed: false,
        provider: {
          id: profile ? routeProviderId(profile) : "openai",
          name: profile?.name || "OpenAI 官方直登",
          official: profile?.authMode === "officialAccount",
          baseUrl: profile?.baseUrl || "",
        },
      };
    };
    const previewCurrentProviderSnapshot = () => {
      const profile = activePreviewProfile();
      const id = profile ? routeProviderId(profile) : "openai";
      // 没有有效所选渠道时省略 channelId，不发 null。
      const selected = previewConfig.selectedChannelId;
      const channelId = previewChannelCatalog.some((entry) => entry.id === selected && entry.available)
        ? selected
        : null;
      return {
        id,
        baseUrl: (profile?.baseUrl || "").replace(/\/+$/, ""),
        wireApi: "responses",
        usesOfficialAccountAuth: profile?.authMode === "officialAccount",
        ownershipKey: id,
        ...(channelId ? { channelId } : {}),
      };
    };
    const CHANNEL_FALLBACK_NOTICE = "所选渠道已不可用，已回退到用户配置的默认 provider。";
    const channelVersionConflictMessage = "Codey 设置已被其他操作更新，请刷新后重试";
    // 预览用的渠道目录：两个 provider、一个缺少密钥的 provider、官方账号和一个无法选择的官方占位。
    const previewChannelCatalog = [
      { id: "provider:primary", kind: "provider", providerId: "primary", displayName: "主中转", available: true, unavailableReason: null },
      { id: "provider:backup", kind: "provider", providerId: "backup", displayName: "备用中转 (Claude)", available: true, unavailableReason: null },
      { id: "provider:offline", kind: "provider", providerId: "offline", displayName: "离线中转", available: false, unavailableReason: "环境变量 OFFLINE_API_KEY 未设置" },
      { id: "official:preview-account", kind: "official", providerId: "openai", displayName: "官方账号", available: true, unavailableReason: null },
      { id: "official:unavailable", kind: "official", providerId: "openai", displayName: "官方账号（未登录）", available: false, unavailableReason: "没有可用的官方账号登录" },
    ] as const;
    // 预览里“正在运行的 Codex”所用的渠道与模型，重启后与当前渠道对齐。
    const previewChannelRunKey = () => {
      const list = previewChannelList();
      const current = list.channels.find((entry) => entry.current);
      return `${current?.id ?? ""}|${current?.defaultModel ?? ""}`;
    };
    let previewChannelRunning = "";
    const previewChannelList = (): ChannelList => {
      const selected = previewConfig.selectedChannelId;
      const found = previewChannelCatalog.find((entry) => entry.id === selected);
      const effective = found ?? previewChannelCatalog[0];
      const channels: ChannelEntry[] = previewChannelCatalog.map((entry) => ({
        ...entry,
        defaultModel: previewConfig.defaultModelsByChannel[entry.id] ?? null,
        current: entry.id === effective.id,
      }));
      return {
        channels,
        selectedChannelId: selected,
        effectiveProviderId: effective.providerId,
        notice: selected !== null && !found ? CHANNEL_FALLBACK_NOTICE : null,
      };
    };
    previewChannelRunning = previewChannelRunKey();
    const channelRestartRequired = () => previewChannelRunKey() !== previewChannelRunning;
    const previewChannelMutationResult = () => ({
      status: "ok",
      channelList: previewChannelList(),
      settingsRevision: previewConfig.settingsRevision,
      restartRequired: channelRestartRequired(),
    });
    const previewModelStateForProfile = (profile: PreviewProfile): ModelState => {
      const providerId = routeProviderId(profile);
      const official = profile.authMode === "officialAccount";
      const upstream = previewConfig.upstreamModelsByProvider[providerId] || [];
      const selected = previewConfig.selectedModelsByProvider[providerId] || [];
      const manual = previewConfig.manualThirdPartyModelsByProvider[providerId] || [];
      const selectableOfficial = previewOfficialModels.filter(
        (model) => official && (selected.length === 0 || includesModelId(selected, model.slug)),
      );
      const thirdPartyModels = official ? [] : selected;
      const requestedDefault = previewConfig.defaultModel;
      const defaultModel =
        [
          ...selectableOfficial.map((model) => model.slug),
          ...thirdPartyModels,
        ].find(
          (model) =>
            Boolean(requestedDefault) &&
            modelIdsEqual(model, requestedDefault),
        ) ||
        selectableOfficial[0]?.slug ||
        thirdPartyModels[0] ||
        "";
      return {
        officialModels: official ? previewOfficialModels.map((model) => ({
          ...model,
          supported: selected.length === 0 || includesModelId(selected, model.slug),
        })) : [],
        officialModelIds: previewOfficialModels.map((model) => model.slug),
        thirdPartyModels,
        manualThirdPartyModels: manual.filter((model) =>
          includesModelId(thirdPartyModels, model),
        ),
        upstreamModels: official ? [] : upstream,
        defaultModel,
      };
    };
    const refreshPreviewModelState = () => {
      const profile = activePreviewProfile();
      if (profile) previewModelState = previewModelStateForProfile(profile);
    };
    let previewTraceStats: typeof previewTraceLogStats | undefined;
    let previewCrashpadStats:
      | typeof previewCrashpadPendingStats
      | undefined = previewCrashpadPendingStats;
    const previewRouteRequestLogs = Array.from({ length: 47 }, (_, index) => {
      const primary = index % 3 !== 1;
      const failed = index % 9 === 4;
      const protocol = (["sse", "ws", "http"] as const)[index % 3];
      const inputTokens = 1_200 + index * 137;
      const outputTokens = failed ? undefined : 240 + index * 29;
      const cachedInputTokens = index % 4 === 0 ? 640 + index * 11 : undefined;
      const codexSessionIsParent = index % 8 === 0;
      return {
        requestId: `preview-request-${String(index + 1).padStart(4, "0")}`,
        traceId: `preview-trace-${String(index + 1).padStart(4, "0")}`,
        codexSessionId: index % 10 === 9
          ? null
          : `preview-${codexSessionIsParent ? "parent-" : ""}session-${String(index + 1).padStart(4, "0")}`,
        codexSessionIsParent,
        timestampUnixMs: Date.now() - index * 83_000,
        provider: primary ? "primary" : "backup",
        providerName: primary ? "主力代理 (ChatGPT)" : "备用中转 (Claude)",
        requestedModel: primary ? "provider-fast-coder" : "claude-sonnet-4-5",
        model: primary ? "provider-fast-coder" : "claude-sonnet-4-5",
        reasoningEffort: (["low", "medium", "high"] as const)[index % 3],
        thinkingBudgetTokens: undefined,
        ttftMs: failed ? undefined : 190 + index * 13,
        routerPreUpstreamMs: failed ? undefined : 12 + index,
        upstreamFirstByteMs: failed ? undefined : 190 + index * 13,
        downstreamFirstContentMs: failed ? undefined : 215 + index * 14,
        upstreamHeaderMs: 120 + index * 8,
        totalDurationMs: failed ? 1_640 + index * 31 : 2_350 + index * 91,
        queueDelayMs: index % 5,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens: undefined,
        reasoningOutputTokens: outputTokens ? Math.floor(outputTokens / 4) : undefined,
        totalTokens: outputTokens == null ? inputTokens : inputTokens + outputTokens,
        usageReported: !failed,
        usageUnavailableReason: failed ? "upstream_error" : undefined,
        requestProtocol: protocol,
        upstreamTransport: protocol === "ws" ? "ws" : "http",
        requestKind: "responses",
        status: failed ? "failed" : "succeeded",
        statusCode: failed ? 502 : 200,
        upstreamStatusCode: failed ? 429 : 200,
        errorCode: failed ? "upstream_rate_limited" : undefined,
        upstreamErrorSummary: failed
          ? "供应商额度不足，请稍后重试或切换备用线路（代码：rate_limit_exceeded）"
          : undefined,
        completionReason: failed ? undefined : "completed",
        fallbackCount: failed ? 1 : 0,
        fallbackReason: failed ? "rate_limited" : undefined,
        upstreamAuthority: primary ? "primary.example.invalid" : "backup.example.invalid",
        upstreamRequestId: `upstream-preview-${index + 1}`,
        upstreamProtocol: primary ? "openaiResponses" : "openaiChatCompletions",
        protocolBridge: primary ? undefined : "chat_completions_to_responses",
        firstByteSource: protocol === "http" ? "headers" : "stream",
        subagent: index % 6 === 0,
      };
    });

    const extensionsPreview = createCodexExtensionsPreview(previewClientPlatform);

    window.__codeyInvokeApi = async (command, args) => {
      console.log(`[Mock API Call] ${command}`, args);
      // Wait a tiny bit to simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 300));

      if (command === "codex_extensions") return extensionsPreview(args?.request as Record<string, unknown>);

      if (command === "load_codey_config") {
        return {
          config: previewConfig,
          modelState: previewModelState,
          startupError: undefined,
          providerStatus: previewProviderStatus(),
          currentProviderSnapshot: previewCurrentProviderSnapshot(),
          fastContextToolsStatus: {
            userConfigured: false,
            detectionFailed: false,
          },
        };
      }
      if (
        command === "plugin_marketplace_status" ||
        command === "repair_plugin_marketplace" ||
        command === "prepare_computer_use"
      ) {
        if (command === "prepare_computer_use") previewComputerUseReady = true;
        return {
          status: "ready",
          needsRepair: false,
          officialMarketplace: true,
          remoteMarketplace: true,
          remoteRegistered: true,
          managedConfigCompatible: true,
          computerUse: { supported: true, ready: previewComputerUseReady },
        };
      }
      if (command === "runtime_status") {
        const activeNotificationChannelCount =
          previewConfig.webhook.channels.filter(
            (channel) =>
              channel.enabled &&
              (channel.kind === "telegram" || channel.kind === "wechatClaw"
                ? channel.botTokenConfigured &&
                  Boolean(channel.chatId.trim()) &&
                  (channel.kind !== "wechatClaw" ||
                    (channel.sessionStatus !== "expired" &&
                      channel.urlConfigured &&
                      channel.contextTokenConfigured))
                : channel.kind === "ntfy"
                  ? channel.urlConfigured && !validateNtfyTopic(channel.chatId)
                  : channel.urlConfigured),
          ).length;
        const configApply = previewConfigApply;
        if (previewConfigApply?.state === "pending") {
          previewConfigApply = { revision: previewConfigApply.revision, state: "applied" };
        }
        return {
          configApply,
          running: true,
          appVersion: "0.2.0",
          codexAppVersion: "26.601.21317",
          clientPlatform: previewClientPlatform,
          restartRequired: channelRestartRequired(),
          restartInProgress: false,
          channelNotice: previewChannelList().notice,
          activeProfileId: previewActiveProfileId,
          activeProfileName:
            previewRoutes.find(
              (p) => p.id === previewActiveProfileId,
            )?.name || "未命名代理",
          codexAppPath: previewConfig.codexAppPath,
          maintenance: {
            sessionStatus: "ready",
            sessionFilesFixed: 3,
            sqliteRowsUpdated: 7,
            ghostTasksPruned: 2,
            performanceStatus: "ready",
            performanceDetail: "Codex 启动成功",
          },
          injectionScripts: [
            {
              id: "bridge-helpers",
              name: "桥接辅助",
              source: "builtin",
              visibility: "internal",
              status: "effective",
              detail: "桥接函数可调用",
            },
            {
              id: "model-whitelist",
              name: "模型白名单",
              source: "builtin",
              visibility: "internal",
              status: "effective",
              detail: "模型目录已加载（5 个模型）",
            },
            {
              id: "pet-control-shield",
              name: "宠物控制精简",
              source: "builtin",
              visibility: "feature",
              status: "effective",
              detail: "宠物控制精简已启用",
            },
            {
              id: "security-warning-shield",
              name: "安全提示控制",
              source: "builtin",
              visibility: "feature",
              status: "inactive",
              detail: "控制器已就绪，当前屏蔽策略关闭",
            },
            {
              id: "settings-overlay-loader",
              name: "配置面板加载器",
              source: "builtin",
              visibility: "internal",
              status: "effective",
              detail: "配置面板按需加载器可用",
            },
            {
              id: "renderer-controls",
              name: "渲染器控制",
              source: "builtin",
              visibility: "internal",
              status: "effective",
              detail: "渲染器控制与按需加载 API 可用",
            },
            {
              id: "plugin-marketplace-compatibility",
              name: "插件市场兼容",
              source: "builtin",
              visibility: "internal",
              status: "effective",
              detail: "插件市场桥接已接管",
            },
          ],
          fastContextToolsActive: previewConfig.fastContextTools,
          subagentOptimizationActive: previewConfig.subagentOptimization,
          notificationChannelsActive: activeNotificationChannelCount > 0,
          activeNotificationChannelCount,
          traceLogWriteProtectionActive: previewConfig.disableTraceLogWrites,
          crashpadDiskProtectionActive:
            previewClientPlatform === "macos" &&
            previewConfig.protectCrashpadPending,
          ...(previewTraceStats ? { traceLogStats: previewTraceStats } : {}),
          ...(previewCrashpadStats
            ? { crashpadPendingStats: previewCrashpadStats }
            : {}),
        };
      }
      if (command === "refresh_diagnostic_storage_stats") {
        previewTraceStats = previewTraceLogStats;
        previewCrashpadStats = {
          ...previewCrashpadPendingStats,
          protectionEnabled: previewConfig.protectCrashpadPending,
        };
        return {
          status: "ok",
          traceLogStats: previewTraceStats,
          crashpadPendingStats: previewCrashpadStats,
        };
      }
      if (command === "refresh_trace_log_stats") {
        previewTraceStats = previewTraceLogStats;
        return { status: "ok", traceLogStats: previewTraceStats };
      }
      if (command === "query_route_request_logs") {
        const page = Math.max(1, Number(args.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(args.pageSize) || 20));
        const search = String(args.search || "").trim().toLocaleLowerCase();
        const provider = String(args.provider || "");
        const model = String(args.model || "");
        const status = String(args.status || "");
        const protocol = String(args.protocol || "");
        const filtered = previewRouteRequestLogs.filter((item) => {
          if (provider && item.provider !== provider && item.providerName !== provider) return false;
          if (model && item.model !== model && item.requestedModel !== model) return false;
          if (status && item.status !== status) return false;
          if (protocol && item.requestProtocol !== protocol) return false;
          if (!search) return true;
          return [
            item.requestId,
            item.traceId,
            item.codexSessionId,
            item.provider,
            item.providerName,
            item.model,
            item.upstreamAuthority,
            item.upstreamErrorSummary,
          ].some((value) => value?.toLocaleLowerCase().includes(search));
        });
        const totalPages = Math.ceil(filtered.length / pageSize);
        return {
          status: "ok",
          backend: "sqlite",
          queryable: true,
          page,
          pageSize,
          total: filtered.length,
          totalPages,
          items: filtered.slice((page - 1) * pageSize, page * pageSize),
        };
      }
      if (command === "clear_route_request_logs") {
        const hadLogs = previewRouteRequestLogs.length > 0;
        previewRouteRequestLogs.length = 0;
        return {
          status: "ok",
          removedFileCount: hadLogs ? 1 : 0,
          removedFiles: hadLogs ? ["route-requests.sqlite3"] : [],
          recordingEnabled: true,
          recordingActive: true,
          recordingRestarted: true,
        };
      }
      if (command === "save_codey_config") {
        const incoming = args.config as Config;
        previewConfig = {
          ...incoming,
          promptOptimization: {
            ...incoming.promptOptimization,
            apiKey: incoming.promptOptimization.clearApiKey
              ? ""
              : incoming.promptOptimization.apiKey,
            apiKeyConfigured:
              !incoming.promptOptimization.clearApiKey &&
              Boolean(incoming.promptOptimization.apiKey.trim()),
            clearApiKey: false,
          },
          settingsRevision: previewConfig.settingsRevision + 1,
          // 普通保存不改渠道字段，渠道变更走专用命令。
          selectedChannelId: previewConfig.selectedChannelId,
          defaultModelsByChannel: previewConfig.defaultModelsByChannel,
        };
        refreshPreviewModelState();
        previewConfigApply = {
          revision: (previewConfigApply?.revision ?? 0) + 1,
          state: "pending",
        };
        return {
          config: previewConfig,
          configApply: previewConfigApply,
          modelState: previewModelState,
          providerStatus: previewProviderStatus(),
          currentProviderSnapshot: previewCurrentProviderSnapshot(),
          fastContextToolsStatus: {
            userConfigured: false,
            detectionFailed: false,
          },
          restartRequired: false,
        };
      }
      if (command === "list_channels") return previewChannelList();
      if (command === "set_channel_default_model" || command === "select_channel") {
        const failed = (message: string) => ({ status: "failed", message });
        // 参数校验与错误文案对齐后端 argument()，包括 serde 的类型错误描述。
        const describe = (value: unknown) =>
          value === null ? "null"
            : typeof value === "string" ? `string "${value}"`
            : typeof value === "boolean" ? `boolean \`${value}\``
            : typeof value === "number" ? (Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``)
            : Array.isArray(value) ? "sequence" : "map";
        const argumentError = (name: string, detail: string) => failed(`参数 ${name} 无效：${detail}`);
        if (!("expectedRevision" in args)) return failed("缺少参数：expectedRevision");
        const revision = args.expectedRevision;
        if (typeof revision !== "number" || !Number.isInteger(revision)) {
          return argumentError("expectedRevision", `invalid type: ${describe(revision)}, expected u64`);
        }
        if (revision < 0) {
          return argumentError("expectedRevision", `invalid value: integer \`${revision}\`, expected u64`);
        }
        if (revision !== previewConfig.settingsRevision) {
          return failed(channelVersionConflictMessage);
        }
        if (!("channelId" in args)) return failed("缺少参数：channelId");
        const rawId = args.channelId;
        const setDefault = command === "set_channel_default_model";
        if (typeof rawId !== "string" && !(rawId === null && !setDefault)) {
          return argumentError("channelId", `invalid type: ${describe(rawId)}, expected a string`);
        }
        const channelId = rawId as string | null;
        const entry = previewChannelCatalog.find((candidate) => candidate.id === channelId && candidate.available);
        if (setDefault) {
          if (!("model" in args)) return failed("缺少参数：model");
          if (typeof args.model !== "string") {
            return argumentError("model", `invalid type: ${describe(args.model)}, expected a string`);
          }
          const model = args.model.trim();
          if (!model) return failed("渠道默认模型不能为空");
          if (!entry) return failed("所选渠道不可用");
          previewConfig = {
            ...previewConfig,
            settingsRevision: previewConfig.settingsRevision + 1,
            defaultModelsByChannel: { ...previewConfig.defaultModelsByChannel, [entry.id]: model },
          };
          return previewChannelMutationResult();
        }
        if (channelId !== null) {
          if (!entry) return failed("所选渠道不可用");
          if (!previewConfig.defaultModelsByChannel[entry.id]?.trim()) {
            return failed("请先为渠道设置默认模型");
          }
        }
        previewConfig = {
          ...previewConfig,
          settingsRevision: previewConfig.settingsRevision + 1,
          selectedChannelId: channelId,
        };
        const effectiveProviderId = previewChannelList().effectiveProviderId;
        previewActiveProfileId = previewRoutes.find((profile) => routeProviderId(profile) === effectiveProviderId)?.id
          ?? "primary";
        return previewChannelMutationResult();
      }
      if (command === "sync_current_provider") {
        return {
          config: previewConfig,
          modelState: previewModelState,
          providerStatus: previewProviderStatus(),
          currentProviderSnapshot: previewCurrentProviderSnapshot(),
          restartRequired: false,
        };
      }
      if (command === "fetch_route_models") {
        const expectedRevision = Number(args.expectedRevision);
        if (expectedRevision !== previewConfig.settingsRevision) {
          return {
            status: "failed",
            message: "Codey 设置已被其他操作更新，请重新载入后再操作线路",
          };
        }
        const routeId = String(args.routeId || "");
        const snapshot = previewCurrentProviderSnapshot();
        const route = routeId
          ? previewRoutes.find((profile) => profile.id === routeId)
          : previewRoutes.find((profile) =>
              (profile.sourceProviderId || profile.id) === snapshot.ownershipKey,
            ) || previewRoutes.find((profile) => profile.authMode !== "officialAccount");
        if (!route) return { status: "failed", message: "找不到要同步模型的线路" };
        const providerId = snapshot.ownershipKey || routeProviderId(route);
        const fetchedModels = uniqueModelIds([
          ...previewUpstreamModels,
          ...(providerId === "backup" ? ["claude-sonnet-4-5"] : []),
        ]);
        const supportsAutoReview = includesModelId(
          fetchedModels,
          AUTO_REVIEW_MODEL,
        );
        const models = fetchedModels.filter(
          (model) => !modelIdsEqual(model, AUTO_REVIEW_MODEL),
        );
        previewRoutes = previewRoutes.map((profile) =>
          profile.id === route.id
            ? { ...profile, supportsAutoReview }
            : profile,
        );
        previewConfig = {
          ...previewConfig,
          settingsRevision: previewConfig.settingsRevision + 1,
          upstreamModelsByProvider: {
            ...previewConfig.upstreamModelsByProvider,
            [providerId]: models,
          },
        };
        refreshPreviewModelState();
        return {
          status: "ok",
          config: previewConfig,
          modelState: previewModelState,
          routeModelState: previewModelStateForProfile(route),
          providerStatus: previewProviderStatus(),
          currentProviderSnapshot: previewCurrentProviderSnapshot(),
          models,
          restartRequired: false,
          modelHotReloaded: true,
        };
      }
      if (command === "clear_diagnostic_storage") {
        previewTraceStats = {
          ...previewTraceLogStats,
          databaseBytes: 49152,
          rowCount: 0,
          estimatedLogBytes: 0,
        };
        previewCrashpadStats = {
          ...previewCrashpadPendingStats,
          protectionEnabled: previewConfig.protectCrashpadPending,
          reportsFound: 0,
          completeReports: 0,
          filesFound: 0,
          managedFiles: 0,
          pendingBytes: 0,
          managedBytes: 0,
        };
        return {
          status: "ok",
          traceProtectionEnabled: previewConfig.disableTraceLogWrites,
          traceLogWriteProtectionActive: previewConfig.disableTraceLogWrites,
          crashpadProtectionEnabled: previewConfig.protectCrashpadPending,
          errors: [],
          traceCleanup: {
            databasesFound: 1,
            databasesCleaned: 1,
            rowsDeleted: 30141,
            bytesBefore: 406921216,
            bytesAfter: 49152,
            bytesReclaimed: 406872064,
          },
          crashpadCleanup: {
            directoriesFound: 2,
            reportsFound: 13,
            reportsDeleted: 13,
            filesFound: 26,
            filesDeleted: 26,
            orphanFilesDeleted: 0,
            unmanagedFiles: 0,
            skippedRecentReports: 0,
            bytesBefore: 3448832,
            bytesAfter: 0,
            bytesReclaimed: 3448832,
            limitApplied: false,
            stillOverLimit: false,
            errors: [],
          },
          traceLogStats: previewTraceStats,
          crashpadPendingStats: previewCrashpadStats,
        };
      }
      if (command === "save_selected_models") {
        const routeId = String(args.routeId || "");
        const targetProfile = previewRoutes.find(
          (profile) => profile.id === routeId,
        ) || activePreviewProfile();
        const providerId = targetProfile ? routeProviderId(targetProfile) : "primary";
        const officialModels = (args.officialModels as string[]) || [];
        const thirdPartyModels = (args.thirdPartyModels as string[]) || [];
        const manualThirdPartyModels = (args.manualThirdPartyModels as string[]) || [];
        const supportsAutoReview =
          typeof args.supportsAutoReview === "boolean"
            ? args.supportsAutoReview
            : targetProfile?.supportsAutoReview === true;
        if (targetProfile) {
          previewRoutes = previewRoutes.map((profile) =>
            profile.id === targetProfile.id
              ? { ...profile, supportsAutoReview }
              : profile,
          );
        }
        const supportedModels = uniqueModelIds([
          ...officialModels,
          ...thirdPartyModels,
        ]).filter((model) => !modelIdsEqual(model, AUTO_REVIEW_MODEL));
        previewConfig = {
          ...previewConfig,
          settingsRevision: previewConfig.settingsRevision + 1,
          selectedModelsByProvider: {
            ...previewConfig.selectedModelsByProvider,
            [providerId]: (targetProfile?.authMode === "officialAccount" ? officialModels : thirdPartyModels).filter(
              (model) => !modelIdsEqual(model, AUTO_REVIEW_MODEL),
            ),
          },
          manualThirdPartyModelsByProvider: {
            ...previewConfig.manualThirdPartyModelsByProvider,
            [providerId]: manualThirdPartyModels.filter(
              (model) => !modelIdsEqual(model, AUTO_REVIEW_MODEL),
            ),
          },
          declaredOfficialModelsByProvider: {
            ...previewConfig.declaredOfficialModelsByProvider,
            [providerId]: [],
          },
          upstreamModelsByProvider: {
            ...previewConfig.upstreamModelsByProvider,
            [providerId]: uniqueModelIds([
              ...(previewConfig.upstreamModelsByProvider[providerId] || []),
              ...supportedModels,
            ]),
          },
        };
        refreshPreviewModelState();
        return {
          status: "ok",
          config: previewConfig,
          modelState: previewModelState,
          restartRequired: false,
          modelHotReloaded: true,
        };
      }
      if (command === "save_default_model") {
        const model = String(args.model || "");
        const routeId = String(args.routeId || "");
        const targetProfile = previewRoutes.find(
          (profile) => profile.id === routeId,
        ) || activePreviewProfile();
        if (!targetProfile) {
          return { status: "failed", message: "找不到要设置默认模型的线路" };
        }
        previewActiveProfileId = targetProfile.id;
        previewConfig = {
          ...previewConfig,
          defaultModel: model,
        };
        if (targetProfile?.id === previewActiveProfileId) {
          previewModelState = { ...previewModelState, defaultModel: model };
        }
        return {
          status: "ok",
          config: previewConfig,
          modelState: previewModelState,
          restartRequired: false,
          modelHotReloaded: true,
        };
      }
      if (command === "save_official_route_models") {
        const routeId = String(args.routeId || "");
        const requestedModels = uniqueModelIds((args.models as string[]) || []);
        const knownModels = new Set(
          ((args.knownOfficialModels as string[]) || previewOfficialModels.map((model) => model.slug)).map(modelKey),
        );
        const models = uniqueModelIds([
          ...requestedModels,
          ...previewOfficialModels.filter((model) =>
            !knownModels.has(modelKey(model.slug))
            && previewModelState.officialModels.find((entry) => modelIdsEqual(entry.slug, model.slug))?.supported !== false,
          ).map((model) => model.slug),
        ]);
        const targetProfile = previewRoutes.find(
          (profile) => profile.id === routeId,
        );
        if (!targetProfile || targetProfile.authMode !== "officialAccount" || models.length === 0) {
          return { status: "failed", message: "官方线路至少需要保留一个模型" };
        }
        const providerId = routeProviderId(targetProfile);
        previewConfig = {
          ...previewConfig,
          selectedModelsByProvider: {
            ...previewConfig.selectedModelsByProvider,
            [providerId]: models,
          },
        };
        const defaultModel = models.find((candidate) =>
          modelIdsEqual(candidate, previewConfig.defaultModel),
        ) || models[0];
        if (!models.some((candidate) =>
          modelIdsEqual(candidate, previewConfig.defaultModel),
        )) {
          previewConfig = {
            ...previewConfig,
            defaultModel: defaultModel,
          };
        }
        if (targetProfile.id === previewActiveProfileId) {
          const selected = new Set(models.map(modelKey));
          previewModelState = {
            ...previewModelState,
            officialModels: previewOfficialModels.map((model) => ({
              ...model,
              supported: selected.has(modelKey(model.slug)),
            })),
            defaultModel,
          };
        }
        return {
          status: "ok",
          config: previewConfig,
          modelState: previewModelState,
          restartRequired: false,
          modelHotReloaded: true,
        };
      }
      if (command === "repair_codex_config") {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        if (configRepairPreview === "failure") throw new Error("预览：无法写入配置目录，已记录错误日志");
        return {
          message: configRepairPreview === "unchanged" ? "Codex 配置检查通过，无需修改" : "Codex 配置已修复",
          configPath: "/preview/.codex/config.toml",
          repaired: configRepairPreview !== "unchanged",
          backupPath: null,
        };
      }
      if (command === "restart_codey") {
        previewChannelRunning = previewChannelRunKey();
        return { status: "restarting" };
      }
      if (command === "codey_router_session_diagnosis") {
        return {
          affectedSessionCount: 0,
          targetProviders: ["openai"],
          lastMigration: null,
        };
      }
      if (command === "migrate_codey_router_sessions") {
        return { status: "migrating" };
      }
      if (command === "test_notification_channel") {
        const channel = args.channel as {
          kind?: string;
          url?: string;
          botToken?: string;
          contextToken?: string;
          chatId?: string;
        } | undefined;
        const configured = channel?.kind === "telegram" || channel?.kind === "wechatClaw"
          ? Boolean(
            channel.botToken?.trim() &&
              channel.chatId?.trim() &&
              (channel.kind !== "wechatClaw" ||
                (channel.url?.trim() && channel.contextToken?.trim())),
          )
          : channel?.kind === "ntfy"
            ? Boolean(channel.url?.trim()) && !validateNtfyTopic(channel.chatId ?? "")
            : Boolean(channel?.url?.trim());
        return configured
          ? { status: "ok", eventId: "preview-notification-test" }
          : { status: "failed", message: "请先完成渠道配置" };
      }
      if (command === "start_wechat_claw_login") {
        return {
          loginId: "preview-wechat-claw-login",
          status: "wait",
          qrCode: "preview-wechat-claw-qr-code",
          qrCodeImageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='192' height='192' viewBox='0 0 12 12'%3E%3Crect width='12' height='12' fill='white'/%3E%3Cpath d='M1 1h3v3H1zm7 0h3v3H8zM1 8h3v3H1zm4-4h2v2H5zm1 3h2v2H6zm3 2h2v2H9zM4 8h1v3H4zm5-3h2v1H9z' fill='%231d1d1f'/%3E%3C/svg%3E",
        };
      }
      if (command === "poll_wechat_claw_login") {
        return {
          status: "confirmed",
          baseUrl: "https://ilinkai.weixin.qq.com",
          botToken: "preview-wechat-claw-token",
          recipientId: "preview-user@im.wechat",
          contextToken: "preview-wechat-claw-context",
        };
      }
      if (command === "fetch_prompt_optimization_models") {
        return { models: previewModelState.upstreamModels };
      }
      if (command === "test_prompt_optimization") {
        return {
          status: "ok",
          result: { httpStatus: 200, responsePreview: "preview" },
        };
      }
      return { status: "ok" };
    };
  }
}

export {};
