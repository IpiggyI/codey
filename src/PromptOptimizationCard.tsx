import { memo, useEffect, useId, useRef, useState } from "react";

import {
  IconKey,
  IconPlugConnected,
  IconSparkles,
  IconWorld,
} from "@tabler/icons-react";

import type {
  Config,
  CurrentProviderSnapshot,
  InlineResult,
  Notice,
  PromptOptimizationConfig,
} from "./App.types";
import { invoke } from "./api";
import { errorText, withTimeout } from "./appUtils";
import { ManualModelCombobox } from "./components/ManualModelCombobox";
import { Card } from "@heroui/react";
import { Button, Input, PasswordInput, Select, Switch } from "./components/ui";
import { SETTINGS_OVERLAY_Z_INDEX } from "./overlay.constants";
import { surfaceCardPaddingClass } from "./uiClasses";
import { validateOutboundApiUrl } from "./urlValidation";

const TEST_TIMEOUT_MS = 65_000;
const FETCH_MODELS_TIMEOUT_MS = 20_000;
const DEFAULT_OPTIMIZER_INSTRUCTION =
  "你是提示词优化专家。用户会提供一段提示词，请在不改变其意图的前提下，把它重写为更清晰、更具体、可执行的高质量提示词。只输出优化后的提示词本身，不要添加任何解释、前言、后记或代码围栏。";

const MANUAL_PROTOCOL_OPTIONS = [
  { value: "openaiResponses", label: "OpenAI Responses" },
  { value: "openaiChatCompletions", label: "OpenAI Chat Completions" },
  { value: "anthropicMessages", label: "Anthropic Messages" },
] as const;

type PromptOptimizationMode = PromptOptimizationConfig["mode"];

type PromptOptimizationCardProps = {
  config: Config;
  currentProviderSnapshot: CurrentProviderSnapshot | null;
  officialAccountAvailable: boolean;
  isBusy: boolean;
  popupContainer: HTMLElement | null;
  onConfigChange: (config: Config) => void;
  onNotice: (notice: Notice) => void;
};

type TestResult = {
  httpStatus?: number;
  responsePreview?: string;
};

