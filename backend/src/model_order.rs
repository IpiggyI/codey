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

pub(crate) fn apply_provider_order(
    config: &mut crate::config::CodeyConfig,
    provider_key: &str,
    order: &[String],
) {
    if order.is_empty()
        || config.model_order_mode_by_provider.get(provider_key) == Some(&ModelOrderMode::Manual)
    {
        return;
    }
    let upstream = config
        .upstream_models_by_provider
        .get(provider_key)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if let Some(models) = config.selected_models_by_provider.get_mut(provider_key) {
        sort_models(models, upstream, false);
        sort_models(models, order, true);
    }
}

pub fn official_order(models: &[Value]) -> Vec<String> {
    let mut visible = models
        .iter()
        .filter(|model| model["visibility"] == "list")
        .collect::<Vec<_>>();
    visible.sort_by_key(|model| model["priority"].as_u64().unwrap_or(u64::MAX));
    model_id::dedupe_preserving_first(visible.iter().filter_map(|model| model["slug"].as_str()))
}

fn order_positions(order: &[String]) -> HashMap<String, usize> {
    order
        .iter()
        .enumerate()
        .map(|(index, model)| (model_id::key(model), index))
        .collect()
}

fn order_position(
    positions: &HashMap<String, usize>,
    model: &str,
    match_aliases: bool,
) -> Option<usize> {
    positions.get(&model_id::key(model)).copied().or_else(|| {
        match_aliases
            .then(|| model_id::parse_alias(model))
            .flatten()
            .and_then(|alias| positions.get(&model_id::key(alias.upstream_model)).copied())
    })
}

pub fn sort_models(models: &mut [String], order: &[String], match_aliases: bool) {
    let positions = order_positions(order);
    models.sort_by_key(|model| {
        order_position(&positions, model, match_aliases).unwrap_or(usize::MAX)
    });
}

/// 同步发现的新模型（上次上游清单里没有的）加入已选清单。已选模型的顺序不变，
/// 新模型插在官方顺序排在它之后的已选模型中最靠前的一个之前，因此新一代模型
/// 即使在手动排序的清单里也排在旧模型前面；官方顺序里没有它时追加到末尾。
/// 没有上次清单（首次同步）时不自动选择，保持原来由用户勾选的流程。
pub(crate) fn select_new_provider_models(
    config: &mut crate::config::CodeyConfig,
    provider_id: &str,
    previous_upstream: Option<&[String]>,
    fetched: &[String],
    order: impl FnOnce() -> Vec<String>,
) {
    let Some(previous_upstream) = previous_upstream else {
        return;
    };
    let Some(selected) = config.selected_models_by_provider.get_mut(provider_id) else {
        return;
    };
    let known = previous_upstream
        .iter()
        .chain(selected.iter())
        .map(|model| model_id::key(model))
        .collect::<std::collections::HashSet<_>>();
    let added = model_id::dedupe_preserving_first(
        fetched
            .iter()
            .map(String::as_str)
            .filter(|model| !known.contains(&model_id::key(model))),
    );
    if added.is_empty() {
        return;
    }
    insert_by_official_position(selected, &added, &order());
}

fn insert_by_official_position(models: &mut Vec<String>, added: &[String], order: &[String]) {
    let positions = order_positions(order);
    let mut added = added.to_vec();
    sort_models(&mut added, order, true);
    for model in added {
        let index = order_position(&positions, &model, true).and_then(|position| {
            models.iter().position(|existing| {
                order_position(&positions, existing, true)
                    .is_some_and(|existing_position| existing_position > position)
            })
        });
        models.insert(index.unwrap_or(models.len()), model);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const OFFICIAL: [&str; 6] = [
        "gpt-6.2-sol",
        "gpt-6.2-astra",
        "gpt-6.1-terra",
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-5.5",
    ];

    fn config_with(selected: &[&str]) -> crate::config::CodeyConfig {
        let mut config = crate::config::CodeyConfig::default();
        config
            .selected_models_by_provider
            .insert("relay".into(), strings(selected));
        config
    }

    #[test]
    fn new_models_take_their_official_position_and_keep_the_manual_order() {
        // 手动排序：6-astra 被拖到最前；新一代模型排在它前面，已有模型的相对顺序不变。
        let mut config =
            config_with(&["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "relay-only"]);
        let previous = strings(&[
            "gpt-6-astra",
            "gpt-6.1-sol",
            "gpt-6.1-terra",
            "relay-only",
            "gpt-5.5",
        ]);
        let fetched = strings(&[
            "gpt-6.2-astra",
            "gpt-6.2-sol",
            "gpt-6-astra",
            "gpt-6.1-sol",
            "gpt-6.1-terra",
            "relay-only",
            "gpt-5.5",
            "relay-new",
        ]);
        select_new_provider_models(&mut config, "relay", Some(&previous), &fetched, || {
            strings(&OFFICIAL)
        });
        assert_eq!(
            config.selected_models_by_provider["relay"],
            [
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6-astra",
                "gpt-6.1-sol",
                "gpt-6.1-terra",
                "relay-only",
                "relay-new"
            ]
        );
    }

    #[test]
    fn official_order_list_gets_new_models_at_the_top() {
        let mut config = config_with(&["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
        let previous = strings(&["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]);
        let fetched = strings(&[
            "gpt-6.1-terra",
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6.2-sol",
            "gpt-6.2-astra",
        ]);
        select_new_provider_models(&mut config, "relay", Some(&previous), &fetched, || {
            strings(&OFFICIAL)
        });
        assert_eq!(
            config.selected_models_by_provider["relay"],
            [
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6.1-terra",
                "gpt-6.1-sol",
                "gpt-6-astra"
            ]
        );
    }

    #[test]
    fn models_the_user_left_unselected_or_a_first_sync_are_not_selected() {
        let mut config = config_with(&["gpt-6.1-sol"]);
        let previous = strings(&["gpt-6.1-sol", "gpt-5.5"]);
        let fetched = strings(&["gpt-6.1-sol", "gpt-5.5"]);
        select_new_provider_models(&mut config, "relay", Some(&previous), &fetched, || {
            panic!("没有新模型时不读取官方顺序")
        });
        assert_eq!(config.selected_models_by_provider["relay"], ["gpt-6.1-sol"]);

        select_new_provider_models(
            &mut config,
            "relay",
            None,
            &strings(&["gpt-6.2-sol"]),
            || strings(&OFFICIAL),
        );
        assert_eq!(config.selected_models_by_provider["relay"], ["gpt-6.1-sol"]);
    }
}
