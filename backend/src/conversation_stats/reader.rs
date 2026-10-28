use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::{ConversationStatsSnapshot, state::State};

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const HEAD_BYTES: u64 = 4 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<(PathBuf, String, Reader)>,
}

impl Cache {
    pub fn read(&mut self, path: &Path, session_id: &str) -> Result<ConversationStatsSnapshot> {
        let index = self
            .entries
            .iter()
            .position(|(cached, id, _)| cached == path && id == session_id);
        let mut entry = index
            .and_then(|index| self.entries.remove(index))
            .unwrap_or_else(|| (path.to_owned(), session_id.to_owned(), Reader::default()));
        entry
            .2
            .read(path, session_id)
            .with_context(|| format!("读取对话用量失败：{}", path.display()))?;
        let snapshot = entry.2.state.snapshot();
        self.entries.push_back(entry);
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
    version: Option<(u64, Option<SystemTime>)>,
    state: State,
}

impl Reader {
    fn read(&mut self, path: &Path, session_id: &str) -> Result<()> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        let len = metadata.len();
        let modified = metadata.modified().ok();
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

    fn read_append(&mut self, file: &mut File, len: u64, session_id: &str) -> Result<()> {
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file.take(len - self.offset));
        loop {
            let mut line = Vec::new();
            let mut consumed = 0u64;
            let mut oversized = false;
            loop {
                let buffer = reader.fill_buf()?;
                if buffer.is_empty() {
                    return Ok(());
                }
                let end = buffer.iter().position(|byte| *byte == b'\n');
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
            if oversized {
                self.state.mark_partial();
            } else if let Ok(record) = serde_json::from_slice(&line) {
                self.state.observe(&record, session_id);
            } else {
                self.state.mark_partial();
            }
        }
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
