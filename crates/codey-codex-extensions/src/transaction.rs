#![allow(clippy::items_after_test_module)]

use crate::fsutil;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Change {
    pub path: PathBuf,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub before_mode: Option<u32>,
    pub after_mode: Option<u32>,
}

impl Change {
    pub fn new(path: PathBuf, after: Option<Vec<u8>>) -> Result<Self> {
        ensure!(
            after
                .as_ref()
                .is_none_or(|b| b.len() as u64 <= fsutil::MAX_FILE),
            "文件超过大小限制，未执行写入"
        );
        let before_mode = fsutil::file_mode(&path)?;
        Ok(Self {
            before: fsutil::read(&path)?,
            before_mode,
            after_mode: after.as_ref().and(before_mode.map(|m| 0o600 | (m & 0o100))),
            path,
            after,
        })
    }

    pub fn matches_before(&self) -> Result<bool> {
        self.matches(&self.before, self.before_mode)
    }

    pub fn matches_after(&self) -> Result<bool> {
        self.matches(&self.after, self.after_mode)
    }

    fn matches(&self, bytes: &Option<Vec<u8>>, mode: Option<u32>) -> Result<bool> {
        Ok(fsutil::read(&self.path)? == *bytes
            && (bytes.is_none() || mode.is_none() || fsutil::file_mode(&self.path)? == mode))
    }
}

pub struct Locks {
    _files: Vec<fs::File>,
}
pub fn lock(paths: &[PathBuf]) -> Result<Locks> {
    let mut paths = paths.to_vec();
    paths.sort();
    paths.dedup();
    let mut files = Vec::new();
    for path in paths {
        fsutil::safe_path(&path)?;
        fsutil::private_dir(path.parent().context("锁文件缺少父目录")?)?;
        let mut options = fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        file.lock_exclusive()?;
        files.push(file);
    }
    Ok(Locks { _files: files })
}

