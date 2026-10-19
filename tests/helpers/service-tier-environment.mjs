export function legacyServiceTierEnvironment() {
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

export function serviceTierEnvironment() {
  const model = { model: "supported", isDefault: true, defaultServiceTier: "priority",
    serviceTiers: [{ id: "priority", name: "Fast" }] };
  const state = { authMethod: null, config: { model: model.model, service_tier: "default" },
    selection: { type: "fromConfig" }, models: [model, { model: "unsupported", serviceTiers: [] }],
    modelSettings: { model: model.model, isLoading: false }, requirementsPending: false,
    settingsLoading: false, modelReads: 0 };
  const scope = { get: () => state.selection, set() {}, watch() {}, when() {}, query: { setData() {} } };
  const errors = [], caches = new Map();
  // Like React's memo cache, each component keeps its slots across renders.
  const memo = (component) => ({ c: (length) => {
    if (!caches.has(component)) caches.set(component, Array(length).fill(Symbol.for("react.memo_cache_sentinel")));
    return caches.get(component);
  } });
  return {
    state, scope, errors, lar: "selection", U: "scope", gk: "host", pvo: "context",
    nC: "requirements", IJ: "pendingTier", Yar: "conversation", QSo: "conversationTier", ZSo: "conversationLoading",
    Nxo: memo("access"), ywo: memo("selection"), bwo: { use() {} },
    q: () => "local", hi: () => scope, hmi: () => ({ hostId: "local" }),
    Eu: (key) => key === "requirements" ? { data: null, isPending: state.requirementsPending } : null,
    OT: () => ({ authMethod: state.authMethod }),
    wvo: () => ({ data: { models: state.models }, isLoading: false }),
    pwo: () => ({ serviceTier: state.config.service_tier, isLoading: false, activeProfileForWrite: null }),
    mwo: () => async () => {},
    gir: (selectedModel) => [{ value: null }, ...(selectedModel?.serviceTiers ?? []).map((tier) => ({ value: tier.id }))],
    v$s: async () => state.authMethod,
    kSn: async () => ({ requirements: { featureRequirements: { fast_mode: false } } }),
    k_o: async () => ({ config: state.config }), Eb: (config) => config,
    Vh: () => ({ sendRequest: async (method) => {
      if (method !== "model/list") throw Error(`Unexpected request: ${method}`);
      state.modelReads++;
      await Promise.resolve();
      return { data: state.models };
    } }),
    fn: { error: (message) => errors.push(message) },
  };
}
