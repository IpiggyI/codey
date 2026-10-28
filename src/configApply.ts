import type { ConfigApplyStatus, Notice } from "./App.types";

export function reconcileConfigApply(
  current: ConfigApplyStatus | null | undefined,
  incoming: ConfigApplyStatus | null | undefined,
): ConfigApplyStatus | null | undefined {
  if (!incoming) return current;
  if (current && (incoming.revision < current.revision ||
    (incoming.revision === current.revision && current.state !== "pending"))) return current;
  return incoming;
}

export function configApplyNotice(status: ConfigApplyStatus): Notice {
  switch (status.state) {
    case "pending": return { tone: "info", text: "配置已保存，正在应用" };
    case "applied": return { tone: "success", text: "配置已保存并应用" };
    case "restart_required": return { tone: "info", text: "配置已保存，部分设置需重启 Codex 后生效" };
    case "failed": return { tone: "error", text: `配置已保存，但未能完全应用：${status.error || "请检查 Codex 状态后重试"}` };
    case "saved": return { tone: "success", text: "配置已保存" };
  }
}

export function configApplyPending(next: ConfigApplyStatus | null | undefined, revision: number) {
  return !next || next.revision < revision || next.state === "pending";
}

// 横幅只提示进行中、失败或状态无法确认；成功后隐藏。
export function configApplyBannerVisible(
  status: ConfigApplyStatus | null | undefined,
  queryError: string | null,
) {
  return Boolean(status && (status.state === "pending" || status.state === "failed" || queryError));
}

// 本次会话看到的应用从进行中结束时，用提示告知最终结果。
export function configApplyCompletionNotice(
  previous: ConfigApplyStatus | null | undefined,
  next: ConfigApplyStatus | null | undefined,
): Notice | null {
  if (previous?.state !== "pending" || !next || next.state === "pending") return null;
  if (next.revision < previous.revision) return null;
  return configApplyNotice(next);
}