fn audit(data: &Path, id: &str, operation: &str, target_count: usize, state: &str) -> Result<()> {
    let path = data.join("audit.jsonl");
    fsutil::safe_path(&path)?;
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    let record = serde_json::json!({"id":id,"operation":operation,"state":state,"at":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"targetCount":target_count});
    serde_json::to_writer(&mut f, &record)?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backup_bytes(root: &Path, source: &Path) -> Vec<u8> {
        for entry in fs::read_dir(root.join("backups")).unwrap() {
            let directory = entry.unwrap().path();
            let manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap())
                    .unwrap();
            for item in manifest.as_array().unwrap() {
                if item["source"] == source.to_str().unwrap() {
                    return fs::read(item["backup"].as_str().unwrap()).unwrap();
                }
            }
        }
        panic!("未找到原文件备份");
    }

    #[test]
    fn backup_precedes_write_and_delete_and_matches_original() {
        for after in [Some(b"changed".to_vec()), None] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let path = root.join("config.toml");
            fs::write(&path, b"original").unwrap();
            let change = Change::new(path.clone(), after).unwrap();
            let backup = commit_with_apply(&root, "test", vec![change], &[root.join("skills")], |target, bytes, mode| {
                assert_eq!(backup_bytes(&root, &path), b"original");
                assert_eq!(fs::read(&path).unwrap(), b"original");
                fsutil::apply(target, bytes, mode)
            })
            .unwrap();
            assert!(backup.starts_with(root.join("backups")));
            #[cfg(unix)]
            {
                assert_eq!(fsutil::file_mode(&backup).unwrap(), Some(0o700));
                assert_eq!(fsutil::file_mode(&backup.join("0")).unwrap(), Some(0o600));
            }
        }
    }

    #[test]
    fn backup_failure_aborts_before_apply() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("config.toml");
        fs::write(&path, b"original").unwrap();
        fs::write(root.join("backups"), b"blocked").unwrap();
        let change = Change::new(path.clone(), Some(b"changed".to_vec())).unwrap();
        let error = commit_with_apply(&root, "test", vec![change], &[root.join("skills")], |_, _, _| {
            panic!("备份失败时不得写入");
        })
        .unwrap_err();
        assert!(error.to_string().contains("备份失败"));
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[test]
    fn failed_readback_reports_backup_and_preserves_external_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("config.toml");
        fs::write(&path, b"original").unwrap();
        let change = Change::new(path.clone(), Some(b"changed".to_vec())).unwrap();
        let error = commit_with_apply(&root, "test", vec![change], &[root.join("skills")], |target, _, _| {
            fs::write(target, b"external")?;
            Ok(())
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("提交后文件校验失败"));
        let backup = fs::read_dir(root.join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(error.to_string().contains(backup.to_str().unwrap()));
        assert_eq!(backup_bytes(&root, &path), b"original");
        assert_eq!(fs::read(path).unwrap(), b"external");
    }

    #[test]
    fn whole_skill_is_backed_up_before_manifest_edit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let skill = root.join("skills/demo");
        fs::create_dir_all(skill.join("resources/empty")).unwrap();
        let path = skill.join("SKILL.md");
        fs::write(&path, b"original").unwrap();
        fs::write(skill.join("resources/example"), b"resource").unwrap();
        let change = Change::new(path, Some(b"changed".to_vec())).unwrap();
        commit_with_apply(&root, "test", vec![change], &[root.join("skills")], |target, bytes, mode| {
            let backup = fs::read_dir(root.join("backups"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path()
                .join("0");
            assert_eq!(fs::read(backup.join("SKILL.md")).unwrap(), b"original");
            assert_eq!(
                fs::read(backup.join("resources/example")).unwrap(),
                b"resource"
            );
            assert!(backup.join("resources/empty").is_dir());
            fsutil::apply(target, bytes, mode)
        })
        .unwrap();
    }

    #[test]
    fn failure_compensates_in_reverse_order_and_preserves_modes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let paths: Vec<_> = (0..3).map(|n| root.join(format!("file-{n}"))).collect();
        for path in &paths {
            fs::write(path, b"original").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o640)).unwrap();
            }
        }
        let changes = paths
            .iter()
            .map(|path| Change::new(path.clone(), Some(b"changed".to_vec())).unwrap())
            .collect();
        let mut calls = Vec::new();
        let error = commit_with_apply(&root, "test", changes, &[], |path, bytes, mode| {
            calls.push(path.to_path_buf());
            if calls.len() == 3 {
                anyhow::bail!("injected write failure");
            }
            fsutil::apply(path, bytes, mode)
        })
        .unwrap_err();
        assert!(error.to_string().contains("已恢复"));
        assert_eq!(
            calls,
            vec![
                paths[0].clone(),
                paths[1].clone(),
                paths[2].clone(),
                paths[1].clone(),
                paths[0].clone()
            ]
        );
        for path in &paths {
            assert_eq!(fs::read(path).unwrap(), b"original");
            #[cfg(unix)]
            assert_eq!(fsutil::file_mode(path).unwrap(), Some(0o640));
        }
        assert!(!root.join("snapshots").exists());
        let audit = fs::read_to_string(root.join("audit.jsonl")).unwrap();
        assert!(audit.contains("compensated"));
        assert!(!audit.contains("original") && !audit.contains("changed"));
    }

    #[test]
    fn compensation_refuses_to_overwrite_external_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let first = root.join("first");
        let second = root.join("second");
        fs::write(&first, b"original").unwrap();
        let changes = vec![
            Change::new(first.clone(), Some(b"changed".to_vec())).unwrap(),
            Change::new(second.clone(), Some(b"created".to_vec())).unwrap(),
        ];
        let error = commit_with_apply(&root, "test", changes, &[], |path, bytes, mode| {
            if path == second {
                fs::write(&first, b"external").unwrap();
                anyhow::bail!("injected write failure");
            }
            fsutil::apply(path, bytes, mode)
        })
        .unwrap_err();
        assert!(error.to_string().contains("部分文件无法恢复"));
        assert_eq!(fs::read(first).unwrap(), b"external");
        assert!(!second.exists());
        assert!(
            fs::read_to_string(root.join("audit.jsonl"))
                .unwrap()
                .contains("recovery-required")
        );
    }

    #[test]
    fn changed_inputs_are_rejected_before_any_write() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("config");
        fs::write(&path, b"original").unwrap();
        let changes = vec![Change::new(path.clone(), Some(b"changed".to_vec())).unwrap()];
        fs::write(&path, b"external").unwrap();
        assert!(commit(&root, "test", changes, &[]).is_err());
        assert_eq!(fs::read(path).unwrap(), b"external");
        assert!(!root.join("audit.jsonl").exists());
    }

    #[test]
    fn failed_batch_restores_deleted_files_and_removes_created_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let deleted = root.join("deleted");
        let created = root.join("created");
        let failing = root.join("failing");
        fs::write(&deleted, b"original").unwrap();
        let changes = vec![
            Change::new(deleted.clone(), None).unwrap(),
            Change::new(created.clone(), Some(b"new".to_vec())).unwrap(),
            Change::new(failing.clone(), Some(b"new".to_vec())).unwrap(),
        ];
        let error = commit_with_apply(&root, "test", changes, &[], |path, bytes, mode| {
            if path == failing {
                anyhow::bail!("injected write failure");
            }
            fsutil::apply(path, bytes, mode)
        })
        .unwrap_err();
        assert!(error.to_string().contains("已恢复"));
        assert_eq!(fs::read(deleted).unwrap(), b"original");
        assert!(!created.exists() && !failing.exists());
    }

    #[test]
    fn failed_compensation_reports_incomplete_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let first = root.join("first");
        let second = root.join("second");
        fs::write(&first, b"original").unwrap();
        let changes = vec![
            Change::new(first.clone(), Some(b"changed".to_vec())).unwrap(),
            Change::new(second.clone(), Some(b"new".to_vec())).unwrap(),
        ];
        let mut calls = 0;
        let error = commit_with_apply(&root, "test", changes, &[], |path, bytes, mode| {
            calls += 1;
            if calls > 1 {
                anyhow::bail!("injected unavailable filesystem");
            }
            fsutil::apply(path, bytes, mode)
        })
        .unwrap_err();
        assert!(error.to_string().contains("部分文件无法恢复"));
        assert_eq!(fs::read(first).unwrap(), b"changed");
        assert!(!second.exists());
    }
}

