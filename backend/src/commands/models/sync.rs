use super::*;

#[derive(Default)]
pub(crate) struct ModelHotReloadOutcome {
    pub(crate) reloaded: bool,
    pub(crate) deferred: bool,
    pub(crate) error: Option<String>,
}

impl ModelHotReloadOutcome {
    pub(crate) fn add_to_response(self, mut response: Value) -> Value {
        if let Some(object) = response.as_object_mut() {
            object.insert("modelHotReloaded".into(), Value::Bool(self.reloaded));
            if self.deferred {
                object.insert("modelHotReloadDeferred".into(), Value::Bool(true));
            }
            if let Some(error) = self.error {
                object.insert("modelHotReloadError".into(), Value::String(error));
            }
        }
        response
    }
}

pub(crate) fn add_subagent_hot_reload_to_response(
    mut response: Value,
    outcome: SubagentHotReloadOutcome,
) -> Value {
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "subagentConfigHotReloaded".into(),
            Value::Bool(outcome.reloaded()),
        );
        object.insert(
            "subagentConfigRepaired".into(),
            Value::Bool(outcome.repaired()),
        );
        object.insert(
            "subagentConfigHealth".into(),
            Value::String(outcome.health().to_string()),
        );
        object.insert(
            "subagentConfigRepairReasons".into(),
            Value::Array(
                outcome
                    .repair_reasons()
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        if outcome.requires_restart() {
            object.insert("restartRequired".into(), Value::Bool(true));
        }
        if let Some(error) = outcome.error() {
            object.insert(
                "subagentConfigHotReloadError".into(),
                Value::String(error.to_string()),
            );
        }
    }
    response
}

pub async fn sync_current_provider_command(state: &Arc<AppState>) -> Result<Value, String> {
    crate::commands::prepare_routes_for_current_launch(state).await?;
    let current_provider = current_codex_provider().await?;
    let provider_status = if current_provider.official {
        let config = state.config.read().await;
        codex_provider::status_from_config(&config)
    } else {
        sync_current_third_party_provider_state(state).await?
    };
    let config = if current_provider.official {
        state.config.read().await.clone()
    } else {
        sync_provider_models_for_launch(state, true).await
    };
    let restart_required = runtime_config_requires_restart(state, &config).await;
    let model_state = current_model_state_async(&config).await?;
    let public_config = redacted_config(&config);
    Ok(json!({
        "status":"ok",
        "config":public_config,
        "providerStatus":provider_status,
        "currentProviderSnapshot": super::super::json_current_provider_snapshot(&config),
        "modelState":model_state,
        "restartRequired":restart_required,
    }))
}

pub(crate) async fn current_codex_provider() -> Result<codex_provider::CurrentProvider, String> {
    let home = codex_home().to_path_buf();
    tokio::task::spawn_blocking(move || codex_provider::current_provider(&home))
        .await
        .map_err(|error| format!("读取当前 Codex 线路任务异常退出：{error}"))?
        .map_err(|error| format!("读取当前 Codex 线路失败：{error:#}"))
}

pub(crate) async fn sync_current_third_party_provider_state(
    state: &Arc<AppState>,
) -> Result<codex_provider::ProviderStatus, String> {
    let home = codex_home();
    sync_provider_state_with(state, move |config| {
        let (mut next, mut status) =
            codex_provider::sync_current_third_party_provider(&config, home)
                .map_err(|error| error.to_string())?;
        subagent_policy::reconcile_for_current_provider(&mut next, home, status.provider.official);
        next = next.normalize();
        status.changed = next != config;
        Ok((next, status))
    })
    .await
}

pub(crate) async fn sync_provider_state_with<F>(
    state: &Arc<AppState>,
    sync: F,
) -> Result<codex_provider::ProviderStatus, String>
where
    F: FnOnce(CodeyConfig) -> Result<(CodeyConfig, codex_provider::ProviderStatus), String>
        + Send
        + 'static,
{
    let previous = state.config.read().await.clone();
    let sync_input = previous.clone();
    let sync_result = tokio::task::spawn_blocking(move || sync(sync_input)).await;
    match sync_result {
        Ok(Ok((config, status))) => {
            if !status.changed {
                return Ok(status);
            }

            let _config_write_guard = state.config_write_lock.lock().await;
            let latest = state.config.read().await.clone();
            if latest != previous {
                return Err("Codey 设置在同步线路期间已更新，已忽略过期的同步结果".to_string());
            }
            save_config_to_store(state, &config)
                .await
                .map_err(|error| format!("保存当前线路同步结果失败：{error}"))?;
            *state.config.write().await = config;
            Ok(status)
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!("同步当前线路任务异常退出：{error}")),
    }
}

#[cfg(test)]
pub(crate) fn config_with_current_provider_models(
    config: &CodeyConfig,
    models: Vec<String>,
) -> CodeyConfig {
    let Some(provider_id) = config.current_model_list_key().map(ToString::to_string) else {
        return config.clone();
    };
    let mut next = config.clone();
    next.upstream_models_by_provider.insert(provider_id, models);
    next.normalize()
}

