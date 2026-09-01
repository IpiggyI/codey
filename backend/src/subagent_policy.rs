#[cfg(test)]
use std::collections::BTreeMap;
use std::path::Path;

use crate::config::{
    CodeyConfig, DEFAULT_SUBAGENT_MODEL, DEFAULT_SUBAGENT_REASONING_EFFORT, SUBAGENT_ROLE_DEFAULT,
    SUBAGENT_ROLE_IDS, SubagentRoleConfig, uniform_subagent_roles,
};
use crate::local_router;
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
        let provider_id = self.provider_id.trim();
        if provider_id.is_empty() {
            return None;
        }
        self.models
            .iter()
            .find(|slug| model_id::equal(&local_router::model_alias(provider_id, slug), requested))
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
        .or_else(|| {
            config
                .active_profile()
                .map(|profile| profile.official_account)
        })
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
    let list_key = config
        .active_profile()
        .map(|profile| config.model_list_key_for_profile(&profile));
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
    use crate::config::ProviderProfile;

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
        let mut profile = ProviderProfile::new("Route");
        profile.id = provider_id.to_string();
        profile.official_account = false;
        CodeyConfig {
            active_profile_id: provider_id.to_string(),
            profiles: vec![profile],
            subagent_optimization: true,
            subagent_model: "provider-old-model".into(),
            subagent_roles: uniform_subagent_roles(
                "provider-old-model",
                DEFAULT_SUBAGENT_REASONING_EFFORT,
            ),
            ..CodeyConfig::default()
        }
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
                "route-b".into(),
                case.upstream_models
                    .iter()
                    .map(|model| (*model).to_string())
                    .collect(),
            );
            config.selected_models_by_provider.insert(
                "route-b".into(),
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
            .insert("route-b".into(), vec!["provider-custom-model".into()]);
        config
            .upstream_models_by_provider
            .insert("route-b".into(), vec!["provider-custom-model".into()]);

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
            "route-b".into(),
            vec![DEFAULT_SUBAGENT_MODEL.into(), "gpt-5.6-sol".into()],
        );

        reconcile_for_current_provider(&mut config, home.path(), false);

        assert!(config.subagent_optimization);
        assert_eq!(config.subagent_model, "gpt-5.6-sol");
        assert_eq!(config.subagent_reasoning_effort, "high");
    }

    #[test]
    fn route_aliases_reconcile_reasoning_using_the_upstream_model_metadata() {
        let home = tempfile::tempdir().unwrap();
        for (model, preferred, expected) in [
            ("gpt-5.4", "ultra", DEFAULT_SUBAGENT_REASONING_EFFORT),
            ("gpt-5.6-luna", "ultra", "ultra"),
            ("gpt-5.6-sol", "ultra", "ultra"),
            (
                "provider-special",
                "ultra",
                DEFAULT_SUBAGENT_REASONING_EFFORT,
            ),
            ("provider-special", "high", "high"),
        ] {
            let mut config = route_config("route-a");
            config
                .selected_models_by_provider
                .insert("route-a".into(), vec![model.into()]);
            config.subagent_model = format!("ROUTE-A/{model}");
            config.subagent_reasoning_effort = preferred.into();
            config.subagent_roles = uniform_subagent_roles(&config.subagent_model, preferred);

            reconcile_for_current_provider(&mut config, home.path(), false);

            assert_eq!(config.subagent_model, format!("route-a/{model}"));
            assert_eq!(config.subagent_reasoning_effort, expected, "{model}");
            assert!(
                config
                    .subagent_roles
                    .values()
                    .all(|role| role.reasoning_effort == expected)
            );
        }
    }

    #[test]
    fn route_qualified_model_is_preserved_outside_the_current_route_state() {
        let mut provider_a = ProviderProfile::new("A");
        provider_a.id = "route-a".into();
        let mut provider_b = ProviderProfile::new("B");
        provider_b.id = "route-b".into();
        let mut config = CodeyConfig {
            active_profile_id: provider_a.id.clone(),
            profiles: vec![provider_a, provider_b],
            selected_models_by_provider: std::collections::BTreeMap::from([
                ("route-a".into(), vec![DEFAULT_SUBAGENT_MODEL.into()]),
                ("route-b".into(), vec!["provider-special".into()]),
            ]),
            subagent_optimization: true,
            subagent_model: "route-b/provider-special".into(),
            subagent_reasoning_effort: "high".into(),
            subagent_roles: uniform_subagent_roles("route-b/provider-special", "high"),
            ..CodeyConfig::default()
        }
        .normalize();

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

        assert_eq!(config.subagent_model, "route-b/provider-special");
        assert_eq!(config.subagent_reasoning_effort, "high");
        assert!(
            config
                .subagent_roles
                .values()
                .all(|selection| selection.model == "route-b/provider-special")
        );

        state
            .third_party_model_metadata
            .push(model_catalog::ThirdPartyModelAvailability {
                slug: "route-b/provider-special".into(),
                supported_reasoning_efforts: vec!["medium".into()],
                default_reasoning_effort: "medium".into(),
            });
        reconcile_with_model_state(&mut config, Some(&state));
        assert_eq!(config.subagent_model, "route-b/provider-special");
        assert_eq!(config.subagent_reasoning_effort, "medium");
        assert!(
            config
                .subagent_roles
                .values()
                .all(|selection| selection.reasoning_effort == "medium")
        );
    }

    #[test]
    fn provider_switch_keeps_unavailable_binding_instead_of_falling_back() {
        let mut provider_a = ProviderProfile::new("A");
        provider_a.id = "route-a".into();
        let mut provider_b = ProviderProfile::new("B");
        provider_b.id = "route-b".into();
        let mut config = CodeyConfig {
            active_profile_id: provider_a.id.clone(),
            profiles: vec![provider_a, provider_b],
            subagent_optimization: true,
            subagent_model: "gpt-5.6-luna".into(),
            subagent_reasoning_effort: "high".into(),
            subagent_roles: uniform_subagent_roles("gpt-5.6-luna", "high"),
            ..CodeyConfig::default()
        }
        .normalize();

        config.active_profile_id = "route-b".into();
        let mut route_b_models = model_state();
        route_b_models
            .official_models
            .retain(|model| model.slug == DEFAULT_SUBAGENT_MODEL);
        route_b_models.default_model = DEFAULT_SUBAGENT_MODEL.into();
        reconcile_with_model_state(&mut config, Some(&route_b_models));
        assert_eq!(config.subagent_model, "gpt-5.6-luna");

        config.active_profile_id = "route-a".into();
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
            .insert("route-a".into(), vec!["provider-custom-model".into()]);

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
            .insert("route-a".into(), vec!["gpt-5.6-sol".into()]);
        config
            .selected_models_by_provider
            .insert("route-a".into(), vec!["gpt-5.6-sol".into()]);

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
            .insert("route-b".into(), vec!["gpt-5.4".into()]);
        config
            .selected_models_by_provider
            .insert("route-b".into(), vec!["gpt-5.4".into()]);

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
        assert_eq!(catalog.canonical_model("route-b/provider-special"), None);
        assert_eq!(catalog.canonical_model("missing-model"), None);
    }

    #[test]
    fn official_unavailable_catalog_is_empty_even_when_selected_models_exist() {
        let mut config = route_config("openai");
        config.profiles[0].official_account = true;
        config.official_account_available_this_launch = false;
        config
            .selected_models_by_provider
            .insert("openai".into(), vec!["gpt-5.4".into()]);

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
