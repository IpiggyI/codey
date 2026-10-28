use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use anyhow::{Context, Result, bail};
use codey_runtime_core::app_paths::{codex_runtime_executable, resolve_codex_app_dir_with_saved};
use codey_runtime_core::config_manager::ConfigManager;
use serde::Serialize;
use serde_json::Value;
use toml_edit::{DocumentMut, Item, TableLike};

use crate::codex_config::BUILTIN_OPENAI_PROVIDER_ID;
use crate::config::CodeyConfig;
use crate::model_ownership::CurrentProviderSnapshot;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProvider {
    pub id: String,
    pub name: String,
    pub official: bool,
    pub supports_remote_compaction: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_web_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_warning: Option<String>,
    pub base_url: String,
}

/// Native capability metadata extends the existing model-ownership identity.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(flatten)]
    identity: CurrentProviderSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_remote_compaction: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_web_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_warning: Option<String>,
}

impl ProviderSnapshot {
    pub(crate) fn supports_remote_compaction(&self) -> bool {
        self.supports_remote_compaction
            .unwrap_or(self.uses_official_account_auth || self.id == BUILTIN_OPENAI_PROVIDER_ID)
    }

    pub(crate) fn resolved_base_url(&self) -> &str {
        if self.base_url.is_empty() && self.id == BUILTIN_OPENAI_PROVIDER_ID {
            if self.uses_official_account_auth {
                crate::codex_config::CHATGPT_CODEX_BASE_URL
            } else {
                "https://api.openai.com/v1"
            }
        } else {
            &self.base_url
        }
    }

    pub(crate) fn inherit_capabilities(&mut self, previous: &Self) {
        if self.supports_remote_compaction.is_none() && self.identity == previous.identity {
            self.supports_remote_compaction = previous.supports_remote_compaction;
            self.external_web_access = previous.external_web_access;
            self.capability_warning = previous.capability_warning.clone();
        }
    }
}

impl From<CurrentProviderSnapshot> for ProviderSnapshot {
    fn from(identity: CurrentProviderSnapshot) -> Self {
        Self {
            identity,
            channel_id: None,
            supports_remote_compaction: None,
            external_web_access: None,
            capability_warning: None,
        }
    }
}

impl std::ops::Deref for ProviderSnapshot {
    type Target = CurrentProviderSnapshot;

    fn deref(&self) -> &Self::Target {
        &self.identity
    }
}

impl std::ops::DerefMut for ProviderSnapshot {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.identity
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub changed: bool,
    pub provider: CurrentProvider,
}

struct LocalProviderSnapshot {
    provider: CurrentProvider,
    official_account_auth: OfficialAccountAuthProbe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OfficialAccountAuthProbe {
    Available(String),
    Unavailable(String),
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeLoginStatus {
    ChatGpt,
    NotLoggedIn(String),
    ApiKey(String),
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OfficialAccountProfileStatus {
    Available,
    Unavailable { reason: String },
    Unknown { reason: String },
}

pub fn current_official_account_profile_status_for_launch(
    codex_home: &Path,
    configured_codex_app_path: &str,
) -> Result<OfficialAccountProfileStatus> {
    let executable = resolve_native_status_executable(configured_codex_app_path);
    current_official_account_profile_status_with_probe(codex_home, |home| {
        native_login_status_with_path_fallback(home, &executable)
    })
}

fn current_official_account_profile_status_with_probe(
    codex_home: &Path,
    native_probe: impl FnOnce(&Path) -> NativeLoginStatus,
) -> Result<OfficialAccountProfileStatus> {
    let mut snapshot = local_provider_with_auth_policy(codex_home, AuthProbePolicy::Lenient)?;
    let native_status = native_probe(codex_home);
    snapshot.official_account_auth = if !snapshot.provider.official
        && let NativeLoginStatus::Unknown(reason) = &native_status
    {
        OfficialAccountAuthProbe::Unavailable(format!(
            "当前使用 API Key 或第三方线路，原生探针未确认 ChatGPT 登录，不使用残留凭据推断官方账号；{reason}"
        ))
    } else {
        official_auth_probe_from_native(snapshot.official_account_auth, native_status)
    };
    Ok(match snapshot.official_account_auth {
        OfficialAccountAuthProbe::Available(_) => OfficialAccountProfileStatus::Available,
        OfficialAccountAuthProbe::Unavailable(reason) => {
            OfficialAccountProfileStatus::Unavailable { reason }
        }
        OfficialAccountAuthProbe::Unknown(reason) => {
            OfficialAccountProfileStatus::Unknown { reason }
        }
    })
}

fn official_auth_probe_from_native(
    file_probe: OfficialAccountAuthProbe,
    native_status: NativeLoginStatus,
) -> OfficialAccountAuthProbe {
    match native_status {
        NativeLoginStatus::ChatGpt => OfficialAccountAuthProbe::Available(
            "Codex 原生认证探针确认当前使用 ChatGPT 登录".to_string(),
        ),
        NativeLoginStatus::NotLoggedIn(reason) | NativeLoginStatus::ApiKey(reason) => {
            let file_reason = match file_probe {
                OfficialAccountAuthProbe::Available(reason)
                | OfficialAccountAuthProbe::Unavailable(reason)
                | OfficialAccountAuthProbe::Unknown(reason) => reason,
            };
            OfficialAccountAuthProbe::Unavailable(format!("{reason}；文件凭据探针：{file_reason}"))
        }
        NativeLoginStatus::Unknown(reason) => match file_probe {
            OfficialAccountAuthProbe::Available(file_reason) => {
                OfficialAccountAuthProbe::Available(format!("{reason}；{file_reason}"))
            }
            OfficialAccountAuthProbe::Unavailable(file_reason) => {
                OfficialAccountAuthProbe::Unavailable(format!("{reason}；{file_reason}"))
            }
            OfficialAccountAuthProbe::Unknown(file_reason) => {
                OfficialAccountAuthProbe::Unknown(format!("{reason}；{file_reason}"))
            }
        },
    }
}

pub fn current_provider(codex_home: &Path) -> Result<CurrentProvider> {
    Ok(local_provider(codex_home)?.provider)
}

pub(crate) fn current_provider_for_config(
    codex_home: &Path,
    config: &CodeyConfig,
) -> Result<CurrentProvider> {
    Ok(local_provider_for_config(codex_home, AuthProbePolicy::Strict, config)?.provider)
}

pub(crate) fn current_provider_id_for_config(home: &Path, config: &CodeyConfig) -> Result<String> {
    let loaded = ConfigManager::new(home.join("config.toml")).load()?;
    Ok(crate::channels::resolve(home, loaded.document(), config)?.provider_id)
}

/// Read-only snapshot of the user-owned `config.toml` current provider.
/// Never writes `config.toml`. Parse or schema failures are returned as errors
/// so the caller can refuse to start instead of auto-correcting.
#[cfg(test)]
pub fn current_provider_snapshot(codex_home: &Path) -> Result<ProviderSnapshot> {
    current_provider_snapshot_for_config(codex_home, &CodeyConfig::default())
}

pub(crate) fn current_provider_snapshot_for_config(
    codex_home: &Path,
    codey: &CodeyConfig,
) -> Result<ProviderSnapshot> {
    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path)
        .load()
        .context("解析 Codex 用户配置失败")?;
    let document = config.document();
    let resolution = crate::channels::resolve(codex_home, document, codey)?;
    let provider_id = resolution.provider_id;
    let table = provider_table(document, &provider_id);
    let base_url = table
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str)
        .unwrap_or_default();
    let wire_api = table
        .and_then(|provider| provider.get("wire_api"))
        .and_then(Item::as_str)
        .unwrap_or("responses");
    let normalized = crate::model_ownership::normalize_base_url(base_url);
    let auth = if !provider_has_scoped_credentials(table)
        && document
            .get("experimental_bearer_token")
            .and_then(Item::as_str)
            .is_none_or(|token| token.trim().is_empty())
        && ((normalized.is_empty() && provider_id == BUILTIN_OPENAI_PROVIDER_ID)
            || is_official_base_url(&normalized))
    {
        read_auth_probe(
            &codex_home.join("auth.json"),
            "auto",
            if resolution
                .channel_id
                .as_deref()
                .is_some_and(|id| id.starts_with("provider:"))
            {
                AuthProbePolicy::Lenient
            } else {
                AuthProbePolicy::Strict
            },
        )?
        .value
    } else {
        None
    };
    let uses_official_account_auth =
        uses_official_account_auth(document, &provider_id, table, &normalized, auth.as_ref());
    let capabilities = provider_capabilities(&provider_id, table, uses_official_account_auth);
    if let Some(warning) = &capabilities.warning {
        eprintln!("{warning}");
    }
    Ok(ProviderSnapshot {
        channel_id: resolution.channel_id,
        identity: CurrentProviderSnapshot::from_parts(
            provider_id,
            normalized,
            wire_api,
            uses_official_account_auth,
        ),
        supports_remote_compaction: Some(capabilities.supports_remote_compaction),
        external_web_access: capabilities.external_web_access,
        capability_warning: capabilities.warning,
    })
}

/// Current-provider model sync inputs. Built only from the user-owned Codex
/// config, native credentials and process environment. Never reads stored `ProviderProfile`
/// credentials and never writes `config.toml`.
#[derive(Debug, Clone)]
pub struct CurrentProviderModelSync {
    pub snapshot: CurrentProviderSnapshot,
    pub request: crate::provider_models::ModelSyncRequest,
}

pub const PROMPT_OPTIMIZATION_KEY_STATUS_READY: &str = "ready";
pub const PROMPT_OPTIMIZATION_KEY_STATUS_MISSING: &str = "missing";
pub const PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED: &str = "undeclared";
pub const PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE: &str = "notApplicable";
pub const PROMPT_OPTIMIZATION_KEY_STATUS_UNSUPPORTED: &str = "unsupported";

/// Read-only overlay for prompt optimization. Never includes the secret value.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptOptimizationProviderOverlay {
    pub upstream_protocol: String,
    pub key_status: String,
    pub env_key_name: String,
    pub message: String,
}

