#[cfg(test)]
use std::collections::BTreeMap;
use std::path::Path;

use crate::config::{
    CodeyConfig, DEFAULT_SUBAGENT_MODEL, DEFAULT_SUBAGENT_REASONING_EFFORT, SUBAGENT_ROLE_DEFAULT,
    SUBAGENT_ROLE_IDS, SubagentRoleConfig, uniform_subagent_roles,
};
use crate::model_catalog;
use crate::model_id;
#[cfg(test)]
use crate::subagent::rules::{RoleAccess, RolePolicy};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SubagentCatalogSnapshot {
    pub provider_id: String,
    pub models: Vec<String>,
}

impl SubagentCatalogSnapshot {
    pub(crate) fn new(provider_id: impl Into<String>, models: Vec<String>) -> Self {
        Self {
            provider_id: provider_id.into(),
            models,
        }
    }

    #[cfg(test)]
    pub(crate) fn allowing_bound_models(
        provider_id: &str,
        roles: &BTreeMap<String, SubagentRoleConfig>,
    ) -> Self {
        Self::new(
            provider_id.to_string(),
            model_id::dedupe_preserving_first(roles.values().map(|role| role.model.as_str())),
        )
    }

    pub(crate) fn canonical_model<'a>(&'a self, requested: &str) -> Option<&'a str> {
        let requested = requested.trim();
        if requested.is_empty() {
            return None;
        }
        if let Some(model) = self
            .models
            .iter()
            .find(|model| model_id::equal(model, requested))
        {
            return Some(model.as_str());
        }
        let stripped = model_id::strip_route_alias(requested);
        if stripped == requested {
            return None;
        }
        self.models
            .iter()
            .find(|slug| model_id::equal(slug, stripped))
            .map(String::as_str)
    }
}

pub(crate) fn catalog_snapshot_for_config(config: &CodeyConfig) -> SubagentCatalogSnapshot {
    let snapshot = config.current_provider_snapshot.as_ref();
    let provider_id = snapshot
        .map(|snapshot| snapshot.id.as_str())
        .or_else(|| config.current_provider_id())
        .unwrap_or_default()
        .to_string();
    let official = snapshot
        .map(|snapshot| snapshot.uses_official_account_auth)
        .unwrap_or(false);
    if official && !config.official_account_available_this_launch {
        return SubagentCatalogSnapshot::new(provider_id, Vec::new());
    }
    let Some(list_key) = config.current_model_list_key() else {
        return SubagentCatalogSnapshot::new(provider_id, Vec::new());
    };
    let models = if official {
        config.enabled_official_route_models(list_key)
    } else {
        config.enabled_route_models(list_key)
    };
    SubagentCatalogSnapshot::new(provider_id, models)
}

#[cfg(test)]
pub(crate) fn role_policy(role: &str) -> Option<RolePolicy> {
    crate::subagent::rules::embedded().role_policy(role)
}

pub(crate) fn reconcile_for_current_provider(
    config: &mut CodeyConfig,
    codex_home: &Path,
    official_provider: bool,
) {
    prepare_subagent_roles(config);
    let list_key = config.current_model_list_key().map(str::to_string);
    let selected_models = list_key
        .as_deref()
        .map(|key| {
            if official_provider {
                config.enabled_official_route_models(key)
            } else {
                config.enabled_route_models(key)
            }
        })
        .unwrap_or_default();
    let upstream_models = list_key
        .as_deref()
        .and_then(|key| config.upstream_models_by_provider.get(key))
        .map(Vec::as_slice);
    let manual_models = list_key
        .as_deref()
        .and_then(|key| config.manual_third_party_models_by_provider.get(key))
        .map(Vec::as_slice)
        .unwrap_or_default();
    let state = model_catalog::selection_state_with_manual_models(
        codex_home,
        &crate::codex_config::codey_model_catalog_dir(),
        official_provider,
        upstream_models,
        &selected_models,
        manual_models,
        Some(&config.subagent_model),
    )
    .ok();
    reconcile_with_model_state(config, state.as_ref());
}

