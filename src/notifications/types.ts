export type NotificationChannelKind =
  "feishu" | "wecom" | "telegram" | "wechatClaw" | "ntfy";
export type NotificationChannelSessionStatus = "active" | "expired";

export const MAX_NOTIFICATION_CHANNELS = 32;

export type NotificationChannel = {
  id: string;
  kind: NotificationChannelKind;
  enabled: boolean;
  url: string;
  urlConfigured: boolean;
  clearUrl?: boolean;
  botToken: string;
  botTokenConfigured: boolean;
  clearBotToken?: boolean;
  contextToken: string;
  contextTokenConfigured: boolean;
  clearContextToken?: boolean;
  getUpdatesBuf?: string;
  chatId: string;
  sessionStatus?: NotificationChannelSessionStatus;
};

export type NotificationChannelEditorProps = {
  channel: NotificationChannel;
  disabled: boolean;
  onChange: (patch: Partial<NotificationChannel>) => void;
};

export type NtfyChannelIssues = {
  url: string;
  topic: string;
};

// 与后端 ntfy_base_url / ntfy_topic 的前置判断一致：只接受 HTTPS 根地址，
// 已保存的地址不回显，留空表示沿用。
export function validateNtfyChannel(
  channel: Pick<NotificationChannel, "url" | "urlConfigured" | "chatId">,
): NtfyChannelIssues {
  return {
    url: validateNtfyUrl(channel.url, channel.urlConfigured),
    topic: validateNtfyTopic(channel.chatId),
  };
}

export function validateNtfyTopic(value: string) {
  const topic = value.trim();
  if (!topic) return "请先填写 ntfy 主题";
  return topic.length <= 64 && /^[A-Za-z0-9_-]+$/.test(topic)
    ? ""
    : "ntfy 主题只能包含字母、数字、下划线和连字符，长度不超过 64 个字符";
}

function validateNtfyUrl(value: string, configured: boolean) {
  const normalized = value.trim();
  if (!normalized) return configured ? "" : "请先填写 ntfy 服务器地址";
  const invalid = "ntfy 服务器地址必须是 HTTPS 根地址，例如 https://ntfy.sh";
  try {
    const parsed = new URL(normalized);
    const isRoot =
      parsed.pathname === "/" &&
      !normalized.includes("?") &&
      !normalized.includes("#");
    return parsed.protocol === "https:" &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      isRoot
      ? ""
      : invalid;
  } catch {
    return invalid;
  }
}
