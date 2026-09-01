use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::{fs, path::Path};

use reqwest::Client;
use serde_json::{Value, json};
use uuid::Uuid;

use super::AppState;
use crate::codex_config::{CHATGPT_CODEX_BASE_URL, codex_home};
use crate::codex_provider::{
    self, PROMPT_OPTIMIZATION_KEY_STATUS_MISSING, PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE,
    PROMPT_OPTIMIZATION_KEY_STATUS_READY, PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED,
    PROMPT_OPTIMIZATION_KEY_STATUS_UNSUPPORTED, PromptOptimizationProviderOverlay,
};
use crate::config::PromptOptimizationConfig;
use crate::error_log;
use crate::prompt_optimization;

static OPTIMIZER_CLIENT: OnceLock<Client> = OnceLock::new();
const CODEX_INSTALLATION_ID_HEADER: &str = "x-codex-installation-id";
const CODEX_INSTALLATION_ID_FILE: &str = "installation_id";
const AUTHORIZATION_HEADER: &str = "authorization";
const CHATGPT_ACCOUNT_ID_HEADER: &str = "chatgpt-account-id";

fn optimizer_client() -> Result<&'static Client, String> {
    if let Some(client) = OPTIMIZER_CLIENT.get() {
        return Ok(client);
    }
    let client = prompt_optimization::optimizer_http_client()?;
    // Concurrent callers may build a duplicate client; the first successful
    // one wins and the rest reuse it.
    Ok(OPTIMIZER_CLIENT.get_or_init(|| client))
}

fn resolve_request_config(
    optimization: &PromptOptimizationConfig,
) -> Result<prompt_optimization::ResolvedPromptOptimizationConfig, String> {
    resolve_request_config_at(optimization, codex_home(), &|name| std::env::var(name).ok())
}