#[cfg(test)]
pub fn prompt_optimization_provider_overlay_with_env(
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<PromptOptimizationProviderOverlay> {
    prompt_optimization_provider_overlay_for_config(codex_home, &CodeyConfig::default(), env)
}

pub(crate) fn prompt_optimization_provider_overlay_for_config(
    codex_home: &Path,
    codey: &CodeyConfig,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<PromptOptimizationProviderOverlay> {
    let snapshot = current_provider_snapshot_for_config(codex_home, codey)?;
    if snapshot.uses_official_account_auth {
        return Ok(PromptOptimizationProviderOverlay {
            upstream_protocol: crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES.to_string(),
            key_status: PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE.to_string(),
            env_key_name: String::new(),
            message: "当前 provider 使用官方账号鉴权，提示词优化会复用登录态。".to_string(),
        });
    }

    let protocol = match upstream_protocol_from_wire_api(&snapshot.wire_api) {
        Ok(protocol) => protocol.to_string(),
        Err(_) => {
            return Ok(PromptOptimizationProviderOverlay {
                upstream_protocol: String::new(),
                key_status: PROMPT_OPTIMIZATION_KEY_STATUS_UNSUPPORTED.to_string(),
                env_key_name: String::new(),
                message: format!(
                    "当前 provider 的接口格式「{}」不受提示词优化支持。请改用手工配置，或把 Codex 配置改成 responses、chat 或 Anthropic messages。",
                    snapshot.wire_api
                ),
            });
        }
    };

    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path)
        .load()
        .context("解析 Codex 用户配置失败")?;
    let document = config.document();
    let table = provider_table(document, &snapshot.id);
    let env_key_name = table
        .and_then(|provider| provider.get("env_key"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
        .to_string();

    if let Some(auth) = table.and_then(|provider| provider.get("auth")) {
        let (key_status, message) = match ProviderAuthCommand::parse(&snapshot.id, table, auth) {
            Ok(_) => (
                PROMPT_OPTIMIZATION_KEY_STATUS_READY,
                "已配置 auth.command；使用时从配置的命令获取令牌。状态读取不会执行命令。"
                    .to_string(),
            ),
            Err(error) => (PROMPT_OPTIMIZATION_KEY_STATUS_MISSING, error.to_string()),
        };
        return Ok(PromptOptimizationProviderOverlay {
            upstream_protocol: protocol,
            key_status: key_status.to_string(),
            env_key_name,
            message,
        });
    }

    let credential = resolve_provider_credential(codex_home, document, table, &snapshot.id, env);
    let (key_status, message) = match credential {
        Ok(Some(credential)) => (
            PROMPT_OPTIMIZATION_KEY_STATUS_READY,
            format!(
                "已从 {} 读取密钥，不会写入 Codey 或用户配置。",
                credential.source
            ),
        ),
        Ok(None) if !env_key_name.is_empty() => (
            PROMPT_OPTIMIZATION_KEY_STATUS_MISSING,
            format!("环境变量「{env_key_name}」未设置，且没有其他可用凭据。可以改用手工填写密钥。"),
        ),
        Ok(None) => (
            PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED,
            format!(
                "当前 provider「{}」没有可用的凭据来源。可以改用手工填写密钥。",
                snapshot.id
            ),
        ),
        Err(error) => (PROMPT_OPTIMIZATION_KEY_STATUS_MISSING, error.to_string()),
    };
    Ok(PromptOptimizationProviderOverlay {
        upstream_protocol: protocol,
        key_status: key_status.to_string(),
        env_key_name,
        message,
    })
}

#[cfg(test)]
pub fn current_provider_model_sync(codex_home: &Path) -> Result<CurrentProviderModelSync> {
    current_provider_model_sync_with_env(codex_home, &|name| std::env::var(name).ok())
}

pub(crate) fn current_provider_model_sync_for_config(
    codex_home: &Path,
    config: &CodeyConfig,
) -> Result<CurrentProviderModelSync> {
    current_provider_model_sync_for_config_with_env(codex_home, config, &|name| {
        std::env::var(name).ok()
    })
}

#[cfg(test)]
pub(crate) fn current_provider_model_sync_with_env(
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<CurrentProviderModelSync> {
    current_provider_model_sync_for_config_with_env(codex_home, &CodeyConfig::default(), env)
}

pub(crate) fn current_provider_model_sync_for_config_with_env(
    codex_home: &Path,
    codey: &CodeyConfig,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<CurrentProviderModelSync> {
    let snapshot = current_provider_snapshot_for_config(codex_home, codey)?;
    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path)
        .load()
        .context("解析 Codex 用户配置失败")?;
    let document = config.document();
    let table = provider_table(document, &snapshot.id);
    let base_url = table
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(snapshot.base_url.as_str())
        .to_string();
    let upstream_protocol = if snapshot.uses_official_account_auth {
        crate::config::UPSTREAM_PROTOCOL_OFFICIAL.to_string()
    } else {
        upstream_protocol_from_wire_api(&snapshot.wire_api)?.to_string()
    };
    let base_url = if base_url.is_empty()
        && !snapshot.uses_official_account_auth
        && snapshot.id == BUILTIN_OPENAI_PROVIDER_ID
    {
        "https://api.openai.com/v1".to_string()
    } else {
        base_url
    };
    let (api_key, auth_command) = if snapshot.uses_official_account_auth {
        (String::new(), None)
    } else {
        let credential = resolve_provider_credential(codex_home, document, table, &snapshot.id, env)?
            .ok_or_else(|| {
            anyhow::anyhow!(
                "当前 provider「{}」没有可用的密钥。请检查 auth.command、env_key「{}」、experimental_bearer_token 或适用的 auth.json API 密钥。Codey 不会使用自己保存的密钥，也不会把密钥写回你的配置。",
                snapshot.id,
                table.and_then(|provider| provider.get("env_key")).and_then(Item::as_str).unwrap_or_default()
            )
        })?;
        (credential.token, credential.auth_command)
    };
    let request_headers = table
        .map(|provider| provider_model_request_headers_with_env(provider, env))
        .unwrap_or_default();
    Ok(CurrentProviderModelSync {
        snapshot: snapshot.identity,
        request: crate::provider_models::ModelSyncRequest {
            base_url,
            upstream_protocol,
            api_key,
            auth_command,
            request_headers,
        },
    })
}

pub fn sync_current_third_party_provider(
    config: &CodeyConfig,
    codex_home: &Path,
) -> Result<(CodeyConfig, ProviderStatus)> {
    let snapshot = local_provider_for_config(codex_home, AuthProbePolicy::Strict, config)?;
    if snapshot.provider.official {
        bail!("当前 Codex 配置是官方账号，不自动导入为第三方 provider");
    }
    let next = config.clone().normalize();
    Ok((
        next,
        ProviderStatus {
            changed: false,
            provider: snapshot.provider,
        },
    ))
}

#[cfg(test)]
pub fn sync_current_provider(
    config: &CodeyConfig,
    codex_home: &Path,
) -> Result<(CodeyConfig, ProviderStatus)> {
    let snapshot = local_provider(codex_home)?;
    let next = config.clone().normalize();
    Ok((
        next,
        ProviderStatus {
            changed: false,
            provider: snapshot.provider,
        },
    ))
}

pub fn status_from_config(config: &CodeyConfig) -> ProviderStatus {
    let provider = config
        .current_provider_snapshot
        .as_ref()
        .map(|snapshot| CurrentProvider {
            id: snapshot.id.clone(),
            name: if snapshot.uses_official_account_auth {
                "OpenAI 官方直登".to_string()
            } else {
                snapshot.id.clone()
            },
            official: snapshot.uses_official_account_auth,
            supports_remote_compaction: snapshot.supports_remote_compaction(),
            external_web_access: snapshot.external_web_access,
            capability_warning: snapshot.capability_warning.clone(),
            base_url: snapshot.base_url.clone(),
        })
        .unwrap_or_else(|| CurrentProvider {
            id: BUILTIN_OPENAI_PROVIDER_ID.to_string(),
            name: "OpenAI 官方直登".to_string(),
            official: true,
            supports_remote_compaction: true,
            ..CurrentProvider::default()
        });
    ProviderStatus {
        changed: false,
        provider,
    }
}

fn local_provider(codex_home: &Path) -> Result<LocalProviderSnapshot> {
    local_provider_with_auth_policy(codex_home, AuthProbePolicy::Strict)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthProbePolicy {
    Strict,
    Lenient,
}

struct AuthProbe {
    value: Option<Value>,
    status: OfficialAccountAuthProbe,
}

fn local_provider_with_auth_policy(
    codex_home: &Path,
    auth_policy: AuthProbePolicy,
) -> Result<LocalProviderSnapshot> {
    local_provider_for_config(codex_home, auth_policy, &CodeyConfig::default())
}

fn local_provider_for_config(
    codex_home: &Path,
    auth_policy: AuthProbePolicy,
    codey: &CodeyConfig,
) -> Result<LocalProviderSnapshot> {
    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path).load()?;
    let document = config.document();
    let resolved = crate::channels::resolve(codex_home, document, codey)?;
    let provider_id = resolved.provider_id.as_str();
    let table = provider_table(document, provider_id);
    let mut base_url = table
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str)
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    let name = table
        .and_then(|provider| provider.get("name"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(provider_id);
    let wire_api = table
        .and_then(|provider| provider.get("wire_api"))
        .and_then(Item::as_str)
        .unwrap_or("responses");
    let _upstream_protocol = upstream_protocol_from_wire_api(wire_api)?;
    let auth_path = codex_home.join("auth.json");
    let auth_store = document
        .get("cli_auth_credentials_store")
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto");
    let auth_policy = if resolved
        .channel_id
        .as_deref()
        .is_some_and(|id| id.starts_with("provider:"))
    {
        AuthProbePolicy::Lenient
    } else {
        auth_policy
    };
    let auth = read_auth_probe(&auth_path, auth_store, auth_policy)?;
    let official =
        uses_official_account_auth(document, provider_id, table, &base_url, auth.value.as_ref());
    let capabilities = provider_capabilities(provider_id, table, official);
    if let Some(warning) = &capabilities.warning {
        eprintln!("{warning}");
    }
    if !official && base_url.is_empty() {
        base_url = "https://api.openai.com/v1".to_string();
    }
    Ok(LocalProviderSnapshot {
        provider: CurrentProvider {
            id: provider_id.to_string(),
            name: if official {
                "OpenAI 官方直登".to_string()
            } else if name == BUILTIN_OPENAI_PROVIDER_ID {
                "OpenAI API".to_string()
            } else {
                name.to_string()
            },
            official,
            supports_remote_compaction: capabilities.supports_remote_compaction,
            external_web_access: capabilities.external_web_access,
            capability_warning: capabilities.warning,
            base_url,
        },
        official_account_auth: auth.status,
    })
}

fn read_auth_probe(
    auth_path: &Path,
    auth_store: &str,
    policy: AuthProbePolicy,
) -> Result<AuthProbe> {
    let missing_auth_status = if auth_store.eq_ignore_ascii_case("file") {
        OfficialAccountAuthProbe::Unavailable(format!(
            "凭据存储策略为 file，但 auth.json 不存在：{}",
            auth_path.display()
        ))
    } else {
        OfficialAccountAuthProbe::Unknown(format!(
            "未找到 Codex auth.json，当前凭据存储为 {auth_store}，可能由系统凭据存储接管：{}",
            auth_path.display()
        ))
    };
    let bytes = match fs::read(auth_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AuthProbe {
                value: None,
                status: missing_auth_status,
            });
        }
        Err(error) if policy == AuthProbePolicy::Lenient => {
            return Ok(AuthProbe {
                value: None,
                status: OfficialAccountAuthProbe::Unknown(format!(
                    "读取 Codex auth.json 失败，无法确认官方登录状态：{}：{error}",
                    auth_path.display()
                )),
            });
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("读取本地 Codex 认证失败：{}", auth_path.display()));
        }
    };
    let value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(error) if policy == AuthProbePolicy::Lenient => {
            return Ok(AuthProbe {
                value: None,
                status: OfficialAccountAuthProbe::Unknown(format!(
                    "解析 Codex auth.json 失败，无法确认官方登录状态：{}：{error}",
                    auth_path.display()
                )),
            });
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("解析本地 Codex 认证失败：{}", auth_path.display()));
        }
    };
    let auth_summary = auth_file_safe_summary(&value);
    let status = if auth_has_chatgpt_tokens(&value) {
        OfficialAccountAuthProbe::Available(format!(
            "auth.json 包含可用的 ChatGPT 登录字段（{auth_summary}）：{}",
            auth_path.display()
        ))
    } else if auth_store.eq_ignore_ascii_case("file") {
        OfficialAccountAuthProbe::Unavailable(format!(
            "凭据存储策略为 file，但 auth.json 未包含可用的 ChatGPT 登录字段（{auth_summary}）：{}",
            auth_path.display()
        ))
    } else {
        OfficialAccountAuthProbe::Unknown(format!(
            "Codex auth.json 未包含 ChatGPT token（{auth_summary}），当前凭据存储为 {auth_store}，可能由系统凭据存储接管：{}",
            auth_path.display()
        ))
    };
    Ok(AuthProbe {
        value: Some(value),
        status,
    })
}

