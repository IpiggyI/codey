use super::*;

#[test]
fn unknown_official_auth_from_auto_store_allows_official_only_launch_to_reach_runtime() {
    let mut previous = CodeyConfig::default();
    previous.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "openai",
            "https://chatgpt.com/backend-api/codex",
            "responses",
            true,
        ),
    );

    let next = route_config_for_official_probe(
        &previous,
        crate::codex_provider::OfficialAccountProfileStatus::Unknown {
            reason: concat!(
                "无法运行 codex login status：拒绝访问。 (os error 5)；",
                "Codex auth.json 未包含 ChatGPT token（authMode=missing, ",
                "chatgptTokenFields=[\"access_token\", \"id_token\", \"refresh_token\"], ",
                "openaiApiKeyPresent=false），当前凭据存储为 auto，",
                "可能由系统凭据存储接管"
            )
            .into(),
        },
    )
    .unwrap();

    assert!(next.official_account_available_this_launch);
    assert_eq!(
        next.official_account_status_this_launch,
        crate::config::LaunchOfficialAccountStatus::Unknown
    );
    assert!(
        next.current_provider_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.uses_official_account_auth)
    );
}

#[test]
fn unknown_official_auth_does_not_force_openai_auth_for_third_party_launches() {
    let mut previous = CodeyConfig {
        default_model: "gpt-5.6-sol".into(),
        selected_models_by_provider: std::collections::BTreeMap::from([(
            "relay".into(),
            vec!["gpt-5.6-sol".into()],
        )]),
        ..CodeyConfig::default()
    };
    previous.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "relay",
            "https://relay.example/v1",
            "responses",
            false,
        ),
    );

    let next = route_config_for_official_probe(
        &previous,
        crate::codex_provider::OfficialAccountProfileStatus::Unknown {
            reason: "auth.json not found under auto store".into(),
        },
    )
    .unwrap();

    assert!(!next.official_account_available_this_launch);
    assert_eq!(
        next.official_account_status_this_launch,
        crate::config::LaunchOfficialAccountStatus::Unknown
    );
    assert!(next.current_provider_is_third_party());
    assert_eq!(next.current_provider_id(), Some("relay"));
}

#[test]
fn unavailable_official_auth_error_keeps_safe_probe_diagnostics() {
    let mut previous = CodeyConfig::default();
    previous.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "openai",
            "https://chatgpt.com/backend-api/codex",
            "responses",
            true,
        ),
    );

    let error = route_config_for_official_probe(
        &previous,
        crate::codex_provider::OfficialAccountProfileStatus::Unavailable {
            reason: "nativeStatus=not_logged_in; executable=codex.exe; credentialsIncluded=false"
                .into(),
        },
    )
    .unwrap_err();

    assert!(error.contains("没有可用的官方账号登录"));
    assert!(error.contains("nativeStatus=not_logged_in"));
    assert!(error.contains("executable=codex.exe"));
    assert!(error.contains("credentialsIncluded=false"));
}

#[test]
fn every_available_route_model_can_be_selected_for_subagents() {
    let state = model_catalog::ModelSelectionState {
        third_party_models: vec!["provider-coder".into()],
        official_models: vec![model_catalog::OfficialModelAvailability {
            slug: "gpt-5.6-luna".into(),
            display_name: "GPT-5.6-Luna".into(),
            supported: true,
            supported_reasoning_efforts: vec!["low".into(), "high".into()],
            default_reasoning_effort: "low".into(),
        }],
        ..model_catalog::ModelSelectionState::default()
    };

    assert_eq!(state.available_model("GPT-5.6-LUNA"), Some("gpt-5.6-luna"));
    assert_eq!(
        state.available_model("provider-coder"),
        Some("provider-coder")
    );
    assert_eq!(state.available_model("gpt-5.6-sol"), None);
}

