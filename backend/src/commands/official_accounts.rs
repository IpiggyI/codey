use super::*;
use crate::official_accounts::{
    OfficialAccountStore,
    oauth::{self, LoginPhase},
};

impl AppState {
    pub(crate) fn official_accounts(&self) -> OfficialAccountStore {
        OfficialAccountStore::new(self.store.path().parent().unwrap_or_else(|| Path::new(".")))
    }

    pub(crate) fn sync_official_accounts_at_startup(&self, home: &Path) -> anyhow::Result<()> {
        self.official_accounts().sync_from_codex(home)
    }
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
    home: &Path,
) -> Result<Value, String> {
    match command {
        "start_official_account_login" => start_login(state).await,
        "submit_official_account_login_callback" => {
            submit_login_callback(
                state,
                &string_argument(args, "loginId")?,
                &string_argument(args, "callbackUrl")?,
                home,
            )
            .await
        }
        "poll_official_account_login" => {
            poll_login(state, &string_argument(args, "loginId")?, home).await
        }
        "cancel_official_account_login" => {
            if let Some(session) = state
                .official_account_logins
                .lock()
                .await
                .remove(&string_argument(args, "loginId")?)
            {
                session.cancel();
            }
            Ok(json!({"status":"ok"}))
        }
        "query_official_account_usage" => Ok(query_usage(state, args, home)
            .await
            .unwrap_or_else(|message| json!({"status":"error","message":message}))),
        "store_official_account_usage" => store_usage(state, args, home).await,
        "set_default_official_account" => {
            switch_account(state, &string_argument(args, "accountId")?, home).await
        }
        "import_official_account_credential" => {
            let input = string_argument(args, "credential")?;
            let account = oauth::import_credential(&state.http_client, &input)
                .await
                .map_err(|e| e.to_string())?;
            let _guard = state.official_account_lock.lock().await;
            add_account(state, account, home)
        }
        _ => {
            let _guard = state.official_account_lock.lock().await;
            invoke_local(state, command, args, home).map_err(|e| e.to_string())
        }
    }
}

fn invoke_local(
    state: &AppState,
    command: &str,
    args: &Value,
    home: &Path,
) -> anyhow::Result<Value> {
    let store = state.official_accounts();
    match command {
        "list_official_accounts" => {
            store.sync_from_codex(home)?;
            store.payload(home)
        }
        "import_current_codex_login" => {
            let account = store.import_current(home)?;
            let mut payload = store.payload(home)?;
            payload["accountId"] = json!(account.id);
            Ok(payload)
        }
        "remove_official_account" => {
            let id = string_argument(args, "accountId").map_err(anyhow::Error::msg)?;
            store.remove(&id)?;
            store.payload(home)
        }
        _ => anyhow::bail!("未知官方账号命令"),
    }
}

fn add_account(
    state: &AppState,
    account: crate::official_accounts::Account,
    home: &Path,
) -> Result<Value, String> {
    let store = state.official_accounts();
    let account = store.upsert(account).map_err(|e| e.to_string())?;
    let mut payload = store.payload(home).map_err(|e| e.to_string())?;
    payload["accountId"] = json!(account.id);
    Ok(payload)
}

async fn start_login(state: &Arc<AppState>) -> Result<Value, String> {
    let mut logins = state.official_account_logins.lock().await;
    logins.cancel_all().await;
    let session = oauth::start_login(state.http_client.clone())
        .await
        .map_err(|e| e.to_string())?;
    let auth_url = session.auth_url.clone();
    let callback_listening = session.callback_listening;
    let callback_error = session.callback_error.clone();
    let login_id = uuid::Uuid::new_v4().to_string();
    logins.insert(login_id.clone(), session);
    drop(logins);
    let url = auth_url.clone();
    let browser_opened = tokio::task::spawn_blocking(move || open_browser(&url))
        .await
        .map_err(|_| "打开浏览器任务异常退出")?;
    Ok(
        json!({"status":"wait","loginId":login_id,"authUrl":auth_url,"browserOpened":browser_opened,
            "callbackListening":callback_listening,"callbackError":callback_error}),
    )
}

fn open_browser(url: &str) -> bool {
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    match result {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(error) => {
            eprintln!("打开官方账号登录浏览器失败，请使用返回的授权地址：{error}");
            false
        }
    }
}