pub(crate) fn configured_provider_id(document: &DocumentMut) -> &str {
    let profile = document
        .get("profile")
        .and_then(Item::as_str)
        .and_then(|name| document.get("profiles")?.get(name));
    profile
        .and_then(|profile| profile.get("model_provider"))
        .or_else(|| document.get("model_provider"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(BUILTIN_OPENAI_PROVIDER_ID)
}

fn provider_table<'a>(document: &'a DocumentMut, provider_id: &str) -> Option<&'a dyn TableLike> {
    document
        .get("model_providers")
        .and_then(Item::as_table_like)
        .and_then(|providers| providers.get(provider_id))
        .and_then(Item::as_table_like)
}

fn provider_capability<'a>(provider: Option<&'a dyn TableLike>, name: &str) -> Option<&'a Item> {
    provider?.get("capabilities")?.as_table_like()?.get(name)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderCapabilities {
    supports_remote_compaction: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_web_access: Option<bool>,
    #[serde(rename = "capabilityWarning", skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

fn provider_capabilities(
    provider_id: &str,
    provider: Option<&dyn TableLike>,
    official: bool,
) -> ProviderCapabilities {
    let (supports_remote_compaction, warning) = match provider_capability(
        provider,
        "remote_compaction",
    )
    .map(Item::as_str)
    {
        None => (official || provider_id == BUILTIN_OPENAI_PROVIDER_ID, None),
        Some(Some("v2")) => (true, None),
        Some(Some("unsupported")) => (false, None),
        Some(_) => (
            false,
            Some(format!(
                "provider「{provider_id}」的 capabilities.remote_compaction 无效，已禁用远程压缩。"
            )),
        ),
    };
    ProviderCapabilities {
        supports_remote_compaction,
        external_web_access: provider_capability(provider, "external_web_access")
            .and_then(Item::as_bool),
        warning,
    }
}

fn provider_has_scoped_credentials(provider: Option<&dyn TableLike>) -> bool {
    provider.is_some_and(|provider| {
        provider.get("auth").is_some()
            || PROVIDER_KEYS.iter().chain(PROVIDER_ENV_KEYS).any(|key| {
                provider
                    .get(key)
                    .and_then(Item::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
            || ["http_headers", "env_http_headers"].iter().any(|key| {
                provider
                    .get(key)
                    .and_then(Item::as_table_like)
                    .is_some_and(|headers| {
                        headers
                            .iter()
                            .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    })
            })
    })
}

fn uses_official_account_auth(
    document: &DocumentMut,
    provider_id: &str,
    provider: Option<&dyn TableLike>,
    base_url: &str,
    auth: Option<&Value>,
) -> bool {
    let official_endpoint = (base_url.is_empty() && provider_id == BUILTIN_OPENAI_PROVIDER_ID)
        || is_official_base_url(base_url);
    let auth_mode = auth
        .and_then(|auth| auth.get("auth_mode"))
        .and_then(Value::as_str);
    official_endpoint
        && !provider_has_scoped_credentials(provider)
        && document
            .get("experimental_bearer_token")
            .and_then(Item::as_str)
            .is_none_or(|token| token.trim().is_empty())
        && provider
            .and_then(|provider| provider.get("requires_openai_auth"))
            .and_then(Item::as_bool)
            != Some(false)
        && matches!(auth_mode, None | Some("chatgpt"))
        && auth_json_api_key(provider_id, provider, auth).is_none()
}

pub(crate) fn official_channel_available(document: &DocumentMut, auth: &Value) -> bool {
    let table = provider_table(document, BUILTIN_OPENAI_PROVIDER_ID);
    let base_url = table
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str)
        .unwrap_or_default();
    uses_official_account_auth(
        document,
        BUILTIN_OPENAI_PROVIDER_ID,
        table,
        base_url,
        Some(auth),
    )
}

fn auth_json_api_key(
    provider_id: &str,
    provider: Option<&dyn TableLike>,
    auth: Option<&Value>,
) -> Option<String> {
    let requires_openai_auth = provider_uses_openai_auth(provider_id, provider);
    let auth = auth.filter(|auth| {
        requires_openai_auth
            && (auth.get("auth_mode").and_then(Value::as_str) == Some("apikey")
                || (auth.get("auth_mode").is_none() && !auth_has_chatgpt_tokens(auth)))
    })?;
    auth.get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToString::to_string)
}

fn provider_uses_openai_auth(provider_id: &str, provider: Option<&dyn TableLike>) -> bool {
    provider_id == BUILTIN_OPENAI_PROVIDER_ID
        || provider
            .and_then(|provider| provider.get("requires_openai_auth"))
            .and_then(Item::as_bool)
            == Some(true)
}

struct ProviderCredential {
    token: String,
    source: &'static str,
    auth_command: Option<AuthCommandIdentity>,
}

fn resolve_provider_credential(
    codex_home: &Path,
    document: &DocumentMut,
    provider: Option<&dyn TableLike>,
    provider_id: &str,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<Option<ProviderCredential>> {
    if let Some(auth) = provider.and_then(|provider| provider.get("auth")) {
        let command = ProviderAuthCommand::parse(provider_id, provider, auth)?;
        return command.credential(provider_id).map(Some);
    }
    if let Some(token) = provider_native_api_key_with_env(provider, env) {
        return Ok(Some(ProviderCredential {
            token,
            source: "provider 配置或环境变量",
            auth_command: None,
        }));
    }
    if provider_uses_openai_auth(provider_id, provider) {
        let auth = read_auth_probe(
            &codex_home.join("auth.json"),
            "auto",
            AuthProbePolicy::Strict,
        )?;
        if let Some(token) = auth_json_api_key(provider_id, provider, auth.value.as_ref()) {
            return Ok(Some(ProviderCredential {
                token,
                source: "auth.json",
                auth_command: None,
            }));
        }
    }
    Ok(
        provider_compatibility_api_key_with_env(document, provider, env).map(|token| {
            ProviderCredential {
                token,
                source: "兼容凭据配置",
                auth_command: None,
            }
        }),
    )
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct AuthCommandCacheKey {
    provider_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
}

#[derive(Clone)]
struct ProviderAuthCommand {
    command: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    timeout: Duration,
    refresh_interval: Duration,
}

struct CachedAuthToken {
    token: String,
    acquired: Instant,
    generation: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AuthCommandIdentity {
    key: AuthCommandCacheKey,
    generation: u64,
}

impl AuthCommandIdentity {
    pub(crate) fn invalidate(&self) -> Result<()> {
        let mut cache = AUTH_COMMAND_CACHE
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| auth_command_error(&self.key.provider_id, "缓存不可用"))?;
        if cache
            .get(&self.key)
            .is_some_and(|cached| cached.generation == self.generation)
        {
            cache.remove(&self.key);
        }
        Ok(())
    }
}

static AUTH_COMMAND_GENERATION: AtomicU64 = AtomicU64::new(1);
const MAX_AUTH_COMMAND_STDOUT_BYTES: u64 = 64 * 1024;

static AUTH_COMMAND_CACHE: OnceLock<Mutex<BTreeMap<AuthCommandCacheKey, CachedAuthToken>>> =
    OnceLock::new();

fn auth_command_error(provider_id: &str, kind: &str) -> anyhow::Error {
    anyhow::anyhow!("provider「{provider_id}」的 auth.command {kind}（未记录命令输出）。")
}

impl ProviderAuthCommand {
    fn parse(provider_id: &str, provider: Option<&dyn TableLike>, auth: &Item) -> Result<Self> {
        let invalid = || auth_command_error(provider_id, "配置无效");
        if [
            "env_key",
            "experimental_bearer_token",
            "requires_openai_auth",
        ]
        .iter()
        .any(|key| provider.and_then(|provider| provider.get(key)).is_some())
        {
            bail!(
                "provider「{provider_id}」的 auth 不能与 env_key、experimental_bearer_token 或 requires_openai_auth 同时配置。"
            );
        }
        let auth = auth.as_table_like().ok_or_else(invalid)?;
        let command = auth
            .get("command")
            .and_then(Item::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(invalid)?
            .to_string();
        let args = auth
            .get("args")
            .map(|args| {
                args.as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .map(|arg| arg.as_str().map(ToString::to_string).ok_or_else(invalid))
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        let cwd = auth
            .get("cwd")
            .map(|cwd| cwd.as_str().map(PathBuf::from).ok_or_else(invalid))
            .transpose()?;
        let milliseconds = |name, default| -> Result<Duration> {
            let value = auth
                .get(name)
                .map(|value| {
                    value
                        .as_integer()
                        .and_then(|n| u64::try_from(n).ok())
                        .ok_or_else(invalid)
                })
                .transpose()?
                .unwrap_or(default);
            Ok(Duration::from_millis(value))
        };
        Ok(Self {
            command,
            args,
            cwd,
            timeout: match milliseconds("timeout_ms", 5000)? {
                timeout if timeout.is_zero() => Duration::from_millis(5000),
                timeout => timeout.min(Duration::from_millis(60000)),
            },
            refresh_interval: milliseconds("refresh_interval_ms", 300000)?,
        })
    }

    #[cfg(all(test, unix))]
    fn token(&self, provider_id: &str) -> Result<String> {
        self.credential(provider_id)
            .map(|credential| credential.token)
    }

    fn credential(&self, provider_id: &str) -> Result<ProviderCredential> {
        let key = AuthCommandCacheKey {
            provider_id: provider_id.to_string(),
            command: self.command.clone(),
            args: self.args.clone(),
            cwd: self.cwd.clone(),
        };
        {
            let mut cache = AUTH_COMMAND_CACHE
                .get_or_init(Mutex::default)
                .lock()
                .map_err(|_| auth_command_error(provider_id, "缓存不可用"))?;
            if let Some(cached) = cache.get(&key)
                && (self.refresh_interval.is_zero()
                    || cached.acquired.elapsed() < self.refresh_interval)
            {
                return Ok(ProviderCredential {
                    token: cached.token.clone(),
                    source: "auth.command",
                    auth_command: Some(AuthCommandIdentity {
                        key,
                        generation: cached.generation,
                    }),
                });
            }
            cache.remove(&key);
        }
        let command = self.clone();
        let id = provider_id.to_string();
        let token = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| auth_command_error(&id, "运行环境不可用"))?;
            runtime.block_on(command.execute(&id))
        })
        .join()
        .map_err(|_| auth_command_error(provider_id, "执行失败"))??;
        let mut cache = AUTH_COMMAND_CACHE
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| auth_command_error(provider_id, "缓存不可用"))?;
        let generation = AUTH_COMMAND_GENERATION.fetch_add(1, Ordering::Relaxed);
        cache.insert(
            key.clone(),
            CachedAuthToken {
                token: token.clone(),
                acquired: Instant::now(),
                generation,
            },
        );
        Ok(ProviderCredential {
            token,
            source: "auth.command",
            auth_command: Some(AuthCommandIdentity { key, generation }),
        })
    }

    async fn execute(&self, provider_id: &str) -> Result<String> {
        use tokio::io::AsyncReadExt;

        let mut command = tokio::process::Command::new(&self.command);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        command.creation_flags(codey_runtime_core::windows_create_no_window());
        let mut child = command
            .spawn()
            .map_err(|_| auth_command_error(provider_id, "启动失败"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| auth_command_error(provider_id, "读取失败"))?;
        let mut bytes = Vec::new();
        let capture = async {
            tokio::try_join!(
                async { child.wait().await.map_err(|_| "等待失败") },
                async {
                    stdout
                        .take(MAX_AUTH_COMMAND_STDOUT_BYTES + 1)
                        .read_to_end(&mut bytes)
                        .await
                        .map_err(|_| "读取失败")?;
                    if bytes.len() as u64 > MAX_AUTH_COMMAND_STDOUT_BYTES {
                        Err("输出超过 64 KiB 上限")
                    } else {
                        Ok(())
                    }
                }
            )
        };
        let result = tokio::time::timeout(self.timeout, capture).await;
        let status = match result {
            Ok(Ok((status, _))) => status,
            failure => {
                // Timeout and output-limit cleanup terminates only the direct child.
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(auth_command_error(
                    provider_id,
                    match failure {
                        Err(_) => "超时",
                        Ok(Err(kind)) => kind,
                        Ok(Ok(_)) => unreachable!(),
                    },
                ));
            }
        };
        if !status.success() {
            return Err(auth_command_error(provider_id, "退出失败"));
        }
        let token = String::from_utf8(bytes)
            .map_err(|_| auth_command_error(provider_id, "输出不是 UTF-8"))?;
        let token = token.trim();
        if token.is_empty() {
            return Err(auth_command_error(provider_id, "输出为空"));
        }
        Ok(token.to_string())
    }
}

pub(crate) fn auth_has_chatgpt_tokens(auth: &Value) -> bool {
    (matches!(auth.get("auth_mode"), None | Some(Value::Null))
        || auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt"))
        && auth
            .get("tokens")
            .and_then(Value::as_object)
            .is_some_and(|tokens| {
                ["access_token", "id_token", "refresh_token"]
                    .iter()
                    .any(|name| {
                        tokens
                            .get(*name)
                            .and_then(Value::as_str)
                            .is_some_and(|token| !token.trim().is_empty())
                    })
            })
}

fn auth_file_safe_summary(auth: &Value) -> String {
    let auth_mode = match auth
        .get("auth_mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("chatgpt") => "chatgpt",
        Some("api") | Some("api_key") | Some("apikey") => "api_key",
        Some(_) => "other",
        None => "missing",
    };
    let token_fields = auth
        .get("tokens")
        .and_then(Value::as_object)
        .map(|tokens| {
            ["access_token", "id_token", "refresh_token"]
                .into_iter()
                .filter(|name| {
                    tokens
                        .get(*name)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let openai_api_key_present = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    format!(
        "authMode={auth_mode}, chatgptTokenFields={token_fields:?}, openaiApiKeyPresent={openai_api_key_present}"
    )
}

fn resolve_native_status_executable(configured_codex_app_path: &str) -> PathBuf {
    resolve_codex_app_dir_with_saved(None, Some(configured_codex_app_path))
        .as_deref()
        .and_then(codex_runtime_executable)
        .unwrap_or_else(|| PathBuf::from("codex"))
}

fn native_login_status(codex_home: &Path, executable: Option<&Path>) -> NativeLoginStatus {
    const LOGIN_STATUS_TIMEOUT: Duration = Duration::from_secs(3);
    let executable = executable.unwrap_or_else(|| Path::new("codex"));
    let mut command = Command::new(executable);
    command
        .args(["login", "status"])
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(codey_runtime_core::windows_create_no_window());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return NativeLoginStatus::Unknown(format!(
                "无法运行 codex login status：{error}；executable={}；CODEX_HOME={}",
                executable.display(),
                codex_home.display()
            ));
        }
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < LOGIN_STATUS_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return NativeLoginStatus::Unknown(format!(
                    "codex login status 在 {}ms 后超时；executable={}；CODEX_HOME={}",
                    started.elapsed().as_millis(),
                    executable.display(),
                    codex_home.display()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return NativeLoginStatus::Unknown(format!(
                    "等待 codex login status 失败：{error}；executable={}；CODEX_HOME={}；elapsedMs={}",
                    executable.display(),
                    codex_home.display(),
                    started.elapsed().as_millis()
                ));
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return NativeLoginStatus::Unknown(format!(
                "读取 codex login status 输出失败：{error}；executable={}；CODEX_HOME={}；elapsedMs={}",
                executable.display(),
                codex_home.display(),
                started.elapsed().as_millis()
            ));
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let status = output.status.to_string();
    let diagnostic = format!(
        "executable={}；CODEX_HOME={}；exitStatus={status}；elapsedMs={}；stdoutBytes={}；stderrBytes={}",
        executable.display(),
        codex_home.display(),
        started.elapsed().as_millis(),
        output.stdout.len(),
        output.stderr.len()
    );
    match parse_native_login_status_output(output.status.success(), &stdout, &stderr, &status) {
        NativeLoginStatus::ChatGpt => NativeLoginStatus::ChatGpt,
        NativeLoginStatus::NotLoggedIn(reason) => {
            NativeLoginStatus::NotLoggedIn(format!("{reason}；{diagnostic}"))
        }
        NativeLoginStatus::ApiKey(reason) => {
            NativeLoginStatus::ApiKey(format!("{reason}；{diagnostic}"))
        }
        NativeLoginStatus::Unknown(reason) => {
            NativeLoginStatus::Unknown(format!("{reason}；{diagnostic}"))
        }
    }
}

fn native_login_status_with_path_fallback(
    codex_home: &Path,
    primary_executable: &Path,
) -> NativeLoginStatus {
    let primary_status = native_login_status(codex_home, Some(primary_executable));
    native_login_status_with_path_fallback_result(primary_executable, primary_status, || {
        native_login_status(codex_home, Some(Path::new("codex")))
    })
}

fn native_login_status_with_path_fallback_result(
    primary_executable: &Path,
    primary_status: NativeLoginStatus,
    fallback_probe: impl FnOnce() -> NativeLoginStatus,
) -> NativeLoginStatus {
    if !should_try_path_login_status_fallback(&primary_status, primary_executable) {
        return primary_status;
    }
    let primary_reason = match primary_status {
        NativeLoginStatus::Unknown(reason) => reason,
        status => return status,
    };
    match fallback_probe() {
        NativeLoginStatus::Unknown(fallback_reason) => NativeLoginStatus::Unknown(format!(
            "{primary_reason}；PATH codex 回退也无法确认官方登录状态：{fallback_reason}"
        )),
        status => status,
    }
}

fn should_try_path_login_status_fallback(status: &NativeLoginStatus, executable: &Path) -> bool {
    let NativeLoginStatus::Unknown(reason) = status else {
        return false;
    };
    if !(reason.contains("无法运行 codex login status")
        || reason.contains("could not run codex login status"))
    {
        return false;
    }
    executable != Path::new("codex")
}

fn parse_native_login_status_output(
    success: bool,
    stdout: &str,
    stderr: &str,
    status: &str,
) -> NativeLoginStatus {
    let normalized = format!("{stdout}\n{stderr}").trim().to_ascii_lowercase();
    if normalized.contains("not logged in")
        || normalized.contains("not signed in")
        || normalized.contains("authentication required")
        || normalized.contains("未登录")
    {
        NativeLoginStatus::NotLoggedIn(
            "Codex 原生认证探针明确返回未登录（未记录命令原始输出，避免泄露凭据）".to_string(),
        )
    } else if normalized.contains("api key") {
        NativeLoginStatus::ApiKey(
            "Codex 原生认证探针显示当前使用 API Key，而不是 ChatGPT 官方账号登录（未记录命令原始输出，避免泄露凭据）"
                .to_string(),
        )
    } else if success
        && normalized
            .lines()
            .any(|line| line.trim() == "logged in using chatgpt")
    {
        NativeLoginStatus::ChatGpt
    } else if success {
        NativeLoginStatus::Unknown("codex login status 输出格式未知".to_string())
    } else {
        NativeLoginStatus::Unknown(format!("codex login status 退出码为 {status}"))
    }
}

const PROVIDER_KEYS: &[&str] = &[
    "experimental_bearer_token",
    "api_key",
    "apikey",
    "bearer_token",
    "token",
];
const PROVIDER_ENV_KEYS: &[&str] = &[
    "env_key",
    "api_key_env",
    "api_key_env_var",
    "key_env",
    "bearer_token_env",
];

fn provider_native_api_key_with_env(
    provider: Option<&dyn TableLike>,
    env_value: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let env_key = provider
        .and_then(|provider| provider.get("env_key"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());
    env_key
        .and_then(env_value)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            provider
                .and_then(|provider| provider.get("experimental_bearer_token"))
                .and_then(Item::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn provider_compatibility_api_key_with_env(
    document: &DocumentMut,
    provider: Option<&dyn TableLike>,
    env_value: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    PROVIDER_KEYS
        .iter()
        .skip(1)
        .find_map(|key| {
            provider?
                .get(key)?
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| {
            PROVIDER_ENV_KEYS.iter().skip(1).find_map(|key| {
                let name = provider?.get(key)?.as_str()?.trim();
                env_value(name)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
        })
        .or_else(|| {
            document
                .get("experimental_bearer_token")
                .and_then(Item::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn provider_model_request_headers_with_env(
    provider: &dyn TableLike,
    env_value: &impl Fn(&str) -> Option<String>,
) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    if let Some(configured) = provider.get("http_headers").and_then(Item::as_table_like) {
        for (name, item) in configured.iter() {
            if let Some(value) = item.as_str() {
                insert_model_request_header(&mut headers, name, value);
            }
        }
    }
    if let Some(configured) = provider
        .get("env_http_headers")
        .and_then(Item::as_table_like)
    {
        for (name, item) in configured.iter() {
            let Some(env_name) = item.as_str().map(str::trim).filter(|name| !name.is_empty())
            else {
                continue;
            };
            let Some(value) = env_value(env_name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            insert_model_request_header(&mut headers, name, &value);
        }
    }
    headers
}

fn insert_model_request_header(headers: &mut BTreeMap<String, String>, name: &str, value: &str) {
    let name = name.trim();
    if name.is_empty() || (name.eq_ignore_ascii_case("authorization") && value.trim().is_empty()) {
        return;
    }
    if let Some(existing) = headers
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(name))
        .cloned()
    {
        headers.remove(&existing);
    }
    headers.insert(name.to_string(), value.to_string());
}

pub(crate) fn is_official_base_url(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("chatgpt.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.path().trim_end_matches('/') == "/backend-api/codex"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(crate) fn upstream_protocol_from_wire_api(value: &str) -> Result<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    if value.contains("anthropic") || value == "messages" || value.ends_with("/messages") {
        return Ok(crate::config::UPSTREAM_PROTOCOL_ANTHROPIC_MESSAGES);
    }
    if value.contains("chat") {
        return Ok(crate::config::UPSTREAM_PROTOCOL_OPENAI_CHAT_COMPLETIONS);
    }
    if value.is_empty() || value.contains("response") {
        return Ok(crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES);
    }
    bail!("Codex Provider 使用了 Codey 不支持的 wire_api：{value}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tempfile::TempDir;
    use toml_edit::DocumentMut;

    fn write_config(home: &Path, contents: &str) {
        fs::write(home.join("config.toml"), contents).unwrap();
    }

    fn write_auth(home: &Path, value: Value) {
        fs::write(
            home.join("auth.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn native_auth_json_api_key_reaches_model_sync_and_overlay() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            "model_provider = 'official'\n[model_providers.official]\nbase_url = 'https://api.openai.com/v1'\nrequires_openai_auth = true\n",
        );
        write_auth(
            home.path(),
            serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "fixture-auth-key"}),
        );
        let before = fs::read(home.path().join("auth.json")).unwrap();
        let sync = current_provider_model_sync(home.path()).unwrap();
        assert_eq!(sync.request.api_key, "fixture-auth-key");
        assert!(!sync.snapshot.uses_official_account_auth);
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert!(
            !serde_json::to_string(&overlay)
                .unwrap()
                .contains("fixture-auth-key")
        );
        assert_eq!(fs::read(home.path().join("auth.json")).unwrap(), before);
    }

    #[test]
    fn auth_revision_chatgpt_mode_never_uses_a_leftover_api_key() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "");
        write_auth(
            home.path(),
            serde_json::json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": "stale-fixture-key"}),
        );
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert!(sync.snapshot.uses_official_account_auth);
        assert!(sync.request.api_key.is_empty());
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(
            overlay.key_status,
            PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE
        );
    }

    #[cfg(unix)]
    #[test]
    fn auth_revision_status_reads_never_execute_the_command() {
        let home = TempDir::new().unwrap();
        auth_command_fixture(home.path(), "printf fixture-token", 1000, 0);
        for _ in 0..2 {
            let overlay =
                prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
            assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
            assert!(overlay.message.contains("auth.command"));
        }
        assert!(!home.path().join("calls").exists());
    }

    #[cfg(unix)]
    #[test]
    fn auth_revision_stdout_overflow_is_bounded_and_terminates_the_child() {
        let home = TempDir::new().unwrap();
        auth_command_fixture(
            home.path(),
            "printf '%s' \"$$\" > pid\ni=0\nwhile [ \"$i\" -lt 65 ]; do printf '%01024d' 0; i=$((i+1)); done\nwhile :; do :; done",
            3000,
            0,
        );
        let error = current_provider_model_sync_with_env(home.path(), &|_| None)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("relay") && error.contains("64 KiB"),
            "{error}"
        );
        assert!(!error.contains("00000000"));
        let pid = fs::read_to_string(home.path().join("pid")).unwrap();
        assert!(
            !Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    }

    #[cfg(unix)]
    #[test]
    fn auth_revision_a_slow_command_does_not_lock_out_other_providers() {
        let slow_home = TempDir::new().unwrap();
        let fast_home = TempDir::new().unwrap();
        auth_command_fixture(
            slow_home.path(),
            "while [ ! -e release ]; do :; done\nprintf slow-fixture-token",
            3000,
            0,
        );
        auth_command_fixture(fast_home.path(), "printf fast-fixture-token", 1000, 0);
        let slow_path = slow_home.path().to_path_buf();
        let slow = thread::spawn(move || {
            current_provider_model_sync_with_env(&slow_path, &|_| None).is_ok()
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !slow_home.path().join("calls").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let fast_path = fast_home.path().to_path_buf();
        let fast = thread::spawn(move || {
            sender
                .send(current_provider_model_sync_with_env(&fast_path, &|_| None).is_ok())
                .unwrap()
        });
        let fast_result = receiver.recv_timeout(Duration::from_secs(1));
        fs::write(slow_home.path().join("release"), "").unwrap();
        let slow_result = slow.join().unwrap();
        fast.join().unwrap();
        assert!(slow_result);
        assert_eq!(fast_result.ok(), Some(true));
    }

    #[test]
    fn auth_revision_command_timeout_is_bounded() {
        for (configured, expected) in [(0, 5000), (123, 123), (60001, 60000)] {
            let document = format!("[auth]\ncommand = 'fixture'\ntimeout_ms = {configured}")
                .parse::<DocumentMut>()
                .unwrap();
            let command = ProviderAuthCommand::parse(
                "fixture",
                Some(document.as_table()),
                document.get("auth").unwrap(),
            )
            .unwrap();
            assert_eq!(command.timeout, Duration::from_millis(expected));
        }
    }

    #[test]
    fn native_explicit_remote_compaction_overrides_display_name() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            "model_provider = 'relay'\n[model_providers.relay]\nname = 'Relay'\nbase_url = 'https://relay.example/v1'\ncapabilities.remote_compaction = 'v2'\n",
        );
        assert!(
            current_provider(home.path())
                .unwrap()
                .supports_remote_compaction
        );
    }

    #[test]
    fn native_capabilities_reach_both_console_snapshots() {
        let home = TempDir::new().unwrap();
        for (remote, expected) in [("v2", true), ("unsupported", false), ("future", false)] {
            write_config(
                home.path(),
                &format!(
                    "model_provider = 'relay'\n[model_providers.relay]\nbase_url = 'https://relay.example/v1'\ncapabilities = {{ remote_compaction = '{remote}', external_web_access = false }}\n"
                ),
            );
            let mut config = CodeyConfig::default();
            config
                .attach_current_provider_snapshot(current_provider_snapshot(home.path()).unwrap());
            let snapshot = crate::commands::json_current_provider_snapshot(&config);
            let status = serde_json::to_value(status_from_config(&config)).unwrap();
            assert_eq!(snapshot["supportsRemoteCompaction"], expected);
            assert_eq!(snapshot["externalWebAccess"], false);
            assert_eq!(status["provider"]["supportsRemoteCompaction"], expected);
            assert_eq!(status["provider"]["externalWebAccess"], false);
            assert_eq!(
                snapshot.get("capabilityWarning").is_some(),
                remote == "future"
            );
            let native = current_provider(home.path()).unwrap();
            assert_eq!(native.supports_remote_compaction, expected);
            assert_eq!(native.external_web_access, Some(false));
            config.attach_current_provider_snapshot(CurrentProviderSnapshot::from_parts(
                "relay",
                "https://relay.example/v1",
                "responses",
                false,
            ));
            assert_eq!(
                crate::commands::json_current_provider_snapshot(&config),
                snapshot
            );
            config.attach_current_provider_snapshot(CurrentProviderSnapshot::from_parts(
                "another-provider",
                "https://relay.example/v1",
                "responses",
                false,
            ));
            let changed = crate::commands::json_current_provider_snapshot(&config);
            assert!(changed.get("externalWebAccess").is_none());
            assert!(changed.get("capabilityWarning").is_none());
            assert!(
                !status_from_config(&config)
                    .provider
                    .supports_remote_compaction
            );
        }
        write_config(home.path(), "");
        let snapshot = current_provider_snapshot(home.path()).unwrap();
        assert!(snapshot.supports_remote_compaction());
        let json = serde_json::to_value(snapshot).unwrap();
        assert!(json.get("externalWebAccess").is_none());
    }

    #[cfg(windows)]
    fn windows_auth_command_fixture(home: &Path, body: &str, timeout_ms: u64, refresh_ms: u64) {
        fs::write(
            home.join("credential.cmd"),
            format!("@echo off\r\n>>calls echo x\r\n{body}\r\n"),
        )
        .unwrap();
        let command = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let cwd = toml_edit::Value::from(home.to_str().unwrap()).to_string();
        let command = toml_edit::Value::from(command).to_string();
        write_config(
            home,
            &format!(
                "model_provider = 'relay'\n[model_providers.relay]\nbase_url = 'https://relay.example/v1'\nauth = {{ command = {command}, args = ['/D', '/Q', '/C', 'credential.cmd'], cwd = {cwd}, timeout_ms = {timeout_ms}, refresh_interval_ms = {refresh_ms} }}\n"
            ),
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_auth_command_windows_success_cache_and_redaction() {
        let home = TempDir::new().unwrap();
        windows_auth_command_fixture(home.path(), "echo   fixture-command-token   ", 5000, 300000);
        let before = fs::read(home.path().join("config.toml")).unwrap();
        let configured =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(configured.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert!(!home.path().join("calls").exists());
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(sync.request.api_key, "fixture-command-token");
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert!(overlay.message.contains("auth.command"));
        assert!(!format!("{sync:?}{overlay:?}").contains("fixture-command-token"));
        assert_eq!(
            fs::read_to_string(home.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
        windows_auth_command_fixture(home.path(), "echo fixture-command-token", 5000, 0);
        current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(
            fs::read_to_string(home.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert!(!home.path().join("auth.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_auth_command_windows_failures_are_explicit_and_redacted() {
        for (body, timeout, kind) in [
            (
                "echo fixture-stdout\r\necho fixture-stderr >&2\r\nexit /b 7",
                5000,
                "退出失败",
            ),
            ("exit /b 0", 5000, "输出为空"),
            (":again\r\ngoto again", 500, "超时"),
        ] {
            let home = TempDir::new().unwrap();
            windows_auth_command_fixture(home.path(), body, timeout, 0);
            let error = current_provider_model_sync_with_env(home.path(), &|_| None)
                .unwrap_err()
                .to_string();
            assert!(error.contains("relay") && error.contains(kind), "{error}");
            assert!(!error.contains("fixture-stdout") && !error.contains("fixture-stderr"));
            let overlay =
                prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
            assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
            assert!(overlay.message.contains("auth.command"));
            assert!(
                !overlay.message.contains("fixture-stdout")
                    && !overlay.message.contains("fixture-stderr")
            );
        }
    }

    #[test]
    fn native_credential_sources_follow_codex_order_and_auth_mode() {
        let home = TempDir::new().unwrap();
        for (provider_id, requires, auth, expected) in [
            (
                "official",
                "requires_openai_auth = true",
                serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "auth-key"}),
                Some("auth-key"),
            ),
            (
                "official",
                "requires_openai_auth = true",
                serde_json::json!({"OPENAI_API_KEY": "auth-key"}),
                Some("auth-key"),
            ),
            (
                "openai",
                "",
                serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "auth-key"}),
                Some("auth-key"),
            ),
            (
                "relay",
                "",
                serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "auth-key"}),
                None,
            ),
            (
                "official",
                "requires_openai_auth = true",
                serde_json::json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": "stale-key", "tokens": {"access_token": "account-token"}}),
                None,
            ),
        ] {
            write_config(
                home.path(),
                &format!(
                    "model_provider = {provider_id:?}\n[model_providers.{provider_id}]\nbase_url = 'https://api.openai.com/v1'\n{requires}\n"
                ),
            );
            write_auth(home.path(), auth);
            let resolved = current_provider_model_sync_with_env(home.path(), &|_| None);
            match expected {
                Some(key) => assert_eq!(resolved.unwrap().request.api_key, key),
                None => assert!(resolved.is_err()),
            }
        }
        write_config(
            home.path(),
            "model_provider = 'official'\n[model_providers.official]\nbase_url = 'https://api.openai.com/v1'\nrequires_openai_auth = true\nenv_key = 'FIXTURE_KEY'\nexperimental_bearer_token = 'inline-key'\n",
        );
        write_auth(
            home.path(),
            serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "auth-key"}),
        );
        let from_env = current_provider_model_sync_with_env(home.path(), &|name| {
            (name == "FIXTURE_KEY").then(|| " env-key \n".into())
        })
        .unwrap();
        assert_eq!(from_env.request.api_key, "env-key");
        let from_inline = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(from_inline.request.api_key, "inline-key");
        assert!(!format!("{from_env:?}{from_inline:?}").contains("env-key"));
        assert!(!format!("{from_inline:?}").contains("inline-key"));
        write_config(home.path(), "");
        let builtin = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(builtin.request.api_key, "auth-key");
        assert_eq!(builtin.request.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn native_scoped_key_does_not_read_unrelated_auth_json() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            "[model_providers.openai]\nenv_key = 'FIXTURE_KEY'\nexperimental_bearer_token = 'inline-key'\n",
        );
        fs::write(home.path().join("auth.json"), "invalid auth fixture").unwrap();
        let sync =
            current_provider_model_sync_with_env(home.path(), &|_| Some("env-key".into())).unwrap();
        assert_eq!(sync.request.api_key, "env-key");
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(sync.request.api_key, "inline-key");
    }

    #[test]
    fn native_auth_json_precedes_legacy_credential_aliases() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            "experimental_bearer_token = 'document-key'\nmodel_provider = 'official'\n[model_providers.official]\nbase_url = 'https://api.openai.com/v1'\nrequires_openai_auth = true\napi_key = 'alias-key'\n",
        );
        write_auth(
            home.path(),
            serde_json::json!({"auth_mode": "apikey", "OPENAI_API_KEY": "native-key"}),
        );
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(sync.request.api_key, "native-key");
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert!(overlay.message.contains("auth.json"));
        fs::remove_file(home.path().join("auth.json")).unwrap();
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(sync.request.api_key, "alias-key");
    }

    #[test]
    fn native_capabilities_use_explicit_values_and_provider_defaults() {
        let home = TempDir::new().unwrap();
        for (id, name, declaration, expected, warning) in [
            (
                "relay",
                "Relay",
                "capabilities.remote_compaction = 'v2'",
                true,
                false,
            ),
            (
                "openai",
                "OpenAI",
                "capabilities.remote_compaction = 'unsupported'",
                false,
                false,
            ),
            (
                "openai",
                "OpenAI",
                "capabilities.remote_compaction = 'future'",
                false,
                true,
            ),
            ("relay", "OpenAI", "", false, false),
            ("openai", "Custom display", "", true, false),
            ("relay", "Relay", "", false, false),
        ] {
            let text = format!(
                "model_provider = {id:?}\n[model_providers.{id}]\nname = {name:?}\nbase_url = 'https://api.openai.com/v1'\n{declaration}\n"
            );
            write_config(home.path(), &text);
            let document = text.parse::<DocumentMut>().unwrap();
            let capabilities = provider_capabilities(id, provider_table(&document, id), false);
            assert_eq!(capabilities.supports_remote_compaction, expected);
            assert_eq!(capabilities.warning.is_some(), warning);
            assert_eq!(
                current_provider(home.path())
                    .unwrap()
                    .supports_remote_compaction,
                expected
            );
        }
        assert!(provider_capabilities("account", None, true).supports_remote_compaction);
        for value in [None, Some(true), Some(false)] {
            let declaration = value
                .map(|value| format!("capabilities.external_web_access = {value}"))
                .unwrap_or_default();
            let document = declaration.parse::<DocumentMut>().unwrap();
            let capabilities = provider_capabilities("relay", Some(document.as_table()), false);
            assert_eq!(capabilities.external_web_access, value);
            let json = serde_json::to_value(capabilities).unwrap();
            assert_eq!(
                json.get("externalWebAccess").and_then(Value::as_bool),
                value
            );
        }
    }

    #[cfg(unix)]
    fn auth_command_fixture(home: &Path, body: &str, timeout_ms: u64, refresh_ms: u64) {
        fs::write(
            home.join("credential.sh"),
            format!("printf x >> calls\n{body}\n"),
        )
        .unwrap();
        write_config(
            home,
            &format!(
                "model_provider = 'relay'\n[model_providers.relay]\nbase_url = 'https://relay.example/v1'\nauth = {{ command = '/bin/sh', args = ['credential.sh', 'literal;$(not-a-command)'], cwd = {:?}, timeout_ms = {timeout_ms}, refresh_interval_ms = {refresh_ms} }}\n",
                home.to_str().unwrap()
            ),
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_auth_command_success_is_shared_cached_and_redacted() {
        let home = TempDir::new().unwrap();
        auth_command_fixture(home.path(), "printf '  %s \\n' \"$1\"", 1000, 300000);
        let before = fs::read(home.path().join("config.toml")).unwrap();
        let sync = current_provider_model_sync_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(sync.request.api_key, "literal;$(not-a-command)");
        assert!(!format!("{sync:?}").contains("literal;$(not-a-command)"));
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert!(overlay.message.contains("auth.command"));
        assert!(
            !serde_json::to_string(&overlay)
                .unwrap()
                .contains("literal;$(not-a-command)")
        );
        assert!(!overlay.message.contains("env_key"));
        assert_eq!(fs::read_to_string(home.path().join("calls")).unwrap(), "x");
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
        assert!(!home.path().join("auth.json").exists());
        fs::write(home.path().join("auth.json"), "invalid auth fixture").unwrap();
        assert_eq!(
            current_provider_model_sync_with_env(home.path(), &|_| None)
                .unwrap()
                .request
                .api_key,
            "literal;$(not-a-command)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_auth_command_cache_obeys_expiry_zero_and_identity() {
        let home = TempDir::new().unwrap();
        auth_command_fixture(home.path(), "printf fixture-token", 1000, 300000);
        let document = fs::read_to_string(home.path().join("config.toml"))
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        let provider = provider_table(&document, "relay").unwrap();
        let mut command =
            ProviderAuthCommand::parse("relay", Some(provider), provider.get("auth").unwrap())
                .unwrap();
        assert_eq!(command.token("relay").unwrap(), "fixture-token");
        assert_eq!(command.token("relay").unwrap(), "fixture-token");
        {
            let mut cache = AUTH_COMMAND_CACHE.get().unwrap().lock().unwrap();
            let cached = cache
                .iter_mut()
                .find(|(key, _)| key.cwd.as_deref() == Some(home.path()))
                .unwrap()
                .1;
            cached.acquired = Instant::now() - Duration::from_secs(301);
        }
        command.token("relay").unwrap();
        assert_eq!(fs::read_to_string(home.path().join("calls")).unwrap(), "xx");
        command.refresh_interval = Duration::ZERO;
        command.token("relay").unwrap();
        command.token("relay").unwrap();
        assert_eq!(fs::read_to_string(home.path().join("calls")).unwrap(), "xx");
        command.refresh_interval = Duration::from_secs(300);
        command.token("another-provider").unwrap();
        command.args.push("different-argument".into());
        command.token("another-provider").unwrap();
        assert_eq!(
            fs::read_to_string(home.path().join("calls")).unwrap(),
            "xxxx"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_auth_command_errors_are_explicit_and_never_include_output() {
        for (body, timeout, kind) in [
            (
                "printf secret-output; printf secret-stderr >&2; exit 7",
                1000,
                "退出失败",
            ),
            ("printf ' \\n'", 1000, "输出为空"),
            ("printf '%s' \"$$\" > pid; while :; do :; done", 50, "超时"),
        ] {
            let home = TempDir::new().unwrap();
            auth_command_fixture(home.path(), body, timeout, 0);
            let error = current_provider_model_sync_with_env(home.path(), &|_| None)
                .unwrap_err()
                .to_string();
            assert!(error.contains("relay") && error.contains(kind), "{error}");
            assert!(!error.contains("secret-output") && !error.contains("secret-stderr"));
            if kind == "超时" {
                let pid = fs::read_to_string(home.path().join("pid")).unwrap();
                let status = Command::new("kill")
                    .args(["-0", &pid])
                    .stderr(Stdio::null())
                    .status()
                    .unwrap();
                assert!(
                    !status.success(),
                    "timed-out credential child must be reaped"
                );
            }
            let overlay =
                prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();
            assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
            assert!(overlay.message.contains("auth.command"));
            assert!(
                !overlay.message.contains("secret-output")
                    && !overlay.message.contains("secret-stderr")
            );
        }
    }

    #[test]
    fn native_auth_command_schema_defaults_and_conflicts() {
        for extra in [
            "",
            "env_key = 'FIXTURE'",
            "experimental_bearer_token = 'fixture'",
            "requires_openai_auth = false",
        ] {
            let document = format!("auth.command = 'fixture-command'\n{extra}\n")
                .parse::<DocumentMut>()
                .unwrap();
            let provider = document.as_table();
            let result = ProviderAuthCommand::parse(
                "fixture",
                Some(provider),
                provider.get("auth").unwrap(),
            );
            if extra.is_empty() {
                let command = result.unwrap();
                assert_eq!(command.timeout, Duration::from_millis(5000));
                assert_eq!(command.refresh_interval, Duration::from_millis(300000));
                assert!(command.args.is_empty() && command.cwd.is_none());
            } else {
                assert!(result.is_err());
            }
        }
        for body in [
            "command = ''",
            "command = 'fixture'\nargs = [1]",
            "command = 'fixture'\ntimeout_ms = -1",
        ] {
            let document = format!("[auth]\n{body}").parse::<DocumentMut>().unwrap();
            assert!(
                ProviderAuthCommand::parse(
                    "fixture",
                    Some(document.as_table()),
                    document.get("auth").unwrap()
                )
                .is_err()
            );
        }
    }

    fn third_party_config(wire_api: &str) -> String {
        format!(
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "{wire_api}"
experimental_bearer_token = "sk-relay"
"#,
        )
    }

    fn status_with_unknown_native(home: &Path) -> Result<OfficialAccountProfileStatus> {
        current_official_account_profile_status_with_probe(home, |_| {
            NativeLoginStatus::Unknown("probe unavailable".into())
        })
    }

    #[test]
    fn rejects_malformed_codex_files() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "not = [valid");
        assert!(current_provider(home.path()).is_err());

        write_config(home.path(), "");
        fs::write(home.path().join("auth.json"), b"{").unwrap();
        assert!(current_provider(home.path()).is_err());
    }

    #[test]
    fn current_provider_snapshot_reads_user_config_without_writing() {
        let home = TempDir::new().unwrap();
        let original = third_party_config("chat_completions");
        write_config(home.path(), &original);
        let before = fs::read(home.path().join("config.toml")).unwrap();

        let snapshot = current_provider_snapshot(home.path()).unwrap();

        assert_eq!(snapshot.id, "relay");
        assert_eq!(snapshot.base_url, "https://relay.example/v1");
        assert_eq!(snapshot.wire_api, "chat_completions");
        assert!(!snapshot.uses_official_account_auth);
        assert_eq!(snapshot.ownership_key, "relay#889271d70d18");
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
    }

    #[test]
    fn current_provider_snapshot_rejects_malformed_user_config() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "not = [valid");
        let before = fs::read(home.path().join("config.toml")).unwrap();

        let error = current_provider_snapshot(home.path()).unwrap_err();

        assert!(
            format!("{error:#}").contains("解析 Codex 用户配置失败")
                || format!("{error:#}").contains("解析")
        );
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
    }

    #[test]
    fn empty_user_config_snapshot_uses_builtin_openai_defaults() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "");
        let snapshot = current_provider_snapshot(home.path()).unwrap();
        assert_eq!(snapshot.id, BUILTIN_OPENAI_PROVIDER_ID);
        assert!(snapshot.base_url.is_empty());
        assert_eq!(snapshot.wire_api, "responses");
        assert!(snapshot.uses_official_account_auth);
    }

    #[test]
    fn imports_supported_wire_protocols() {
        for (wire_api, _) in [
            (
                "chat_completions",
                crate::config::UPSTREAM_PROTOCOL_OPENAI_CHAT_COMPLETIONS,
            ),
            (
                "anthropic/messages",
                crate::config::UPSTREAM_PROTOCOL_ANTHROPIC_MESSAGES,
            ),
            (
                "responses",
                crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES,
            ),
        ] {
            let home = TempDir::new().unwrap();
            write_config(home.path(), &third_party_config(wire_api));
            let (_, status) =
                sync_current_third_party_provider(&CodeyConfig::default(), home.path()).unwrap();
            let snapshot = current_provider_snapshot(home.path()).unwrap();
            assert_eq!(snapshot.wire_api, wire_api);
            assert_eq!(status.provider.id, "relay");
            assert!(!status.provider.official);
        }
    }

    #[test]
    fn official_capability_requires_chatgpt_tokens() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "");
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "token" }
            }),
        );
        let OfficialAccountProfileStatus::Available =
            status_with_unknown_native(home.path()).unwrap()
        else {
            panic!("auth.json ChatGPT tokens should make official auth available");
        };

        fs::remove_file(home.path().join("auth.json")).unwrap();
        write_config(home.path(), r#"cli_auth_credentials_store = "file""#);
        let OfficialAccountProfileStatus::Unavailable { reason } =
            status_with_unknown_native(home.path()).unwrap()
        else {
            panic!("missing file credentials under file store should be unavailable");
        };
        assert!(reason.contains("凭据存储策略为 file"));
        assert!(reason.contains("auth.json 不存在"));
    }

    #[test]
    fn legacy_chatgpt_tokens_work_without_auth_mode_when_native_probe_fails() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "");
        let mut auth = serde_json::json!({
            "OPENAI_API_KEY": null,
            "tokens": { "access_token": "legacy-token" }
        });
        for mode in [None, Some(Value::Null), Some(serde_json::json!("chatgpt"))] {
            if let Some(mode) = mode {
                auth["auth_mode"] = mode;
            }
            write_auth(home.path(), auth.clone());
            assert!(matches!(
                status_with_unknown_native(home.path()).unwrap(),
                OfficialAccountProfileStatus::Available
            ));
        }
        for mode in [
            serde_json::json!("apikey"),
            serde_json::json!("other"),
            serde_json::json!(42),
        ] {
            auth["auth_mode"] = mode;
            assert!(!auth_has_chatgpt_tokens(&auth));
        }
        assert!(!auth_has_chatgpt_tokens(&serde_json::json!({
            "tokens": { "access_token": "  ", "refresh_token": null }
        })));
    }

    #[test]
    fn official_auth_probe_distinguishes_file_missing_from_unknown_store() {
        let file_home = TempDir::new().unwrap();
        write_config(file_home.path(), r#"cli_auth_credentials_store = "file""#);
        let OfficialAccountProfileStatus::Unavailable { reason } =
            current_official_account_profile_status_with_probe(file_home.path(), |_| {
                NativeLoginStatus::Unknown("probe unavailable".into())
            })
            .unwrap()
        else {
            panic!("missing auth.json under file store should be unavailable");
        };
        assert!(reason.contains("probe unavailable"));
        assert!(reason.contains("凭据存储策略为 file"));

        let auto_home = TempDir::new().unwrap();
        write_config(auto_home.path(), r#"cli_auth_credentials_store = "auto""#);
        let status = current_official_account_profile_status_with_probe(auto_home.path(), |_| {
            NativeLoginStatus::Unknown("probe unavailable".into())
        })
        .unwrap();
        let OfficialAccountProfileStatus::Unknown { reason } = status else {
            panic!("missing auth.json under auto store should be unknown");
        };
        assert!(reason.contains("auth.json"));
    }

    #[test]
    fn native_login_status_wins_over_file_probe() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), r#"cli_auth_credentials_store = "keyring""#);

        let status = current_official_account_profile_status_with_probe(home.path(), |_| {
            NativeLoginStatus::ChatGpt
        })
        .unwrap();
        let OfficialAccountProfileStatus::Available = status else {
            panic!("native ChatGPT login should be authoritative");
        };

        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": { "refresh_token": "stale-token" }
            }),
        );
        let OfficialAccountProfileStatus::Unavailable { reason } =
            current_official_account_profile_status_with_probe(home.path(), |_| {
                NativeLoginStatus::NotLoggedIn("native probe says not logged in".into())
            })
            .unwrap()
        else {
            panic!("native not-logged-in result should be authoritative");
        };
        assert!(reason.contains("native probe says not logged in"));
        assert!(reason.contains("chatgptTokenFields=[\"refresh_token\"]"));
    }

    #[test]
    fn native_login_status_parser_distinguishes_chatgpt_from_api_key() {
        assert_eq!(
            parse_native_login_status_output(true, "Logged in using ChatGPT", "", "exit status: 0",),
            NativeLoginStatus::ChatGpt
        );
        assert!(matches!(
            parse_native_login_status_output(
                true,
                "Logged in using an API key - sk-...",
                "",
                "exit status: 0",
            ),
            NativeLoginStatus::ApiKey(reason)
                if reason.contains("API Key") && !reason.contains("sk-")
        ));
        assert!(matches!(
            parse_native_login_status_output(false, "Not logged in", "", "exit status: 1"),
            NativeLoginStatus::NotLoggedIn(reason)
                if reason.contains("明确返回未登录")
        ));
        assert!(matches!(
            parse_native_login_status_output(true, "Unexpected auth mode", "", "exit status: 0"),
            NativeLoginStatus::Unknown(_)
        ));
        for output in [
            "ChatGPT login is available",
            "OAuth bearer token configured",
            "warning: ChatGPT authentication failed",
            "warning: Logged in using ChatGPT",
        ] {
            assert!(
                matches!(
                    parse_native_login_status_output(true, "", output, "exit status: 0"),
                    NativeLoginStatus::Unknown(_)
                ),
                "{output}"
            );
        }
        assert_eq!(
            parse_native_login_status_output(true, "", "Logged in using ChatGPT\n", "0"),
            NativeLoginStatus::ChatGpt
        );
        assert!(matches!(
            parse_native_login_status_output(false, "Logged in using ChatGPT", "", "1"),
            NativeLoginStatus::Unknown(_)
        ));
    }

    #[test]
    fn native_login_status_tries_path_fallback_after_spawn_access_denied() {
        let status = native_login_status_with_path_fallback_result(
            Path::new(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_26.820.7780.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
            ),
            NativeLoginStatus::Unknown(
                "无法运行 codex login status：拒绝访问。 (os error 5)".into(),
            ),
            || NativeLoginStatus::ChatGpt,
        );

        assert_eq!(status, NativeLoginStatus::ChatGpt);

        let status = native_login_status_with_path_fallback_result(
            Path::new("codex"),
            NativeLoginStatus::Unknown("无法运行 codex login status：not found".into()),
            || panic!("PATH fallback must not retry an identical codex executable"),
        );
        assert!(matches!(status, NativeLoginStatus::Unknown(_)));
    }

    #[test]
    fn auth_file_summary_reports_presence_without_secret_values() {
        let summary = auth_file_safe_summary(&serde_json::json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": "sk-private-api-key",
            "tokens": {
                "access_token": "private-access-token",
                "refresh_token": "private-refresh-token"
            }
        }));

        assert!(summary.contains("authMode=chatgpt"));
        assert!(summary.contains("access_token"));
        assert!(summary.contains("refresh_token"));
        assert!(summary.contains("openaiApiKeyPresent=true"));
        assert!(!summary.contains("sk-private-api-key"));
        assert!(!summary.contains("private-access-token"));
        assert!(!summary.contains("private-refresh-token"));

        let unknown_mode = auth_file_safe_summary(&serde_json::json!({
            "auth_mode": "private-custom-auth-mode"
        }));
        assert!(unknown_mode.contains("authMode=other"));
        assert!(!unknown_mode.contains("private-custom-auth-mode"));
    }

    #[test]
    fn unknown_native_probe_keeps_keyring_and_auto_inconclusive() {
        for store in ["keyring", "auto"] {
            let home = TempDir::new().unwrap();
            write_config(
                home.path(),
                &format!(r#"cli_auth_credentials_store = "{store}""#),
            );
            write_auth(home.path(), serde_json::json!({}));

            let status = current_official_account_profile_status_with_probe(home.path(), |_| {
                NativeLoginStatus::Unknown("probe unavailable".into())
            })
            .unwrap();

            assert!(matches!(
                status,
                OfficialAccountProfileStatus::Unknown { .. }
            ));
        }
    }

    #[test]
    fn malformed_auth_json_is_unknown_for_launch_but_strict_provider_reads_still_fail() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), "");
        fs::write(home.path().join("auth.json"), b"{").unwrap();

        let status = status_with_unknown_native(home.path()).unwrap();
        assert!(matches!(
            status,
            OfficialAccountProfileStatus::Unknown { .. }
        ));
        assert!(current_provider(home.path()).is_err());
    }

    #[test]
    fn third_party_provider_requires_native_confirmation_of_retained_chatgpt_login() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), &third_party_config("responses"));
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "retained-token" }
            }),
        );

        assert!(matches!(
            status_with_unknown_native(home.path()).unwrap(),
            OfficialAccountProfileStatus::Unavailable { .. }
        ));
        assert!(matches!(
            current_official_account_profile_status_with_probe(home.path(), |_| {
                NativeLoginStatus::ChatGpt
            })
            .unwrap(),
            OfficialAccountProfileStatus::Available
        ));

        let current = current_provider(home.path()).unwrap();
        assert!(!current.official);
        assert_eq!(current.id, "relay");
    }

    #[test]
    fn scoped_api_key_on_official_endpoint_stays_separate_from_chatgpt_login() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "OpenAI API"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-relay"