#[test]
fn renderer_model_catalog_keeps_supported_models_before_configured_models() {
    let mut config = CodeyConfig::default();
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "source-provider",
            "https://source.example/v1",
            "responses",
            false,
        ),
    );
    let official_models = [
        ("gpt-5.6-sol", "GPT-5.6-Sol"),
        ("gpt-5.6-terra", "GPT-5.6-Terra"),
        ("gpt-5.6-luna", "GPT-5.6-Luna"),
        ("gpt-5.5", "GPT-5.5"),
        ("gpt-5.4", "GPT-5.4"),
        ("gpt-5.4-mini", "GPT-5.4-Mini"),
        ("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
    ]
    .into_iter()
    .map(
        |(slug, display_name)| model_catalog::OfficialModelAvailability {
            slug: slug.into(),
            display_name: display_name.into(),
            supported: !matches!(slug, "gpt-5.6-terra" | "gpt-5.4-mini"),
            supported_reasoning_efforts: vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
            ],
            default_reasoning_effort: "low".into(),
        },
    )
    .collect::<Vec<_>>();
    let model_state = model_catalog::ModelSelectionState {
        official_model_ids: official_models
            .iter()
            .map(|model| model.slug.clone())
            .collect(),
        official_models,
        third_party_models: vec!["provider-fast-coder".into()],
        third_party_model_metadata: Vec::new(),
        manual_third_party_models: vec!["provider-fast-coder".into()],
        upstream_models: vec!["provider-fast-coder".into()],
        default_model: "gpt-5.6-sol".into(),
    };

    let catalog = renderer_model_catalog_value(&config, &model_state);

    assert_eq!(
        catalog["models"],
        json!([
            "gpt-5.6-sol",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.3-codex-spark",
            "provider-fast-coder"
        ])
    );
    assert_eq!(catalog["default_model"], "gpt-5.6-sol");
    assert_eq!(catalog["model_provider"], "source-provider");
    assert_eq!(catalog["model_metadata"][0]["model"], "gpt-5.6-sol");
    assert_eq!(catalog["model_metadata"][0]["display_name"], "gpt-5.6-sol");
    assert_eq!(catalog["model_metadata"][0]["provider_id"], "source-provider");
    assert!(catalog["model_metadata"][0].get("route_prefix").is_none());
    assert_eq!(catalog["model_metadata"][5]["model"], "provider-fast-coder");
    assert_eq!(catalog["model_metadata"][5]["provider_id"], "source-provider");
    assert_eq!(catalog["model_metadata"].as_array().unwrap().len(), 6);
}

#[test]
fn renderer_model_catalog_uses_per_third_party_reasoning_metadata() {
    let mut config = CodeyConfig::default();
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "source-provider",
            "https://source.example/v1",
            "responses",
            false,
        ),
    );
    let model_state = model_catalog::ModelSelectionState {
        third_party_models: vec!["gpt-5.6-sol".into(), "provider-fast-coder".into()],
        third_party_model_metadata: vec![
            model_catalog::ThirdPartyModelAvailability {
                slug: "gpt-5.6-sol".into(),
                supported_reasoning_efforts: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                    "ultra".into(),
                ],
                default_reasoning_effort: "low".into(),
            },
            model_catalog::ThirdPartyModelAvailability {
                slug: "provider-fast-coder".into(),
                supported_reasoning_efforts: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                ],
                default_reasoning_effort: "low".into(),
            },
        ],
        default_model: "gpt-5.6-sol".into(),
        ..model_catalog::ModelSelectionState::default()
    };

    let catalog = renderer_model_catalog_value(&config, &model_state);
    let metadata = catalog["model_metadata"].as_array().unwrap();
    let sol = metadata
        .iter()
        .find(|entry| entry["model"] == "gpt-5.6-sol")
        .unwrap();
    assert_eq!(
        sol["supported_reasoning_efforts"],
        json!(["low", "medium", "high", "xhigh", "max", "ultra"])
    );
    let custom = metadata
        .iter()
        .find(|entry| entry["model"] == "provider-fast-coder")
        .unwrap();
    assert_eq!(
        custom["supported_reasoning_efforts"],
        json!(["low", "medium", "high", "xhigh"])
    );
}

#[test]
fn renderer_model_catalog_uses_official_snapshot_bare_ids() {
    let mut config = CodeyConfig {
        official_account_available_this_launch: true,
        ..CodeyConfig::default()
    };
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "openai",
            "https://chatgpt.com/backend-api/codex",
            "responses",
            true,
        ),
    );
    let model_state = model_catalog::ModelSelectionState {
        official_models: vec![model_catalog::OfficialModelAvailability {
            slug: "gpt-5.6-sol".into(),
            display_name: "GPT-5.6-Sol".into(),
            supported: true,
            supported_reasoning_efforts: vec!["low".into(), "medium".into()],
            default_reasoning_effort: "low".into(),
        }],
        default_model: "gpt-5.6-sol".into(),
        ..model_catalog::ModelSelectionState::default()
    };

    let catalog = renderer_model_catalog_value(&config, &model_state);

    assert_eq!(catalog["models"], json!(["gpt-5.6-sol"]));
    assert_eq!(catalog["default_model"], "gpt-5.6-sol");
    assert_eq!(catalog["model_provider"], "openai");
    assert_eq!(catalog["model_metadata"][0]["model"], "gpt-5.6-sol");
    assert_eq!(catalog["model_metadata"][0]["display_name"], "gpt-5.6-sol");
    assert_eq!(catalog["model_metadata"][0]["provider_id"], "openai");
    assert_eq!(catalog["model_metadata"][0]["official_account"], true);
    assert!(catalog["model_metadata"][0].get("route_prefix").is_none());
}

