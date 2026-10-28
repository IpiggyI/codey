use super::*;

pub(crate) fn fixture() -> (tempfile::TempDir, CodeyConfig) {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        r#"model_provider = "a"
model = "original-model"
[model_providers.a]
name = "A"
base_url = "https://a.example/v1"
experimental_bearer_token = "fixture-a"
[model_providers."b.dot"]
name = "B"
base_url = "https://b.example/v1"
experimental_bearer_token = "fixture-b"
"#,
    )
    .unwrap();
    std::fs::write(
        home.path().join("auth.json"),
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture","account_id":"account-one"}}"#,
    )
    .unwrap();
    (home, CodeyConfig::default())
}

pub(crate) fn selected_fixture() -> (tempfile::TempDir, CodeyConfig) {
    let (home, mut config) = fixture();
    set_default(
        home.path(),
        &mut config,
        "provider:b.dot",
        "model.with.\"quote",
    )
    .unwrap();
    select(home.path(), &mut config, Some("provider:b.dot")).unwrap();
    let snapshot =
        crate::codex_provider::current_provider_snapshot_for_config(home.path(), &config).unwrap();
    config.attach_current_provider_snapshot(snapshot);
    (home, config)
}

#[test]
fn channels_list_selection_and_quoted_runtime_values() {
    let (home, mut config) = fixture();
    let channels = list(home.path(), &config).unwrap();
    assert_eq!(channels.channels.len(), 3);
    assert!(channels.channels[0].current);
    assert!(channels.channels[2].id.starts_with("official:"));
    assert_eq!(channels.channels[2].provider_id, "openai");
    assert_eq!(channels.channels[1].default_model, None);
    assert!(select(home.path(), &mut config, Some("provider:b.dot")).is_err());
    assert_eq!(config.selected_channel_id, None);
    let model = "model.with.\"quote";
    set_default(home.path(), &mut config, "provider:b.dot", model).unwrap();
    select(home.path(), &mut config, Some("provider:b.dot")).unwrap();
    let overrides = runtime_overrides(home.path(), &config).unwrap();
    let parsed = overrides.join("\n").parse::<DocumentMut>().unwrap();
    assert_eq!(parsed["model_provider"].as_str(), Some("b.dot"));
    assert_eq!(parsed["model"].as_str(), Some(model));
    assert_eq!(
        list(home.path(), &config).unwrap().effective_provider_id,
        "b.dot"
    );
    let official = channels.channels[2].id.clone();
    set_default(home.path(), &mut config, &official, "official-model").unwrap();
    select(home.path(), &mut config, Some(&official)).unwrap();
    assert_eq!(
        runtime_overrides(home.path(), &config).unwrap(),
        vec!["model_provider=\"openai\"", "model=\"official-model\""]
    );
    select(home.path(), &mut config, None).unwrap();
    assert!(runtime_overrides(home.path(), &config).unwrap().is_empty());
}

#[test]
fn channels_official_selection_without_default_model_fails_like_other_channels() {
    let (home, mut config) = fixture();
    let official = list(home.path(), &config).unwrap().channels[2].id.clone();
    assert!(official.starts_with("official:"));
    config.selected_channel_id = Some(official);
    assert!(config.default_model.is_empty());
    let error = runtime_overrides(home.path(), &config).unwrap_err();
    assert!(
        error.to_string().contains("所选渠道缺少默认模型"),
        "{error}"
    );
}

#[test]
fn channels_missing_selection_falls_back_to_profile_with_notice() {
    let (home, mut config) = selected_fixture();
    std::fs::write(home.path().join("config.toml"), "model_provider='root'\nprofile='work'\n[profiles.work]\nmodel_provider='profile-provider'\n[model_providers.profile-provider]\nbase_url='https://fallback.example/v1'\n").unwrap();
    let channels = list(home.path(), &config).unwrap();
    assert_eq!(
        channels.selected_channel_id.as_deref(),
        Some("provider:b.dot")
    );
    assert_eq!(channels.effective_provider_id, "profile-provider");
    assert!(channels.notice.as_deref().unwrap().contains("回退"));
    assert!(channels.channels[0].current);
    assert!(runtime_overrides(home.path(), &config).unwrap().is_empty());
    let snapshot =
        crate::codex_provider::current_provider_snapshot_for_config(home.path(), &config).unwrap();
    assert_eq!(snapshot.id, "profile-provider");
    config.attach_current_provider_snapshot(snapshot);
    assert_eq!(config.default_model(), None);
}

#[test]
fn channels_model_sync_uses_selected_provider_credentials() {
    let (home, config) = selected_fixture();
    let sync = crate::codex_provider::current_provider_model_sync_for_config_with_env(
        home.path(),
        &config,
        &|_| None,
    )
    .unwrap();
    assert_eq!(sync.snapshot.id, "b.dot");
    assert_eq!(sync.request.base_url, "https://b.example/v1");
    assert_eq!(sync.request.api_key, "fixture-b");
}

