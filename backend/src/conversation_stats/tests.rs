use std::fs::{self, OpenOptions};
use std::io::Write;

use serde_json::{Value, json};

use super::*;

const SESSION: &str = "00000000-0000-0000-0000-000000000034";

fn record(second: u32, kind: &str, payload: Value) -> Value {
    json!({"timestamp":format!("2026-10-28T00:00:{second:02}Z"), "type":kind, "payload":payload})
}

fn start(second: u32, id: &str) -> Value {
    record(
        second,
        "event_msg",
        json!({"type":"task_started", "turn_id":id}),
    )
}

fn response(second: u32) -> Value {
    record(
        second,
        "response_item",
        json!({"type":"message", "role":"assistant", "content":[]}),
    )
}

fn usage(second: u32, id: &str, output: u64, total: u64) -> Value {
    record(
        second,
        "token_usage_record",
        json!({
            "session_id":SESSION, "turn_id":"one", "response_id":id,
            "usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":output},
            "turn_token_usage":{"reasoning_output_tokens":7},
            "thread_token_usage":{"input_tokens":total-output,"output_tokens":output,"total_tokens":total,"cached_input_tokens":50}
        }),
    )
}

fn count(second: u32, output: u64, total: u64) -> Value {
    record(
        second,
        "event_msg",
        json!({"type":"token_count", "info":{
            "last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":output},
            "total_token_usage":{"input_tokens":total-output,"output_tokens":output,"total_tokens":total,"cached_input_tokens":50}
        }}),
    )
}

fn write(path: &Path, records: &[Value]) {
    fs::write(
        path,
        records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>(),
    )
    .unwrap();
}

fn append(path: &Path, records: &[Value]) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
}

fn fixture() -> Vec<Value> {
    vec![
        record(0, "session_meta", json!({"id":SESSION})),
        start(1, "one"),
        response(2),
        usage(3, "a", 20, 120),
        count(3, 20, 120),
        record(
            5,
            "response_item",
            json!({"type":"function_call_output","call_id":"missing", "output":"done"}),
        ),
        response(6),
        usage(9, "b", 60, 280),
        count(9, 60, 280),
        record(
            10,
            "event_msg",
            json!({"type":"task_complete", "turn_id":"one"}),
        ),
    ]
}

#[test]
fn conversation_stats_counts_tokens_and_uses_local_request_windows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(&path, &fixture());
    let result = snapshot(&path, SESSION).unwrap();
    let turn = result.last_turn.unwrap();
    assert_eq!(result.turn_count, Some(1));
    assert_eq!(turn.id, "one");
    assert_eq!(turn.step_count, Some(2));
    assert_eq!(turn.model_duration_ms, Some(6000));
    assert_eq!(turn.average_output_tokens_per_second, Some(80.0 / 6.0));
    assert_eq!(result.output_tokens_per_second, Some(15.0));
    assert_eq!(result.total_tokens, Some(280));
    assert_eq!(result.input_tokens, Some(220));
    assert_eq!(result.cached_input_tokens, Some(50));
    assert_eq!(turn.turn_reasoning_output_tokens, Some(7));
    let request = result.last_model_request.unwrap();
    assert_eq!(
        request.turn_reasoning_output_tokens,
        turn.turn_reasoning_output_tokens
    );
    assert_eq!(
        request.response_window.unwrap().ended_at - turn.started_at_unix_ms.unwrap(),
        8000
    );
    assert_eq!(turn.status, "completed");
    assert_eq!(
        turn.completed_at_unix_ms.unwrap() - turn.started_at_unix_ms.unwrap(),
        9000
    );
    assert_eq!(turn.tool_duration_ms, None);
}

#[test]
fn conversation_stats_average_is_null_if_any_request_has_no_duration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(
        &path,
        &[
            start(1, "one"),
            usage(2, "a", 20, 120),
            count(2, 20, 120),
            response(3),
            usage(4, "b", 60, 280),
            count(4, 60, 280),
        ],
    );
    let result = snapshot(&path, SESSION).unwrap();
    let turn = result.last_turn.unwrap();
    assert_eq!(turn.step_count, Some(2));
    assert_eq!(result.output_tokens_per_second, Some(30.0));
    assert_eq!(turn.average_output_tokens_per_second, None);
    assert_eq!(turn.model_duration_ms, None);
    assert_eq!(turn.coverage, "partial");
}

fn tool(second: u32, id: &str, output: bool) -> Value {
    record(
        second,
        "response_item",
        json!({"type":if output {"function_call_output"} else {"function_call"},"call_id":id}),
    )
}

