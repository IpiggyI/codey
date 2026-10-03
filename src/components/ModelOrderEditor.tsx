import { useState, type ReactNode } from "react";
import { moveModelId, orderModelIds } from "../modelIds";
import { Button } from "./ui";
import { ModelOrderControls } from "./ModelOrderControls";

export function ModelOrderEditor({ models, officialOrder, sourceOrder, mode, disabled, readOnly, onSave, children }: {
  models: string[];
  officialOrder: string[];
  sourceOrder: string[];
  mode?: "official" | "manual";
  disabled: boolean;
  readOnly?: boolean;
  onSave: (models: string[], mode: "official" | "manual") => Promise<boolean>;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<{ models: string[]; mode: "official" | "manual" } | null>(null);
  if (readOnly) return children;
  if (!draft) return <>
    <Button variant="ghost" size="xs" disabled={disabled || !models.length}
      onPress={() => setDraft({ models: [...models], mode: mode ?? "manual" })}>调整顺序</Button>
    {children}
  </>;
  return <div className="grid gap-2 px-3 py-2" aria-label="调整模型顺序">
    <p className="text-xs">{draft.mode === "official" ? "跟随官方排序" : "手动排序"}，保存后更新模型选择器。</p>
    {!officialOrder.length && <p className="text-xs">官方排序暂不可用，保留当前顺序。</p>}
    <Button variant="ghost" size="xs" disabled={disabled || !officialOrder.length}
      onPress={() => setDraft({ models: orderModelIds(orderModelIds(draft.models, sourceOrder), officialOrder, true), mode: "official" })}>恢复官方排序</Button>
    {draft.models.map((model, index) => <div className="flex items-center justify-between gap-2" key={model}>
      <span className="min-w-0 break-all text-xs">{model}</span>
      <ModelOrderControls model={model} index={index} count={draft.models.length} disabled={disabled}
        onMove={(item, direction) => setDraft({ models: moveModelId(draft.models, item, direction), mode: "manual" })} />
    </div>)}
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" disabled={disabled} onPress={() => setDraft(null)}>取消排序</Button>
      <Button size="sm" disabled={disabled} onPress={async () => {
        if (await onSave(draft.models, draft.mode)) setDraft(null);
      }}>保存顺序</Button>
    </div>
  </div>;
}
