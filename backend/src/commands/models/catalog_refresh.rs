use super::*;

pub(crate) fn should_refresh_model_catalog(
    model_state: &model_catalog::ModelSelectionState,
) -> bool {
    !model_state.official_models.is_empty() || !model_state.third_party_models.is_empty()
}

pub(crate) struct ModelCatalogRefresh {
    pub(crate) fallback: bool,
    pub(crate) snapshot: model_catalog::CatalogSnapshot,
}

pub(crate) fn refresh_model_catalog_or_fallback(
    config: &CodeyConfig,
) -> Result<ModelCatalogRefresh, String> {
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    let contexts = config.runtime_enabled_model_contexts();
    if let Some(source) =
        crate::codex_config::configured_user_model_catalog_path(codex_home(), &catalog_dir)
            .map_err(|error| error.to_string())?
    {
        model_catalog::render_context_catalog_overlay(&source, &contexts)
            .map_err(|error| format!("{error:#}"))?;
    }
    let snapshot = model_catalog::snapshot(&catalog_dir).map_err(|error| error.to_string())?;
    let native_web_search_models = config.runtime_native_web_search_model_aliases();
    let context_1m_models = config.runtime_1m_context_model_aliases();
    let result = model_catalog_fallback(
        try_refresh_model_catalog(config),
        &catalog_dir,
        &native_web_search_models,
        &context_1m_models,
    );
    match result {
        Ok(fallback) => {
            if !contexts.is_empty() && !model_catalog::is_available(&catalog_dir) {
                return Err(rollback_model_catalog_snapshot(
                    snapshot,
                    "无法生成带有自定义上下文预算的模型目录，请恢复默认预算或重新同步模型".into(),
                ));
            }
            if model_catalog::is_available(&catalog_dir)
                && let Err(error) = model_catalog::apply_catalog_contexts(
                    &catalog_dir,
                    &contexts,
                    &context_1m_models,
                )
            {
                return Err(rollback_model_catalog_snapshot(snapshot, error.to_string()));
            }
            Ok(ModelCatalogRefresh { fallback, snapshot })
        }
        Err(error) => Err(rollback_model_catalog_snapshot(snapshot, error)),
    }
}

pub(crate) async fn refreshed_model_state_async(
    config: &mut CodeyConfig,
    refresh_only_when_populated: bool,
) -> Result<
    (
        Option<ModelCatalogRefresh>,
        model_catalog::ModelSelectionState,
    ),
    String,
> {
    let contexts = config.runtime_enabled_model_contexts();
    let validation = crate::codex_config::configured_user_model_catalog_path(
        codex_home(),
        &crate::codex_config::codey_model_catalog_dir(),
    )
    .and_then(|source| match source {
        Some(source) => {
            model_catalog::render_context_catalog_overlay(&source, &contexts).map(|_| ())
        }
        None => Ok(()),
    });
    if let Err(error) = validation {
        let reason = format!("{error:#}");
        if !error.is::<model_catalog::ContextBudgetCatalogError>() {
            return Err(reason);
        }
        if !crate::context_recovery::confirm(crate::context_recovery::Purpose::ModelSync, &reason)
            .await
            .map_err(|prompt| format!("{reason}；{prompt}"))?
        {
            return Err(reason);
        }
        config.model_context_by_provider.clear();
        error_log::record_failure(
            "context_recovery",
            "restore_default_context_budgets_for_model_save",
            reason,
            json!({}),
        );
    }
    let result = refreshed_model_state_once(config.clone(), refresh_only_when_populated).await;
    if let Err(reason) = &result
        && reason == "无法生成带有自定义上下文预算的模型目录，请恢复默认预算或重新同步模型"
    {
        if !crate::context_recovery::confirm(crate::context_recovery::Purpose::ModelSync, reason)
            .await
            .map_err(|prompt| format!("{reason}；{prompt}"))?
        {
            return result;
        }
        config.model_context_by_provider.clear();
        return refreshed_model_state_once(config.clone(), refresh_only_when_populated).await;
    }
    result
}

async fn refreshed_model_state_once(
    config: CodeyConfig,
    refresh_only_when_populated: bool,
) -> Result<
    (
        Option<ModelCatalogRefresh>,
        model_catalog::ModelSelectionState,
    ),
    String,
> {
    tokio::task::spawn_blocking(move || {
        let should_refresh = if refresh_only_when_populated {
            should_refresh_model_catalog(&current_model_state(&config)?)
        } else {
            true
        };
        let refresh = should_refresh
            .then(|| refresh_model_catalog_or_fallback(&config))
            .transpose()?;
        match current_model_state(&config) {
            Ok(model_state) => Ok((refresh, model_state)),
            Err(error) => Err(rollback_model_catalog_after_config_save(refresh, error)),
        }
    })
    .await
    .map_err(|error| format!("刷新 Codey 模型目录的任务异常退出：{error}"))?
}