"#,
        );
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "retained-token" }
            }),
        );

        assert!(matches!(
            status_with_unknown_native(home.path()).unwrap(),
            OfficialAccountProfileStatus::Unavailable { .. }
        ));

        let (_, status) =
            sync_current_third_party_provider(&CodeyConfig::default(), home.path()).unwrap();
        assert!(!status.provider.official);
        assert_eq!(status.provider.id, "relay");
    }

    #[test]
    fn official_route_detection_rejects_api_credentials_and_lookalike_urls() {
        let home = TempDir::new().unwrap();
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "retained-token" }
            }),
        );
        for base_url in [
            "https://api.openai.com/v1",
            "https://api.openai.com.relay.example/v1",
            "https://relay.example/api.openai.com",
            "https://relay.example/?upstream=chatgpt.com/backend-api/codex",
            "https://chatgpt.com@relay.example/backend-api/codex",
            "http://chatgpt.com/backend-api/codex",
            "https://chatgpt.com/backend-api/codex-proxy",
            "https://chatgpt.com:8443/backend-api/codex",
        ] {
            write_config(
                home.path(),
                &format!("[model_providers.openai]\nbase_url = {base_url:?}\n"),
            );
            assert!(
                !current_provider(home.path()).unwrap().official,
                "{base_url}"
            );
            assert!(matches!(
                status_with_unknown_native(home.path()).unwrap(),
                OfficialAccountProfileStatus::Unavailable { .. }
            ));
        }
        for extra in [
            "env_key = 'CODEY_TEST_UNSET_OFFICIAL_AUTH_KEY'",
            "requires_openai_auth = false",
            "http_headers = { Authorization = 'Bearer custom-token' }",
            "env_http_headers = { Authorization = 'CODEY_TEST_UNSET_OFFICIAL_AUTH_KEY' }",
        ] {
            write_config(home.path(), &format!("[model_providers.openai]\n{extra}\n"));
            assert!(!current_provider(home.path()).unwrap().official, "{extra}");
        }
        write_config(home.path(), "model_provider = 'relay'");
        assert!(!current_provider(home.path()).unwrap().official);
        write_config(
            home.path(),
            "profile = 'relay-profile'\n[profiles.relay-profile]\nmodel_provider = 'relay'",
        );
        assert_eq!(current_provider(home.path()).unwrap().id, "relay");
        assert!(!current_provider(home.path()).unwrap().official);
        for config in [
            "",
            "[model_providers.openai]\nbase_url = 'https://chatgpt.com/backend-api/codex/'",
        ] {
            write_config(home.path(), config);
            assert!(current_provider(home.path()).unwrap().official);
        }
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": "api-key",
                "tokens": { "access_token": "retained-token" }
            }),
        );
        assert!(current_provider(home.path()).unwrap().official);
    }

    #[test]
    fn provider_token_wins_over_retained_auth_key() {
        let home = TempDir::new().unwrap();
        write_config(home.path(), &third_party_config("responses"));
        write_auth(
            home.path(),
            serde_json::json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": "stale-auth-key",
                "tokens": { "access_token": "retained-token" }
            }),
        );
        let (_, status) = sync_current_provider(&CodeyConfig::default(), home.path()).unwrap();
        assert_eq!(status.provider.id, "relay");
        assert!(!status.provider.official);
    }

    #[test]
    fn current_provider_model_sync_reads_user_config_and_does_not_write() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
