import type {
  ChannelEntry,
  ChannelList,
  ChannelMutationResult,
  Config,
  Confirmation,
  Notice,
  OfficialAccountSwitchResult,
} from "./App.types";
import { errorText } from "./appUtils";

export type ChannelCommand =
  | "list_channels"
  | "set_channel_default_model"
  | "select_channel"
  | "set_default_official_account";

// 后端版本冲突提示中的固定片段，用它判断是否提示使用者刷新。
const VERSION_CONFLICT_MARKER = "已被其他操作更新";

// restart：started 表示使用者已确认，切换后直接重启 Codex；next-start 表示 Codex 未运行，下次启动生效。
export type SwitchRestart = "started" | "next-start" | "none";

export type ChannelOutcome =
  | { kind: "applied"; restartRequired: boolean; restart: SwitchRestart }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | { kind: "failed"; message: string; conflict: boolean };

// accounts 只要后端切换成功就返回，即使配置接纳因修订过旧被拒绝。
export type OfficialAccountSwitchOutcome = {
  outcome: ChannelOutcome;
  accounts: OfficialAccountSwitchResult | null;
  listError: string | null;
};

export type ChannelControllerDeps = {
  call: <T>(command: ChannelCommand, args: Record<string, unknown>) => Promise<T>;
  readConfig: () => Config | null;
  // 沿用配置命令结果的接纳流程；旧修订返回 false。
  adopt: (config: Config, restartRequired: boolean) => boolean;
  setChannelList: (list: ChannelList) => void;
  // 回退提示以最近一次到达的响应为准：渠道列表与运行状态都经此更新。
  setChannelNotice: (notice: string | null) => void;
  codexRunning: () => boolean;
  // Codex 运行时，切换前先走重启确认；取消时返回 false。
  confirmSwitch: (target: SwitchTarget) => Promise<boolean>;
  // 使用者已确认重启，交给既有的重启操作直接执行，这里不自带重启路径。
  restart: () => void;
};

export type SwitchTarget = "channel" | "official-account";

export type ConfirmationHost = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Confirmation | null;
  setConfirmation: (confirmation: Confirmation) => void;
};

// 把确认对话框包装成 Promise：确认时 resolve(true)，对话框被关闭或被其他确认替换时 resolve(false)。
// 对话框确认时先清除再执行 run，所以清除后留到微任务再判定是否取消。
export function confirmThroughDialog(
  host: ConfirmationHost,
  confirmation: Omit<Confirmation, "run">,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(confirmed);
    };
    const pending: Confirmation = { ...confirmation, run: () => settle(true) };
    const unsubscribe = host.subscribe(() => {
      if (host.getSnapshot() === pending) return;
      queueMicrotask(() => settle(false));
    });
    host.setConfirmation(pending);
  });
}

// 切换用的模型由后端按渠道默认模型、全局默认模型、Codex 配置的顶层 model 依次解析；
// 三处都没有时才需要使用者先给出模型。
export const needsDefaultModel = (entry: ChannelEntry) => !entry.switchModel?.trim();

const SWITCH_MODEL_SOURCE_LABELS: Record<NonNullable<ChannelEntry["switchModelSource"]>, string> = {
  channel: "渠道默认模型",
  global: "全局默认模型",
  "codex-config": "Codex 配置",
};

// 渠道行右侧的默认模型说明；没有自己的默认模型时，说明切换会用哪个模型、取自哪里。
export function defaultModelText(entry: ChannelEntry) {
  if (entry.defaultModel) return `默认模型：${entry.defaultModel}`;
  if (entry.switchModel && entry.switchModelSource) {
    return `尚未设置默认模型，切换时使用 ${entry.switchModel}（${SWITCH_MODEL_SOURCE_LABELS[entry.switchModelSource]}）`;
  }
  return "尚未设置默认模型";
}

// 编辑默认模型时的候选：当前渠道把当前 provider 的模型清单排在前面，再并入渠道自己的清单。
export function channelModelOptions(entry: ChannelEntry, currentProviderOptions: string[]) {
  const options = entry.current ? [...currentProviderOptions, ...entry.modelOptions] : entry.modelOptions;
  return [...new Set(options)];
}

// 没有稳定账号标识的官方账号以此占位，后端不允许选择它。
const UNAVAILABLE_OFFICIAL_ID = "official:unavailable";

export const canSelectChannel = (entry: ChannelEntry) =>
  entry.available && !entry.current && entry.id !== UNAVAILABLE_OFFICIAL_ID;

export const currentChannel = (list: ChannelList | null) =>
  list?.channels.find((entry) => entry.current) ?? null;

export const isVersionConflict = (message: string) => message.includes(VERSION_CONFLICT_MARKER);

// 渠道命令只返回修订号与渠道列表，把它们并入已接纳的配置，保证下一次请求带最新修订。
export function mergeChannelResult(config: Config, result: ChannelMutationResult): Config {
  const defaultModelsByChannel = { ...(config.defaultModelsByChannel ?? {}) };
  for (const entry of result.channelList.channels) {
    if (entry.defaultModel) defaultModelsByChannel[entry.id] = entry.defaultModel;
  }
  return {
    ...config,
    settingsRevision: result.settingsRevision,
    selectedChannelId: result.channelList.selectedChannelId,
    defaultModelsByChannel,
  };
}

