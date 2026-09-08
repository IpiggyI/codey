use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use codey_runtime_core::codex_sqlite::{
    codex_session_db_paths_from_home, codex_sqlite_sidecar_paths,
};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toml_edit::{DocumentMut, Item};

use crate::codex_config::BUILTIN_OPENAI_PROVIDER_ID;
use crate::fs_util::timestamp_millis;
use crate::session_metadata::normalize_session_id;
use crate::sqlite_util::table_columns;

pub(crate) const ROUTER_PROVIDER_ID: &str = "codey_router";

const SESSION_DIRS: [&str; 2] = ["sessions", "archived_sessions"];
const LOCK_DIR: &str = "tmp/codey-router-session-migrate.lock";
const BACKUP_ROOT: &str = "backups_state/codey-router-session-migrate";
const BACKUP_KEEP_COUNT: usize = 5;
const MANAGED_BY: &str = "Codey codey_router session migrate";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub affected_session_count: usize,
    pub session_ids: Vec<String>,
    pub target_providers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrateStatus {
    Migrated,
    Refused,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnprocessedSession {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub status: MigrateStatus,
    pub message: String,
    pub target_provider: String,
    pub backup_dir: Option<PathBuf>,
    pub migrated_session_count: usize,
    pub unprocessed: Vec<UnprocessedSession>,
}

struct MigrateLock {
    path: PathBuf,
}

impl MigrateLock {
    fn acquire(home: &Path) -> Result<Self> {
        let path = home.join(LOCK_DIR);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir(&path).with_context(|| format!("维护锁被占用：{}", path.display()))?;
        fs::write(
            path.join("owner.json"),
            serde_json::to_vec(&json!({
                "pid": std::process::id(),
                "startedAt": timestamp_millis(),
            }))?,
        )?;
        Ok(Self { path })
    }
}

impl Drop for MigrateLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct PlannedFile {
    path: PathBuf,
    original: String,
    session_ids: HashSet<String>,
}

pub fn diagnose(home: &Path) -> Result<Diagnosis> {
    let session_ids = collect_affected_ids(home)?;
    Ok(Diagnosis {
        affected_session_count: session_ids.len(),
        session_ids,
        target_providers: configured_provider_ids(home).unwrap_or_default(),
    })
}

pub fn migrate(home: &Path, target_provider: &str, codex_running: bool) -> Result<MigrateReport> {
    let target_provider = target_provider.trim();
    if let Some(report) = refuse_invalid_target(home, target_provider) {
        return Ok(report);
    }
    if codex_running {
        return Ok(refused(
            target_provider,
            "Codex 仍在运行，已拒绝迁移。请在 Codex 停止后重试。",
        ));
    }
    let _lock = match MigrateLock::acquire(home) {
        Ok(lock) => lock,
        Err(error) => {
            return Ok(refused(
                target_provider,
                &format!("维护锁被占用或无法创建，已拒绝迁移：{error:#}"),
            ));
        }
    };
    migrate_locked(home, target_provider)
}

pub(crate) fn restore_backup(home: &Path, backup_dir: &Path) -> Result<()> {
    let metadata: Value = serde_json::from_slice(&fs::read(backup_dir.join("metadata.json"))?)?;
    let files = metadata
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for file in files {
        let Some(relative) = file.as_str() else {
            continue;
        };
        let source = backup_dir.join("files").join(relative);
        let destination = home.join(relative);
        if !source.exists() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source, &destination).with_context(|| {
            format!(
                "从备份恢复失败：{} -> {}",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
}

fn migrate_locked(home: &Path, target_provider: &str) -> Result<MigrateReport> {
    let session_ids = collect_affected_ids(home)?;
    if session_ids.is_empty() {
        return Ok(MigrateReport {
            status: MigrateStatus::Migrated,
            message: "没有需要迁移的历史会话。".to_string(),
            target_provider: target_provider.to_string(),
            backup_dir: None,
            migrated_session_count: 0,
            unprocessed: Vec::new(),
        });
    }

    let plan = plan_rollout_changes(home, &session_ids)?;
    let sqlite_paths = codex_session_db_paths_from_home(home);
    let backup_files = backup_candidates(&plan.files, &sqlite_paths);
    let backup_dir = create_backup(home, target_provider, &session_ids, &backup_files)?;

    let apply_result = (|| -> Result<(HashSet<String>, Vec<UnprocessedSession>)> {
        let mut applied_ids = HashSet::new();
        let mut skipped = plan.unprocessed;
        for file in &plan.files {
            match apply_rollout_file(file, target_provider) {
                Ok(true) => applied_ids.extend(file.session_ids.iter().cloned()),
                Ok(false) => skipped.extend(unprocessed_for(
                    &file.session_ids,
                    "会话文件被占用，已跳过。",
                )),
                Err(error) => return Err(error),
            }
        }
        let sqlite_ids = if plan.had_locked_rollout {
            applied_ids.clone()
        } else {
            session_ids.iter().cloned().collect()
        };
        let sqlite_ids = sqlite_ids
            .into_iter()
            .filter(|id| !skipped.iter().any(|item| &item.session_id == id))
            .collect::<HashSet<_>>();
        apply_sqlite_updates(&sqlite_paths, target_provider, &sqlite_ids)?;
        applied_ids.extend(sqlite_ids);
        Ok((applied_ids, skipped))
    })();

    match apply_result {
        Ok((applied_ids, mut unprocessed)) => {
            let remaining = session_ids
                .iter()
                .filter(|id| !applied_ids.contains(*id))
                .collect::<Vec<_>>();
            if !remaining.is_empty() {
                unprocessed.extend(unprocessed_for(remaining, "会话文件被占用，已跳过。"));
            }
            unprocessed.sort_by(|left, right| left.session_id.cmp(&right.session_id));
            unprocessed.dedup_by(|left, right| left.session_id == right.session_id);
            let migrated_session_count = applied_ids.len();
            let mut message =
                format!("已将 {migrated_session_count} 个历史会话改写为 {target_provider}。");
            if !unprocessed.is_empty() {
                message.push_str(&format!(
                    " 有 {} 个会话因文件被占用未处理。",
                    unprocessed.len()
                ));
            }
            if let Err(error) = prune_backups(home) {
                message.push_str(&format!(" 旧备份清理未完成：{error:#}"));
            }
            Ok(MigrateReport {
                status: MigrateStatus::Migrated,
                message,
                target_provider: target_provider.to_string(),
                backup_dir: Some(backup_dir),
                migrated_session_count,
                unprocessed,
            })
        }
        Err(error) => {
            restore_backup(home, &backup_dir).with_context(|| {
                format!(
                    "迁移失败且备份恢复也失败：{error:#}；备份位于 {}",
                    backup_dir.display()
                )
            })?;
            Ok(MigrateReport {
                status: MigrateStatus::Failed,
                message: format!("迁移失败，已恢复改写前的内容：{error:#}"),
                target_provider: target_provider.to_string(),
                backup_dir: Some(backup_dir),
                migrated_session_count: 0,
                unprocessed: unprocessed_for(&session_ids, "迁移失败，已恢复改写前的内容。"),
            })
        }
    }
}

pub(crate) fn refuse_invalid_target(home: &Path, target_provider: &str) -> Option<MigrateReport> {
    if target_provider.is_empty() || !is_valid_provider_id(target_provider) {
        return Some(refused(target_provider, "目标 provider 无效。"));
    }
    if target_provider == ROUTER_PROVIDER_ID {
        return Some(refused(target_provider, "不能把会话迁移到内置路由。"));
    }
    match configured_provider_ids(home) {
        Ok(ids) if ids.iter().any(|id| id == target_provider) => None,
        Ok(_) => Some(refused(
            target_provider,
            "目标 provider 不存在于当前用户配置。",
        )),
        Err(error) => Some(refused(
            target_provider,
            &format!("当前用户配置无法解析，已拒绝迁移：{error:#}"),
        )),
    }
}

fn refused(target_provider: &str, message: &str) -> MigrateReport {
    MigrateReport {
        status: MigrateStatus::Refused,
        message: message.to_string(),
        target_provider: target_provider.to_string(),
        backup_dir: None,
        migrated_session_count: 0,
        unprocessed: Vec::new(),
    }
}

fn configured_provider_ids(home: &Path) -> Result<Vec<String>> {
    let path = home.join("config.toml");
    let document = if path.exists() {
        fs::read_to_string(&path)?
            .parse::<DocumentMut>()
            .with_context(|| format!("解析用户配置失败：{}", path.display()))?
    } else {
        DocumentMut::new()
    };
    let mut ids = BTreeSet::new();
    if let Some(providers) = document
        .get("model_providers")
        .and_then(Item::as_table_like)
    {
        for (key, _) in providers.iter() {
            if key != ROUTER_PROVIDER_ID && is_valid_provider_id(key) {
                ids.insert(key.to_string());
            }
        }
    }
    match document
        .get("model_provider")
        .and_then(Item::as_str)
        .map(str::trim)
    {
        Some(id) if !id.is_empty() && id != ROUTER_PROVIDER_ID && is_valid_provider_id(id) => {
            ids.insert(id.to_string());
        }
        Some(id) if !id.is_empty() => {}
        _ => {
            ids.insert(BUILTIN_OPENAI_PROVIDER_ID.to_string());
        }
    }
    Ok(ids.into_iter().collect())
}

fn is_valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
}

fn collect_affected_ids(home: &Path) -> Result<Vec<String>> {
    let mut ids = HashSet::new();
    for path in rollout_files(home)? {
        match fs::read_to_string(&path) {
            Ok(text) => ids.extend(inspect_rollout_text(&text).1),
            Err(error) if is_locked_io_error(&error) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    for path in codex_session_db_paths_from_home(home) {
        ids.extend(sqlite_codey_router_ids(&path)?);
    }
    let mut ids = ids.into_iter().collect::<Vec<_>>();
    ids.sort();
    Ok(ids)
}

struct RolloutPlan {
    files: Vec<PlannedFile>,
    unprocessed: Vec<UnprocessedSession>,
    had_locked_rollout: bool,
}

fn plan_rollout_changes(home: &Path, session_ids: &[String]) -> Result<RolloutPlan> {
    let wanted = session_ids.iter().cloned().collect::<HashSet<_>>();
    let mut files = Vec::new();
    let mut had_locked_rollout = false;
    for path in rollout_files(home)? {
        let original = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if is_locked_io_error(&error) => {
                had_locked_rollout = true;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let file_ids = inspect_rollout_text(&original)
            .1
            .into_iter()
            .filter(|id| wanted.contains(id))
            .collect::<HashSet<_>>();
        if file_ids.is_empty() {
            continue;
        }
        files.push(PlannedFile {
            path,
            original,
            session_ids: file_ids,
        });
    }
    Ok(RolloutPlan {
        files,
        unprocessed: Vec::new(),
        had_locked_rollout,
    })
}

fn apply_rollout_file(file: &PlannedFile, target_provider: &str) -> Result<bool> {
    let (next, changed) = rewrite_codey_router_session_meta(&file.original, target_provider)?;
    if !changed {
        return Ok(true);
    }
    match fs::write(&file.path, next) {
        Ok(()) => Ok(true),
        Err(error) if is_locked_io_error(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn rewrite_codey_router_session_meta(text: &str, target_provider: &str) -> Result<(String, bool)> {
    let mut next = String::with_capacity(text.len());
    let mut changed = false;
    for segment in text.split_inclusive('\n') {
        let (line, ending) = split_line_ending(segment);
        if let Some(rewritten) = rewrite_session_meta_line(line, target_provider)? {
            next.push_str(&rewritten);
            next.push_str(ending);
            changed = true;
        } else {
            next.push_str(segment);
        }
    }
    Ok((next, changed))
}

fn rewrite_session_meta_line(line: &str, target_provider: &str) -> Result<Option<String>> {
    let Ok(mut record) = serde_json::from_str::<Value>(line) else {
        return Ok(None);
    };
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Ok(None);
    }
    let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) else {
        return Ok(None);
    };
    if payload.get("model_provider").and_then(Value::as_str) != Some(ROUTER_PROVIDER_ID) {
        return Ok(None);
    }
    payload.insert("model_provider".to_string(), json!(target_provider));
    Ok(Some(serde_json::to_string(&record)?))
}

fn inspect_rollout_text(text: &str) -> (Option<String>, HashSet<String>) {
    let mut thread_id = None;
    let mut ids = HashSet::new();
    for segment in text.split_inclusive('\n') {
        let (line, _) = split_line_ending(segment);
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = record.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if thread_id.is_none() {
            thread_id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(|id| normalize_session_id(id).to_string())
                .filter(|id| !id.is_empty());
        }
        if payload.get("model_provider").and_then(Value::as_str) != Some(ROUTER_PROVIDER_ID) {
            continue;
        }
        if let Some(id) = payload
            .get("id")
            .and_then(Value::as_str)
            .map(normalize_session_id)
            .filter(|id| !id.is_empty())
        {
            ids.insert(id.to_string());
        } else if let Some(id) = thread_id.clone() {
            ids.insert(id);
        }
    }
    (thread_id, ids)
}

fn sqlite_codey_router_ids(path: &Path) -> Result<HashSet<String>> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let db = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(db) => db,
        Err(_) => return Ok(HashSet::new()),
    };
    let columns = table_columns(&db, "threads")?;
    if !columns.contains("id") || !columns.contains("model_provider") {
        return Ok(HashSet::new());
    }
    let mut statement = db.prepare(
        "SELECT id FROM threads WHERE COALESCE(model_provider, '') = ?1 AND COALESCE(id, '') <> ''",
    )?;
    let ids = statement
        .query_map([ROUTER_PROVIDER_ID], |row| row.get::<_, String>(0))?
        .map(|id| id.map(|value| normalize_session_id(&value).to_string()))
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(ids.into_iter().filter(|id| !id.is_empty()).collect())
}

fn apply_sqlite_updates(
    paths: &[PathBuf],
    target_provider: &str,
    session_ids: &HashSet<String>,
) -> Result<()> {
    if session_ids.is_empty() {
        return Ok(());
    }
    for path in paths {
        apply_sqlite_update(path, target_provider, session_ids)?;
    }
    Ok(())
}

fn apply_sqlite_update(
    path: &Path,
    target_provider: &str,
    session_ids: &HashSet<String>,
) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut db = Connection::open(path)?;
    let columns = table_columns(&db, "threads")?;
    if !columns.contains("id") || !columns.contains("model_provider") {
        return Ok(());
    }
    let tx = db.transaction()?;
    for session_id in session_ids {
        tx.execute(
            "UPDATE threads SET model_provider = ?1 WHERE id = ?2 AND COALESCE(model_provider, '') = ?3",
            params![target_provider, session_id, ROUTER_PROVIDER_ID],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn backup_candidates(planned: &[PlannedFile], sqlite_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = planned
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    for db_path in sqlite_paths {
        files.extend(
            codex_sqlite_sidecar_paths(db_path)
                .into_iter()
                .filter(|path| path.exists()),
        );
    }
    files.sort();
    files.dedup();
    files
}

fn relative_to_codex_home(home: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(home).unwrap_or(path).to_path_buf()
}

fn create_backup(
    home: &Path,
    target_provider: &str,
    session_ids: &[String],
    files: &[PathBuf],
) -> Result<PathBuf> {
    let backup_dir = unique_backup_dir(&home.join(BACKUP_ROOT));
    fs::create_dir_all(backup_dir.join("files"))?;
    let mut relative_files = Vec::new();
    for source in files {
        if !source.exists() {
            continue;
        }
        let relative = relative_to_codex_home(home, source);
        let target = backup_dir.join("files").join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, &target)?;
        relative_files.push(relative.to_string_lossy().replace('\\', "/"));
    }
    fs::write(
        backup_dir.join("metadata.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "namespace": "codey-router-session-migrate",
            "managedBy": MANAGED_BY,
            "targetProvider": target_provider,
            "sessionIds": session_ids,
            "files": relative_files,
            "createdAtMs": timestamp_millis(),
        }))?,
    )?;
    Ok(backup_dir)
}

fn unique_backup_dir(root: &Path) -> PathBuf {
    let base = timestamp_millis().to_string();
    let mut path = root.join(&base);
    let mut suffix = 0usize;
    while path.exists() {
        suffix += 1;
        path = root.join(format!("{base}-{suffix}"));
    }
    path
}

fn prune_backups(home: &Path) -> Result<()> {
    let root = home.join(BACKUP_ROOT);
    if !root.exists() {
        return Ok(());
    }
    let mut managed = Vec::new();
    for entry in fs::read_dir(&root)? {
        let path = entry?.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(bytes) = fs::read(path.join("metadata.json")) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if metadata.get("managedBy").and_then(Value::as_str) == Some(MANAGED_BY) {
            managed.push(path);
        }
    }
    managed.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for path in managed.into_iter().skip(BACKUP_KEEP_COUNT) {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}

fn rollout_files(home: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for dirname in SESSION_DIRS {
        let root = home.join(dirname);
        if root.exists() {
            collect_rollout_files(&root, &mut files)?;
        }
    }
    files.sort();
    Ok(files)
}

fn collect_rollout_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_rollout_files(&path, files)?;
            continue;
        }
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn split_line_ending(segment: &str) -> (&str, &str) {
    if let Some(line) = segment.strip_suffix("\r\n") {
        (line, "\r\n")
    } else if let Some(line) = segment.strip_suffix('\n') {
        (line, "\n")
    } else {
        (segment, "")
    }
}

fn is_locked_io_error(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::PermissionDenied)
        || matches!(error.raw_os_error(), Some(32 | 33))
}

fn unprocessed_for<'a>(
    session_ids: impl IntoIterator<Item = &'a String>,
    reason: &str,
) -> Vec<UnprocessedSession> {
    let mut items = session_ids
        .into_iter()
        .map(|id| UnprocessedSession {
            session_id: id.clone(),
            reason: reason.to_string(),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    items
}

#[cfg(test)]
mod tests;
