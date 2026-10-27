use crate::{fsutil, transaction::Change};
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

// 备份位于 Codey 数据目录，路径映射随备份保存，不写入审计日志。
pub(crate) fn snapshot(data: &Path, changes: &[Change], skill_roots: &[PathBuf]) -> Result<PathBuf> {
    let backups = data.join("backups");
    private_directory(&backups)?;
    let directory = backups.join(uuid::Uuid::new_v4().to_string());
    private_directory(&directory)?;
    let mut targets = BTreeSet::new();
    for change in changes {
        if change.before.is_none() {
            continue;
        }
        let skill = skill_roots.iter().filter(|root| change.path.starts_with(root))
            .max_by_key(|root| root.components().count())
            .and_then(|root| change.path.ancestors().skip(1)
                .take_while(|path| *path != root && path.starts_with(root))
                .find(|path| path.join("SKILL.md").is_file()));
        targets.insert(skill.unwrap_or(&change.path).to_path_buf());
    }
    let mut manifest = Vec::new();
    for (index, source) in targets.iter().enumerate() {
        let target = directory.join(index.to_string());
        if source.is_dir() {
            private_directory(&target)?;
            copy_directory(source, &target, 0, &mut (0, 0))?;
        } else {
            copy_file(source, &target)?;
        }
        for change in changes.iter().filter(|change| change.before.is_some()) {
            let copied = if change.path == *source {
                target.clone()
            } else if let Ok(relative) = change.path.strip_prefix(source) {
                target.join(relative)
            } else {
                continue;
            };
            ensure!(
                fsutil::read(&copied)? == change.before,
                "备份内容与原版本不一致，操作未提交"
            );
        }
        manifest.push(serde_json::json!({"source":source,"backup":target}));
    }
    fsutil::apply(
        &directory.join("manifest.json"),
        &Some(serde_json::to_vec(&manifest)?),
        Some(0o600),
    )?;
    Ok(directory)
}


fn copy_file(source: &Path, target: &Path) -> Result<u64> {
    let bytes = fsutil::read(source)?.context("备份源文件已消失")?;
    private_directory(target.parent().context("备份路径没有父目录")?)?;
    fsutil::apply(target, &Some(bytes.clone()), Some(0o600))?;
    ensure!(
        fsutil::read(target)?.as_deref() == Some(bytes.as_slice()),
        "备份读回不一致，未写入源文件"
    );
    Ok(bytes.len() as u64)
}

fn copy_directory(
    source: &Path,
    target: &Path,
    depth: usize,
    budget: &mut (usize, u64),
) -> Result<()> {
    ensure!(depth <= 20, "备份目录层级超过限制");
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        budget.0 += 1;
        ensure!(budget.0 <= fsutil::MAX_FILES, "备份目录条目超过限制");
        let child = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            // 只复制链接本身，不读取链接目标；卸载仍只删除登记的普通文件。
            let link = fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link, &child)?;
            #[cfg(windows)]
            if entry.path().is_dir() {
                std::os::windows::fs::symlink_dir(&link, &child)?;
            } else {
                std::os::windows::fs::symlink_file(&link, &child)?;
            }
            ensure!(fs::read_link(&child)? == link, "备份链接读回不一致");
        } else if kind.is_dir() {
            fsutil::safe_path(&entry.path())?;
            private_directory(&child)?;
            copy_directory(&entry.path(), &child, depth + 1, budget)?;
        } else {
            ensure!(kind.is_file(), "备份目录包含特殊文件");
            budget.1 += copy_file(&entry.path(), &child)?;
            ensure!(budget.1 <= fsutil::MAX_TOTAL, "备份内容超过总大小限制");
        }
    }
    Ok(())
}

fn private_directory(path: &Path) -> Result<()> {
    fsutil::private_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", r#"
$ErrorActionPreference = 'Stop'
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($sid)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:CODEY_EXTENSIONS_BACKUP_DIR -AclObject $acl
"#]).env("CODEY_EXTENSIONS_BACKUP_DIR", path).output()
            .context("无法设置备份目录权限")?;
        ensure!(
            output.status.success(),
            "无法将备份限制为当前用户访问，未写入源文件"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_rejects_a_changed_source_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("config.toml");
        fs::write(&source, b"original").unwrap();
        let change = Change::new(source.clone(), Some(b"replacement".to_vec())).unwrap();
        fs::write(&source, b"external").unwrap();
        let error = snapshot(&root.join("data"), &[change], &[]).unwrap_err();
        assert!(error.to_string().contains("原版本不一致"));
        assert_eq!(fs::read(source).unwrap(), b"external");
    }
}
