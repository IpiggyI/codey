use super::*;
use crate::codex_config_guidance::{
    CODEY_FASTCTX_GUIDANCE, CODEY_FASTCTX_GUIDANCE_VERSIONS, codey_fastctx_guidance_for_namespace,
    remove_codey_fastctx_guidance,
};
const LEGACY_GLOBAL_PROVIDER_ID: &str = "codey_global";

#[test]
fn codex_home_is_resolved_once_per_process() {
    assert!(std::ptr::eq(codex_home(), codex_home()));
}

#[test]
fn runtime_input_guard_detects_concurrent_file_changes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");

    assert!(optional_file_matches(&path, None).unwrap());
    fs::write(&path, b"original").unwrap();
    assert!(!optional_file_matches(&path, None).unwrap());
    assert!(optional_file_matches(&path, Some(b"original")).unwrap());
    fs::write(&path, b"concurrent").unwrap();
    assert!(!optional_file_matches(&path, Some(b"original")).unwrap());
}

#[test]
fn runtime_config_lock_serializes_codey_writers() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("codex-lease.json");
    let first = RuntimeConfigLock::acquire(&marker).unwrap();
    let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
    let second_marker = marker;
    let second = std::thread::spawn(move || {
        let _guard = RuntimeConfigLock::acquire(&second_marker).unwrap();
        acquired_tx.send(()).unwrap();
    });

    assert!(
        acquired_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err()
    );
    drop(first);
    acquired_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    second.join().unwrap();
}

#[test]
fn runtime_config_lock_has_a_bounded_wait() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("codex-lease.json");
    let _first = RuntimeConfigLock::acquire(&marker).unwrap();
    let started = std::time::Instant::now();

    let error =
        RuntimeConfigLock::acquire_with_timeout(&marker, std::time::Duration::from_millis(40))
            .err()
            .unwrap();

    assert!(format!("{error:#}").contains("超过 40 毫秒"));
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn failed_initial_lease_never_publishes_runtime_policy() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let marker = temp.path().join("codey/codex-lease.json");
    let backup_root = temp.path().join("codey/codex-backups");
    fs::create_dir_all(&home).unwrap();
    // A directory at the marker path deterministically makes the lease's
    // final atomic rename fail after all startup input preparation.
    fs::create_dir_all(&marker).unwrap();
    let original_config = b"model_provider = \"codey_global\"\n";
    fs::write(home.join("config.toml"), original_config).unwrap();
    let result = apply_isolated_test_runtime_config(
        &home,
        false,
        None,
        true,
        DEFAULT_SUBAGENT_MODEL,
        DEFAULT_SUBAGENT_REASONING_EFFORT,
        None,
        &marker,
        &backup_root,
    );

    assert!(result.is_err());
    let (policy_path, pending_path) = crate::subagent_gate::runtime_subagent_policy_paths(&home);
    assert!(!policy_path.exists());
    assert!(!pending_path.exists());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original_config);
}

#[test]
fn discarding_a_cancelled_startup_clears_active_and_pending_runtime_policy() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let marker = temp.path().join("codey/codex-lease.json");
    let backup_dir = temp.path().join("codey/codex-backups/current");
    fs::create_dir_all(&backup_dir).unwrap();
    fs::write(&marker, b"lease").unwrap();
    let roles = crate::config::uniform_subagent_roles("provider-model", "high");
    let hashes = BTreeMap::from([("default".to_string(), "digest".to_string())]);
    crate::subagent_gate::commit_runtime_subagent_policy(
        &home,
        &roles,
        &hashes,
        &crate::subagent_policy::SubagentCatalogSnapshot::allowing_bound_models(
            "test-provider",
            &roles,
        ),
    )
    .unwrap();
    crate::subagent_gate::begin_runtime_subagent_policy_update(
        &home,
        &roles,
        &hashes,
        &crate::subagent_policy::SubagentCatalogSnapshot::allowing_bound_models(
            "test-provider",
            &roles,
        ),
    )
    .unwrap();

    discard_runtime_lease(&home, &marker, &backup_dir).unwrap();

    let (policy_path, pending_path) = crate::subagent_gate::runtime_subagent_policy_paths(&home);
    assert!(!policy_path.exists());
    assert!(!pending_path.exists());
    assert!(!marker.exists());
    assert!(!backup_dir.exists());
}

#[test]
fn restore_without_a_lease_repairs_legacy_persistent_codey_runtime_config() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = br#"model_provider = "codey_router"
model = "custom/gpt-5.6-terra"
model_catalog_json = "model-catalogs/codey-official.json"

[model_providers.codey_router]
name = "Codey Local Router"
base_url = "http://127.0.0.1:43127/v1"
wire_api = "responses"
supports_websockets = false
experimental_bearer_token = "runtime-token"
http_headers = { x-codey-router-token = "runtime-token" }

[model_providers.user_relay]
name = "User Relay"
base_url = "https://relay.example/v1"

[agents]
enabled = true
default_subagent_model = "custom/gpt-5.6-terra"
default_subagent_reasoning_effort = "low"

[agents.default]
model = "custom/gpt-5.6-terra"
model_reasoning_effort = "low"
config_file = "/tmp/codey/codex-constraints/runtime/default-agent.toml"

[agents.codey_worker]
model = "custom/gpt-5.6-terra"
model_reasoning_effort = "medium"
config_file = "/tmp/codey/codex-constraints/runtime/agents/codey_worker.toml"

[features.multi_agent_v2]
enabled = true
tool_namespace = "agents"
multi_agent_mode_hint_text = "Codey runtime hint"
default_subagent_model = "custom/gpt-5.6-luna"
default_subagent_reasoning_effort = "max"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert!(restore_runtime_config_at(&home, &temp.path().join("missing-lease.json"), true).unwrap());
    let repaired = fs::read_to_string(home.join("config.toml")).unwrap();
    let document = repaired.parse::<DocumentMut>().unwrap();

    assert!(document.get("model").is_none());
    assert!(document.get("model_provider").is_none());
    assert!(document.get("model_catalog_json").is_none());
    assert!(
        document
            .get("model_providers")
            .and_then(Item::as_table_like)
            .is_none_or(|providers| !providers.contains_key("codey_router"))
    );
    assert_eq!(
        document["model_providers"]["user_relay"]["base_url"].as_str(),
        Some("https://relay.example/v1")
    );
    assert!(document["agents"].get("default_subagent_model").is_none());
    assert!(
        document["agents"]
            .get("default_subagent_reasoning_effort")
            .is_none()
    );
    assert!(document["agents"].get("default").is_none());
    assert!(document["agents"].get("codey_worker").is_none());
    assert_eq!(document["agents"]["enabled"].as_bool(), Some(true));
    assert!(
        document
            .get("features")
            .and_then(Item::as_table)
            .and_then(|features| features.get("multi_agent_v2"))
            .is_some()
    );
    assert!(
        document["features"]["multi_agent_v2"]
            .get("default_subagent_model")
            .is_none()
    );
    assert!(
        document["features"]["multi_agent_v2"]
            .get("default_subagent_reasoning_effort")
            .is_none()
    );
    assert_eq!(fs::read(home.join("config.toml.bak")).unwrap(), original);
}

#[test]
fn restore_without_a_lease_repairs_dangling_codey_router_selection() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = br#"model_provider = "codey_router"
model = "route-a/gpt-5.6-terra"
model_catalog_json = "model-catalogs/codey-official.json"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert!(restore_runtime_config_at(&home, &temp.path().join("missing-lease.json"), true).unwrap());
    let repaired = fs::read_to_string(home.join("config.toml")).unwrap();
    let document = repaired.parse::<DocumentMut>().unwrap();

    assert!(document.get("model_provider").is_none());
    assert!(document.get("model").is_none());
    assert!(document.get("model_catalog_json").is_none());
    assert!(
        document
            .get("model_providers")
            .and_then(Item::as_table_like)
            .is_none_or(|providers| !providers.contains_key("codey_router"))
    );
    assert_eq!(
        document["model_providers"]["relay"]["base_url"].as_str(),
        Some("https://relay.example/v1")
    );
    assert_eq!(fs::read(home.join("config.toml.bak")).unwrap(), original);
}

#[test]
fn legacy_repair_keeps_a_user_owned_codey_router_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = br#"model_provider = "codey_router"
model = "user-model"

[model_providers.codey_router]
name = "User-Owned Router"
base_url = "http://127.0.0.1:9876/v1"
wire_api = "responses"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert!(!restore_runtime_config_at(&home, &temp.path().join("missing-lease.json"), true).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
}

