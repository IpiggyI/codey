import { memo, useState } from "react";

import type { ChannelEntry, ChannelList } from "./App.types";
import { Badge, Button } from "./components/ui";
import { ManualModelCombobox } from "./components/ManualModelCombobox";
import { canSelectChannel, channelModelOptions, currentChannel, defaultModelText, needsDefaultModel } from "./channels";
import { SETTINGS_OVERLAY_Z_INDEX } from "./overlay.constants";

type ChannelSectionProps = {
  channelList: ChannelList | null;
  loadError: string | null;
  actionError: string | null;
  versionConflict: boolean;
  notice: string | null;
  modelOptions: string[];
  popupContainer: HTMLElement | null;
  disabled: boolean;
  onSelect: (channelId: string | null, defaultModel?: string) => void;
  onSetDefaultModel: (channelId: string, model: string) => void;
  onRefresh: () => void;
};

type Editing = { channelId: string; draft: string; thenSelect: boolean };
// 编辑行关闭后，焦点要回到打开它的按钮：switch 是「切换到此渠道」，edit 是「设置/修改默认模型」。
type FocusRequest = { channelId: string; target: "switch" | "edit" };

function summaryText(list: ChannelList | null, loadError: string | null) {
  if (!list) return loadError ? "渠道列表读取失败" : "正在读取渠道";
  const current = currentChannel(list);
  const name = current?.displayName ?? list.effectiveProviderId;
  const chosen = list.selectedChannelId !== null && current?.id === list.selectedChannelId;
  return chosen
    ? `当前渠道：${name}（已手动选择）`
    : `当前渠道：${name}（跟随用户配置的默认 provider）`;
}

function ChannelSectionComponent({
  channelList,
  loadError,
  actionError,
  versionConflict,
  notice,
  modelOptions,
  popupContainer,
  disabled,
  onSelect,
  onSetDefaultModel,
  onRefresh,
}: ChannelSectionProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const error = actionError ?? loadError;

  const openEditor = (next: Editing) => {
    setFocusRequest(null);
    setEditing(next);
  };
  // 编辑行里持有焦点的元素随它卸载，不归还焦点就会落回页面顶部；全局禁用时按钮无法聚焦，不记录。
  const closeEditor = (editor: Editing) => {
    setEditing(null);
    if (!disabled) setFocusRequest({ channelId: editor.channelId, target: editor.thenSelect ? "switch" : "edit" });
  };
  // 按钮此刻被禁用（例如操作进行中）时先不聚焦，请求保留到它可用。
  const takeFocus = (node: HTMLButtonElement | null) => {
    if (!node || node.disabled) return;
    node.focus();
    setFocusRequest(null);
  };

  const choose = (entry: ChannelEntry) => {
    if (needsDefaultModel(entry)) {
      openEditor({ channelId: entry.id, draft: "", thenSelect: true });
      return;
    }
    onSelect(entry.id);
  };
  const commit = (editor: Editing) => {
    const model = editor.draft.trim();
    if (!model) return;
    closeEditor(editor);
    if (editor.thenSelect) onSelect(editor.channelId, model);
    else onSetDefaultModel(editor.channelId, model);
  };

  return (
    <aside className="current-provider-snapshot" aria-label="渠道">
      <div className="current-provider-snapshot-heading">
        <strong>渠道</strong>
        <small>{summaryText(channelList, loadError)}</small>
      </div>
      {notice ? (
        <p role="status" className="mb-2 text-xs text-[#9a6700]">{notice}</p>
      ) : null}
      {error ? (
        <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-[#c4271c]">
          <span className="min-w-0 flex-1">{error}</span>
          {versionConflict || !actionError ? (
            <Button variant="outline" size="xs" disabled={disabled} onPress={onRefresh}>
              {versionConflict ? "刷新后重试" : "重新读取"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {channelList ? (
        <>
          <ul className="m-0 grid list-none gap-2 p-0">
            {channelList.channels.map((entry) => {
              const editor = editing?.channelId === entry.id ? editing : null;
              const switchDisabled = disabled || !canSelectChannel(entry);
              const request = focusRequest?.channelId === entry.id ? focusRequest.target : null;
              // 保存并切换后该渠道成为当前渠道，「切换到此渠道」被禁用，焦点改给默认模型按钮。
              const focusSwitch = request === "switch" && !switchDisabled;
              const focusEdit = request === "edit" || (request === "switch" && !focusSwitch);
              return (
                <li key={entry.id} className="grid gap-2 rounded-lg border border-black/5 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[13px]">{entry.displayName}</strong>
                    <Badge variant={entry.kind === "official" ? "info" : "brand"}>
                      {entry.kind === "official" ? "官方账号" : "provider"}
                    </Badge>
                    {entry.current ? <Badge variant="success">当前渠道</Badge> : null}
                    <Badge variant={entry.available ? "secondary" : "warning"}>
                      {entry.available ? "可用" : "不可用"}
                    </Badge>
                    <span className="ml-auto text-xs text-[#6e6e73]">{defaultModelText(entry)}</span>
                  </div>
                  {entry.unavailableReason ? (
                    <small className="text-xs text-[#9a6700]">{entry.unavailableReason}</small>
                  ) : null}
                  {editor ? (
                    <div
                      className="flex flex-wrap items-center gap-2"
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        // Escape 只取消编辑行，不再向外层传递。
                        event.stopPropagation();
                        closeEditor(editor);
                      }}
                    >
                      <div className="min-w-[220px] flex-1">
                        <ManualModelCombobox
                          ariaLabel={`${entry.displayName} 默认模型`}
                          autoFocus
                          emptyHint="没有可选模型，可直接输入模型名称"
                          value={editor.draft}
                          options={channelModelOptions(entry, modelOptions)}
                          disabled={disabled}
                          getPopupContainer={() => popupContainer ?? document.body}
                          zIndex={SETTINGS_OVERLAY_Z_INDEX}
                          onChange={(draft) => setEditing({ ...editor, draft })}
                        />
                      </div>
                      <Button size="xs" disabled={disabled || !editor.draft.trim()} onPress={() => commit(editor)}>
                        {editor.thenSelect ? "保存并切换" : "保存默认模型"}
                      </Button>
                      <Button variant="outline" size="xs" onPress={() => closeEditor(editor)}>取消</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        ref={focusSwitch ? takeFocus : undefined}
                        variant="outline"
                        size="xs"
                        disabled={switchDisabled}
                        onPress={() => choose(entry)}
                      >
                        切换到此渠道
                      </Button>
                      <Button
                        ref={focusEdit ? takeFocus : undefined}
                        variant="ghost"
                        size="xs"
                        disabled={disabled}
                        onPress={() => openEditor({ channelId: entry.id, draft: entry.defaultModel ?? "", thenSelect: false })}
                      >
                        {entry.defaultModel ? "修改默认模型" : "设置默认模型"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {channelList.selectedChannelId !== null ? (
            <div className="mt-2">
              <Button variant="outline" size="xs" disabled={disabled} onPress={() => onSelect(null)}>
                跟随用户配置
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

export const ChannelSection = memo(ChannelSectionComponent);