#[test]
fn conversation_stats_tool_duration_is_wall_clock_union() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(
        &path,
        &[
            start(1, "one"),
            tool(2, "a", false),
            tool(3, "b", false),
            tool(5, "a", true),
            tool(7, "b", true),
        ],
    );
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        Some(5000)
    );
    append(&path, &[tool(8, "c", false)]);
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        None
    );
    append(&path, &[tool(8, "c", true)]);
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        Some(5000)
    );
}

#[test]
fn conversation_stats_deduplicates_and_never_mixes_turns_or_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    let records = fixture();
    write(&path, &records);
    let first = serde_json::to_value(snapshot(&path, SESSION).unwrap()).unwrap();
    append(&path, &records);
    assert_eq!(
        serde_json::to_value(snapshot(&path, SESSION).unwrap()).unwrap(),
        first
    );
    append(&path, &[usage(11, "b", 60, 280), start(12, "two")]);
    let second = snapshot(&path, SESSION).unwrap();
    assert_eq!(second.turn_count, Some(2));
    assert_eq!(second.total_tokens, Some(280));
    let turn = second.last_turn.unwrap();
    assert_eq!(turn.id, "two");
    assert_eq!(turn.step_count, Some(0));
    assert_eq!(turn.turn_reasoning_output_tokens, None);
    assert_eq!(turn.model_duration_ms, None);
    assert_eq!(
        serde_json::to_value(second.last_model_request).unwrap(),
        first["lastModelRequest"]
    );
    let foreign = snapshot(&path, "another").unwrap();
    assert!(foreign.last_turn.is_none());
    assert!(foreign.total_tokens.is_none());
    assert_eq!(snapshot(&path, SESSION).unwrap().turn_count, Some(2));
    append(&path, &[usage(13, "late", 100, 9999)]);
    assert_eq!(snapshot(&path, SESSION).unwrap().total_tokens, Some(280));
}

#[test]
fn conversation_stats_invalidates_same_length_rewrite_and_truncation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(&path, &fixture());
    assert_eq!(snapshot(&path, SESSION).unwrap().total_tokens, Some(280));
    let before = fs::read_to_string(&path).unwrap();
    fs::write(&path, before.replace("280", "380")).unwrap();
    assert_eq!(snapshot(&path, SESSION).unwrap().total_tokens, Some(380));
    write(&path, &[start(1, "new")]);
    let result = snapshot(&path, SESSION).unwrap();
    assert_eq!(result.turn_count, Some(1));
    assert_eq!(result.last_turn.unwrap().id, "new");
    assert!(result.total_tokens.is_none());
    assert!(result.last_model_request.is_none());
}

#[test]
fn conversation_stats_waits_for_complete_lines_and_keeps_zero_distinct_from_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(&path, &[start(1, "one")]);
    let line = response(1).to_string();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&line.as_bytes()[..10])
        .unwrap();
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .step_count,
        Some(0)
    );
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(format!("{}\n", &line[10..]).as_bytes())
        .unwrap();
    append(&path, &[usage(1, "a", 0, 100), count(1, 0, 100)]);
    let result = snapshot(&path, SESSION).unwrap();
    let turn = result.last_turn.unwrap();
    assert_eq!(turn.model_duration_ms, Some(0));
    assert_eq!(turn.tool_duration_ms, Some(0));
    assert_eq!(turn.average_output_tokens_per_second, None);
}

#[test]
fn conversation_stats_serializes_only_record_derived_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(&path, &fixture());
    let value = serde_json::to_value(snapshot(&path, SESSION).unwrap()).unwrap();
    assert_eq!(value["usageSource"], "rollout");
    assert_eq!(value["usageScope"], "session");
    assert_eq!(value["speedScope"], "latest_recorded_request");
    assert_eq!(value["speedIsEstimate"], false);
    assert_eq!(value["lastTurn"]["speedIsEstimate"], false);
    for field in ["averageTtftMs", "ttftSampleCount", "inFlight", "lastStatus"] {
        assert!(value.get(field).is_none());
        assert!(value["lastTurn"].get(field).is_none());
    }
    assert_eq!(
        value["lastModelRequest"]["lastTokenUsage"]["outputTokens"],
        60
    );
}

#[test]
fn conversation_stats_legacy_output_fallback_and_previous_usage_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(
        &path,
        &[
            start(1, "one"),
            response(2),
            count(3, 20, 120),
            response(5),
            count(6, 60, 280),
        ],
    );
    let result = snapshot(&path, SESSION).unwrap();
    assert_eq!(result.output_tokens_per_second, Some(30.0));
    let turn = result.last_turn.unwrap();
    assert_eq!(turn.step_count, Some(2));
    assert_eq!(turn.model_duration_ms, Some(3000));
    assert_eq!(turn.average_output_tokens_per_second, Some(80.0 / 3.0));
    assert_eq!(
        result.last_model_request,
        crate::rollout_last_request::last_model_request(&path).unwrap()
    );
}