#[test]
fn legacy_repair_keeps_an_inline_user_owned_codey_router_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = br#"model_provider = "codey_router"
model = "user-model"
model_providers = { codey_router = { name = "User-Owned Router", base_url = "https://relay.example/v1", wire_api = "responses" } }
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert!(!restore_runtime_config_at(&home, &temp.path().join("missing-lease.json"), true).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
}

#[test]
fn legacy_repair_keeps_user_subagent_defaults_without_codey_ownership_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = br#"[agents]
enabled = true
default_subagent_model = "company/gpt-5.6-terra"
default_subagent_reasoning_effort = "low"

[agents.researcher]
model = "company/gpt-5.6-terra"
model_reasoning_effort = "low"

[features.multi_agent_v2]
enabled = true
tool_namespace = "agents"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert!(!restore_runtime_config_at(&home, &temp.path().join("missing-lease.json"), true).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
    assert!(!home.join("config.toml.bak").exists());
}

#[test]
fn disabled_subagent_roles_are_omitted_from_runtime_registration_and_policy_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let constraints_dir = temp.path().join("codex-constraints");
    let mut configured = crate::config::default_subagent_roles();
    configured
        .get_mut(crate::config::SUBAGENT_ROLE_WORKER)
        .unwrap()
        .enabled = false;

    let runtime_roles = runtime_subagent_roles(
        Some(&configured),
        DEFAULT_SUBAGENT_MODEL,
        DEFAULT_SUBAGENT_REASONING_EFFORT,
    );
    assert!(!runtime_roles.contains_key(crate::config::SUBAGENT_ROLE_WORKER));
    assert!(runtime_roles.contains_key(crate::config::SUBAGENT_ROLE_QUICK_SCAN));
    assert!(runtime_roles.contains_key(crate::config::SUBAGENT_ROLE_DEFAULT));

    let plans = plan_runtime_agent_files(&constraints_dir, &runtime_roles, None).unwrap();
    assert_eq!(plans.len(), runtime_roles.len());
    assert!(
        plans
            .iter()
            .all(|plan| plan.registration.role != crate::config::SUBAGENT_ROLE_WORKER)
    );

    let stale_worker_path =
        runtime_agent_path(&constraints_dir, crate::config::SUBAGENT_ROLE_WORKER);
    if let Some(parent) = stale_worker_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&stale_worker_path, b"stale worker runtime file").unwrap();
    let registrations =
        prepare_runtime_agent_files(&constraints_dir, &runtime_roles, None).unwrap();
    assert_eq!(registrations.len(), runtime_roles.len());
    assert!(!stale_worker_path.exists());
}

#[test]
fn failed_lease_marker_removal_keeps_the_recovery_backup() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let marker = temp.path().join("codex-lease.json");
    let backup_dir = temp.path().join("codex-backups/active");
    fs::create_dir_all(&marker).unwrap();
    fs::create_dir_all(&backup_dir).unwrap();
    fs::write(backup_dir.join("hooks.json"), b"recoverable").unwrap();

    let error = discard_runtime_lease(&home, &marker, &backup_dir)
        .unwrap_err()
        .to_string();

    assert!(error.contains("删除文件失败"));
    assert!(marker.is_dir());
    assert!(backup_dir.is_dir());
    assert_eq!(
        fs::read(backup_dir.join("hooks.json")).unwrap(),
        b"recoverable"
    );
}

#[test]
fn stale_backup_dirs_are_pruned_beyond_retention() {
    let temp = tempfile::tempdir().unwrap();
    let backup_root = temp.path().join("codex-backups");
    for index in 0..8_u32 {
        fs::create_dir_all(backup_root.join(format!("{}-42", 1000 + index))).unwrap();
    }
    fs::create_dir_all(backup_root.join("unrelated")).unwrap();
    let marker = temp.path().join("codex-lease.json");
    let lease = serde_json::json!({
        "backupDir": backup_root.join("1000-42"),
        "originalConfigExists": true,
    });
    fs::write(&marker, lease.to_string()).unwrap();

    prune_stale_backup_dirs(&backup_root, &marker);

    assert!(backup_root.join("1000-42").is_dir(), "lease dir kept");
    assert!(!backup_root.join("1001-42").is_dir(), "oldest pruned");
    assert!(!backup_root.join("1002-42").is_dir(), "oldest pruned");
    for index in 3..8_u32 {
        assert!(backup_root.join(format!("{}-42", 1000 + index)).is_dir());
    }
    assert!(backup_root.join("unrelated").is_dir(), "foreign dir kept");
}

fn relative_model_catalog_path() -> Option<&'static Path> {
    Some(Path::new(
        crate::model_catalog_store::DERIVED_CATALOG_FILE_NAME,
    ))
}

#[test]
fn configured_model_catalog_treats_legacy_codey_paths_as_owned() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let catalog_dir = temp.path().join("codey/model-catalogs");
    fs::create_dir_all(&home).unwrap();
    let legacy = home.join("model-catalogs/codey-official.json");
    fs::write(
        home.join("config.toml"),
        format!("model_catalog_json = \"{}\"\n", legacy.display()),
    )
    .unwrap();

    assert_eq!(
        configured_model_catalog(&home, &catalog_dir).unwrap(),
        ConfiguredModelCatalog::CodeyOwned
    );
    assert_eq!(
        configured_user_model_catalog_path(&home, &catalog_dir).unwrap(),
        None
    );

    fs::write(
        home.join("config.toml"),
        "model_catalog_json = \"model-catalogs/codey-official.json\"\n",
    )
    .unwrap();
    assert_eq!(
        configured_model_catalog(&home, &catalog_dir).unwrap(),
        ConfiguredModelCatalog::CodeyOwned
    );
}

#[test]
fn configured_model_catalog_keeps_user_files_as_user_owned() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let catalog_dir = temp.path().join("codey/model-catalogs");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        home.join("config.toml"),
        "model_catalog_json = \"/user/catalog.json\"\n",
    )
    .unwrap();

    assert_eq!(
        configured_model_catalog(&home, &catalog_dir).unwrap(),
        ConfiguredModelCatalog::User(PathBuf::from("/user/catalog.json"))
    );
}

#[test]
fn isolated_runtime_preserves_computer_use_without_adding_an_mcp() {
    let endpoint = RuntimeRouterEndpoint {
        base_url: "http://127.0.0.1:43127/v1".into(),
        token: "test-router-token".into(),
        supports_websockets: false,
        supports_remote_compaction: false,
        requires_openai_auth: false,
    };
    for local_router in [None, Some(&endpoint)] {
        for enabled in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("codex-home");
            let marker = temp.path().join("codey-state/codex-lease.json");
            let backup_root = temp.path().join("codey-state/codex-backups");
            let client_path = "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
            let client = home.join("computer-use").join(client_path);
            fs::create_dir_all(client.parent().unwrap()).unwrap();
            fs::write(client, b"test client").unwrap();
            let original = format!(
                "[plugins.\"unified-computer-use@openai-bundled\"]\nenabled = true\n\n\
                 [mcp_servers.computer-use]\ncommand = './{client_path}'\nargs = ['mcp']\n\
                 cwd = '.'\nenabled = {enabled}\n"
            );
            fs::write(home.join("config.toml"), &original).unwrap();

            let applied = apply_isolated_runtime_router_config(
                &home,
                RouterApplyOptions {
                    local_router,
                    model_catalog_path: None,
                    default_model: None,
                    fastctx_command: None,
                    subagent_optimization: false,
                    subagent_model: DEFAULT_SUBAGENT_MODEL,
                    subagent_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
                    subagent_roles: None,
                    subagent_catalog: Default::default(),
                    marker: &marker,
                    backup_root: &backup_root,
                },
            )
            .unwrap();

            assert_eq!(
                fs::read_to_string(home.join("config.toml")).unwrap(),
                original
            );
            assert!(applied.runtime_config_overrides.iter().all(|entry| {
                !entry.starts_with("mcp_servers.") && !entry.starts_with("plugins.")
            }));
            assert!(restore_runtime_config_at(&home, &marker, false).unwrap());
            assert_eq!(
                fs::read_to_string(home.join("config.toml")).unwrap(),
                original
            );
        }
    }
}

#[test]
fn native_isolated_runtime_preserves_a_user_owned_reserved_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let marker = temp.path().join("codey-state/codex-lease.json");
    let backup_root = temp.path().join("codey-state/codex-backups");
    fs::create_dir_all(&home).unwrap();
    let original = br#"model_provider = "codey_router"
model = "user-model"

[model_providers.codey_router]
name = "User Router"
base_url = "https://user-router.example/v1"
wire_api = "responses"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    apply_isolated_runtime_router_config(
        &home,
        RouterApplyOptions {
            model_catalog_path: None,
            default_model: None,
            fastctx_command: None,
            subagent_optimization: false,
            subagent_model: DEFAULT_SUBAGENT_MODEL,
            subagent_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
            subagent_roles: None,
            subagent_catalog: Default::default(),
            marker: &marker,
            backup_root: &backup_root,
        },
    )
    .unwrap();

    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
    assert!(restore_runtime_config_at(&home, &marker, false).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original);
}

