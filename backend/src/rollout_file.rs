use anyhow::Result;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub(crate) const MAX_DECODED: u64 = 512 * 1024 * 1024;

pub(crate) fn plain_name(name: &str) -> &str {
    name.strip_suffix(".zst")
        .filter(|base| base.ends_with(".jsonl"))
        .unwrap_or(name)
}
pub(crate) fn is_rollout(name: &str) -> bool {
    name.starts_with("rollout-") && plain_name(name).ends_with(".jsonl")
}
pub(crate) fn compressed(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".jsonl.zst"))
}
pub(crate) fn has_extension(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "jsonl") || compressed(path)
}
pub(crate) fn resolve(path: &Path) -> io::Result<PathBuf> {
    let sibling = if compressed(path) {
        path.with_extension("")
    } else if path.extension().is_some_and(|e| e == "jsonl") {
        path.with_extension("jsonl.zst")
    } else {
        return Ok(path.to_owned());
    };
    let present = |p: &Path| match fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    };
    match (present(path)?, present(&sibling)?) {
        (true, true) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "会话记录同时存在：{}、{}",
                path.display(),
                sibling.display()
            ),
        )),
        (false, true) => Ok(sibling),
        _ => Ok(path.to_owned()),
    }
}
fn ensure_current_path(path: &Path) -> io::Result<()> {
    if resolve(path)? != path {
        return Err(io::Error::other("会话记录已变化，请重新加载"));
    }
    Ok(())
}
pub(crate) fn open_plain(path: &Path) -> io::Result<File> {
    ensure_current_path(path)?;
    if compressed(path) {
        return Err(io::Error::other("会话记录需要解压"));
    }
    File::open(path)
}
pub(crate) fn create_plain(path: &Path) -> io::Result<File> {
    ensure_current_path(path)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}
pub(crate) fn remove_current(path: &Path) -> io::Result<()> {
    ensure_current_path(path)?;
    fs::remove_file(path)
}
fn compare_content(reader: &mut impl Read, original: &[u8]) -> Result<()> {
    let mut remaining = original;
    let mut buffer = [0; 65536];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        remaining = remaining
            .strip_prefix(&buffer[..count])
            .ok_or_else(|| anyhow::anyhow!("会话记录已变化，请重新加载后再删除"))?;
    }
    anyhow::ensure!(remaining.is_empty(), "会话记录已变化，请重新加载后再删除");
    Ok(())
}
pub(crate) fn reader_current(path: &Path) -> io::Result<Box<dyn Read>> {
    ensure_current_path(path)?;
    let file = File::open(path)?;
    if compressed(path) {
        Ok(Box::new(zstd::Decoder::new(file)?))
    } else {
        Ok(Box::new(file))
    }
}
pub(crate) fn bounded(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader_current(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("会话记录超过读取上限（{limit} 字节）"),
        ));
    }
    Ok(bytes)
}
pub(crate) fn text(path: &Path) -> io::Result<String> {
    ensure_current_path(path)?;
    if !compressed(path) {
        return fs::read_to_string(path);
    }
    String::from_utf8(bounded(path, MAX_DECODED)?)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
pub(crate) trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}
pub(crate) fn seekable(path: &Path, limit: u64) -> io::Result<Box<dyn ReadSeek>> {
    ensure_current_path(path)?;
    if compressed(path) {
        Ok(Box::new(Cursor::new(bounded(path, limit)?)))
    } else {
        Ok(Box::new(File::open(path)?))
    }
}
pub(crate) struct RolloutWindow {
    pub head: Vec<u8>,
    tail: Vec<u8>,
    tail_truncated: bool,
}

impl RolloutWindow {
    pub fn tail_records(&self) -> &[u8] {
        if !self.tail_truncated {
            return &self.tail;
        }
        self.tail
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(&[], |index| &self.tail[index + 1..])
    }
}