fn resolve_request_config_at(
    optimization: &PromptOptimizationConfig,
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<prompt_optimization::ResolvedPromptOptimizationConfig, String> {
    if optimization.uses_official_account() {
        return resolve_official_account_request(optimization, codex_home);
    }
    if optimization.uses_current_provider() {
        return resolve_current_provider_request(optimization, codex_home, env);
    }
    resolve_manual_request_config_at(optimization, codex_home)
}

fn resolve_official_account_request(
    optimization: &PromptOptimizationConfig,
    codex_home: &Path,
) -> Result<prompt_optimization::ResolvedPromptOptimizationConfig, String> {
    let request_headers = read_official_auth_headers(codex_home).map_err(|error| {
        format!("官方账号登录不可用：{error}。提示词优化不会改用环境变量或其他已保存密钥。")
    })?;
    Ok(official_resolved(
        optimization,
        CHATGPT_CODEX_BASE_URL.to_string(),
        request_headers,
    ))
}

fn resolve_current_provider_request(
    optimization: &PromptOptimizationConfig,
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<prompt_optimization::ResolvedPromptOptimizationConfig, String> {
    let snapshot = codex_provider::current_provider_snapshot(codex_home)
        .map_err(|error| format!("读取当前 provider 失败：{error:#}"))?;
    if snapshot.uses_official_account_auth {
        let request_headers = read_official_auth_headers(codex_home).map_err(|error| {
            format!(
                "官方账号登录不可用：{error}。当前 provider 使用官方账号鉴权，提示词优化不会改用环境变量或其他已保存密钥。"
            )
        })?;
        let base_url = if snapshot.base_url.trim().is_empty() {
            CHATGPT_CODEX_BASE_URL.to_string()
        } else {
            snapshot.base_url
        };
        return Ok(official_resolved(optimization, base_url, request_headers));
    }

    let overlay = codex_provider::prompt_optimization_provider_overlay_with_env(codex_home, env)
        .map_err(|error| format!("读取当前 provider 失败：{error:#}"))?;
    match overlay.key_status.as_str() {
        status if status == PROMPT_OPTIMIZATION_KEY_STATUS_UNSUPPORTED => Err(overlay.message),
        status if status == PROMPT_OPTIMIZATION_KEY_STATUS_UNDECLARED => Err(overlay.message),
        status if status == PROMPT_OPTIMIZATION_KEY_STATUS_MISSING => Err(overlay.message),
        status if status == PROMPT_OPTIMIZATION_KEY_STATUS_READY => {
            if snapshot.base_url.trim().is_empty() {
                return Err(format!(
                    "当前 provider「{}」没有 API 地址。可以改用手工填写。",
                    snapshot.id
                ));
            }
            let api_key = env(&overlay.env_key_name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| overlay.message.clone())?;
            crate::config::validate_outbound_api_url(&snapshot.base_url, "当前 provider API 地址")?;
            Ok(prompt_optimization::ResolvedPromptOptimizationConfig {
                base_url: snapshot.base_url,
                api_key,
                request_headers: BTreeMap::new(),
                response_store: None,
                response_stream: None,
                response_omit_max_output_tokens: false,
                model: optimization.model.clone(),
                upstream_protocol: overlay.upstream_protocol,
                instruction: optimization.instruction.clone(),
            })
        }
        _ => Err(overlay.message),
    }
}

fn official_resolved(
    optimization: &PromptOptimizationConfig,
    base_url: String,
    request_headers: BTreeMap<String, String>,
) -> prompt_optimization::ResolvedPromptOptimizationConfig {
    prompt_optimization::ResolvedPromptOptimizationConfig {
        base_url,
        api_key: String::new(),
        request_headers,
        response_store: Some(false),
        response_stream: Some(true),
        response_omit_max_output_tokens: true,
        model: optimization.model.clone(),
        upstream_protocol: crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES.to_string(),
        instruction: optimization.instruction.clone(),
    }
}

fn read_official_auth_headers(codex_home: &Path) -> Result<BTreeMap<String, String>, String> {
    let auth = crate::account_usage::read_official_auth(&codex_home.join("auth.json"))
        .map_err(|error| format!("读取 Codex 官方账号登录态失败：{error}"))?;
    let mut headers = BTreeMap::new();
    headers.insert(
        AUTHORIZATION_HEADER.to_string(),
        format!("Bearer {}", auth.access_token),
    );
    if let Some(account_id) = auth.account_id {
        headers.insert(CHATGPT_ACCOUNT_ID_HEADER.to_string(), account_id);
    }
    Ok(headers)
}

fn resolve_manual_request_config_at(
    optimization: &PromptOptimizationConfig,
    codex_home: &Path,
) -> Result<prompt_optimization::ResolvedPromptOptimizationConfig, String> {
    if optimization.api_key.trim().is_empty() {
        return Err("请先配置 API Key".to_string());
    }
    let mut resolved =
        prompt_optimization::ResolvedPromptOptimizationConfig::from_custom(optimization);
    if let Some(installation_id) = read_codex_installation_id(codex_home) {
        resolved
            .request_headers
            .insert(CODEX_INSTALLATION_ID_HEADER.to_string(), installation_id);
    }
    Ok(resolved)
}

fn read_codex_installation_id(codex_home: &Path) -> Option<String> {
    let value = fs::read_to_string(codex_home.join(CODEX_INSTALLATION_ID_FILE)).ok()?;
    Uuid::parse_str(value.trim())
        .ok()
        .map(|installation_id| installation_id.to_string())
}

pub async fn optimize_prompt_command(state: &Arc<AppState>, text: String) -> Result<Value, String> {
    let config = state.config.read().await.clone();
    let optimization = config.prompt_optimization.clone();
    if !optimization.enabled {
        return Err("提示词优化尚未启用，请先在 Codey 控制台开启".to_string());
    }
    let request_config = resolve_request_config(&optimization)?;
    let client = optimizer_client()?;
    match prompt_optimization::optimize_prompt_resolved(client, &request_config, &text).await {
        Ok(optimized) => Ok(json!({"optimized": optimized})),
        Err(error) => {
            let (error, context) =
                prompt_optimization_failure_payload(&optimization, &request_config, error);
            error_log::record_failure(
                "prompt_optimization_failed",
                "optimize_prompt",
                error.clone(),
                context,
            );
            Err(error)
        }
    }
}

/// Fetches the model list advertised by the configured service for the
/// console picker. Accepts an unsaved draft like the connectivity test.
pub async fn fetch_prompt_optimization_models_command(
    state: &Arc<AppState>,
    draft: Option<PromptOptimizationConfig>,
) -> Result<Value, String> {
    let config = state.config.read().await.clone();
    let mut optimization = draft.unwrap_or_else(|| config.prompt_optimization.clone());
    optimization.merge_redacted_secrets(&config.prompt_optimization);
    optimization.validate()?;
    let request_config = resolve_request_config(&optimization)?;
    let client = optimizer_client()?;
    let models = prompt_optimization::fetch_models_resolved(client, &request_config).await;
    match models {
        Ok(models) => Ok(json!({"models": models})),
        Err(error) => {
            let (error, context) =
                prompt_optimization_failure_payload(&optimization, &request_config, error);
            error_log::record_failure(
                "prompt_optimization_models_failed",
                "fetch_prompt_optimization_models",
                error.clone(),
                context,
            );
            Err(error)
        }
    }
}

/// Tests connectivity against the saved configuration, or against an
/// unsaved draft passed by the console. The compatibility merge still accepts
/// older redacted drafts before the request is sent.
pub async fn test_prompt_optimization_command(
    state: &Arc<AppState>,
    draft: Option<PromptOptimizationConfig>,
) -> Result<Value, String> {
    let config = state.config.read().await.clone();
    let mut optimization = draft.unwrap_or_else(|| config.prompt_optimization.clone());
    optimization.merge_redacted_secrets(&config.prompt_optimization);
    optimization.validate()?;
    let request_config = resolve_request_config(&optimization)?;
    let client = optimizer_client()?;
    match prompt_optimization::test_configuration_resolved(client, &request_config).await {
        Ok(result) => Ok(json!({"status": "ok", "result": result})),
        Err(error) => {
            let (error, context) =
                prompt_optimization_failure_payload(&optimization, &request_config, error);
            error_log::record_failure(
                "prompt_optimization_test_failed",
                "test_prompt_optimization",
                error.clone(),
                context,
            );
            Err(error)
        }
    }
}

fn prompt_optimization_api_source(optimization: &PromptOptimizationConfig) -> &'static str {
    if optimization.uses_official_account() {
        "officialAccount"
    } else if optimization.uses_current_provider() {
        "currentProvider"
    } else {
        "manual"
    }
}

pub(super) fn prompt_optimization_failure_payload(
    optimization: &PromptOptimizationConfig,
    resolved: &prompt_optimization::ResolvedPromptOptimizationConfig,
    error: String,
) -> (String, Value) {
    (
        prompt_optimization::sanitize_resolved_error(&error, resolved),
        json!({
            "model": optimization.model.trim(),
            "apiSource": prompt_optimization_api_source(optimization),
        }),
    )
}

pub(super) fn apply_prompt_optimization_overlay(
    public: &mut PromptOptimizationConfig,
    overlay: Option<&PromptOptimizationProviderOverlay>,
    official_login_available: bool,
) {
    if let Some(overlay) = overlay {
        public.current_provider_key_status = overlay.key_status.clone();
        public.current_provider_key_message = overlay.message.clone();
        public.current_provider_env_key_name = overlay.env_key_name.clone();
        public.current_provider_upstream_protocol = overlay.upstream_protocol.clone();
    }
    public.credentials_ready =
        prompt_optimization_credentials_ready(public, overlay, official_login_available);
}

pub(super) fn official_login_available(codex_home: &Path) -> bool {
    crate::account_usage::read_official_auth(&codex_home.join("auth.json")).is_ok()
}

pub(super) fn current_prompt_optimization_overlay(
    codex_home: &Path,
    env: &impl Fn(&str) -> Option<String>,
) -> Option<PromptOptimizationProviderOverlay> {
    codex_provider::prompt_optimization_provider_overlay_with_env(codex_home, env).ok()
}

fn prompt_optimization_credentials_ready(
    optimization: &PromptOptimizationConfig,
    overlay: Option<&PromptOptimizationProviderOverlay>,
    official_login_available: bool,
) -> bool {
    if optimization.uses_official_account() {
        return official_login_available;
    }
    if optimization.uses_current_provider() {
        return match overlay.map(|overlay| overlay.key_status.as_str()) {
            Some(status) if status == PROMPT_OPTIMIZATION_KEY_STATUS_NOT_APPLICABLE => {
                official_login_available
            }
            Some(status) if status == PROMPT_OPTIMIZATION_KEY_STATUS_READY => true,
            _ => false,
        };
    }
    optimization.api_key_configured
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        PROMPT_OPTIMIZATION_MODE_CURRENT_PROVIDER, PROMPT_OPTIMIZATION_MODE_OFFICIAL_ACCOUNT,
    };

    #[test]
    fn official_auth_headers_are_loaded_from_codex_auth_json() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("auth.json"),
            serde_json::to_vec_pretty(&json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": "access-token",
                    "account_id": "account-123"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let headers = read_official_auth_headers(directory.path()).unwrap();

        assert_eq!(
            headers.get(AUTHORIZATION_HEADER).map(String::as_str),
            Some("Bearer access-token")
        );
        assert_eq!(
            headers.get(CHATGPT_ACCOUNT_ID_HEADER).map(String::as_str),
            Some("account-123")
        );
    }

    #[test]
    fn resolved_prompt_optimization_uses_codex_installation_id_header() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(CODEX_INSTALLATION_ID_FILE),
            " 49A95816-9EAD-4F14-B008-1D0CBAA3C328\n",
        )
        .unwrap();
        let optimization = PromptOptimizationConfig {
            api_key: "sk-test".to_string(),
            ..PromptOptimizationConfig::default()
        };

        let resolved = resolve_manual_request_config_at(&optimization, directory.path()).unwrap();

        assert_eq!(
            resolved
                .request_headers
                .get(CODEX_INSTALLATION_ID_HEADER)
                .map(String::as_str),
            Some("49a95816-9ead-4f14-b008-1d0cbaa3c328")
        );
        assert_eq!(resolved.response_store, None);
        assert_eq!(resolved.response_stream, None);
        assert!(!resolved.response_omit_max_output_tokens);
    }

    #[test]
    fn invalid_codex_installation_id_is_not_forwarded() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(CODEX_INSTALLATION_ID_FILE),
            "not-an-installation-id",
        )
        .unwrap();
        let optimization = PromptOptimizationConfig {
            api_key: "sk-test".to_string(),
            ..PromptOptimizationConfig::default()
        };

        let resolved = resolve_manual_request_config_at(&optimization, directory.path()).unwrap();

        assert!(
            !resolved
                .request_headers
                .contains_key(CODEX_INSTALLATION_ID_HEADER)
        );
    }

    fn write_user_config(home: &Path, contents: &str) {
        fs::write(home.join("config.toml"), contents).unwrap();
    }

    fn current_provider_optimization() -> PromptOptimizationConfig {
        PromptOptimizationConfig {
            enabled: true,
            mode: PROMPT_OPTIMIZATION_MODE_CURRENT_PROVIDER.to_string(),
            model: "gpt-test".to_string(),
            api_key: "leftover-manual-secret".to_string(),
            ..PromptOptimizationConfig::default()
        }
    }

    #[test]
    fn current_provider_resolve_reads_env_key_and_does_not_mutate_saved_config() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
