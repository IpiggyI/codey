import type { Config, CurrentProviderSnapshot, ModelState, Profile } from "./App.types";
import { modelKey, uniqueModelIds } from "./modelIds";
import {
  modelListKey,
  providerModelAlias,
  routeModelAlias,
  routeProviderId,
} from "./modelRoutes";
import { routeDisplayPrefix } from "./routeShortNames";

const THIRD_PARTY_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const THIRD_PARTY_REASONING_EFFORT_ALLOWLIST = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function thirdPartyReasoningEfforts(efforts?: readonly string[]) {
  const supported = (efforts || []).filter((effort) =>
    THIRD_PARTY_REASONING_EFFORT_ALLOWLIST.includes(effort)
  );
  return supported.length > 0 ? supported : THIRD_PARTY_REASONING_EFFORTS;
}

function metadataForModel<T>(metadata: ReadonlyMap<string, T>, modelId: string) {
  const exact = metadata.get(modelKey(modelId));
  if (exact) return exact;
  const separator = modelId.indexOf("/");
  return separator >= 0
    ? metadata.get(modelKey(modelId.slice(separator + 1)))
    : undefined;
}

export type SubagentModelOption = {
  value: string;
  label: string;
  modelId: string;
  routeId: string;
  providerId: string;
  routeName: string;
  routePrefix: string;
  official: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
};

function enabledModelsForRoute(
  config: Config,
  modelState: ModelState,
  profile: Profile,
) {
  const providerId = routeProviderId(profile);
  const configuredModels = config.selectedModelsByProvider[providerId] || [];
  if (profile.authMode !== "officialAccount") {
    return uniqueModelIds([
      ...configuredModels,
      ...(config.declaredOfficialModelsByProvider[providerId] || []),
    ]);
  }

  const fallbackModels = uniqueModelIds([
    ...modelState.officialModelIds,
    ...modelState.officialModels.map((model) => model.slug),
  ]);
  return uniqueModelIds(configuredModels.length > 0 ? configuredModels : fallbackModels);
}

export function buildSubagentModelOptions(
  config: Config | null,
  modelState: ModelState,
  officialAccountAvailable: boolean,
) {
  if (!config) return [];

  const officialMetadata = new Map(
    modelState.officialModels.map((model) => [modelKey(model.slug), model]),
  );
  const thirdPartyMetadata = new Map(
    (modelState.thirdPartyModelMetadata || []).map((model) => [
      modelKey(model.slug),
      model,
    ]),
  );
  const seenAliases = new Set<string>();
  const options: SubagentModelOption[] = [];

  for (const profile of config.profiles) {
    if (profile.enabled === false) continue;
    const official = profile.authMode === "officialAccount";
    if (official && !officialAccountAvailable) continue;

    const providerId = routeProviderId(profile);
    for (const modelId of enabledModelsForRoute(config, modelState, profile)) {
      const value = routeModelAlias(profile, modelId);
      const valueKey = modelKey(value);
      if (seenAliases.has(valueKey)) continue;
      seenAliases.add(valueKey);

      const officialModelMetadata = metadataForModel(officialMetadata, modelId);
      const thirdPartyModelMetadata = metadataForModel(thirdPartyMetadata, modelId);
      const usesOfficialMetadata = official;
      const efforts = usesOfficialMetadata && officialModelMetadata
        ? officialModelMetadata.supportedReasoningEfforts
        : thirdPartyReasoningEfforts(
          thirdPartyModelMetadata?.supportedReasoningEfforts ??
            officialModelMetadata?.supportedReasoningEfforts,
        );
      const supportedReasoningEfforts = efforts.length > 0 ? efforts : ["low"];
      const requestedDefaultEffort =
        usesOfficialMetadata && officialModelMetadata
          ? officialModelMetadata.defaultReasoningEffort || supportedReasoningEfforts[0]
          : thirdPartyModelMetadata?.defaultReasoningEffort || "low";
      options.push({
        value,
        label: usesOfficialMetadata && officialModelMetadata
          ? officialModelMetadata.displayName
          : modelId,
        modelId,
        routeId: profile.id,
        providerId,
        routeName: profile.name.trim() || providerId,
        routePrefix: routeDisplayPrefix(profile),
        official,
        supportedReasoningEfforts,
        defaultReasoningEffort:
          supportedReasoningEfforts.includes(requestedDefaultEffort)
            ? requestedDefaultEffort
            : supportedReasoningEfforts[0],
      });
    }
  }

  return options;
}