async fn poll_login(state: &Arc<AppState>, id: &str, home: &Path) -> Result<Value, String> {
    let phase = {
        let mut logins = state.official_account_logins.lock().await;
        logins.remove_expired();
        let Some(session) = logins.get(id) else {
            return Ok(json!({"status":"expired","message":"登录已过期或已取消，请重新添加账号"}));
        };
        let phase = session.phase();
        if !matches!(phase, LoginPhase::Waiting | LoginPhase::Exchanging) {
            logins.remove(id);
        }
        phase
    };
    match phase {
        LoginPhase::Waiting | LoginPhase::Exchanging => Ok(json!({"status":"wait"})),
        LoginPhase::Failed(message) => Ok(json!({"status":"failed","message":message})),
        LoginPhase::Completed(account) => {
            let _guard = state.official_account_lock.lock().await;
            add_account(state, *account, home)
        }
    }
}

async fn submit_login_callback(
    state: &Arc<AppState>,
    id: &str,
    callback_url: &str,
    home: &Path,
) -> Result<Value, String> {
    let mut logins = state.official_account_logins.lock().await;
    logins.remove_expired();
    let session = logins.get(id).ok_or("登录已过期或已取消，请重新添加账号")?;
    let account = session
        .submit_callback(callback_url)
        .await
        .map_err(|e| e.to_string())?;
    logins.remove(id);
    drop(logins);
    let _guard = state.official_account_lock.lock().await;
    add_account(state, account, home)
}

pub(super) async fn switch_account(
    state: &Arc<AppState>,
    id: &str,
    home: &Path,
) -> Result<Value, String> {
    let _config_guard = state.config_write_lock.lock().await;
    let _account_guard = state.official_account_lock.lock().await;
    let mut config = state.config.read().await.clone();
    let channel_id = format!("official:{id}");
    crate::channels::require_switch_model(home, &config, &channel_id)
        .map_err(|error| error.to_string())?;
    config.selected_channel_id = Some(channel_id);
    config.settings_revision = config.settings_revision.saturating_add(1);
    let store = state.official_accounts();
    let payload = store
        .activate(home, id, || {
            config.attach_current_provider_snapshot(
                codex_provider::current_provider_snapshot_for_config(home, &config)?,
            );
            let mut payload = store.payload(home)?;
            payload["accountId"] = json!(id);
            payload["restartRequired"] = json!(true);
            payload["settingsRevision"] = json!(config.settings_revision);
            state.store.save(&config)?;
            Ok(payload)
        })
        .map_err(|e| format!("{e:#}"))?;
    *state.config.write().await = config;
    Ok(payload)
}

async fn query_usage(state: &Arc<AppState>, args: &Value, home: &Path) -> Result<Value, String> {
    query_usage_with(state, args, home, |auth| {
        account_usage::fetch_usage_for_auth(&state.http_client, auth)
    })
    .await
}

async fn query_usage_with<F, Fut>(
    state: &Arc<AppState>,
    args: &Value,
    home: &Path,
    fetch: F,
) -> Result<Value, String>
where
    F: FnOnce(account_usage::OfficialAuth) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<account_usage::AccountUsageSnapshot>>,
{
    let force = optional_argument::<bool>(args, "forceRefresh")?.unwrap_or(false);
    let store = state.official_accounts();
    let request = {
        let _guard = state.official_account_lock.lock().await;
        store.sync_from_codex(home).map_err(|e| e.to_string())?;
        let id = usage_account_id(args, home)?;
        let account = store
            .get(&id)
            .map_err(|e| e.to_string())?
            .ok_or("找不到官方账号")?;
        let mut usage = state.official_account_usage.lock().await;
        if !force && let Some(cached) = usage.cached(&account) {
            return Ok(cached);
        }
        usage.begin(&account).map_err(|e| e.to_string())?
    };
    let snapshot = fetch(request.auth.clone())
        .await
        .map_err(|e| e.to_string())?;
    let _guard = state.official_account_lock.lock().await;
    store.sync_from_codex(home).map_err(|e| e.to_string())?;
    state
        .official_account_usage
        .lock()
        .await
        .complete(&store, &request, snapshot)
        .map_err(|e| e.to_string())
}

fn usage_account_id(args: &Value, home: &Path) -> Result<String, String> {
    optional_argument::<String>(args, "accountId")?
        .or(crate::official_accounts::current_id(home).map_err(|e| e.to_string())?)
        .ok_or_else(|| "当前没有可用的官方账号".into())
}

