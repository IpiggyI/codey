import type {
  FastContextToolsStatus,
  InjectionScriptStatus,
  RuntimeStatus,
} from "./App.types";

type OptimizationFeatureIcon =
  | "code"
  | "database"
  | "fastctx"
  | "notifications"
  | "subagent";

export type EnabledOptimizationFeature = {
  id: string;
  icon: OptimizationFeatureIcon;
  name: string;
  detail?: string;
  sourceLabel: string;
};

type OptimizationRuntimeStatus = Pick<
  RuntimeStatus,
  | "running"
  | "injectionScripts"
  | "fastContextToolsActive"
  | "subagentOptimizationActive"
  | "notificationChannelsActive"
  | "activeNotificationChannelCount"
  | "traceLogWriteProtectionActive"
  | "crashpadDiskProtectionActive"
>;

export type InjectionIssue = {
  id: string;
  name: string;
  internal: boolean;
  sourceLabel: string;
  cause: string;
  impact: string;
  remedy: string;
  error?: string;
};

const ERROR_LOG_HINT =
  "Codey 错误日志位于用户目录下的 .codex-session-delete/codey-errors.log。该日志跨日清空，请在出错当天提交。";

// Impact of an internal component failure; feature names describe themselves.
const INTERNAL_COMPONENT_IMPACTS: Record<string, string> = {
  "bridge-helpers": "Codey 无法与 Codex 页面通信，依赖页面桥接的功能都不可用。",
  "model-whitelist": "Codex 模型列表不会按 Codey 的模型设置过滤和补充。",
  "settings-overlay-loader": "Codex 设置中的 Codey 配置面板可能无法打开。",
  "renderer-controls": "侧栏会话工具、默认中文界面等页面增强可能不可用。",
  "plugin-marketplace-compatibility": "插件市场可能无法显示和管理 Codey 内置市场的插件。",
};

const ISSUE_RULES: Array<{
  pattern: RegExp;
  cause: string;
  remedy: string;
}> = [
  {
    pattern: /形态不兼容|源码已变化|无法唯一定位|补偿匹配次数异常/,
    cause: "当前 Codex 版本的页面代码与这个 Codey 版本的适配规则不一致。",
    remedy:
      "重启 Codex 通常无法恢复。请把 Codey 更新到最新版本；已是最新版本时，请把错误详情和 Codey 错误日志提交给维护者。",
  },
  {
    pattern: /超时|deadline has elapsed|作用域/,
    cause: "Codex 页面在等待时限内没有准备就绪，组件未能完成安装。",
    remedy:
      "重启 Codex 通常可以恢复。多次重启后仍然出现时，请把错误详情和 Codey 错误日志提交给维护者。",
  },
  {
    pattern: /调试连接|调试命令失败|调试入口/,
    cause: "Codey 与 Codex 页面的调试连接中断。",
    remedy: "重启 Codex 通常可以恢复。",
  },
];

export function describeInjectionIssues(
  injectionScripts: readonly InjectionScriptStatus[],
): InjectionIssue[] {
  return injectionScripts
    .filter((script) => script.status === "failed" || script.status === "unknown")
    .map((script) => {
      const internal = script.visibility === "internal";
      const userScript = script.source === "user";
      const error = script.error?.trim() || undefined;
      const impact = internal
        ? INTERNAL_COMPONENT_IMPACTS[script.id] ??
          "该基础组件支撑的功能可能不可用。"
        : `“${script.name}”未生效。`;
      const rule = error
        ? ISSUE_RULES.find(({ pattern }) => pattern.test(error))
        : undefined;
      const { cause, remedy } = userScript
        ? {
            cause: "用户脚本运行出错，或没有通过生效检查。",
            remedy: "请检查脚本是否适用于当前 Codex 版本，或者停用该脚本。",
          }
        : script.status === "unknown"
          ? {
              cause: "Codey 没有读到该组件的运行结果。",
              remedy: "请等待状态自动刷新。持续出现时，请重启 Codex。",
            }
          : rule ?? {
              cause: "组件运行时出错。",
              remedy:
                "请重启 Codex。重启后仍然出现时，请把错误详情和 Codey 错误日志提交给维护者。",
            };
      return {
        id: script.id,
        name: script.name,
        internal,
        sourceLabel: internal ? "基础组件" : userScript ? "用户脚本" : "内置功能",
        cause,
        impact,
        remedy: remedy.includes("错误日志") ? `${remedy}${ERROR_LOG_HINT}` : remedy,
        error,
      };
    });
}

