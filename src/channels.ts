import type {
  ChannelEntry,
  ChannelList,
  ChannelMutationResult,
  Config,
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

export type ChannelOutcome =
  | { kind: "applied"; restartRequired: boolean }
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
  // 交给既有的重启确认流程，这里不自带重启路径。
  askRestart: () => void;
};

export const needsDefaultModel = (entry: ChannelEntry) => !entry.defaultModel?.trim();

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
      return { kind: "applied", restartRequired: false };
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
    return { kind: "applied", restartRequired: result.restartRequired };
  }

  const setDefaultModel = (channelId: string, model: string) =>
    mutate("set_channel_default_model", { channelId, model });

  // 渠道没有默认模型时，先保存使用者给出的模型，再选择渠道。
  async function select(channelId: string | null, defaultModel?: string): Promise<ChannelOutcome> {
    if (channelId !== null && defaultModel !== undefined) {
      const saved = await setDefaultModel(channelId, defaultModel);
      if (saved.kind !== "applied") return saved;
    }
    const outcome = await mutate("select_channel", { channelId });
    if (outcome.kind === "applied" && outcome.restartRequired) deps.askRestart();
    return outcome;
  }

  // 切换官方账号即切换到它的渠道。后端已保存修订号，这里沿用渠道的配置接纳流程，
  // 保证下一次渠道请求带上新修订；列表读取失败时仍接纳修订与所选渠道。
  async function switchOfficialAccount(accountId: string): Promise<OfficialAccountSwitchOutcome> {
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
    if (result.restartRequired) deps.askRestart();
    return { outcome: { kind: "applied", restartRequired: result.restartRequired }, accounts: result, listError };
  }

  // 运行状态响应到达时调用；较晚到达的 null 同样清除提示。
  const noteStatusNotice = (notice: string | null) => deps.setChannelNotice(notice);

  return { refresh, select, setDefaultModel, switchOfficialAccount, noteStatusNotice };
}