pub(super) async fn store_usage(
    state: &AppState,
    args: &Value,
    home: &Path,
) -> Result<Value, String> {
    let generation = argument::<u64>(args, "authGeneration")?;
    let snapshot = argument::<account_usage::AccountUsageSnapshot>(args, "snapshot")?;
    let _guard = state.official_account_lock.lock().await;
    let store = state.official_accounts();
    store.sync_from_codex(home).map_err(|e| e.to_string())?;
    let account = store
        .get(&usage_account_id(args, home)?)
        .map_err(|e| e.to_string())?
        .ok_or("找不到官方账号")?;
    state
        .official_account_usage
        .lock()
        .await
        .store_displayed(&account, generation, snapshot)
        .map_err(|e| e.to_string())?;
    Ok(json!({"status":"ok"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::official_accounts::Account;

    struct CallbackExchange(std::sync::atomic::AtomicUsize);

    #[async_trait::async_trait]
    impl oauth::TokenExchange for CallbackExchange {
        async fn exchange(&self, grant: Value) -> anyhow::Result<Value> {
            assert_eq!(grant["grant_type"], "authorization_code");
            assert_eq!(grant["redirect_uri"], "http://localhost:1455/auth/callback");
            assert!(!grant["code_verifier"].as_str().unwrap().is_empty());
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({"access_token":"fake-access", "account_id":"pasted-account"}))
        }
    }

    #[tokio::test]
    async fn commands_official_account_oauth_paste_validates_and_consumes_once() {
        for prefix in ["http://localhost:1455/auth/callback?", "", "?"] {
            let (_dir, home, state, _) = fixture();
            let exchange = Arc::new(CallbackExchange(std::sync::atomic::AtomicUsize::new(0)));
            let held = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let session =
                oauth::start_login_on_port(exchange.clone(), held.local_addr().unwrap().port())
                    .await
                    .unwrap();
            assert!(!session.callback_listening);
            assert!(
                session
                    .callback_error
                    .as_deref()
                    .unwrap()
                    .contains("已被占用")
            );
            let auth = reqwest::Url::parse(&session.auth_url).unwrap();
            let expected = auth
                .query_pairs()
                .find(|(key, _)| key == "state")
                .unwrap()
                .1
                .into_owned();
            state
                .official_account_logins
                .lock()
                .await
                .insert("paste".into(), session);
            let before = state.official_accounts().payload(&home).unwrap();
            for (query, message) in [
                ("code=fake&state=wrong".to_string(), "状态校验失败"),
                (
                    format!("error=denied&error_description=用户拒绝&state={expected}"),
                    "用户拒绝",
                ),
                (format!("state={expected}"), "缺少授权码"),
            ] {
                let error = invoke(
                    &state,
                    "submit_official_account_login_callback",
                    &json!({"loginId":"paste", "callbackUrl":query}),
                    &home,
                )
                .await
                .unwrap_err();
                assert!(error.contains(message), "{error}");
                assert_eq!(exchange.0.load(std::sync::atomic::Ordering::SeqCst), 0);
                assert_eq!(state.official_accounts().payload(&home).unwrap(), before);
                assert_eq!(
                    poll_login(&state, "paste", &home).await.unwrap()["status"],
                    "wait"
                );
            }
            let args = json!({"loginId":"paste", "callbackUrl":format!("{prefix}code=fake&state={expected}")});
            let result = invoke(
                &state,
                "submit_official_account_login_callback",
                &args,
                &home,
            )
            .await
            .unwrap();
            assert_eq!(result["accounts"].as_array().unwrap().len(), 2);
            assert!(result["accountId"].is_string());
            assert_eq!(
                poll_login(&state, "paste", &home).await.unwrap()["status"],
                "expired"
            );
            let saved = state.official_accounts().payload(&home).unwrap();
            assert!(
                invoke(
                    &state,
                    "submit_official_account_login_callback",
                    &args,
                    &home
                )
                .await
                .is_err()
            );
            assert_eq!(exchange.0.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(state.official_accounts().payload(&home).unwrap(), saved);
        }
    }

    #[tokio::test]
    async fn commands_official_account_oauth_unknown_cancelled_reject_paste() {
        let (_dir, home, state, _) = fixture();
        let session = oauth::start_login_on_port(
            Arc::new(CallbackExchange(std::sync::atomic::AtomicUsize::new(0))),
            0,
        )
        .await
        .unwrap();
        state
            .official_account_logins
            .lock()
            .await
            .insert("cancelled".into(), session);
        invoke(
            &state,
            "cancel_official_account_login",
            &json!({"loginId":"cancelled"}),
            &home,
        )
        .await
        .unwrap();
        for id in ["unknown", "cancelled"] {
            assert!(
                submit_login_callback(&state, id, "code=fake", &home)
                    .await
                    .unwrap_err()
                    .contains("已过期或已取消")
            );
        }
    }

    #[tokio::test]
    async fn commands_official_account_oauth_listener_wins_before_paste_or_poll() {
        let (_dir, home, state, _) = fixture();
        let exchange = Arc::new(CallbackExchange(std::sync::atomic::AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let session = oauth::start_login_with_listener(exchange.clone(), Ok(listener));
        let auth = reqwest::Url::parse(&session.auth_url).unwrap();
        let expected = auth
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        state
            .official_account_logins
            .lock()
            .await
            .insert("listener".into(), session);
        let query = format!("code=fake&state={expected}");
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        socket
            .write_all(
                format!("GET /auth/callback?{query} HTTP/1.1\r\nHost: localhost\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        let before = state.official_accounts().payload(&home).unwrap();
        assert!(
            submit_login_callback(&state, "listener", &query, &home)
                .await
                .is_err()
        );
        assert_eq!(state.official_accounts().payload(&home).unwrap(), before);
        let result = poll_login(&state, "listener", &home).await.unwrap();
        assert_eq!(result["accounts"].as_array().unwrap().len(), 2);
        assert_eq!(
            poll_login(&state, "listener", &home).await.unwrap()["status"],
            "expired"
        );
        assert!(
            submit_login_callback(&state, "listener", &query, &home)
                .await
                .is_err()
        );
        assert_eq!(exchange.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, Arc<AppState>, String) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex");
        std::fs::create_dir(&home).unwrap();
        let state = Arc::new(AppState::with_store(ConfigStore::new(
            dir.path().join("codey/config.json"),
        )));
        let account = state.official_accounts().upsert(Account::from_auth(json!({"auth_mode":"chatgpt",
            "tokens":{"account_id":"test-account","access_token":"secret-access","refresh_token":"secret-refresh"}})).unwrap()).unwrap();
        std::fs::write(
            home.join("auth.json"),
            serde_json::to_vec_pretty(&account.auth).unwrap(),
        )
        .unwrap();
        (dir, home, state, account.id)
    }

    #[tokio::test]
    async fn commands_official_accounts_import_list_switch_remove_never_start_runtime() {
        let (_dir, home, state, id) = fixture();
        state.config.write().await.default_model = "global-model".into();
        let original = std::fs::read(home.join("auth.json")).unwrap();
        let modified = std::fs::metadata(home.join("auth.json"))
            .unwrap()
            .modified()
            .unwrap();
        state.sync_official_accounts_at_startup(&home).unwrap();
        for command in ["list_official_accounts", "import_current_codex_login"] {
            let payload = invoke(&state, command, &json!({}), &home).await.unwrap();
            assert_eq!(payload["defaultAccountId"], id);
            assert!(!payload.to_string().contains("secret-"));
            assert!(!payload.to_string().contains("tokens"));
        }
        assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), original);
        assert_eq!(
            std::fs::metadata(home.join("auth.json"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        let switched = invoke(
            &state,
            "set_default_official_account",
            &json!({"accountId":id}),
            &home,
        )
        .await
        .unwrap();
        assert_eq!(switched["restartRequired"], true);
        assert_eq!(
            state.config.read().await.selected_channel_id,
            Some(format!("official:{id}"))
        );
        assert!(state.runtime.lock().await.is_none());
        let before_remove = std::fs::read(home.join("auth.json")).unwrap();
        let removed = invoke(
            &state,
            "remove_official_account",
            &json!({"accountId":id}),
            &home,
        )
        .await
        .unwrap();
        assert_eq!(removed["accounts"], json!([]));
        assert_eq!(
            std::fs::read(home.join("auth.json")).unwrap(),
            before_remove
        );
    }

    #[tokio::test]
    async fn commands_official_accounts_switch_resolves_fallback_without_persisting_it() {
        for step in 0..3 {
            let (_dir, home, state, id) = fixture();
            let channel_id = format!("official:{id}");
            std::fs::write(home.join("config.toml"), "model='codex-model'\n").unwrap();
            {
                let mut config = state.config.write().await;
                if step == 0 {
                    config
                        .default_models_by_channel
                        .insert(channel_id.clone(), "channel-model".into());
                }
                if step <= 1 {
                    config.default_model = "global-model".into();
                }
            }
            let before = state.config.read().await.default_models_by_channel.clone();
            switch_account(&state, &id, &home).await.unwrap();
            let config = state.config.read().await.clone();
            let overrides = crate::channels::runtime_overrides(&home, &config)
                .unwrap()
                .join("\n")
                .parse::<toml_edit::DocumentMut>()
                .unwrap();
            assert_eq!(
                overrides["model"].as_str(),
                Some(["channel-model", "global-model", "codex-model"][step])
            );
            assert_eq!(config.default_models_by_channel, before);
            assert_eq!(
                state.store.load().unwrap().default_models_by_channel,
                before
            );
        }
    }

    #[tokio::test]
    async fn commands_official_accounts_switch_without_any_default_model_fails_before_touching_auth()
     {
        let (_dir, home, state, _id) = fixture();
        let second = state
            .official_accounts()
            .upsert(
                Account::from_auth(json!({"auth_mode":"chatgpt",
            "tokens":{"account_id":"second-account","access_token":"second-secret"}}))
                .unwrap(),
            )
            .unwrap();
        let original = std::fs::read(home.join("auth.json")).unwrap();
        let before = state.config.read().await.clone();
        assert!(before.default_model.is_empty());
        let error = invoke(
            &state,
            "set_default_official_account",
            &json!({"accountId":second.id}),
            &home,
        )
        .await
        .unwrap_err();
        assert!(error.contains("请先设置默认模型"), "{error}");
        assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), original);
        let after = state.config.read().await.clone();
        assert_eq!(after.settings_revision, before.settings_revision);
        assert_eq!(after.selected_channel_id, before.selected_channel_id);
        assert_eq!(
            state.store.load().unwrap().settings_revision,
            before.settings_revision
        );

        // 渠道默认模型优先于全局默认模型。
        let channel_id = format!("official:{}", second.id);
        state.config.write().await.default_model = "global-model".into();
        state
            .config
            .write()
            .await
            .default_models_by_channel
            .insert(channel_id.clone(), "channel-model".into());
        invoke(
            &state,
            "set_default_official_account",
            &json!({"accountId":second.id}),
            &home,
        )
        .await
        .unwrap();
        assert_ne!(std::fs::read(home.join("auth.json")).unwrap(), original);
        assert_eq!(
            state.config.read().await.default_models_by_channel[&channel_id],
            "channel-model"
        );
    }

    #[tokio::test]
    async fn commands_official_accounts_quota_uses_requested_credentials_and_rejects_stale_display()
    {
        let (_dir, home, state, id) = fixture();
        let second = state
            .official_accounts()
            .upsert(
                Account::from_auth(json!({"auth_mode":"chatgpt",
            "tokens":{"account_id":"second-account","access_token":"second-secret"}}))
                .unwrap(),
            )
            .unwrap();
        let args = json!({"accountId":second.id,"forceRefresh":true});
        let response = query_usage_with(&state, &args, &home, |auth| async move {
            assert_eq!(auth.access_token, "second-secret");
            assert_eq!(auth.account_id.as_deref(), Some("second-account"));
            Ok(account_usage::AccountUsageSnapshot {
                plan_type: Some("plus".into()),
                primary: None,
                secondary: None,
                credits: None,
                additional_limits: vec![],
                account_label: None,
                fetched_at: 10,
            })
        })
        .await
        .unwrap();
        assert_eq!(response["status"], "ok");
        assert!(!response.to_string().contains("secret"));
        assert_eq!(
            state
                .official_accounts()
                .get(&second.id)
                .unwrap()
                .unwrap()
                .plan_type
                .as_deref(),
            Some("plus")
        );
        let generation = response["authGeneration"].as_u64().unwrap();
        let args = json!({"accountId":second.id,"authGeneration":generation,"snapshot":response});
        assert_eq!(
            invoke(&state, "store_official_account_usage", &args, &home)
                .await
                .unwrap()["status"],
            "ok"
        );
        let wrong_account = json!({"accountId":id,"authGeneration":generation,"snapshot":response});
        assert!(
            invoke(
                &state,
                "store_official_account_usage",
                &wrong_account,
                &home
            )
            .await
            .is_err()
        );
        let mut changed = second;
        changed.auth["tokens"]["access_token"] = json!("new-secret");
        state.official_accounts().upsert(changed).unwrap();
        assert!(
            invoke(&state, "store_official_account_usage", &args, &home)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn commands_official_accounts_cancel_and_expired_poll_are_token_free() {
        let (_dir, home, state, _) = fixture();
        let args = json!({"loginId":"missing"});
        assert_eq!(
            invoke(&state, "cancel_official_account_login", &args, &home)
                .await
                .unwrap(),
            json!({"status":"ok"})
        );
        assert_eq!(
            invoke(&state, "poll_official_account_login", &args, &home)
                .await
                .unwrap()["status"],
            "expired"
        );
    }
}