pub(crate) fn read_window(
    path: &Path,
    head_limit: usize,
    tail_limit: usize,
) -> io::Result<RolloutWindow> {
    let mut head = Vec::new();
    if !compressed(path) {
        let mut file = open_plain(path)?;
        let length = file.seek(SeekFrom::End(0))?;
        if head_limit > 0 {
            file.seek(SeekFrom::Start(0))?;
            (&mut file).take(head_limit as u64).read_to_end(&mut head)?;
        }
        let start = length.saturating_sub(tail_limit as u64);
        file.seek(SeekFrom::Start(start))?;
        let mut tail = Vec::new();
        file.take(tail_limit as u64).read_to_end(&mut tail)?;
        return Ok(RolloutWindow {
            head,
            tail,
            tail_truncated: start > 0,
        });
    }
    let mut reader = reader_current(path)?;
    let mut tail = std::collections::VecDeque::new();
    let mut tail_truncated = false;
    let mut chunk = [0; 32 * 1024];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        let bytes = &chunk[..count];
        head.extend_from_slice(&bytes[..count.min(head_limit - head.len())]);
        let overflow = (tail.len() + count).saturating_sub(tail_limit);
        tail_truncated |= overflow > 0;
        tail.drain(..overflow.min(tail.len()));
        tail.extend(&bytes[count.saturating_sub(tail_limit)..]);
    }
    Ok(RolloutWindow {
        head,
        tail: tail.into(),
        tail_truncated,
    })
}

pub(crate) fn rewrite(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let metadata = File::options().write(true).open(path)?.metadata()?;
    replace_with_check(path, bytes, &metadata, || Ok(()))
}
fn replace_with_check(
    path: &Path,
    bytes: &[u8],
    metadata: &fs::Metadata,
    check: impl FnOnce() -> Result<()>,
) -> Result<()> {
    ensure_current_path(path)?;
    let modified = metadata.modified()?;
    let temp = crate::fs_util::unique_temp_path(path);
    let result = (|| -> anyhow::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.set_permissions(metadata.permissions())?;
        if compressed(path) {
            zstd::stream::copy_encode(bytes, &mut file, 0)?;
        } else {
            std::io::Write::write_all(&mut file, bytes)?;
        }
        file.set_modified(modified)?;
        file.sync_all()?;
        drop(file);
        check()?;
        ensure_current_path(path)?;
        anyhow::ensure!(
            same_rollout_metadata(metadata, &fs::symlink_metadata(path)?),
            "会话记录已变化，请重新加载"
        );
        crate::fs_util::persist_temp_file(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub(crate) fn rollout_thread_id_from_filename(name: &str) -> Option<String> {
    let stem = plain_name(name)
        .strip_prefix("rollout-")?
        .strip_suffix(".jsonl")?;
    if stem.len() < 36 {
        return None;
    }
    let candidate = stem.get(stem.len() - 36..)?;
    let valid = candidate
        .chars()
        .enumerate()
        .all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        });
    valid.then(|| candidate.to_string())
}

fn same_rollout_metadata(original: &fs::Metadata, current: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if original.dev() != current.dev() || original.ino() != current.ino() {
            return false;
        }
    }
    current.is_file()
        && original.len() == current.len()
        && original.modified().ok() == current.modified().ok()
        && original.created().ok() == current.created().ok()
}

pub(crate) fn rewrite_if_unchanged(
    destination: &Path,
    metadata: &fs::Metadata,
    original: &[u8],
    contents: &[u8],
) -> Result<()> {
    ensure_current_path(destination)?;
    let recovery_path = rollout_recovery_path(destination);
    anyhow::ensure!(
        !recovery_path.exists(),
        "会话存在待恢复写入，请先恢复后再删除"
    );
    if compressed(destination) {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)?;
        file.try_lock_exclusive()?;
        return replace_with_check(destination, contents, metadata, || {
            let mut reader = zstd::Decoder::new(&mut file)?;
            compare_content(&mut reader, original)?;
            anyhow::ensure!(
                same_rollout_metadata(metadata, &file.metadata()?),
                "会话记录已变化，请重新加载后再删除"
            );
            Ok(())
        });
    }
    // Codex 可能仍通过已打开的句柄追加普通记录；保留文件身份并使用恢复日志。
    let temporary = crate::fs_util::unique_temp_path(destination);
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        serde_json::to_writer(
            &mut output,
            &RolloutRecovery {
                version: 1,
                restoring: false,
                identity: rollout_identity(metadata),
                original: std::str::from_utf8(original)?,
                replacement: std::str::from_utf8(contents)?,
            },
        )?;
        output.sync_all()?;
        drop(output);
        let mut current = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)?;
        current.try_lock_exclusive()?;
        compare_content(&mut current, original)?;
        ensure_current_path(destination)?;
        anyhow::ensure!(
            same_rollout_metadata(metadata, &current.metadata()?)
                && same_rollout_metadata(metadata, &fs::symlink_metadata(destination)?),
            "会话记录已变化，请重新加载后再删除"
        );
        crate::fs_util::persist_temp_file(&temporary, &recovery_path)?;
        if let Err(error) = overwrite_rollout(&mut current, contents) {
            drop(current);
            return match recover_rollout_write(destination) {
                Ok(()) => Err(error.into()),
                Err(recovery_error) => Err(anyhow::anyhow!(
                    "会话写入失败：{error}；恢复失败：{recovery_error:#}；原始数据保存在 {}",
                    recovery_path.display()
                )),
            };
        }
        current.set_modified(metadata.modified()?)?;
        fs::remove_file(&recovery_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Serialize, Deserialize)]
