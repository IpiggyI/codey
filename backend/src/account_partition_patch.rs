//! Codex 按 ChatGPT 账号分区保存界面状态（项目列表、置顶会话、新手引导记录等），
//! 分区写在全局状态的 `electron-account-renderer-state-v1` 中。Codex 每次启动先把
//! 当前账号的状态收进分区，识别出账号后再放回；渠道不走 OpenAI 鉴权时识别不出账号，
//! 项目列表变空并重新出现新手引导。分区只由 Codex 的账号切换流程创建，启动前去掉
//! 它，Codex 就按共享状态运行，切换渠道和账号都使用同一份界面状态。
//!
//! shortcut: 启动前把分区并回共享状态并删除分区键; ceiling: 依赖 Codex 主进程在缺少分区键时不分区，
//! 当前账号为空且有多个账号分区时无法判断归属，保持原样; replace when: Codex 更换分区键名或在启动时主动创建分区键，
//! 使启动前删除后侧栏仍出现空项目列表。

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::value::{RawValue, to_raw_value};

use crate::pet_slim_patch::{GLOBAL_STATE_FILE, read_state};

const PARTITION_KEY: &str = "electron-account-renderer-state-v1";
const ATOM_STATE_KEY: &str = "electron-persisted-atom-state";
pub(crate) const DROPPED_PARTITIONS_FILE: &str = "codex-account-partitions-backup.json";

#[derive(Debug, Deserialize)]
struct AccountPartitions {
    owner: Option<String>,
    inactive: BTreeMap<String, Partition>,
}

