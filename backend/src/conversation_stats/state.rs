use std::collections::{HashSet, VecDeque};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::rollout_last_request::{
    LastModelRequest, LastTokenUsage, RequestWindow, ResponseWindow, is_input_event, timestamp,
};
use crate::session_metadata::normalize_session_id;

use super::{ConversationStatsSnapshot, LastTurnStatsSnapshot, speed, tools::ToolTiming};

pub(super) const MAX_ITEMS: usize = 2048;
const MAX_RECORDS: usize = 4096;

pub(super) fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[derive(Default)]
struct Sample {
    output: Option<u64>,
    duration: Option<u64>,
}

#[derive(Default)]
struct Turn {
    snapshot: LastTurnStatsSnapshot,
    samples: Vec<Sample>,
    responses: HashSet<[u8; 32]>,
    tools: ToolTiming,
    partial: bool,
}

impl Turn {
    fn snapshot(&self) -> LastTurnStatsSnapshot {
        let mut result = self.snapshot.clone();
        result.step_count = (!self.partial).then_some(self.samples.len() as u64);
        let complete = !self.partial && !self.samples.is_empty();
        result.model_duration_ms = complete
            .then(|| {
                self.samples
                    .iter()
                    .try_fold(0u64, |sum, sample| sum.checked_add(sample.duration?))
            })
            .flatten();
        let output = self
            .samples
            .iter()
            .try_fold(0u64, |sum, sample| sum.checked_add(sample.output?));
        result.average_output_tokens_per_second = speed(output, result.model_duration_ms);
        result.tool_duration_ms = (!self.partial)
            .then(|| {
                self.tools
                    .duration(result.started_at_unix_ms, result.completed_at_unix_ms)
            })
            .flatten();
        result.coverage = if self.partial
            || result.model_duration_ms.is_none()
            || result.tool_duration_ms.is_none()
        {
            "partial"
        } else {
            "recorded"
        };
        result
    }

    fn belongs(&self, record: &Value) -> bool {
        if let Some(id) = record["payload"]["turn_id"].as_str() {
            return id == self.snapshot.id;
        }
        timestamp(record.get("timestamp"))
            .zip(self.snapshot.started_at_unix_ms)
            .is_some_and(|(time, start)| {
                time >= start
                    && self
                        .snapshot
                        .completed_at_unix_ms
                        .is_none_or(|end| time <= end)
            })
    }
}

#[derive(Default)]
pub(super) struct State {
    snapshot: ConversationStatsSnapshot,
    turn: Option<Turn>,
    window: RequestWindow,
    pending_native: Option<usize>,
    pending_window: Option<ResponseWindow>,
    own_segment: Option<bool>,
    recent: VecDeque<([u8; 32], Option<i64>)>,
    seen: HashSet<[u8; 32]>,
    retired_through: Option<i64>,
    retired_unknown: bool,
    turns: VecDeque<[u8; 32]>,
    count: u64,
    count_unknown: bool,
    session_started_at: Option<i64>,
    compactions: u64,
}

impl State {
    pub fn snapshot(&self) -> ConversationStatsSnapshot {
        let mut result = self.snapshot.clone();
        result.last_turn = self.turn.as_ref().map(Turn::snapshot);
        result.turn_count = (!self.count_unknown && self.count > 0).then_some(self.count);
        result.activity_source = result.turn_count.map(|_| "rollout");
        result.activity_scope = result.turn_count.map(|_| "session");
        if result.usage_source.is_empty() {
            result.usage_source = "unknown";
            result.usage_scope = "unknown";
        }
        if let Some(request) = &mut result.last_model_request {
            request.session_started_at = self.session_started_at;
            request.compaction_count = Some(self.compactions);
        }
        result
    }

    pub fn mark_partial(&mut self) {
        self.count_unknown = true;
        if let Some(turn) = &mut self.turn {
            turn.partial = true;
        }
    }

    fn remember(&mut self, record: &Value) -> bool {
        let key = digest(record.to_string().as_bytes());
        if self.seen.contains(&key) {
            return false;
        }
        let time = timestamp(record.get("timestamp"));
        if self.retired_unknown
            || self
                .retired_through
                .is_some_and(|old| time.is_none_or(|time| time <= old))
        {
            self.mark_partial();
            return false;
        }
        self.seen.insert(key);
        self.recent.push_back((key, time));
        if self.recent.len() > MAX_RECORDS {
            let (key, time) = self.recent.pop_front().expect("存在已缓存记录");
            self.seen.remove(&key);
            if let Some(time) = time {
                self.retired_through = Some(self.retired_through.map_or(time, |old| old.max(time)));
            } else {
                self.retired_unknown = true;
            }
        }
        true
    }

