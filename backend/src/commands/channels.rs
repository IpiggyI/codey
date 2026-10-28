use super::*;

pub(super) async fn list_channels(state: &Arc<AppState>) -> Result<Value, String> {
    let config = state.config.read().await.clone();
    channel_list_at(state, codex_home(), &config)
}

fn channel_list_at(state: &AppState, home: &Path, config: &CodeyConfig) -> Result<Value, String> {
    serde_json::to_value(
        crate::channels::list_with_accounts(home, config, &state.official_accounts())
            .map_err(|error| error.to_string())?,
    )
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
    let _account_guard = state.official_account_lock.lock().await;
    let store = state.official_accounts();
    let id = argument::<Option<String>>(args, "channelId")?;
    let stored_official = id
        .as_deref()
        .and_then(|id| id.strip_prefix("official:"))
        .filter(|id| *id != "unavailable")
        .map(|id| store.get(id).map(|account| account.map(|_| id.to_string())))
        .transpose()
        .map_err(|e| e.to_string())?
        .flatten();
    if let Some(id) = stored_official.as_deref() {
        let channel_id = format!("official:{id}");
        let channel = crate::channels::list_with_accounts(home, &config, &store)
            .map_err(|e| e.to_string())?
            .channels
            .into_iter()
            .find(|channel| channel.id == channel_id && channel.available)
            .ok_or("所选渠道不可用")?;
        if set_default {
            let model = argument::<String>(args, "model")?;
            if model.trim().is_empty() {
                return Err("渠道默认模型不能为空".into());
            }
            config
                .default_models_by_channel
                .insert(channel_id, model.trim().into());
        } else {
            if channel
                .default_model
                .as_deref()
                .is_none_or(|model| model.trim().is_empty())
            {
                return Err("请先为渠道设置默认模型".into());
            }
            config.selected_channel_id = Some(channel_id);
        }
    } else if set_default {
        let id = id.as_deref().ok_or("缺少 channelId")?;
        let model = argument::<String>(args, "model")?;
        crate::channels::set_default(home, &mut config, id, &model).map_err(|e| e.to_string())?;
    } else {
        crate::channels::select(home, &mut config, id.as_deref()).map_err(|e| e.to_string())?;
    }
    config.settings_revision = config.settings_revision.saturating_add(1);
    let mut finish = || -> anyhow::Result<Value> {
        let snapshot = codex_provider::current_provider_snapshot_for_config(home, &config)?;
        config.attach_current_provider_snapshot(snapshot);
        let list = channel_list_at(state, home, &config).map_err(anyhow::Error::msg)?;
        state.store.save(&config)?;
        Ok(list)
    };
    let switched = stored_official.is_some() && !set_default;
    let channel_list = if switched {
        store.activate(home, stored_official.as_deref().unwrap(), finish)
    } else {
        finish()
    }
    .map_err(|e| format!("{e:#}"))?;
    *state.config.write().await = config.clone();
    drop(_guard);
    let restart_required = switched || runtime_config_requires_restart(state, &config).await;
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

#[tokio::test]
async fn channels_stored_account_switch_and_provider_selection_use_separate_credentials() {
    use crate::official_accounts::Account;
    let (home, config) = crate::channels::tests::fixture();
    let state = Arc::new(AppState::with_store(ConfigStore::new(
        home.path().join("codey/config.json"),
    )));
    *state.config.write().await = config;
    let store = state.official_accounts();
    store.import_current(home.path()).unwrap();
    let target = store
        .upsert(
            Account::from_auth(json!({"auth_mode":"chatgpt",
        "tokens":{"account_id":"second-account","access_token":"second-secret"}}))
            .unwrap(),
        )
        .unwrap();
    let id = format!("official:{}", target.id);
    let original = std::fs::read(home.path().join("auth.json")).unwrap();
    let list = channel_list_at(&state, home.path(), &state.config.read().await.clone()).unwrap();
    assert_eq!(
        list["channels"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "official")
            .count(),
        2
    );
    assert!(!list.to_string().contains("second-secret"));
    change_channel_at(
        &state,
        &json!({"channelId":id,"model":"official-model","expectedRevision":0}),
        true,
        home.path(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        original
    );
    let switched = change_channel_at(
        &state,
        &json!({"channelId":id,"expectedRevision":1}),
        false,
        home.path(),
    )
    .await
    .unwrap();
    assert_eq!(switched["restartRequired"], true);
    assert_eq!(switched["channelList"]["effectiveProviderId"], "openai");
    let auth: Value =
        serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(auth, target.auth);
    assert!(state.runtime.lock().await.is_none());
    change_channel_at(
        &state,
        &json!({"channelId":"provider:b.dot","model":"provider-model","expectedRevision":2}),
        true,
        home.path(),
    )
    .await
    .unwrap();
    change_channel_at(
        &state,
        &json!({"channelId":"provider:b.dot","expectedRevision":3}),
        false,
        home.path(),
    )
    .await
    .unwrap();
    let after: Value =
        serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(after, target.auth);
}