#[test]
fn router_patch_installs_only_the_loopback_provider_and_preserves_user_catalog() {    let result = patch_config(
        r#"model_provider = "relay"
model_catalog_json = "/user/catalog.json"

[model_providers.relay]
base_url = "https://relay.example/v1"
experimental_bearer_token = "user-secret"
"#,
        true,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();
    assert_eq!(document["model_provider"].as_str(), Some("relay"));
    assert!(
        document
            .get("model_providers")
            .and_then(Item::as_table_like)
            .is_none_or(|providers| !providers.contains_key("codey_router"))
    );
    assert_eq!(
        document["model_providers"]["relay"]["base_url"].as_str(),
        Some("https://relay.example/v1")
    );
    assert_eq!(
        root_key_string(&result, "model_catalog_json").as_deref(),
        Some(crate::model_catalog_store::DERIVED_CATALOG_FILE_NAME)
    );
}

#[test]
fn router_patch_enables_all_desktop_reasoning_efforts() {
    let existing = r#"
[desktop]
enabled-reasoning-efforts = ["low", "medium", "high", "xhigh"]
"#;
    let result = patch_config(existing, true).unwrap();
    let document = result.parse::<DocumentMut>().unwrap();
    let efforts = document["desktop"]["enabled-reasoning-efforts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|effort| effort.as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
}

#[test]
fn router_patch_preserves_selected_service_tier() {
    let result = patch_config("service_tier = \"priority\"\n", true).unwrap();

    assert_eq!(
        root_key_string(&result, "service_tier").as_deref(),
        Some("priority")
    );
}

#[test]
fn router_patch_sets_the_requested_default_model() {
    let result = patch_config_with_fastctx(
        "model = \"old-model\"\n\n[profiles.work]\nmodel = \"profile-model\"\n",
        relative_model_catalog_path(),
        Some("gpt-5.6-sol"),
        None,
        false,
    )
    .unwrap();

    assert_eq!(
        root_key_string(&result, "model").as_deref(),
        Some("gpt-5.6-sol")
    );
    let document = result.parse::<DocumentMut>().unwrap();
    let work_profile = document["profiles"]["work"].as_table().unwrap();
    assert!(work_profile.get("model").is_none());
}

#[test]
fn fast_context_tools_status_reports_only_user_configured_servers() {
    let document = parse_document(
        r#"
[mcp_servers.codey_fastctx]
command = "/Applications/Codey.app/Contents/MacOS/codey-fastctx"
args = ["--codey-fastctx-mcp"]

[mcp_servers.context_tools]
command = "uvx"
args = ["fastctx", "--stdio"]
"#,
    )
    .unwrap();

    assert_eq!(
        fast_context_tools_status_from_document(&document),
        FastContextToolsStatus {
            user_configured: true,
            detection_failed: false,
            server_id: Some("context_tools".to_string()),
        }
    );

    let owned_only = parse_document(
        r#"
[mcp_servers.codey_fastctx]
command = "/Applications/Codey.app/Contents/MacOS/codey-fastctx"
args = ["--codey-fastctx-mcp"]
"#,
    )
    .unwrap();
    assert_eq!(
        fast_context_tools_status_from_document(&owned_only),
        FastContextToolsStatus::default()
    );
}

#[test]
fn fast_context_tools_status_reads_the_current_codex_config() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        fast_context_tools_status(temp.path()).unwrap(),
        FastContextToolsStatus::default()
    );

    fs::write(
        temp.path().join("config.toml"),
        r#"[mcp_servers.fastctx]
command = "/custom/fastctx"
args = ["serve"]
"#,
    )
    .unwrap();

    assert_eq!(
        fast_context_tools_status(temp.path()).unwrap(),
        FastContextToolsStatus {
            user_configured: true,
            detection_failed: false,
            server_id: Some("fastctx".to_string()),
        }
    );
}

#[test]
fn fast_context_tools_detect_root_inline_user_servers() {
    let existing = r#"
mcp_servers = { context_tools = { command = "uvx", args = ["fastctx", "--stdio"] } }
"#;
    let document = parse_document(existing).unwrap();

    assert_eq!(
        fast_context_tools_status_from_document(&document),
        FastContextToolsStatus {
            user_configured: true,
            detection_failed: false,
            server_id: Some("context_tools".to_string()),
        }
    );

    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey-fastctx")),
        false,
    )
    .unwrap();
    let document = parse_document(&result).unwrap();
    assert!(!mcp_server_exists(&document, CODEY_FASTCTX_SERVER_ID));
    assert_eq!(
        configured_user_fastctx_server_id(&document).as_deref(),
        Some("context_tools")
    );
}

#[test]
fn disabling_fast_context_tools_removes_inline_owned_servers() {
    for existing in [
        r#"
[mcp_servers]
codey_fastctx = { command = "/tmp/codey-fastctx", args = ["--codey-fastctx-mcp"] }

[features.code_mode]
direct_only_tool_namespaces = ["mcp__codey_fastctx"]
"#,
        r#"
mcp_servers = { codey_fastctx = { command = "/tmp/codey-fastctx", args = ["--codey-fastctx-mcp"] } }

[features.code_mode]
direct_only_tool_namespaces = ["mcp__codey_fastctx"]
"#,
    ] {
        let result =
            patch_config_with_fastctx(existing, relative_model_catalog_path(), None, None, false)
                .unwrap();
        let document = parse_document(&result).unwrap();

        assert!(!mcp_server_exists(&document, CODEY_FASTCTX_SERVER_ID));
        assert!(
            document["features"]["code_mode"]["direct_only_tool_namespaces"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn enabling_fast_context_tools_normalizes_inline_owned_servers() {
    let existing = r#"
mcp_servers = { codey_fastctx = { command = "/old/codey", args = ["--codey-fastctx-mcp"], env = { CUSTOM = "preserve" } } }
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/new/codey-fastctx")),
        false,
    )
    .unwrap();
    let document = parse_document(&result).unwrap();
    let server = document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]
        .as_table()
        .unwrap();

    assert_eq!(server["command"].as_str(), Some("/new/codey-fastctx"));
    assert_eq!(server["env"]["CUSTOM"].as_str(), Some("preserve"));
    assert_eq!(
        server["env"]["FASTCTX_TOKEN_BUDGET"]
            .as_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        CODEY_FASTCTX_TOKEN_BUDGET
    );
    assert_eq!(
        server["env"]["FASTCTX_GREP_TOKEN_BUDGET"]
            .as_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        CODEY_FASTCTX_GREP_TOKEN_BUDGET
    );
    assert_eq!(
        server["env"]["FASTCTX_GLOB_TOKEN_BUDGET"]
            .as_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        CODEY_FASTCTX_GLOB_TOKEN_BUDGET
    );
    assert_eq!(
        fast_context_tools_status_from_document(&document),
        FastContextToolsStatus::default()
    );
}

#[test]
fn user_fastctx_blocks_the_embedded_server_without_injecting_codey_guidance() {
    let existing = r#"
developer_instructions = "Keep my guidance."
tool_output_token_limit = 16000

[mcp_servers.fastctx]
command = "/custom/fastctx"
args = ["serve", "--enable-shell"]

[features.code_mode]
direct_only_tool_namespaces = ["mcp__existing", "mcp__fastctx"]
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/Applications/Codey.app/Contents/MacOS/codey")),
        false,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["mcp_servers"]["fastctx"]["command"].as_str(),
        Some("/custom/fastctx")
    );
    assert!(
        document["mcp_servers"]
            .as_table()
            .unwrap()
            .get(CODEY_FASTCTX_SERVER_ID)
            .is_none()
    );
    assert_eq!(
        document["tool_output_token_limit"].as_integer(),
        Some(16_000)
    );
    let namespaces = document["features"]["code_mode"]["direct_only_tool_namespaces"]
        .as_array()
        .unwrap();
    assert!(
        namespaces
            .iter()
            .any(|entry| entry.as_str() == Some("mcp__fastctx"))
    );
    assert!(
        namespaces
            .iter()
            .all(|entry| entry.as_str() != Some(CODEY_FASTCTX_NAMESPACE))
    );
    let guidance = document["developer_instructions"].as_str().unwrap();
    assert_eq!(guidance, "Keep my guidance.");
    assert!(!guidance.contains("Codey FastCtx context tools are enabled"));
    assert!(!guidance.contains("mcp__codey_fastctx"));
}

#[test]
fn fast_context_tools_migrate_the_owned_main_executable_proxy_to_the_sidecar() {
    let existing = r#"
[mcp_servers.codey_fastctx]
command = "/Applications/Codey.app/Contents/MacOS/codey"
args = ["--codey-fastctx-mcp"]
startup_timeout_sec = 15
runtime_note = "preserve"

[mcp_servers.codey_fastctx.env]
CONCURRENT = "preserve"
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new(
            "/Applications/Codey.app/Contents/MacOS/codey-fastctx",
        )),
        false,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();
    let server = document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]
        .as_table()
        .unwrap();

    assert_eq!(
        server["command"].as_str(),
        Some("/Applications/Codey.app/Contents/MacOS/codey-fastctx")
    );
    assert_eq!(
        server["args"]
            .as_array()
            .and_then(|arguments| arguments.get(0))
            .and_then(Value::as_str),
        Some("--codey-fastctx-mcp")
    );
    assert_eq!(
        server["startup_timeout_sec"].as_integer(),
        Some(CODEY_FASTCTX_STARTUP_TIMEOUT_SECONDS)
    );
    assert_eq!(
        server["tool_timeout_sec"].as_integer(),
        Some(CODEY_FASTCTX_TOOL_TIMEOUT_SECONDS)
    );
    assert_eq!(server["runtime_note"].as_str(), Some("preserve"));
    assert_eq!(server["env"]["CONCURRENT"].as_str(), Some("preserve"));
    assert_eq!(
        server["env"]["FASTCTX_TOKEN_BUDGET"]
            .as_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        CODEY_FASTCTX_TOKEN_BUDGET
    );
}

