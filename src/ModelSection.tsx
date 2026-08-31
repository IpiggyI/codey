import { memo, useMemo, useState } from "react";
import {
  IconCheck as Check,
  IconCpu,
  IconRefresh as RefreshCw,
  IconServer as Server,
  IconShieldCheck,
} from "@tabler/icons-react";

import type { Config, CurrentProviderSnapshot, ModelState, Profile } from "./App.types";
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
  Switch,
} from "./components/mantine";
import { modelIdsEqual, modelKey, uniqueModelIds } from "./modelIds";
import {
  globalDefaultForProvider,
  globalDefaultForRoute,
  modelListKey,
  routeProviderId,
} from "./modelRoutes";
import { SETTINGS_OVERLAY_Z_INDEX } from "./overlay.constants";
import { flushCardClass } from "./uiClasses";

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
  onFetchRouteModels: (route?: Profile) => void;
  onToggleAccountUsage?: (checked: boolean) => void;
  onSaveOfficialRouteSettings?: (
    routeId: string,
    models: string[],
    showAccountUsageInHeader: boolean,
  ) => Promise<boolean>;
  onSetDefaultModel: (routeId: string, model: string) => void;
};

type RouteModelGroup = {
  profile: Profile | null;
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
}: ModelSectionProps) {
  const [officialEditorProfile, setOfficialEditorProfile] = useState<Profile | null>(
    null,
  );
  const [officialModelDraft, setOfficialModelDraft] = useState<string[]>([]);

  const visibleProfiles = useMemo(
    () =>
      config.profiles.filter((profile) => {
        const available =
          profile.authMode !== "officialAccount" || officialAccountAvailable;
        return (
          available &&
          currentProviderSnapshot != null &&
          Boolean(currentProviderSnapshot.ownershipKey) &&
          modelListKey(profile, currentProviderSnapshot) === currentProviderSnapshot.ownershipKey
        );
      }),
    [config.profiles, currentProviderSnapshot, officialAccountAvailable],
  );
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
    const fromProfiles = visibleProfiles.map((profile) => {
      const providerId = routeProviderId(profile);
      const official = profile.authMode === "officialAccount";
      const listKey = modelListKey(profile, currentProviderSnapshot);
      const configuredModels = config.selectedModelsByProvider[listKey] || [];
      const models = official
        ? configuredModels.length > 0
          ? configuredModels
          : officialCatalog
        : uniqueModelIds([
            ...configuredModels,
            ...(config.declaredOfficialModelsByProvider[listKey] || []),
          ]);
      return {
        profile,
        providerId,
        models,
        defaultModel: globalDefaultForRoute(config, profile, models),
        official,
      };
    });
    if (fromProfiles.length > 0 || !currentProviderSnapshot?.ownershipKey) {
      return fromProfiles;
    }
    if (currentProviderSnapshot.usesOfficialAccountAuth) {
      return fromProfiles;
    }
    const listKey = currentProviderSnapshot.ownershipKey;
    const configuredModels = config.selectedModelsByProvider[listKey] || [];
    const models = uniqueModelIds([
      ...configuredModels,
      ...(config.declaredOfficialModelsByProvider[listKey] || []),
    ]);
    return [
      {
        profile: null,
        providerId: currentProviderSnapshot.id,
        models,
        defaultModel: globalDefaultForProvider(
          config,
          currentProviderSnapshot.id,
          models,
        ),
        official: false,
      },
    ];
  }, [config, currentProviderSnapshot, officialCatalog, visibleProfiles]);

  const totalModelCount = useMemo(
    () => modelGroups.reduce((count, group) => count + group.models.length, 0),
    [modelGroups],
  );

  const openOfficialModelDialog = (profile: Profile) => {
    if (profile.authMode !== "officialAccount") return;
    const listKey = modelListKey(profile, currentProviderSnapshot);
    const configuredModels = config.selectedModelsByProvider[listKey] || [];
    setOfficialEditorProfile({ ...profile });
    setOfficialModelDraft(
      configuredModels.length > 0 ? configuredModels : officialCatalog,
    );
  };

  const saveOfficialModels = async () => {
    if (!officialEditorProfile) return;
    const saved = onSaveOfficialRouteSettings
      ? await onSaveOfficialRouteSettings(
          officialEditorProfile.id,
          officialModelDraft,
          showAccountUsageInHeader,
        )
      : true;
    if (saved) {
      setOfficialEditorProfile(null);
    }
  };

  const catalogTitle = currentProviderSnapshot?.id || "当前 provider";

  const syncOrConfigureGroup = (group: RouteModelGroup) => {
    if (group.official) {
      if (group.profile) openOfficialModelDialog(group.profile);
      return;
    }
    onFetchRouteModels(group.profile ?? undefined);
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
              aria-label="在账户区域显示额度"
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
                              busy === "fetch-route-models" &&
                              (group.profile == null ||
                                group.profile.id === config.activeProfileId)
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
                              onClick={() =>
                                onSetDefaultModel(group.profile?.id || "", model)
                              }
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
        open={officialEditorProfile !== null}
        onOpenChange={(open) => {
          if (!isBusy && !open) {
            setOfficialEditorProfile(null);
          }
        }}
      >
        {officialEditorProfile && (
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
                  <strong>{officialEditorProfile.name}</strong>
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
                onClick={() => setOfficialEditorProfile(null)}
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
