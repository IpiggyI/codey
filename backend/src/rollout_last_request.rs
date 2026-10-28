use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

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
    pub reasoning_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResponseWindow {
    pub started_at: i64,
    pub ended_at: i64,
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
    pub session_started_at: Option<i64>,
    pub response_window: Option<ResponseWindow>,
    pub turn_reasoning_output_tokens: Option<u64>,
    pub compaction_count: Option<u64>,
}

#[derive(Default)]
struct RolloutSummary {
    scanned_bytes: u64,
    fingerprint: Sha256,
    compaction_count: u64,
    session_meta_seen: bool,
    session_started_at: Option<i64>,
}

fn rollout_summary(file: &mut File, len: u64, path: &Path) -> Result<(Option<i64>, u64)> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, RolloutSummary>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("会话记录统计缓存锁已损坏"))?;
    let summary = cache.entry(path.to_path_buf()).or_default();
    if len < summary.scanned_bytes || !prefix_matches(file, summary)? {
        *summary = RolloutSummary::default();
    }
    file.seek(SeekFrom::Start(summary.scanned_bytes))?;
    let mut reader = BufReader::new(file.take(len - summary.scanned_bytes));
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        if !line.ends_with(b"\n") {
            break;
        }
        summary.scanned_bytes += line.len() as u64;
        summary.fingerprint.update(&line);
        summary.observe(&line);
        line.clear();
    }
    Ok((summary.session_started_at, summary.compaction_count))
}

fn prefix_matches(file: &mut File, summary: &RolloutSummary) -> Result<bool> {
    // Validate all counted bytes so in-place rewrites cannot preserve a stale count.
    // Only appended complete lines are parsed again after this fingerprint check.
    file.seek(SeekFrom::Start(0))?;
    let mut prefix = file.take(summary.scanned_bytes);
    let mut fingerprint = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = prefix.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        fingerprint.update(&buffer[..read]);
    }
    Ok(prefix.limit() == 0 && fingerprint.finalize() == summary.fingerprint.clone().finalize())
}

impl RolloutSummary {
    fn observe(&mut self, line: &[u8]) {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("compacted") => self.compaction_count += 1,
            Some("session_meta") if !self.session_meta_seen => {
                self.session_meta_seen = true;
                self.session_started_at = record
                    .get("payload")
                    .and_then(|payload| timestamp(payload.get("timestamp")))
                    .or_else(|| timestamp(record.get("timestamp")));
            }
            _ => {}
        }
    }
}