    pub fn observe(&mut self, record: &Value, session_id: &str) {
        let payload = &record["payload"];
        if record["type"] == "session_meta" {
            if let Some(id) = payload["id"]
                .as_str()
                .or_else(|| payload["session_id"].as_str())
            {
                self.own_segment = Some(normalize_session_id(id).eq_ignore_ascii_case(session_id));
            }
            if self.own_segment == Some(true) && self.session_started_at.is_none() {
                self.session_started_at = timestamp(payload.get("timestamp"))
                    .or_else(|| timestamp(record.get("timestamp")));
            }
            return;
        }
        if self.own_segment == Some(false)
            || ["session_id", "thread_id"].iter().any(|key| {
                payload[*key]
                    .as_str()
                    .is_some_and(|id| !normalize_session_id(id).eq_ignore_ascii_case(session_id))
            })
            || !self.remember(record)
        {
            return;
        }
        let time = timestamp(record.get("timestamp"));
        if record["type"] == "compacted" {
            self.compactions = self.compactions.saturating_add(1);
        }
        if record["type"] == "event_msg" && payload["type"] == "task_started" {
            let previous_count = self.count;
            self.start_turn(payload, time);
            if self.count != previous_count {
                self.window.observe(record);
            }
            return;
        }
        if let Some(turn) = &self.turn {
            if payload["turn_id"]
                .as_str()
                .is_some_and(|id| id != turn.snapshot.id)
            {
                return;
            }
            if record["type"] == "token_usage_record"
                && payload["response_id"]
                    .as_str()
                    .is_some_and(|id| turn.responses.contains(&digest(id.as_bytes())))
            {
                return;
            }
        }
        self.update_usage(record);
        let Some(turn) = &self.turn else { return };
        if !turn.belongs(record) {
            if payload["turn_id"].is_null() && time.is_none() {
                self.mark_partial();
            }
            return;
        }
        if record["type"] == "token_usage_record" {
            self.native_request(record);
        } else if record["type"] == "event_msg" && payload["type"] == "token_count" {
            self.token_count(record);
        } else {
            self.window.observe(record);
            let turn = self.turn.as_mut().expect("已检查轮次");
            turn.tools.observe(record, time);
            if record["type"] == "event_msg"
                && matches!(
                    payload["type"].as_str(),
                    Some("task_complete" | "turn_aborted")
                )
            {
                turn.snapshot.completed_at_unix_ms = time.filter(|end| {
                    turn.snapshot
                        .started_at_unix_ms
                        .is_none_or(|start| *end >= start)
                });
                turn.snapshot.status = if payload["type"] == "turn_aborted" {
                    "aborted"
                } else {
                    "completed"
                };
            }
            if record["type"] == "response_item"
                && !is_input_event(record)
                && self.pending_native.is_some()
            {
                // 缺少 token_count 的记录格式，下一次输出仍从上一用量边界计时。
                self.pending_native = None;
            }
        }
    }

