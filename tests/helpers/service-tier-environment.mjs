export function serviceTierEnvironment() {
  const model = { model: "supported", isDefault: true, defaultServiceTier: "priority",
    serviceTiers: [{ id: "priority", name: "Fast" }] };
  const state = { authMethod: null, config: { model: model.model, service_tier: "default" },
    selection: { type: "fromConfig" }, models: [model, { model: "unsupported", serviceTiers: [] }],
    modelSettings: { model: model.model, isLoading: false }, requirementsPending: false,
    settingsLoading: false, modelReads: 0 };
  const scope = { get: () => state.selection, set() {}, watch() {}, when() {}, query: { setData() {} } };
  const errors = [];
  return {
    state, scope, errors, Cjt: "default", Sjt: "ultrafast",
    k: "selection", X: "scope", ZU: "context", YU: "pendingTier",
    JXe: "conversation", Ohi: "conversationTier", xp: "requirements",
    Ehi: { c: (length) => Array(length) }, Dhi: { use() {} },
    Jfi: { c: (length) => Array(length) }, J: () => "local", jc: "host",
    vf: () => scope, WO: () => ({ hostId: "local" }),
    Zh: (key) => key === "requirements" ? { data: null, isPending: state.requirementsPending } : null,
    Jli: () => ({ data: { models: state.models }, isLoading: false }),
    be: () => ({ authMethod: state.authMethod }),
    bhi: () => ({ serviceTier: state.config.service_tier, isLoading: false }), xhi: () => async () => {},
    ffi: (models, id) => models.find((candidate) => candidate.model === id),
    SBe: (tier) => tier, HJe: (tier) => tier,
    TKe: (selectedModel) => [null, ...selectedModel.serviceTiers],
    aia: async () => state.authMethod,
    AYe: async () => ({ requirements: { featureRequirements: { fast_mode: false } } }),
    SUe: (selection) => selection.value,
    gsi: async () => ({ config: state.config }), Wd: (config) => config,
    fp: () => ({ sendRequest: async (method) => {
      if (method !== "model/list") throw Error(`Unexpected request: ${method}`);
      state.modelReads++;
      await Promise.resolve();
      return { data: state.models };
    } }),
    Dp: { error: (message) => errors.push(message) },
  };
}