#[test]
fn renderer_catalog_uses_applied_config_while_provider_restart_is_pending() {
    let mut applied = CodeyConfig::default();
    applied.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "openai",
            "https://chatgpt.com/backend-api/codex",
            "responses",
            true,
        ),
    );
    let mut current = CodeyConfig::default();
    current.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "relay",
            "https://api.example.test/v1",
            "responses",
            false,
        ),
    );

    assert!(std::ptr::eq(
        model_catalog_config_for_runtime(&current, Some(&applied)),
        &applied
    ));
}

#[test]
fn renderer_catalog_uses_current_config_for_model_only_changes() {
    let applied = CodeyConfig::default();
    let mut current = applied.clone();
    current.default_model = "provider-default".into();

    assert!(std::ptr::eq(
        model_catalog_config_for_runtime(&current, Some(&applied)),
        &current
    ));
}

#[test]
fn model_hot_reload_keeps_startup_capabilities_pending_without_blocking_other_routes() {
    for (websockets, web_search) in [(false, false), (true, false), (false, true)] {
        let mut route = crate::config::ProviderProfile::new("Models");
        route.id = "models".into();
        route.base_url = "https://models.example/v1".into();
        route.supports_websockets = websockets;
        route.supports_native_web_search = web_search;
        let mut other = crate::config::ProviderProfile::new("Other");
        other.id = "other".into();
        other.base_url = "https://other.example/v1".into();
        let applied = CodeyConfig {
            active_profile_id: route.id.clone(),
            profiles: vec![route, other],
            selected_models_by_provider: std::collections::BTreeMap::from([
                ("models".into(), vec!["model-a".into()]),
                ("other".into(), vec!["other-a".into()]),
            ]),
            ..CodeyConfig::default()
        };
        let mut current = applied.clone();
        current
            .selected_models_by_provider
            .insert("models".into(), vec!["model-a".into(), "model-b".into()]);
        current
            .selected_models_by_provider
            .insert("other".into(), vec!["other-b".into()]);
        assert!(std::ptr::eq(
            model_catalog_config_for_runtime(&current, Some(&applied)),
            &current,
        ));
        // Publishing the picker updates only the model baseline. The app-server
        // capability baseline must still be compared with the launch config.
        assert_eq!(
            config_requires_restart_with_route_status(
                provider_route_restart_required_for_runtime(&applied, &current),
                &applied,
                &RuntimeModelConfig::from_config(&current),
                &RuntimeSubagentConfig::from_config(&current),
                &current,
            ),
            websockets || web_search,
        );
        let mut capability_change = applied.clone();
        capability_change.profiles[0].supports_native_web_search = !web_search;
        assert!(!runtime_supports_current_routes_for_hot_reload(
            &applied,
            &capability_change
        ));
        assert!(provider_route_restart_required_for_runtime(
            &applied,
            &capability_change
        ));
    }
}

