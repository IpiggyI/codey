use serde_json::{Value, json};
use std::fs;

fn write_official_cache(home: &std::path::Path) -> Vec<String> {
    let selected = vec!["gpt-5.6-sol".to_string(), "gpt-5.5".to_string()];
    let models = selected
        .iter()
        .zip(["3000", "2911"])
        .map(|(slug, identity)| {
            json!({
                "slug": slug,
                "visibility": "list",
                "description": "测试模型",
                "base_instructions": "测试指令",
                "comp_hash": identity,
                "supported_reasoning_levels": [{"effort": "high"}],
                "default_reasoning_level": "high"
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        home.join("models_cache.json"),
        serde_json::to_vec(&json!({"models":models})).unwrap(),
    )
    .unwrap();
    selected
}

#[test]
fn local_provider_model_ids_do_not_inherit_official_compaction_identities() {
    let home = tempfile::tempdir().unwrap();
    let selected = write_official_cache(home.path());
    crate::model_catalog::refresh_for_provider(home.path(), false, Some(&selected), &selected)
        .unwrap();
    let catalog: Value = serde_json::from_slice(
        &fs::read(
            home.path()
                .join(crate::model_catalog_store::DERIVED_CATALOG_FILE_NAME),
        )
        .unwrap(),
    )
    .unwrap();
    let actual = catalog["models"].as_array().unwrap();
    for slug in &selected {
        let model = actual.iter().find(|model| model["slug"] == *slug).unwrap();
        assert!(model.get("comp_hash").is_none(), "{model}");
    }
    // 此测试核实目录继承；实际切换模型时的压缩次数需由 Codex 运行验收。
}

#[test]
fn official_entries_keep_compaction_identities_for_official_and_mixed_providers() {
    for official_provider in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let official_models = write_official_cache(home.path());
        let third_party = vec!["third-party-model".to_string()];
        let selected = if official_provider {
            &official_models
        } else {
            &third_party
        };
        super::refresh_catalog(super::CatalogRefreshArgs {
            codex_app_path: "",
            codex_home: home.path(),
            catalog_dir: home.path(),
            official_provider,
            include_official_models: true,
            upstream_models: Some(selected),
            selected_models: selected,
            excluded_official_models: &[],
            websocket_models: None,
            native_web_search_models: None,
            context_1m_models: None,
            user_catalog: None,
        })
        .unwrap();
        let catalog = super::read_derived_catalog(home.path()).unwrap();
        let models = catalog["models"].as_array().unwrap();
        for (slug, identity) in official_models.iter().zip(["3000", "2911"]) {
            let model = models.iter().find(|model| model["slug"] == *slug).unwrap();
            assert_eq!(model["comp_hash"], identity, "{official_provider}: {model}");
        }
        if !official_provider {
            let model = models
                .iter()
                .find(|model| model["slug"] == third_party[0])
                .unwrap();
            assert!(model.get("comp_hash").is_none(), "{model}");
        }
    }
}