pub(crate) fn selected_models_not_in_upstream(
    selected_models: &[String],
    upstream_models: &[String],
) -> Vec<String> {
    let upstream_model_keys = upstream_models
        .iter()
        .map(|model| model_id::key(model))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    selected_models
        .iter()
        .map(|model| model.trim())
        .filter(|model| {
            !model.is_empty()
                && !upstream_model_keys.contains(&model_id::key(model))
                && seen.insert(model_id::key(model))
        })
        .map(ToString::to_string)
        .collect()
}

pub(crate) fn models_support_auto_review(models: &[String]) -> bool {
    models
        .iter()
        .any(|model| model_id::equal(model, model_id::CODEX_AUTO_REVIEW_MODEL))
}

pub(crate) fn regular_route_models(models: Vec<String>) -> Vec<String> {
    models
        .into_iter()
        .filter(|model| !model_id::equal(model, model_id::CODEX_AUTO_REVIEW_MODEL))
        .collect()
}

pub(crate) fn set_provider_auto_review_support(
    config: &mut CodeyConfig,
    provider_id: &str,
    supported: bool,
) {
    let profile_id = config.profiles.iter().find_map(|profile| {
        if profile.official_account {
            return None;
        }
        if profile.provider_id() == provider_id
            || config.model_list_key_for_profile(profile) == provider_id
        {
            Some(profile.id.clone())
        } else {
            None
        }
    });
    if let Some(profile) = config
        .profiles
        .iter_mut()
        .find(|profile| Some(profile.id.as_str()) == profile_id.as_deref())
    {
        profile.supports_auto_review = supported;
    }
}

pub(crate) fn config_with_current_provider_model_sync(
    config: &CodeyConfig,
    provider_models: Vec<String>,
    synced: bool,
    codex_home: &std::path::Path,
) -> CodeyConfig {
    let Some(provider_id) = config.current_model_list_key().map(ToString::to_string) else {
        return config.clone();
    };
    let supports_auto_review = models_support_auto_review(&provider_models);
    let provider_models = regular_route_models(provider_models);
    let manual_models = if synced {
        selected_models_not_in_upstream(config.selected_models(), &provider_models)
    } else {
        preserve_selected_third_party_models(Vec::new(), config.manual_third_party_models())
    };
    let mut supported_models = if synced {
        preserve_selected_third_party_models(provider_models, config.selected_models())
    } else {
        provider_models
    };
    preserve_declared_official_models(&mut supported_models, config.declared_official_models());
    let mut next = config.clone();
    if synced {
        next.retain_1m_context_models(&provider_id, &supported_models);
        set_provider_auto_review_support(&mut next, &provider_id, supports_auto_review);
    }
    next.upstream_models_by_provider
        .insert(provider_id.clone(), supported_models);
    if manual_models.is_empty() {
        next.manual_third_party_models_by_provider
            .remove(&provider_id);
    } else {
        next.manual_third_party_models_by_provider
            .insert(provider_id, manual_models);
    }
    next = next.normalize();
    subagent_policy::reconcile_for_current_provider(&mut next, codex_home, false);
    next
}

pub(crate) fn startup_model_sync_models_or_fallback(
    models: Vec<String>,
    saved_models: Option<&[String]>,
) -> (Vec<String>, bool) {
    if models.is_empty() {
        (
            saved_models.map(<[String]>::to_vec).unwrap_or_default(),
            false,
        )
    } else {
        (models, true)
    }
}

pub(crate) fn preserve_selected_third_party_models(
    mut upstream_models: Vec<String>,
    selected_models: &[String],
) -> Vec<String> {
    preserve_selected_third_party_models_except(
        &mut upstream_models,
        selected_models,
        &HashSet::new(),
    );
    upstream_models
}

pub(crate) fn preserve_selected_third_party_models_except(
    upstream_models: &mut Vec<String>,
    selected_models: &[String],
    deleted_model_keys: &HashSet<String>,
) {
    for model in selected_models {
        let model = model.trim();
        let key = model_id::key(model);
        if model.is_empty()
            || deleted_model_keys.contains(key.as_str())
            || upstream_models
                .iter()
                .any(|existing| model_id::equal(existing, model))
        {
            continue;
        }
        upstream_models.push(model.to_string());
    }
}

pub(crate) fn preserve_declared_official_models(
    upstream_models: &mut Vec<String>,
    declared_official_models: &[String],
) {
    let official_models_by_key = model_catalog::default_official_model_slugs()
        .into_iter()
        .map(|model| (model_id::key(&model), model))
        .collect::<std::collections::HashMap<_, _>>();
    for declared_model in declared_official_models {
        let key = model_id::key(declared_model);
        let Some(official_model) = official_models_by_key.get(&key) else {
            continue;
        };
        if upstream_models
            .iter()
            .any(|existing| model_id::equal(existing, official_model))
        {
            continue;
        }
        upstream_models.push(official_model.clone());
    }
}

