use std::path::Path;

use anyhow::{Context, Result, bail};
use codey_runtime_core::config_manager::ConfigManager;
use serde::Serialize;
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item};

use crate::config::CodeyConfig;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub id: String,
    pub kind: &'static str,
    pub provider_id: String,
    pub display_name: String,
    pub default_model: Option<String>,
    pub model_options: Vec<String>,
    pub switch_model: Option<String>,
    pub switch_model_source: Option<&'static str>,
    pub current: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelList {
    pub channels: Vec<Channel>,
    pub selected_channel_id: Option<String>,
    pub effective_provider_id: String,
    pub notice: Option<String>,
}

pub(crate) struct Resolution {
    pub provider_id: String,
    pub channel_id: Option<String>,
    pub default_model: Option<String>,
    pub notice: Option<String>,
}

fn provider_entries(document: &DocumentMut, config: &CodeyConfig) -> Vec<Channel> {
    let mut channels = Vec::new();
    if let Some(providers) = document
        .get("model_providers")
        .and_then(Item::as_table_like)
    {
        for (provider_id, provider) in providers.iter() {
            let id = format!("provider:{provider_id}");
            channels.push(Channel {
                default_model: config.default_models_by_channel.get(&id).cloned(),
                model_options: provider_model_options(provider_id, provider, config),
                switch_model: None,
                switch_model_source: None,
                id,
                kind: "provider",
                provider_id: provider_id.to_string(),
                display_name: provider
                    .get("name")
                    .and_then(Item::as_str)
                    .unwrap_or(provider_id)
                    .to_string(),
                current: false,
                available: provider.as_table_like().is_some(),
                unavailable_reason: provider
                    .as_table_like()
                    .is_none()
                    .then(|| "provider 配置必须是表".into()),
            });
        }
    }
    channels
}

fn provider_model_options(provider_id: &str, provider: &Item, config: &CodeyConfig) -> Vec<String> {
    let snapshot = crate::model_ownership::CurrentProviderSnapshot::from_parts(
        provider_id,
        provider
            .get("base_url")
            .and_then(Item::as_str)
            .unwrap_or(""),
        "responses",
        false,
    );
    let mut config = config.clone();
    config.migrate_current_provider_model_lists(&snapshot);
    crate::model_id::dedupe_preserving_first(
        [
            &config.selected_models_by_provider,
            &config.upstream_models_by_provider,
            &config.manual_third_party_models_by_provider,
            &config.declared_official_models_by_provider,
        ]
        .into_iter()
        .filter_map(|map| map.get(&snapshot.ownership_key))
        .flatten()
        .map(String::as_str),
    )
}

pub(crate) fn switch_model(
    document: &DocumentMut,
    config: &CodeyConfig,
    id: &str,
) -> Option<(String, &'static str)> {
    [
        (
            config.default_models_by_channel.get(id).map(String::as_str),
            "channel",
        ),
        (Some(config.default_model.as_str()), "global"),
        (document.get("model").and_then(Item::as_str), "codex-config"),
    ]
    .into_iter()
    .find_map(|(model, source)| {
        model
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(|model| (model.to_string(), source))
    })
}

pub(crate) fn require_switch_model(home: &Path, config: &CodeyConfig, id: &str) -> Result<String> {
    let loaded = ConfigManager::new(home.join("config.toml")).load()?;
    switch_model(loaded.document(), config, id)
        .map(|(model, _)| model)
        .context("请先设置默认模型：渠道、Codey 全局或 Codex 配置中至少需要一个默认模型")
}

fn official_entry(home: &Path, document: &DocumentMut, config: &CodeyConfig) -> Channel {
    let mut channel = Channel {
        id: "official:unavailable".into(),
        kind: "official",
        provider_id: "openai".into(),
        display_name: "OpenAI 官方账号".into(),
        default_model: None,
        model_options: Vec::new(),
        switch_model: None,
        switch_model_source: None,
        current: false,
        available: false,
        unavailable_reason: None,
    };
    match official_identity(home, document) {
        Ok(id) => {
            channel.default_model = config.default_models_by_channel.get(&id).cloned();
            channel.id = id;
            channel.available = true;
        }
        Err(reason) => channel.unavailable_reason = Some(reason.into()),
    }
    channel
}

fn official_identity(home: &Path, document: &DocumentMut) -> Result<String, &'static str> {
    let path = home.join("auth.json");
    let bytes = std::fs::read(&path).map_err(|_| "无法读取官方登录文件")?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "官方登录文件不是有效的 JSON")?;
    let auth = crate::account_usage::read_official_auth(&path).map_err(|_| "官方登录不可用")?;
    let account = auth
        .account_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or("官方登录缺少稳定账号标识，不能选择该渠道")?;
    if !crate::codex_provider::official_channel_available(document, &value) {
        return Err("openai provider 配置不支持当前官方登录");
    }
    Ok(format!("official:{:x}", Sha256::digest(account.as_bytes())))
}

pub(crate) fn resolve(
    home: &Path,
    document: &DocumentMut,
    config: &CodeyConfig,
) -> Result<Resolution> {
    let fallback = crate::codex_provider::configured_provider_id(document).to_string();
    let Some(selected) = config.selected_channel_id.as_deref() else {
        return Ok(Resolution {
            provider_id: fallback,
            channel_id: None,
            default_model: None,
            notice: None,
        });
    };
    let channel = if selected.starts_with("provider:") {
        provider_entries(document, config)
            .into_iter()
            .find(|channel| channel.id == selected)
    } else {
        Some(official_entry(home, document, config)).filter(|channel| channel.id == selected)
    };
    if let Some(channel) = channel.filter(|channel| channel.available) {
        return Ok(Resolution {
            provider_id: channel.provider_id,
            channel_id: Some(channel.id.clone()),
            default_model: switch_model(document, config, &channel.id).map(|(model, _)| model),
            notice: None,
        });
    }
    Ok(Resolution {
        provider_id: fallback,
        channel_id: None,
        default_model: None,
        notice: Some("所选渠道已不可用，已回退到用户配置的默认 provider。".into()),
    })
}