#[test]
fn fast_context_tools_scale_budgets_down_for_a_smaller_user_host_limit() {
    let result = patch_config_with_fastctx(
        "tool_output_token_limit = 16000\n",
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey-fastctx")),
        false,
    )
    .unwrap();
    let document = parse_document(&result).unwrap();
    let server = document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]
        .as_table()
        .unwrap();

    assert_eq!(
        document["tool_output_token_limit"].as_integer(),
        Some(16_000)
    );
    assert_eq!(
        server["env"]["FASTCTX_TOKEN_BUDGET"].as_str(),
        Some("14400")
    );
    assert_eq!(
        server["env"]["FASTCTX_GREP_TOKEN_BUDGET"].as_str(),
        Some("10800")
    );
    assert_eq!(
        server["env"]["FASTCTX_GLOB_TOKEN_BUDGET"].as_str(),
        Some("5400")
    );
}

#[test]
fn fast_context_tools_keep_an_explicit_zero_host_output_limit() {
    let result = patch_config_with_fastctx(
        "tool_output_token_limit = 0\n",
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey-fastctx")),
        false,
    )
    .unwrap();
    let document = parse_document(&result).unwrap();
    let server = document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]
        .as_table()
        .unwrap();

    assert_eq!(document["tool_output_token_limit"].as_integer(), Some(0));
    assert!(
        server.get("env").is_none(),
        "显式 0 且此前无 env 时不应派生预算环境变量"
    );
}

#[test]
fn fast_context_tools_drop_stale_budget_keys_under_an_explicit_zero_limit() {
    let existing = r#"tool_output_token_limit = 0

[mcp_servers.codey_fastctx]
command = "/old/codey-fastctx"
args = ["--codey-fastctx-mcp"]

[mcp_servers.codey_fastctx.env]
FASTCTX_TOKEN_BUDGET = "54000"
FASTCTX_GREP_TOKEN_BUDGET = "10800"
FASTCTX_GLOB_TOKEN_BUDGET = "5400"
USER_KEY = "preserve"
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey-fastctx")),
        false,
    )
    .unwrap();
    let document = parse_document(&result).unwrap();
    let server = document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]
        .as_table()
        .unwrap();

    assert_eq!(document["tool_output_token_limit"].as_integer(), Some(0));
    let env = server
        .get("env")
        .and_then(|env| env.as_table())
        .expect("已有 env 中的用户键应保留");
    assert_eq!(env["USER_KEY"].as_str(), Some("preserve"));
    for key in [
        "FASTCTX_TOKEN_BUDGET",
        "FASTCTX_GREP_TOKEN_BUDGET",
        "FASTCTX_GLOB_TOKEN_BUDGET",
    ] {
        assert!(env.get(key).is_none(), "应清掉残留的 {key}");
    }
}

#[test]
fn fast_context_tools_detect_fastctx_invoked_by_another_server_id() {
    let existing = r#"
[mcp_servers.context_tools]
command = "uvx"
args = ["fastctx", "--stdio"]
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert!(
        document["mcp_servers"]
            .as_table()
            .unwrap()
            .get(CODEY_FASTCTX_SERVER_ID)
            .is_none()
    );
    assert!(document.get("developer_instructions").is_none());
    assert!(document.get("tool_output_token_limit").is_none());
}

#[test]
fn fast_context_tools_detect_fastctx_in_the_command_case_insensitively() {
    let existing = r#"
[mcp_servers]
context_tools = { command = "/opt/tools/FASTCTX.exe", args = ["--stdio"] }
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert!(
        document["mcp_servers"]
            .as_table()
            .unwrap()
            .get(CODEY_FASTCTX_SERVER_ID)
            .is_none()
    );
}

#[test]
fn fast_context_tools_do_not_confuse_fastctx_substrings_with_the_server() {
    let existing = r#"
[mcp_servers.breakfastctx]
command = "/custom/breakfastctx"
"#;
    let result = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]["command"].as_str(),
        Some("/tmp/codey")
    );
}

#[test]
fn disabling_fast_context_tools_removes_only_codey_owned_artifacts() {
    let original = r#"
developer_instructions = "User guidance."
tool_output_token_limit = 16000

[mcp_servers.user_tools]
command = "/custom/context-server"

[features.code_mode]
direct_only_tool_namespaces = ["mcp__existing"]
"#;
    let enabled = patch_config_with_fastctx(
        original,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    let mut stale = enabled.parse::<DocumentMut>().unwrap();
    let guidance = stale["developer_instructions"]
        .as_str()
        .unwrap()
        .to_string();
    stale["developer_instructions"] = value(format!("{guidance}\n\nConcurrent guidance."));
    let features = ensure_root_table(&mut stale, "features").unwrap();
    let multi_agent = ensure_child_table(features, "multi_agent_v2").unwrap();
    multi_agent["subagent_developer_instructions"] =
        value(format!("Subagent guidance.\n\n{guidance}"));

    let disabled = patch_config_with_fastctx(
        &document_string(&stale).unwrap(),
        relative_model_catalog_path(),
        None,
        None,
        false,
    )
    .unwrap();
    let document = disabled.parse::<DocumentMut>().unwrap();

    let mcp_servers = document["mcp_servers"].as_table().unwrap();
    assert!(mcp_servers.get(CODEY_FASTCTX_SERVER_ID).is_none());
    assert_eq!(
        mcp_servers["user_tools"]["command"].as_str(),
        Some("/custom/context-server")
    );
    assert_eq!(
        document["developer_instructions"].as_str(),
        Some("User guidance.\n\nConcurrent guidance.")
    );
    assert_eq!(
        document["features"]["multi_agent_v2"]["subagent_developer_instructions"].as_str(),
        Some("Subagent guidance.\n\nUser guidance.")
    );
    assert_eq!(
        document["tool_output_token_limit"].as_integer(),
        Some(16_000)
    );
    let namespaces = document["features"]["code_mode"]["direct_only_tool_namespaces"]
        .as_array()
        .unwrap();
    assert_eq!(
        namespaces
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["mcp__existing"]
    );
}

#[test]
fn disabling_fast_context_tools_removes_user_fastctx_guidance_only() {
    let user_fastctx_guidance = codey_fastctx_guidance_for_namespace("mcp__fastctx");
    let existing = format!(
        r#"
developer_instructions = "User guidance.\n\n{user_fastctx_guidance}"

[mcp_servers.fastctx]
command = "/custom/fastctx"
args = ["serve"]

[features.code_mode]
direct_only_tool_namespaces = ["mcp__fastctx"]
"#
    );

    let result =
        patch_config_with_fastctx(&existing, relative_model_catalog_path(), None, None, false)
            .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["mcp_servers"]["fastctx"]["command"].as_str(),
        Some("/custom/fastctx")
    );
    assert_eq!(
        document["developer_instructions"].as_str(),
        Some("User guidance.")
    );
    let namespaces = document["features"]["code_mode"]["direct_only_tool_namespaces"]
        .as_array()
        .unwrap();
    assert!(
        namespaces
            .iter()
            .any(|entry| entry.as_str() == Some("mcp__fastctx"))
    );
}

