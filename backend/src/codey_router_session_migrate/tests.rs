use super::*;
use rusqlite::Connection;
use serde_json::json;
use std::fs;
use std::path::Path;

fn write_config(home: &Path, body: &str) {
    fs::write(home.join("config.toml"), body).unwrap();
}

fn write_rollout(home: &Path, name: &str, provider: &str, thread_id: &str) -> PathBuf {
    let path = home.join(format!("sessions/2026/09/{name}"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let record = json!({
        "type": "session_meta",
        "payload": {
            "id": thread_id,
            "model_provider": provider,
            "cwd": "/tmp/project"
        }
    });
    fs::write(&path, format!("{record}\n{{\"type\":\"event_msg\"}}\n")).unwrap();
    path
}

fn write_state_db(home: &Path, rows: &[(&str, &str)]) -> PathBuf {
    let sqlite = home.join("sqlite");
    fs::create_dir_all(&sqlite).unwrap();
    let path = sqlite.join("codex.db");
    let db = Connection::open(&path).unwrap();
    db.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, has_user_event INTEGER, cwd TEXT)",
        [],
    )
    .unwrap();
    for (id, provider) in rows {
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, 1, '/tmp/project')",
            (*id, *provider),
        )
        .unwrap();
    }
    path
}

fn sqlite_provider(path: &Path, id: &str) -> String {
    let db = Connection::open(path).unwrap();
    db.query_row(
        "SELECT model_provider FROM threads WHERE id = ?1",
        [id],
        |row| row.get::<_, String>(0),
    )
    .unwrap()
}

fn sqlite_has_user_event(path: &Path, id: &str) -> i64 {
    let db = Connection::open(path).unwrap();
    db.query_row(
        "SELECT has_user_event FROM threads WHERE id = ?1",
        [id],
        |row| row.get::<_, i64>(0),
    )
    .unwrap()
}

#[test]
fn diagnose_is_silent_when_no_codey_router_sessions_exist() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(
        home,
        "model_provider = \"openai\"\n\n[model_providers.openai]\nname = \"OpenAI\"\n",
    );
    write_rollout(home, "rollout-kept.jsonl", "openai", "thread-openai");
    write_state_db(home, &[("thread-openai", "openai")]);

    let diagnosis = diagnose(home).unwrap();

    assert_eq!(diagnosis.affected_session_count, 0);
    assert!(diagnosis.session_ids.is_empty());
}

#[test]
fn diagnose_counts_union_of_rollout_and_sqlite_codey_router_ids() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_rollout(
        home,
        "rollout-router.jsonl",
        ROUTER_PROVIDER_ID,
        "thread-router",
    );
    write_rollout(home, "rollout-openai.jsonl", "openai", "thread-openai");
    write_state_db(
        home,
        &[
            ("thread-router", ROUTER_PROVIDER_ID),
            ("thread-sqlite-only", ROUTER_PROVIDER_ID),
            ("thread-openai", "openai"),
        ],
    );

    let diagnosis = diagnose(home).unwrap();

    assert_eq!(diagnosis.affected_session_count, 2);
    assert_eq!(
        diagnosis.session_ids,
        vec![
            "thread-router".to_string(),
            "thread-sqlite-only".to_string()
        ]
    );
}

#[test]
fn target_discovery_includes_builtin_openai_when_root_key_is_absent() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(
        home,
        "[model_providers.gs]\nname = \"gs\"\n\n[model_providers.codey_router]\nname = \"Codey Local Router\"\n",
    );

    let diagnosis = diagnose(home).unwrap();

    assert_eq!(
        diagnosis.target_providers,
        vec!["gs".to_string(), "openai".to_string()]
    );
}

#[test]
fn target_discovery_does_not_insert_openai_when_root_is_another_id() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"gs\"\n");

    let diagnosis = diagnose(home).unwrap();

    assert_eq!(diagnosis.target_providers, vec!["gs".to_string()]);
}

#[test]
fn migrate_refuses_invalid_or_router_targets_before_writes() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    let rollout = write_rollout(home, "rollout-router.jsonl", ROUTER_PROVIDER_ID, "thread-1");
    let original = fs::read(&rollout).unwrap();

    let missing = migrate(home, "missing", false).unwrap();
    assert_eq!(missing.status, MigrateStatus::Refused);
    assert!(missing.message.contains("不存在于当前用户配置"));
    assert_eq!(fs::read(&rollout).unwrap(), original);

    let router = migrate(home, ROUTER_PROVIDER_ID, false).unwrap();
    assert_eq!(router.status, MigrateStatus::Refused);
    assert!(router.message.contains("内置路由"));
    assert_eq!(fs::read(&rollout).unwrap(), original);
}

#[test]
fn migrate_refuses_when_codex_is_running_or_the_lock_is_held() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    write_rollout(home, "rollout-router.jsonl", ROUTER_PROVIDER_ID, "thread-1");

    let running = migrate(home, "openai", true).unwrap();
    assert_eq!(running.status, MigrateStatus::Refused);
    assert!(running.message.contains("仍在运行"));

    fs::create_dir_all(home.join(LOCK_DIR)).unwrap();
    let locked = migrate(home, "openai", false).unwrap();
    assert_eq!(locked.status, MigrateStatus::Refused);
    assert!(locked.message.contains("维护锁被占用或无法创建"));
}