experimental_bearer_token = "fresh-key"
http_headers = { X-Static = "static-value" }
"#,
        );
        let before = fs::read(home.path().join("config.toml")).unwrap();

        let sync = current_provider_model_sync(home.path()).unwrap();

        assert_eq!(sync.snapshot.id, "relay");
        assert_eq!(sync.snapshot.ownership_key, "relay#889271d70d18");
        assert_eq!(sync.request.base_url, "https://relay.example/v1");
        assert_eq!(
            sync.request.upstream_protocol,
            crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES
        );
        assert_eq!(sync.request.api_key, "fresh-key");
        assert_eq!(sync.request.request_headers["X-Static"], "static-value");
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
    }

    #[test]
    fn current_provider_model_sync_fails_when_the_user_config_key_chain_is_empty() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_MISSING_RELAY_TOKEN"
"#,
        );

        let error = current_provider_model_sync(home.path()).unwrap_err();

        assert!(format!("{error:#}").contains("没有可用的密钥"));
        assert!(format!("{error:#}").contains("env_key"));
    }

    #[test]
    fn current_provider_model_sync_uses_inline_token_when_env_key_is_unset() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
experimental_bearer_token = "sk-inline"
env_key = "CODEY_MISSING_RELAY_TOKEN"
"#,
        );

        let sync = current_provider_model_sync(home.path()).unwrap();

        assert_eq!(sync.request.api_key, "sk-inline");
    }

    #[test]
    fn model_request_headers_merge_static_and_env_values() {
        let document = DocumentMut::from_str(
            r#"http_headers = { X-Static = "static-value" }
env_http_headers = { X-Dynamic = "DYNAMIC_HEADER" }
"#,
        )
        .unwrap();
        let table = document.as_table();
        let headers = provider_model_request_headers_with_env(table, &|name| {
            (name == "DYNAMIC_HEADER").then(|| "dynamic-value".to_string())
        });
        assert_eq!(headers["X-Static"], "static-value");
        assert_eq!(headers["X-Dynamic"], "dynamic-value");
    }

    #[test]
    fn environment_provider_keys_are_supported() {
        let document = DocumentMut::from_str(
            r#"[model_providers.relay]
env_key = "RELAY_TOKEN"
"#,
        )
        .unwrap();
        let provider = provider_table(&document, "relay").unwrap();
        let key = provider_native_api_key_with_env(Some(provider), &|name| {
            (name == "RELAY_TOKEN").then(|| "env-secret".to_string())
        });
        assert_eq!(key.as_deref(), Some("env-secret"));
    }

    #[test]
    fn prompt_optimization_overlay_reports_env_ready_without_the_secret() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
