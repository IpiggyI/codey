import type { Config, CurrentProviderSnapshot, ModelState } from "./App.types";
import { modelKey, uniqueModelIds } from "./modelIds";
import { stripRouteAlias } from "./modelRoutes";

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
  return metadata.get(modelKey(stripRouteAlias(modelId)));
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
  const official = snapshot.usesOfficialAccountAuth;
  if (official && !officialAccountAvailable) return [];

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
  return uniqueModelIds(modelIds).map((modelId) =>
    optionForModel(modelId, official, officialMetadata, thirdPartyMetadata, {
      value: modelId,
      routeId: providerId,
      providerId,
      routeName: providerId,
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
  const requestedBareKey = modelKey(stripRouteAlias(requested));
  for (const option of options) {
    if (modelKey(option.value) === requestedKey) return option;
    if (modelKey(option.modelId) === requestedKey) return option;
    if (modelKey(option.modelId) === requestedBareKey) return option;
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
  const requestedBareKey = modelKey(stripRouteAlias(requested));

  let preferredRouteMatch: SubagentModelOption | undefined;
  let legacyMatch: SubagentModelOption | undefined;
  let legacyMatchIsUnique = true;
  for (const option of options) {
    if (modelKey(option.value) === requestedKey) return option;
    if (
      modelKey(option.modelId) !== requestedKey &&
      modelKey(option.modelId) !== requestedBareKey
    ) {
      continue;
    }
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
