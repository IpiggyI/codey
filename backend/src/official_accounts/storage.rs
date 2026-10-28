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
    // 凭据写入前完成权限设置。
    let restricted = crate::fs_util::restrict_directory_to_current_user(path)
        .context("无法设置官方账号库的当前用户 ACL")?;
    ensure!(restricted, "设置官方账号库的当前用户 ACL 失败，未写入凭据");
    Ok(())
}
