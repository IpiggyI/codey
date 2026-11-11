use std::collections::BTreeMap;

use super::tests::input;
use super::*;
use crate::subagent_policy::SubagentCatalogSnapshot;

#[test]
fn unavailable_role_model_is_rejected_before_spawn_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_root = home.join(STATE_DIRECTORY);
    let mut roles = crate::config::default_subagent_roles();
    roles.insert(
        crate::config::SUBAGENT_ROLE_WORKER.into(),
        crate::config::SubagentRoleConfig::new("gone-model", "medium"),
    );
    let catalog = SubagentCatalogSnapshot::new(
        "route-a",
        vec![crate::config::DEFAULT_SUBAGENT_MODEL.to_string()],
    );
    commit_runtime_subagent_policy(home, &roles, &BTreeMap::new(), &catalog).unwrap();

    let mut spawn = input("PreToolUse", "stale-model-session");
    spawn.turn_id = Some("root-turn-a".to_string());
    spawn.cwd = Some("/repo".to_string());
    spawn.tool_name = Some("agents.spawn_agent".to_string());
    spawn.tool_input = Some(json!({
        "task_name": "stale_worker",
        "agent_type": "codey_worker",
        "fork_turns": "none",
        "message": "implement"
    }));
    let denied = handle_hook_for_runtime_at(&spawn, &state_root, "runtime-a", 20).unwrap();
    assert_eq!(
        denied["hookSpecificOutput"]["permissionDecision"].as_str(),
        Some("deny")
    );
    let reason = denied["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap_or_default();
    assert!(reason.contains("CODEY_SUBAGENT_MODEL_UNAVAILABLE"));
    assert!(reason.contains("codey_worker"));
    assert!(reason.contains("gone-model"));
    assert_eq!(
        crate::subagent_orchestrator::active_reservation_count(
            &state_root,
            "runtime-a",
            "stale-model-session",
            30,
        )
        .unwrap(),
        None
    );

    let restored = SubagentCatalogSnapshot::new("route-a", vec!["gone-model".into()]);
    commit_runtime_subagent_policy(home, &roles, &BTreeMap::new(), &restored).unwrap();
    let admitted = runtime_role_admission_denial(&state_root, "codey_worker").unwrap();
    assert_eq!(admitted, None);
}

#[test]
fn reselecting_a_catalog_member_restores_spawn_admission() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_root = home.join(STATE_DIRECTORY);
    let mut roles = crate::config::default_subagent_roles();
    roles.insert(
        crate::config::SUBAGENT_ROLE_WORKER.into(),
        crate::config::SubagentRoleConfig::new("gone-model", "medium"),
    );
    let catalog = SubagentCatalogSnapshot::new(
        "route-a",
        vec![crate::config::DEFAULT_SUBAGENT_MODEL.to_string()],
    );
    commit_runtime_subagent_policy(home, &roles, &BTreeMap::new(), &catalog).unwrap();
    assert!(
        runtime_role_admission_denial(&state_root, "codey_worker")
            .unwrap()
            .is_some_and(|reason| reason.contains("CODEY_SUBAGENT_MODEL_UNAVAILABLE"))
    );

    roles.insert(
        crate::config::SUBAGENT_ROLE_WORKER.into(),
        crate::config::SubagentRoleConfig::new(crate::config::DEFAULT_SUBAGENT_MODEL, "medium"),
    );
    commit_runtime_subagent_policy(home, &roles, &BTreeMap::new(), &catalog).unwrap();
    assert_eq!(
        runtime_role_admission_denial(&state_root, "codey_worker").unwrap(),
        None
    );
}

#[test]
fn provider_switch_keeps_binding_then_spawn_rejects_until_reselect() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_root = home.join(STATE_DIRECTORY);
    let mut config = crate::config::CodeyConfig {
        subagent_optimization: true,
        subagent_model: "stale-model".into(),
        subagent_roles: crate::config::uniform_subagent_roles("stale-model", "medium"),
        ..crate::config::CodeyConfig::default()
    };
    config.attach_current_provider_snapshot(
        crate::model_ownership::CurrentProviderSnapshot::from_parts(
            "route-b",
            "https://route-b.example/v1",
            "responses",
            false,
        ),
    );
    config.selected_models_by_provider.insert(
        config.current_model_list_key().unwrap().to_string(),
        vec!["live-model".into()],
    );
    crate::subagent_policy::reconcile_with_model_state(&mut config, None);
    assert_eq!(
        config.subagent_roles[crate::config::SUBAGENT_ROLE_WORKER].model,
        "stale-model"
    );

    let catalog = crate::subagent_policy::catalog_snapshot_for_config(&config);
    commit_runtime_subagent_policy(home, &config.subagent_roles, &BTreeMap::new(), &catalog)
        .unwrap();
    assert!(
        runtime_role_admission_denial(&state_root, "codey_worker")
            .unwrap()
            .is_some_and(|reason| {
                reason.contains("CODEY_SUBAGENT_MODEL_UNAVAILABLE")
                    && reason.contains("codey_worker")
                    && reason.contains("stale-model")
            })
    );

    config.subagent_roles.insert(
        crate::config::SUBAGENT_ROLE_WORKER.into(),
        crate::config::SubagentRoleConfig::new("live-model", "medium"),
    );
    let catalog = crate::subagent_policy::catalog_snapshot_for_config(&config);
    commit_runtime_subagent_policy(home, &config.subagent_roles, &BTreeMap::new(), &catalog)
        .unwrap();
    assert_eq!(
        runtime_role_admission_denial(&state_root, "codey_worker").unwrap(),
        None
    );
}

#[test]
fn missing_agent_type_gates_the_default_compatibility_role() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_root = home.join(STATE_DIRECTORY);
    let mut roles = crate::config::default_subagent_roles();
    roles.insert(
        crate::config::SUBAGENT_ROLE_DEFAULT.into(),
        crate::config::SubagentRoleConfig::new("legacy-gone", "low"),
    );
    let catalog = SubagentCatalogSnapshot::new(
        "route-a",
        vec![crate::config::DEFAULT_SUBAGENT_MODEL.to_string()],
    );
    commit_runtime_subagent_policy(home, &roles, &BTreeMap::new(), &catalog).unwrap();

    let mut spawn = input("PreToolUse", "default-role-session");
    spawn.turn_id = Some("root-turn-a".to_string());
    spawn.cwd = Some("/repo".to_string());
    spawn.tool_name = Some("agents.spawn_agent".to_string());
    spawn.tool_input = Some(json!({
        "task_name": "anonymous",
        "fork_turns": "none",
        "message": "scan"
    }));
    let denied = handle_hook_for_runtime_at(&spawn, &state_root, "runtime-a", 20).unwrap();
    let reason = denied["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap_or_default();
    assert!(reason.contains("CODEY_SUBAGENT_MODEL_UNAVAILABLE"));
    assert!(reason.contains("default"));
    assert!(reason.contains("legacy-gone"));
}

#[test]
fn catalog_change_without_role_edits_is_visible_to_policy_matching() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let roles = crate::config::default_subagent_roles();
    let hashes = BTreeMap::new();
    let first = SubagentCatalogSnapshot::new("route-a", vec!["model-a".into()]);
    commit_runtime_subagent_policy(home, &roles, &hashes, &first).unwrap();
    let second = SubagentCatalogSnapshot::new("route-a", vec!["model-b".into()]);
    assert!(!runtime_subagent_policy_matches(home, &roles, &hashes, &second).unwrap());
    assert!(runtime_subagent_policy_matches(home, &roles, &hashes, &first).unwrap());
}
