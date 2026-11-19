import type { Config, CurrentProviderSnapshot } from "./App.types";
import { modelIdsEqual } from "./modelIds";

export function stripRouteAlias(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

// 与后端 `CodeyConfig::default_model` 一致：手动选中的渠道就是当前 provider 时，以渠道默认模型为准。
export function effectiveDefaultModel(config: Config, snapshot: CurrentProviderSnapshot | null) {
  const channelId = config.selectedChannelId;
  const channelDefault = channelId && snapshot?.channelId === channelId
    ? config.defaultModelsByChannel?.[channelId]?.trim()
    : "";
  return channelDefault || config.defaultModel;
}

export function globalDefaultForProvider(
  config: Config,
  models: string[],
  snapshot: CurrentProviderSnapshot | null = null,
) {
  const defaultModel = effectiveDefaultModel(config, snapshot);
  const requested = stripRouteAlias(defaultModel);
  return (
    models.find(
      (model) =>
        modelIdsEqual(model, requested) ||
        modelIdsEqual(model, defaultModel),
    ) ||
    models[0] ||
    ""
  );
}
