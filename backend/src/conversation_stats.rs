//! 对话用量只读取会话记录；缺少可靠边界的用时保持未知。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use serde::Serialize;

use crate::rollout_last_request::LastModelRequest;

mod reader;
mod state;
#[cfg(test)]
mod tests;
mod tools;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationStatsSnapshot {
    pub last_turn: Option<LastTurnStatsSnapshot>,
    pub output_tokens_per_second: Option<f64>,
    pub speed_source: Option<&'static str>,
    pub speed_scope: Option<&'static str>,
    pub speed_recorded_at_unix_ms: Option<i64>,
    pub speed_is_estimate: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub updated_at_unix_ms: Option<i64>,
    pub usage_source: &'static str,
    pub usage_scope: &'static str,
    pub turn_count: Option<u64>,
    pub activity_source: Option<&'static str>,
    pub activity_scope: Option<&'static str>,
    pub last_model_request: Option<LastModelRequest>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastTurnStatsSnapshot {
    pub id: String,
    pub started_at_unix_ms: Option<i64>,
    pub completed_at_unix_ms: Option<i64>,
    pub status: &'static str,
    pub step_count: Option<u64>,
    pub model_duration_ms: Option<u64>,
    pub tool_duration_ms: Option<u64>,
    pub average_output_tokens_per_second: Option<f64>,
    pub speed_is_estimate: bool,
    pub coverage: &'static str,
    pub turn_reasoning_output_tokens: Option<u64>,
}

pub(crate) fn snapshot(path: &Path, session_id: &str) -> Result<ConversationStatsSnapshot> {
    static CACHE: OnceLock<Mutex<reader::Cache>> = OnceLock::new();
    CACHE
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("对话用量缓存锁已损坏"))?
        .read(
            path,
            crate::session_metadata::normalize_session_id(session_id),
        )
}

fn speed(output: Option<u64>, duration: Option<u64>) -> Option<f64> {
    let duration = duration.filter(|duration| *duration > 0)?;
    Some(output? as f64 * 1000.0 / duration as f64)
}