pub(crate) async fn sync_provider_models_for_launch(
    state: &Arc<AppState>,
    allow_third_party_sync: bool,
) -> CodeyConfig {
    let config = state.config.read().await.clone();
    let home = codex_home().to_path_buf();
    let sync = match tokio::task::spawn_blocking(move || {
        codex_provider::current_provider_model_sync(&home)
    })
    .await
    {
        Ok(Ok(sync)) => sync,
        Ok(Err(error)) => {
            eprintln!(
                "启动时解析当前 provider 模型同步配置失败，沿用已保存的模型支持配置：{error:#}"
            );
            return reconcile_current_subagent_defaults(state, None)
                .await
                .map(|(config, _)| config)
                .unwrap_or_else(|error| {
                    eprintln!("启动时刷新已保存第三方线路模型目录失败，沿用当前设置：{error}");
                    config
                });
        }
        Err(error) => {
            eprintln!(
                "启动时解析当前 provider 模型同步配置任务异常退出，沿用已保存的模型支持配置：{error}"
            );
            return config;
        }
    };
    if sync.snapshot.uses_official_account_auth {
        return reconcile_current_subagent_defaults(state, None)
            .await
            .map(|(config, _)| config)
            .unwrap_or_else(|error| {
                eprintln!("启动时刷新官方线路模型目录失败，沿用当前设置：{error}");
                config
            });
    }
    if !allow_third_party_sync {
        return reconcile_current_subagent_defaults(state, None)
            .await
            .map(|(config, _)| config)
            .unwrap_or_else(|error| {
                eprintln!("启动时刷新已保存第三方线路模型目录失败，沿用当前设置：{error}");
                config
            });
    }
    let ownership_key = sync.snapshot.ownership_key.clone();
    let provider_label = sync.snapshot.id.clone();

    let (models, synced) = match tokio::time::timeout(
        STARTUP_PROVIDER_MODEL_SYNC_TIMEOUT,
        provider_models::fetch(&sync.request, &state.http_client),
    )
    .await
    {
        Ok(Ok(models)) => {
            let fetched_model_count = models.len();
            let (provider_models, synced) =
                startup_model_sync_models_or_fallback(models, config.upstream_models_snapshot());
            if synced {
                eprintln!(
                    "启动时已从当前 provider「{provider_label}」同步 {fetched_model_count} 个上游模型"
                );
            } else if config.upstream_models_snapshot().is_some() {
                eprintln!(
                    "启动时当前 provider「{provider_label}」返回空模型清单，沿用已保存的模型支持配置"
                );
            } else {
                eprintln!(
                    "启动时当前 provider「{provider_label}」返回空模型清单，等待用户同步或手动添加模型"
                );
            }
            (provider_models, synced)
        }
        Ok(Err(error)) => {
            let (models, synced) = startup_model_sync_models_or_fallback(
                Vec::new(),
                config.upstream_models_snapshot(),
            );
            if config.upstream_models_snapshot().is_some() {
                eprintln!(
                    "启动时同步当前 provider「{provider_label}」上游模型失败，沿用已保存的模型支持配置：{error:#}"
                );
            } else {
                eprintln!(
                    "启动时同步当前 provider「{provider_label}」上游模型失败，未注入未经确认的模型：{error:#}"
                );
            }
            (models, synced)
        }
        Err(_) => {
            let (models, synced) = startup_model_sync_models_or_fallback(
                Vec::new(),
                config.upstream_models_snapshot(),
            );
            if config.upstream_models_snapshot().is_some() {
                eprintln!(
                    "启动时同步当前 provider「{provider_label}」上游模型超时，沿用已保存的模型支持配置"
                );
            } else {
                eprintln!(
                    "启动时同步当前 provider「{provider_label}」上游模型超时，未注入未经确认的模型"
                );
            }
            (models, synced)
        }
    };
    let _config_write_guard = state.config_write_lock.lock().await;
    let mut latest = state.config.read().await.clone();
    if latest.current_provider_snapshot.is_none() {
        latest.attach_current_provider_snapshot(sync.snapshot.clone());
    }
    if latest.current_model_list_key() != Some(ownership_key.as_str()) {
        eprintln!("启动时同步模型期间当前 provider 已变化，忽略旧的同步结果");
        return latest;
    }
    let persistence_base = (!synced).then(|| latest.clone());
    let next = config_with_current_provider_model_sync(&latest, models, synced, codex_home());
    let committed = commit_startup_model_sync(state, latest, next, synced).await;
    drop(_config_write_guard);
    reconcile_current_subagent_defaults(state, persistence_base.as_ref())
        .await
        .map(|(config, _)| config)
        .unwrap_or_else(|error| {
            eprintln!("启动时刷新第三方线路模型目录失败，沿用当前设置：{error}");
            committed
        })
}

pub(crate) async fn commit_startup_model_sync(
    state: &Arc<AppState>,
    latest: CodeyConfig,
    next: CodeyConfig,
    synced: bool,
) -> CodeyConfig {
    if !latest.local_router_enabled {
        return latest;
    }
    if synced && let Err(error) = save_config_to_store(state, &next).await {
        eprintln!("保存启动时模型同步结果失败，本次启动沿用已持久化模型：{error:#}");
        return latest;
    }
    *state.config.write().await = next.clone();
    next
}
