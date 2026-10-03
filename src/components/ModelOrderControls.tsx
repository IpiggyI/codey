import { Button } from "./ui";

export function ModelOrderControls({ model, index, count, disabled, onMove }: {
  model: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (model: string, direction: -1 | 1) => void;
}) {
  return <span className="flex shrink-0 gap-1">
    <Button variant="ghost" size="xs" aria-label={`上移 ${model}`}
      disabled={disabled || index <= 0} onPress={() => onMove(model, -1)}>上移</Button>
    <Button variant="ghost" size="xs" aria-label={`下移 ${model}`}
      disabled={disabled || index >= count - 1} onPress={() => onMove(model, 1)}>下移</Button>
  </span>;
}