#[derive(Debug, Deserialize)]
struct Partition {
    atoms: BTreeMap<String, Box<RawValue>>,
    globals: BTreeMap<String, Box<RawValue>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartitionMerge {
    /// 全局状态里没有分区键，不写文件。
    Absent,
    /// 已删除分区键；`restored_*` 为放回共享状态的项数，`backed_up_partitions` 为备份后丢弃的分区数。
    Merged {
        restored_globals: usize,
        restored_atoms: usize,
        backed_up_partitions: usize,
    },
    /// 当前账号为空且有多个账号分区，无法判断归属，不写文件。
    Ambiguous { partitions: usize },
}

enum Plan {
    Restore {
        partition: Option<Partition>,
        dropped: usize,
    },
    Ambiguous(usize),
}

pub fn merge(codex_home: &Path, backup_dir: &Path) -> Result<PartitionMerge> {
    let state_path = codex_home.join(GLOBAL_STATE_FILE);
    let backup_path = codex_home.join(format!("{GLOBAL_STATE_FILE}.bak"));
    let mut state = read_state(&state_path, &backup_path)?;
    let Some(raw) = state.remove(PARTITION_KEY) else {
        return Ok(PartitionMerge::Absent);
    };
    let partitions: AccountPartitions = serde_json::from_str(raw.get())
        .with_context(|| format!("解析 Codex 账号分区失败：{}", state_path.display()))?;
    let (partition, dropped) = match plan(partitions) {
        Plan::Ambiguous(partitions) => return Ok(PartitionMerge::Ambiguous { partitions }),
        Plan::Restore { partition, dropped } => (partition, dropped),
    };
    if dropped > 0 {
        let destination = backup_dir.join(DROPPED_PARTITIONS_FILE);
        crate::fs_util::atomic_write_private(&destination, raw.get().as_bytes())
            .with_context(|| format!("备份 Codex 账号分区失败：{}", destination.display()))?;
    }
    let outcome = PartitionMerge::Merged {
        restored_globals: partition.as_ref().map_or(0, |part| part.globals.len()),
        restored_atoms: partition.as_ref().map_or(0, |part| part.atoms.len()),
        backed_up_partitions: dropped,
    };
    if let Some(partition) = partition {
        restore_partition(&mut state, partition)?;
    }
    write_state(&state, &state_path, &backup_path)?;
    Ok(outcome)
}

/// 当前账号不为空时，共享状态已经属于该账号，其余分区都不放回。
fn plan(partitions: AccountPartitions) -> Plan {
    let AccountPartitions {
        owner,
        mut inactive,
    } = partitions;
    if let Some(owner) = owner {
        inactive.remove(&owner);
        return Plan::Restore {
            partition: None,
            dropped: inactive.len(),
        };
    }
    match inactive.len() {
        0 | 1 => Plan::Restore {
            partition: inactive.into_values().next(),
            dropped: 0,
        },
        count => Plan::Ambiguous(count),
    }
}

/// 分区里的界面状态覆盖共享状态中的同名项；Codex 收进分区时已排除与账号无关的项。
fn restore_partition(
    state: &mut BTreeMap<String, Box<RawValue>>,
    partition: Partition,
) -> Result<()> {
    let mut atoms: BTreeMap<String, Box<RawValue>> = match state.get(ATOM_STATE_KEY) {
        Some(raw) => serde_json::from_str(raw.get()).context("解析 Codex 界面状态失败")?,
        None => BTreeMap::new(),
    };
    atoms.extend(partition.atoms);
    state.insert(ATOM_STATE_KEY.to_string(), to_raw_value(&atoms)?);
    state.extend(partition.globals);
    Ok(())
}

fn write_state(
    state: &BTreeMap<String, Box<RawValue>>,
    state_path: &Path,
    backup_path: &Path,
) -> Result<()> {
    let bytes = serde_json::to_vec(state)?;
    crate::fs_util::atomic_write_private(state_path, &bytes)
        .with_context(|| format!("更新 Codex 全局状态失败：{}", state_path.display()))?;
    crate::fs_util::atomic_write_private(backup_path, &bytes)
        .with_context(|| format!("更新 Codex 备份全局状态失败：{}", backup_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn write_global_state(home: &Path, state: &str) -> std::path::PathBuf {
        let path = home.join(GLOBAL_STATE_FILE);
        std::fs::write(&path, state).unwrap();
        path
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn restores_the_only_partition_when_codex_parked_it_without_an_account() {
        let home = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let path = write_global_state(
            home.path(),
            r#"{"keep":1,"electron-persisted-atom-state":{"agnostic":true,"last_completed_onboarding":5},
            "electron-account-renderer-state-v1":{"owner":null,"inactive":{"hash-a":{
              "atoms":{"last_completed_onboarding":1,"pinned":["x"]},
              "globals":{"local-projects":{"p1":{"name":"codey"}},"note":"\ud800"}}}}}"#,
        );

        let outcome = merge(home.path(), backups.path()).unwrap();

        assert_eq!(
            outcome,
            PartitionMerge::Merged {
                restored_globals: 2,
                restored_atoms: 2,
                backed_up_partitions: 0,
            }
        );
        // `Value` rejects lone surrogates, so check the raw escape before parsing the rest.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains(r#""note":"\ud800""#));
        let state: Value = serde_json::from_str(&raw.replace(r"\ud800", "surrogate")).unwrap();
        assert!(state.get(PARTITION_KEY).is_none());
        assert_eq!(state["keep"], 1);
        assert_eq!(state["local-projects"]["p1"]["name"], "codey");
        assert_eq!(
            state[ATOM_STATE_KEY],
            json!({"agnostic":true,"last_completed_onboarding":1,"pinned":["x"]})
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            std::fs::read(home.path().join(format!("{GLOBAL_STATE_FILE}.bak"))).unwrap()
        );
        assert!(!backups.path().join(DROPPED_PARTITIONS_FILE).exists());
    }

    #[test]
    fn drops_the_key_but_keeps_the_owner_state_and_backs_up_other_accounts() {
        let home = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let partitions = r#"{"owner":"hash-a","inactive":{"hash-b":{"atoms":{"b":1},"globals":{"local-projects":{}}}}}"#;
        let path = write_global_state(
            home.path(),
            &format!(
                r#"{{"local-projects":{{"p1":{{}}}},"electron-persisted-atom-state":{{"a":1}},"{PARTITION_KEY}":{partitions}}}"#
            ),
        );

        let outcome = merge(home.path(), backups.path()).unwrap();

        assert_eq!(
            outcome,
            PartitionMerge::Merged {
                restored_globals: 0,
                restored_atoms: 0,
                backed_up_partitions: 1,
            }
        );
        assert_eq!(
            read_json(&path),
            json!({"local-projects":{"p1":{}},"electron-persisted-atom-state":{"a":1}})
        );
        assert_eq!(
            std::fs::read_to_string(backups.path().join(DROPPED_PARTITIONS_FILE)).unwrap(),
            partitions
        );
    }

    #[test]
    fn leaves_state_untouched_without_a_partition_or_with_ambiguous_partitions() {
        let ambiguous = format!(
            r#"{{"{PARTITION_KEY}":{{"owner":null,"inactive":{{"a":{{"atoms":{{}},"globals":{{}}}},"b":{{"atoms":{{}},"globals":{{}}}}}}}}}}"#
        );
        for (original, expected) in [
            (r#"{"keep":1}"#.to_string(), PartitionMerge::Absent),
            (ambiguous, PartitionMerge::Ambiguous { partitions: 2 }),
        ] {
            let home = tempfile::tempdir().unwrap();
            let backups = tempfile::tempdir().unwrap();
            let path = write_global_state(home.path(), &original);

            assert_eq!(merge(home.path(), backups.path()).unwrap(), expected);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
            assert!(
                !home
                    .path()
                    .join(format!("{GLOBAL_STATE_FILE}.bak"))
                    .exists()
            );
        }
    }

    #[test]
    fn reads_the_backup_when_the_primary_state_is_corrupt() {
        let home = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let path = write_global_state(home.path(), "{broken");
        std::fs::write(
            home.path().join(format!("{GLOBAL_STATE_FILE}.bak")),
            format!(
                r#"{{"{PARTITION_KEY}":{{"owner":null,"inactive":{{"a":{{"atoms":{{}},"globals":{{"local-projects":{{"p":1}}}}}}}}}}}}"#
            ),
        )
        .unwrap();

        merge(home.path(), backups.path()).unwrap();

        assert_eq!(
            read_json(&path),
            json!({"local-projects":{"p":1},"electron-persisted-atom-state":{}})
        );
    }
}