#[test]
fn migrate_rewrites_only_codey_router_sessions_and_leaves_config_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let config = "model_provider = \"gs\"\n\n[model_providers.gs]\nname = \"gs\"\n";
    write_config(home, config);
    let router = write_rollout(
        home,
        "rollout-router.jsonl",
        ROUTER_PROVIDER_ID,
        "thread-router",
    );
    let kept = write_rollout(home, "rollout-openai.jsonl", "openai", "thread-openai");
    let original_kept = fs::read(&kept).unwrap();
    let db = write_state_db(
        home,
        &[
            ("thread-router", ROUTER_PROVIDER_ID),
            ("thread-openai", "openai"),
        ],
    );

    let report = migrate(home, "gs", false).unwrap();

    assert_eq!(report.status, MigrateStatus::Migrated);
    assert_eq!(report.migrated_session_count, 1);
    assert!(report.unprocessed.is_empty());
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        config
    );
    assert_eq!(fs::read(&kept).unwrap(), original_kept);
    let rewritten = fs::read_to_string(&router).unwrap();
    assert!(rewritten.contains("\"model_provider\":\"gs\""));
    assert!(!rewritten.contains(&format!("\"model_provider\":\"{ROUTER_PROVIDER_ID}\"")));
    assert_eq!(sqlite_provider(&db, "thread-router"), "gs");
    assert_eq!(sqlite_provider(&db, "thread-openai"), "openai");
    assert_eq!(sqlite_has_user_event(&db, "thread-router"), 1);
}

#[test]
fn migrate_is_a_no_op_when_nothing_is_affected() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    write_rollout(home, "rollout-openai.jsonl", "openai", "thread-openai");

    let report = migrate(home, "openai", false).unwrap();

    assert_eq!(report.status, MigrateStatus::Migrated);
    assert_eq!(report.migrated_session_count, 0);
    assert!(report.backup_dir.is_none());
    assert!(!home.join(BACKUP_ROOT).exists());
}

#[test]
fn migrate_restores_rollout_and_sqlite_when_a_later_step_fails() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    let rollout = write_rollout(home, "rollout-router.jsonl", ROUTER_PROVIDER_ID, "thread-1");
    let original = fs::read_to_string(&rollout).unwrap();
    let db = write_state_db(home, &[("thread-1", ROUTER_PROVIDER_ID)]);
    Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_codey_router_migrate BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

    let report = migrate(home, "openai", false).unwrap();

    assert_eq!(report.status, MigrateStatus::Failed);
    assert!(report.message.contains("已恢复"));
    assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
    assert_eq!(sqlite_provider(&db, "thread-1"), ROUTER_PROVIDER_ID);
}

#[test]
fn migrate_backup_can_restore_after_success() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    let rollout = write_rollout(home, "rollout-router.jsonl", ROUTER_PROVIDER_ID, "thread-1");
    let original = fs::read(&rollout).unwrap();
    let db = write_state_db(home, &[("thread-1", ROUTER_PROVIDER_ID)]);

    let report = migrate(home, "openai", false).unwrap();
    let backup_dir = report
        .backup_dir
        .expect("successful migrate keeps a backup");
    restore_backup(home, &backup_dir).unwrap();

    assert_eq!(fs::read(&rollout).unwrap(), original);
    assert_eq!(sqlite_provider(&db, "thread-1"), ROUTER_PROVIDER_ID);
}

#[cfg(unix)]
#[test]
fn migrate_skips_locked_rollout_on_both_sides() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_config(home, "model_provider = \"openai\"\n");
    let locked = write_rollout(
        home,
        "rollout-locked.jsonl",
        ROUTER_PROVIDER_ID,
        "thread-locked",
    );
    let open = write_rollout(
        home,
        "rollout-open.jsonl",
        ROUTER_PROVIDER_ID,
        "thread-open",
    );
    let db = write_state_db(
        home,
        &[
            ("thread-locked", ROUTER_PROVIDER_ID),
            ("thread-open", ROUTER_PROVIDER_ID),
        ],
    );
    let original_locked = fs::read(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let report = migrate(home, "openai", false).unwrap();

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(report.status, MigrateStatus::Migrated);
    assert!(
        report
            .unprocessed
            .iter()
            .any(|item| item.session_id == "thread-locked")
    );
    assert_eq!(fs::read(&locked).unwrap(), original_locked);
    assert!(
        fs::read_to_string(&open)
            .unwrap()
            .contains("\"model_provider\":\"openai\"")
    );
    assert_eq!(sqlite_provider(&db, "thread-locked"), ROUTER_PROVIDER_ID);
    assert_eq!(sqlite_provider(&db, "thread-open"), "openai");
}

#[test]
fn module_does_not_call_vendor_provider_sync_entry() {
    let source = include_str!("../codey_router_session_migrate.rs");
    assert!(
        !source.contains("run_provider_sync"),
        "must not call the wide vendor provider-sync entry"
    );
}