#[test]
fn restart_sensitive_config_changes_are_detected() {
    let applied = CodeyConfig::default();
    let applied_models = RuntimeModelConfig::from_config(&applied);
    let applied_subagent = RuntimeSubagentConfig::from_config(&applied);

    let mut model_change = applied.clone();
    model_change
        .selected_models_by_provider
        .insert("relay".into(), vec!["third-party-model".into()]);
    assert!(config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &model_change
    ));
    assert!(!config_requires_restart(
        &applied,
        &RuntimeModelConfig::from_config(&model_change),
        &applied_subagent,
        &model_change
    ));

    let mut default_model_change = applied.clone();
    default_model_change.default_model = "provider-default".into();
    assert!(config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &default_model_change
    ));
    assert!(!config_requires_restart(
        &applied,
        &RuntimeModelConfig::from_config(&default_model_change),
        &applied_subagent,
        &default_model_change
    ));

    let mut gpu_mode_change = applied.clone();
    gpu_mode_change.gpu_launch_mode = crate::config::GpuLaunchMode::DisableGpuRasterization;
    assert!(config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &gpu_mode_change
    ));

    let mut account_usage_change = applied.clone();
    account_usage_change.show_account_usage_in_header = true;
    assert!(!config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &account_usage_change
    ));

    let mut disabled_subagent_change = applied.clone();
    disabled_subagent_change.subagent_model = "gpt-5.6-sol".into();
    assert!(!config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &disabled_subagent_change
    ));

    let mut enabled_subagents = applied.clone();
    enabled_subagents.subagent_optimization = true;
    let enabled_models = RuntimeModelConfig::from_config(&enabled_subagents);
    let enabled_subagent = RuntimeSubagentConfig::from_config(&enabled_subagents);
    let mut changed_subagent = enabled_subagents.clone();
    changed_subagent.subagent_model = "gpt-5.6-sol".into();
    changed_subagent.subagent_reasoning_effort = "high".into();
    assert!(config_requires_restart(
        &enabled_subagents,
        &enabled_models,
        &enabled_subagent,
        &changed_subagent
    ));
    assert!(!config_requires_restart(
        &enabled_subagents,
        &enabled_models,
        &RuntimeSubagentConfig::from_config(&changed_subagent),
        &changed_subagent
    ));

    let mut changed_task_role = enabled_subagents.clone();
    changed_task_role.subagent_roles.insert(
        crate::config::SUBAGENT_ROLE_QUICK_SCAN.into(),
        crate::config::SubagentRoleConfig::new("gpt-5.6-sol", "high"),
    );
    assert!(config_requires_restart(
        &enabled_subagents,
        &enabled_models,
        &enabled_subagent,
        &changed_task_role
    ));

    let mut provider_change = applied.clone();
    provider_change.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "relay",
            "https://route-b.example/v1",
            "responses",
            false,
        ),
    );
    assert!(config_requires_restart(        &applied,
        &applied_models,
        &applied_subagent,
        &provider_change
    ));
}

#[tokio::test]
async fn shutdown_cancels_a_restart_waiting_for_the_runtime_lock() {
    let state = Arc::new(AppState::default());
    let _operation = state.runtime_operation.lock().await;
    let restart_pending = state.restart_operation_pending.notified();
    let response = schedule_restart_codey_runtime(&state).await.unwrap();
    assert_eq!(response["status"], "restarting");
    tokio::time::timeout(Duration::from_secs(1), restart_pending)
        .await
        .expect("restart did not reach the runtime operation lock");

    tokio::time::timeout(Duration::from_secs(1), begin_shutdown(&state))
        .await
        .expect("shutdown waited on a restart blocked by the runtime lock");

    assert!(state.is_shutting_down());
    assert!(!state.restart_in_progress.load(Ordering::Acquire));
    assert!(state.restart_task.lock().await.is_none());
}

#[tokio::test]
async fn shutdown_rejects_new_runtime_launches_and_restarts() {
    let state = Arc::new(AppState::default());
    begin_shutdown(&state).await;

    assert!(
        launch_codey_inner(&state)
            .await
            .unwrap_err()
            .contains("正在退出")
    );
    assert!(
        schedule_restart_codey_runtime(&state)
            .await
            .unwrap_err()
            .contains("正在退出")
    );
}

#[test]
fn live_config_changes_do_not_require_restart() {
    let applied = CodeyConfig::default();
    let applied_models = RuntimeModelConfig::from_config(&applied);
    let applied_subagent = RuntimeSubagentConfig::from_config(&applied);
    let mut current = applied.clone();
    current.webhook.channels.push(NotificationChannelConfig {
        url: "https://example.test/webhook".into(),
        ..NotificationChannelConfig::default()
    });
    current.disable_trace_log_writes = !current.disable_trace_log_writes;
    current.protect_crashpad_pending = !current.protect_crashpad_pending;

    assert!(!config_requires_restart(
        &applied,
        &applied_models,
        &applied_subagent,
        &current
    ));
}

#[tokio::test]
async fn runtime_status_does_not_wait_for_a_lifecycle_operation() {
    let state = Arc::new(AppState::default());
    let _operation = state.runtime_operation.lock().await;

    let status = tokio::time::timeout(Duration::from_millis(100), runtime_status(&state))
        .await
        .expect("runtime status should not wait for the lifecycle operation lock")
        .unwrap();

    assert_eq!(status["running"], false);
}

