import type { Config, CurrentProviderSnapshot, Profile } from "./App.types";
import { modelIdsEqual } from "./modelIds";

export function routeProviderId(profile: Profile) {
  return profile.sourceProviderId || profile.id;
}

export function normalizeProviderBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function modelListKey(
  profile: Profile,
  snapshot?: CurrentProviderSnapshot | null,
) {
  if (
    snapshot?.ownershipKey
    && routeProviderId(profile) === snapshot.id
    && normalizeProviderBaseUrl(profile.baseUrl || "") === snapshot.baseUrl
  ) {
    return snapshot.ownershipKey;
  }
  return routeProviderId(profile);
}

function encodeRouteComponent(value: string) {
  const bytes = new TextEncoder().encode(value.trim());
  return Array.from(bytes, (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9._-]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export function routeModelAlias(profile: Profile, model: string) {
  return providerModelAlias(routeProviderId(profile), model);
}

export function providerModelAlias(providerId: string, model: string) {
  const normalized = model.trim();
  return `${encodeRouteComponent(providerId)}/${normalized}`;
}

export function globalDefaultForProvider(
  config: Config,
  providerId: string,
  models: string[],
) {
  return models.find((model) =>
    modelIdsEqual(providerModelAlias(providerId, model), config.defaultModel),
  ) || models[0] || "";
}

export function globalDefaultForRoute(
  config: Config,
  profile: Profile,
  models: string[],
) {
  return globalDefaultForProvider(config, routeProviderId(profile), models);
}
