import { useCallback, useMemo } from "react";
import { ComboBox, Input, InputGroup, ListBox } from "@heroui/react";
import { UNSAFE_PortalProvider } from "react-aria";
import { IconCirclePlus, IconRobot, IconX } from "@tabler/icons-react";

export type ManualModelComboboxProps = {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  getPopupContainer?: () => HTMLElement;
  id?: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  value: string;
  zIndex?: number;
};

type ManualOption = {
  custom?: boolean;
  id: string;
  label: string;
  textValue: string;
};

export function ManualModelCombobox({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel = "模型",
  disabled = false,
  getPopupContainer,
  id,
  onChange,
  options,
  placeholder = "例如 gpt-4o-mini 或 deepseek-chat",
  value,
  zIndex,
}: ManualModelComboboxProps) {
  const data = useMemo<ManualOption[]>(() => {
    const trimmed = value.trim();
    const query = trimmed.toLocaleLowerCase();
    const matched = options.filter((option) => option.toLocaleLowerCase().includes(query));
    const suggestions = (matched.length ? matched : options).map((option) => ({
      id: option,
      label: option,
      textValue: option,
    }));
    const hasExactMatch = options.some((option) => option.toLocaleLowerCase() === query);
    return trimmed && !hasExactMatch
      ? [{ id: trimmed, custom: true, label: trimmed, textValue: trimmed }, ...suggestions]
      : suggestions;
  }, [options, value]);
  const portalTarget = getPopupContainer?.();
  const getContainer = useCallback(
    () => getPopupContainer?.() ?? null,
    [getPopupContainer],
  );

  const combobox = (
    <ComboBox
      aria-label={ariaLabel}
      allowsCustomValue
      fullWidth
      className="w-full min-w-0"
      items={data}
      inputValue={value}
      isDisabled={disabled}
      isInvalid={ariaInvalid}
      menuTrigger="focus"
      onInputChange={onChange}
      onSelectionChange={(key) => {
        if (key != null) onChange(String(key));
      }}
    >
      <ComboBox.InputGroup>
        <InputGroup.Prefix className="px-2">
          <IconRobot size={15} aria-hidden="true" className="text-[#7d7d83]" />
        </InputGroup.Prefix>
        <Input
          id={id}
          placeholder={placeholder}
          aria-describedby={ariaDescribedBy}
          autoComplete="off"
          spellCheck={false}
          className="min-h-8 md:min-h-8"
        />
        {value && !disabled ? (
          <InputGroup.Suffix className="px-1">
            <button
              aria-label="清空模型"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#8e8e93] transition-colors hover:bg-black/5 hover:text-[#1d1d1f]"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange("");
              }}
              type="button"
            >
              <IconX size={13} aria-hidden="true" />
            </button>
          </InputGroup.Suffix>
        ) : null}
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover
        className="w-(--trigger-width) max-w-[calc(100vw-32px)]"
        style={zIndex == null ? undefined : { zIndex }}
      >
        <ListBox
          aria-label={ariaLabel}
          className="max-h-[260px] overflow-y-auto"
          renderEmptyState={() => (
            <div className="py-4 text-center text-xs text-[#8e8e93]">
              暂无模型列表，可输入自定义模型或点击「获取列表」
            </div>
          )}
        >
          {(option: ManualOption) => (
            <ListBox.Item id={option.id} textValue={option.textValue} className="mx-0.5 rounded-[7px] px-2.5 py-1.5 text-xs">
              {option.custom ? (
                <div className="flex min-w-0 items-center gap-1.5 truncate">
                  <IconCirclePlus aria-hidden="true" className="shrink-0 text-blue-500" size={14} />
                  <span className="shrink-0 text-[#6e6e73]">使用自定义模型</span>
                  <span className="truncate font-semibold text-[#1d1d1f]">{option.label}</span>
                </div>
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium text-[#1d1d1f]">{option.label}</span>
              )}
            </ListBox.Item>
          )}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );

  return portalTarget
    ? <UNSAFE_PortalProvider getContainer={getContainer}>{combobox}</UNSAFE_PortalProvider>
    : combobox;
}