/// Finds the latest `token_count` with usage in a bounded tail, alongside cached
/// whole-file session metadata and compaction counts. Torn JSON is skipped.
pub(crate) fn last_model_request(path: &Path) -> Result<Option<LastModelRequest>> {
    let mut file =
        File::open(path).with_context(|| format!("打开会话记录失败：{}", path.display()))?;
    let len = file
        .seek(SeekFrom::End(0))
        .with_context(|| format!("读取会话记录长度失败：{}", path.display()))?;
    let (session_started_at, compaction_count) = rollout_summary(&mut file, len, path)
        .with_context(|| format!("统计会话记录失败：{}", path.display()))?;
    let mut window = INITIAL_TAIL_BYTES;
    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity((len - start) as usize);
        file.by_ref()
            .take(len - start)
            .read_to_end(&mut bytes)
            .with_context(|| format!("读取会话记录失败：{}", path.display()))?;
        if let Some(mut request) = last_model_request_in(&bytes, start > 0) {
            request.session_started_at = session_started_at;
            request.compaction_count = Some(compaction_count);
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
    let mut window = RequestWindow::default();
    let mut latest = None;
    for line in lines {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if record["type"] == "event_msg" && record["payload"]["type"] == "token_count" {
            if let Some(mut request) = model_request_from_record(&record) {
                request.response_window = window.response_window();
                request.turn_reasoning_output_tokens = window.turn_reasoning;
                latest = Some(request);
            }
            window = RequestWindow {
                previous_token_at: timestamp(record.get("timestamp")),
                ..RequestWindow::default()
            };
        } else {
            window.observe(&record);
        }
    }
    latest
}

#[derive(Default)]
pub(crate) struct RequestWindow {
    previous_token_at: Option<i64>,
    input_at: Option<i64>,
    started_at: Option<i64>,
    output_at: Option<i64>,
    usage_at: Option<i64>,
    has_output: bool,
    has_usage: bool,
    pub(crate) turn_reasoning: Option<u64>,
}

impl RequestWindow {
    pub(crate) fn after_usage(previous_token_at: Option<i64>) -> Self {
        Self {
            previous_token_at,
            ..Self::default()
        }
    }

    pub(crate) fn observe(&mut self, record: &Value) {
        let time = timestamp(record.get("timestamp"));
        if is_input_event(record) {
            self.input_at = time;
        } else if record["type"] == "response_item" {
            if !self.has_output {
                self.started_at = self
                    .previous_token_at
                    .into_iter()
                    .chain(self.input_at)
                    .max();
            }
            self.has_output = true;
            self.output_at = time;
        } else if record["type"] == "token_usage_record" {
            self.has_usage = true;
            self.usage_at = time;
            self.turn_reasoning =
                record["payload"]["turn_token_usage"]["reasoning_output_tokens"].as_u64();
        }
    }

    fn response_window(&self) -> Option<ResponseWindow> {
        self.recorded_window()
            .filter(|window| window.ended_at > window.started_at)
    }

    pub(crate) fn recorded_window(&self) -> Option<ResponseWindow> {
        if !self.has_output {
            return None;
        }
        let started_at = self.started_at?;
        let ended_at = if self.has_usage {
            self.usage_at?
        } else {
            self.output_at?
        };
        (ended_at >= started_at).then_some(ResponseWindow {
            started_at,
            ended_at,
        })
    }
}

pub(crate) fn is_input_event(record: &Value) -> bool {
    let payload = &record["payload"];
    match record["type"].as_str() {
        Some("turn_context") => true,
        Some("event_msg") => matches!(
            payload["type"].as_str(),
            Some("user_message" | "task_started")
        ),
        Some("response_item") => {
            matches!(
                payload["type"].as_str(),
                Some("function_call_output" | "custom_tool_call_output")
            ) || (payload["type"] == "message"
                && matches!(
                    payload["role"].as_str(),
                    Some("user" | "developer" | "system")
                ))
        }
        _ => false,
    }
}

pub(crate) fn timestamp(value: Option<&Value>) -> Option<i64> {
    DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn model_request_from_record(record: &Value) -> Option<LastModelRequest> {
    let info = record.get("payload")?.get("info")?;
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
            reasoning_output_tokens: usage.get("reasoning_output_tokens").and_then(Value::as_u64),
        },
        thread_total_tokens: info
            .get("total_token_usage")
            .and_then(|total| total.get("total_tokens"))
            .and_then(Value::as_u64),
        session_started_at: None,
        response_window: None,
        turn_reasoning_output_tokens: None,
        compaction_count: None,
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
                reasoning_output_tokens: None,
            }
        );
        assert_eq!(request.thread_total_tokens, Some(200));
        assert_eq!(request.compaction_count, Some(0));
    }

    #[test]
    fn serializes_the_shape_the_composer_chip_reads() {
        let request = LastModelRequest {
            requested_at: 1_790_581_766_019,
            last_token_usage: LastTokenUsage {
                input_tokens: Some(20),
                cached_input_tokens: None,
                output_tokens: Some(3),
                reasoning_output_tokens: None,
            },
            thread_total_tokens: Some(200),
            session_started_at: None,
            response_window: None,
            turn_reasoning_output_tokens: None,
            compaction_count: None,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "requestedAt": 1_790_581_766_019_i64,
                "lastTokenUsage": {
                    "inputTokens": 20,
                    "cachedInputTokens": null,
                    "outputTokens": 3,
                    "reasoningOutputTokens": null,
                },
                "threadTotalTokens": 200,
                "sessionStartedAt": null,
                "responseWindow": null,
                "turnReasoningOutputTokens": null,
                "compactionCount": null,
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

    fn record(second: u8, kind: &str, payload: Value) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": format!("2026-09-28T07:49:{second:02}.000Z"),
                "type": kind,
                "payload": payload,
            })
        )
    }

    fn output(second: u8) -> String {
        record(
            second,
            "response_item",
            serde_json::json!({"type":"reasoning"}),
        )
    }

    fn usage(second: u8, reasoning: u64) -> String {
        record(
            second,
            "token_usage_record",
            serde_json::json!({
                "usage": {"reasoning_output_tokens": 4},
                "turn_token_usage": {"reasoning_output_tokens": reasoning},
            }),
        )
    }

    fn request(contents: &str) -> LastModelRequest {
        let rollout = write_rollout(contents);
        last_model_request(rollout.path()).unwrap().unwrap()
    }

    fn window(start: u8, end: u8) -> Option<ResponseWindow> {
        let time = |second| {
            timestamp(Some(&Value::String(format!(
                "2026-09-28T07:49:{second:02}.000Z"
            ))))
            .unwrap()
        };
        Some(ResponseWindow {
            started_at: time(start),
            ended_at: time(end),
        })
    }

    #[test]
    fn session_start_uses_first_meta_payload_then_line_timestamp() {
        let count = token_count("2026-09-28T07:49:18.540Z", 10);
        let meta = record(
            1,
            "session_meta",
            serde_json::json!({
                "timestamp": "2026-09-28T07:49:00.000Z"
            }),
        );
        let later_meta = record(2, "session_meta", serde_json::json!({}));
        assert_eq!(
            request(&format!("{meta}{later_meta}{count}")).session_started_at,
            Some(1_790_581_740_000)
        );
        assert_eq!(
            request(&format!("{later_meta}{count}")).session_started_at,
            Some(1_790_581_742_000)
        );
        assert_eq!(request(&count).session_started_at, None);
    }

    #[test]
    fn single_request_uses_usage_record_end_and_turn_reasoning() {
        let count = token_count("2026-09-28T07:49:18.540Z", 10).replace(
            "\"output_tokens\":3",
            "\"output_tokens\":3,\"reasoning_output_tokens\":2",
        );
        let result = request(&format!(
            "{}{}{}{}{}{}",
            record(1, "event_msg", serde_json::json!({"type":"user_message"})),
            record(2, "turn_context", serde_json::json!({})),
            output(3),
            usage(5, 123),
            output(6),
            count
        ));
        assert_eq!(result.response_window, window(2, 5));
        assert_eq!(result.turn_reasoning_output_tokens, Some(123));
        assert_eq!(result.last_token_usage.reasoning_output_tokens, Some(2));
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["responseWindow"]["startedAt"], 1_790_581_742_000_i64);
        assert_eq!(value["responseWindow"]["endedAt"], 1_790_581_745_000_i64);
        assert_eq!(value["turnReasoningOutputTokens"], 123);
        assert_eq!(value["lastTokenUsage"]["reasoningOutputTokens"], 2);
    }

    #[test]
    fn back_to_back_requests_reset_window_and_reasoning_at_every_token_count() {
        let first = format!(
            "{}{}{}{}",
            record(1, "turn_context", serde_json::json!({})),
            output(2),
            usage(3, 11),
            token_count("2026-09-28T07:49:04.000Z", 10)
        );
        let second = token_count("2026-09-28T07:49:09.000Z", 20);
        let result = request(&format!("{first}{}{second}", output(8)));
        assert_eq!(result.response_window, window(4, 8));
        assert_eq!(result.turn_reasoning_output_tokens, None);
        assert_eq!(result.last_token_usage.input_tokens, Some(20));
        let no_usage = record(
            6,
            "event_msg",
            serde_json::json!({"type":"token_count","info":null}),
        );
        let result = request(&format!("{first}{no_usage}{}{second}", output(8)));
        assert_eq!(result.response_window, window(6, 8));
    }

    #[test]
    fn window_uses_later_of_previous_count_and_last_input_before_output() {
        for (input, expected_start) in [(2, 4), (5, 5)] {
            let result = request(&format!(
                "{}{}{}{}{}{}",
                token_count("2026-09-28T07:49:04.000Z", 10),
                record(input, "turn_context", serde_json::json!({})),
                output(6),
                record(
                    7,
                    "response_item",
                    serde_json::json!({"type":"function_call_output"})
                ),
                output(8),
                token_count("2026-09-28T07:49:09.000Z", 20)
            ));
            assert_eq!(result.response_window, window(expected_start, 8));
        }
    }

    #[test]
    fn all_input_events_can_start_a_request() {
        let inputs = [
            ("event_msg", serde_json::json!({"type":"user_message"})),
            ("event_msg", serde_json::json!({"type":"task_started"})),
            ("turn_context", serde_json::json!({})),
            (
                "response_item",
                serde_json::json!({"type":"function_call_output"}),
            ),
            (
                "response_item",
                serde_json::json!({"type":"custom_tool_call_output"}),
            ),
            (
                "response_item",
                serde_json::json!({"type":"message","role":"user"}),
            ),
            (
                "response_item",
                serde_json::json!({"type":"message","role":"developer"}),
            ),
            (
                "response_item",
                serde_json::json!({"type":"message","role":"system"}),
            ),
        ];
        for (kind, payload) in inputs {
            let result = request(&format!(
                "{}{}{}",
                record(1, kind, payload),
                output(3),
                token_count("2026-09-28T07:49:04.000Z", 10)
            ));
            assert_eq!(result.response_window, window(1, 3), "{kind}");
        }
    }

    #[test]
    fn window_and_reasoning_stay_with_latest_usage_despite_newer_incomplete_request() {
        let result = request(&format!(
            "{}{}{}{}{}{}{}{}",
            record(1, "turn_context", serde_json::json!({})),
            output(2),
            usage(3, 11),
            token_count("2026-09-28T07:49:04.000Z", 10),
            record(5, "turn_context", serde_json::json!({})),
            output(6),
            usage(7, 99),
            record(
                8,
                "event_msg",
                serde_json::json!({"type":"token_count","info":null})
            )
        ));
        assert_eq!(result.response_window, window(1, 3));
        assert_eq!(result.turn_reasoning_output_tokens, Some(11));
        assert_eq!(result.last_token_usage.input_tokens, Some(10));
    }

    #[test]
    fn missing_start_or_nonpositive_window_returns_null() {
        let count = token_count("2026-09-28T07:49:09.000Z", 10);
        assert_eq!(
            request(&format!("{}{count}", output(8))).response_window,
            None
        );
        for end in [1, 2] {
            assert_eq!(
                request(&format!(
                    "{}{}{count}",
                    record(2, "turn_context", serde_json::json!({})),
                    output(end)
                ))
                .response_window,
                None
            );
        }
    }

    #[test]
    fn start_outside_tail_is_null_but_session_start_is_read_from_head() {
        let filler = record(
            3,
            "event_msg",
            serde_json::json!({
                "type":"agent_reasoning", "text":"x".repeat(INITIAL_TAIL_BYTES as usize)
            }),
        );
        let result = request(&format!(
            "{}{}{filler}{}{}",
            record(0, "session_meta", serde_json::json!({})),
            record(1, "turn_context", serde_json::json!({})),
            output(8),
            token_count("2026-09-28T07:49:09.000Z", 10)
        ));
        assert_eq!(result.response_window, None);
        assert_eq!(result.session_started_at, Some(1_790_581_740_000));
    }

    #[test]
    fn compaction_count_scans_whole_file_and_only_complete_top_level_records() {
        let compacted = record(1, "compacted", serde_json::json!({}));
        let nested = record(2, "event_msg", serde_json::json!({"type":"compacted"}));
        let filler = record(
            3,
            "event_msg",
            serde_json::json!({"text":"x".repeat(INITIAL_TAIL_BYTES as usize)}),
        );
        let count = token_count("2026-09-28T07:49:09.000Z", 10);
        let mut rollout = write_rollout(&format!("{compacted}{nested}{filler}{count}"));
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(1)
        );
        rollout.write_all(compacted.trim_end().as_bytes()).unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(1)
        );
        rollout.write_all(b"\n").unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(2)
        );
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(2)
        );
    }

    #[test]
    fn compaction_count_recounts_shorter_equal_and_longer_rewrites() {
        let compacted = record(1, "compacted", serde_json::json!({}));
        let count = token_count("2026-09-28T07:49:09.000Z", 10);
        let mut rollout = write_rollout(&format!("{compacted}{compacted}{count}"));
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(2)
        );
        let shorter = format!("{compacted}{count}");
        std::fs::write(rollout.path(), &shorter).unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(1)
        );
        let same_length = shorter.replace("compacted", "untouched");
        assert_eq!(same_length.len(), shorter.len());
        std::fs::write(rollout.path(), &same_length).unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(0)
        );
        std::fs::write(rollout.path(), format!("{compacted}{compacted}{count}")).unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(2)
        );
        rollout.seek(SeekFrom::End(0)).unwrap();
        rollout.write_all(compacted.as_bytes()).unwrap();
        assert_eq!(
            last_model_request(rollout.path())
                .unwrap()
                .unwrap()
                .compaction_count,
            Some(3)
        );
    }
}
