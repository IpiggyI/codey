import type { Config, CurrentProviderSnapshot } from "./App.types";
import { modelIdsEqual } from "./modelIds";

export function modelListKey(snapshot: CurrentProviderSnapshot) {
  return snapshot.ownershipKey;
}

export function stripRouteAlias(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function globalDefaultForProvider(config: Config, models: string[]) {
  const requested = stripRouteAlias(config.defaultModel);
  return (
    models.find(
      (model) =>
        modelIdsEqual(model, requested) ||
        modelIdsEqual(model, config.defaultModel),
    ) ||
    models[0] ||
    ""
  );
}
