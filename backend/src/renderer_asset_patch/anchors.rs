use anyhow::{Context, Result, bail};

/// 页面补丁里前置字面量表的起止标记，后端据此预筛资源。
pub(super) const PATCH_ANCHORS_START: &str = "/*codey-renderer-patch-anchors*/";
pub(super) const PATCH_ANCHORS_END: &str = "/*end-codey-renderer-patch-anchors*/";
/// 仅在开启宠物精简时才生效的前置字面量；精简关闭时不加入扫描与预筛。
pub(super) const PET_ONLY_PATCH_ANCHORS: [&str; 5] = [
    "codex-avatar",
    "codex-pet-assets",
    "avatar-mascot-button",
    "use-avatar-options",
    "shouldPrewarmAvatarOverlay:",
];

/// 读取页面补丁登记的前置字面量表。表随二进制内置，由单元测试保证可解析。
pub(super) fn renderer_patch_anchors(script: &str) -> Result<Vec<String>> {
    let start = script
        .find(PATCH_ANCHORS_START)
        .context("缺少前置字面量表起始标记")?
        + PATCH_ANCHORS_START.len();
    let end = start
        + script[start..]
            .find(PATCH_ANCHORS_END)
            .context("缺少前置字面量表结束标记")?;
    let anchors: Vec<String> =
        serde_json::from_str(&script[start..end]).context("前置字面量表不是 JSON 字符串数组")?;
    if anchors.is_empty() || anchors.iter().any(String::is_empty) {
        bail!("前置字面量表不能为空，也不能含空字符串");
    }
    Ok(anchors)
}

pub(super) fn renderer_patch_anchors_for_mode(
    script: &str,
    disable_pet: bool,
) -> Result<Vec<String>> {
    let mut anchors = renderer_patch_anchors(script)?;
    if !disable_pet {
        anchors.retain(|anchor| !PET_ONLY_PATCH_ANCHORS.contains(&anchor.as_str()));
    }
    Ok(anchors)
}