    fn start_turn(&mut self, payload: &Value, time: Option<i64>) {
        let Some(id) = payload["turn_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
        else {
            self.mark_partial();
            self.turn = None;
            return;
        };
        let key = digest(id.as_bytes());
        if self.turns.contains(&key) {
            return;
        }
        if self.turn.as_ref().is_some_and(|turn| {
            time.zip(turn.snapshot.started_at_unix_ms)
                .is_none_or(|(new, old)| new < old)
        }) {
            self.count_unknown = true;
            return;
        }
        self.turns.push_back(key);
        if self.turns.len() > 64 {
            self.turns.pop_front();
        }
        self.count = self.count.saturating_add(1);
        self.turn = Some(Turn {
            snapshot: LastTurnStatsSnapshot {
                id: id.to_owned(),
                started_at_unix_ms: time,
                status: "running",
                ..Default::default()
            },
            ..Default::default()
        });
        self.window = RequestWindow::default();
        self.pending_native = None;
        self.pending_window = None;
        self.snapshot.output_tokens_per_second = None;
        self.snapshot.speed_source = None;
        self.snapshot.speed_scope = None;
        self.snapshot.speed_recorded_at_unix_ms = None;
    }

    fn update_usage(&mut self, record: &Value) {
        let payload = &record["payload"];
        let usage = match record["type"].as_str() {
            Some("token_usage_record") => &payload["thread_token_usage"],
            Some("event_msg") if payload["type"] == "token_count" => {
                &payload["info"]["total_token_usage"]
            }
            _ => return,
        };
        if !usage.is_object() {
            return;
        }
        let snapshot = &mut self.snapshot;
        snapshot.input_tokens = usage["input_tokens"].as_u64();
        snapshot.output_tokens = usage["output_tokens"].as_u64();
        snapshot.cached_input_tokens = usage["cached_input_tokens"].as_u64();
        snapshot.cache_write_input_tokens = usage["cache_write_input_tokens"].as_u64();
        snapshot.total_tokens = usage["total_tokens"]
            .as_u64()
            .or_else(|| snapshot.input_tokens?.checked_add(snapshot.output_tokens?));
        snapshot.updated_at_unix_ms = timestamp(record.get("timestamp"));
        snapshot.usage_source = "rollout";
        snapshot.usage_scope = "session";
    }

    fn native_request(&mut self, record: &Value) {
        let payload = &record["payload"];
        let turn = self.turn.as_mut().expect("已检查轮次");
        self.window.observe(record);
        turn.snapshot.turn_reasoning_output_tokens = self.window.turn_reasoning;
        let Some(id) = payload["response_id"].as_str().filter(|id| !id.is_empty()) else {
            turn.partial = true;
            return;
        };
        if !turn.responses.insert(digest(id.as_bytes())) {
            return;
        }
        if turn.responses.len() > MAX_ITEMS {
            turn.partial = true;
            turn.responses.clear();
            return;
        }
        self.save_request(&payload["usage"], timestamp(record.get("timestamp")), None);
        self.pending_native = self
            .turn
            .as_ref()
            .and_then(|turn| turn.samples.len().checked_sub(1));
        self.pending_window = self.window.recorded_window();
        self.window = RequestWindow::after_usage(timestamp(record.get("timestamp")));
    }

    fn token_count(&mut self, record: &Value) {
        let usage = &record["payload"]["info"]["last_token_usage"];
        if usage.is_object() {
            self.save_request(
                usage,
                timestamp(record.get("timestamp")),
                self.pending_native,
            );
        }
        self.pending_native = None;
        self.pending_window = None;
        self.window = RequestWindow::after_usage(timestamp(record.get("timestamp")));
    }

    fn save_request(&mut self, usage: &Value, time: Option<i64>, replace: Option<usize>) {
        let window = if replace.is_some() {
            self.pending_window.clone()
        } else {
            self.window.recorded_window()
        };
        let duration = window
            .as_ref()
            .and_then(|window| u64::try_from(window.ended_at - window.started_at).ok());
        let output = usage["output_tokens"].as_u64();
        let turn = self.turn.as_mut().expect("已检查轮次");
        if let Some(index) = replace {
            turn.samples[index] = Sample { output, duration };
        } else if turn.samples.len() < MAX_ITEMS {
            turn.samples.push(Sample { output, duration });
        } else {
            turn.partial = true;
        }
        self.snapshot.output_tokens_per_second = speed(output, duration);
        self.snapshot.speed_source = Some("rollout");
        self.snapshot.speed_scope = Some("latest_recorded_request");
        self.snapshot.speed_recorded_at_unix_ms = time;
        self.snapshot.last_model_request = time.map(|requested_at| LastModelRequest {
            requested_at,
            last_token_usage: LastTokenUsage {
                input_tokens: usage["input_tokens"].as_u64(),
                cached_input_tokens: usage["cached_input_tokens"].as_u64(),
                output_tokens: output,
                reasoning_output_tokens: usage["reasoning_output_tokens"].as_u64(),
            },
            thread_total_tokens: self.snapshot.total_tokens,
            session_started_at: self.session_started_at,
            response_window: window.filter(|window| window.ended_at > window.started_at),
            turn_reasoning_output_tokens: turn.snapshot.turn_reasoning_output_tokens,
            compaction_count: Some(self.compactions),
        });
    }
}