#[test]
fn channels_current_provider_display_matches_selected_channel() {
    let (home, config) = selected_fixture();
    let provider =
        crate::codex_provider::current_provider_for_config(home.path(), &config).unwrap();
    assert_eq!(provider.id, "b.dot");
    assert_eq!(provider.name, "B");
    assert_eq!(
        crate::codex_provider::status_from_config(&config)
            .provider
            .id,
        provider.id
    );
}

#[test]
fn channels_subagent_catalog_uses_selected_provider_models() {
    let (_home, mut config) = selected_fixture();
    let key = config
        .current_provider_snapshot
        .as_ref()
        .unwrap()
        .ownership_key
        .clone();
    config
        .selected_models_by_provider
        .insert(key.clone(), vec!["b-only".into()]);
    config
        .upstream_models_by_provider
        .insert(key, vec!["b-only".into()]);
    config
        .selected_models_by_provider
        .insert("a".into(), vec!["a-only".into()]);
    let catalog = crate::subagent_policy::catalog_snapshot_for_config(&config);
    assert_eq!(catalog.provider_id, "b.dot");
    assert_eq!(catalog.models, vec!["b-only"]);
}

#[test]
fn channels_config_defaults_preserve_legacy_and_channel_models() {
    let legacy: CodeyConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(legacy.selected_channel_id, None);
    assert!(legacy.default_models_by_channel.is_empty());
    let (home, mut config) = selected_fixture();
    config.default_model = "global-model".into();
    assert_eq!(config.default_model(), Some("model.with.\"quote"));
    let store = crate::config::ConfigStore::new(home.path().join("codey.json"));
    store.save(&config).unwrap();
    let saved = store.load().unwrap();
    assert_eq!(saved.selected_channel_id, config.selected_channel_id);
    assert_eq!(
        saved.default_models_by_channel,
        config.default_models_by_channel
    );
    select(home.path(), &mut config, None).unwrap();
    assert_eq!(config.default_model(), Some("global-model"));
}

#[test]
fn provider_channels_survive_malformed_or_unreadable_official_login() {
    let (home, config) = selected_fixture();
    let path = home.path().join("auth.json");
    for unreadable in [false, true] {
        std::fs::remove_file(&path).unwrap();
        if unreadable {
            std::fs::create_dir(&path).unwrap();
        } else {
            std::fs::write(&path, "{half-written").unwrap();
        }
        assert_eq!(
            crate::codex_provider::current_provider_snapshot_for_config(home.path(), &config)
                .unwrap()
                .id,
            "b.dot"
        );
        assert_eq!(
            crate::codex_provider::current_provider_for_config(home.path(), &config)
                .unwrap()
                .id,
            "b.dot"
        );
        assert_eq!(runtime_overrides(home.path(), &config).unwrap().len(), 2);
        let listed = list(home.path(), &config).unwrap();
        assert_eq!(listed.effective_provider_id, "b.dot");
        assert!(listed.notice.is_none());
        let official = listed
            .channels
            .iter()
            .find(|c| c.kind == "official")
            .unwrap();
        assert!(!official.available);
        assert!(official.unavailable_reason.is_some());
        if unreadable {
            std::fs::remove_dir(&path).unwrap();
        }
    }
}

#[test]
fn channels_official_selection_with_malformed_auth_fails_after_openai_fallback() {
    let (home, mut config) = fixture();
    std::fs::write(home.path().join("config.toml"), "model_provider='openai'\n").unwrap();
    let official = list(home.path(), &config)
        .unwrap()
        .channels
        .into_iter()
        .find(|channel| channel.kind == "official")
        .unwrap();
    set_default(home.path(), &mut config, &official.id, "official-model").unwrap();
    select(home.path(), &mut config, Some(&official.id)).unwrap();
    std::fs::write(home.path().join("auth.json"), "{half-written").unwrap();
    let listed = list(home.path(), &config).unwrap();
    assert_eq!(listed.effective_provider_id, "openai");
    assert!(listed.notice.is_some());
    let snapshot =
        crate::codex_provider::current_provider_snapshot_for_config(home.path(), &config);
    let display = crate::codex_provider::current_provider_for_config(home.path(), &config);
    assert!(
        snapshot
            .as_ref()
            .is_err_and(|error| error.to_string().contains("解析本地 Codex 认证失败"))
            && display
                .as_ref()
                .is_err_and(|error| error.to_string().contains("解析本地 Codex 认证失败")),
        "snapshot={snapshot:?}, display={display:?}"
    );
}

#[test]
fn official_channel_without_stable_identity_cannot_be_selected() {
    let (home, mut config) = fixture();
    std::fs::write(
        home.path().join("auth.json"),
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture"}}"#,
    )
    .unwrap();
    let listed = list(home.path(), &config).unwrap();
    let official = listed
        .channels
        .iter()
        .find(|c| c.kind == "official")
        .unwrap();
    assert!(!official.available);
    assert!(
        official
            .unavailable_reason
            .as_deref()
            .unwrap()
            .contains("稳定账号标识")
    );
    config
        .default_models_by_channel
        .insert(official.id.clone(), "model".into());
    assert!(select(home.path(), &mut config, Some(&official.id)).is_err());
    assert!(config.selected_channel_id.is_none());
}
