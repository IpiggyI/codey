import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBrandGithub,
  IconArrowBackUp as Undo,
  IconCheck,
  IconDeviceFloppy as Save,
  IconGitBranch as GitBranch,
  IconLoader2 as LoaderCircle,
  IconRefresh as RefreshCw,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { invoke } from "./api";
import { TraceLogModule } from "./TraceLogModule";
import { ModelPickerDialog } from "./AppDialogs";
import { SystemSettingsDialog } from "./SystemSettingsDialog";
import { FeaturePolicyCard, SubagentPolicyCard } from "./FeaturePolicyCard";
import { ModelSection } from "./ModelSection";
import { OperationsPanel } from "./OperationsPanel";
import { PromptOptimizationCard } from "./PromptOptimizationCard";
import {
  getNotificationChannelDefinition,
  NotificationChannelsCard,
} from "./notifications";
import type { NotificationChannel } from "./notifications";
import { errorText, withTimeout } from "./appUtils";
import { formatBytes } from "./formatters";
import {
  confirmThroughDialog,
  createChannelController,
  noticeAfterChannelChange,
  type ChannelOutcome,
  type SwitchTarget,
} from "./channels";
import { modelIdsEqual, uniqueModelIds } from "./modelIds";
import { globalDefaultForProvider } from "./modelRoutes";
import { CodeyBrandMark, SettingsModalShell } from "./SettingsModalShell";
import { SettingsLayout } from "./SettingsLayout";
import { CodexExtensionsPage, type ExtensionTransport } from "./features/codex-extensions";
import { useModelSelection } from "./useModelSelection";
import type { CrashpadPendingStats, TraceLogStats } from "./traceLogTypes";
import { useRuntimeStatus } from "./useRuntimeStatus";
import {
  configApplyBannerVisible,
  configApplyCompletionNotice,
  configApplyNotice,
} from "./configApply";
import {
  applyConfigCommandResult,
  isStaleConfig,
  type ConfigCommandResult,
} from "./configCommandResult";
import {
  NoticeLoadingText,
  NoticeToast,
  useAppNoticeController,
} from "./useAppNotice";
import {
  ConfirmationDialogHost,
  useConfirmationController,
} from "./useConfirmationDialog";
import { useStableEvent } from "./useStableEvent";
import type {
  AppProps,
  ChannelList,
  ConfigApplyStatus,
  CurrentProviderSnapshot,
  ProviderStatus,
  Config,
  Confirmation,
  ModelContextConfig,
  CrashpadCleanup,
  FastContextToolsStatus,
  ModelState,
  OfficialAccountsResult,
  PluginMarketplaceStatus,
  RouterSessionDiagnosis,
  RuntimeStatus,
  TraceLogCleanup,
} from "./App.types";
import { Badge, Button } from "./components/ui";

const Check = IconCheck;
const X = IconX;
const RESTART_INTERRUPTS_TASKS =
  "当前 Codex 客户端将被关闭并由 Codey 自动重新拉起，正在执行的本地任务会被中断。";
const SWITCH_CONFIRMATIONS: Record<SwitchTarget, Omit<Confirmation, "run">> = {
  channel: {
    action: "restart",
    title: "切换渠道并重启 Codex？",
    description: `确认后立即切换渠道，并重启 Codex 使新渠道生效。${RESTART_INTERRUPTS_TASKS}`,
    confirmLabel: "切换并重启",
  },
  "official-account": {
    action: "switch-official-account",
    title: "切换官方账号并重启 Codex？",
    description: `确认后 Codey 会先保存当前账号刷新过的登录，再把 Codex 的登录改写为该账号，并重启 Codex 使新账号生效。${RESTART_INTERRUPTS_TASKS}在之前账号下开始的对话可能无法在新账号下继续。`,
    confirmLabel: "切换并重启",
  },
};
const extensionRequest: ExtensionTransport = (request) => invoke("codex_extensions", { request });
const UNKNOWN_FAST_CONTEXT_TOOLS_STATUS: FastContextToolsStatus = {
  userConfigured: false,
  detectionFailed: true,
};
const CONFIG_LOAD_TIMEOUT_MS = 30_000;

function currentProviderModelState(
  config: Config,
  catalog: ModelState,
  snapshot: CurrentProviderSnapshot,
): ModelState {
  const providerId = snapshot.ownershipKey;
  const selectedModels = uniqueModelIds([
    ...(config.selectedModelsByProvider[providerId] || []),
    ...(config.declaredOfficialModelsByProvider[providerId] || []),
  ]);
  return {
    officialModels: [],
    officialModelIds: catalog.officialModelIds,
    officialModelOrder: catalog.officialModelOrder,
    thirdPartyModels: selectedModels,
    thirdPartyModelMetadata: catalog.thirdPartyModelMetadata,
    manualThirdPartyModels:
      config.manualThirdPartyModelsByProvider[providerId] || [],
    upstreamModels: uniqueModelIds([
      ...(config.upstreamModelsByProvider[providerId] || []),
      ...selectedModels,
    ]),
    defaultModel: globalDefaultForProvider(config, selectedModels),
  };
}

