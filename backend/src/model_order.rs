use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model_id;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelOrderMode {
    Official,
    Manual,
}

pub fn official_order(models: &[Value]) -> Vec<String> {
    let mut visible = models
        .iter()
        .filter(|model| model["visibility"] == "list")
        .collect::<Vec<_>>();
    visible.sort_by_key(|model| model["priority"].as_u64().unwrap_or(u64::MAX));
    model_id::dedupe_preserving_first(visible.iter().filter_map(|model| model["slug"].as_str()))
}

pub fn sort_models(models: &mut [String], order: &[String], match_aliases: bool) {
    let positions = order
        .iter()
        .enumerate()
        .map(|(index, model)| (model_id::key(model), index))
        .collect::<HashMap<_, _>>();
    models.sort_by_key(|model| {
        positions
            .get(&model_id::key(model))
            .or_else(|| {
                match_aliases
                    .then(|| model_id::parse_alias(model))
                    .flatten()
                    .and_then(|alias| positions.get(&model_id::key(alias.upstream_model)))
            })
            .copied()
            .unwrap_or(usize::MAX)
    });
}

pub fn sort_catalog(models: &mut [Value], order: &[String]) {
    let positions = order
        .iter()
        .enumerate()
        .map(|(index, model)| (model_id::key(model), index))
        .collect::<HashMap<_, _>>();
    models.sort_by_key(|model| {
        positions
            .get(&model_id::key(model["slug"].as_str().unwrap_or("")))
            .copied()
            .unwrap_or(usize::MAX)
    });
    for (index, model) in models.iter_mut().enumerate() {
        model["priority"] = serde_json::json!(index);
    }
}
