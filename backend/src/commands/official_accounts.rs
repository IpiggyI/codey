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
    let login_id = uuid::Uuid::new_v4().to_string();
    logins.insert(login_id.clone(), session);
    drop(logins);
    let url = auth_url.clone();
    let browser_opened = tokio::task::spawn_blocking(move || open_browser(&url))
        .await
        .map_err(|_| "打开浏览器任务异常退出")?;
    Ok(
        json!({"status":"wait","loginId":login_id,"authUrl":auth_url,"browserOpened":browser_opened}),
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
        Err(_) => {
            eprintln!("打开官方账号登录浏览器失败，请使用返回的授权地址");
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
        if !matches!(phase, LoginPhase::Waiting) {
            logins.remove(id);
        }
        phase
    };
    match phase {
        LoginPhase::Waiting => Ok(json!({"status":"wait"})),
        LoginPhase::Failed(message) => Ok(json!({"status":"failed","message":message})),
        LoginPhase::Completed(account) => {
            let _guard = state.official_account_lock.lock().await;
            add_account(state, *account, home)
        }
    }
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
    config.selected_channel_id = Some(channel_id.clone());
    if !config.default_model.is_empty() {
        config
            .default_models_by_channel
            .entry(channel_id)
            .or_insert_with(|| config.default_model.clone());
    }
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