#[test]
fn disabling_fast_context_tools_preserves_a_user_replacement_under_the_reserved_id() {
    let existing = format!(
        r#"developer_instructions = "{CODEY_FASTCTX_GUIDANCE}"

[mcp_servers.codey_fastctx]
command = "/user/server"
args = ["serve"]

[features.code_mode]
direct_only_tool_namespaces = ["mcp__codey_fastctx"]
"#
    );
    let disabled =
        patch_config_with_fastctx(&existing, relative_model_catalog_path(), None, None, false)
            .unwrap();
    let document = disabled.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["mcp_servers"][CODEY_FASTCTX_SERVER_ID]["command"].as_str(),
        Some("/user/server")
    );
    assert!(document.get("developer_instructions").is_none());
    assert!(
        document["features"]["code_mode"]["direct_only_tool_namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry.as_str() == Some(CODEY_FASTCTX_NAMESPACE))
    );
}

#[test]
fn disabling_fast_context_tools_cleans_an_orphan_reserved_namespace() {
    let existing = r#"
[features.code_mode]
direct_only_tool_namespaces = ["mcp__codey_fastctx", "mcp__user"]
"#;
    let disabled =
        patch_config_with_fastctx(existing, relative_model_catalog_path(), None, None, false)
            .unwrap();
    let document = disabled.parse::<DocumentMut>().unwrap();
    let namespaces = document["features"]["code_mode"]["direct_only_tool_namespaces"]
        .as_array()
        .unwrap();

    assert_eq!(
        namespaces
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["mcp__user"]
    );
}

#[test]
fn fastctx_guidance_cleanup_requires_complete_paragraph_boundaries() {
    let embedded = format!("User prefix {CODEY_FASTCTX_GUIDANCE} user suffix");

    assert_eq!(remove_codey_fastctx_guidance(&embedded), None);
}

