import { useRef, useState, type ReactNode } from "react";

const MODEL_DRAG_TYPE = "application/x-codey-model";

export function ModelOrderItem({ model, models, disabled, onMove, children, className = "" }: {
  model: string;
  models: string[];
  disabled: boolean;
  onMove: (model: string, target: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  const dragged = useRef(false);
  return <div className={`model-order-item ${className}`} data-model={model} data-drag-over={over || undefined}
    role="group" aria-label={`拖动排序 ${model}`} tabIndex={disabled ? -1 : 0} draggable={!disabled}
    onPointerDownCapture={() => { dragged.current = false; }}
    onClickCapture={(event) => {
      if (dragged.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}
    onDragStart={(event) => {
      dragged.current = true;
      event.dataTransfer.setData(MODEL_DRAG_TYPE, model);
      event.dataTransfer.effectAllowed = "move";
    }}
    onKeyDown={(event) => {
      if (disabled || event.target !== event.currentTarget || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const target = models[models.indexOf(model) + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) onMove(model, target);
    }}
    onDragOver={(event) => {
      if (disabled || !event.dataTransfer.types.includes(MODEL_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    }}
    onDrop={(event) => {
      setOver(false);
      if (disabled) return;
      const source = event.dataTransfer.getData(MODEL_DRAG_TYPE);
      if (!models.includes(source) || source === model) return;
      event.preventDefault();
      onMove(source, model);
    }}>
    {children}
  </div>;
}
