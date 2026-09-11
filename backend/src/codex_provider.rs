use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProvider {
    pub id: String,
    pub name: String,
    pub official: bool,
    pub supports_remote_compaction: bool,
    pub base_url: String,
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

/// Read-only snapshot of the user-owned `config.toml` current provider.
/// Never writes `config.toml`. Parse or schema failures are returned as errors
/// so the caller can refuse to start instead of auto-correcting.
pub fn current_provider_snapshot(codex_home: &Path) -> Result<CurrentProviderSnapshot> {
    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path)
        .load()
        .context("解析 Codex 用户配置失败")?;
    let document = config.document();
    let provider_id = active_provider_id(document).to_string();
    let table = provider_table(document, &provider_id);
    let base_url = table
        .and_then(|provider| provider.get("base_url"))
        .and_then(Item::as_str)
        .unwrap_or_default();
    let wire_api = table
        .and_then(|provider| provider.get("wire_api"))
        .and_then(Item::as_str)
        .unwrap_or("responses");
    let has_provider_scoped_api_key = provider_config_api_key(document, table).is_some();
    let normalized = crate::model_ownership::normalize_base_url(base_url);
    let official_endpoint = normalized.is_empty() || is_official_base_url(&normalized);
    let uses_official_account_auth = official_endpoint && !has_provider_scoped_api_key;
    Ok(CurrentProviderSnapshot::from_parts(
        provider_id,
        normalized,
        wire_api,
        uses_official_account_auth,
    ))
}

/// Current-provider model sync inputs. Built only from the user-owned Codex
/// config and process environment. Never reads stored `ProviderProfile`
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

