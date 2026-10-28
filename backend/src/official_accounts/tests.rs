use super::*;

pub(super) fn auth(id: &str, token: &str) -> Value {
    json!({"auth_mode":"chatgpt", "tokens":{"account_id":id,"access_token":token,
        "refresh_token":format!("refresh-{token}"),"id_token":format!("id-{token}")},
        "extra":{"retained":true}})
}

fn fixture() -> (
    tempfile::TempDir,
    OfficialAccountStore,
    PathBuf,
    Account,
    Account,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("codex");
    fs::create_dir(&home).unwrap();
    let store = OfficialAccountStore::new(&dir.path().join("codey"));
    let first = store
        .upsert(Account::from_auth(auth("a", "old-a")).unwrap())
        .unwrap();
    let second = store
        .upsert(Account::from_auth(auth("b", "token-b")).unwrap())
        .unwrap();
    fs::write(
        home.join("auth.json"),
        serde_json::to_vec_pretty(&auth("a", "refreshed-a")).unwrap(),
    )
    .unwrap();
    (dir, store, home, first, second)
}

#[test]
fn official_accounts_switch_preserves_complete_document_and_copies_current_tokens_before_write() {
    let (_dir, store, home, first, second) = fixture();
    let original = fs::read(home.join("auth.json")).unwrap();
    let restart_required = store
        .activate_with(
            &home,
            &second.id,
            || Ok(true),
            |path, bytes| {
                assert_eq!(
                    store.get(&first.id)?.unwrap().auth,
                    auth("a", "refreshed-a")
                );
                let backups = fs::read_dir(store.root.join("backups"))?
                    .collect::<std::io::Result<Vec<_>>>()?;
                assert_eq!(backups.len(), 1);
                assert_eq!(fs::read(backups[0].path())?, original);
                assert_eq!(fs::read(path)?, original);
                crate::fs_util::atomic_write_private(path, bytes)
            },
        )
        .unwrap();
    assert!(restart_required);
    let switched: Value =
        serde_json::from_slice(&fs::read(home.join("auth.json")).unwrap()).unwrap();
    assert_eq!(switched["auth_mode"], "chatgpt");
    assert_eq!(switched["tokens"]["account_id"], "b");
    assert_eq!(switched, second.auth);
}

#[test]
fn official_accounts_refuses_missing_required_fields_without_touching_auth() {
    for field in ["auth_mode", "account_id"] {
        let (_dir, store, home, _, mut target) = fixture();
        let original = fs::read(home.join("auth.json")).unwrap();
        if field == "auth_mode" {
            target.auth.as_object_mut().unwrap().remove(field);
        } else {
            target.auth["tokens"].as_object_mut().unwrap().remove(field);
        }
        fs::write(
            store.path(&target.id).unwrap(),
            serde_json::to_vec(&target).unwrap(),
        )
        .unwrap();
        assert!(store.activate(&home, &target.id, || Ok(())).is_err());
        assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    }
}

#[test]
fn official_accounts_failed_verification_or_finish_restores_exact_backup() {
    let (_dir, store, home, _, target) = fixture();
    let original = fs::read(home.join("auth.json")).unwrap();
    let error = store
        .activate_with(
            &home,
            &target.id,
            || Ok(()),
            |path, _| {
                fs::write(path, b"corrupt")?;
                Ok(())
            },
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("校验失败"));
    assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    assert!(
        store
            .activate(&home, &target.id, || -> Result<()> {
                bail!("配置保存失败")
            })
            .is_err()
    );
    assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
}

