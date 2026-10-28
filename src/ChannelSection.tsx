import { memo, useState } from "react";

import type { ChannelEntry, ChannelList } from "./App.types";
import { Badge, Button } from "./components/ui";
import { ManualModelCombobox } from "./components/ManualModelCombobox";
import { canSelectChannel, currentChannel, needsDefaultModel } from "./channels";
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
  const error = actionError ?? loadError;

  const choose = (entry: ChannelEntry) => {
    if (needsDefaultModel(entry)) {
      setEditing({ channelId: entry.id, draft: "", thenSelect: true });
      return;
    }
    onSelect(entry.id);
  };
  const commit = (editor: Editing) => {
    const model = editor.draft.trim();
    if (!model) return;
    setEditing(null);
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
                    <span className="ml-auto text-xs text-[#6e6e73]">
                      {entry.defaultModel ? `默认模型：${entry.defaultModel}` : "尚未设置默认模型"}
                    </span>
                  </div>
                  {entry.unavailableReason ? (
                    <small className="text-xs text-[#9a6700]">{entry.unavailableReason}</small>
                  ) : null}
                  {editor ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-[220px] flex-1">
                        <ManualModelCombobox
                          ariaLabel={`${entry.displayName} 默认模型`}
                          value={editor.draft}
                          options={entry.current ? modelOptions : []}
                          disabled={disabled}
                          getPopupContainer={() => popupContainer ?? document.body}
                          zIndex={SETTINGS_OVERLAY_Z_INDEX}
                          onChange={(draft) => setEditing({ ...editor, draft })}
                        />
                      </div>
                      <Button size="xs" disabled={disabled || !editor.draft.trim()} onPress={() => commit(editor)}>
                        {editor.thenSelect ? "保存并切换" : "保存默认模型"}
                      </Button>
                      <Button variant="outline" size="xs" onPress={() => setEditing(null)}>取消</Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={disabled || !canSelectChannel(entry)}
                        onPress={() => choose(entry)}
                      >
                        切换到此渠道
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={disabled}
                        onPress={() => setEditing({ channelId: entry.id, draft: entry.defaultModel ?? "", thenSelect: false })}
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