pub(crate) fn reconcile_with_model_state(
    config: &mut CodeyConfig,
    state: Option<&model_catalog::ModelSelectionState>,
) {
    prepare_subagent_roles(config);
    let catalog = catalog_snapshot_for_config(config);
    if let Some(state) = state {
        for selection in config.subagent_roles.values_mut() {
            let Some(canonical) = catalog.canonical_model(&selection.model) else {
                continue;
            };
            let canonical = canonical.to_string();
            selection.reasoning_effort =
                reasoning_effort_for_model(state, &canonical, &selection.reasoning_effort);
        }
    }
    sync_legacy_default(config);
}

fn prepare_subagent_roles(config: &mut CodeyConfig) {
    if config.subagent_model.trim().is_empty() {
        config.subagent_model = DEFAULT_SUBAGENT_MODEL.to_string();
    }
    if config.subagent_roles.is_empty() {
        config.subagent_roles =
            uniform_subagent_roles(&config.subagent_model, &config.subagent_reasoning_effort);
        return;
    }

    // The scalar fields are retained as the compatibility representation of
    // the fallback role. A caller that still mutates those fields directly
    // therefore continues to update `default` without resetting other roles.
    config.subagent_roles.insert(
        SUBAGENT_ROLE_DEFAULT.to_string(),
        SubagentRoleConfig::new(
            config.subagent_model.clone(),
            config.subagent_reasoning_effort.clone(),
        ),
    );
    let fallback = config
        .subagent_roles
        .get(SUBAGENT_ROLE_DEFAULT)
        .cloned()
        .expect("fallback subagent role was inserted");
    for role in SUBAGENT_ROLE_IDS {
        config
            .subagent_roles
            .entry(role.to_string())
            .or_insert_with(|| fallback.clone());
    }
}

fn sync_legacy_default(config: &mut CodeyConfig) {
    if let Some(selection) = config.subagent_roles.get(SUBAGENT_ROLE_DEFAULT) {
        config.subagent_model.clone_from(&selection.model);
        config
            .subagent_reasoning_effort
            .clone_from(&selection.reasoning_effort);
    }
}

