use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) mod oauth;
mod storage;
#[cfg(test)]
mod tests;
pub(crate) mod usage;

const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub id: String,
    pub added_at: u64,
    pub generation: String,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub auth: Value,
}

impl Account {
    pub fn from_auth(auth: Value) -> Result<Self> {
        validate_auth(&auth)?;
        Ok(Self {
            id: account_key(auth["tokens"]["account_id"].as_str().unwrap()),
            added_at: unix_timestamp(),
            generation: uuid::Uuid::new_v4().to_string(),
            plan_type: None,
            email: None,
            auth,
        })
    }

    pub fn summary(&self, current: Option<&str>) -> Value {
        let claims: Vec<Value> = ["id_token", "access_token"]
            .iter()
            .filter_map(|key| self.auth["tokens"][key].as_str())
            .filter_map(crate::account_usage::jwt_claims)
            .collect();
        let mut value = json!({"id":self.id,"accountId":self.auth["tokens"]["account_id"],
            "addedAt":self.added_at,"invalid":false,"isDefault":current == Some(&self.id)});
        for (field, source) in [("email", "email"), ("planType", "chatgpt_plan_type")] {
            if let Some(text) = claims.iter().find_map(|claim| {
                claim[source]
                    .as_str()
                    .or_else(|| claim["https://api.openai.com/auth"][source].as_str())
            }) {
                value[field] = json!(text);
            }
        }
        if let Some(refresh) = self.auth["last_refresh"].as_str() {
            value["lastRefresh"] = json!(refresh);
        }
        if let Some(plan) = &self.plan_type {
            value["planType"] = json!(plan);
        }
        if let Some(email) = &self.email {
            value["email"] = json!(email);
        }
        value
    }
}

pub(crate) fn account_key(account_id: &str) -> String {
    crate::fs_util::sha256_hex(account_id.as_bytes())
}

pub(crate) fn validate_auth(auth: &Value) -> Result<()> {
    ensure!(
        auth["auth_mode"].as_str() == Some("chatgpt"),
        "官方账号缺少有效的 auth_mode"
    );
    for field in ["account_id", "access_token"] {
        ensure!(
            auth["tokens"][field]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty()),
            "官方账号缺少 tokens.{field}"
        );
    }
    Ok(())
}

pub(crate) fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone)]
pub(crate) struct OfficialAccountStore {
    root: PathBuf,
}

