use std::collections::HashMap;

use serde_json::Value;

use super::state::{MAX_ITEMS, digest};

#[derive(Default)]
pub(super) struct ToolTiming {
    calls: HashMap<[u8; 32], (Option<i64>, Option<i64>)>,
    unreliable: bool,
}

impl ToolTiming {
    pub fn observe(&mut self, record: &Value, time: Option<i64>) {
        if record["type"] == "event_msg" {
            self.observe_item(&record["payload"], time);
            return;
        }
        if record["type"] != "response_item" {
            return;
        }
        let payload = &record["payload"];
        let is_start = match payload["type"].as_str() {
            Some("function_call" | "custom_tool_call") => true,
            Some("function_call_output" | "custom_tool_call_output") => false,
            Some("web_search_call" | "local_shell_call") => {
                self.unreliable = true;
                return;
            }
            _ => return,
        };
        let Some(id) = payload["call_id"].as_str().filter(|id| !id.is_empty()) else {
            self.unreliable = true;
            return;
        };
        let key = digest(id.as_bytes());
        if self.calls.len() >= MAX_ITEMS && !self.calls.contains_key(&key) {
            self.unreliable = true;
            return;
        }
        let pair = self.calls.entry(key).or_default();
        let endpoint = if is_start { &mut pair.0 } else { &mut pair.1 };
        if endpoint.is_some() && *endpoint != time {
            self.unreliable = true;
        }
        *endpoint = time;
        self.unreliable |= time.is_none();
    }

    fn observe_item(&mut self, payload: &Value, time: Option<i64>) {
        let item = &payload["item"];
        if !matches!(
            payload["type"].as_str(),
            Some("item_started" | "item_completed")
        ) || !matches!(
            item["type"].as_str(),
            Some(
                "McpToolCall"
                    | "CommandExecution"
                    | "CollabAgentToolCall"
                    | "FileChange"
                    | "WebSearch"
                    | "ImageGeneration"
                    | "DynamicToolCall"
            )
        ) {
            return;
        }
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else {
            self.unreliable = true;
            return;
        };
        let key = digest(id.as_bytes());
        if self.calls.len() >= MAX_ITEMS && !self.calls.contains_key(&key) {
            self.unreliable = true;
            return;
        }
        let pair = self.calls.entry(key).or_default();
        if payload["type"] == "item_started" {
            pair.0 = time;
        } else {
            pair.0 = pair.0.or_else(|| payload["started_at_ms"].as_i64());
            pair.1 = payload["completed_at_ms"].as_i64().or(time);
        }
    }

    pub fn duration(&self, turn_start: Option<i64>, turn_end: Option<i64>) -> Option<u64> {
        if self.unreliable {
            return None;
        }
        let turn_start = turn_start?;
        let mut intervals = self
            .calls
            .values()
            .map(|(start, end)| {
                let (start, end) = ((*start)?, (*end)?);
                (end >= start && start >= turn_start && turn_end.is_none_or(|limit| end <= limit))
                    .then_some((start, end))
            })
            .collect::<Option<Vec<_>>>()?;
        intervals.sort_unstable();
        let mut total = 0u64;
        let mut previous_end = i64::MIN;
        for (start, end) in intervals {
            let uncovered_start = start.max(previous_end);
            if end > uncovered_start {
                total = total.checked_add(u64::try_from(end - uncovered_start).ok()?)?;
            }
            previous_end = previous_end.max(end);
        }
        Some(total)
    }
}