export function App({
  embedded = false,
  modalContainer,
  modalVisible = true,
  onAfterClose,
  onClose,
}: AppProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const persistedConfigRef = useRef<Config | null>(null);
  const loadGenerationRef = useRef(0);
  // 渠道控制器在运行状态 hook 之后创建，经稳定事件转交。
  const handleStatusResponse = useStableEvent(
    (next: RuntimeStatus) => channelController.noteStatusNotice(next.channelNotice ?? null),
  );
  const { status, setStatus, refreshStatus, refreshStatusForLoad,
    restartStatusError, setRestartStatusError, acceptConfigApply, configApplyError, retryConfigApply } =
    useRuntimeStatus({
      active: !embedded || modalVisible,
      embedded,
      onStatusResponse: handleStatusResponse,
    });
  const [pluginMarketplaceStatus, setPluginMarketplaceStatus] =
    useState<PluginMarketplaceStatus | null>(null);
  const [computerUseNotice, setComputerUseNotice] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(
    null,
  );
  const [currentProviderSnapshot, setCurrentProviderSnapshot] =
    useState<CurrentProviderSnapshot | null>(null);
  const [channelList, setChannelList] = useState<ChannelList | null>(null);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const [channelLoadError, setChannelLoadError] = useState<string | null>(null);
  const [channelActionError, setChannelActionError] = useState<string | null>(null);
  const [channelVersionConflict, setChannelVersionConflict] = useState(false);
  const [restartAfterSwitchPending, setRestartAfterSwitchPending] = useState(false);
  const [officialAccountsRefreshKey, setOfficialAccountsRefreshKey] = useState(0);
  const [routerSessionDiagnosis, setRouterSessionDiagnosis] =
    useState<RouterSessionDiagnosis | null>(null);
  const [fastContextToolsStatus, setFastContextToolsStatus] =
    useState<FastContextToolsStatus>(UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [configRepairNotice, setConfigRepairNotice] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const popupContainer = modalContainer ?? null;
  const noticeController = useAppNoticeController();
  const confirmationController = useConfirmationController();
  const setNotice = noticeController.setNotice;
  const setConfirmation = confirmationController.setConfirmation;
  useEffect(() => {
    if (restartStatusError) setNotice({ tone: "error", text: restartStatusError });
  }, [restartStatusError, setNotice]);
  const previousConfigApplyRef = useRef(status.configApply);
  useEffect(() => {
    const notice = configApplyCompletionNotice(previousConfigApplyRef.current, status.configApply);
    previousConfigApplyRef.current = status.configApply;
    if (notice) setNotice(notice);
  }, [status.configApply, setNotice]);

  const provider = providerStatus?.provider;
  const isBusy = busy !== null;
  const setPersistedConfig = useCallback((next: Config) => {
    persistedConfigRef.current = next;
    setConfig(next);
  }, []);
  const setSubagentOptimization = useCallback((enabled: boolean) => {
    setConfig((current) =>
      current ? { ...current, subagentOptimization: enabled } : current,
    );
    setDirty(true);
  }, []);
  const runOperation = useCallback(
    async (name: string, action: () => Promise<void>) => {
      if (isBusy) return;
      setBusy(name);
      try {
        await action();
      } catch (error) {
        setNotice({ tone: "error", text: errorText(error) });
      } finally {
        setBusy(null);
      }
    },
    [isBusy, setNotice],
  );
  const operationsStatus = useMemo(
    () => ({
      running: status.running,
      clientPlatform: status.clientPlatform,
      restartRequired: status.restartRequired,
      restartInProgress: status.restartInProgress,
      maintenance: status.maintenance,
      injectionScripts: status.injectionScripts,
      fastContextToolsActive: status.fastContextToolsActive,
      subagentOptimizationActive: status.subagentOptimizationActive,
      notificationChannelsActive: status.notificationChannelsActive,
      activeNotificationChannelCount: status.activeNotificationChannelCount,
      traceLogWriteProtectionActive: status.traceLogWriteProtectionActive,
      crashpadDiskProtectionActive: status.crashpadDiskProtectionActive,
    }),
    [
      status.running,
      status.clientPlatform,
      status.restartRequired,
      status.restartInProgress,
      status.maintenance,
      status.injectionScripts,
      status.fastContextToolsActive,
      status.subagentOptimizationActive,
      status.notificationChannelsActive,
      status.activeNotificationChannelCount,
      status.traceLogWriteProtectionActive,
      status.crashpadDiskProtectionActive,
    ],
  );
  const handleConfigResult = useStableEvent(
    (result: ConfigCommandResult) => applyCommandResult(result),
  );
  const {
    subagentModelOptions,
    modelState,
    modelEditorState,
    setModelState,
    modelPickerVisible,
    setModelPickerVisible,
    customModelInput,
    modelInputError,
    modelSyncWarning,
    draftAutoReviewSupported,
    setDraftAutoReviewSupported,
    draftModelSet,
    draft1MModelSet,
    draftModelContexts,
    updateDraftModelContext,
    toggleDraft1MModel,
    draftManualThirdPartyModelKeys,
    thirdPartyModelOptions,
    openModelPicker,
    toggleDraftModel,
    deleteDraftThirdPartyModel,
    updateCustomModelInput,
    addCustomModel,
    saveModelSelection,
    draftModelOrderMode,
    moveDraftModel,
    restoreDraftModelOrder,
    saveModelOrder,
  } = useModelSelection({
    config,
    currentProviderSnapshot,
    officialAccountAvailable: status.officialAccountAvailable === true,
    runOperation,
    applyConfigResult: handleConfigResult,
    setNotice,
  });

  const adoptChannelConfig = useStableEvent(
    (next: Config, restartRequired: boolean) => applyCommandResult({ config: next, restartRequired }),
  );
  const codexRunning = useStableEvent(() => status.running);
  const channelController = useMemo(
    () => createChannelController({
      call: invoke,
      readConfig: () => persistedConfigRef.current,
      adopt: adoptChannelConfig,
      setChannelList,
      setChannelNotice,
      codexRunning,
      confirmSwitch: (target) => confirmThroughDialog(confirmationController, SWITCH_CONFIRMATIONS[target]),
      restart: () => setRestartAfterSwitchPending(true),
    }),
    [adoptChannelConfig, codexRunning, confirmationController],
  );

  useEffect(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, []);

  // 切换前已确认重启：等切换操作结束、界面用上最新状态后，直接执行既有的重启操作。
  useEffect(() => {
    if (!restartAfterSwitchPending || isBusy) return;
    setRestartAfterSwitchPending(false);
    void restartCodex();
  }, [restartAfterSwitchPending, isBusy]);

  async function load() {
    const generation = ++loadGenerationRef.current;
    const current = () => generation === loadGenerationRef.current;
    setLoadFailed(false);
    const timer = window.setTimeout(() => {
      if (!current()) return;
      setLoadFailed(true);
      setNotice({ tone: "error", text: "加载配置超时，请重新检查" });
    }, CONFIG_LOAD_TIMEOUT_MS);
    try {
      const result = await invoke<{
        config: Config;
        modelState?: ModelState;
        startupError?: string;
        officialAccountAvailable?: boolean;
        providerStatus?: ProviderStatus;
        currentProviderSnapshot?: CurrentProviderSnapshot | null;
        fastContextToolsStatus?: FastContextToolsStatus;
      }>("load_codey_config");
      window.clearTimeout(timer);
      if (!current()) return;
      setLoadFailed(false);
      setPersistedConfig(result.config);
      setProviderStatus(result.providerStatus ?? null);
      setCurrentProviderSnapshot(result.currentProviderSnapshot ?? null);
      if (typeof result.officialAccountAvailable === "boolean") {
        setStatus((currentStatus) => ({
          ...currentStatus,
          officialAccountAvailable: result.officialAccountAvailable,
        }));
      }
      setFastContextToolsStatus(
        result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS,
      );
      if (result.modelState) setModelState(result.modelState);
      const [next, , diagnosis] = await Promise.all([
        refreshStatusForLoad(),
        refreshPluginMarketplaceStatus(),
        refreshRouterSessionDiagnosis(),
        refreshChannels(),
      ]);
      if (!current()) return;
      const lastMigration = diagnosis?.lastMigration;
      const startupError = next.startupError || result.startupError;
      if (startupError) {
        setNotice({ tone: "error", text: `自动启动失败：${startupError}` });
      } else if (lastMigration?.message) {
        setNotice({
          tone: lastMigration.status === "migrated" ? "success" : "error",
          text: lastMigration.message,
        });
      } else if (next.restartRequired) {
        setNotice({ tone: "info", text: "已保存的配置需重启 Codex 后生效" });
      } else if (!next.running) {
        setNotice({ tone: "info", text: "Codey 运行时已就绪" });
      }
    } catch (error) {
      window.clearTimeout(timer);
      if (!current()) return;
      setLoadFailed(true);
      setNotice({ tone: "error", text: errorText(error) });
    }
  }

  function reportChannelOutcome(outcome: ChannelOutcome) {
    if (outcome.kind === "stale" || outcome.kind === "cancelled") return false;
    if (outcome.kind === "failed") {
      setChannelActionError(outcome.message);
      setChannelVersionConflict(outcome.conflict);
      setNotice({ tone: "error", text: outcome.message });
      return false;
    }
    setChannelActionError(null);
    setChannelVersionConflict(false);
    return true;
  }

  async function refreshChannels() {
    const outcome = await channelController.refresh();
    if (outcome.kind === "failed") {
      setChannelLoadError(outcome.message);
    } else if (outcome.kind === "applied") {
      setChannelLoadError(null);
      setChannelActionError(null);
      setChannelVersionConflict(false);
    }
  }

  // 渠道变更后当前 provider 随之变化，重新读取一次以免页面显示旧 provider；失败由调用方提示。
  async function refreshProviderAfterChannelChange() {
    const result = await invoke<
      ConfigCommandResult & { currentProviderSnapshot?: CurrentProviderSnapshot | null }
    >("load_codey_config");
    if (!applyRouteResult(result)) return;
    if (result.currentProviderSnapshot === undefined) setCurrentProviderSnapshot(null);
    await refreshStatus().catch(() => undefined);
  }

  async function switchChannel(channelId: string | null, defaultModel?: string) {
    if (dirty || isBusy) return;
    await runOperation("switch-channel", async () => {
      const outcome = await channelController.select(channelId, defaultModel);
      if (!reportChannelOutcome(outcome)) return;
      setOfficialAccountsRefreshKey((key) => key + 1);
      setNotice(await noticeAfterChannelChange(refreshProviderAfterChannelChange, {
        tone: "info",
        text: outcome.kind === "applied" && outcome.restart === "next-start"
          ? "已切换渠道，下次启动 Codex 时生效"
          : "已切换渠道",
      }));
    });
  }

  // 切换官方账号即切换渠道：在操作锁内执行，未保存的修改存在时不切换。
  async function switchOfficialAccount(accountId: string): Promise<OfficialAccountsResult | null> {
    if (dirty || isBusy) return null;
    let accounts: OfficialAccountsResult | null = null;
    await runOperation("switch-official-account", async () => {
      const switched = await channelController.switchOfficialAccount(accountId);
      accounts = switched.accounts;
      if (switched.listError) setChannelLoadError(switched.listError);
      if (!reportChannelOutcome(switched.outcome)) return;
      setNotice(await noticeAfterChannelChange(refreshProviderAfterChannelChange, {
        tone: "info",
        text: switched.outcome.kind === "applied" && switched.outcome.restart === "next-start"
          ? "已切换官方账号，下次启动 Codex 时生效"
          : "已切换官方账号",
      }));
    });
    return accounts;
  }

  async function saveChannelDefaultModel(channelId: string, model: string) {
    if (dirty || isBusy) return;
    await runOperation("save-channel-default-model", async () => {
      const outcome = await channelController.setDefaultModel(channelId, model);
      if (!reportChannelOutcome(outcome)) return;
      setNotice(await noticeAfterChannelChange(
        refreshProviderAfterChannelChange,
        outcome.kind === "applied" && outcome.restartRequired
          ? { tone: "info", text: "已保存渠道默认模型，重启 Codex 后生效" }
          : { tone: "success", text: "已保存渠道默认模型" },
      ));
    });
  }

  async function refreshRouterSessionDiagnosis() {
    try {
      const next = await invoke<RouterSessionDiagnosis>(
        "codey_router_session_diagnosis",
      );
      setRouterSessionDiagnosis(next);
      return next;
    } catch (error) {
      const next: RouterSessionDiagnosis = {
        affectedSessionCount: 0,
        targetProviders: [],
        lastMigration: {
          status: "failed",
          message: `诊断历史会话失败：${errorText(error)}`,
        },
      };
      setRouterSessionDiagnosis(next);
      return next;
    }
  }

  async function refreshPluginMarketplaceStatus() {
    try {
      const next = await invoke<PluginMarketplaceStatus>(
        "plugin_marketplace_status",
      );
      setPluginMarketplaceStatus(next);
      return next;
    } catch (error) {
      const next: PluginMarketplaceStatus = {
        status: "error",
        needsRepair: true,
        message: errorText(error),
      };
      setPluginMarketplaceStatus(next);
      return next;
    }
  }

  function editConfig(next: Config) {
    setConfig(next);
    setDirty(true);
  }

  async function persist(next: Config) {
    const result = await invoke<{
      config: Config;
      providerStatus?: ProviderStatus;
      currentProviderSnapshot?: CurrentProviderSnapshot | null;
      modelState?: ModelState;
      configApply?: ConfigApplyStatus | null;
      restartRequired?: boolean;
      modelHotReloaded?: boolean;
      modelHotReloadError?: string;
      subagentConfigHotReloaded?: boolean;
      subagentConfigRepaired?: boolean;
      subagentConfigHealth?: string;
      subagentConfigRepairReasons?: string[];
      subagentConfigHotReloadError?: string;
      fastContextToolsStatus?: FastContextToolsStatus;
    }>("save_codey_config", { config: next });
    if (!applyCommandResult(result)) return null;
    setFastContextToolsStatus(
      result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS,
    );
    window.dispatchEvent(
      new CustomEvent("codey:config-changed", {
        detail: {
          config: result.config,
          currentProviderSnapshot: result.currentProviderSnapshot,
        },
      }),
    );
    await refreshStatus().catch(() => undefined);
    // 后台应用可能在刷新期间完成，提示以最新的应用状态为准。
    if (result.configApply) result.configApply = acceptConfigApply(result.configApply);
    return result;
  }

  async function persistNotificationChannels(
    current: Config,
    channels: NotificationChannel[],
    successText: string,
  ) {
    if (isBusy) return false;
    setBusy("save-notification-channel");
    try {
      const result = await persist({
        ...current,
        webhook: {
          ...current.webhook,
          channels,
        },
      });
      if (result) {
        setNotice(result.configApply ? configApplyNotice(result.configApply) : { tone: "success", text: successText });
      }
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addNotificationChannel(channel: NotificationChannel) {
    if (!config) return false;
    const channels = config.webhook.channels.some(
      (existing) => existing.id === channel.id,
    )
      ? config.webhook.channels
      : [...config.webhook.channels, channel];
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已保存，自动通知已生效",
    );
  }

  async function updateNotificationChannel(
    channelId: string,
    patch: Partial<NotificationChannel>,
  ) {
    if (!config) return false;
    const channels = config.webhook.channels.map((channel) =>
      channel.id === channelId ? { ...channel, ...patch } : channel,
    );
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已更新，自动通知已生效",
    );
  }

  async function removeNotificationChannel(channelId: string) {
    if (!config) return false;
    const channels = config.webhook.channels.filter(
      (channel) => channel.id !== channelId,
    );
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已删除",
    );
  }

  async function syncCurrentProvider() {
    if (dirty || isBusy) return;
    await runOperation("sync-provider", async () => {
      const result = await invoke<{
        config: Config;
        providerStatus: ProviderStatus;
        currentProviderSnapshot?: CurrentProviderSnapshot | null;
        modelState: ModelState;
        configApply?: ConfigApplyStatus | null;
        restartRequired?: boolean;
      }>("sync_current_provider");
      if (!applyCommandResult(result)) return;
      if (result.currentProviderSnapshot === undefined) setCurrentProviderSnapshot(null);
      void refreshChannels();
      setNotice({
        tone: result.restartRequired ? "info" : "success",
        text: result.restartRequired
          ? "已重新读取 Codex 配置，重启后应用当前 provider"
          : "已重新读取 Codex 配置",
      });
      window.dispatchEvent(
        new CustomEvent("codey:config-changed", {
          detail: {
            config: result.config,
            currentProviderSnapshot: result.currentProviderSnapshot,
          },
        }),
      );
    });
  }

  function adoptCommandConfig(incoming: Config) {
    if (isStaleConfig(persistedConfigRef.current, incoming)) return null;
    setPersistedConfig(incoming);
    return { dirty: false };
  }

  function applyCommandResult(
    result: ConfigCommandResult & { currentProviderSnapshot?: CurrentProviderSnapshot | null },
  ) {
    if (!applyConfigCommandResult(result, {
      adoptConfig: adoptCommandConfig, acceptConfigApply, setDirty, setProviderStatus, setModelState, setStatus,
    })) return false;
    if (result.currentProviderSnapshot !== undefined) {
      setCurrentProviderSnapshot(result.currentProviderSnapshot);
    }
    return true;
  }

  function applyRouteResult(
    result: ConfigCommandResult & { currentProviderSnapshot?: CurrentProviderSnapshot | null },
  ) {
    if (!applyCommandResult(result)) return false;
    window.dispatchEvent(
      new CustomEvent("codey:config-changed", {
        detail: {
          config: result.config,
          currentProviderSnapshot: result.currentProviderSnapshot,
        },
      }),
    );
    return true;
  }

  async function fetchRouteModels() {
    if (!config) return;
    if (currentProviderSnapshot?.usesOfficialAccountAuth) {
      await syncCurrentProvider();
      return;
    }
    await runOperation("fetch-route-models", async () => {
      const savedConfig = config;
      try {
        const result = await invoke<{
          config: Config;
          providerStatus: ProviderStatus;
          modelState: ModelState;
          routeModelState: ModelState;
          models: string[];
          configApply?: ConfigApplyStatus | null;
          restartRequired?: boolean;
          modelHotReloaded?: boolean;
        }>("fetch_route_models", {
          expectedRevision: savedConfig.settingsRevision,
        });
        if (!applyRouteResult(result)) return;
        openModelPicker(
          { ...result.routeModelState, officialModels: [] },
          "",
          currentProviderSnapshot?.id || null,
        );
        setNotice({
          tone: "success",
          text: `已同步当前 provider 的 ${result.models.length} 个模型，请勾选要启用的模型`,
        });
      } catch (error) {
        const warning = `自动同步失败：${errorText(error)}。仍可手动录入当前 provider 支持的模型 ID。`;
        const fallbackState = currentProviderSnapshot
          ? currentProviderModelState(
            savedConfig,
            modelState,
            currentProviderSnapshot,
          )
          : modelState;
        openModelPicker(
          fallbackState,
          warning,
          currentProviderSnapshot?.id || null,
        );
        setNotice({
          tone: "error",
          text: "模型同步失败，已打开手动配置",
        });
      }
    });
  }

  async function saveOfficialRouteSettings(
    models: string[],
    showAccountUsageInHeader: boolean,
    knownOfficialModels: string[],
    modelContexts: Record<string, ModelContextConfig>,
  ) {
    if (!config) return false;
    if (!currentProviderSnapshot?.usesOfficialAccountAuth) return false;
    if (models.length === 0) {
      setNotice({ tone: "info", text: "官方账号至少需要保留一个模型" });
      return false;
    }
    let saved = false;
    await runOperation("save-official-route-settings", async () => {
      const modelResult = await invoke<{
        config: Config;
        modelState: ModelState;
        configApply?: ConfigApplyStatus | null;
        restartRequired?: boolean;
        modelHotReloaded?: boolean;
      }>("save_official_route_models", {
        routeId: currentProviderSnapshot.id,
        models,
        knownOfficialModels,
        supports1MContextModels: [],
        enabled: true,
        showAccountUsageInHeader,
        modelContexts,
      });
      if (!applyRouteResult(modelResult)) return;
      saved = true;
      if (modelResult.configApply) {
        setNotice(configApplyNotice(modelResult.configApply));
        return;
      }
      setNotice({
        tone: modelResult.restartRequired ? "info" : "success",
        text: modelResult.restartRequired
          ? "官方账号设置已保存，重启 Codex 后完全生效"
          : "官方账号设置已保存，模型与额度展示已更新",
      });
    });
    return saved;
  }

  async function setRouteDefaultModel(model: string) {
    if (!config) return;
    const providerId = currentProviderSnapshot?.ownershipKey;
    if (!providerId) {
      setNotice({ tone: "error", text: `模型 ${model} 不属于当前 provider` });
      return;
    }
    const configuredOfficialModels = config.selectedModelsByProvider[providerId] || [];
    const enabledModels = currentProviderSnapshot.usesOfficialAccountAuth
      ? configuredOfficialModels.length > 0
        ? configuredOfficialModels
        : modelState.officialModelIds
      : [
          ...(config.selectedModelsByProvider[providerId] || []),
          ...(config.declaredOfficialModelsByProvider[providerId] || []),
        ];
    if (!enabledModels.some((candidate) => modelIdsEqual(candidate, model))) {
      setNotice({ tone: "error", text: `模型 ${model} 不属于当前 provider` });
      return;
    }
    await runOperation("save-default-model", async () => {
      const result = await invoke<{
        config: Config;
        modelState: ModelState;
        configApply?: ConfigApplyStatus | null;
        restartRequired?: boolean;
      }>("save_default_model", { model });
      if (!applyRouteResult(result)) return;
      // 已选渠道时该命令写入渠道默认模型，渠道列表随之刷新。
      void refreshChannels();
      if (result.configApply) {
        setNotice(configApplyNotice(result.configApply));
        return;
      }
      setNotice({
        tone: result.restartRequired ? "info" : "success",
        text: `已将全局默认模型设为「${currentProviderSnapshot.id} / ${model}」`,
      });
    });
  }

  async function saveCurrent() {
    if (!config) return;
    await runOperation("save", async () => {
      const result = await persist(config);
      if (!result) return;
      if (result.configApply) {
        setNotice(configApplyNotice(result.configApply));
        return;
      }
      const subagentHotReloaded = Boolean(result.subagentConfigHotReloaded);
      const subagentHotReloadFailed = Boolean(result.subagentConfigHotReloadError);
      const subagentConfigRepaired = Boolean(result.subagentConfigRepaired);
      setNotice({
        tone:
          result.restartRequired || subagentHotReloadFailed
            ? "info"
            : "success",
        text: subagentConfigRepaired
          ? "Codey 设置已保存；已校验并修复子代理运行配置，下一次派生将使用当前角色映射"
          : subagentHotReloaded
            ? "Codey 设置已保存；子代理模型和思考强度已实时更新"
          : subagentHotReloadFailed
            ? "Codey 设置已保存；子代理配置暂未能热更新，重启 Codex 后生效"
            : result.restartRequired
              ? "Codey 设置已保存，启动参数将在重启 Codex 后生效"
              : "Codey 设置已保存",
      });
    });
  }

  // 恢复上次保存的设置；close 为 false 时控制台保持打开。
  function discardSettings(close = true) {
    if (isBusy) return;
    if (persistedConfigRef.current) {
      setConfig(persistedConfigRef.current);
    }
    setDirty(false);
    setModelPickerVisible(false);
    confirmationController.clear();
    if (close) onClose?.();
  }

  function askDiscardChanges() {
    if (isBusy || !dirty) return;
    setConfirmation({
      action: "discard-settings",
      title: "放弃未保存的更改？",
      description: "将恢复上次保存的设置，控制台保持打开。",
      confirmLabel: "放弃更改",
      run: () => discardSettings(false),
    });
  }

  function closeSettings() {
    if (isBusy) return;
    if (!dirty) { discardSettings(); return; }
    setConfirmation({
      action: "discard-settings",
      title: "放弃未保存的设置？",
      description: "关闭后将恢复上次保存的设置。",
      confirmLabel: "放弃更改并关闭",
      run: () => discardSettings(),
    });
  }

  function askClearTraceLogs() {
    setConfirmation({
      action: "clear",
      title: "清理 Codex 诊断存储？",
      description:
        "将清空并压缩 logs_*.sqlite，同时删除已稳定写入的 Crashpad 待处理报告。最近写入、未知文件和其他 Crashpad 目录会保留；聊天历史、账号、配置及插件不受影响。清理后的诊断记录无法恢复。",
      confirmLabel: "确认清理",
      run: () => void clearTraceLogs(),
    });
  }

  function askRestartCodex(
    description = "当前 Codex 客户端将被关闭并由 Codey 自动重新拉起，正在执行的本地任务会被中断。",
  ) {
    if (restartStatusError) {
      void runOperation("restart", async () => {
        const next = await refreshStatus();
        setNotice({
          tone: next.startupError ? "error" : "info",
          text: next.startupError || (next.restartInProgress
            ? "Codex 仍在重启，请稍候"
            : next.running ? "Codex 已运行" : "Codex 未运行"),
        });
      });
      return;
    }
    setConfirmation({
      action: "restart",
      title: "重启 Codex？",
      description,
      confirmLabel: "重启 Codex",
      run: () => void restartCodex(),
    });
  }

  function askRepairCodexConfig() {
    if (isBusy) return;
    setConfirmation({
      action: "repair-codex-config",
      title: "修复 Codex 配置？",
      description: "将检查配置文件及相关路径，修改已有配置前自动备份，并修复能够确认的问题。修复成功后，请从 Codey 重启 Codex 使修改生效。",
      confirmLabel: "确认修复",
      run: () => void repairCodexConfig(),
    });
  }

  async function repairCodexConfig() {
    await runOperation("repair-codex-config", async () => {
      const report = (notice: { tone: "info" | "success" | "error"; text: string }) => {
        setConfigRepairNotice(notice);
        setNotice(notice);
      };
      report({ tone: "info", text: "正在检查并修复 Codex 配置…" });
      try {
        const result = await invoke<{
          message: string;
          configPath: string;
          repaired: boolean;
          backupPath?: string | null;
        }>("repair_codex_config");
        const summary = result.message || (result.repaired
          ? "Codex 配置已修复"
          : "Codex 配置检查通过，无需修改");
        const restartHint = "修复成功，请从 Codey 重启 Codex 使修改生效。";
        const backupPath = result.backupPath ? String(result.backupPath) : null;
        // 后端消息已含重启提示或备份位置时不再重复追加
        report({
          tone: "success",
          text: [
            result.repaired && !summary.includes("重启 Codex") ? restartHint : null,
            summary,
            `配置文件：${result.configPath}`,
            backupPath && !summary.includes(backupPath) ? `备份文件：${backupPath}` : null,
          ].filter(Boolean).join("\n"),
        });
      } catch (error) {
        report({ tone: "error", text: `Codex 配置修复未完成：${errorText(error)}。请查看 Codey 错误日志；连接中断时可重新检查执行结果。` });
      }
    });
  }

  function askMigrateRouterSessions(targetProvider: string) {
    const count = routerSessionDiagnosis?.affectedSessionCount ?? 0;
    setConfirmation({
      action: "migrate-codey-router-sessions",
      title: "改写历史会话归属？",
      description: `将把 ${count} 个仍标记为内置路由的历史会话改写为「${targetProvider}」。改写前会备份；进行中会暂时关闭并重新打开 Codex，正在执行的本地任务会被中断。`,
      confirmLabel: "确认迁移",
      run: () => void migrateRouterSessions(targetProvider),
    });
  }

  async function migrateRouterSessions(targetProvider: string) {
    await runOperation("migrate-router-sessions", async () => {
      const result = await invoke<{ status?: string }>(
        "migrate_codey_router_sessions",
        { targetProvider },
      );
      setNotice({
        tone: "info",
        text:
          result.status === "already_restarting"
            ? "已有重启或迁移正在进行，请稍后再试。"
            : "正在改写历史会话归属，Codex 会暂时关闭并重新打开。",
      });
    });
  }

  function askRemoveNotificationChannel(channel: NotificationChannel) {
    const channelName = getNotificationChannelDefinition(channel.kind).addLabel;
    setConfirmation({
      action: "delete-notification-channel",
      title: `删除${channelName}通知渠道？`,
      description:
        "将立即移除这个通知渠道，删除后不会再接收自动通知。",
      confirmLabel: "删除渠道",
      run: () => void removeNotificationChannel(channel.id),
    });
  }

  async function restartCodex() {
    if (!config) return;
    await runOperation("restart", async () => {
      if (dirty) await persist(config);
      setNotice({
        tone: "info",
        text: "正在重启 Codex，Codey 将自动重新拉起客户端…",
      });
      try {
        await withTimeout(invoke("restart_codey"), 10_000,
          "重启请求超时，暂时无法确认执行状态，请点击重新查询状态");
      } catch (error) {
        setRestartStatusError("暂时无法确认重启请求的执行状态，请点击重新查询状态");
        throw error;
      }
      setStatus((current) => ({
        ...current,
        restartInProgress: true,
      }));
    });
  }

  async function repairPluginMarketplace() {
    await runOperation("repair-plugin-marketplace", async () => {
      const result = await withTimeout(
        invoke<PluginMarketplaceStatus>("repair_plugin_marketplace"),
        30_000,
        "插件市场修复超时，请稍后重试",
      );
      setPluginMarketplaceStatus(result);
      if (result.status === "ready") {
        setNotice({
          tone: "success",
          text:
            result.configChanged || result.initializedRemote
              ? "插件市场已修复并立即生效，无需重启 Codex"
              : "插件市场状态正常，无需修改",
        });
        return;
      }
      setNotice({
        tone: "error",
        text: "插件市场仍有缺失项，请检查本地市场文件后重试",
      });
    });
  }

  async function prepareComputerUse() {
    setComputerUseNotice("");
    await runOperation("prepare-computer-use", async () => {
      const result = await withTimeout(
        invoke<PluginMarketplaceStatus>("prepare_computer_use"),
        30_000,
        "桌面操作插件准备超时，请稍后重试",
      );
      setPluginMarketplaceStatus(result);
      if (!result.computerUse?.ready) {
        throw new Error("桌面操作插件资源未就绪，请重试");
      }
      const text = "桌面操作插件已准备。请重启 Codex，再到插件页安装或更新；启用和停用也在插件页操作。";
      setComputerUseNotice(text);
      setNotice({ tone: "success", text });
    });
  }

  async function clearTraceLogs() {
    await runOperation("clear-trace-logs", async () => {
      const result = await invoke<{
        status: "ok" | "partial";
        traceCleanup?: TraceLogCleanup;
        crashpadCleanup: CrashpadCleanup;
        traceProtectionEnabled: boolean;
        traceLogWriteProtectionActive: boolean;
        crashpadProtectionEnabled: boolean;
        errors: string[];
        traceLogStats: TraceLogStats;
        crashpadPendingStats: CrashpadPendingStats;
      }>("clear_diagnostic_storage");
      setStatus((current) => ({
        ...current,
        traceLogStats: result.traceLogStats,
        crashpadPendingStats: result.crashpadPendingStats,
        traceLogWriteProtectionActive:
          result.traceLogWriteProtectionActive,
      }));
      const traceCleanup = result.traceCleanup;
      const crashpadCleanup = result.crashpadCleanup;
      if (
        (traceCleanup?.databasesFound ?? 0) === 0 &&
        crashpadCleanup.reportsFound === 0
      ) {
        setNotice({
          tone: "info",
          text: "未发现可清理的 Trace 日志或 Crashpad 待处理报告",
        });
        return;
      }
      const traceDetail = traceCleanup
        ? `${traceCleanup.databasesCleaned} 个日志库、${traceCleanup.rowsDeleted} 条记录`
        : "Trace 日志清理未完成";
      const crashpadDetail =
        `${crashpadCleanup.reportsDeleted} 份 Crashpad 报告、` +
        `${crashpadCleanup.filesDeleted} 个文件`;
      const reclaimed =
        (traceCleanup?.bytesReclaimed ?? 0) + crashpadCleanup.bytesReclaimed;
      const protectionDetail =
        result.traceProtectionEnabled && result.crashpadProtectionEnabled
          ? "双重保护保持开启"
          : "当前仅启用了部分保护";
      setNotice({
        tone: result.errors.length ? "error" : "success",
        text: `已处理 ${traceDetail}；${crashpadDetail}，释放 ${formatBytes(reclaimed)}；${protectionDetail}${result.errors.length ? `，另有 ${result.errors.length} 项未完成` : ""}`,
      });
    });
  }

  async function updateTraceLogStatsSnapshot() {
    const result = await invoke<{
      status: "ok" | "pending";
      traceLogStats: TraceLogStats;
      crashpadPendingStats: CrashpadPendingStats;
    }>("refresh_diagnostic_storage_stats");
    setStatus((current) => ({
      ...current,
      traceLogStats: result.traceLogStats,
      crashpadPendingStats: result.crashpadPendingStats,
    }));
    return result;
  }

  async function refreshTraceLogStats() {
    await runOperation("refresh-trace-stats", async () => {
      const result = await updateTraceLogStatsSnapshot();
      if (result.status === "pending") {
        setNotice({ tone: "info", text: "诊断存储正在统计，请稍候" });
        return;
      }
      setNotice({ tone: "success", text: "诊断存储统计已更新" });
    });
  }

  const handleCloseSettings = useStableEvent(closeSettings);
  const handleDiscardChanges = useStableEvent(askDiscardChanges);
  const handleSaveCurrent = useStableEvent(() => void saveCurrent());
  const handleRepairPluginMarketplace = useStableEvent(
    () => void repairPluginMarketplace(),
  );
  const handlePrepareComputerUse = useStableEvent(
    () => void prepareComputerUse(),
  );
  const handleRestartCodex = useStableEvent(() => askRestartCodex());
  const handleConfigChange = useStableEvent(editConfig);
  const handleAddNotificationChannel = useStableEvent(addNotificationChannel);
  const handleNotificationChannelChange = useStableEvent(
    updateNotificationChannel,
  );
  const handleRequestRemoveNotificationChannel = useStableEvent(
    askRemoveNotificationChannel,
  );
  const handleSubagentOptimizationChange = useStableEvent(
    (checked: boolean) => setSubagentOptimization(checked),
  );
  const handleSyncCurrentProvider = useStableEvent(
    () => void syncCurrentProvider(),
  );
  const handleFetchRouteModels = useStableEvent(() => {
    void fetchRouteModels();
  });
  const handleToggleAccountUsage = useStableEvent((checked: boolean) => {
    if (!config) return;
    editConfig({
      ...config,
      showAccountUsageInHeader: checked,
    });
  });
  const handleCacheValidMinutesChange = useStableEvent((minutes: number) => {
    if (!config) return;
    editConfig({
      ...config,
      cacheValidMinutes: minutes,
    });
  });
  const handleSaveOfficialRouteSettings = useStableEvent(
    saveOfficialRouteSettings,
  );
  const handleSetRouteDefaultModel = useStableEvent((model: string) => {
    void setRouteDefaultModel(model);
  });
  const handleSelectChannel = useStableEvent(
    (channelId: string | null, defaultModel?: string) => void switchChannel(channelId, defaultModel),
  );
  const handleSetChannelDefaultModel = useStableEvent(
    (channelId: string, model: string) => void saveChannelDefaultModel(channelId, model),
  );
  const handleSwitchOfficialAccount = useStableEvent(switchOfficialAccount);
  const handleOfficialAccountsChanged = useStableEvent(() => void refreshChannels());
  const handleRefreshChannels = useStableEvent(
    () => void runOperation("reload-config", load),
  );
  const handleClearTraceLogs = useStableEvent(askClearTraceLogs);
  const handleRefreshTraceLogStats = useStableEvent(
    () => void refreshTraceLogStats(),
  );
  const handleModelPickerOpenChange = useStableEvent((open: boolean) => {
    if (!isBusy || open) setModelPickerVisible(open);
  });
  if (!config || !provider) {
    const loadingContent = (
      <main className="app-shell loading-shell">
        <div className="loading-mark">
          <GitBranch size={17} />
        </div>
        <div>
          <strong>{loadFailed ? "Codey 加载失败" : "正在载入 Codey"}</strong>
          <p>
            <NoticeLoadingText controller={noticeController} />
          </p>
          {loadFailed && (
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={isBusy}
                onPress={() => void runOperation("reload-config", load)}
              >
                重新检查
              </Button>
            </div>
          )}
        </div>
        {!loadFailed && (
          <LoaderCircle
            className="animate-spin loading-animate-spin"
            size={16}
            aria-hidden="true"
          />
        )}
      </main>
    );
    return embedded ? (
      <SettingsModalShell
        afterClose={onAfterClose}
        container={modalContainer}
        onCancel={handleCloseSettings}
        title="Codey 配置"
        visible={modalVisible}
      >
        {loadingContent}
      </SettingsModalShell>
    ) : (
      loadingContent
    );
  }

  // 已保存的配置需重启生效时，重启按钮提示等待重启。
  const waitingForRestart = !restartStatusError && status.running
    && !status.restartInProgress && busy !== "restart" && status.restartRequired === true;

  const configHeaderContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-5 max-[760px]:grid-cols-[minmax(0,1fr)_auto_auto] max-[760px]:gap-2.5">
      <div className="flex min-w-0 items-center gap-3 justify-self-start max-[760px]:gap-2">
        <CodeyBrandMark />
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="m-0 whitespace-nowrap text-base font-bold tracking-[-0.02em] text-[#1d1d1f]">Codey 控制台</h1>
            <span className="whitespace-nowrap text-[11px] font-medium tracking-[0.01em] text-[#8e8e93]">
              v{status.appVersion || "0.2.0"}
            </span>

            {dirty && (
              <Badge variant="warning">
                未保存更改
              </Badge>
            )}
          </div>
          <p className="m-0 mt-0.5 text-[11px] text-[#6e6e73] max-[760px]:hidden">查看当前 provider、管理模型清单、运行策略与诊断存储</p>
        </div>
      </div>

      {embedded && (
        <div className="flex items-center gap-3 justify-self-center max-[520px]:gap-2">
          <Button
            aria-label="打开 Codey GitHub 仓库"
            className="w-8! min-w-8! px-0!"
            onClick={() => window.open("https://github.com/IpiggyI/codey", "_blank", "noopener,noreferrer")}
            size="sm"
            title="GitHub 仓库"
            variant="brand-outline"
          >
            <IconBrandGithub aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-4 justify-self-end">
        <div className="flex items-center gap-2">
          <Button
            aria-label="系统设置与偏好"
            className="flex-none"
            onPress={() => setSystemSettingsOpen(true)}
            size="icon-sm"
            title="系统设置与偏好"
            variant="ghost"
          >
            <IconSettings aria-hidden="true" />
          </Button>
          {embedded && (
            <Button
              aria-label={restartStatusError ? "重新查询状态" : waitingForRestart ? "等待重启 Codex，点击重启以应用配置" : status.running ? "重启 Codex" : "Codex 未运行"}
              className="max-[520px]:w-8! max-[520px]:px-0!"
              disabled={isBusy || (!restartStatusError && (status.restartInProgress || !status.running))}
              onPress={handleRestartCodex}
              size="sm"
              variant="warning"
            >
              {busy === "restart" || (status.restartInProgress && !restartStatusError) ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              <span className="max-[520px]:hidden">
                {restartStatusError ? "重新查询状态" : waitingForRestart ? "等待重启" : status.running ? "重启 Codex" : "未运行"}
              </span>
            </Button>
          )}
          {dirty && (
            <Button
              aria-label="放弃更改"
              className="max-[520px]:w-8! max-[520px]:px-0!"
              disabled={isBusy}
              onPress={handleDiscardChanges}
              size="sm"
              variant="ghost"
            >
              <Undo aria-hidden="true" />
              <span className="max-[520px]:hidden">放弃更改</span>
            </Button>
          )}
          <Button
            aria-label={dirty ? "保存更改" : "已保存"}
            className="h-8 min-w-[88px] px-3.5 text-xs max-[520px]:min-w-8! max-[520px]:w-8! max-[520px]:px-0!"
            disabled={!dirty || isBusy}
            onPress={handleSaveCurrent}
            size="sm"
            variant={dirty ? "default" : "secondary"}
          >
            {busy === "save" ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : dirty ? (
              <Save aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span className="max-[520px]:hidden">
              {dirty ? "保存更改" : "已保存"}
            </span>
          </Button>
          {embedded && (
            <Button
              aria-label="关闭配置"
              className="flex-none max-[520px]:h-8! max-[520px]:w-8! max-[520px]:p-0!"
              disabled={isBusy}
              onPress={handleCloseSettings}
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  const appContent = (
    <main
      className={`app-shell${embedded ? " embedded" : ""}`}
      ref={setPortalContainer}
    >
      <a
        className="skip-link"
        href="#codey-settings-content"
        onClick={(event) => {
          // 页内锚点无法跨越 ShadowRoot，直接在当前控制台内移动焦点。
          const target = event.currentTarget
            .closest(".app-shell")
            ?.querySelector<HTMLElement>("#codey-settings-content");
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        跳至设置内容
      </a>

      {!embedded && (
        <div className="macos-titlebar">
          <div className="macos-traffic-lights">
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-black/15! bg-[#ff5f56]! p-0! shadow-none! hover:opacity-85"
              title="关闭"
              aria-label="关闭窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-black/15! bg-[#ffbd2e]! p-0! shadow-none! hover:opacity-85"
              title="最小化"
              aria-label="最小化窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-black/15! bg-[#27c93f]! p-0! shadow-none! hover:opacity-85"
              title="缩放"
              aria-label="全屏缩放"
            />
          </div>
          <div className="macos-titlebar-title">
            <span className="app-title-text">Codey Control Panel</span>
            <span className="app-version-tag">
              v{status.appVersion || "0.2.0"}
            </span>
          </div>
          <div className="macos-titlebar-right" aria-hidden="true" />
        </div>
      )}

      {!embedded && (
        <header className="z-30 flex flex-col border-b border-black/8 bg-white/75 px-5 py-2.5 backdrop-blur-xl">
          {configHeaderContent}
        </header>
      )}

      {configApplyBannerVisible(status.configApply, configApplyError) && status.configApply && (
        <div
          role={status.configApply.state === "failed" || configApplyError ? "alert" : "status"}
          className="flex flex-wrap items-center gap-2 border-b border-black/8 px-5 py-2 text-xs"
        >
          {status.configApply.state === "pending" && !configApplyError && (
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
          )}
          <span>{configApplyError || configApplyNotice(status.configApply).text}</span>
          {configApplyError && (
            <Button size="sm" variant="outline" onPress={() => void retryConfigApply()}>
              重新查询状态
            </Button>
          )}
        </div>
      )}

      <SettingsLayout
        sections={{
          overview: (
            <>
              <OperationsPanel
                fastContextToolsStatus={fastContextToolsStatus}
                status={operationsStatus}
                busy={busy}
                isBusy={isBusy}
                pluginMarketplaceStatus={pluginMarketplaceStatus}
                onRepairPluginMarketplace={handleRepairPluginMarketplace}
                computerUseNotice={computerUseNotice}
                onPrepareComputerUse={handlePrepareComputerUse}
                onRestart={handleRestartCodex}
                restartStatusUnknown={Boolean(restartStatusError)}
                showRestartAction={!embedded}
              />

              {/* Codex 功能策略（含启动代理） */}
              <div className="full-row-section">
                <FeaturePolicyCard
                  config={config}
                  fastContextToolsStatus={fastContextToolsStatus}
                  isMacClient={status.clientPlatform === "macos"}
                  isWindowsClient={status.clientPlatform === "windows"}
                  popupContainer={popupContainer}
                  tooltipContainer={portalContainer}
                  isBusy={isBusy}
                  onConfigChange={handleConfigChange}
                />
              </div>

              {/* 消息通知：每个渠道 item 占一半 */}
              <div className="full-row-section">
                <NotificationChannelsCard
                  config={config}
                  container={portalContainer}
                  popupContainer={popupContainer}
                  isBusy={isBusy}
                  onAddChannel={handleAddNotificationChannel}
                  onChannelChange={handleNotificationChannelChange}
                  onRequestRemoveChannel={handleRequestRemoveNotificationChannel}
                />
              </div>

              {/* 诊断存储保护 */}
              <div className="full-row-section">
                <TraceLogModule
                  stats={status.traceLogStats}
                  crashpadStats={status.crashpadPendingStats}
                  crashpadSupported={status.clientPlatform === "macos"}
                  traceProtectionEnabled={config.disableTraceLogWrites}
                  crashpadProtectionEnabled={config.protectCrashpadPending}
                  clearBusy={busy === "clear-trace-logs"}
                  refreshing={busy === "refresh-trace-stats"}
                  disabled={isBusy}
                  onClear={handleClearTraceLogs}
                  onRefresh={handleRefreshTraceLogStats}
                />
              </div>
            </>
          ),
          models: (active) => (
            <ModelSection
              active={active}
              config={config}
              currentProviderSnapshot={currentProviderSnapshot}
              officialAccountAvailable={status.officialAccountAvailable === true}
              popupContainer={popupContainer}
              modelState={modelState}
              dirty={dirty}
              isBusy={isBusy}
              busy={busy}
              showAccountUsageInHeader={config.showAccountUsageInHeader}
              onCacheValidMinutesChange={handleCacheValidMinutesChange}
              onSyncCurrentProvider={handleSyncCurrentProvider}
              onFetchRouteModels={handleFetchRouteModels}
              onToggleAccountUsage={handleToggleAccountUsage}
              onSaveOfficialRouteSettings={handleSaveOfficialRouteSettings}
              onSetDefaultModel={handleSetRouteDefaultModel}
              onSaveModelOrder={saveModelOrder}
              routerSessionDiagnosis={routerSessionDiagnosis}
              onMigrateRouterSessions={askMigrateRouterSessions}
              channelList={channelList}
              channelLoadError={channelLoadError}
              channelActionError={channelActionError}
              channelVersionConflict={channelVersionConflict}
              channelNotice={channelNotice}
              onSelectChannel={handleSelectChannel}
              onSetChannelDefaultModel={handleSetChannelDefaultModel}
              onRefreshChannels={handleRefreshChannels}
              officialAccountsRefreshKey={officialAccountsRefreshKey}
              onSwitchOfficialAccount={handleSwitchOfficialAccount}
              onOfficialAccountsChanged={handleOfficialAccountsChanged}
              onNotice={setNotice}
              onRequestConfirmation={setConfirmation}
            />
          ),
          prompt: (
            <PromptOptimizationCard
              config={config}
              currentProviderSnapshot={currentProviderSnapshot}
              officialAccountAvailable={status.officialAccountAvailable === true}
              isBusy={isBusy}
              popupContainer={popupContainer}
              onConfigChange={handleConfigChange}
              onNotice={setNotice}
            />
          ),
          subagents: (
            <SubagentPolicyCard
              config={config}
              popupContainer={popupContainer}
              tooltipContainer={portalContainer}
              isBusy={isBusy}
              subagentModelOptions={subagentModelOptions}
              onConfigChange={handleConfigChange}
              onSubagentOptimizationChange={handleSubagentOptimizationChange}
            />
          ),
          mcp: (active) => (
            <CodexExtensionsPage kind="mcp" active={active} request={extensionRequest} container={popupContainer} />
          ),
          skills: (active) => (
            <CodexExtensionsPage kind="skill" active={active} request={extensionRequest} container={popupContainer} />
          ),
        }}
      />

      <NoticeToast
        autoDismissEnabled
        controller={noticeController}
      />

      <ModelPickerDialog
        open={modelPickerVisible}
        isBusy={isBusy}
        busy={busy}
        container={portalContainer}
        customModelInput={customModelInput}
        modelInputError={modelInputError}
        modelSyncWarning={modelSyncWarning}
        autoReviewSupported={draftAutoReviewSupported}
        thirdPartyModelOptions={thirdPartyModelOptions}
        modelState={modelEditorState}
        draftModelSet={draftModelSet}
        draft1MModelSet={draft1MModelSet}
        draftModelContexts={draftModelContexts}
        onUpdateDraftModelContext={updateDraftModelContext}
        onToggleDraft1MModel={toggleDraft1MModel}
        manualThirdPartyModelKeys={draftManualThirdPartyModelKeys}
        onOpenChange={handleModelPickerOpenChange}
        onCustomModelInputChange={updateCustomModelInput}
        onAddCustomModel={addCustomModel}
        onToggleDraftModel={toggleDraftModel}
        onDeleteThirdPartyModel={deleteDraftThirdPartyModel}
        onAutoReviewSupportedChange={setDraftAutoReviewSupported}
        onSave={saveModelSelection}
        modelOrderMode={draftModelOrderMode}
        onMoveModel={moveDraftModel}
        onRestoreModelOrder={restoreDraftModelOrder}
      />

      <ConfirmationDialogHost
        container={portalContainer}
        controller={confirmationController}
      />

      <SystemSettingsDialog
        open={systemSettingsOpen}
        onOpenChange={setSystemSettingsOpen}
        container={portalContainer}
        appVersion={status.appVersion}
        codexAppVersion={status.codexAppVersion}
        codexAppPath={config.codexAppPath || status.codexAppPath}
        onRefreshStatus={refreshStatus}
        isBusy={isBusy}
        busy={busy}
        onRepairCodexConfig={askRepairCodexConfig}
        configRepairNotice={configRepairNotice}
      />
    </main>
  );
  return embedded ? (
    <SettingsModalShell
      afterClose={onAfterClose}
      container={modalContainer}
      header={
        <div className="relative z-[2] flex w-full items-center overflow-visible">
          {configHeaderContent}
        </div>
      }
      onCancel={handleCloseSettings}
      visible={modalVisible}
    >
      {appContent}
    </SettingsModalShell>
  ) : (
    appContent
  );
}