impl OfficialAccountStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            root: config_dir.join("official-accounts"),
        }
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        ensure!(
            id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
            "官方账号标识无效"
        );
        Ok(self.root.join(format!("{id}.json")))
    }

    pub fn get(&self, id: &str) -> Result<Option<Account>> {
        let path = self.path(id)?;
        if !path.try_exists()? {
            return Ok(None);
        }
        let bytes = crate::fs_util::read_bounded(&path, MAX_DOCUMENT_BYTES)?;
        let account: Account = serde_json::from_slice(&bytes).context("账号库文档格式无效")?;
        validate_auth(&account.auth)?;
        ensure!(
            account.id == id
                && account_key(account.auth["tokens"]["account_id"].as_str().unwrap()) == id,
            "账号库身份不一致"
        );
        Ok(Some(account))
    }

    pub fn accounts(&self) -> Result<Vec<Account>> {
        if !self.root.try_exists()? {
            return Ok(Vec::new());
        }
        let mut accounts = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .context("账号文件名无效")?;
                if let Some(account) = self.get(id)? {
                    accounts.push(account);
                }
            }
        }
        accounts.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        Ok(accounts)
    }

    pub fn upsert(&self, mut account: Account) -> Result<Account> {
        validate_auth(&account.auth)?;
        if let Some(old) = self.get(&account.id)? {
            account.added_at = old.added_at;
            if old.auth == account.auth {
                return Ok(old);
            }
            if account.plan_type.is_none() {
                account.plan_type = old.plan_type;
            }
            if account.email.is_none() {
                account.email = old.email;
            }
        }
        account.generation = uuid::Uuid::new_v4().to_string();
        storage::write_private(&self.path(&account.id)?, &serde_json::to_vec(&account)?)?;
        Ok(account)
    }

    pub fn import_current(&self, home: &Path) -> Result<Account> {
        ensure_file_store(home)?;
        let mut auth = read_auth(home)?.context("当前 Codex 没有官方登录")?;
        oauth::complete_identity(&mut auth);
        self.upsert(Account::from_auth(auth)?)
    }

    pub(super) fn update_plan(&self, account: &Account, plan: Option<&str>) -> Result<()> {
        if let Some(plan) = plan {
            let mut updated = account.clone();
            updated.plan_type = Some(plan.to_string());
            storage::write_private(&self.path(&account.id)?, &serde_json::to_vec(&updated)?)?;
        }
        Ok(())
    }

    pub fn sync_from_codex(&self, home: &Path) -> Result<()> {
        if switch_disabled_reason(home)?.is_some() {
            return Ok(());
        }
        let Some(mut auth) = read_auth(home)? else {
            return Ok(());
        };
        oauth::complete_identity(&mut auth);
        // 当前登录无法用于回存时仍允许查看和切换其他账号。
        let Ok(account) = Account::from_auth(auth) else {
            return Ok(());
        };
        if let Some(stored) = self.get(&account.id)? {
            let parse_refresh = |auth: &Value| {
                auth["last_refresh"]
                    .as_str()
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            };
            let newer = match (parse_refresh(&account.auth), parse_refresh(&stored.auth)) {
                (Some(current), Some(saved)) => current >= saved,
                _ => true,
            };
            if newer {
                self.upsert(account)?;
            }
        }
        Ok(())
    }

    pub fn payload(&self, home: &Path) -> Result<Value> {
        let reason = switch_disabled_reason(home)?;
        let current = current_id(home)?;
        let accounts = self.accounts()?;
        let default = current
            .as_ref()
            .filter(|id| accounts.iter().any(|a| &a.id == *id));
        Ok(
            json!({"status":"ok", "accounts":accounts.iter().map(|a| a.summary(default.map(String::as_str))).collect::<Vec<_>>(),
            "defaultAccountId":default,"officialAccountAvailable":current.is_some(),
            "officialAccountStatus":if current.is_some() {"authenticated"} else {"unauthenticated"},
            "switchDisabledReason":reason}),
        )
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let path = self.path(id)?;
        if path.try_exists()? {
            fs::remove_file(path).context("删除官方账号失败")?;
        }
        Ok(())
    }

    pub fn activate<T>(
        &self,
        home: &Path,
        id: &str,
        finish: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.activate_with(home, id, finish, |path, bytes| {
            crate::fs_util::atomic_write_private(path, bytes)
        })
    }

    fn activate_with<T>(
        &self,
        home: &Path,
        id: &str,
        finish: impl FnOnce() -> Result<T>,
        write: impl FnOnce(&Path, &[u8]) -> Result<()>,
    ) -> Result<T> {
        ensure_file_store(home)?;
        self.sync_from_codex(home)?;
        let target = self.get(id)?.context("找不到官方账号")?;
        validate_auth(&target.auth)?;
        let loaded =
            codey_runtime_core::config_manager::ConfigManager::new(home.join("config.toml"))
                .load()?;
        ensure!(
            crate::codex_provider::official_channel_available(loaded.document(), &target.auth),
            "openai provider 配置不支持官方登录"
        );
        let path = home.join("auth.json");
        let original = if path.try_exists()? {
            Some(crate::fs_util::read_bounded(&path, MAX_DOCUMENT_BYTES)?)
        } else {
            None
        };
        let backup = self
            .root
            .join("backups")
            .join(format!("{}.json", uuid::Uuid::new_v4()));
        if let Some(bytes) = &original {
            storage::write_private(&backup, bytes).context("备份当前官方登录失败")?;
            ensure!(fs::read(&backup)? == *bytes, "官方登录备份校验失败");
        }
        let bytes = serde_json::to_vec_pretty(&target.auth)?;
        // Codex 可能在备份期间刷新令牌，检测到变化就保留它的新文档。
        let latest = if path.try_exists()? {
            Some(fs::read(&path)?)
        } else {
            None
        };
        ensure!(latest == original, "Codex 登录在切换期间发生变化，请重试");
        let result = (|| {
            write(&path, &bytes)?;
            ensure!(fs::read(&path)? == bytes, "切换后的官方登录校验失败");
            finish()
        })();
        if let Err(error) = result {
            if fs::read(&path).ok().as_deref() != original.as_deref() {
                match original {
                    Some(_) => crate::fs_util::atomic_write_private(&path, &fs::read(&backup)?)
                        .context("切换失败且恢复备份失败")?,
                    None => {
                        if path.try_exists()? {
                            fs::remove_file(&path)?;
                        }
                    }
                }
            }
            return Err(error).context("切换官方账号失败");
        }
        result
    }
}

fn read_auth(home: &Path) -> Result<Option<Value>> {
    let path = home.join("auth.json");
    if !path.try_exists()? {
        return Ok(None);
    }
    let bytes = crate::fs_util::read_bounded(&path, MAX_DOCUMENT_BYTES)?;
    serde_json::from_slice(&bytes)
        .context("官方登录 JSON 格式无效")
        .map(Some)
}

pub(crate) fn current_id(home: &Path) -> Result<Option<String>> {
    Ok(read_auth(home)?.and_then(|mut auth| {
        oauth::complete_identity(&mut auth);
        Account::from_auth(auth).ok().map(|account| account.id)
    }))
}

pub(crate) fn switch_disabled_reason(home: &Path) -> Result<Option<String>> {
    let loaded =
        codey_runtime_core::config_manager::ConfigManager::new(home.join("config.toml")).load()?;
    let mode = loaded.document().get("cli_auth_credentials_store");
    Ok(match mode.and_then(toml_edit::Item::as_str) {
        None if mode.is_none() => None,
        Some("file") => None,
        _ => Some("Codex 凭据存储不是 file 模式，不能导入当前登录或切换官方账号".into()),
    })
}

fn ensure_file_store(home: &Path) -> Result<()> {
    if let Some(reason) = switch_disabled_reason(home)? {
        bail!("{reason}");
    }
    Ok(())
}
