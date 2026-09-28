use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result};
use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;

const INITIAL_TAIL_BYTES: u64 = 256 * 1024;
/// A turn can append large tool outputs after its last `token_count`; past this
/// window the answer is reported as unknown rather than scanning the whole file.
const MAX_TAIL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastTokenUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastModelRequest {
    /// Unix milliseconds of the rollout line recording the latest model response.
    pub requested_at: i64,
    pub last_token_usage: LastTokenUsage,
    /// Lets the page tell a rollout that is ahead of its notification (a turn
    /// sent from another window) from one that has not caught up yet.
    pub thread_total_tokens: Option<u64>,
}

/// Finds the latest `token_count` event with usage in a rollout. Codex appends
/// to the file while it is open, so only the tail is read and a torn final line
/// is skipped instead of failing the read.
pub(crate) fn last_model_request(path: &Path) -> Result<Option<LastModelRequest>> {
    let mut file =
        File::open(path).with_context(|| format!("打开会话记录失败：{}", path.display()))?;
    let len = file
        .seek(SeekFrom::End(0))
        .with_context(|| format!("读取会话记录长度失败：{}", path.display()))?;
    let mut window = INITIAL_TAIL_BYTES;
    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity((len - start) as usize);
        file.by_ref()
            .take(len - start)
            .read_to_end(&mut bytes)
            .with_context(|| format!("读取会话记录失败：{}", path.display()))?;
        if let Some(request) = last_model_request_in(&bytes, start > 0) {
            return Ok(Some(request));
        }
        if start == 0 || window >= MAX_TAIL_BYTES {
            return Ok(None);
        }
        window = (window * 2).min(MAX_TAIL_BYTES);
    }
}

fn last_model_request_in(bytes: &[u8], starts_mid_line: bool) -> Option<LastModelRequest> {
    let mut lines = bytes.split(|byte| *byte == b'\n');
    if starts_mid_line {
        lines.next();
    }
    lines
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find_map(model_request_from_line)
}

fn model_request_from_line(line: &[u8]) -> Option<LastModelRequest> {
    let record = serde_json::from_slice::<Value>(line).ok()?;
    if record.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    let payload = record.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let info = payload.get("info")?;
    let usage = info.get("last_token_usage")?;
    if !usage.is_object() {
        return None;
    }
    let requested_at = DateTime::parse_from_rfc3339(record.get("timestamp")?.as_str()?)
        .ok()?
        .timestamp_millis();
    Some(LastModelRequest {
        requested_at,
        last_token_usage: LastTokenUsage {
            input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
            cached_input_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64),
            output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
        },
        thread_total_tokens: info
            .get("total_token_usage")
            .and_then(|total| total.get("total_tokens"))
            .and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn token_count(timestamp: &str, input: u64) -> String {
        format!(
            "{{\"timestamp\":\"{timestamp}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"last_token_usage\":{{\"input_tokens\":{input},\"cached_input_tokens\":7,\"output_tokens\":3}},\"total_token_usage\":{{\"total_tokens\":{total}}}}}}}}}\n",
            total = input * 10
        )
    }

    fn write_rollout(contents: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        file
    }

    #[test]
    fn returns_the_latest_token_count_with_usage() {
        let rollout = write_rollout(&format!(
            "{}{}{}{}",
            token_count("2026-09-28T07:49:18.540Z", 10),
            token_count("2026-09-28T07:49:26.019Z", 20),
            "{\"timestamp\":\"2026-09-28T07:49:27.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null}}\n",
            "{\"timestamp\":\"2026-09-28T07:49:28.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
        ));
        let request = last_model_request(rollout.path()).unwrap().unwrap();
        assert_eq!(request.requested_at, 1_790_581_766_019);
        assert_eq!(
            request.last_token_usage,
            LastTokenUsage {
                input_tokens: Some(20),
                cached_input_tokens: Some(7),
                output_tokens: Some(3),
            }
        );
        assert_eq!(request.thread_total_tokens, Some(200));
    }

    #[test]
    fn serializes_the_shape_the_composer_chip_reads() {
        let request = LastModelRequest {
            requested_at: 1_790_581_766_019,
            last_token_usage: LastTokenUsage {
                input_tokens: Some(20),
                cached_input_tokens: None,
                output_tokens: Some(3),
            },
            thread_total_tokens: Some(200),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "requestedAt": 1_790_581_766_019_i64,
                "lastTokenUsage": {
                    "inputTokens": 20,
                    "cachedInputTokens": null,
                    "outputTokens": 3,
                },
                "threadTotalTokens": 200,
            })
        );
    }

    #[test]
    fn skips_a_torn_final_line() {
        let complete = token_count("2026-09-28T07:49:18.540Z", 10);
        let next = token_count("2026-09-28T07:49:26.019Z", 20);
        let rollout = write_rollout(&format!("{complete}{}", &next[..next.len() / 2]));
        let request = last_model_request(rollout.path()).unwrap().unwrap();
        assert_eq!(request.last_token_usage.input_tokens, Some(10));
    }

    #[test]
    fn widens_the_tail_past_large_trailing_records() {
        let filler = format!(
            "{{\"type\":\"response_item\",\"payload\":{{\"output\":\"{}\"}}}}\n",
            "x".repeat(INITIAL_TAIL_BYTES as usize * 3)
        );
        let rollout = write_rollout(&format!(
            "{}{filler}",
            token_count("2026-09-28T07:49:18.540Z", 10)
        ));
        let request = last_model_request(rollout.path()).unwrap().unwrap();
        assert_eq!(request.last_token_usage.input_tokens, Some(10));
    }

    #[test]
    fn reports_none_without_token_usage() {
        let rollout = write_rollout(
            "{\"timestamp\":\"2026-09-28T07:49:09.471Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        );
        assert_eq!(last_model_request(rollout.path()).unwrap(), None);
    }
}