#[test]
fn official_accounts_startup_sync_and_import_never_write_codex_auth() {
    let (_dir, store, home, first, _) = fixture();
    let original = fs::read(home.join("auth.json")).unwrap();
    let modified = fs::metadata(home.join("auth.json"))
        .unwrap()
        .modified()
        .unwrap();
    store.sync_from_codex(&home).unwrap();
    assert_eq!(
        store.get(&first.id).unwrap().unwrap().auth,
        auth("a", "refreshed-a")
    );
    assert_eq!(
        store.import_current(&home).unwrap().auth,
        auth("a", "refreshed-a")
    );
    assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    assert_eq!(
        fs::metadata(home.join("auth.json"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}

#[test]
fn official_accounts_frontend_payload_has_no_credentials_or_auth_document() {
    let (_dir, store, home, _, _) = fixture();
    let payload = store.payload(&home).unwrap();
    let text = payload.to_string();
    for forbidden in [
        "access_token",
        "refresh_token",
        "id_token",
        "old-a",
        "token-b",
        "refreshed-a",
        "\"auth\"",
    ] {
        assert!(!text.contains(forbidden), "前端载荷包含凭据字段或值");
    }
    assert_eq!(payload["accounts"].as_array().unwrap().len(), 2);
}

#[test]
fn official_accounts_non_file_store_disables_switch_and_current_import() {
    let (_dir, store, home, _, target) = fixture();
    let original = fs::read(home.join("auth.json")).unwrap();
    for mode in ["keyring", "auto", "unknown"] {
        fs::write(
            home.join("config.toml"),
            format!("cli_auth_credentials_store = \"{mode}\"\n"),
        )
        .unwrap();
        assert!(store.payload(&home).unwrap()["switchDisabledReason"].is_string());
        assert!(store.activate(&home, &target.id, || Ok(())).is_err());
        assert!(store.import_current(&home).is_err());
        store.sync_from_codex(&home).unwrap();
        assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    }
}

#[cfg(unix)]
#[test]
fn official_accounts_documents_and_backups_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, store, home, first, target) = fixture();
    store.activate(&home, &target.id, || Ok(())).unwrap();
    for path in [
        store.path(&first.id).unwrap(),
        fs::read_dir(store.root.join("backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(&store.root).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn official_accounts_current_claim_identity_allows_list_import_and_switch() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let (_dir, store, home, first, target) = fixture();
    let mut current = auth("a", "refreshed-a");
    current["tokens"]["account_id"] = Value::Null;
    let claims = json!({"https://api.openai.com/auth":{"chatgpt_account_id":"a"}});
    current["tokens"]["id_token"] = json!(format!(
        "e30.{}.sig",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    ));
    let original = serde_json::to_vec_pretty(&current).unwrap();
    fs::write(home.join("auth.json"), &original).unwrap();
    store.sync_from_codex(&home).unwrap();
    let copied = store.get(&first.id).unwrap().unwrap();
    assert_eq!(copied.auth["tokens"]["account_id"], "a");
    assert_eq!(copied.auth["tokens"]["access_token"], "refreshed-a");
    assert_eq!(store.payload(&home).unwrap()["defaultAccountId"], first.id);
    assert_eq!(current_id(&home).unwrap(), Some(first.id.clone()));
    let imported = store.import_current(&home).unwrap();
    assert_eq!(imported.auth["tokens"]["account_id"], "a");
    assert_eq!(fs::read(home.join("auth.json")).unwrap(), original);
    store
        .activate_with(
            &home,
            &target.id,
            || Ok(()),
            |path, bytes| {
                let saved = store.get(&first.id)?.unwrap();
                assert_eq!(saved.auth["tokens"]["account_id"], "a");
                assert_eq!(saved.auth["tokens"]["access_token"], "refreshed-a");
                let backup = fs::read_dir(store.root.join("backups"))?
                    .next()
                    .unwrap()?
                    .path();
                assert_eq!(fs::read(backup)?, original);
                crate::fs_util::atomic_write_private(path, bytes)
            },
        )
        .unwrap();
    assert_eq!(read_auth(&home).unwrap().unwrap(), target.auth);
}

#[test]
fn official_accounts_unresolved_current_identity_skips_copy_back_and_allows_switch() {
    let (_dir, store, home, first, target) = fixture();
    let mut current = auth("a", "unresolved-current");
    current["tokens"]["account_id"] = Value::Null;
    fs::write(
        home.join("auth.json"),
        serde_json::to_vec(&current).unwrap(),
    )
    .unwrap();
    store.sync_from_codex(&home).unwrap();
    assert!(store.payload(&home).unwrap()["defaultAccountId"].is_null());
    assert_eq!(current_id(&home).unwrap(), None);
    assert_eq!(store.get(&first.id).unwrap().unwrap().auth, first.auth);
    store.activate(&home, &target.id, || Ok(())).unwrap();
    assert_eq!(read_auth(&home).unwrap().unwrap(), target.auth);
    assert_eq!(store.get(&first.id).unwrap().unwrap().auth, first.auth);
}

#[test]
fn official_accounts_copy_back_respects_refresh_freshness() {
    for (saved_time, current_time, copy) in [
        (
            Some("2026-10-28T10:00:00Z"),
            Some("2026-10-28T09:00:00Z"),
            false,
        ),
        (
            Some("2026-10-28T09:00:00Z"),
            Some("2026-10-28T10:00:00Z"),
            true,
        ),
        (
            Some("2026-10-28T10:00:00Z"),
            Some("2026-10-28T18:00:00+08:00"),
            true,
        ),
        (None, Some("2026-10-28T10:00:00Z"), true),
        (Some("2026-10-28T10:00:00Z"), None, true),
    ] {
        let (_dir, store, home, mut saved, _) = fixture();
        saved.auth["last_refresh"] = json!(saved_time);
        let saved = store.upsert(saved).unwrap();
        let mut current = auth("a", "codex-current");
        current["last_refresh"] = json!(current_time);
        fs::write(
            home.join("auth.json"),
            serde_json::to_vec(&current).unwrap(),
        )
        .unwrap();
        store.sync_from_codex(&home).unwrap();
        let result = store.get(&saved.id).unwrap().unwrap();
        assert_eq!(result.auth, if copy { current } else { saved.auth });
        if !copy {
            assert_eq!(result.generation, saved.generation);
        }
    }
}