pub fn commit(data: &Path, operation: &str, changes: Vec<Change>, skill_roots: &[PathBuf]) -> Result<PathBuf> {
    commit_with_apply(data, operation, changes, skill_roots, fsutil::apply)
}

// 持久备份供手动恢复；逐文件原子替换不保证进程中断时整批恢复。
fn commit_with_apply(
    data: &Path,
    operation: &str,
    changes: Vec<Change>,
    skill_roots: &[PathBuf],
    mut apply: impl FnMut(&Path, &Option<Vec<u8>>, Option<u32>) -> Result<()>,
) -> Result<PathBuf> {
    ensure!(!changes.is_empty(), "没有可提交的修改");
    for change in &changes {
        ensure!(
            [&change.before, &change.after].iter().all(|b| b
                .as_ref()
                .is_none_or(|b| b.len() as u64 <= fsutil::MAX_FILE)),
            "文件超过大小限制，未执行写入"
        );
    }
    let total: usize = changes
        .iter()
        .map(|c| c.before.as_ref().map_or(0, Vec::len) + c.after.as_ref().map_or(0, Vec::len))
        .sum();
    ensure!(
        total as u64 <= fsutil::MAX_TOTAL * 2,
        "操作内容超过总大小限制"
    );
    for c in &changes {
        ensure!(c.matches_before()?, "文件已被其他程序修改，操作未提交");
    }
    let backup = crate::backup::snapshot(data, &changes, skill_roots).context("备份失败，操作未提交")?;
    let id = uuid::Uuid::new_v4().to_string();
    audit(data, &id, operation, changes.len(), "prepared")?;
    let mut applied = 0;
    let result = (|| -> Result<()> {
        for c in &changes {
            ensure!(c.matches_before()?, "提交期间文件被其他程序修改");
            applied += 1;
            apply(&c.path, &c.after, c.after_mode)?;
        }
        for c in &changes {
            ensure!(c.matches_after()?, "提交后文件校验失败");
        }
        audit(data, &id, operation, changes.len(), "committed")?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut recovered = true;
        for c in changes[..applied].iter().rev() {
            if c.matches_after().unwrap_or(false) {
                let rollback = Change::new(c.path.clone(), c.before.clone())
                    .and_then(|change| crate::backup::snapshot(data, &[change], skill_roots));
                if rollback.is_err()
                    || !c.matches_after().unwrap_or(false)
                    || apply(&c.path, &c.before, c.before_mode).is_err()
                    || !c.matches_before().unwrap_or(false)
                {
                    recovered = false;
                }
            } else if !c.matches_before().unwrap_or(false) {
                recovered = false;
            }
        }
        let state = if recovered {
            "compensated"
        } else {
            "recovery-required"
        };
        let _ = audit(data, &id, operation, changes.len(), state);
        return Err(error.context(format!(
            "{}；原内容备份：{}",
            if recovered {
                "操作失败，本次已写入的文件已恢复"
            } else {
                "操作失败，部分文件无法恢复；为避免覆盖外部修改已停止补偿，请检查当前配置"
            },
            backup.display()
        )));
    }
    Ok(backup)
}