function optionForModel(
  modelId: string,
  official: boolean,
  officialMetadata: ReadonlyMap<string, ModelState["officialModels"][number]>,
  thirdPartyMetadata: ReadonlyMap<string, NonNullable<ModelState["thirdPartyModelMetadata"]>[number]>,
  identity: {
    value: string;
    routeId: string;
    providerId: string;
    routeName: string;
    routePrefix: string;
  },
): SubagentModelOption {
  const officialModelMetadata = metadataForModel(officialMetadata, modelId);
  const thirdPartyModelMetadata = metadataForModel(thirdPartyMetadata, modelId);
  const usesOfficialMetadata = official;
  const efforts = usesOfficialMetadata && officialModelMetadata
    ? officialModelMetadata.supportedReasoningEfforts
    : thirdPartyReasoningEfforts(
      thirdPartyModelMetadata?.supportedReasoningEfforts ??
        officialModelMetadata?.supportedReasoningEfforts,
    );
  const supportedReasoningEfforts = efforts.length > 0 ? efforts : ["low"];
  const requestedDefaultEffort =
    usesOfficialMetadata && officialModelMetadata
      ? officialModelMetadata.defaultReasoningEffort || supportedReasoningEfforts[0]
      : thirdPartyModelMetadata?.defaultReasoningEffort || "low";
  return {
    value: identity.value,
    label: usesOfficialMetadata && officialModelMetadata
      ? officialModelMetadata.displayName
      : modelId,
    modelId,
    routeId: identity.routeId,
    providerId: identity.providerId,
    routeName: identity.routeName,
    routePrefix: identity.routePrefix,
    official,
    supportedReasoningEfforts,
    defaultReasoningEffort:
      supportedReasoningEfforts.includes(requestedDefaultEffort)
        ? requestedDefaultEffort
        : supportedReasoningEfforts[0],
  };
}

export function buildCurrentProviderSubagentModelOptions(
  config: Config | null,
  modelState: ModelState,
  officialAccountAvailable: boolean,
  snapshot: CurrentProviderSnapshot | null,
) {
  if (!config || !snapshot?.ownershipKey) return [];
  if (snapshot.usesOfficialAccountAuth && !officialAccountAvailable) return [];

  const profile = config.profiles.find(
    (candidate) => modelListKey(candidate, snapshot) === snapshot.ownershipKey,
  );
  const official = profile
    ? profile.authMode === "officialAccount"
    : snapshot.usesOfficialAccountAuth;
  if (official && !profile) return [];

  const listKey = snapshot.ownershipKey;
  const configuredModels = config.selectedModelsByProvider[listKey] || [];
  const officialCatalog = uniqueModelIds([
    ...modelState.officialModelIds,
    ...modelState.officialModels.map((model) => model.slug),
  ]);
  const modelIds = official
    ? configuredModels.length > 0
      ? configuredModels
      : officialCatalog
    : uniqueModelIds([
      ...configuredModels,
      ...(config.declaredOfficialModelsByProvider[listKey] || []),
    ]);

  const officialMetadata = new Map(
    modelState.officialModels.map((model) => [modelKey(model.slug), model]),
  );
  const thirdPartyMetadata = new Map(
    (modelState.thirdPartyModelMetadata || []).map((model) => [
      modelKey(model.slug),
      model,
    ]),
  );
  const providerId = snapshot.id;
  const routeId = profile?.id || snapshot.id;
  const routeName = profile?.name.trim() || snapshot.id;
  return uniqueModelIds(modelIds).map((modelId) =>
    optionForModel(modelId, official, officialMetadata, thirdPartyMetadata, {
      value: modelId,
      routeId,
      providerId,
      routeName,
      routePrefix: "",
    }),
  );
}

export function resolveCurrentProviderModelOption(
  options: readonly SubagentModelOption[],
  requestedValue: string,
) {
  const requested = requestedValue.trim();
  if (!requested) return undefined;
  const requestedKey = modelKey(requested);
  const providerId = options[0]?.providerId;
  for (const option of options) {
    if (modelKey(option.value) === requestedKey) return option;
    if (modelKey(option.modelId) === requestedKey) return option;
    if (
      providerId &&
      modelKey(providerModelAlias(providerId, option.modelId)) === requestedKey
    ) {
      return option;
    }
  }
  return undefined;
}

export function resolveSubagentModelOption(
  options: readonly SubagentModelOption[],
  requestedValue: string,
  preferredProviderId?: string,
) {
  const requested = requestedValue.trim();
  if (!requested) return undefined;
  const requestedKey = modelKey(requested);

  let preferredRouteMatch: SubagentModelOption | undefined;
  let legacyMatch: SubagentModelOption | undefined;
  let legacyMatchIsUnique = true;
  for (const option of options) {
    if (modelKey(option.value) === requestedKey) return option;
    if (modelKey(option.modelId) !== requestedKey) continue;
    if (!preferredRouteMatch && option.providerId === preferredProviderId) {
      preferredRouteMatch = option;
    }
    if (legacyMatch) {
      legacyMatchIsUnique = false;
    } else {
      legacyMatch = option;
    }
  }
  return preferredRouteMatch || (legacyMatchIsUnique ? legacyMatch : undefined);
}
