import { useState, type ReactNode } from "react";
import { moveModelId, orderModelIds } from "../modelIds";
import { Button } from "./ui";
import { ModelOrderItem } from "./ModelOrderItem";

export function ModelOrderEditor({ models, officialOrder, sourceOrder, mode, disabled, readOnly, onSave, children }: {
  models: string[];
  officialOrder: string[];
  sourceOrder: string[];
  mode?: "official" | "manual";
  disabled: boolean;
  readOnly?: boolean;
  onSave: (models: string[], mode: "official" | "manual") => Promise<boolean>;
  children: (model: string) => ReactNode;
}) {
  const [draft, setDraft] = useState<{ models: string[]; mode: "official" | "manual" } | null>(null);
  if (readOnly) return <div className="provider-model-tags">{models.map(children)}</div>;
  const current = draft ?? { models, mode: mode ?? "official" };
  return <div aria-label="调整模型顺序">
    <div className="flex items-center justify-between gap-2 px-3 pt-2">
    <p className="text-xs">{current.mode === "official" ? "跟随官方排序" : "手动排序"}，拖动模型调整顺序。</p>
    {!officialOrder.length && <p className="text-xs">官方排序暂不可用，保留当前顺序。</p>}
    <Button variant="ghost" size="xs" disabled={disabled || !officialOrder.length}
      onPress={() => setDraft({ models: orderModelIds(orderModelIds(current.models, sourceOrder), officialOrder, true), mode: "official" })}>恢复官方排序</Button>
    </div>
    <div className="provider-model-tags">
    {current.models.map((model) => <ModelOrderItem model={model} models={current.models}
      disabled={disabled} key={model}
      onMove={(item, target) => setDraft({ models: moveModelId(current.models, item, target), mode: "manual" })}>
      {children(model)}
    </ModelOrderItem>)}
    </div>
    <div className="flex justify-end gap-2 px-3 pb-2">
      <Button variant="outline" size="sm" disabled={disabled || !draft} onPress={() => setDraft(null)}>取消排序</Button>
      <Button size="sm" disabled={disabled || !draft} onPress={async () => {
        if (await onSave(current.models, current.mode)) setDraft(null);
      }}>保存顺序</Button>
    </div>
  </div>;
}
