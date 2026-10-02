use super::*;

pub async fn save_default_model(
    state: &Arc<AppState>,
    requested_model: String,
    route_id: Option<String>,
) -> Result<Value, String> {
    let _config_write_guard = state.config_write_lock.lock().await;
    let mut config = state.config.read().await.clone();
    let requested_model = requested_model.trim();
    if requested_model.is_empty() {
        return Err("默认模型不能为空".to_string());
    }
    let requested_route_id = route_id
        .as_deref()
        .map(str::trim)
        .filter(|route_id| !route_id.is_empty());
    let target_profile = requested_route_id.and_then(|route_id| {
        config
            .profiles
            .iter()
            .find(|profile| profile.id == route_id)
            .cloned()
    });
    if let Some(profile) = &target_profile
        && !profile_matches_current_snapshot(&config, profile)
    {
        return Err("只能为当前 provider 设置默认模型".to_string());
    }
    if target_profile
        .as_ref()
        .is_some_and(|profile| profile.official_account)
        && !config.official_account_available_this_launch
    {
        return Err("本次 Codex 没有可用的官方账号登录态，不能选择官方模型".to_string());
    }
    let target = if let Some(profile) = &target_profile {
        config
            .model_target_for_route(&profile.id, requested_model)
            .ok_or_else(|| format!("模型 {requested_model} 当前不可用，无法设为默认"))?
    } else {
        model_target_for_current_provider(&config, requested_model)
            .or_else(|| {
                config.runtime_model_targets().into_iter().find(|target| {
                    model_matches_current_provider_selector(
                        &target.upstream_model,
                        requested_model,
                        &target.provider_id,
                    ) || model_id::equal(&target.alias, requested_model)
                })
            })
            .ok_or_else(|| format!("模型 {requested_model} 当前不可用，无法设为默认"))?
    };
    let stored_default = if config.local_router_enabled {
        target.alias.clone()
    } else {
        target.upstream_model.clone()
    };
    config.default_model = stored_default.clone();
    // `active_profile_id` remains a compatibility projection for older features.
    // The model default is authoritative and therefore owns that projection.
    if let Some(profile) = target_profile {
        config.active_profile_id = profile.id;
    }
    config = config.normalize();
    if !config.local_router_enabled {
        config.default_model = stored_default;
    }
    config.settings_revision = config.settings_revision.saturating_add(1);
    let model_state = current_model_state_async(&config).await?;
    save_config_to_store(state, &config).await?;
    *state.config.write().await = config.clone();
    let public_config = redacted_config(&config);
    drop(_config_write_guard);
    let hot_reload = hot_reload_runtime_models(state).await;
    let restart_required = runtime_config_requires_restart(state, &config).await;
    Ok(hot_reload.add_to_response(json!({
        "status":"ok",
        "config":public_config,
        "modelState":model_state,
        "restartRequired":restart_required,
    })))
}

#[allow(
    clippy::too_many_arguments,
    reason = "参数逐项对应官方模型保存命令的请求字段"
)]
pub async fn save_official_route_models(
    state: &Arc<AppState>,
    route_id: String,
    requested_models: Vec<String>,
    known_official_models: Option<Vec<String>>,
    requested_supports_1m_context_models: Option<Vec<String>>,
    requested_enabled: Option<bool>,
    requested_show_account_usage: Option<bool>,
    requested_model_contexts: Option<BTreeMap<String, crate::config::ModelContextConfig>>,
) -> Result<Value, String> {
    validate_requested_model_list_bounds("官方模型", &requested_models)?;
    let _config_write_guard = state.config_write_lock.lock().await;
    let mut config = state.config.read().await.clone();
    let route_id = route_id.trim();
    let profile_index = config
        .profiles
        .iter()
        .position(|profile| profile.id == route_id)
        .ok_or_else(|| "找不到要更新模型的官方账号线路".to_string())?;
    let profile = &config.profiles[profile_index];
    if !profile.official_account || !config.official_account_available_this_launch {
        return Err("当前线路不是本次登录可用的官方账号线路".to_string());
    }
    let provider_id = profile.provider_id().to_string();
    let list_key = config.model_list_key_for_profile(profile);
    if let Some(enabled) = requested_enabled {
        config.profiles[profile_index].enabled = enabled;
    }
    if let Some(show_usage) = requested_show_account_usage {
        config.show_account_usage_in_header = show_usage;
    }
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    let user_catalog =
        crate::codex_config::configured_user_model_catalog_path(codex_home(), &catalog_dir)
            .map_err(|error| error.to_string())?;
    let official_models = model_catalog::available_official_models(
        codex_home(),
        &catalog_dir,
        user_catalog.as_deref(),
    )
    .map_err(|error| error.to_string())?
    .into_iter()
    .map(|model| model.slug)
    .collect::<Vec<_>>();
    set_supports_1m_context_models(
        &mut config,
        &list_key,
        requested_supports_1m_context_models.as_deref(),
        &official_models,
    )?;
    set_model_contexts(
        &mut config,
        &provider_id,
        requested_model_contexts.as_ref(),
        &official_models,
    )?;
    apply_official_model_selection(
        &mut config,
        &list_key,
        &official_models,
        &requested_models,
        known_official_models.as_deref(),
    )?;
    config = config.normalize();
    let (catalog_refresh, model_state) = refreshed_model_state_async(&mut config, false).await?;
    subagent_policy::reconcile_with_model_state(&mut config, Some(&model_state));
    config = config.normalize();
    config.settings_revision = config.settings_revision.saturating_add(1);
    if let Err(error) = save_config_to_store(state, &config).await {
        return Err(rollback_model_catalog_after_config_save_async(catalog_refresh, error).await);
    }
    *state.config.write().await = config.clone();
    let public_config = redacted_config(&config);
    drop(_config_write_guard);
    let hot_reload = hot_reload_runtime_models(state).await;
    let subagent_hot_reload = hot_reload_runtime_subagent_config(state, &config).await;
    let restart_required = runtime_config_requires_restart(state, &config).await;
    Ok(add_subagent_hot_reload_to_response(
        hot_reload.add_to_response(json!({
            "status":"ok",
            "config":public_config,
            "modelState":model_state,
            "restartRequired":restart_required,
        })),
        subagent_hot_reload,
    ))
}

