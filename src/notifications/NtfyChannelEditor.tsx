import { memo } from "react";
import { IconBellRinging, IconKey, IconServer } from "@tabler/icons-react";

import { Input } from "../components/ui";
import { inputShellClass, insetInputClass } from "../uiClasses";
import { validateNtfyChannel, type NotificationChannelEditorProps } from "./types";

function NtfyChannelEditorComponent({
  channel,
  disabled,
  onChange,
}: NotificationChannelEditorProps) {
  const issues = validateNtfyChannel(channel);
  // 留空只是提示缺项；填了但不合规才按错误显示。
  const urlIssueClass = channel.url.trim() ? "field-error" : "field-hint";
  const topicIssueClass = channel.chatId.trim() ? "field-error" : "field-hint";
  return (
    <>
      <label className="field">
        <span>服务器地址</span>
        <div className={inputShellClass}>
          <IconServer size={15} aria-hidden="true" />
          <Input
            className={insetInputClass}
            type="text"
            value={channel.url}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                url: event.target.value,
                clearUrl: false,
              })
            }
            placeholder={
              channel.urlConfigured
                ? "已保存；输入新地址可替换"
                : "https://ntfy.sh"
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {issues.url ? (
          <small className={urlIssueClass} role="status">
            {issues.url}
          </small>
        ) : null}
      </label>
      <label className="field">
        <span>主题</span>
        <div className={inputShellClass}>
          <IconBellRinging size={15} aria-hidden="true" />
          <Input
            className={insetInputClass}
            value={channel.chatId}
            disabled={disabled}
            onChange={(event) => onChange({ chatId: event.target.value })}
            placeholder="自定义主题，例如 codey-notify"
            spellCheck={false}
          />
        </div>
        {issues.topic ? (
          <small className={topicIssueClass} role="status">
            {issues.topic}
          </small>
        ) : null}
      </label>
      <label className="field">
        <span>访问令牌</span>
        <div className={inputShellClass}>
          <IconKey size={15} aria-hidden="true" />
          <Input
            className={insetInputClass}
            type="password"
            value={channel.botToken}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                botToken: event.target.value,
                clearBotToken: false,
              })
            }
            placeholder={
              channel.botTokenConfigured
                ? "已保存；输入新令牌可替换"
                : "公开主题可留空"
            }
            autoComplete="new-password"
            spellCheck={false}
          />
        </div>
      </label>
    </>
  );
}

export const NtfyChannelEditor = memo(NtfyChannelEditorComponent);
