use std::collections::VecDeque;
#[cfg(test)]
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::{ConversationStatsSnapshot, state::State};
use crate::rollout_file::{self, FileVersion};

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const HEAD_BYTES: u64 = 4 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;

fn line_may_affect_stats(line: &[u8]) -> bool {
    [
        b"session_meta".as_slice(),
        b"compacted",
        b"event_msg",
        b"token_usage_record",
        b"response_item",
        b"turn_context",
        b"\\u",
    ]
    .iter()
    .any(|name| memchr::memmem::find(line, name).is_some())
}

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<(PathBuf, String, Reader)>,
}

impl Cache {
    pub fn read(&mut self, path: &Path, session_id: &str) -> Result<ConversationStatsSnapshot> {
        let context = || format!("读取对话用量失败：{}", path.display());
        let path = rollout_file::resolve(path).with_context(context)?;
        let alternate = rollout_file::alternate_path(&path);
        let index = self.entries.iter().position(|(cached, id, _)| {
            id == session_id && (*cached == path || Some(cached) == alternate.as_ref())
        });
        let mut reader = index
            .and_then(|index| self.entries.remove(index))
            .filter(|(cached, _, _)| *cached == path)
            .map(|(_, _, reader)| reader)
            .unwrap_or_default();
        reader.read(&path, session_id).with_context(context)?;
        let snapshot = reader.state.snapshot();
        self.entries
            .push_back((path, session_id.to_owned(), reader));
        if self.entries.len() > MAX_SESSIONS {
            self.entries.pop_front();
        }
        Ok(snapshot)
    }
}

#[derive(Default)]
struct Reader {
    offset: u64,
    checkpoint: Option<[u8; 32]>,
    version: Option<FileVersion>,
    state: State,
}

impl Reader {
    fn read(&mut self, path: &Path, session_id: &str) -> Result<()> {
        if rollout_file::compressed(path) {
            let version = rollout_file::file_version(&std::fs::metadata(path)?);
            if self.version == Some(version) {
                return Ok(());
            }
            let bytes = rollout_file::bounded(path, rollout_file::MAX_DECODED)?;
            let len = bytes.len() as u64;
            *self = Self::default();
            self.read_append(&mut std::io::Cursor::new(bytes), len, session_id)?;
            self.version = Some(version);
            return Ok(());
        }
        let mut file = rollout_file::open_plain(path)?;
        let (len, modified) = rollout_file::file_version(&file.metadata()?);
        if len < self.offset
            || self
                .version
                .is_some_and(|(old_len, old_modified)| len == old_len && modified != old_modified)
        {
            *self = Self::default();
        }
        if let Some(checkpoint) = self.checkpoint
            && checkpoint != boundary_digest(&mut file, self.offset)?
        {
            *self = Self::default();
        }
        let previous_offset = self.offset;
        self.read_append(&mut file, len, session_id)?;
        if self.checkpoint.is_none() || self.offset != previous_offset {
            self.checkpoint = Some(boundary_digest(&mut file, self.offset)?);
        }
        self.version = Some((len, modified));
        Ok(())
    }