experimental_bearer_token = "inline-fixture-key"
env_key = "CODEY_PROMPT_OPT_OVERLAY_READY"
"#,
        );
        let secret = "sk-codey-opt-overlay-ready-aa11";
        let overlay = prompt_optimization_provider_overlay_with_env(home.path(), &|name| {
            (name == "CODEY_PROMPT_OPT_OVERLAY_READY").then(|| secret.to_string())
        })
        .unwrap();

        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert_eq!(overlay.env_key_name, "CODEY_PROMPT_OPT_OVERLAY_READY");
        assert_eq!(
            overlay.upstream_protocol,
            crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES
        );
        let json = serde_json::to_string(&overlay).unwrap();
        assert!(!json.contains(secret));
        assert!(!json.contains("inline-fixture-key"));
        assert!(
            !fs::read_to_string(home.path().join("config.toml"))
                .unwrap()
                .contains(secret)
        );
    }

    #[test]
    fn prompt_optimization_overlay_uses_inline_token_when_env_key_is_missing() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "chat"
experimental_bearer_token = "inline-fixture-key"
"#,
        );
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();

        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_READY);
        assert!(!overlay.message.contains("env_key"));
        assert_eq!(
            overlay.upstream_protocol,
            crate::config::UPSTREAM_PROTOCOL_OPENAI_CHAT_COMPLETIONS
        );
        let json = serde_json::to_string(&overlay).unwrap();
        assert!(!json.contains("inline-fixture-key"));
    }

    #[test]
    fn prompt_optimization_overlay_reports_declared_but_empty_env() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_OVERLAY_MISSING"