function protocolLabel(value: string) {
  return (
    MANUAL_PROTOCOL_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

function PromptOptimizationCardComponent({
  config,
  currentProviderSnapshot,
  officialAccountAvailable,
  isBusy,
  popupContainer,
  onConfigChange,
  onNotice,
}: PromptOptimizationCardProps) {
  const optimization = config.promptOptimization;
  const controlId = useId();
  const requestSequenceRef = useRef(0);
  const activeOperationRef = useRef<"models" | "test" | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsResult, setModelsResult] = useState<InlineResult>({
    tone: "idle",
    text: "",
  });

  const updateOptimization = (patch: Partial<Config["promptOptimization"]>) => {
    onConfigChange({
      ...config,
      promptOptimization: { ...optimization, ...patch },
    });
  };
  const apiKeyInputId = controlId + "-api-key";
  const baseUrlInputId = controlId + "-base-url";
  const modelInputId = controlId + "-model";
  const mode = optimization.mode;
  const usesOfficialAccount = mode === "officialAccount";
  const usesCurrentProvider = mode === "currentProvider";
  const usesManual = mode === "manual";
  const hasApiKey = Boolean(
    optimization.apiKey.trim() ||
      (optimization.apiKeyConfigured && !optimization.clearApiKey),
  );
  const baseUrlError =
    usesManual && (optimization.enabled || optimization.baseUrl.trim())
      ? validateOutboundApiUrl(optimization.baseUrl, "API 地址")
      : "";
  const apiKeyError =
    usesManual && optimization.enabled && !hasApiKey ? "请输入 API Key" : "";
  const modelError =
    optimization.enabled && !optimization.model.trim()
      ? "请选择或填写模型"
      : "";
  const credentialsReady = optimization.credentialsReady === true;
  const connectionDraftValid = usesManual
    ? !baseUrlError && !apiKeyError
    : credentialsReady;
  const testDraftValid = connectionDraftValid && !modelError;
  const keyStatus = optimization.currentProviderKeyStatus;
  const canFillManually =
    usesCurrentProvider &&
    (keyStatus === "missing" ||
      keyStatus === "undeclared" ||
      keyStatus === "unsupported");

  useEffect(() => {
    setApiKeyVisible(false);
  }, [config.settingsRevision]);

  const clearModelSuggestions = () => {
    setCloudModels([]);
    setModelsResult({ tone: "idle", text: "" });
  };

  const changeMode = (next: PromptOptimizationMode) => {
    if (optimization.mode === next) return;
    clearModelSuggestions();
    onNotice({ tone: "info", text: "" });
    updateOptimization({ mode: next });
  };

  const fillManualFromCurrentProvider = () => {
    const protocol = optimization.currentProviderUpstreamProtocol;
    clearModelSuggestions();
    onNotice({ tone: "info", text: "" });
    updateOptimization({
      mode: "manual",
      baseUrl: currentProviderSnapshot?.baseUrl ?? optimization.baseUrl,
      upstreamProtocol:
        protocol === "openaiResponses" ||
        protocol === "openaiChatCompletions" ||
        protocol === "anthropicMessages"
          ? protocol
          : optimization.upstreamProtocol,
    });
  };

  const showTestNotice = (tone: "success" | "error", text: string) => {
    onNotice({ tone, text });
  };

  const handleApiKeyChange = (value: string) => {
    if (value === "") {
      updateOptimization({
        apiKey: "",
        clearApiKey: false,
      });
      return;
    }
    updateOptimization({
      apiKey: value,
      clearApiKey: false,
    });
  };

  const runFetchModels = async () => {
    if (!connectionDraftValid || activeOperationRef.current) return;
    activeOperationRef.current = "models";
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setFetchingModels(true);
    setModelsResult({
      tone: "pending",
      text: "正在获取模型列表…",
    });
    try {
      const result = await withTimeout(
        invoke<{ models?: string[] }>("fetch_prompt_optimization_models", {
          config: optimization,
        }),
        FETCH_MODELS_TIMEOUT_MS,
        "获取模型列表超时，请检查 API 地址与网络",
      );
      if (requestSequenceRef.current !== requestId) return;
      const models = result?.models ?? [];
      setCloudModels(models);
      setModelsResult(
        models.length > 0
          ? { tone: "success", text: "已获取 " + models.length + " 个模型" }
          : { tone: "error", text: "服务端没有返回可用模型" },
      );
    } catch (error) {
      if (requestSequenceRef.current === requestId) {
        setModelsResult({ tone: "error", text: errorText(error) });
      }
    } finally {
      if (requestSequenceRef.current === requestId) {
        activeOperationRef.current = null;
        setFetchingModels(false);
      }
    }
  };

  const runTest = async () => {
    if (activeOperationRef.current || !testDraftValid) return;
    activeOperationRef.current = "test";
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setTesting(true);
    onNotice({ tone: "info", text: "" });
    try {
      const result = await withTimeout(
        invoke<{ result?: TestResult }>("test_prompt_optimization", {
          config: optimization,
        }),
        TEST_TIMEOUT_MS,
        "测试超时，请检查 API 地址与网络",
      );
      if (requestSequenceRef.current !== requestId) return;
      const httpStatus = result?.result?.httpStatus;
      const responsePreview = result?.result?.responsePreview?.trim();
      if (typeof httpStatus === "number" && httpStatus >= 400) {
        showTestNotice(
          "error",
          responsePreview
            ? "连接失败（HTTP " + httpStatus + "）：" + responsePreview
            : "连接失败（HTTP " + httpStatus + "）",
        );
        return;
      }
      showTestNotice(
        "success",
        responsePreview
          ? "连通性正常。响应预览：" + responsePreview
          : "连通性正常。",
      );
    } catch (error) {
      if (requestSequenceRef.current === requestId) {
        showTestNotice("error", errorText(error));
      }
    } finally {
      if (requestSequenceRef.current === requestId) {
        activeOperationRef.current = null;
        setTesting(false);
      }
    }
  };

  const testButtonLabel = testing
    ? "测试中…"
    : usesOfficialAccount
      ? "测试官方账号连通性"
      : usesCurrentProvider
        ? "测试当前 provider 连通性"
        : "测试 API 连通性";

  const instructionEditor = (
    <div className="field prompt-optimization-instruction-field">
      <div className="field-label-wrap">
        <label htmlFor={controlId + "-instruction"} className="field-label">优化指令</label>
        {optimization.instruction && optimization.instruction !== DEFAULT_OPTIMIZER_INSTRUCTION ? (
          <button
            type="button"
            className="reset-instruction-btn"
            onClick={() => updateOptimization({ instruction: DEFAULT_OPTIMIZER_INSTRUCTION })}
          >
            恢复默认
          </button>
        ) : null}
      </div>
      <div className="field-control">
        <textarea
          id={controlId + "-instruction"}
          className="prompt-optimization-instruction"
          value={optimization.instruction || DEFAULT_OPTIMIZER_INSTRUCTION}
          disabled={isBusy}
          onChange={(event) =>
            updateOptimization({ instruction: event.target.value })
          }
          placeholder="自定义优化指令…"
          spellCheck={false}
        />
      </div>
    </div>
  );

  const modelPicker = (
    <div className="field prompt-optimization-model-field">
      <label htmlFor={modelInputId} className="field-label">模型</label>
      <div className="field-control">
        <div className="flex min-w-0 items-center gap-2 max-[680px]:flex-col max-[680px]:items-stretch">
          <div className="relative min-w-0 flex-1 max-[680px]:w-full">
            <ManualModelCombobox
              id={modelInputId}
              value={optimization.model}
              disabled={isBusy || fetchingModels}
              ariaLabel="提示词优化模型"
              ariaInvalid={Boolean(modelError)}
              ariaDescribedBy={modelError ? modelInputId + "-error" : undefined}
              options={cloudModels}
              placeholder="例如 gpt-4o-mini 或 deepseek-chat"
              getPopupContainer={() => popupContainer ?? document.body}
              zIndex={SETTINGS_OVERLAY_Z_INDEX}
              onChange={(model) => updateOptimization({ model })}
            />
          </div>
          <Button
            className="h-[38px]! min-w-[76px] shrink-0 max-[680px]:w-full!"
            variant="light"
            size="xs"
            disabled={
              isBusy ||
              fetchingModels ||
              testing ||
              !connectionDraftValid
            }
            onPress={() => void runFetchModels()}
          >
            {fetchingModels ? "获取中…" : "获取列表"}
          </Button>
        </div>
        {modelsResult.text ? (
          <span className={"inline-result " + modelsResult.tone}>
            {modelsResult.text}
          </span>
        ) : null}
        {modelError ? (
          <small id={modelInputId + "-error"} className="field-error" role="alert">
            {modelError}
          </small>
        ) : null}
      </div>
    </div>
  );

  return (
    <section
      className="secondary-section prompt-optimization-section"
      aria-labelledby="prompt-optimization-title"
    >
      <div className="section-title compact">
        <div className="section-heading">
          <span className="section-icon" aria-hidden="true">
            <IconSparkles size={15} />
          </span>
          <div>
            <h2 id="prompt-optimization-title">提示词优化</h2>
            <p>把 Codex 输入框里的内容重写得更清楚、更好执行。可沿用当前 provider、复用官方账号登录，或手工填写连接信息。</p>
          </div>
        </div>
        <Switch
          checked={optimization.enabled}
          disabled={isBusy}
          aria-label="启用提示词优化"
          onCheckedChange={(checked) =>
            updateOptimization({ enabled: checked })
          }
        />
      </div>
      <Card className={"secondary-card prompt-optimization-card " + surfaceCardPaddingClass}>
        {optimization.enabled ? (
          <div className="prompt-optimization-content">
            <div className="prompt-optimization-toolbar">
              <div className="prompt-optimization-mode-tabs" role="tablist" aria-label="提示词优化配置方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={usesOfficialAccount}
                  className={
                    "prompt-optimization-mode-tab" +
                    (usesOfficialAccount ? " active" : "")
                  }
                  disabled={isBusy}
                  onClick={() => changeMode("officialAccount")}
                >
                  官方账号
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={usesCurrentProvider}
                  className={
                    "prompt-optimization-mode-tab" +
                    (usesCurrentProvider ? " active" : "")
                  }
                  disabled={isBusy}
                  onClick={() => changeMode("currentProvider")}
                >
                  沿用当前 provider
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={usesManual}
                  className={
                    "prompt-optimization-mode-tab" +
                    (usesManual ? " active" : "")
                  }
                  disabled={isBusy}
                  onClick={() => changeMode("manual")}
                >
                  手动配置
                </button>
              </div>

              <div className="prompt-optimization-toolbar-actions">
                <Button
                  variant="light"
                  size="xs"
                  className="prompt-test-btn"
                  disabled={isBusy || testing || fetchingModels || !testDraftValid}
                  onPress={() => void runTest()}
                >
                  <IconPlugConnected size={13} aria-hidden="true" />
                  <span>{testButtonLabel}</span>
                </Button>
              </div>
            </div>

            <div className="prompt-optimization-form-fields">
              {usesOfficialAccount ? (
                <div className="prompt-form-group">
                  <p className="field-hint">
                    {officialAccountAvailable || credentialsReady
                      ? "使用本机 ChatGPT 登录态，不另外保存密钥。"
                      : "官方账号登录不可用。请先完成 ChatGPT 登录；提示词优化不会改用环境变量或其他已保存密钥。"}
                  </p>
                  {modelPicker}
                  {instructionEditor}
                </div>
              ) : usesCurrentProvider ? (
                <div className="prompt-form-group">
                  <dl className="current-provider-snapshot-fields">
                    <div>
                      <dt>当前 provider</dt>
                      <dd title={currentProviderSnapshot?.id || ""}>
                        {currentProviderSnapshot?.id || "（未能读取）"}
                      </dd>
                    </div>
                    <div>
                      <dt>API 地址</dt>
                      <dd title={currentProviderSnapshot?.baseUrl || ""}>
                        {currentProviderSnapshot?.baseUrl || "（默认）"}
                      </dd>
                    </div>
                    <div>
                      <dt>接口格式</dt>
                      <dd>
                        {optimization.currentProviderUpstreamProtocol
                          ? protocolLabel(optimization.currentProviderUpstreamProtocol)
                          : currentProviderSnapshot?.wireApi || "（未知）"}
                      </dd>
                    </div>
                  </dl>
                  <p
                    className={
                      keyStatus === "ready" || keyStatus === "notApplicable"
                        ? "field-hint"
                        : "field-error"
                    }
                    role={
                      keyStatus === "ready" || keyStatus === "notApplicable"
                        ? undefined
                        : "alert"
                    }
                  >
                    {optimization.currentProviderKeyMessage ||
                      (currentProviderSnapshot
                        ? "正在读取当前 provider 的密钥状态。"
                        : "未能读取当前 provider。")}
                  </p>
                  {canFillManually ? (
                    <Button
                      variant="light"
                      size="xs"
                      disabled={isBusy}
                      onPress={fillManualFromCurrentProvider}
                    >
                      改为手工填写
                    </Button>
                  ) : null}
                  {modelPicker}
                  {instructionEditor}
                </div>
              ) : (
                <div className="prompt-form-group">
                  <div className="field prompt-optimization-protocol-field">
                    <label htmlFor={controlId + "-protocol"} className="field-label">上游协议</label>
                    <div className="field-control">
                      <Select
                        id={controlId + "-protocol"}
                        className="w-full min-w-0"
                        value={optimization.upstreamProtocol}
                        disabled={isBusy}
                        aria-label="提示词优化上游协议"
                        optionList={[...MANUAL_PROTOCOL_OPTIONS]}
                        filter={false}
                        onChange={(value) => {
                          clearModelSuggestions();
                          updateOptimization({
                            upstreamProtocol: String(value ?? "openaiResponses") as Config["promptOptimization"]["upstreamProtocol"],
                          });
                        }}
                      />
                    </div>
                  </div>

                  <div className="field prompt-optimization-address-field">
                    <label htmlFor={baseUrlInputId} className="field-label">API 地址</label>
                    <div className="field-control">
                      <Input
                        id={baseUrlInputId}
                        leftSection={<IconWorld size={15} aria-hidden="true" />}
                        value={optimization.baseUrl}
                        disabled={isBusy}
                        aria-invalid={Boolean(baseUrlError)}
                        aria-describedby={baseUrlError ? baseUrlInputId + "-error" : undefined}
                        onChange={(event) => {
                          clearModelSuggestions();
                          updateOptimization({ baseUrl: event.target.value });
                        }}
                        placeholder="https://api.openai.com/v1"
                        spellCheck={false}
                      />
                      {baseUrlError ? (
                        <small id={baseUrlInputId + "-error"} className="field-error" role="alert">
                          {baseUrlError}
                        </small>
                      ) : null}
                    </div>
                  </div>

                  <div className="field prompt-optimization-key-field">
                    <label htmlFor={apiKeyInputId} className="field-label">API Key</label>
                    <div className="field-control">
                      <PasswordInput
                        id={apiKeyInputId}
                        className="w-full"
                        leftSection={<IconKey size={15} aria-hidden="true" />}
                        visibility={apiKeyVisible}
                        onVisibilityChange={() => setApiKeyVisible((visible) => !visible)}
                        value={optimization.apiKey}
                        disabled={isBusy}
                        aria-invalid={Boolean(apiKeyError)}
                        aria-describedby={apiKeyError ? apiKeyInputId + "-error" : undefined}
                        onChange={(event) => {
                          clearModelSuggestions();
                          handleApiKeyChange(event.target.value);
                        }}
                        placeholder={
                          optimization.apiKeyConfigured &&
                          optimization.apiKey.trim() === ""
                            ? "已保存（输入新 Key 可替换）"
                            : "sk-…"
                        }
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      {apiKeyError ? (
                        <small id={apiKeyInputId + "-error"} className="field-error" role="alert">
                          {apiKeyError}
                        </small>
                      ) : optimization.apiKeyConfigured &&
                        !optimization.clearApiKey &&
                        !optimization.apiKey.trim() ? (
                        <small className="field-hint">
                          Key 已保存，不会再次显示；输入新 Key 可替换。
                        </small>
                      ) : null}
                    </div>
                  </div>

                  {modelPicker}
                  {instructionEditor}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="feature-disabled-placeholder">
            <div className="feature-disabled-icon">
              <IconSparkles size={22} aria-hidden="true" />
            </div>
            <div className="feature-disabled-text">
              <strong>提示词优化已关闭</strong>
              <p>开启后，在 Codex 输入框旁可通过快捷按钮一键将自然语言重写为高质量提示词。</p>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

export const PromptOptimizationCard = memo(PromptOptimizationCardComponent);
