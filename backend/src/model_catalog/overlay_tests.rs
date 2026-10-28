use super::*;

#[test]
fn generated_user_overlay_keeps_required_model_without_prior_derived_catalog() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("custom.json");
    let user = br#"{"models":[{"slug":"external","description":"external","base_instructions":"external"}]}"#;
    fs::write(&source, user).unwrap();
    fs::write(home.path().join("models_cache.json"), serde_json::to_vec(&json!({"models":[{
        "slug":"gpt-5.5", "visibility":"list", "description":"required", "base_instructions":"required",
        "context_window":400000, "codey_context_source":"official_catalog"
    }]})).unwrap()).unwrap();
    refresh_catalog(CatalogRefreshArgs {
        codex_app_path: "",
        codex_home: home.path(),
        catalog_dir: home.path(),
        official_provider: false,
        include_official_models: false,
        upstream_models: Some(&["gpt-5.5".into()]),
        selected_models: &["gpt-5.5".into()],
        excluded_official_models: &[],
        websocket_models: None,
        native_web_search_models: None,
        context_1m_models: None,
        user_catalog: Some(&source),
    })
    .unwrap();
    let catalog = read_derived_catalog(home.path()).unwrap();
    let model = catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["slug"] == "gpt-5.5")
        .unwrap();
    assert_eq!(model["context_window"], 400000);
    assert_eq!(fs::read(source).unwrap(), user);
}

#[test]
fn custom_context_overlay_keeps_required_models_after_budget_removal() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("custom.json");
    let source_bytes = br#"{"models":[{"slug":"external/model","custom":true}]}"#;
    fs::write(&source, source_bytes).unwrap();
    let mut original_model = json!({
        "slug": "custom-model",
        "description": "Runtime",
        "base_instructions": "Instructions",
        "context_window": 320000,
        "effective_context_window_percent": 91,
        "codey_context_source": "official_catalog",
        "custom": [1, 2]
    });
    configure_1m_context_window(&mut original_model, &HashSet::new());
    let policies = BTreeMap::from([(
        "custom-model".into(),
        crate::config::ModelContextConfig {
            context_window_tokens: 128_000,
            auto_compact_token_limit: Some(100_000),
            reserve_output_tokens: Some(16_000),
        },
    )]);
    let mut cached_model = original_model.clone();
    apply_model_context(&mut cached_model, policies.values().next()).unwrap();
    let runtime_path = derived_catalog_path(home.path());
    fs::create_dir_all(runtime_path.parent().unwrap()).unwrap();
    let runtime_bytes = serde_json::to_vec(&json!({"models": [cached_model]})).unwrap();
    fs::write(&runtime_path, &runtime_bytes).unwrap();
    let required = vec!["CUSTOM-MODEL".to_string(), "custom-model".to_string()];

    let first =
        prepare_context_catalog_overlay(home.path(), &source, &policies, &required).unwrap();
    let first_bytes = fs::read(&first).unwrap();
    let with_budget: Value = serde_json::from_slice(&first_bytes).unwrap();
    assert_eq!(with_budget["models"].as_array().unwrap().len(), 2);
    assert_eq!(with_budget["models"][1], cached_model);

    let second =
        prepare_context_catalog_overlay(home.path(), &source, &BTreeMap::new(), &required).unwrap();
    let without_budget: Value = serde_json::from_slice(&fs::read(&second).unwrap()).unwrap();
    assert_eq!(without_budget["models"].as_array().unwrap().len(), 2);
    assert_eq!(without_budget["models"][1], original_model);
    assert_ne!(first, second);
    assert_eq!(fs::read(&first).unwrap(), first_bytes);
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert_eq!(fs::read(&runtime_path).unwrap(), runtime_bytes);
}

#[test]
fn custom_context_overlay_required_only_preserves_plugin_and_unmarked_metadata() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("custom.json");
    fs::write(&source, br#"{"models":[]}"#).unwrap();
    let models = vec![
        json!({
            "slug": "plugin-model",
            "description": "Plugin model",
            "base_instructions": "Plugin instructions",
            "context_window": 918000,
            "codey_context_source": "plugin_declared",
            "codey_context_base": {"context_window": 272000},
            "custom": {"nested": [1, 2]}
        }),
        json!({
            "slug": "unmarked-model",
            "description": "Unmarked model",
            "base_instructions": "Unmarked instructions",
            "context_window": 1000000,
            "codey_source": "third_party"
        }),
    ];
    let runtime_path = derived_catalog_path(home.path());
    fs::create_dir_all(runtime_path.parent().unwrap()).unwrap();
    fs::write(
        &runtime_path,
        serde_json::to_vec(&json!({"models": models})).unwrap(),
    )
    .unwrap();
    let required = vec![
        "plugin-model".into(),
        "unmarked-model".into(),
        "PLUGIN-MODEL".into(),
    ];

    let overlay = render_context_catalog_overlay_with_required_models(
        home.path(),
        &source,
        &BTreeMap::new(),
        &required,
    )
    .unwrap()
    .unwrap();
    let projected: Value = serde_json::from_slice(&overlay).unwrap();
    assert_eq!(projected["models"], json!(models));
}

#[test]
fn custom_context_overlay_complete_required_catalog_reuses_source() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("custom.json");
    let source_bytes = br#"{"models":[{"slug":"custom-model","context_window":1000000,"codey_context_source":"user_declared","codey_context_base":{"context_window":272000}}]}"#;
    fs::write(&source, source_bytes).unwrap();
    let runtime_path = derived_catalog_path(home.path());
    fs::create_dir_all(runtime_path.parent().unwrap()).unwrap();
    fs::write(&runtime_path, b"invalid unused fallback").unwrap();
    let required = vec!["CUSTOM-MODEL".into(), "custom-model".into()];

    assert!(
        render_context_catalog_overlay_with_required_models(
            home.path(),
            &source,
            &BTreeMap::new(),
            &required
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        prepare_context_catalog_overlay(home.path(), &source, &BTreeMap::new(), &required).unwrap(),
        source
    );
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert!(
        !home
            .path()
            .join("model-catalogs/context-overrides")
            .exists()
    );
}

#[test]
fn custom_context_overlay_without_requirements_does_not_read_catalogs() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("missing.json");
    assert!(
        render_context_catalog_overlay_with_required_models(
            home.path(),
            &source,
            &BTreeMap::new(),
            &[]
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        prepare_context_catalog_overlay(home.path(), &source, &BTreeMap::new(), &[]).unwrap(),
        source
    );
    assert!(!home.path().join("model-catalogs").exists());
}
