import { memo, useMemo, useState } from "react";
import {
  IconCheck as Check,
  IconCpu,
  IconRefresh as RefreshCw,
  IconServer as Server,
  IconShieldCheck,
} from "@tabler/icons-react";

import type {
  Config,
  CurrentProviderSnapshot,
  ModelContextConfig,
  ModelState,
  RouterSessionDiagnosis,
} from "./App.types";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from "./components/mantine";
import { modelIdsEqual, modelKey, uniqueModelIds } from "./modelIds";
import { globalDefaultForProvider } from "./modelRoutes";
import { SETTINGS_OVERLAY_Z_INDEX } from "./overlay.constants";
import { flushCardClass } from "./uiClasses";

export function ModelContextFields({ model, policy, disabled, onChange }: {
  model: string;
  policy?: ModelContextConfig;
  disabled: boolean;
  onChange: (policy: ModelContextConfig | undefined) => void;
}) {
  return <details className="w-full text-xs">
    <summary className="cursor-pointer">上下文预算{policy ? ` · ${policy.contextWindowTokens} Token` : " · 默认"}</summary>
    <p className="my-2 text-xs text-[#6e6e73]">自定义值优先于 1M；清空窗口恢复默认。未知模型默认使用 32768 Token 保守预算，不代表服务端容量。修改后重启 Codex 生效。</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {([
        ["contextWindowTokens", "窗口", 1024, "默认"],
        ["autoCompactTokenLimit", "压缩阈值", 1, "自动"],
        ["reserveOutputTokens", "输出预留", 1, "不单独预留"],
      ] as const).map(([field, label, min, placeholder]) => <label key={field}>
        <span>{label}（Token）</span>
        <Input type="number" min={min} max={10_000_000} step={1} disabled={disabled}
          aria-label={`${model} ${label} Token`} placeholder={placeholder} value={policy?.[field] ?? ""}
          onChange={(event) => {
            const raw = event.target.value;
            if (field === "contextWindowTokens" && raw === "") { onChange(undefined); return; }
            onChange({ contextWindowTokens: 32768, ...policy, [field]: raw === "" ? undefined : Number(raw) });
          }} />
      </label>)}
    </div>
    <p className="my-2 text-xs text-[#6e6e73]">阈值不能超过窗口的 90% 和预留后的有效空间；预留按整百分比向下取整，不是输出长度上限。</p>
  </details>;
}

type ModelSectionProps = {
  config: Config;
  currentProviderSnapshot: CurrentProviderSnapshot | null;
  officialAccountAvailable: boolean;
  popupContainer: HTMLElement | null;
  modelState: ModelState;
  dirty: boolean;
  isBusy: boolean;
  busy: string | null;
  showAccountUsageInHeader: boolean;
  onSyncCurrentProvider: () => void;
  onFetchRouteModels: () => void;
  onToggleAccountUsage?: (checked: boolean) => void;
  onSaveOfficialRouteSettings?: (
    models: string[],
    showAccountUsageInHeader: boolean,
  ) => Promise<boolean>;
  onSetDefaultModel: (model: string) => void;
  routerSessionDiagnosis: RouterSessionDiagnosis | null;
  onMigrateRouterSessions: (targetProvider: string) => void;
};

type RouteModelGroup = {
  providerId: string;
  models: string[];
  defaultModel: string;
  official: boolean;
};