type InjectionStatusSummary = {
  failedInjectionScriptCount: number;
  internalInjectionError: boolean;
  internalInjectionPending: boolean;
  unverifiedInjectionScriptCount: number;
};

export function buildEnabledOptimizationFeatures(
  status: OptimizationRuntimeStatus,
  fastContextToolsStatus: FastContextToolsStatus,
): EnabledOptimizationFeature[] {
  const injectedFeatures = (status.injectionScripts ?? [])
    .filter(
      (script) =>
        script.visibility === "feature" && script.status === "effective",
    )
    .map((script) => ({
      id: script.id,
      icon: "code" as const,
      name: script.name,
      detail: script.detail,
      sourceLabel: script.source === "user" ? "用户脚本" : "内置",
    }));
  const appliedFeatures: EnabledOptimizationFeature[] = [...injectedFeatures];

  if (status.subagentOptimizationActive === true) {
    appliedFeatures.push({
      id: "subagent-optimization",
      icon: "subagent",
      name: "子代理优化",
      detail: "子代理角色与调度增强已随当前运行实例加载",
      sourceLabel: "Codey",
    });
  }

  const activeNotificationChannelCount =
    status.activeNotificationChannelCount ?? 0;
  if (
    status.notificationChannelsActive === true &&
    activeNotificationChannelCount > 0
  ) {
    appliedFeatures.push({
      id: "notification-channels",
      icon: "notifications",
      name: "消息通知",
      detail: `已启用 ${activeNotificationChannelCount} 个通知渠道`,
      sourceLabel: "Codey",
    });
  }

  const traceWriteProtectionActive =
    status.traceLogWriteProtectionActive === true;
  const crashpadDiskProtectionActive =
    status.crashpadDiskProtectionActive === true;
  if (traceWriteProtectionActive || crashpadDiskProtectionActive) {
    const protectionDetail =
      traceWriteProtectionActive && crashpadDiskProtectionActive
        ? "Codex Trace 日志与 Crashpad 磁盘保护均已生效"
        : traceWriteProtectionActive
          ? "Codex Trace 日志写盘保护已生效"
          : "Codex Crashpad 磁盘保护已生效";
    appliedFeatures.push({
      id: "disk-write-protection",
      icon: "database",
      name: "写盘保护",
      detail: protectionDetail,
      sourceLabel: "Codey",
    });
  }

  const fastContextToolsActive =
    status.fastContextToolsActive === true ||
    (status.running && fastContextToolsStatus.userConfigured);
  if (!fastContextToolsActive) return appliedFeatures;

  const externalFastContextTools = fastContextToolsStatus.userConfigured;
  return [
    {
      id: "fastctx-context-tools",
      icon: "fastctx",
      name: "FastCtx 上下文加速",
      detail: externalFastContextTools
        ? `Codex 已配置 FastCtx${
            fastContextToolsStatus.serverId
              ? `（${fastContextToolsStatus.serverId}）`
              : ""
          }`
        : "Codey 内置 FastCtx 已随当前运行实例加载",
      sourceLabel: externalFastContextTools ? "外部配置" : "Codey",
    },
    ...appliedFeatures,
  ];
}

export function summarizeInjectionScripts(
  injectionScripts: readonly InjectionScriptStatus[],
): InjectionStatusSummary {
  let failedInjectionScriptCount = 0;
  let internalInjectionError = false;
  let internalInjectionPending = false;
  let unverifiedInjectionScriptCount = 0;

  for (const script of injectionScripts) {
    const failedOrUnknown =
      script.status === "failed" || script.status === "unknown";
    if (script.visibility === "internal") {
      internalInjectionPending ||= script.status === "executed";
      internalInjectionError ||= failedOrUnknown;
    } else if (script.status === "executed") {
      unverifiedInjectionScriptCount += 1;
    } else if (failedOrUnknown) {
      failedInjectionScriptCount += 1;
    }
  }

  return {
    failedInjectionScriptCount,
    internalInjectionError,
    internalInjectionPending,
    unverifiedInjectionScriptCount,
  };
}
