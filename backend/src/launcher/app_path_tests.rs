use super::*;
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
#[tokio::test]
#[ignore = "需要 CODEY_TEST_PREVIOUS_APP_DIR 和 CODEY_TEST_CURRENT_APP_DIR 指向已更新的本机 Store 安装"]
async fn configured_codex_app_dir_recovers_installed_store_update() {
    let previous = std::env::var("CODEY_TEST_PREVIOUS_APP_DIR").unwrap();
    let current = std::env::var("CODEY_TEST_CURRENT_APP_DIR").unwrap();
    assert!(!Path::new(&previous).exists());
    assert!(Path::new(&current).is_dir());
    let resolved = find_configured_codex_app_dir(&previous).await.unwrap();
    assert_eq!(resolved, Some(PathBuf::from(current)));
}

#[tokio::test]
async fn configured_codex_app_dir_preserves_selected_directory() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("Codex.exe"), []).unwrap();
    let resources = directory.path().join("resources/app");
    std::fs::create_dir_all(&resources).unwrap();
    std::fs::write(
        resources.join("package.json"),
        r#"{"name":"codex","productName":"Codex","version":"1.0.0"}"#,
    )
    .unwrap();
    let resolved = find_configured_codex_app_dir(&directory.path().to_string_lossy())
        .await
        .unwrap();
    assert_eq!(resolved.as_deref(), Some(directory.path()));
}

#[tokio::test]
async fn configured_codex_app_dir_reports_missing_directory() {
    let directory = tempfile::tempdir().unwrap();
    let resolved =
        find_configured_codex_app_dir(&directory.path().join("missing").to_string_lossy())
            .await
            .unwrap();
    assert_eq!(resolved, None);
}