#[test]
fn successful_startup_model_sync_keeps_only_enabled_route_models() {
    let mut config = CodeyConfig::default();
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "relay",
            "https://relay.example/v1",
            "responses",
            false,
        ),
    );
    let provider_id = config.current_model_list_key().unwrap().to_string();
    config.selected_models_by_provider.insert(
        provider_id,
        vec!["provider-fast-coder".into(), "provider-missing".into()],
    );
    let synced = config_with_current_provider_models(
        &config,
        vec!["gpt-5.6-sol".into(), "provider-fast-coder".into()],
    );
    let home = tempfile::tempdir().unwrap();

    let state = model_catalog::selection_state(
        home.path(),
        false,
        synced.upstream_models_snapshot(),
        synced.selected_models(),
        synced.default_model(),
    )
    .unwrap();

    assert!(state.official_models.is_empty());
    assert_eq!(state.third_party_models, ["provider-fast-coder"]);
}

#[test]
fn failed_startup_model_sync_does_not_inject_unconfirmed_official_models() {
    let mut config = CodeyConfig::default();
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "relay",
            "https://relay.example/v1",
            "responses",
            false,
        ),
    );
    let provider_id = config.current_model_list_key().unwrap().to_string();
    config
        .selected_models_by_provider
        .insert(provider_id.clone(), vec!["provider-fast-coder".into()]);
    config.default_model = "provider-fast-coder".to_string();
    let (fallback_models, synced) = startup_model_sync_models_or_fallback(Vec::new(), None);
    assert!(!synced);
    assert!(fallback_models.is_empty());
    let fallback = config_with_current_provider_models(&config, fallback_models);
    let home = tempfile::tempdir().unwrap();

    let state = model_catalog::selection_state(
        home.path(),
        false,
        fallback.upstream_models_snapshot(),
        fallback.selected_models(),
        fallback.default_model(),
    )
    .unwrap();

    assert!(state.official_models.is_empty());
    assert!(state.third_party_models.is_empty());
    assert!(state.default_model.is_empty());
}

#[test]
fn failed_startup_model_sync_preserves_a_saved_manual_selection() {
    let saved = vec!["gpt-5.6-luna".into(), "provider-manual-model".into()];

    let (fallback_models, synced) = startup_model_sync_models_or_fallback(Vec::new(), Some(&saved));

    assert!(!synced);
    assert_eq!(fallback_models, saved);
}

#[test]
fn successful_model_sync_preserves_user_confirmed_other_models() {
    let merged = preserve_selected_third_party_models(
        vec!["gpt-5.6-sol".into(), "provider-listed".into()],
        &[
            "provider-manual".into(),
            "provider-listed".into(),
            "gpt-5.4".into(),
        ],
    );

    assert_eq!(
        merged,
        [
            "gpt-5.6-sol",
            "provider-listed",
            "provider-manual",
            "gpt-5.4",
        ]
    );
}

#[test]
fn manual_model_selection_deletion_removes_saved_other_model_support() {
    let official = model_catalog::default_official_model_slugs();
    let deleted =
        validate_deleted_third_party_models(&official, &["provider-manual".into()]).unwrap();
    let mut supported_models = vec!["gpt-5.6-sol".into()];

    preserve_selected_third_party_models_except(
        &mut supported_models,
        &[
            "provider-listed".into(),
            "provider-manual".into(),
            "gpt-5.4".into(),
        ],
        &deleted,
    );
    preserve_selected_third_party_models_except(
        &mut supported_models,
        &["provider-listed".into()],
        &std::collections::HashSet::new(),
    );

    assert_eq!(
        supported_models,
        ["gpt-5.6-sol", "provider-listed", "gpt-5.4"]
    );
}

#[test]
fn manual_model_selection_deletion_rejects_official_models() {
    let official = model_catalog::default_official_model_slugs();

    let error =
        validate_deleted_third_party_models(&official, &[" GPT-5.6-SOL ".into()]).unwrap_err();

    assert!(error.contains("官方模型"));
}

#[test]
fn manual_model_selection_separates_official_and_other_models() {
    let official = model_catalog::default_official_model_slugs();

    let (supported_official, selected_third_party) = validate_manual_model_selection(
        &official,
        &["gpt-5.6-luna".into(), "gpt-5.4".into()],
        &[
            " provider-manual-model ".into(),
            "provider-manual-model".into(),
        ],
    )
    .unwrap();

    assert_eq!(supported_official, ["gpt-5.6-luna", "gpt-5.4"]);
    assert_eq!(selected_third_party, ["provider-manual-model"]);
}

#[test]
fn manual_model_selection_rejects_official_models_in_the_other_model_input() {
    let official = model_catalog::default_official_model_slugs();

    let error =
        validate_manual_model_selection(&official, &[], &[" GPT-5.6-SOL ".into()]).unwrap_err();

    assert!(error.contains("已在官方模型列表中"));
}
