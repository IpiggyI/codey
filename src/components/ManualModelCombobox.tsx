import { useCallback, useId, useMemo } from "react";
import { ComboBox, Input, InputGroup, ListBox } from "@heroui/react";
import { UNSAFE_PortalProvider } from "react-aria";
import { IconCirclePlus, IconRobot, IconX } from "@tabler/icons-react";

export type ManualModelComboboxProps = {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  // 传入后，无候选时不挂载下拉层，改为在输入框下方显示该提示；不传则保持空下拉层里的原有提示。
  emptyHint?: string;
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
  autoFocus,
  disabled = false,
  emptyHint,
  getPopupContainer,
  id,
  onChange,
  options,
  placeholder = "例如 gpt-4o-mini 或 deepseek-chat",
  value,
  zIndex,
}: ManualModelComboboxProps) {
  // 选择加入后，没有候选时不挂载下拉层，避免弹出空白列表；改为在输入框下方提示，仍可直接输入。
  const showPopup = options.length > 0 || emptyHint === undefined;
  const hintId = useId();
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
      // 只在有候选时传 items：传入空数组也会让组件允许打开空的下拉层。
      items={showPopup ? data : undefined}
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
          aria-describedby={[ariaDescribedBy, showPopup ? undefined : hintId].filter(Boolean).join(" ") || undefined}
          autoComplete="off"
          autoFocus={autoFocus}
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
        {/* 输入组依赖触发按钮才会渲染，所以无候选时保留它但隐藏。 */}
        <ComboBox.Trigger className={showPopup ? undefined : "hidden"} />
      </ComboBox.InputGroup>
      {showPopup ? (
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
      ) : null}
    </ComboBox>
  );
  // 提示放在组合框外：放进去会被复制进组合框的隐藏收集树，产生重复的 id。
  const field = showPopup ? combobox : (
    <div className="w-full min-w-0">
      {combobox}
      <p id={hintId} className="m-0 mt-1 text-xs text-[#8e8e93]">
        {emptyHint}
      </p>
    </div>
  );

  return portalTarget
    ? <UNSAFE_PortalProvider getContainer={getContainer}>{field}</UNSAFE_PortalProvider>
    : field;
}