experimental_bearer_token = "inline-must-not-be-used"
env_key = "CODEY_PROMPT_OPT_RESOLVE"
"#,
        );
        let secret = "sk-codey-opt-resolve-bb22";
        let before = fs::read(home.path().join("config.toml")).unwrap();
        let optimization = current_provider_optimization();
        let before_config = serde_json::to_value(&optimization).unwrap();

        let resolved = resolve_request_config_at(&optimization, home.path(), &|name| {
            (name == "CODEY_PROMPT_OPT_RESOLVE").then(|| secret.to_string())
        })
        .unwrap();

        assert_eq!(resolved.base_url, "https://relay.example/v1");
        assert_eq!(resolved.api_key, secret);
        assert_eq!(
            resolved.upstream_protocol,
            crate::config::UPSTREAM_PROTOCOL_OPENAI_RESPONSES
        );
        assert_eq!(resolved.response_store, None);
        assert!(!resolved.response_omit_max_output_tokens);
        assert_eq!(serde_json::to_value(&optimization).unwrap(), before_config);
        assert!(
            !serde_json::to_string(&optimization)
                .unwrap()
                .contains(secret)
        );
        assert_eq!(fs::read(home.path().join("config.toml")).unwrap(), before);
    }

    #[test]
    fn current_provider_resolve_ignores_inline_token_and_saved_manual_key() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "chat"