function ModelSectionComponent({
  config,
  currentProviderSnapshot,
  officialAccountAvailable,
  popupContainer,
  modelState,
  dirty,
  isBusy,
  busy,
  showAccountUsageInHeader,
  onSyncCurrentProvider,
  onFetchRouteModels,
  onToggleAccountUsage,
  onSaveOfficialRouteSettings,
  onSetDefaultModel,
  routerSessionDiagnosis,
  onMigrateRouterSessions,
}: ModelSectionProps) {
  const [officialEditorOpen, setOfficialEditorOpen] = useState(false);
  const [officialModelDraft, setOfficialModelDraft] = useState<string[]>([]);
  const [migrateTargetProvider, setMigrateTargetProvider] = useState<string>("");
  const migrateTargets = routerSessionDiagnosis?.targetProviders ?? [];
  const selectedMigrateTarget = migrateTargets.includes(migrateTargetProvider)
    ? migrateTargetProvider
    : (migrateTargets[0] ?? "");

  const officialDisplayNames = useMemo(
    () =>
      new Map(
        modelState.officialModels.map((model) => [
          modelKey(model.slug),
          model.displayName,
        ]),
      ),
    [modelState.officialModels],
  );
  const officialCatalog = useMemo(
    () =>
      uniqueModelIds([
        ...modelState.officialModelIds,
        ...modelState.officialModels.map((model) => model.slug),
      ]),
    [modelState.officialModelIds, modelState.officialModels],
  );
  const officialModelDraftKeys = useMemo(
    () => new Set(officialModelDraft.map(modelKey)),
    [officialModelDraft],
  );
  const modelGroups = useMemo<RouteModelGroup[]>(() => {
    if (!currentProviderSnapshot?.ownershipKey) return [];
    const official = currentProviderSnapshot.usesOfficialAccountAuth;
    if (official && !officialAccountAvailable) return [];
    const listKey = currentProviderSnapshot.ownershipKey;
    const configuredModels = config.selectedModelsByProvider[listKey] || [];
    const models = official
      ? configuredModels.length > 0
        ? configuredModels
        : officialCatalog
      : uniqueModelIds([
          ...configuredModels,
          ...(config.declaredOfficialModelsByProvider[listKey] || []),
        ]);
    return [
      {
        providerId: currentProviderSnapshot.id,
        models,
        defaultModel: globalDefaultForProvider(config, models),
        official,
      },
    ];
  }, [
    config,
    currentProviderSnapshot,
    officialAccountAvailable,
    officialCatalog,
  ]);

  const totalModelCount = useMemo(
    () => modelGroups.reduce((count, group) => count + group.models.length, 0),
    [modelGroups],
  );

  const openOfficialModelDialog = () => {
    if (!currentProviderSnapshot?.usesOfficialAccountAuth) return;
    const listKey = currentProviderSnapshot.ownershipKey;
    const configuredModels = config.selectedModelsByProvider[listKey] || [];
    setOfficialModelDraft(
      configuredModels.length > 0 ? configuredModels : officialCatalog,
    );
    setOfficialEditorOpen(true);
  };

  const saveOfficialModels = async () => {
    if (!officialEditorOpen) return;
    const saved = onSaveOfficialRouteSettings
      ? await onSaveOfficialRouteSettings(
          officialModelDraft,
          showAccountUsageInHeader,
        )
      : true;
    if (saved) {
      setOfficialEditorOpen(false);
    }
  };

  const catalogTitle = currentProviderSnapshot?.id || "当前 provider";

  const syncOrConfigureGroup = (group: RouteModelGroup) => {
    if (group.official) {
      openOfficialModelDialog();
      return;
    }
    onFetchRouteModels();
  };

  return (
    <section className="route-section" aria-labelledby="provider-title">
      <div className="section-title">
        <div className="section-heading">
          <span className="section-icon" aria-hidden="true">
            <Server size={15} />
          </span>
          <div>
            <h2 id="provider-title">当前 provider 与模型</h2>
            <p>只读展示当前 Codex 配置中的 provider，并管理对应模型</p>
          </div>
        </div>
        <div className="route-heading-actions">
          <div className="route-item-usage-toggle">
            <span className="route-item-usage-label">额度显示</span>
            <Switch
              size="xs"
              checked={showAccountUsageInHeader}
              disabled={isBusy}
              onCheckedChange={(checked) => onToggleAccountUsage?.(checked)}
              aria-label="在输入栏显示账号额度"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={dirty || isBusy}
            onClick={onSyncCurrentProvider}
          >
            <RefreshCw
              className={busy === "sync-provider" ? "animate-spin" : ""}
              aria-hidden="true"
            />
            重新读取 Codex 配置
          </Button>
        </div>
      </div>

      {currentProviderSnapshot ? (
        <aside
          className="current-provider-snapshot"
          aria-label="当前 Codex provider"
        >
          <div className="current-provider-snapshot-heading">
            <strong>当前 Codex provider</strong>
            <small>只读来自你的 Codex 配置，Codey 不会改写它</small>
          </div>
          <dl className="current-provider-snapshot-fields">
            <div>
              <dt>标识</dt>
              <dd title={currentProviderSnapshot.id}>
                {currentProviderSnapshot.id}
              </dd>
            </div>
            <div>
              <dt>地址</dt>
              <dd title={currentProviderSnapshot.baseUrl || "（默认）"}>
                {currentProviderSnapshot.baseUrl || "（默认）"}
              </dd>
            </div>
            <div>
              <dt>接口格式</dt>
              <dd>{currentProviderSnapshot.wireApi}</dd>
            </div>
            <div>
              <dt>官方账号鉴权</dt>
              <dd>{currentProviderSnapshot.usesOfficialAccountAuth ? "是" : "否"}</dd>
            </div>
          </dl>
        </aside>
      ) : null}

      {routerSessionDiagnosis &&
      routerSessionDiagnosis.affectedSessionCount > 0 ? (
        <aside
          className="current-provider-snapshot router-session-migrate"
          aria-label="历史会话归属迁移"
        >
          <div className="current-provider-snapshot-heading">
            <strong>历史会话归属</strong>
            <small>
              有 {routerSessionDiagnosis.affectedSessionCount}{" "}
              个历史会话仍标记为内置路由。确认后会先备份，再改写到你指定的
              provider；进行中会暂时关闭并重新打开 Codex。
            </small>
          </div>
          <div className="router-session-migrate-actions">
            <div
              className="router-session-migrate-targets"
              aria-label="迁移目标 provider"
            >
              {migrateTargets.map((id) => (
                <label key={id} className="router-session-migrate-target">
                  <input
                    type="radio"
                    name="router-session-migrate-target"
                    value={id}
                    checked={selectedMigrateTarget === id}
                    disabled={isBusy}
                    onChange={() => setMigrateTargetProvider(id)}
                  />
                  <span>{id}</span>
                </label>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy || !selectedMigrateTarget}
              onClick={() => {
                if (selectedMigrateTarget) {
                  onMigrateRouterSessions(selectedMigrateTarget);
                }
              }}
            >
              迁移这些会话
            </Button>
          </div>
        </aside>
      ) : null}

      <Card className={`route-card ${flushCardClass}`}>
        <div className="route-manager route-manager-single">
          <div className="route-catalog-pane">
            <div className="catalog-aggregate-heading">
              <div className="catalog-aggregate-title-wrap">
                <div className="catalog-aggregate-title">
                  <strong>统一模型目录</strong>
                  <Badge variant="secondary" size="xs">
                    {totalModelCount} 个
                  </Badge>
                </div>
                <small>只显示与当前 provider 指纹对应的模型清单</small>
              </div>
            </div>

            <div id="provider-model-groups" className="provider-model-groups">
              {modelGroups.length === 0 ? (
                <div className="provider-model-empty">
                  <div className="provider-empty-content">
                    <IconCpu size={16} className="provider-empty-icon" aria-hidden="true" />
                    <span>当前 provider 还没有对应的模型清单</span>
                  </div>
                </div>
              ) : (
                modelGroups.map((group) => (
                  <section
                    className="provider-model-group"
                    key={group.providerId}
                    aria-labelledby={`provider-model-${group.providerId}`}
                  >
                    <div className="provider-model-group-heading">
                      <div className="provider-heading-main">
                        <div
                          className={`provider-avatar-pill ${group.official ? "official" : "custom"}`}
                          aria-hidden="true"
                        >
                          {group.official ? (
                            <IconShieldCheck size={14} />
                          ) : (
                            <Server size={14} />
                          )}
                        </div>
                        <div className="provider-heading-text">
                          <strong id={`provider-model-${group.providerId}`}>
                            {catalogTitle}
                          </strong>
                          <small>
                            {group.official ? "官方账号" : "第三方 API Key"}
                          </small>
                        </div>
                      </div>
                      <div className="provider-model-group-actions">
                        <Badge variant={group.official ? "info" : "brand"} size="xs">
                          {group.models.length} 模型
                        </Badge>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={isBusy || dirty}
                          onClick={() => syncOrConfigureGroup(group)}
                        >
                          <RefreshCw
                            size={12}
                            className={
                              busy === "fetch-route-models"
                                ? "animate-spin"
                                : ""
                            }
                            aria-hidden="true"
                          />
                          同步模型
                        </Button>
                      </div>
                    </div>

                    {group.models.length > 0 ? (
                      <div className="provider-model-tags">
                        {group.models.map((model) => {
                          const isDefault = modelIdsEqual(group.defaultModel, model);
                          const displayName = group.official
                            ? officialDisplayNames.get(modelKey(model)) || model
                            : model;
                          return (
                            <button
                              type="button"
                              key={`${group.providerId}:${model}`}
                              className={`model-tag-pill${isDefault ? " is-default" : ""}`}
                              disabled={isBusy || dirty || isDefault}
                              onClick={() => onSetDefaultModel(model)}
                              title={
                                isDefault
                                  ? `${displayName}（当前默认模型）`
                                  : `点击设为默认模型：${displayName}`
                              }
                              aria-label={
                                isDefault
                                  ? `${displayName}，当前默认模型`
                                  : `设 ${displayName} 为默认模型`
                              }
                            >
                              <span className="model-tag-indicator" aria-hidden="true">
                                {isDefault ? (
                                  <Check size={11} strokeWidth={2.5} />
                                ) : (
                                  <span className="model-tag-dot" />
                                )}
                              </span>
                              <span className="model-tag-name">{displayName}</span>
                              {isDefault && (
                                <span className="model-tag-badge">默认</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="provider-model-empty">
                        <div className="provider-empty-content">
                          <IconCpu size={16} className="provider-empty-icon" aria-hidden="true" />
                          <span>尚未配置模型</span>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy || dirty}
                          onClick={() => syncOrConfigureGroup(group)}
                        >
                          <RefreshCw size={12} aria-hidden="true" />
                          {group.official ? "配置官方模型" : "同步或手动添加"}
                        </Button>
                      </div>
                    )}
                  </section>
                ))
              )}
            </div>
          </div>
        </div>
      </Card>

      <Dialog
        open={officialEditorOpen}
        onOpenChange={(open) => {
          if (!isBusy && !open) {
            setOfficialEditorOpen(false);
          }
        }}
      >
        {officialEditorOpen && (
          <DialogContent
            className="route-editor-dialog"
            container={popupContainer ?? undefined}
            zIndex={SETTINGS_OVERLAY_Z_INDEX}
            onEscapeKeyDown={(event) => {
              if (isBusy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (isBusy) event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>配置官方账号模型</DialogTitle>
              <DialogDescription>
                选择允许在 Codex 中使用的官方候选模型。未勾选的模型不会在模型目录和选择器中出现。
              </DialogDescription>
            </DialogHeader>

            <div className="official-route-editor">
              <div className="official-route-summary">
                <span>
                  <strong>{currentProviderSnapshot?.id || "官方账号"}</strong>
                  <small>使用当前 Codex 官方账号登录状态</small>
                </span>
                <Badge variant="info">官方账号</Badge>
              </div>

              <div className="official-model-editor">
                <div className="official-model-editor-heading">
                  <span>
                    <strong>支持的模型</strong>
                    <small>已启用 {officialModelDraft.length} 个，至少保留一个。</small>
                  </span>
                  <Badge variant="secondary">
                    {officialModelDraft.length} / {officialCatalog.length}
                  </Badge>
                </div>
                <div className="official-model-options">
                  {officialCatalog.map((model) => {
                    const checked = officialModelDraftKeys.has(modelKey(model));
                    return (
                      <label className="official-model-option" key={model}>
                        <Checkbox
                          checked={checked}
                          disabled={isBusy || (checked && officialModelDraft.length <= 1)}
                          onCheckedChange={(nextChecked) => {
                            setOfficialModelDraft((current) =>
                              nextChecked === true
                                ? uniqueModelIds([...current, model])
                                : current.filter(
                                    (candidate) => !modelIdsEqual(candidate, model),
                                  ),
                            );
                          }}
                          aria-label={`${checked ? "停用" : "启用"}官方模型 ${model}`}
                        />
                        <span>
                          <strong>
                            {officialDisplayNames.get(modelKey(model)) || model}
                          </strong>
                          <small>{model}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <DialogFooter className="route-editor-footer">
              <Button
                variant="outline"
                disabled={isBusy}
                onClick={() => setOfficialEditorOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={isBusy || officialModelDraft.length === 0}
                onClick={() => void saveOfficialModels()}
              >
                <Check aria-hidden="true" />
                保存模型
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

export const ModelSection = memo(ModelSectionComponent);
