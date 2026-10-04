use super::*;

pub async fn fetch_route_models(
    state: &Arc<AppState>,
    route_id: Option<String>,
    expected_revision: u64,
) -> Result<Value, String> {
    let _provider_model_sync_guard = state.provider_model_sync_lock.lock().await;
    let config = state.config.read().await.clone();
    ensure_route_revision(&config, expected_revision)?;
    let requested_route_id = route_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(route_id) = requested_route_id {
        match config
            .profiles
            .iter()
            .find(|profile| profile.id == route_id)
        {
            Some(profile) => {
                if !profile.enabled {
                    return Err("线路已禁用，不能同步模型".to_string());
                }
                if !profile_matches_current_snapshot(&config, profile) {
                    return Err("只能同步当前 provider 的模型清单".to_string());
                }
            }
            None => return Err("找不到要同步的当前 provider".to_string()),
        }
    }

    let home = codex_home().to_path_buf();
    let sync_home = home.clone();
    let sync = tokio::task::spawn_blocking(move || {
        codex_provider::current_provider_model_sync(&sync_home)
    })
    .await
    .map_err(|error| format!("解析当前 provider 模型同步配置任务异常退出：{error}"))?
    .map_err(|error| error.to_string())?;
    if sync.snapshot.uses_official_account_auth {
        return Err("官方账号使用官方模型目录，无需同步第三方模型".to_string());
    }
    let fetched_models = provider_models::fetch(&sync.request, &state.http_client)
        .await
        .map_err(|error| error.to_string())?;
    let visible_fetched_models = regular_route_models(fetched_models.clone());
    let _config_write_guard = state.config_write_lock.lock().await;
    let mut latest = apply_fetched_current_provider_models(
        state.config.read().await.clone(),
        sync.snapshot.clone(),
        fetched_models.clone(),
        expected_revision,
        &home,
    )?;
    let matching_route_id =
        matching_current_provider_profile(&latest).map(|profile| profile.id.clone());
    let route_model_state = if let Some(route_id) = matching_route_id.as_deref() {
        model_state_for_route_async(&latest, route_id).await?
    } else {
        current_model_state_async(&latest).await?
    };
    let (catalog_refresh, model_state) = refreshed_model_state_async(&mut latest, true).await?;
    if let Err(error) = save_config_to_store(state, &latest).await {
        return Err(rollback_model_catalog_after_config_save_async(catalog_refresh, error).await);
    }
    *state.config.write().await = latest.clone();
    drop(_config_write_guard);
    let hot_reload = hot_reload_runtime_models(state).await;
    let subagent_hot_reload = hot_reload_runtime_subagent_config(state, &latest).await;
    let restart_required = runtime_config_requires_restart(state, &latest).await;
    Ok(add_subagent_hot_reload_to_response(
        hot_reload.add_to_response(json!({
            "status":"ok",
            "config": redacted_config(&latest),
            "providerStatus": codex_provider::status_from_config(&latest),
            "models": visible_fetched_models,
            "modelState": model_state,
            "routeModelState": route_model_state,
            "restartRequired": restart_required,
        })),
        subagent_hot_reload,
    ))
}

pub(crate) fn ensure_route_revision(
    config: &CodeyConfig,
    expected_revision: u64,
) -> Result<(), String> {
    if config.settings_revision != expected_revision {
        return Err("Codey 设置已被其他操作更新，请重新载入后再操作线路".to_string());
    }
    Ok(())
}