#[test]
fn fast_context_tools_are_idempotent_and_default_the_host_output_limit() {
    let existing = r#"
[features.code_mode]
direct_only_tool_namespaces = ["mcp__existing", "mcp__codey_fastctx", "mcp__codey_fastctx"]
"#;
    let first = patch_config_with_fastctx(
        existing,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    let second = patch_config_with_fastctx(
        &first,
        relative_model_catalog_path(),
        None,
        Some(Path::new("/tmp/codey")),
        false,
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.matches(CODEY_FASTCTX_GUIDANCE).count(), 1);
    let document = first.parse::<DocumentMut>().unwrap();
    let guidance = document["developer_instructions"].as_str().unwrap();
    assert!(guidance.contains("`mcp__codey_fastctx__inspect_local_file`"));
    assert!(guidance.contains("`mcp__codey_fastctx__grep`"));
    assert!(guidance.contains("`mcp__codey_fastctx__glob`"));
    assert!(guidance.contains("`mcp__codey_fastctx__replace`"));
    assert!(guidance.contains("Use CodeGraph only for semantic symbols"));
    assert!(guidance.contains("Batch 2-32 known text files or ranges"));
    assert!(guidance.contains("Start broad grep with `files_with_matches`"));
    assert!(guidance.contains("FastCtx is a direct-only tool namespace"));
    assert!(guidance.contains("never transparently retry a write"));
    assert!(guidance.contains("use `tool_search` when deferred"));
    assert!(!guidance.contains("list_mcp_resources"));
    assert!(!guidance.contains("read_mcp_resource"));
    assert!(!guidance.contains("Write-Output"));
    for stale_guidance in &CODEY_FASTCTX_GUIDANCE_VERSIONS[1..] {
        assert!(!guidance.contains(stale_guidance));
    }
    assert_eq!(
        document["features"]["code_mode"]["direct_only_tool_namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["mcp__existing", "mcp__codey_fastctx"]
    );
    assert_eq!(
        document["tool_output_token_limit"].as_integer(),
        Some(CODEY_FASTCTX_HOST_TOKEN_LIMIT)
    );
    assert_eq!(document["features"]["hooks"].as_bool(), Some(true));
    // The FastCtx route hook itself is delivered via the runtime hooks.json,
    // never through the TOML document.
    assert!(document.get("hooks").is_none());
    assert!(!first.contains(crate::fastctx_route_gate::HOOK_ARGUMENT));
}

#[test]
fn fast_context_tools_normalize_and_keep_direct_only_namespace_in_inline_tables() {
    for existing in [
        r#"
features = { code_mode = { direct_only_tool_namespaces = ["mcp__existing", "mcp__codey_fastctx"] }, user_flag = true }
"#,
        r#"
[features]
code_mode = { direct_only_tool_namespaces = ["mcp__existing", "mcp__codey_fastctx"] }
user_flag = true
"#,
    ] {
        let result = patch_config_with_fastctx(
            existing,
            relative_model_catalog_path(),
            None,
            Some(Path::new("/tmp/codey")),
            false,
        )
        .unwrap();
        let document = result.parse::<DocumentMut>().unwrap();
        let namespaces = direct_only_tool_namespaces(&document).unwrap();

        assert_eq!(
            namespaces
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            vec!["mcp__existing", "mcp__codey_fastctx"]
        );
        assert_eq!(
            document["features"]["user_flag"].as_bool(),
            Some(true),
            "inline feature fields must be preserved"
        );
    }
}

#[test]
fn subagent_optimization_writes_public_agents_schema_and_migrates_legacy_threads() {
    let existing = r#"
[agents]
max_threads = 6
max_depth = 1
interrupt_message = true
custom_setting = "preserved"

[features.multi_agent_v2]
enabled = false
max_concurrent_threads_per_session = 2
default_subagent_model = "legacy-v2-model"
default_subagent_reasoning_effort = "low"
custom_setting = "preserved"
subagent_developer_instructions = "Preserve my subagent guidance."
root_agent_usage_hint_text = "Preserve my root usage hint."
multi_agent_mode_hint_text = "Require explicit requests."

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "echo preserve-user-hook"
"#;
    let result = patch_config_with_fastctx_mode(
        existing,
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "gpt-5.6-sol",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();
    let agents = document["agents"].as_table().unwrap();
    let multi_agent = document["features"]["multi_agent_v2"].as_table().unwrap();

    assert_eq!(agents["interrupt_message"].as_bool(), Some(true));
    assert_eq!(agents["custom_setting"].as_str(), Some("preserved"));
    assert_eq!(agents["enabled"].as_bool(), Some(true));
    assert_eq!(
        agents["max_concurrent_threads_per_session"].as_integer(),
        Some(DEFAULT_SUBAGENT_MAX_CONCURRENCY)
    );
    assert_eq!(
        agents["default_subagent_model"].as_str(),
        Some("gpt-5.6-sol")
    );
    assert_eq!(
        agents["default_subagent_reasoning_effort"].as_str(),
        Some("high")
    );
    assert_eq!(multi_agent["enabled"].as_bool(), Some(true));
    assert_eq!(multi_agent["wait_agent_enabled"].as_bool(), Some(true));
    assert_eq!(
        multi_agent["hide_spawn_agent_metadata"].as_bool(),
        Some(true)
    );
    assert_eq!(
        multi_agent["expose_spawn_agent_model_overrides"].as_bool(),
        Some(false)
    );
    assert_eq!(multi_agent["tool_namespace"].as_str(), Some("agents"));
    assert_eq!(
        multi_agent["min_wait_timeout_ms"].as_integer(),
        Some(10_000)
    );
    assert_eq!(
        multi_agent["default_wait_timeout_ms"].as_integer(),
        Some(30_000)
    );
    assert_eq!(
        multi_agent["max_wait_timeout_ms"].as_integer(),
        Some(120_000)
    );
    assert_eq!(multi_agent["custom_setting"].as_str(), Some("preserved"));
    assert_eq!(document["features"]["hooks"].as_bool(), Some(true));
    assert_eq!(
        multi_agent["subagent_developer_instructions"].as_str(),
        Some("Preserve my subagent guidance.")
    );
    let root_usage_hint = multi_agent["root_agent_usage_hint_text"].as_str().unwrap();
    assert!(root_usage_hint.contains("Preserve my root usage hint."));
    assert!(root_usage_hint.contains(ROOT_AGENT_COLLABORATION_USAGE_HINT));
    assert_eq!(
        multi_agent["multi_agent_mode_hint_text"].as_str(),
        Some(ROOT_AGENT_MULTI_AGENT_MODE_HINT)
    );
    // Hook definitions are delivered through the runtime hooks.json; the
    // effective TOML keeps only the user's own hook group untouched.    let pre_tool_use = document["hooks"]["PreToolUse"]
        .as_array_of_tables()
        .unwrap();
    assert_eq!(pre_tool_use.len(), 1);
    assert_eq!(
        pre_tool_use.get(0).unwrap()["hooks"]
            .as_array_of_tables()
            .unwrap()
            .get(0)
            .unwrap()["command"]
            .as_str(),
        Some("echo preserve-user-hook")
    );
    assert!(
        !document
            .to_string()
            .contains(crate::subagent_gate::HOOK_ARGUMENT)
    );
    assert!(document["hooks"].get("state").is_none());}
#[test]
fn subagent_optimization_keeps_explicit_agents_concurrency_over_legacy_max_threads() {
    let existing = r#"
[agents]
max_threads = 6
max_concurrent_threads_per_session = 4

[features.multi_agent_v2]
max_concurrent_threads_per_session = 2
default_subagent_model = "legacy-v2-model"
default_subagent_reasoning_effort = "low"
"#;
    let result = patch_config_with_fastctx_mode(
        existing,
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "gpt-5.6-sol",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["agents"]["max_concurrent_threads_per_session"].as_integer(),
        Some(4)
    );
    assert!(
        document["features"]["multi_agent_v2"]
            .as_table()
            .unwrap()
            .get("max_concurrent_threads_per_session")
            .is_none()
    );
    assert!(
        document["features"]["multi_agent_v2"]
            .as_table()
            .unwrap()
            .get("default_subagent_model")
            .is_none()
    );
    assert!(
        document["features"]["multi_agent_v2"]
            .as_table()
            .unwrap()
            .get("default_subagent_reasoning_effort")
            .is_none()
    );
}

#[test]
fn subagent_optimization_migrates_the_previous_codey_owned_concurrency_default() {
    let existing = r#"
[agents]
max_concurrent_threads_per_session = 2

[agents.codey_quick_scan]
description = "Codey quick scan"
config_file = "/tmp/codey-quick-scan.toml"

[agents.codey_worker]
description = "Codey worker"
config_file = "/tmp/codey-worker.toml"

[features.multi_agent_v2]
enabled = true
tool_namespace = "agents"
"#;
    let result = patch_config_with_fastctx_mode(
        existing,
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "gpt-5.6-sol",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["agents"]["max_concurrent_threads_per_session"].as_integer(),
        Some(DEFAULT_SUBAGENT_MAX_CONCURRENCY)
    );}

#[test]
fn subagent_optimization_keeps_a_standalone_explicit_lower_concurrency() {
    let result = patch_config_with_fastctx_mode(
        "[agents]\nmax_concurrent_threads_per_session = 2\n",
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "gpt-5.6-sol",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap();
    let document = result.parse::<DocumentMut>().unwrap();

    assert_eq!(
        document["agents"]["max_concurrent_threads_per_session"].as_integer(),
        Some(2)
    );
}

#[test]
fn subagent_optimization_defaults_concurrency_for_new_or_invalid_configs() {
    for existing in [
        "",
        "[agents]\nmax_threads = \"invalid\"\n",
        "[agents]\nmax_threads = 0\n",
        "[agents]\nmax_concurrent_threads_per_session = \"invalid\"\n",
        "[agents]\nmax_concurrent_threads_per_session = 0\n",
    ] {
        let result = patch_config_with_fastctx_mode(
            existing,
            RouterPatchOptions {
                config_path: Path::new("/tmp/codey-codex/config.toml"),
                catalog_dir: Path::new("model-catalogs"),
                model_catalog_path: relative_model_catalog_path(),
                default_model: None,
                fastctx_command: None,
                subagent_optimization: true,
                subagent_model: "gpt-5.6-sol",
                subagent_reasoning_effort: "high",
            },
        )
        .unwrap();
        let document = result.parse::<DocumentMut>().unwrap();

        assert_eq!(
            document["agents"]["max_concurrent_threads_per_session"].as_integer(),
            Some(DEFAULT_SUBAGENT_MAX_CONCURRENCY)
        );
    }
}

#[test]
fn subagent_optimization_accepts_dynamic_model_ids_and_rejects_empty_values() {
    let patched = patch_config_with_fastctx_mode(
        "",
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "gpt-5.6-luna",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap();
    let document = patched.parse::<DocumentMut>().unwrap();
    assert_eq!(
        document["agents"]["default_subagent_model"].as_str(),
        Some("gpt-5.6-luna")
    );

    let error = patch_config_with_fastctx_mode(
        "",
        RouterPatchOptions {
            config_path: Path::new("/tmp/codey-codex/config.toml"),
            catalog_dir: Path::new("model-catalogs"),
            model_catalog_path: relative_model_catalog_path(),
            default_model: None,
            fastctx_command: None,
            subagent_optimization: true,
            subagent_model: "   ",
            subagent_reasoning_effort: "high",
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("子代理模型不能为空"));
}
#[test]
fn current_provider_defaults_to_builtin_openai_without_creating_config() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();

    assert_eq!(
        current_model_provider(&home).unwrap(),
        BUILTIN_OPENAI_PROVIDER_ID
    );
    assert!(!home.join("config.toml").exists());
}

#[test]
fn preserves_the_builtin_openai_provider_without_adding_a_global_alias() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = "model_provider = \"openai\"\nmodel = \"gpt-5\"\n";
    fs::write(home.join("config.toml"), original).unwrap();

    assert_eq!(
        current_model_provider(&home).unwrap(),
        BUILTIN_OPENAI_PROVIDER_ID
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn preserves_the_current_legacy_global_official_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        home.join("config.toml"),
        r#"model_provider = "codey_global"

[model_providers.codey_global]
name = "OpenAI (Codey Global)"
base_url = "https://chatgpt.com/backend-api/codex/"
wire_api = "responses"
requires_openai_auth = true
"#,
    )
    .unwrap();

    let original = fs::read_to_string(home.join("config.toml")).unwrap();
    assert_eq!(
        current_model_provider(&home).unwrap(),
        LEGACY_GLOBAL_PROVIDER_ID
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn preserves_a_reserved_current_provider_without_rewriting_its_config() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = r#"model_provider = "openai"

[model_providers.openai]
name = "Private Relay"
base_url = "https://relay.example/v1"
wire_api = "chat"
requires_openai_auth = true
experimental_bearer_token = "sk-existing"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert_eq!(
        current_model_provider(&home).unwrap(),
        BUILTIN_OPENAI_PROVIDER_ID
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn preserves_an_existing_global_provider_api_address() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = r#"model_provider = "codey_global"

[model_providers.codey_global]
name = "Private Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "sk-existing"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert_eq!(
        current_model_provider(&home).unwrap(),
        LEGACY_GLOBAL_PROVIDER_ID
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn preserves_a_legacy_official_global_provider_with_extra_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = r#"model_provider = "codey_global"

[model_providers.codey_global]
name = "OpenAI (Codey Global)"
base_url = "https://chatgpt.com/backend-api/codex/"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "must-not-be-removed"
"#;
    fs::write(home.join("config.toml"), original).unwrap();

    assert_eq!(
        current_model_provider(&home).unwrap(),
        LEGACY_GLOBAL_PROVIDER_ID
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn preserves_an_existing_non_reserved_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    fs::create_dir_all(&home).unwrap();
    let original = "model_provider = \"company\"\n\n[model_providers.company]\nname = \"Company\"\nbase_url = \"https://example.com/v1\"\n";
    fs::write(home.join("config.toml"), original).unwrap();
    assert_eq!(
        current_model_provider(&home).unwrap(),
        "company".to_string()
    );
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        original
    );
}

#[test]
fn isolated_runtime_overrides_do_not_redirect_the_request_destination() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let state_dir = temp.path().join("codey-state");
    let marker = state_dir.join("codex-lease.json");
    let backup_root = state_dir.join("codex-backups");
    fs::create_dir_all(&home).unwrap();
    let original_config = br#"model_provider = "relay"

[model_providers.relay]
name = "User Relay"
base_url = "https://upstream-secret.example/v1"
wire_api = "responses"
experimental_bearer_token = "upstream-secret-token"
"#;
    fs::write(home.join("config.toml"), original_config).unwrap();

    let applied = apply_isolated_runtime_router_config(
        &home,
        RouterApplyOptions {
            model_catalog_path: relative_model_catalog_path(),
            default_model: Some("provider-model"),
            fastctx_command: None,
            subagent_optimization: false,
            subagent_model: DEFAULT_SUBAGENT_MODEL,
            subagent_reasoning_effort: DEFAULT_SUBAGENT_REASONING_EFFORT,
            subagent_roles: None,
            subagent_catalog: Default::default(),
            marker: &marker,
            backup_root: &backup_root,
        },
    )
    .unwrap();

    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original_config);
    let rendered = applied.runtime_config_overrides.join("\n");
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry == "model=\"provider-model\""),
        "missing model runtime override"
    );
    assert!(!rendered.contains("model_provider="));
    assert!(!rendered.contains("model_providers.codey_router"));
    assert!(!rendered.contains("codey_router"));
    assert!(!rendered.contains("upstream-secret.example"));
    assert!(!rendered.contains("upstream-secret-token"));
    assert!(!rendered.contains("openai_base_url="));
}

#[test]
fn isolated_fastctx_installs_route_hook_without_subagent_optimization() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let state_dir = temp.path().join("codey-state");
    let marker = state_dir.join("codex-lease.json");
    let backup_root = state_dir.join("codex-backups");
    fs::create_dir_all(&home).unwrap();
    let original_config = br#"model_provider = "relay"

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
"#;
    fs::write(home.join("config.toml"), original_config).unwrap();

    let applied = apply_isolated_test_runtime_config(
        &home,
        false,
        Some(Path::new("/opt/codey/codey-fastctx")),
        false,
        DEFAULT_SUBAGENT_MODEL,
        DEFAULT_SUBAGENT_REASONING_EFFORT,
        None,
        &marker,
        &backup_root,
    )
    .unwrap();

    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry == "features.hooks=true")
    );
    assert_eq!(
        applied
            .runtime_config_overrides
            .iter()
            .filter(|entry| entry.starts_with("hooks.state."))
            .count(),
        FASTCTX_ROUTE_HOOKS.len()
    );
    assert!(
        !applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry.starts_with("features.multi_agent_v2."))
    );
    let hooks: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("hooks.json")).unwrap()).unwrap();
    let groups = hooks["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(
        groups[0]["matcher"].as_str(),
        Some(crate::fastctx_route_gate::HOOK_MATCHER)
    );
    assert!(
        groups[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(crate::fastctx_route_gate::HOOK_ARGUMENT)
    );

    assert!(restore_runtime_config_at(&home, &marker, true).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original_config);
    assert!(!home.join("hooks.json").exists());
}

