use super::*;

pub(super) async fn list_channels(state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await.clone();
    channel_list_at(codex_home(), &config)
}

fn channel_list_at(home: &Path, config: &CodeyConfig) -> Result<Value, String> {
    serde_json::to_value(crate::channels::list(home, config).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

pub(super) async fn change_channel(
    state: &Arc<AppState>,
    args: &Value,
    set_default: bool,
) -> Result<Value, String> {
    change_channel_at(state, args, set_default, codex_home()).await
}

async fn change_channel_at(
    state: &Arc<AppState>,
    args: &Value,
    set_default: bool,
    home: &Path,
) -> Result<Value, String> {
    let revision = argument::<u64>(args, "expectedRevision")?;
    let _guard = state.config_write_lock.lock().await;
    let mut config = state.config.read().await.clone();
    if revision != config.settings_revision {
        return Err("Codey 设置已被其他操作更新，请刷新后重试".into());
    }
    if set_default {
        let id = argument::<String>(args, "channelId")?;
        let model = argument::<String>(args, "model")?;
        crate::channels::set_default(home, &mut config, &id, &model)
            .map_err(|error| error.to_string())?;
    } else {
        let id = argument::<Option<String>>(args, "channelId")?;
        crate::channels::select(home, &mut config, id.as_deref())
            .map_err(|error| error.to_string())?;
    }
    let snapshot = codex_provider::current_provider_snapshot_for_config(home, &config)
        .map_err(|error| error.to_string())?;
    config.attach_current_provider_snapshot(snapshot);
    config.settings_revision = config.settings_revision.saturating_add(1);
    let channel_list = channel_list_at(home, &config)?;
    save_config_to_store(state, &config).await?;
    *state.config.write().await = config.clone();
    drop(_guard);
    let restart_required = runtime_config_requires_restart(state, &config).await;
    Ok(json!({
        "status": "ok",
        "channelList": channel_list,
        "settingsRevision": config.settings_revision,
        "restartRequired": restart_required,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn channels_commands_persist_without_starting_runtime_and_reject_stale_writes() {
        let (home, config) = crate::channels::tests::fixture();
        let state = Arc::new(AppState {
            store: ConfigStore::new(home.path().join("codey.json")),
            config: RwLock::new(config),
            ..AppState::default()
        });
        let config_bytes = std::fs::read(home.path().join("config.toml")).unwrap();
        let auth_bytes = std::fs::read(home.path().join("auth.json")).unwrap();
        let rejected = change_channel_at(
            &state,
            &json!({"channelId":"provider:b.dot","expectedRevision":0}),
            false,
            home.path(),
        )
        .await;
        assert!(rejected.unwrap_err().contains("默认模型"));
        assert_eq!(state.config.read().await.selected_channel_id, None);
        let default = change_channel_at(
            &state,
            &json!({"channelId":"provider:b.dot","model":"b.model","expectedRevision":0}),
            true,
            home.path(),
        )
        .await
        .unwrap();
        assert_eq!(default["settingsRevision"], 1);
        assert_eq!(default["restartRequired"], false);
        let selected = change_channel_at(
            &state,
            &json!({"channelId":"provider:b.dot","expectedRevision":1}),
            false,
            home.path(),
        )
        .await
        .unwrap();
        assert_eq!(selected["channelList"]["effectiveProviderId"], "b.dot");
        assert_eq!(selected["restartRequired"], false);
        assert_eq!(
            state.store.load().unwrap().selected_channel_id.as_deref(),
            Some("provider:b.dot")
        );
        assert_eq!(
            state
                .config
                .read()
                .await
                .current_provider_snapshot
                .as_ref()
                .unwrap()
                .id,
            "b.dot"
        );
        assert!(state.runtime.lock().await.is_none());
        assert!(
            change_channel_at(
                &state,
                &json!({"channelId":null,"expectedRevision":1}),
                false,
                home.path()
            )
            .await
            .is_err()
        );
        let reset = change_channel_at(
            &state,
            &json!({"channelId":null,"expectedRevision":2}),
            false,
            home.path(),
        )
        .await
        .unwrap();
        assert!(reset["channelList"]["selectedChannelId"].is_null());
        assert_eq!(reset["channelList"]["effectiveProviderId"], "a");
        assert_eq!(
            std::fs::read(home.path().join("config.toml")).unwrap(),
            config_bytes
        );
        assert_eq!(
            std::fs::read(home.path().join("auth.json")).unwrap(),
            auth_bytes
        );
    }
}

#[tokio::test]
async fn channels_restart_rule_compares_with_running_channel_and_model() {
    let (home, mut config) = crate::channels::tests::selected_fixture();
    crate::channels::set_default(home.path(), &mut config, "provider:a", "a-model").unwrap();
    let original_model = config.default_models_by_channel["provider:b.dot"].clone();
    let runtime = crate::launcher::CodeyRuntime::for_model_delivery_test(config.clone(), "");
    let state = Arc::new(AppState {
        store: ConfigStore::new(home.path().join("codey.json")),
        config: RwLock::new(config),
        runtime: Mutex::new(Some(Arc::new(runtime))),
        ..AppState::default()
    });
    for (revision, id, expected) in [(0, "provider:a", true), (1, "provider:b.dot", false)] {
        let result = change_channel_at(
            &state,
            &json!({"channelId":id,"expectedRevision":revision}),
            false,
            home.path(),
        )
        .await
        .unwrap();
        assert_eq!(result["restartRequired"], expected);
    }
    for (revision, model, expected) in [(2, "changed", true), (3, original_model.as_str(), false)] {
        let result = change_channel_at(
            &state,
            &json!({"channelId":"provider:b.dot","model":model,"expectedRevision":revision}),
            true,
            home.path(),
        )
        .await
        .unwrap();
        assert_eq!(result["restartRequired"], expected);
    }
}