// 渠道变更已保存后再读取当前 provider；读取失败时给出错误提示，不能被成功提示盖掉。
export async function noticeAfterChannelChange(
  refreshProvider: () => Promise<void>,
  success: Notice,
): Promise<Notice> {
  try {
    await refreshProvider();
    return success;
  } catch (error) {
    return { tone: "error", text: `渠道已更新，但读取当前 provider 失败：${errorText(error)}` };
  }
}

export function createChannelController(deps: ChannelControllerDeps) {
  const adoptList = (list: ChannelList) => {
    deps.setChannelList(list);
    deps.setChannelNotice(list.notice);
  };

  // 每次列表请求或渠道变更接纳都使在途的列表请求作废。
  let listGeneration = 0;

  const failed = (error: unknown): ChannelOutcome => {
    const message = errorText(error);
    return { kind: "failed", message, conflict: isVersionConflict(message) };
  };

  async function refresh(): Promise<ChannelOutcome> {
    const generation = ++listGeneration;
    try {
      const list = await deps.call<ChannelList>("list_channels", {});
      if (generation !== listGeneration) return { kind: "stale" };
      adoptList(list);
      return { kind: "applied", restartRequired: false, restart: "none" };
    } catch (error) {
      if (generation !== listGeneration) return { kind: "stale" };
      return failed(error);
    }
  }

  async function mutate(
    command: "set_channel_default_model" | "select_channel",
    args: Record<string, unknown>,
  ): Promise<ChannelOutcome> {
    const config = deps.readConfig();
    if (!config) return { kind: "failed", message: "Codey 配置尚未载入", conflict: false };
    let result: ChannelMutationResult;
    try {
      result = await deps.call<ChannelMutationResult>(command, {
        ...args,
        expectedRevision: config.settingsRevision,
      });
    } catch (error) {
      return failed(error);
    }
    const latest = deps.readConfig();
    if (!latest || !deps.adopt(mergeChannelResult(latest, result), result.restartRequired)) {
      return { kind: "stale" };
    }
    listGeneration += 1;
    adoptList(result.channelList);
    return { kind: "applied", restartRequired: result.restartRequired, restart: "none" };
  }

  // Codex 运行时先确认再发送切换命令；返回 null 表示使用者取消，否则返回切换后是否直接重启。
  async function confirmBeforeSwitch(target: SwitchTarget): Promise<boolean | null> {
    if (!deps.codexRunning()) return false;
    return (await deps.confirmSwitch(target)) ? true : null;
  }

  function finishSwitch(outcome: ChannelOutcome, restartAfter: boolean): ChannelOutcome {
    if (outcome.kind !== "applied") return outcome;
    if (!restartAfter) return { ...outcome, restart: "next-start" };
    if (!outcome.restartRequired) return outcome;
    deps.restart();
    return { ...outcome, restart: "started" };
  }

  const setDefaultModel = (channelId: string, model: string) =>
    mutate("set_channel_default_model", { channelId, model });

  // 渠道没有默认模型时，先保存使用者给出的模型，再选择渠道；确认在两条命令之前。
  async function select(channelId: string | null, defaultModel?: string): Promise<ChannelOutcome> {
    const restartAfter = await confirmBeforeSwitch("channel");
    if (restartAfter === null) return { kind: "cancelled" };
    if (channelId !== null && defaultModel !== undefined) {
      const saved = await setDefaultModel(channelId, defaultModel);
      if (saved.kind !== "applied") return saved;
    }
    return finishSwitch(await mutate("select_channel", { channelId }), restartAfter);
  }

  // 切换官方账号即切换到它的渠道。后端已保存修订号，这里沿用渠道的配置接纳流程，
  // 保证下一次渠道请求带上新修订；列表读取失败时仍接纳修订与所选渠道。
  async function switchOfficialAccount(accountId: string): Promise<OfficialAccountSwitchOutcome> {
    const restartAfter = await confirmBeforeSwitch("official-account");
    if (restartAfter === null) return { outcome: { kind: "cancelled" }, accounts: null, listError: null };
    let result: OfficialAccountSwitchResult;
    try {
      result = await deps.call<OfficialAccountSwitchResult>("set_default_official_account", { accountId });
    } catch (error) {
      return { outcome: failed(error), accounts: null, listError: null };
    }
    const generation = ++listGeneration;
    let list: ChannelList | null = null;
    let listError: string | null = null;
    try {
      list = await deps.call<ChannelList>("list_channels", {});
    } catch (error) {
      listError = errorText(error);
    }
    const latest = deps.readConfig();
    const merged = latest && (list
      ? mergeChannelResult(latest, {
        status: "ok",
        channelList: list,
        settingsRevision: result.settingsRevision,
        restartRequired: result.restartRequired,
      })
      : { ...latest, settingsRevision: result.settingsRevision, selectedChannelId: `official:${result.accountId}` });
    if (!merged || !deps.adopt(merged, result.restartRequired)) {
      return { outcome: { kind: "stale" }, accounts: result, listError };
    }
    if (list && generation === listGeneration) adoptList(list);
    const outcome = finishSwitch(
      { kind: "applied", restartRequired: result.restartRequired, restart: "none" },
      restartAfter,
    );
    return { outcome, accounts: result, listError };
  }

  // 运行状态响应到达时调用；较晚到达的 null 同样清除提示。
  const noteStatusNotice = (notice: string | null) => deps.setChannelNotice(notice);

  return { refresh, select, setDefaultModel, switchOfficialAccount, noteStatusNotice };
}