#[test]
fn isolated_runtime_constraints_stay_out_of_config_and_restore_hooks() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let state_dir = temp.path().join("codey-state");
    let marker = state_dir.join("codex-lease.json");
    let backup_root = state_dir.join("codex-backups");
    fs::create_dir_all(&home).unwrap();
    let original_config = br#"model_provider = "relay"
model_catalog_json = "/user/catalog.json"
developer_instructions = "Keep the user's instructions."

[model_providers.relay]
name = "Relay"
base_url = "https://relay.example/v1"
wire_api = "responses"
"#;
    let original_hooks = br#"{
  "description": "User hooks",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/usr/bin/true", "timeout": 2 }
        ]
      }
    ]
  }
}
"#;
    fs::write(home.join("config.toml"), original_config).unwrap();
    fs::write(home.join("hooks.json"), original_hooks).unwrap();
    let seeded_constraints_dir = state_dir.join(CODEY_CONSTRAINTS_DIR);
    fs::create_dir_all(&seeded_constraints_dir).unwrap();
    fs::write(
        seeded_constraints_dir.join(CODEY_ROOT_INSTRUCTIONS_FILE),
        SUBAGENT_GUIDANCE,
    )
    .unwrap();
    fs::write(
        seeded_constraints_dir.join(CODEY_FASTCTX_INSTRUCTIONS_FILE),
        CODEY_FASTCTX_GUIDANCE,
    )
    .unwrap();
    fs::write(
        seeded_constraints_dir.join(CODEY_COLLABORATION_HINT_FILE),
        ROOT_AGENT_COLLABORATION_USAGE_HINT,
    )
    .unwrap();
    let applied = apply_isolated_test_runtime_config(
        &home,
        true,
        Some(Path::new("/opt/codey/codey-fastctx")),
        true,
        "gpt-5.6-mini",
        "high",
        None,
        &marker,
        &backup_root,
    )
    .unwrap();

    assert_eq!(fs::read(home.join("config.toml")).unwrap(), original_config);
    assert!(!home.join("AGENTS.md").exists());
    assert!(!home.join("agents/default.toml").exists());
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry.starts_with("developer_instructions="))
    );
    let expected_catalog = marker
        .with_file_name("model-catalogs")
        .join(crate::model_catalog_store::DERIVED_CATALOG_FILE_NAME);
    let model_catalog_override = applied
        .runtime_config_overrides
        .iter()
        .find(|entry| entry.starts_with("model_catalog_json="))
        .unwrap()
        .parse::<DocumentMut>()
        .unwrap();
    assert_eq!(
        model_catalog_override["model_catalog_json"].as_str(),
        Some(expected_catalog.to_string_lossy().as_ref())
    );
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry == "agents.enabled=true")
    );
    assert!(applied.runtime_config_overrides.iter().any(|entry| entry
        == &format!(
            "agents.max_concurrent_threads_per_session={DEFAULT_SUBAGENT_MAX_CONCURRENCY}"
        )));
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry == "agents.default_subagent_model=\"gpt-5.6-mini\"")
    );
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry.starts_with("agents.default.config_file="))
    );
    for role in SUBAGENT_ROLE_IDS {
        for field in ["config_file", "description"] {
            let key = format!("agents.{role}.{field}");
            assert!(
                applied
                    .runtime_config_overrides
                    .iter()
                    .any(|entry| entry.starts_with(&format!("{key}="))),
                "missing runtime override {key}"
            );
        }
    }
    let pre_tool_state_key = format!("{}:pre_tool_use:1:0", home.join("hooks.json").display());
    let pre_tool_prefix = format!(
        "hooks.state.{}.trusted_hash=",
        toml_string_literal(&pre_tool_state_key)
    );
    let hook_commands =
        crate::subagent_gate::hook_commands_for(crate::subagent_gate::COMBINED_HOOK_ARGUMENT)
            .unwrap();
    let selected_command = if cfg!(windows) {
        hook_commands.command_windows.as_str()
    } else {
        hook_commands.command.as_str()
    };
    let expected_pre_tool_hash = crate::subagent_gate::hook_trust_hash(
        "pre_tool_use",
        Some("*"),
        selected_command,
        crate::subagent_gate::HOOK_TIMEOUT_SECONDS,
    );
    assert!(applied.runtime_config_overrides.iter().any(|entry| {
        entry.starts_with(&pre_tool_prefix) && entry.contains(&expected_pre_tool_hash)
    }));
    assert!(
        applied
            .runtime_config_overrides
            .iter()
            .any(|entry| entry.starts_with("mcp_servers.codey_fastctx.command="))
    );
    for required_key in [
        "model_catalog_json",
        "desktop.enabled-reasoning-efforts",
        "service_tier",
        "developer_instructions",
        "mcp_servers.codey_fastctx.command",
        "mcp_servers.codey_fastctx.args",
        "mcp_servers.codey_fastctx.startup_timeout_sec",
        "mcp_servers.codey_fastctx.tool_timeout_sec",
        "mcp_servers.codey_fastctx.env.FASTCTX_TOKEN_BUDGET",
        "mcp_servers.codey_fastctx.env.FASTCTX_GREP_TOKEN_BUDGET",
        "mcp_servers.codey_fastctx.env.FASTCTX_GLOB_TOKEN_BUDGET",
        "mcp_servers.codey_subagent_control.command",
        "mcp_servers.codey_subagent_control.args",
        "mcp_servers.codey_subagent_control.startup_timeout_sec",
        "mcp_servers.codey_subagent_control.tool_timeout_sec",
        "mcp_servers.codey_subagent_control.enabled_tools",
        "mcp_servers.codey_subagent_control.disabled_tools",
        "mcp_servers.codey_subagent_control.tools.resolve_batch.approval_mode",
        "mcp_servers.codey_subagent_control.tools.prepare_delegation.approval_mode",
        "tool_output_token_limit",
        "agents.enabled",
        "agents.max_concurrent_threads_per_session",
        "agents.default_subagent_model",
        "agents.default_subagent_reasoning_effort",
        "agents.default.config_file",
        "agents.default.description",
        "features.multi_agent_v2.enabled",
        "features.multi_agent_v2.wait_agent_enabled",
        "features.multi_agent_v2.hide_spawn_agent_metadata",
        "features.multi_agent_v2.expose_spawn_agent_model_overrides",
        "features.multi_agent_v2.tool_namespace",
        "features.multi_agent_v2.min_wait_timeout_ms",
        "features.multi_agent_v2.default_wait_timeout_ms",
        "features.multi_agent_v2.max_wait_timeout_ms",
        "features.multi_agent_v2.root_agent_usage_hint_text",
        "features.multi_agent_v2.multi_agent_mode_hint_text",
        "features.multi_agent_v2.subagent_developer_instructions",
        "features.code_mode.direct_only_tool_namespaces",
        "features.hooks",
    ] {
        assert!(
            applied
                .runtime_config_overrides
                .iter()
                .any(|entry| entry.starts_with(&format!("{required_key}="))),
            "missing runtime override {required_key}"
        );
    }
    assert_eq!(
        applied
            .runtime_config_overrides
            .iter()
            .filter(|entry| entry.starts_with("hooks.state."))
            .count(),
        SUBAGENT_GATE_HOOKS.len()
    );
    assert_eq!(
        applied
            .runtime_config_overrides
            .iter()
            .filter(|entry| entry.starts_with(CODEY_WSL_ONLY_OVERRIDE_PREFIX))
            .count(),
        if cfg!(windows) {
            SUBAGENT_GATE_HOOKS.len()
        } else {
            0
        }
    );
    for runtime_override in &applied.runtime_config_overrides {
        let runtime_override = runtime_override
            .strip_prefix(CODEY_WSL_ONLY_OVERRIDE_PREFIX)
            .unwrap_or(runtime_override);
        runtime_override
            .parse::<DocumentMut>()
            .unwrap_or_else(|error| {
                panic!("invalid runtime override {runtime_override:?}: {error}")
            });
    }

    let hooks: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("hooks.json")).unwrap()).unwrap();
    assert_eq!(hooks["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
    assert_eq!(
        hooks["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str(),
        Some("/usr/bin/true")
    );
    assert_eq!(
        hooks["hooks"]["PreToolUse"][1]["matcher"].as_str(),
        Some("*")
    );
    assert!(
        hooks["hooks"]["PreToolUse"][1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(crate::subagent_gate::COMBINED_HOOK_ARGUMENT)
    );
    let windows_command = hooks["hooks"]["PreToolUse"][1]["hooks"][0]["commandWindows"]
        .as_str()
        .unwrap();
    assert!(windows_command.starts_with("& '"), "{windows_command}");
    assert!(windows_command.contains(crate::subagent_gate::COMBINED_HOOK_ARGUMENT));
    for event in [
        "PostToolUse",
        "UserPromptSubmit",
        "SubagentStart",
        "SubagentStop",
        "Stop",
        "SessionEnd",
    ] {
        assert_eq!(
            hooks["hooks"][event].as_array().unwrap().len(),
            1,
            "{event}"
        );
    }
    assert_eq!(
        hooks["hooks"]["PostToolUse"][0]["matcher"].as_str(),
        Some(crate::subagent_orchestrator::POST_TOOL_HOOK_MATCHER)
    );
    let constraints_dir = state_dir.join(CODEY_CONSTRAINTS_DIR);
    assert_eq!(
        fs::read_to_string(constraints_dir.join(CODEY_ROOT_INSTRUCTIONS_FILE)).unwrap(),
        SUBAGENT_GUIDANCE
    );
    assert!(constraints_dir.join(CODEY_ROOT_INSTRUCTIONS_FILE).exists());
    assert!(
        constraints_dir
            .join(CODEY_FASTCTX_INSTRUCTIONS_FILE)
            .exists()
    );
    assert_eq!(
        fs::read_to_string(constraints_dir.join(CODEY_FASTCTX_INSTRUCTIONS_FILE)).unwrap(),
        CODEY_FASTCTX_GUIDANCE
    );
    assert_eq!(
        fs::read_to_string(constraints_dir.join(CODEY_COLLABORATION_HINT_FILE)).unwrap(),
        ROOT_AGENT_COLLABORATION_USAGE_HINT
    );
    assert!(constraints_dir.join(CODEY_SUBAGENT_SOURCE_FILE).exists());
    assert!(
        constraints_dir
            .join(CODEY_RUNTIME_DEFAULT_AGENT_FILE)
            .exists()
    );
    for role in SUBAGENT_ROLE_IDS {
        let runtime_path = if role == SUBAGENT_ROLE_DEFAULT {
            constraints_dir.join(CODEY_RUNTIME_DEFAULT_AGENT_FILE)
        } else {
            assert!(
                constraints_dir
                    .join(CODEY_SUBAGENT_SOURCES_DIR)
                    .join(format!("{role}.toml"))
                    .exists(),
                "missing editable source for {role}"
            );
            constraints_dir
                .join(CODEY_RUNTIME_AGENTS_DIR)
                .join(format!("{role}.toml"))
        };
        let runtime = fs::read_to_string(runtime_path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert_eq!(runtime["name"].as_str(), Some(role));
        assert_eq!(runtime["model"].as_str(), Some("gpt-5.6-mini"));
        assert_eq!(runtime["model_reasoning_effort"].as_str(), Some("high"));
    }

    let switched_config = [
        original_config.as_slice(),
        b"\n# User changed persistent config\n",
    ]
    .concat();
    fs::write(home.join("config.toml"), &switched_config).unwrap();
    assert!(restore_runtime_config_at(&home, &marker, true).unwrap());
    assert_eq!(fs::read(home.join("config.toml")).unwrap(), switched_config);
    assert_eq!(fs::read(home.join("hooks.json")).unwrap(), original_hooks);
    assert!(!marker.exists());
    fs::write(home.join("config.toml"), original_config).unwrap();

    fs::write(
        constraints_dir.join(CODEY_ROOT_INSTRUCTIONS_FILE),
        "CUSTOM ROOT CONSTRAINT",
    )
    .unwrap();
    fs::write(
        constraints_dir.join(CODEY_FASTCTX_INSTRUCTIONS_FILE),
        "CUSTOM FASTCTX CONSTRAINT",
    )
    .unwrap();
    fs::write(
        constraints_dir.join(CODEY_COLLABORATION_HINT_FILE),
        "CUSTOM COLLABORATION HINT",
    )
    .unwrap();
    fs::write(
        constraints_dir.join(CODEY_SUBAGENT_SOURCE_FILE),
        r#"name = "default"
description = "Custom editable subagent"
developer_instructions = "CUSTOM SUBAGENT CONSTRAINT"
"#,
    )
    .unwrap();

    let reapplied = apply_isolated_test_runtime_config(
        &home,
        true,
        Some(Path::new("/opt/codey/codey-fastctx")),
        true,
        "gpt-5.6-mini",
        "high",
        None,
        &marker,
        &backup_root,
    )
    .unwrap();
    let developer_override = reapplied
        .runtime_config_overrides
        .iter()
        .find(|entry| entry.starts_with("developer_instructions="))
        .unwrap()
        .parse::<DocumentMut>()
        .unwrap();
    let developer_instructions = developer_override["developer_instructions"]
        .as_str()
        .unwrap();
    assert!(developer_instructions.contains("CUSTOM ROOT CONSTRAINT"));
    assert!(developer_instructions.contains("CUSTOM FASTCTX CONSTRAINT"));
    assert!(!developer_instructions.contains(SUBAGENT_GUIDANCE));
    assert!(!developer_instructions.contains(CODEY_FASTCTX_GUIDANCE));
    let collaboration_override = reapplied
        .runtime_config_overrides
        .iter()
        .find(|entry| entry.starts_with("features.multi_agent_v2.root_agent_usage_hint_text="))
        .unwrap()
        .parse::<DocumentMut>()
        .unwrap();
    assert_eq!(
        collaboration_override["features"]["multi_agent_v2"]["root_agent_usage_hint_text"].as_str(),
        Some("CUSTOM COLLABORATION HINT")
    );
    let runtime_agent =
        fs::read_to_string(constraints_dir.join(CODEY_RUNTIME_DEFAULT_AGENT_FILE)).unwrap();
    assert!(runtime_agent.contains("CUSTOM SUBAGENT CONSTRAINT"));
    assert!(runtime_agent.contains("CUSTOM FASTCTX CONSTRAINT"));
    assert!(restore_runtime_config_at(&home, &marker, true).unwrap());
}

#[test]
fn pre_isolation_lease_is_released_without_the_removed_restore_path() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("codex-home");
    let state_dir = temp.path().join("state");
    let marker = state_dir.join("codex-lease.json");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(home.join("AGENTS.md"), "user guidance\n").unwrap();
    // Shape written by releases before isolated runtime constraints existed:
    // the removed fields are simply ignored by serde.
    fs::write(
        &marker,
        serde_json::to_vec_pretty(&serde_json::json!({
            "backupDir": state_dir.join("backups").join("1-1"),
            "localRouterApplied": false,
            "subagentOptimizationApplied": true,
            "isolatedRuntimeConstraints": false,
            "independentPromptSources": false,
            "originalAgentsMdExists": true,
            "runtimeHooksApplied": false
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(restore_runtime_config_at(&home, &marker, false).unwrap());
    assert!(!marker.exists(), "legacy lease marker must be released");
    assert_eq!(
        fs::read_to_string(home.join("AGENTS.md")).unwrap(),
        "user guidance\n",
        "user files are left untouched"
    );
}