pub(crate) async fn reconcile_current_subagent_defaults(
    state: &Arc<AppState>,
    persistence_base: Option<&CodeyConfig>,
) -> Result<(CodeyConfig, bool), String> {
    let _config_write_guard = state.config_write_lock.lock().await;
    let current = state.config.read().await.clone();
    let (catalog_refresh, model_state) = (None, current_model_state_async(&current).await?);
    let mut next = current.clone();
    reconcile_subagent_models_for_mode(&mut next, &model_state);
    next = next.normalize();
    if next == current {
        return Ok((current, false));
    }
    let persisted = persistence_base.map_or_else(
        || next.clone(),
        |base| config_with_reconciled_subagent_defaults(base, &next),
    );
    if let Err(error) = save_config_to_store(state, &persisted).await {
        return Err(rollback_model_catalog_after_config_save_async(catalog_refresh, error).await);
    }
    *state.config.write().await = next.clone();
    Ok((next, true))
}

pub(crate) fn config_with_reconciled_subagent_defaults(
    persistence_base: &CodeyConfig,
    reconciled: &CodeyConfig,
) -> CodeyConfig {
    let mut persisted = persistence_base.clone();
    persisted.subagent_optimization = reconciled.subagent_optimization;
    persisted
        .subagent_model
        .clone_from(&reconciled.subagent_model);
    persisted
        .subagent_reasoning_effort
        .clone_from(&reconciled.subagent_reasoning_effort);
    persisted
        .subagent_roles
        .clone_from(&reconciled.subagent_roles);
    persisted.normalize()
}

pub(crate) fn rollback_model_catalog_after_config_save(
    refresh: Option<ModelCatalogRefresh>,
    error: String,
) -> String {
    match refresh {
        Some(refresh) => rollback_model_catalog_snapshot(refresh.snapshot, error),
        None => error,
    }
}

pub(crate) async fn rollback_model_catalog_after_config_save_async(
    refresh: Option<ModelCatalogRefresh>,
    error: String,
) -> String {
    let primary_error = error.clone();
    tokio::task::spawn_blocking(move || rollback_model_catalog_after_config_save(refresh, error))
        .await
        .unwrap_or_else(|join_error| {
            format!("{primary_error}；回滚 Codey 模型目录的任务异常退出：{join_error}")
        })
}

pub(crate) fn rollback_model_catalog_snapshot(
    snapshot: model_catalog::CatalogSnapshot,
    error: String,
) -> String {
    match model_catalog::restore_snapshot(snapshot) {
        Ok(()) => error,
        Err(rollback_error) => {
            format!("{error}；回滚 Codey 模型目录也失败：{rollback_error:#}")
        }
    }
}

pub(crate) fn model_catalog_fallback(
    result: anyhow::Result<()>,
    catalog_dir: &std::path::Path,
    native_web_search_models: &[String],
    context_1m_models: &[String],
) -> Result<bool, String> {
    match result {
        Ok(()) => Ok(false),
        Err(error) if model_catalog::is_runtime_model_cache_unavailable(&error) => {
            model_catalog::prepare_cached_catalog_for_native_web_search(
                catalog_dir,
                native_web_search_models,
                context_1m_models,
            )
            .map(|available| !available)
            .map_err(|fallback_error| fallback_error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn try_refresh_model_catalog(config: &CodeyConfig) -> anyhow::Result<()> {
    let home = codex_home();
    let catalog_dir = crate::codex_config::codey_model_catalog_dir();
    let user_catalog = crate::codex_config::configured_user_model_catalog_path(home, &catalog_dir)?;
    let available_official_models =
        model_catalog::available_official_models(home, &catalog_dir, user_catalog.as_deref())?
            .into_iter()
            .map(|model| model.slug)
            .collect::<Vec<_>>();
    let mut config = config.clone();
    config.synchronize_runtime_official_model_selections(&available_official_models);
    let has_third_party_route = config.has_third_party_route();
    let (upstream_models, selected_models) = config.runtime_catalog_models();
    let websocket_models = config.runtime_websocket_model_aliases();
    let native_web_search_models = config.runtime_native_web_search_model_aliases();
    let context_1m_models = config.runtime_1m_context_model_aliases();
    let include_official_models = config.official_account_available_this_launch
        && config
            .profiles
            .iter()
            .any(|profile| profile.official_account);
    let excluded_official_models = config.runtime_official_model_exclusions();
    model_catalog::refresh_catalog(model_catalog::CatalogRefreshArgs {
        codex_home: home,
        catalog_dir: &catalog_dir,
        official_provider: config.official_account_available_this_launch && !has_third_party_route,
        include_official_models,
        upstream_models: has_third_party_route.then_some(upstream_models).as_deref(),
        selected_models: &selected_models,
        excluded_official_models: &excluded_official_models,
        websocket_models: Some(&websocket_models),
        native_web_search_models: Some(&native_web_search_models),
        context_1m_models: Some(&context_1m_models),
        user_catalog: user_catalog.as_deref(),
    })
    .map(|_| ())
}