"#,
        );
        let overlay = prompt_optimization_provider_overlay_with_env(home.path(), &|name| {
            (name == "CODEY_PROMPT_OPT_OVERLAY_MISSING").then(String::new)
        })
        .unwrap();

        assert_eq!(overlay.key_status, PROMPT_OPTIMIZATION_KEY_STATUS_MISSING);
        assert_eq!(overlay.env_key_name, "CODEY_PROMPT_OPT_OVERLAY_MISSING");
        assert!(overlay.message.contains("CODEY_PROMPT_OPT_OVERLAY_MISSING"));
    }

    #[test]
    fn prompt_optimization_overlay_rejects_unsupported_wire_api() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "gemini"
env_key = "CODEY_PROMPT_OPT_OVERLAY_READY"
"#,
        );
        let overlay = prompt_optimization_provider_overlay_with_env(home.path(), &|_| {
            Some("sk-unused".to_string())
        })
        .unwrap();

        assert_eq!(
            overlay.key_status,
            PROMPT_OPTIMIZATION_KEY_STATUS_UNSUPPORTED
        );
        assert!(overlay.message.contains("gemini"));
        assert!(overlay.upstream_protocol.is_empty());
        let json = serde_json::to_string(&overlay).unwrap();
        assert!(!json.contains("sk-unused"));
    }

    #[test]
    fn prompt_optimization_overlay_marks_official_account_auth_not_applicable() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
"#,
        );
        let overlay = prompt_optimization_provider_overlay_with_env(home.path(), &|_| {
            Some("sk-must-not-be-used".to_string())
        })
        .unwrap();

        assert_eq!(
            overlay.key_status,
            PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE
        );
        let json = serde_json::to_string(&overlay).unwrap();
        assert!(!json.contains("sk-must-not-be-used"));
    }
}