struct RolloutRecovery<Text> {
    version: u32,
    #[serde(default)]
    restoring: bool,
    identity: String,
    original: Text,
    replacement: Text,
}

fn rollout_identity(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}", metadata.created().ok())
    }
}

fn rollout_recovery_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    destination.with_file_name(format!(".{name}.codey-delete-recovery.json"))
}

fn overwrite_rollout(file: &mut fs::File, contents: &[u8]) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.set_len(0)?;
    file.write_all(contents)?;
    file.sync_all()
}

pub(crate) fn recover_rollout_write(destination: &Path) -> Result<()> {
    let recovery_path = rollout_recovery_path(destination);
    ensure_current_path(destination)?;
    let recovery = match fs::File::open(&recovery_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut recovery: RolloutRecovery<String> =
        serde_json::from_reader(std::io::BufReader::new(recovery))?;
    anyhow::ensure!(recovery.version == 1, "会话恢复记录版本无效");
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)?;
    file.try_lock_exclusive()?;
    anyhow::ensure!(
        rollout_identity(&file.metadata()?) == recovery.identity,
        "会话文件身份已变化，保留恢复记录以供检查"
    );
    let mut current = Vec::new();
    (&mut file)
        .take(recovery.original.len().max(recovery.replacement.len()) as u64 + 1)
        .read_to_end(&mut current)?;
    if recovery.restoring {
        if !current.starts_with(recovery.original.as_bytes()) {
            anyhow::ensure!(
                recovery.original.as_bytes().starts_with(&current),
                "会话恢复期间内容已变化，保留恢复记录以供检查"
            );
            overwrite_rollout(&mut file, recovery.original.as_bytes())?;
        }
    } else if current != recovery.original.as_bytes()
        && !current.starts_with(recovery.replacement.as_bytes())
    {
        anyhow::ensure!(
            recovery.replacement.as_bytes().starts_with(&current),
            "会话内容已变化，保留恢复记录以供检查"
        );
        recovery.restoring = true;
        crate::fs_util::atomic_write_private(&recovery_path, &serde_json::to_vec(&recovery)?)?;
        overwrite_rollout(&mut file, recovery.original.as_bytes())?;
    }
    fs::remove_file(recovery_path)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn assert_conflicting_paths(message: &str, plain: &Path, packed: &Path) {
    let (_, paths) = message.split_once("会话记录同时存在：").expect(message);
    let (first, second) = paths.split_once('、').expect(message);
    let mut reported = [first, second].map(|path| fs::canonicalize(path).expect(message));
    let mut expected = [plain, packed].map(|path| fs::canonicalize(path).unwrap());
    reported.sort();
    expected.sort();
    assert_eq!(reported, expected);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rollout_variants_resolve_and_refuse_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("rollout-test.jsonl");
        let packed = plain.with_extension("jsonl.zst");
        fs::write(&plain, b"one\n").unwrap();
        assert_eq!(resolve(&packed).unwrap(), plain);
        fs::write(&packed, zstd::encode_all(&b"two\n"[..], 1).unwrap()).unwrap();
        for path in [&plain, &packed] {
            let message = resolve(path).unwrap_err().to_string();
            assert_conflicting_paths(&message, &plain, &packed);
        }
        fs::remove_file(&plain).unwrap();
        assert_eq!(resolve(&plain).unwrap(), packed);
        assert_eq!(bounded(&resolve(&plain).unwrap(), 4).unwrap(), b"two\n");
    }

    #[test]
    fn compressed_rollout_rewrite_preserves_frame_mtime_and_bounds_output() {
        let dir = tempfile::tempdir().unwrap();
        let packed = dir.path().join("x.jsonl.zst");
        fs::write(
            &packed,
            zstd::encode_all(&vec![b'x'; 16384][..], 1).unwrap(),
        )
        .unwrap();
        assert!(fs::metadata(&packed).unwrap().len() < 256);
        assert!(
            bounded(&packed, 256)
                .unwrap_err()
                .to_string()
                .contains("上限")
        );
        let file = File::options().write(true).open(&packed).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1234567890))
            .unwrap();
        let modified = file.metadata().unwrap().modified().unwrap();
        drop(file);
        rewrite(&packed, b"updated\n").unwrap();
        let frame = fs::read(&packed).unwrap();
        assert_eq!(frame[..4], [0x28, 0xb5, 0x2f, 0xfd]);
        assert_eq!(
            zstd::zstd_safe::find_frame_compressed_size(&frame).unwrap(),
            frame.len()
        );
        assert_eq!(text(&packed).unwrap(), "updated\n");
        assert_eq!(fs::metadata(&packed).unwrap().modified().unwrap(), modified);
    }
    #[test]
    fn interrupted_rollout_write_recovers_original_without_losing_completed_appends() {
        let home = tempdir().unwrap();
        let path = home.path().join("rollout.jsonl");
        fs::write(&path, b"original-history").unwrap();
        let recovery = RolloutRecovery {
            version: 1,
            restoring: false,
            identity: rollout_identity(&fs::metadata(&path).unwrap()),
            original: "original-history",
            replacement: "kept-history",
        };
        let recovery_path = rollout_recovery_path(&path);
        for (interrupted, expected) in [
            ("", "original-history"),
            ("kept-", "original-history"),
            ("kept-history\nnew-turn", "kept-history\nnew-turn"),
        ] {
            fs::write(&recovery_path, serde_json::to_vec(&recovery).unwrap()).unwrap();
            fs::write(&path, interrupted).unwrap();
            recover_rollout_write(&path).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), expected);
            assert!(!recovery_path.exists());
        }
        fs::write(&recovery_path, serde_json::to_vec(&recovery).unwrap()).unwrap();
        fs::write(&path, "unrelated-change").unwrap();
        assert!(recover_rollout_write(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "unrelated-change");
        assert!(recovery_path.exists());
    }

    #[test]
    fn interrupted_recovery_handles_every_prefix_and_preserves_completed_appends() {
        let home = tempdir().unwrap();
        let path = home.path().join("rollout.jsonl");
        let original = "kept-history\nremoved-turn\n";
        fs::write(&path, original).unwrap();
        let recovery = RolloutRecovery {
            version: 1,
            restoring: true,
            identity: rollout_identity(&fs::metadata(&path).unwrap()),
            original,
            replacement: "kept-history\n",
        };
        let recovery_path = rollout_recovery_path(&path);
        for prefix_length in 0..=original.len() {
            fs::write(&recovery_path, serde_json::to_vec(&recovery).unwrap()).unwrap();
            fs::write(&path, &original[..prefix_length]).unwrap();
            recover_rollout_write(&path).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
            assert!(!recovery_path.exists());
        }
        fs::write(&recovery_path, serde_json::to_vec(&recovery).unwrap()).unwrap();
        let appended = format!("{original}new-turn\n");
        fs::write(&path, &appended).unwrap();
        recover_rollout_write(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), appended);
    }

    #[test]
    fn rewrite_rejects_changed_history_and_preserves_all_records() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        fs::write(&path, b"keep\nremove\n").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"new-record\n")
            .unwrap();
        assert!(rewrite_if_unchanged(&path, &metadata, b"keep\nremove\n", b"keep\n").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep\nremove\nnew-record\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn rewrite_commits_complete_history_and_rejects_same_length_changes() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        fs::write(&path, b"original").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert!(rewrite_if_unchanged(&path, &metadata, b"different", b"new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        rewrite_if_unchanged(&path, &metadata, b"original", b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