pub fn prompt_optimization_provider_overlay_with_env(
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<PromptOptimizationProviderOverlay> {
    let snapshot = current_provider_snapshot(codex_home)?;
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

    if env_key_name.is_empty() {
        return Ok(PromptOptimizationProviderOverlay {
            upstream_protocol: protocol,
            key_status: PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED.to_string(),
            env_key_name: String::new(),
            message: format!(
                "当前 provider「{}」未声明 env_key。可以改用手工填写密钥。",
                snapshot.id
            ),
        });
    }

    let env_value = env(&env_key_name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if env_value.is_some() {
        return Ok(PromptOptimizationProviderOverlay {
            upstream_protocol: protocol,
            key_status: PROMPT_OPTIMIZATION_KEY_STATUS_READY.to_string(),
            env_key_name,
            message: "已从环境变量读取密钥，不会写入 Codey 或用户配置。".to_string(),
        });
    }

    Ok(PromptOptimizationProviderOverlay {
        upstream_protocol: protocol,
        key_status: PROMPT_OPTIMIZATION_KEY_STATUS_MISSING.to_string(),
        env_key_name: env_key_name.clone(),
        message: format!("环境变量「{env_key_name}」未设置。可以改用手工填写密钥。"),
    })
}

pub fn current_provider_model_sync(codex_home: &Path) -> Result<CurrentProviderModelSync> {
    let snapshot = current_provider_snapshot(codex_home)?;
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
    let api_key = if snapshot.uses_official_account_auth {
        String::new()
    } else {
        provider_config_api_key(document, table).ok_or_else(|| {
            anyhow::anyhow!(
                "当前 provider「{}」没有可用的密钥。请在用户配置中设置 env_key 指向的环境变量，或 experimental_bearer_token。Codey 不会使用自己保存的密钥，也不会把密钥写回你的配置。",
                snapshot.id
            )
        })?
    };
    let request_headers = table
        .map(provider_model_request_headers)
        .unwrap_or_default();
    Ok(CurrentProviderModelSync {
        snapshot,
        request: crate::provider_models::ModelSyncRequest {
            base_url,
            upstream_protocol,
            api_key,
            request_headers,
        },
    })
}

pub fn sync_current_third_party_provider(
    config: &CodeyConfig,
    codex_home: &Path,
) -> Result<(CodeyConfig, ProviderStatus)> {
    let snapshot = local_provider(codex_home)?;
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
            supports_remote_compaction: snapshot.uses_official_account_auth,
            base_url: snapshot.base_url.clone(),
        })
        .unwrap_or_else(|| CurrentProvider {
            id: BUILTIN_OPENAI_PROVIDER_ID.to_string(),
            name: "OpenAI 官方直登".to_string(),
            official: true,
            supports_remote_compaction: true,
            base_url: String::new(),
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
    let config_path = codex_home.join("config.toml");
    let config = ConfigManager::new(&config_path).load()?;
    let document = config.document();
    let provider_id = active_provider_id(document);
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
    let auth = read_auth_probe(&auth_path, auth_store, auth_policy)?;
    let auth_mode = auth
        .value
        .as_ref()
        .and_then(|auth| auth.get("auth_mode"))
        .and_then(Value::as_str);
    let auth_api_key = auth
        .value
        .as_ref()
        .and_then(|auth| auth.get("OPENAI_API_KEY"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let config_api_key = provider_config_api_key(document, table);
    let has_provider_scoped_api_key = config_api_key.is_some()
        || PROVIDER_KEYS.iter().chain(PROVIDER_ENV_KEYS).any(|key| {
            table
                .and_then(|provider| provider.get(key))
                .and_then(Item::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
        || ["http_headers", "env_http_headers"].iter().any(|key| {
            table
                .and_then(|provider| provider.get(key))
                .and_then(Item::as_table_like)
                .is_some_and(|headers| {
                    headers
                        .iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                })
        });
    let official_endpoint = (base_url.is_empty() && provider_id == BUILTIN_OPENAI_PROVIDER_ID)
        || is_official_base_url(&base_url);
    // A provider-scoped token describes the active route and must win over a
    // long-lived auth.json login retained alongside it.
    let api_key = config_api_key
        .or_else(|| auth_api_key.map(ToString::to_string))
        .unwrap_or_default();
    let official = official_endpoint
        && !has_provider_scoped_api_key
        && table
            .and_then(|provider| provider.get("requires_openai_auth"))
            .and_then(Item::as_bool)
            != Some(false)
        && matches!(auth_mode, None | Some("chatgpt"))
        && api_key.is_empty();
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
            supports_remote_compaction: official || name == "OpenAI",
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

fn active_provider_id(document: &DocumentMut) -> &str {
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

fn auth_has_chatgpt_tokens(auth: &Value) -> bool {
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

fn provider_config_api_key(
    document: &DocumentMut,
    provider: Option<&dyn TableLike>,
) -> Option<String> {
    provider_config_api_key_with_env(document, provider, &|name| std::env::var(name).ok())
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

fn provider_config_api_key_with_env(
    document: &DocumentMut,
    provider: Option<&dyn TableLike>,
    env_value: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    PROVIDER_KEYS
        .iter()
        .find_map(|key| {
            provider
                .and_then(|provider| provider.get(key))
                .and_then(Item::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            PROVIDER_ENV_KEYS.iter().find_map(|key| {
                let name = provider
                    .and_then(|provider| provider.get(key))
                    .and_then(Item::as_str)?
                    .trim();
                if name.is_empty() {
                    return None;
                }
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

fn provider_model_request_headers(provider: &dyn TableLike) -> BTreeMap<String, String> {
    provider_model_request_headers_with_env(provider, &|name| std::env::var(name).ok())
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
        assert!(!current_provider(home.path()).unwrap().official);
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
        let key = provider_config_api_key_with_env(&document, Some(provider), &|name| {
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
experimental_bearer_token = "inline-must-not-be-used"
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
        assert!(!json.contains("inline-must-not-be-used"));
        assert!(
            !fs::read_to_string(home.path().join("config.toml"))
                .unwrap()
                .contains(secret)
        );
    }

    #[test]
    fn prompt_optimization_overlay_does_not_use_inline_token_when_env_key_is_missing() {
        let home = TempDir::new().unwrap();
        write_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "chat"
experimental_bearer_token = "inline-must-not-be-used"
"#,
        );
        let overlay =
            prompt_optimization_provider_overlay_with_env(home.path(), &|_| None).unwrap();

        assert_eq!(
            overlay.key_status,
            PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED
        );
        assert!(overlay.message.contains("env_key"));
        assert_eq!(
            overlay.upstream_protocol,
            crate::config::UPSTREAM_PROTOCOL_OPENAI_CHAT_COMPLETIONS
        );
        let json = serde_json::to_string(&overlay).unwrap();
        assert!(!json.contains("inline-must-not-be-used"));
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