pub(crate) fn list(home: &Path, config: &CodeyConfig) -> Result<ChannelList> {
    let loaded = ConfigManager::new(home.join("config.toml")).load()?;
    let document = loaded.document();
    let resolved = resolve(home, document, config)?;
    let mut channels = provider_entries(document, config);
    channels.push(official_entry(home, document, config));
    let catalog_dir = if cfg!(test) {
        home.to_path_buf()
    } else {
        crate::codex_config::codey_model_catalog_dir()
    };
    let official_models =
        crate::codex_config::configured_user_model_catalog_path(home, &catalog_dir)
            .and_then(|user_catalog| {
                crate::model_catalog::available_official_models(
                    home,
                    &catalog_dir,
                    user_catalog.as_deref(),
                    &config.codex_app_path,
                )
            })
            .map(|models| {
                models
                    .into_iter()
                    .map(|model| model.slug)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|error| {
                eprintln!("读取渠道官方模型候选失败：{error:#}");
                Vec::new()
            });
    let has_provider = channels
        .iter()
        .any(|channel| channel.kind == "provider" && channel.provider_id == resolved.provider_id);
    for channel in &mut channels {
        if channel.kind == "official" {
            channel.model_options = official_models.clone();
        }
        if let Some((model, source)) = switch_model(document, config, &channel.id) {
            channel.switch_model = Some(model);
            channel.switch_model_source = Some(source);
        }
        channel.current = match &resolved.channel_id {
            Some(id) => channel.id == *id,
            None => {
                channel.provider_id == resolved.provider_id
                    && (channel.kind == "provider" || (!has_provider && channel.available))
            }
        };
    }
    Ok(ChannelList {
        channels,
        selected_channel_id: config.selected_channel_id.clone(),
        effective_provider_id: resolved.provider_id,
        notice: resolved.notice,
    })
}

pub(crate) fn select(home: &Path, config: &mut CodeyConfig, id: Option<&str>) -> Result<()> {
    if let Some(id) = id {
        let channel = list(home, config)?
            .channels
            .into_iter()
            .find(|channel| channel.id == id && channel.available)
            .context("所选渠道不可用")?;
        require_switch_model(home, config, &channel.id)?;
    }
    config.selected_channel_id = id.map(str::to_string);
    Ok(())
}

pub(crate) fn list_with_accounts(
    home: &Path,
    config: &CodeyConfig,
    store: &crate::official_accounts::OfficialAccountStore,
) -> Result<ChannelList> {
    let mut list = list(home, config)?;
    let official_models = list
        .channels
        .iter()
        .find(|channel| channel.kind == "official")
        .map(|channel| channel.model_options.clone())
        .unwrap_or_default();
    let loaded = ConfigManager::new(home.join("config.toml")).load()?;
    let document = loaded.document();
    let disabled = crate::official_accounts::switch_disabled_reason(home)?;
    let current = crate::official_accounts::current_id(home)?;
    for account in store.accounts()? {
        let id = format!("official:{}", account.id);
        let summary = account.summary(current.as_deref());
        let provider_ok =
            crate::codex_provider::official_channel_available(document, &account.auth);
        let reason = disabled
            .clone()
            .or_else(|| (!provider_ok).then(|| "openai provider 配置不支持官方登录".into()));
        let model = switch_model(document, config, &id);
        list.channels
            .retain(|channel| channel.id != id && channel.id != "official:unavailable");
        list.channels.push(Channel {
            default_model: config.default_models_by_channel.get(&id).cloned(),
            model_options: official_models.clone(),
            switch_model: model.as_ref().map(|(model, _)| model.clone()),
            switch_model_source: model.map(|(_, source)| source),
            current: current.as_deref() == Some(&account.id)
                && list.effective_provider_id == "openai",
            id,
            kind: "official",
            provider_id: "openai".into(),
            display_name: summary["email"]
                .as_str()
                .unwrap_or("OpenAI 官方账号")
                .into(),
            available: reason.is_none(),
            unavailable_reason: reason,
        });
    }
    Ok(list)
}

pub(crate) fn set_default(
    home: &Path,
    config: &mut CodeyConfig,
    id: &str,
    model: &str,
) -> Result<()> {
    let model = model.trim();
    if model.is_empty() {
        bail!("渠道默认模型不能为空");
    }
    if !list(home, config)?
        .channels
        .iter()
        .any(|channel| channel.id == id && channel.available)
    {
        bail!("所选渠道不可用");
    }
    config
        .default_models_by_channel
        .insert(id.to_string(), model.to_string());
    Ok(())
}

pub(crate) fn runtime_overrides(home: &Path, config: &CodeyConfig) -> Result<Vec<String>> {
    let loaded = ConfigManager::new(home.join("config.toml")).load()?;
    let resolved = resolve(home, loaded.document(), config)?;
    if resolved.channel_id.is_none() {
        return Ok(Vec::new());
    }
    let model = resolved
        .default_model
        .context("请先设置默认模型：渠道、Codey 全局或 Codex 配置中至少需要一个默认模型")?;
    Ok(vec![
        format!(
            "model_provider={}",
            toml_edit::Value::from(resolved.provider_id)
        ),
        format!("model={}", toml_edit::Value::from(model)),
    ])
}

#[cfg(test)]
pub(crate) mod tests;
