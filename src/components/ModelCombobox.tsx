import { useCallback, useMemo, useState } from "react";
import {
  Collection,
  ComboBox,
  Header,
  Input,
  InputGroup,
  ListBox,
  ListLayout,
  Virtualizer,
  useFilter,
} from "@heroui/react";
import type { Key } from "@heroui/react";
import { UNSAFE_PortalProvider } from "react-aria";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";

import type { SubagentModelOption } from "../subagentModels";
import {
  resolveCurrentProviderModelOption,
  resolveSubagentModelOption,
} from "../subagentModels";
import {
  MODEL_GROUP_HEIGHT,
  MODEL_LIST_HEIGHT,
  MODEL_OPTION_HEIGHT,
} from "../modelComboboxWindow";

type ModelOption = {
  id: string;
  label: string;
  modelId: string;
  routeName: string;
  textValue: string;
};
type ModelGroup = {
  id: string;
  label: string;
  providerId: string;
  options: ModelOption[];
};

type ModelComboboxProps = {
  "aria-label": string;
  disabled?: boolean;
  getPopupContainer?: () => HTMLElement;
  onChange: (value: string) => void;
  options: SubagentModelOption[];
  placeholder?: string;
  preferredProviderId?: string;
  showLaneIdentity?: boolean;
  value: string;
  zIndex?: number;
};

function normalizedSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function ModelCombobox({
  "aria-label": ariaLabel,
  disabled = false,
  getPopupContainer,
  onChange,
  options,
  placeholder = "请选择模型",
  preferredProviderId,
  showLaneIdentity = true,
  value,
  zIndex,
}: ModelComboboxProps) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedOption = useMemo(
    () =>
      showLaneIdentity
        ? resolveSubagentModelOption(options, value, preferredProviderId)
        : resolveCurrentProviderModelOption(options, value),
    [options, preferredProviderId, showLaneIdentity, value],
  );
  const validValues = useMemo(
    () => new Set(options.map((option) => option.value)),
    [options],
  );
  const trimmedValue = value.trim();
  const unavailableValue = selectedOption ? "" : trimmedValue;
  const displayText = selectedOption
    ? showLaneIdentity
      ? `[${selectedOption.routePrefix}] ${selectedOption.label}`
      : selectedOption.label
    : unavailableValue
      ? `${unavailableValue} · ${showLaneIdentity ? "已不可用" : "待重选"}`
      : "";

  const groups = useMemo<ModelGroup[]>(() => {
    const result = new Map<string, SubagentModelOption[]>();
    for (const option of options) {
      const group = result.get(option.routeId);
      if (group) group.push(option);
      else result.set(option.routeId, [option]);
    }
    const list = Array.from(result.entries()).map(([id, group]) => ({
      id,
      label: group[0].routeName,
      providerId: group[0].providerId,
      options: group.map((option) => ({
        id: option.value,
        label: option.label,
        modelId: option.modelId,
        routeName: option.routeName,
        textValue: (
          showLaneIdentity
            ? [
                option.label,
                option.modelId,
                option.routeName,
                option.routePrefix,
                option.providerId,
              ]
            : [option.label, option.modelId]
        )
          .map(normalizedSearchText)
          .join("\u0000"),
      })),
    }));
    if (unavailableValue) {
      list.unshift({
        id: "__unavailable__",
        label: "不可用模型",
        providerId: "",
        options: [
          {
            id: unavailableValue,
            label: `${unavailableValue} · ${showLaneIdentity ? "已不可用" : "待重选"}`,
            modelId: unavailableValue,
            routeName: "",
            textValue: normalizedSearchText(unavailableValue),
          },
        ],
      });
    }
    return list;
  }, [options, showLaneIdentity, unavailableValue]);

  const selectedKey: Key | null = selectedOption?.value ?? (unavailableValue || null);
  const emptyText = options.length === 0
    ? "还没有可用于子代理的模型"
    : "没有匹配的模型";
  const portalTarget = getPopupContainer?.();
  const getContainer = useCallback(
    () => getPopupContainer?.() ?? null,
    [getPopupContainer],
  );

  const combobox = (
    <ComboBox
      aria-label={ariaLabel}
      fullWidth
      className="w-full min-w-0"
      defaultFilter={(textValue, inputValue) => contains(textValue, inputValue.trim())}
      inputValue={open ? search : displayText}
      isDisabled={disabled}
      isInvalid={Boolean(unavailableValue)}
      menuTrigger="focus"
      selectedKey={selectedKey}
      onInputChange={(nextValue) => {
        if (open) setSearch(nextValue);
      }}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setSearch("");
      }}
      onSelectionChange={(key) => {
        if (key == null) return;
        const nextValue = String(key);
        if (!validValues.has(nextValue)) return;
        onChange(nextValue);
      }}
    >
      <ComboBox.InputGroup>
        {unavailableValue ? (
          <InputGroup.Prefix className="px-2">
            <IconAlertTriangle size={14} className="shrink-0 text-warning" aria-hidden="true" />
          </InputGroup.Prefix>
        ) : null}
        <Input
          placeholder={open ? "搜索模型" : placeholder}
          autoComplete="off"
          spellCheck={false}
          className="min-h-8 md:min-h-8"
        />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover
        className="w-(--trigger-width) max-w-[calc(100vw-24px)] overflow-hidden p-0"
        style={zIndex == null ? undefined : { zIndex }}
      >
        <Virtualizer
          layout={ListLayout}
          layoutOptions={{
            rowHeight: MODEL_OPTION_HEIGHT,
            headingSize: MODEL_GROUP_HEIGHT,
          }}
        >
          <ListBox
            aria-label={ariaLabel}
            items={groups}
            className="overflow-y-auto"
            style={{ maxHeight: MODEL_LIST_HEIGHT }}
            renderEmptyState={() => (
              <div className="px-3 py-6 text-xs text-[#8e8e93]">{emptyText}</div>
            )}
          >
            {(group) => (
              <ListBox.Section id={group.id}>
                <Header className="flex min-w-0 items-center justify-between gap-2 px-3 py-1 text-[10px] font-semibold text-[#8e8e93]">
                  <span className="truncate">{group.label}</span>
                  {group.providerId ? (
                    <span className="shrink-0 font-mono font-normal text-[#aeaeb2]">
                      {group.providerId}
                    </span>
                  ) : null}
                </Header>
                <Collection items={group.options}>
                  {(option) => {
                    const selected = selectedOption?.value === option.id;
                    return (
                      <ListBox.Item
                        id={option.id}
                        textValue={option.textValue}
                        className="mx-1 rounded-[7px] px-2.5 py-2 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="grid min-w-0 flex-1 gap-0.5">
                            <span className="truncate font-semibold text-[#3a3a3c]">
                              {option.label}
                            </span>
                            {option.routeName ? (
                              <span className="truncate text-[10px] text-[#8e8e93]">
                                {option.routeName} · {option.modelId}
                              </span>
                            ) : null}
                          </span>
                          <span className="grid w-4 shrink-0 place-items-center text-blue-600">
                            {selected ? <IconCheck size={14} aria-hidden="true" /> : null}
                          </span>
                        </span>
                      </ListBox.Item>
                    );
                  }}
                </Collection>
              </ListBox.Section>
            )}
          </ListBox>
        </Virtualizer>
      </ComboBox.Popover>
    </ComboBox>
  );

  return portalTarget
    ? <UNSAFE_PortalProvider getContainer={getContainer}>{combobox}</UNSAFE_PortalProvider>
    : combobox;
}