pub(crate) fn apply_official_model_selection(
    config: &mut CodeyConfig,
    list_key: &str,
    available_models: &[String],
    requested_models: &[String],
    known_official_models: Option<&[String]>,
) -> Result<(), String> {
    let official_by_key = available_models
        .iter()
        .map(|model| (model_id::key(model), model.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let requested_keys = requested_models
        .iter()
        .map(|model| model_id::key(model))
        .collect::<HashSet<_>>();
    if requested_keys.is_empty() {
        return Err("官方账号线路至少需要保留一个模型".to_string());
    }
    if let Some(model) = requested_keys
        .iter()
        .find(|model| !official_by_key.contains_key(model.as_str()))
    {
        return Err(format!("模型 {model} 不在官方模型列表中"));
    }
    let known_models = known_official_models.map_or_else(
        || {
            let mut known = model_catalog::legacy_selectable_official_model_slugs();
            known.extend(requested_models.iter().cloned());
            model_id::dedupe_preserving_first(known.iter().map(String::as_str))
        },
        ToOwned::to_owned,
    );
    validate_requested_model_list_bounds("已知官方模型", &known_models)?;
    let known_keys = known_models
        .iter()
        .map(|model| model_id::key(model))
        .collect::<HashSet<_>>();
    if let Some(model) = requested_keys
        .iter()
        .find(|model| !known_keys.contains(model.as_str()))
    {
        return Err(format!("模型 {model} 不在本次打开的官方模型列表中"));
    }

    let mut exclusions = config.official_model_exclusions(list_key);
    exclusions.retain(|model| !known_keys.contains(&model_id::key(model)));
    exclusions.extend(
        known_models
            .iter()
            .filter(|model| !requested_keys.contains(&model_id::key(model)))
            .cloned(),
    );
    let exclusions = model_id::dedupe_preserving_first(exclusions.iter().map(String::as_str));
    let excluded_keys = exclusions
        .iter()
        .map(|model| model_id::key(model))
        .collect::<HashSet<_>>();
    let selected_models = available_models
        .iter()
        .filter(|model| !excluded_keys.contains(&model_id::key(model)))
        .cloned()
        .collect::<Vec<_>>();
    config
        .excluded_official_models_by_provider
        .insert(list_key.to_string(), exclusions);
    config
        .selected_models_by_provider
        .insert(list_key.to_string(), selected_models);
    Ok(())
}

pub(crate) fn current_model_state(
    config: &CodeyConfig,
) -> Result<model_catalog::ModelSelectionState, String> {
    if !config.local_router_enabled {
        let provider = codex_provider::current_provider(codex_home())
            .map_err(|error| format!("读取当前 Codex 线路失败：{error:#}"))?;
        return native_model_state_for_provider(config, &provider, codex_home());
    }
    if let Some(profile) = config
        .profiles
        .iter()
        .find(|profile| profile.enabled && profile.id == config.active_profile_id)
        .or_else(|| config.profiles.iter().find(|profile| profile.enabled))
    {
        return model_state_for_profile(config, profile);
    }
    let official = false;
    let selected_models = config
        .current_model_list_key()
        .map(|provider_id| config.enabled_route_models(provider_id))
        .unwrap_or_default();
    model_catalog::selection_state_with_manual_models(
        codex_home(),
        &crate::codex_config::codey_model_catalog_dir(),
        official,
        config.upstream_models_snapshot(),
        &selected_models,
        config.manual_third_party_models(),
        None,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn model_state_for_profile(
    config: &CodeyConfig,
    profile: &ProviderProfile,
) -> Result<model_catalog::ModelSelectionState, String> {
    let list_key = config.model_list_key_for_profile(profile);
    let official = profile.official_account && config.official_account_available_this_launch;
    let selected_models = if official {
        config.enabled_official_route_models(&list_key)
    } else {
        config.enabled_route_models(&list_key)
    };
    let upstream_models = config
        .upstream_models_by_provider
        .get(&list_key)
        .map(Vec::as_slice);
    let manual_models = config
        .manual_third_party_models_by_provider
        .get(&list_key)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let excluded_official_models = config.official_model_exclusions(&list_key);
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    let user_catalog =
        crate::codex_config::configured_user_model_catalog_path(codex_home(), &catalog_dir)
            .map_err(|error| error.to_string())?;
    model_catalog::selection_state_with_catalog_options(
        codex_home(),
        &catalog_dir,
        official,
        upstream_models,
        &selected_models,
        manual_models,
        &excluded_official_models,
        config.default_model_for_profile(profile).as_deref(),
        user_catalog.as_deref(),
    )
    .map_err(|error| error.to_string())
}
