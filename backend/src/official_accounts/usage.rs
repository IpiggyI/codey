use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use super::{Account, OfficialAccountStore};
use crate::account_usage::{AccountUsageSnapshot, OfficialAuth};

#[derive(Default)]
pub(crate) struct UsageState {
    sequence: u64,
    entries: HashMap<String, Entry>,
}

struct Entry {
    credential_generation: String,
    generation: u64,
    snapshot: Option<AccountUsageSnapshot>,
    expires: Instant,
}

pub(crate) struct Request {
    pub id: String,
    credential_generation: String,
    generation: u64,
    pub auth: OfficialAuth,
}

impl UsageState {
    pub fn cached(&self, account: &Account) -> Option<Value> {
        let entry = self.entries.get(&account.id)?;
        (entry.credential_generation == account.generation && entry.expires > Instant::now())
            .then(|| {
                entry
                    .snapshot
                    .as_ref()
                    .map(|s| payload(s, entry.generation))
            })
            .flatten()
    }

    pub fn begin(&mut self, account: &Account) -> Result<Request> {
        let auth = crate::account_usage::official_auth_from_value(&account.auth)?;
        self.sequence = self
            .sequence
            .checked_add(1)
            .context("账号额度请求代次已耗尽")?;
        self.entries.insert(
            account.id.clone(),
            Entry {
                credential_generation: account.generation.clone(),
                generation: self.sequence,
                snapshot: None,
                expires: Instant::now(),
            },
        );
        Ok(Request {
            id: account.id.clone(),
            credential_generation: account.generation.clone(),
            generation: self.sequence,
            auth,
        })
    }

    pub fn complete(
        &mut self,
        store: &OfficialAccountStore,
        request: &Request,
        snapshot: AccountUsageSnapshot,
    ) -> Result<Value> {
        let account = store
            .get(&request.id)?
            .context("官方账号已删除，忽略旧的额度结果")?;
        ensure!(
            account.generation == request.credential_generation,
            "官方账号凭据已变化，忽略旧的额度结果"
        );
        ensure!(
            self.entries
                .get(&request.id)
                .is_some_and(|entry| entry.generation == request.generation),
            "已有较新的账号额度请求，忽略旧结果"
        );
        store.update_plan(&account, snapshot.plan_type.as_deref())?;
        self.store_displayed(&account, request.generation, snapshot)
    }

    pub fn store_displayed(
        &mut self,
        account: &Account,
        generation: u64,
        snapshot: AccountUsageSnapshot,
    ) -> Result<Value> {
        let entry = self
            .entries
            .get_mut(&account.id)
            .context("账号额度请求已失效")?;
        ensure!(
            entry.credential_generation == account.generation && entry.generation == generation,
            "官方账号状态已变化，忽略旧的额度结果"
        );
        if let Some(old) = &entry.snapshot {
            ensure!(
                snapshot.fetched_at >= old.fetched_at,
                "账号额度结果早于当前数据"
            );
        }
        let value = payload(&snapshot, generation);
        entry.snapshot = Some(snapshot);
        entry.expires = Instant::now() + Duration::from_secs(30);
        Ok(value)
    }
}

fn payload(snapshot: &AccountUsageSnapshot, generation: u64) -> Value {
    let mut value = serde_json::to_value(snapshot).expect("账号额度可序列化");
    value["status"] = json!("ok");
    value["authGeneration"] = json!(generation);
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(at: u64) -> AccountUsageSnapshot {
        AccountUsageSnapshot {
            plan_type: Some("plus".into()),
            primary: None,
            secondary: None,
            credits: None,
            additional_limits: vec![],
            account_label: None,
            fetched_at: at,
        }
    }

    #[test]
    fn official_accounts_old_async_quota_cannot_overwrite_newer_request_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = OfficialAccountStore::new(dir.path());
        let account = store
            .upsert(
                Account::from_auth(json!({"auth_mode":"chatgpt",
            "tokens":{"account_id":"one","access_token":"first"}}))
                .unwrap(),
            )
            .unwrap();
        let mut state = UsageState::default();
        let old = state.begin(&account).unwrap();
        let new = state.begin(&account).unwrap();
        state.complete(&store, &new, snapshot(2)).unwrap();
        assert!(state.complete(&store, &old, snapshot(1)).is_err());
        assert_eq!(state.cached(&account).unwrap()["fetchedAt"], 2);
        let mut changed = account.clone();
        changed.auth["tokens"]["access_token"] = json!("second");
        let changed = store.upsert(changed).unwrap();
        assert!(state.cached(&changed).is_none());
        assert!(state.complete(&store, &new, snapshot(3)).is_err());
        store.remove(&account.id).unwrap();
        let again = store.upsert(account).unwrap();
        assert!(state.complete(&store, &old, snapshot(4)).is_err());
        let request = state.begin(&again).unwrap();
        assert_eq!(request.auth.access_token, "first");
        assert_eq!(request.auth.account_id.as_deref(), Some("one"));
    }
}