experimental_bearer_token = "inline-must-not-be-used"
"#,
        );
        let error =
            resolve_request_config_at(&current_provider_optimization(), home.path(), &|_| {
                Some("env-must-not-be-used".to_string())
            })
            .unwrap_err();

        assert!(error.contains("env_key"));
        assert!(!error.contains("inline-must-not-be-used"));
        assert!(!error.contains("leftover-manual-secret"));
        assert!(!error.contains("env-must-not-be-used"));
    }

    #[test]
    fn current_provider_resolve_reports_missing_env_and_unsupported_wire_api() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_MISSING"
"#,
        );
        let missing =
            resolve_request_config_at(&current_provider_optimization(), home.path(), &|_| None)
                .unwrap_err();
        assert!(missing.contains("CODEY_PROMPT_OPT_MISSING"));

        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "gemini"
env_key = "CODEY_PROMPT_OPT_RESOLVE"
"#,
        );
        let unsupported =
            resolve_request_config_at(&current_provider_optimization(), home.path(), &|_| {
                Some("sk-unused".to_string())
            })
            .unwrap_err();
        assert!(unsupported.contains("gemini"));
        assert!(!unsupported.contains("sk-unused"));
    }

    #[test]
    fn official_account_resolve_does_not_fall_back_to_env_or_saved_key() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_RESOLVE"