pub(crate) fn reasoning_effort_for_model(
    state: &model_catalog::ModelSelectionState,
    model: &str,
    preferred_reasoning_effort: &str,
) -> String {
    let preferred_reasoning_effort = preferred_reasoning_effort.trim().to_ascii_lowercase();
    if let Some(official_model) = state
        .official_models
        .iter()
        .find(|candidate| candidate.supported && model_id::equal(&candidate.slug, model))
    {
        if official_model
            .supported_reasoning_efforts
            .iter()
            .any(|effort| effort.eq_ignore_ascii_case(&preferred_reasoning_effort))
        {
            return preferred_reasoning_effort;
        }
        if official_model
            .supported_reasoning_efforts
            .iter()
            .any(|effort| effort == DEFAULT_SUBAGENT_REASONING_EFFORT)
        {
            return DEFAULT_SUBAGENT_REASONING_EFFORT.to_string();
        }
        if !official_model.default_reasoning_effort.trim().is_empty() {
            return official_model.default_reasoning_effort.clone();
        }
    }
    if state
        .third_party_models
        .iter()
        .any(|candidate| model_id::equal(candidate, model))
        || state
            .third_party_model_metadata
            .iter()
            .any(|candidate| model_id::equal(&candidate.slug, model))
    {
        let metadata = state
            .third_party_model_metadata
            .iter()
            .find(|candidate| model_id::equal(&candidate.slug, model));
        let fallback_efforts = model_catalog::THIRD_PARTY_REASONING_EFFORTS.to_vec();
        let supported_reasoning_efforts = metadata
            .map(|metadata| {
                metadata
                    .supported_reasoning_efforts
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            })
            .unwrap_or(fallback_efforts);
        if supported_reasoning_efforts
            .iter()
            .any(|effort| effort.eq_ignore_ascii_case(&preferred_reasoning_effort))
        {
            return preferred_reasoning_effort;
        }
        if supported_reasoning_efforts.contains(&DEFAULT_SUBAGENT_REASONING_EFFORT) {
            return DEFAULT_SUBAGENT_REASONING_EFFORT.to_string();
        }
        if let Some(metadata) = metadata
            && !metadata.default_reasoning_effort.trim().is_empty()
        {
            return metadata.default_reasoning_effort.clone();
        }
    }
    DEFAULT_SUBAGENT_REASONING_EFFORT.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_policies_keep_access_and_visual_capabilities_explicit() {
        assert_eq!(
            role_policy(crate::config::SUBAGENT_ROLE_QUICK_SCAN),
            Some(RolePolicy {
                access: RoleAccess::ReadOnly,
                visual: false,
            })
        );
        assert_eq!(
            role_policy(crate::config::SUBAGENT_ROLE_WORKER),
            Some(RolePolicy {
                access: RoleAccess::Write,
                visual: false,
            })
        );
        assert_eq!(
            role_policy(crate::config::SUBAGENT_ROLE_VISUAL_WORKER),
            Some(RolePolicy {
                access: RoleAccess::Write,
                visual: true,
            })
        );
        assert_eq!(role_policy("unknown"), None);
    }

    fn model_state() -> model_catalog::ModelSelectionState {
        model_catalog::ModelSelectionState {
            official_models: ["gpt-5.6-luna", DEFAULT_SUBAGENT_MODEL]
                .into_iter()
                .map(|slug| model_catalog::OfficialModelAvailability {
                    slug: slug.to_string(),
                    display_name: slug.to_string(),
                    supported: true,
                    supported_reasoning_efforts: vec!["low".into(), "high".into()],
                    default_reasoning_effort: "low".into(),
                })
                .collect(),
            official_model_ids: vec!["gpt-5.6-luna".into(), DEFAULT_SUBAGENT_MODEL.into()],
            default_model: "gpt-5.6-luna".into(),
            ..model_catalog::ModelSelectionState::default()
        }
    }

    fn route_config(provider_id: &str) -> CodeyConfig {
        let mut config = CodeyConfig {
            subagent_optimization: true,
            subagent_model: "provider-old-model".into(),
            subagent_roles: uniform_subagent_roles(
                "provider-old-model",
                DEFAULT_SUBAGENT_REASONING_EFFORT,
            ),
            ..CodeyConfig::default()
        };
        config.attach_current_provider_snapshot(
            crate::model_ownership::CurrentProviderSnapshot::from_parts(
                provider_id,
                "https://example.test/v1",
                "responses",
                false,
            ),
        );
        config
    }

    fn list_key(config: &CodeyConfig) -> String {
        config
            .current_model_list_key()
            .expect("snapshot attached")
            .to_string()
    }

    #[test]
    fn provider_change_keeps_unavailable_bindings_and_does_not_rewrite_roles() {
        struct Case {
            upstream_models: &'static [&'static str],
            saved_effort: &'static str,
        }

        let cases = [
            Case {
                upstream_models: &[DEFAULT_SUBAGENT_MODEL],
                saved_effort: "xhigh",
            },
            Case {
                upstream_models: &["gpt-5.6-sol"],
                saved_effort: "ultra",
            },
            Case {
                upstream_models: &["gpt-5.4"],
                saved_effort: "ultra",
            },
            Case {
                upstream_models: &["provider-custom-model"],
                saved_effort: "high",
            },
        ];

        for case in cases {
            let home = tempfile::tempdir().unwrap();
            let mut config = route_config("route-b");
            config.subagent_reasoning_effort = case.saved_effort.into();
            config.subagent_roles = uniform_subagent_roles("provider-old-model", case.saved_effort);
            config.upstream_models_by_provider.insert(
                list_key(&config),
                case.upstream_models
                    .iter()
                    .map(|model| (*model).to_string())
                    .collect(),
            );
            config.selected_models_by_provider.insert(
                list_key(&config),
                case.upstream_models
                    .iter()
                    .map(|model| (*model).to_string())
                    .collect(),
            );

            reconcile_for_current_provider(&mut config, home.path(), false);

            assert_eq!(config.subagent_model, "provider-old-model");
            assert_eq!(config.subagent_reasoning_effort, case.saved_effort);
            assert!(
                config
                    .subagent_roles
                    .values()
                    .all(|selection| selection.model == "provider-old-model"),
                "silent substitution for {:?}",
                case.upstream_models
            );
        }
    }

    #[test]
    fn unavailable_binding_is_not_replaced_by_catalog_default_or_first_available() {
        let mut config = route_config("route-a");
        config.subagent_model = "gpt-5.6-luna".into();
        config.subagent_reasoning_effort = "high".into();
        config.subagent_roles = uniform_subagent_roles("gpt-5.6-luna", "high");
        let mut state = model_state();
        state
            .official_models
            .retain(|model| model.slug == DEFAULT_SUBAGENT_MODEL);
        state.default_model = DEFAULT_SUBAGENT_MODEL.into();

        reconcile_with_model_state(&mut config, Some(&state));

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "gpt-5.6-luna");
        assert_eq!(config.subagent_reasoning_effort, "high");
        assert!(
            config
                .subagent_roles
                .values()
                .all(|selection| selection.model == "gpt-5.6-luna")
        );
    }

    #[test]
    fn missing_model_state_preserves_optimization_and_selection() {
        let mut config = route_config("route-a");
        config.subagent_model = "gpt-5.6-luna".into();
        config.subagent_reasoning_effort = "high".into();

        reconcile_with_model_state(&mut config, None);

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "gpt-5.6-luna");
        assert_eq!(config.subagent_reasoning_effort, "high");
    }

    #[test]
    fn provider_change_does_not_adopt_a_selected_third_party_model() {
        let home = tempfile::tempdir().unwrap();
        let mut config = route_config("route-b");
        config.subagent_reasoning_effort = "high".into();
        config.subagent_roles = uniform_subagent_roles("provider-old-model", "high");
        config
            .selected_models_by_provider
            .insert(list_key(&config), vec!["provider-custom-model".into()]);
        config
            .upstream_models_by_provider
            .insert(list_key(&config), vec!["provider-custom-model".into()]);

        reconcile_for_current_provider(&mut config, home.path(), false);

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "provider-old-model");
        assert_eq!(config.subagent_reasoning_effort, "high");
    }

    #[test]
    fn provider_change_preserves_a_saved_compatible_subagent_model() {
        let home = tempfile::tempdir().unwrap();
        let mut config = route_config("route-b");
        config.subagent_model = "gpt-5.6-sol".into();
        config.subagent_reasoning_effort = "high".into();
        config.upstream_models_by_provider.insert(
            list_key(&config),
            vec![DEFAULT_SUBAGENT_MODEL.into(), "gpt-5.6-sol".into()],
        );

        reconcile_for_current_provider(&mut config, home.path(), false);

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "gpt-5.6-sol");
        assert_eq!(config.subagent_reasoning_effort, "high");
    }

    #[test]
    fn saved_bare_model_is_preserved_outside_the_current_catalog() {
        let mut config = route_config("route-a");
        config.subagent_optimization = true;
        config.subagent_model = "provider-special".into();
        config.subagent_reasoning_effort = "high".into();
        config.subagent_roles = uniform_subagent_roles("provider-special", "high");
        config = config.normalize();

        let mut state = model_state();
        state.third_party_models.push("provider-special".into());
        state
            .third_party_model_metadata
            .push(model_catalog::ThirdPartyModelAvailability {
                slug: "provider-special".into(),
                supported_reasoning_efforts: vec!["low".into()],
                default_reasoning_effort: "low".into(),
            });
        reconcile_with_model_state(&mut config, Some(&state));

        assert_eq!(config.subagent_model, "provider-special");
        assert!(
            config
                .subagent_roles
                .values()
                .all(|selection| selection.model == "provider-special")
        );
    }

    #[test]
    fn provider_switch_keeps_unavailable_binding_instead_of_falling_back() {
        let mut config = route_config("route-a");
        config.subagent_optimization = true;
        config.subagent_model = "gpt-5.6-luna".into();
        config.subagent_reasoning_effort = "high".into();
        config.subagent_roles = uniform_subagent_roles("gpt-5.6-luna", "high");
        config = config.normalize();

        let mut route_b_models = model_state();
        route_b_models
            .official_models
            .retain(|model| model.slug == DEFAULT_SUBAGENT_MODEL);
        route_b_models.default_model = DEFAULT_SUBAGENT_MODEL.into();
        reconcile_with_model_state(&mut config, Some(&route_b_models));
        assert_eq!(config.subagent_model, "gpt-5.6-luna");
        assert_eq!(config.subagent_reasoning_effort, "high");
    }

    #[test]
    fn unchanged_provider_only_reconciles_an_unavailable_model() {
        let available_home = tempfile::tempdir().unwrap();
        let mut available = route_config("route-a");
        available.subagent_model = "gpt-5.6-sol".into();
        available.subagent_reasoning_effort = "high".into();

        reconcile_for_current_provider(&mut available, available_home.path(), false);

        assert!(available.subagent_optimization);
        assert_eq!(available.subagent_model, "gpt-5.6-sol");
        assert_eq!(available.subagent_reasoning_effort, "high");

        let unavailable_home = tempfile::tempdir().unwrap();
        let mut unavailable = route_config("route-a");
        unavailable.subagent_model = DEFAULT_SUBAGENT_MODEL.into();
        unavailable.subagent_reasoning_effort = "high".into();
        unavailable
            .upstream_models_by_provider
            .insert(list_key(&unavailable), vec!["provider-custom-model".into()]);

        reconcile_for_current_provider(&mut unavailable, unavailable_home.path(), false);

        assert!(unavailable.subagent_optimization);
        assert_eq!(unavailable.subagent_model, DEFAULT_SUBAGENT_MODEL);
        assert_eq!(unavailable.subagent_reasoning_effort, "high");
    }

    #[test]
    fn api_route_models_use_route_reasoning_efforts_even_when_names_match_official_models() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("models_cache.json"),
            serde_json::to_vec(&serde_json::json!({
                "models": [{
                    "slug": "gpt-5.6-sol",
                    "display_name": "GPT-5.6-Sol",
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [
                        {"effort": "medium"},
                        {"effort": "high"}
                    ]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut config = route_config("route-a");
        config.subagent_model = "gpt-5.6-sol".into();
        config.subagent_reasoning_effort = "low".into();
        config
            .upstream_models_by_provider
            .insert(list_key(&config), vec!["gpt-5.6-sol".into()]);
        config
            .selected_models_by_provider
            .insert(list_key(&config), vec!["gpt-5.6-sol".into()]);

        reconcile_for_current_provider(&mut config, home.path(), false);

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "gpt-5.6-sol");
        assert_eq!(config.subagent_reasoning_effort, "low");
    }

    #[test]
    fn task_roles_keep_independent_models_and_reasoning_efforts() {
        let mut config = route_config("route-a").normalize();
        config.subagent_model = DEFAULT_SUBAGENT_MODEL.into();
        config.subagent_reasoning_effort = "low".into();
        config.subagent_roles.insert(
            crate::config::SUBAGENT_ROLE_QUICK_SCAN.into(),
            crate::config::SubagentRoleConfig::new("gpt-5.6-luna", "low"),
        );
        config.subagent_roles.insert(
            crate::config::SUBAGENT_ROLE_DEEP_RESEARCH.into(),
            crate::config::SubagentRoleConfig::new(DEFAULT_SUBAGENT_MODEL, "high"),
        );

        reconcile_with_model_state(&mut config, Some(&model_state()));

        assert_eq!(
            config.subagent_roles[crate::config::SUBAGENT_ROLE_QUICK_SCAN],
            crate::config::SubagentRoleConfig::new("gpt-5.6-luna", "low")
        );
        assert_eq!(
            config.subagent_roles[crate::config::SUBAGENT_ROLE_DEEP_RESEARCH],
            crate::config::SubagentRoleConfig::new(DEFAULT_SUBAGENT_MODEL, "high")
        );
        assert_eq!(config.subagent_model, DEFAULT_SUBAGENT_MODEL);
        assert_eq!(config.subagent_reasoning_effort, "low");
    }

    #[test]
    fn available_model_clamps_unsupported_effort_without_rewriting_the_binding() {
        let home = tempfile::tempdir().unwrap();
        let mut config = route_config("route-b");
        config.subagent_model = "gpt-5.4".into();
        config.subagent_reasoning_effort = "ultra".into();
        config
            .upstream_models_by_provider
            .insert(list_key(&config), vec!["gpt-5.4".into()]);
        config
            .selected_models_by_provider
            .insert(list_key(&config), vec!["gpt-5.4".into()]);

        reconcile_for_current_provider(&mut config, home.path(), false);

        assert_eq!(config.subagent_model, "gpt-5.4");
        assert_eq!(
            config.subagent_reasoning_effort,
            DEFAULT_SUBAGENT_REASONING_EFFORT
        );
    }

    #[test]
    fn current_provider_alias_is_available_foreign_alias_is_not() {
        let catalog = SubagentCatalogSnapshot::new(
            "route-a",
            vec!["gpt-5.6-terra".into(), "provider-special".into()],
        );

        assert_eq!(
            catalog.canonical_model("gpt-5.6-terra"),
            Some("gpt-5.6-terra")
        );
        assert_eq!(
            catalog.canonical_model("route-a/gpt-5.6-terra"),
            Some("gpt-5.6-terra")
        );
        assert_eq!(
            catalog.canonical_model("route-b/provider-special"),
            Some("provider-special")
        );
        assert_eq!(catalog.canonical_model("missing-model"), None);
    }

    #[test]
    fn official_unavailable_catalog_is_empty_even_when_selected_models_exist() {
        let mut config = route_config("openai");
        config.attach_current_provider_snapshot(
            crate::model_ownership::CurrentProviderSnapshot::from_parts(
                "openai",
                "https://chatgpt.com/backend-api/codex",
                "responses",
                true,
            ),
        );
        config.official_account_available_this_launch = false;
        config
            .selected_models_by_provider
            .insert(list_key(&config), vec!["gpt-5.4".into()]);

        let catalog = catalog_snapshot_for_config(&config);
        assert!(catalog.models.is_empty(), "{catalog:?}");

        config.official_account_available_this_launch = true;
        let catalog = catalog_snapshot_for_config(&config);
        assert_eq!(catalog.models, vec!["gpt-5.4".to_string()]);
    }

    #[test]
    fn default_compatibility_role_survives_unavailable_reconcile() {
        let mut config = route_config("route-a").normalize();
        config.subagent_model = "legacy-only-model".into();
        config.subagent_reasoning_effort = "high".into();
        config.subagent_roles.insert(
            crate::config::SUBAGENT_ROLE_DEFAULT.into(),
            crate::config::SubagentRoleConfig::new("legacy-only-model", "high"),
        );

        reconcile_with_model_state(&mut config, Some(&model_state()));

        assert!(config.subagent_roles.contains_key(SUBAGENT_ROLE_DEFAULT));
        assert_eq!(
            config.subagent_roles[SUBAGENT_ROLE_DEFAULT].model,
            "legacy-only-model"
        );
        assert_eq!(config.subagent_model, "legacy-only-model");
        assert_eq!(config.subagent_roles.len(), SUBAGENT_ROLE_IDS.len());
    }
}