    fn read_append(
        &mut self,
        file: &mut impl crate::rollout_file::ReadSeek,
        len: u64,
        session_id: &str,
    ) -> Result<()> {
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::with_capacity(64 * 1024, file.take(len - self.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let mut consumed = 0u64;
            let mut oversized = false;
            loop {
                let buffer = reader.fill_buf()?;
                if buffer.is_empty() {
                    return Ok(());
                }
                let end = memchr::memchr(b'\n', buffer);
                let size = end.map_or(buffer.len(), |end| end + 1);
                consumed += size as u64;
                if !oversized && line.len() + size <= MAX_LINE_BYTES {
                    line.extend_from_slice(&buffer[..size]);
                } else {
                    oversized = true;
                    line.clear();
                }
                reader.consume(size);
                if end.is_some() {
                    break;
                }
            }
            self.offset += consumed;
            if oversized || self.observe_line(&line, session_id).is_err() {
                self.state.mark_partial();
            }
        }
    }

    fn observe_line(&mut self, line: &[u8], session_id: &str) -> Result<()> {
        if line_may_affect_stats(line) {
            let record = serde_json::from_slice(line)?;
            self.state.observe(&record, session_id);
        } else {
            // 无关记录只校验 JSON，避免为其分配字段和值。
            serde_json::from_str::<&serde_json::value::RawValue>(std::str::from_utf8(line)?)?;
        }
        Ok(())
    }
}

fn boundary_digest(file: &mut (impl Read + Seek), offset: u64) -> Result<[u8; 32]> {
    // 校验已读区域的首尾；删除整轮会移动后续记录，轮询不重读整个文件。
    let mut fingerprint = Sha256::new();
    let mut buffer = [0; TAIL_BYTES as usize];
    for (start, len) in [
        (0, offset.min(HEAD_BYTES)),
        (offset.saturating_sub(TAIL_BYTES), offset.min(TAIL_BYTES)),
    ] {
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..len as usize])?;
        fingerprint.update(&buffer[..len as usize]);
    }
    Ok(fingerprint.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn prefilter_keeps_stats_records_and_marks_malformed_unrelated_lines_partial() {
        use std::io::Write;

        for kind in [
            "session_meta",
            "compacted",
            "event_msg",
            "token_usage_record",
            "response_item",
            "turn_context",
        ] {
            assert!(line_may_affect_stats(
                format!(r#"{{"type":"{kind}"}}"#).as_bytes()
            ));
        }
        assert!(line_may_affect_stats(br#"{"type":"\u0063ompacted"}"#));
        assert!(!line_may_affect_stats(br#"{"type":"other"}"#));

        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-10-28T00:00:00Z","type":"event_msg","payload":{{"type":"task_started","turn_id":"first"}}}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"type":"other"}}"#).unwrap();
        let mut reader = Reader::default();
        reader.read(file.path(), "own").unwrap();
        assert_eq!(reader.state.snapshot().turn_count, Some(1));
        writeln!(file, r#"{{"type":"other","#).unwrap();
        reader.read(file.path(), "own").unwrap();
        assert_eq!(reader.state.snapshot().turn_count, None);
    }

    fn assert_reader_snapshot(reader: &Reader, file: &File, total: u64, turns: u64, id: &str) {
        let snapshot = reader.state.snapshot();
        assert_eq!(snapshot.total_tokens, Some(total));
        assert_eq!(snapshot.turn_count, Some(turns));
        assert_eq!(snapshot.last_turn.unwrap().id, id);
        assert_eq!(reader.offset, file.metadata().unwrap().len());
    }

    #[test]
    fn append_reader_preserves_stats_across_large_buffered_content() {
        use serde_json::json;
        use std::io::Write;

        let mut file = tempfile::NamedTempFile::new().unwrap();
        let start = |id, second| json!({"timestamp":format!("2026-10-28T00:00:{second:02}Z"),"type":"event_msg","payload":{"type":"task_started","turn_id":id}});
        writeln!(file, "{}", start("large", 0)).unwrap();
        let content = json!({"timestamp":"2026-10-28T00:00:01Z","type":"response_item","payload":{"type":"function_call_output","output":"tool output 中文 ".repeat(8192)}});
        for _ in 0..100 {
            writeln!(file, "{content}").unwrap();
        }
        writeln!(file, "{}", json!({"timestamp":"2026-10-28T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":123}}}})).unwrap();
        let mut reader = Reader::default();
        reader.read(file.path(), "own").unwrap();
        assert_reader_snapshot(&reader, file.as_file(), 123, 1, "large");

        // 大行后的短记录和后续追加都必须独立解析，重复读取不能增加轮数。
        writeln!(file, "{}", start("next", 3)).unwrap();
        reader.read(file.path(), "own").unwrap();
        reader.read(file.path(), "own").unwrap();
        assert_reader_snapshot(&reader, file.as_file(), 123, 2, "next");
    }

    struct Counted {
        file: Cursor<Vec<u8>>,
        bytes: usize,
    }

    impl Read for Counted {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self.file.read(buffer)?;
            self.bytes += count;
            Ok(count)
        }
    }

    impl Seek for Counted {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.file.seek(position)
        }
    }

    #[test]
    fn conversation_stats_rewrite_check_reads_at_most_68_kib() {
        for size in [100_000, 10_000_000] {
            let mut file = Counted {
                file: Cursor::new(vec![b'x'; size]),
                bytes: 0,
            };
            boundary_digest(&mut file, size as u64).unwrap();
            assert_eq!(file.bytes, (HEAD_BYTES + TAIL_BYTES) as usize);
        }
    }
}
