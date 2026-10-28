use std::fs;
use std::path::Path;

use anyhow::{Context, Result, ensure};

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("账号库路径没有父目录")?;
    private_directory(parent)?;
    crate::fs_util::atomic_write_private(path, bytes).context("保存官方账号私密文档失败")
}

fn private_directory(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "账号库目录不是可信目录"
        );
    } else if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    restrict_windows_directory(path)?;
    Ok(())
}

#[cfg(windows)]
fn restrict_windows_directory(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    // 新文件继承受保护目录的当前用户 ACL；凭据写入前完成权限设置。
    let script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:CODEY_ACCOUNT_PRIVATE_DIRECTORY -AclObject $acl";
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CODEY_ACCOUNT_PRIVATE_DIRECTORY", path)
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context("无法设置官方账号库的当前用户 ACL")?;
    ensure!(
        status.success(),
        "设置官方账号库的当前用户 ACL 失败，未写入凭据"
    );
    Ok(())
}