#[test]
fn conversation_stats_tool_item_boundaries_and_unassignable_records_are_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    let completed = record(
        5,
        "event_msg",
        json!({"type":"item_completed","item":{"type":"CommandExecution","id":"a","duration":{"secs":3,"nanos":0}}}),
    );
    write(&path, &[start(1, "one"), completed.clone()]);
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        None
    );
    write(
        &path,
        &[
            start(1, "one"),
            record(
                2,
                "event_msg",
                json!({"type":"item_started","item":{"type":"CommandExecution","id":"a"}}),
            ),
            completed,
        ],
    );
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        Some(3000)
    );
    append(
        &path,
        &[
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"without-time"}}),
        ],
    );
    assert_eq!(
        snapshot(&path, SESSION)
            .unwrap()
            .last_turn
            .unwrap()
            .tool_duration_ms,
        None
    );
}

#[test]
fn conversation_stats_foreign_segments_and_missing_response_ids_keep_reasoning_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    let mut missing_id = usage(3, "a", 20, 120);
    missing_id["payload"]
        .as_object_mut()
        .unwrap()
        .remove("response_id");
    write(
        &path,
        &[
            record(0, "session_meta", json!({"id":"other"})),
            record(0, "session_meta", json!({})),
            start(1, "foreign"),
            count(2, 10, 9999),
            record(0, "session_meta", json!({"id":SESSION})),
            start(1, "one"),
            response(2),
            missing_id,
            count(3, 20, 120),
        ],
    );
    let result = snapshot(&path, SESSION).unwrap();
    assert_eq!(result.turn_count, Some(1));
    assert_eq!(result.total_tokens, Some(120));
    assert_eq!(
        result.last_turn.unwrap().turn_reasoning_output_tokens,
        Some(7)
    );
    assert_eq!(
        result
            .last_model_request
            .unwrap()
            .turn_reasoning_output_tokens,
        Some(7)
    );
}

#[test]
fn conversation_stats_last_request_matches_old_endpoint_across_turn_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    write(&path, &fixture());
    let mut next_usage = usage(14, "c", 30, 410);
    next_usage["payload"]["turn_id"] = json!("two");
    let mut zero_usage = usage(16, "d", 0, 510);
    zero_usage["payload"]["turn_id"] = json!("three");
    for records in [
        vec![],
        vec![start(12, "two")],
        vec![response(13), next_usage, count(14, 30, 410)],
        vec![record(
            15,
            "event_msg",
            json!({"type":"task_complete","turn_id":"two"}),
        )],
        vec![start(16, "three")],
        vec![response(16), zero_usage, count(16, 0, 510)],
        vec![start(17, "four")],
    ] {
        append(&path, &records);
        let actual = snapshot(&path, SESSION).unwrap();
        assert_eq!(
            actual.last_model_request,
            crate::rollout_last_request::last_model_request(&path).unwrap(),
            "{records:?}"
        );
        if actual.last_turn.as_ref().unwrap().id == "three"
            && actual.last_turn.as_ref().unwrap().step_count == Some(1)
        {
            assert_eq!(actual.last_turn.unwrap().model_duration_ms, Some(0));
            assert!(actual.last_model_request.unwrap().response_window.is_none());
        }
    }
}

#[test]
fn conversation_stats_resets_after_earlier_turn_deletion_with_equal_or_greater_length() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.jsonl");
    let head = record(
        0,
        "event_msg",
        json!({"type":"padding","text":"h".repeat(6000)}),
    );
    let tail = record(
        20,
        "event_msg",
        json!({"type":"padding","text":"t".repeat(100_000)}),
    );
    let original = vec![
        head.clone(),
        start(1, "deleted"),
        response(2),
        start(10, "remaining"),
        tail,
    ];
    for growth in [0, 1000] {
        write(&path, &original);
        assert_eq!(snapshot(&path, SESSION).unwrap().turn_count, Some(2));
        let original_len = fs::metadata(&path).unwrap().len();
        let removed_len = format!("{}\n{}\n", original[1], original[2]).len();
        let replacement_tail = record(
            20,
            "event_msg",
            json!({"type":"padding","text":"t".repeat(100_000 + removed_len + growth)}),
        );
        write(
            &path,
            &[head.clone(), start(10, "remaining"), replacement_tail],
        );
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            original_len + growth as u64
        );
        let actual = snapshot(&path, SESSION).unwrap();
        assert_eq!(actual.turn_count, Some(1));
        assert_eq!(actual.last_turn.unwrap().id, "remaining");
    }
}