"#,
        );
        let mut optimization = current_provider_optimization();
        optimization.mode = PROMPT_OPTIMIZATION_MODE_OFFICIAL_ACCOUNT.to_string();
        let error = resolve_request_config_at(&optimization, home.path(), &|_| {
            Some("sk-env-must-not-be-used".to_string())
        })
        .unwrap_err();

        assert!(error.contains("官方账号登录不可用"));
        assert!(error.contains("不会改用"));
        assert!(!error.contains("sk-env-must-not-be-used"));
        assert!(!error.contains("leftover-manual-secret"));
    }

    #[test]
    fn current_provider_official_auth_does_not_fall_back_to_env() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_RESOLVE"
"#,
        );
        let error =
            resolve_request_config_at(&current_provider_optimization(), home.path(), &|_| {
                Some("sk-env-must-not-be-used".to_string())
            })
            .unwrap_err();

        assert!(error.contains("官方账号登录不可用"));
        assert!(!error.contains("sk-env-must-not-be-used"));
    }

    #[test]
    fn official_account_resolve_uses_chatgpt_url_and_auth_headers() {
        let home = tempfile::tempdir().unwrap();
        fs::write(
            home.path().join("auth.json"),
            serde_json::to_vec_pretty(&json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": "official-access-token",
                    "account_id": "acct-1"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let mut optimization = current_provider_optimization();
        optimization.mode = PROMPT_OPTIMIZATION_MODE_OFFICIAL_ACCOUNT.to_string();

        let resolved = resolve_request_config_at(&optimization, home.path(), &|_| {
            Some("sk-env-must-not-be-used".to_string())
        })
        .unwrap();

        assert_eq!(resolved.base_url, CHATGPT_CODEX_BASE_URL);
        assert!(resolved.api_key.is_empty());
        assert_eq!(
            resolved
                .request_headers
                .get(AUTHORIZATION_HEADER)
                .map(String::as_str),
            Some("Bearer official-access-token")
        );
        assert_eq!(resolved.response_store, Some(false));
        assert_eq!(resolved.response_stream, Some(true));
        assert!(resolved.response_omit_max_output_tokens);
        assert!(!resolved.api_key.contains("sk-env-must-not-be-used"));
    }

    #[test]
    fn prompt_optimization_failure_payload_omits_env_key() {
        let home = tempfile::tempdir().unwrap();
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_LOG"
"#,
        );
        let secret = "sk-codey-opt-leak-log-cc33";
        let optimization = current_provider_optimization();
        let resolved = resolve_request_config_at(&optimization, home.path(), &|name| {
            (name == "CODEY_PROMPT_OPT_LOG").then(|| secret.to_string())
        })
        .unwrap();
        let (error, context) = prompt_optimization_failure_payload(
            &optimization,
            &resolved,
            format!("upstream rejected {secret}"),
        );
        let dumped = format!("{error}{}", serde_json::to_string(&context).unwrap());
        assert!(!dumped.contains(secret));
        assert_eq!(context["apiSource"], "currentProvider");
        assert!(!dumped.contains("leftover-manual-secret"));
    }

    #[test]
    fn current_provider_env_key_is_not_persisted_in_codey_config() {
        let home = tempfile::tempdir().unwrap();
        let secret = "sk-codey-opt-leak-persist-dd44";
        write_user_config(
            home.path(),
            r#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
env_key = "CODEY_PROMPT_OPT_PERSIST"
"#,
        );
        let optimization = current_provider_optimization();
        let resolved = resolve_request_config_at(&optimization, home.path(), &|name| {
            (name == "CODEY_PROMPT_OPT_PERSIST").then(|| secret.to_string())
        })
        .unwrap();
        assert_eq!(resolved.api_key, secret);

        let config = crate::config::CodeyConfig {
            prompt_optimization: optimization,
            ..crate::config::CodeyConfig::default()
        };
        let store = crate::config::ConfigStore::new(home.path().join("config.json"));
        store.save(&config).unwrap();
        let saved = fs::read_to_string(home.path().join("config.json")).unwrap();
        assert!(!saved.contains(secret));
        assert!(saved.contains("leftover-manual-secret"));
    }
}