pub(crate) fn config_with_provider_model_sync(
    config: &CodeyConfig,
    provider_id: &str,
    provider_models: Vec<String>,
    codex_home: &std::path::Path,
) -> CodeyConfig {
    let supports_auto_review = models_support_auto_review(&provider_models);
    let provider_models = regular_route_models(provider_models);
    let selected_models = config
        .selected_models_by_provider
        .get(provider_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let declared_models = config
        .declared_official_models_by_provider
        .get(provider_id)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let manual_models = selected_models_not_in_upstream(selected_models, &provider_models);
    let mut supported_models =
        preserve_selected_third_party_models(provider_models, selected_models);
    preserve_declared_official_models(&mut supported_models, declared_models);

    let mut next = config.clone();
    next.retain_1m_context_models(provider_id, &supported_models);
    set_provider_auto_review_support(&mut next, provider_id, supports_auto_review);
    next.upstream_models_by_provider
        .insert(provider_id.to_string(), supported_models);
    if manual_models.is_empty() {
        next.manual_third_party_models_by_provider
            .remove(provider_id);
    } else {
        next.manual_third_party_models_by_provider
            .insert(provider_id.to_string(), manual_models);
    }
    next = next.normalize();
    if next.current_model_list_key() == Some(provider_id)
        || next.current_provider_id() == Some(provider_id)
    {
        subagent_policy::reconcile_for_current_provider(&mut next, codex_home, false);
    }
    next
}

pub(crate) fn apply_fetched_current_provider_models(
    mut latest: CodeyConfig,
    snapshot: crate::model_ownership::CurrentProviderSnapshot,
    fetched_models: Vec<String>,
    expected_revision: u64,
    home: &std::path::Path,
) -> Result<CodeyConfig, String> {
    ensure_route_revision(&latest, expected_revision)?;
    if latest
        .current_provider_snapshot
        .as_ref()
        .is_some_and(|current| current.ownership_key != snapshot.ownership_key)
    {
        return Err("同步模型期间当前 provider 已变化，请重试".to_string());
    }
    latest.attach_current_provider_snapshot(snapshot.clone());
    if matching_current_provider_profile(&latest).is_none() {
        let (upserted, _) = codex_provider::sync_current_third_party_provider(&latest, home)
            .map_err(|error| error.to_string())?;
        latest = upserted;
        latest.attach_current_provider_snapshot(snapshot.clone());
    }
    let list_key = snapshot.ownership_key;
    latest = config_with_provider_model_sync(&latest, &list_key, fetched_models, home);
    latest.settings_revision = expected_revision.saturating_add(1);
    Ok(latest)
}

pub(crate) fn matching_current_provider_profile(config: &CodeyConfig) -> Option<&ProviderProfile> {
    let snapshot = config.current_provider_snapshot.as_ref()?;
    config
        .profiles
        .iter()
        .find(|profile| profile_matches_snapshot(profile, snapshot))
}

pub(crate) fn profile_matches_snapshot(
    profile: &ProviderProfile,
    snapshot: &crate::model_ownership::CurrentProviderSnapshot,
) -> bool {
    profile.provider_id() == snapshot.id && profile.normalized_base_url() == snapshot.base_url
}

pub(crate) fn profile_matches_current_snapshot(
    config: &CodeyConfig,
    profile: &ProviderProfile,
) -> bool {
    let Some(snapshot) = &config.current_provider_snapshot else {
        return true;
    };
    profile_matches_snapshot(profile, snapshot)
}

pub(crate) fn model_matches_current_provider_selector(
    model: &str,
    requested_model: &str,
    provider_id: &str,
) -> bool {
    let stripped = model_id::strip_route_alias(requested_model);
    model_id::equal(model, requested_model)
        || model_id::equal(&model_id::model_alias(provider_id, model), requested_model)
        || (stripped != requested_model && model_id::equal(model, stripped))
}

pub(crate) fn model_target_for_current_provider(
    config: &CodeyConfig,
    requested_model: &str,
) -> Option<crate::config::RuntimeModelTarget> {
    let snapshot = config.current_provider_snapshot.as_ref()?;
    let upstream = config
        .enabled_route_models(&snapshot.ownership_key)
        .into_iter()
        .find(|model| {
            model_matches_current_provider_selector(model, requested_model, &snapshot.id)
        })?;
    let alias = model_id::model_alias(&snapshot.id, &upstream);
    Some(crate::config::RuntimeModelTarget {
        route_id: matching_current_provider_profile(config)
            .map(|profile| profile.id.clone())
            .unwrap_or_default(),
        provider_id: snapshot.id.clone(),
        alias,
        request_provider_id: config.runtime_gateway_provider_id().to_string(),
        request_model: upstream.clone(),
        upstream_model: upstream,
        official: snapshot.uses_official_account_auth,
    })
}
