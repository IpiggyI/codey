use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::config::{CodeyConfig, SubagentRoleConfig};
use crate::subagent::rules::{self, RuleSource};

/// 只读概览：按触发条件分组列出 Codey 启动 Codex 时为子代理交付的内容。
/// 内容按已保存的设置生成；未启用的角色也按启用后的样子规划，由前端标明未生效。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overview {
    status: &'static str,
    platform_supported: bool,
    saved: Saved,
    master: Vec<Item>,
    roles: Vec<RoleEntry>,
    scope_guard: Vec<Item>,
    gate: Gate,
}

/// 生成概览所依据的已保存设置，供前端与页面草稿比对。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    subagent_optimization: bool,
    scope_guard: bool,
    roles: BTreeMap<String, SubagentRoleConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Gate {
    items: Vec<Item>,
    concurrency: Concurrency,
    rules: Rules,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Concurrency {
    read_only: usize,
    writable: usize,
}

pub(crate) struct TriggerItems {
    pub(crate) master: Vec<Item>,
    pub(crate) roles: Vec<RoleEntry>,
    pub(crate) scope_guard: Vec<Item>,
    pub(crate) gate: Vec<Item>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Channel {
    File,
    Override,
    Hook,
}

/// 可编辑模板的位置；`exists` 为 false 时启动用内置内容创建它。
#[derive(Debug, Serialize)]
pub(crate) struct Template {
    pub(crate) path: PathBuf,
    pub(crate) exists: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct Override {
    pub(crate) label: &'static str,
    pub(crate) key: String,
    pub(crate) value: Option<String>,
}

impl Override {
    pub(crate) fn new(label: &'static str, key: String, value: Option<String>) -> Self {
        Self { label, key, value }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct HookEvent {
    pub(crate) event: &'static str,
    pub(crate) name: &'static str,
    pub(crate) purpose: &'static str,
}

/// 内容原文由谁读取：交给 Codex 的提示与配置，或只供 Codey 门禁读取的记录。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reader {
    Codex,
    Codey,
}

#[derive(Debug, Serialize)]
pub(crate) struct Content {
    pub(crate) format: &'static str,
    pub(crate) reader: Reader,
    pub(crate) text: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct Item {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) description: &'static str,
    pub(crate) channel: Channel,
    pub(crate) destination: Option<PathBuf>,
    pub(crate) template: Option<Template>,
    pub(crate) overrides: Vec<Override>,
    pub(crate) events: Vec<HookEvent>,
    pub(crate) content: Option<Content>,
    pub(crate) error: Option<String>,
}

impl Item {
    pub(crate) fn new(
        id: &'static str,
        title: &'static str,
        description: &'static str,
        channel: Channel,
    ) -> Self {
        Self {
            id,
            title,
            description,
            channel,
            destination: None,
            template: None,
            overrides: Vec::new(),
            events: Vec::new(),
            content: None,
            error: None,
        }
    }
}

/// 一个子代理角色的交付计划。不带标题：显示名称由前端角色列表提供。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoleEntry {
    pub(crate) id: String,
    pub(crate) destination: PathBuf,
    pub(crate) template: Template,
    pub(crate) overrides: Vec<Override>,
    pub(crate) model: String,
    pub(crate) reasoning_effort: String,
    pub(crate) content: Option<Content>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Rules {
    source: &'static str,
    path: Option<PathBuf>,
    items: Vec<Rule>,
}

#[derive(Debug, Serialize)]
struct Rule {
    id: String,
    explanation: String,
    definition: String,
}

pub(crate) fn build(
    codey_home: &Path,
    codex_home: &Path,
    config: &CodeyConfig,
) -> Result<Overview> {
    let codey_home = std::path::absolute(codey_home)?;
    let codex_home = std::path::absolute(codex_home)?;
    let state_root = codex_home.join(crate::subagent_gate::STATE_DIRECTORY);
    let loaded = rules::load_read_only(&state_root)?;
    let from_file = loaded.source == RuleSource::Live;
    let items = loaded
        .rules
        .rules
        .iter()
        .map(|rule| {
            Ok(Rule {
                id: rule.id.clone(),
                explanation: rule.explanation.clone(),
                definition: serde_json::to_string_pretty(rule)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let planned = crate::codex_config::runtime_overview_items(&codey_home, &codex_home, config)?;
    Ok(Overview {
        status: "ok",
        platform_supported: cfg!(any(windows, target_os = "macos")),
        saved: Saved {
            subagent_optimization: config.subagent_optimization,
            scope_guard: config.scope_guard,
            roles: config.subagent_roles.clone(),
        },
        master: planned.master,
        roles: planned.roles,
        scope_guard: planned.scope_guard,
        gate: Gate {
            items: planned.gate,
            concurrency: Concurrency {
                read_only: crate::subagent_orchestrator::READ_ONLY_CONCURRENCY_LIMIT,
                writable: crate::subagent_orchestrator::WRITE_OR_MIXED_CONCURRENCY_LIMIT,
            },
            rules: Rules {
                source: if from_file { "file" } else { "builtin" },
                path: from_file.then(|| rules::live_rule_path(&state_root)),
                items,
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_config::{plan_runtime_agent_files, runtime_subagent_roles};
    use crate::config::{
        SUBAGENT_ROLE_DEFAULT, SUBAGENT_ROLE_IDS, SUBAGENT_ROLE_VISUAL_WORKER, SUBAGENT_ROLE_WORKER,
    };

    fn item<'a>(items: &'a [Item], id: &str) -> &'a Item {
        items.iter().find(|item| item.id == id).unwrap()
    }

    fn role<'a>(overview: &'a Overview, id: &str) -> &'a RoleEntry {
        overview.roles.iter().find(|role| role.id == id).unwrap()
    }

    /// 递归记录目录下每个条目的路径与内容，用于确认概览前后完全一致。
    fn snapshot(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
        let mut entries = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path.clone());
                    entries.push((path, None));
                } else {
                    let contents = std::fs::read(&path).unwrap();
                    entries.push((path, Some(contents)));
                }
            }
        }
        entries.sort();
        entries
    }

    fn config_without_writable_roles() -> CodeyConfig {
        let mut config = CodeyConfig {
            subagent_optimization: true,
            scope_guard: true,
            ..Default::default()
        };
        for role in [SUBAGENT_ROLE_WORKER, SUBAGENT_ROLE_VISUAL_WORKER] {
            config.subagent_roles.get_mut(role).unwrap().enabled = false;
        }
        config
    }

    #[test]
    fn missing_home_uses_builtins_without_creating_anything() {
        let temp = tempfile::tempdir().unwrap();
        let codey_home = temp.path().join("codey");
        let codex_home = temp.path().join("codex");
        let config = CodeyConfig::default();
        let overview = build(&codey_home, &codex_home, &config).unwrap();
        assert!(!codey_home.exists());
        assert!(!codex_home.exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        let constraints = codey_home.join("codex-constraints");
        for item in overview.master.iter().chain(&overview.scope_guard) {
            if let Some(template) = &item.template {
                assert!(!template.exists, "{}", item.id);
                assert!(template.path.starts_with(&constraints), "{}", item.id);
            }
            // 没有正文的项必须把每个覆盖值直接写明。
            assert!(
                item.content.is_some() || item.overrides.iter().all(|entry| entry.value.is_some()),
                "{}",
                item.id
            );
        }
        assert_eq!(overview.roles.len(), SUBAGENT_ROLE_IDS.len());
        for entry in &overview.roles {
            assert!(!entry.template.exists, "{}", entry.id);
            assert!(entry.error.is_none(), "{}", entry.id);
            assert!(entry.content.is_some(), "{}", entry.id);
        }
        assert_eq!(overview.gate.rules.source, "builtin");
        assert!(overview.gate.rules.path.is_none());
        assert_eq!(
            overview.gate.rules.items.len(),
            rules::embedded().rules.len()
        );
        assert_eq!(
            item(&overview.gate.items, "runtime-policy").destination,
            Some(crate::subagent_gate::runtime_subagent_policy_paths(&codex_home).0)
        );
        assert_eq!(
            overview.platform_supported,
            cfg!(any(windows, target_os = "macos"))
        );
        assert!(!overview.saved.subagent_optimization);
        assert!(!overview.saved.scope_guard);
        assert_eq!(overview.gate.concurrency.read_only, 3);
        assert_eq!(overview.gate.concurrency.writable, 2);
    }

    #[test]
    fn every_role_appears_once_with_launch_destination_and_template() {
        let temp = tempfile::tempdir().unwrap();
        let constraints = temp.path().join("codex-constraints");
        std::fs::create_dir_all(constraints.join("agents")).unwrap();
        let worker_template = constraints.join("agents/codey_worker.toml");
        let worker_source = crate::codex_config_guidance::WORKER_AGENT_CONFIG.replacen(
            "description = \"",
            "description = \"本项目：",
            1,
        );
        std::fs::write(&worker_template, &worker_source).unwrap();
        let config = config_without_writable_roles();
        let overview = build(temp.path(), &temp.path().join("codex"), &config).unwrap();

        let ids = overview
            .roles
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, SUBAGENT_ROLE_IDS, "每个角色恰好一条，启用与否都在");
        for entry in &overview.roles {
            let selection = config.subagent_roles[&entry.id].clone();
            let single = BTreeMap::from([(
                entry.id.clone(),
                SubagentRoleConfig {
                    enabled: true,
                    ..selection
                },
            )]);
            let plan = plan_runtime_agent_files(&constraints, &single, None)
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(
                entry.destination,
                plan.registration.config_file(),
                "{}",
                entry.id
            );
            assert_eq!(
                entry.content.as_ref().unwrap().text.as_bytes(),
                plan.contents,
                "{}",
                entry.id
            );
            let expected_template = if entry.id == SUBAGENT_ROLE_DEFAULT {
                constraints.join("subagent.toml")
            } else {
                constraints
                    .join("agents")
                    .join(format!("{}.toml", entry.id))
            };
            assert_eq!(entry.template.path, expected_template, "{}", entry.id);
            assert_eq!(
                entry.template.exists,
                entry.id == SUBAGENT_ROLE_WORKER,
                "{}",
                entry.id
            );
            assert_eq!(
                entry.overrides[0].key,
                format!("agents.{}.config_file", entry.id)
            );
            assert_eq!(
                entry.overrides[0].value.as_deref(),
                Some(
                    plan.registration
                        .config_file()
                        .display()
                        .to_string()
                        .as_str()
                )
            );
            assert_eq!(
                entry.overrides[1].value.as_deref(),
                Some(plan.registration.description())
            );
        }
        let worker = role(&overview, SUBAGENT_ROLE_WORKER);
        assert!(!config.subagent_roles[SUBAGENT_ROLE_WORKER].enabled);
        assert!(
            worker.overrides[1]
                .value
                .as_deref()
                .unwrap()
                .starts_with("本项目：")
        );
        assert!(
            worker
                .destination
                .ends_with("codex-constraints/runtime/agents/codey_worker.toml")
        );
        assert!(
            role(&overview, SUBAGENT_ROLE_DEFAULT)
                .destination
                .ends_with("codex-constraints/runtime/default-agent.toml")
        );
    }

    #[test]
    fn root_guidance_follows_the_enabled_roles() {
        let temp = tempfile::tempdir().unwrap();
        let constraints = temp.path().join("codex-constraints");
        std::fs::create_dir(&constraints).unwrap();
        let root_path = constraints.join("root-instructions.md");
        let root_text = "自定义主代理指导\r\n保留原始空白。\n\n";
        std::fs::write(&root_path, root_text).unwrap();
        std::fs::write(constraints.join("collaboration-hint.md"), "自定义协作提示").unwrap();
        let config = config_without_writable_roles();
        let overview = build(temp.path(), &temp.path().join("codex"), &config).unwrap();
        let root = item(&overview.master, "root-guidance");
        assert_eq!(root.channel, Channel::Override);
        let template = root.template.as_ref().unwrap();
        assert_eq!(template.path, root_path);
        assert!(template.exists);
        let text = &root.content.as_ref().unwrap().text;
        assert!(text.starts_with("自定义主代理指导"));
        assert!(text.ends_with(crate::codex_config_guidance::NO_WRITABLE_SUBAGENT_GUIDANCE.trim()));
        assert_eq!(root.overrides[0].key, "developer_instructions");
        assert_eq!(
            item(&overview.master, "collaboration-hint")
                .content
                .as_ref()
                .unwrap()
                .text,
            "自定义协作提示"
        );

        let enabled = build(
            temp.path(),
            &temp.path().join("codex"),
            &CodeyConfig {
                subagent_optimization: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            item(&enabled.master, "root-guidance")
                .content
                .as_ref()
                .unwrap()
                .text,
            root_text
        );
    }

    #[test]
    fn codex_agent_settings_use_the_launch_values() {
        let temp = tempfile::tempdir().unwrap();
        let config = CodeyConfig {
            subagent_optimization: true,
            ..Default::default()
        };
        let overview = build(
            &temp.path().join("codey"),
            &temp.path().join("codex"),
            &config,
        )
        .unwrap();
        let settings = item(&overview.master, "codex-agent-settings");
        let value = |key: &str| {
            settings
                .overrides
                .iter()
                .find(|entry| entry.key == key)
                .unwrap()
                .value
                .clone()
                .unwrap()
        };
        assert_eq!(value("agents.enabled"), "true");
        assert_eq!(
            value("agents.max_concurrent_threads_per_session"),
            "沿用 Codex 配置；未设置时为 3"
        );
        assert_eq!(
            value("agents.default_subagent_model"),
            format!("\"{}\"", config.subagent_model)
        );
        assert_eq!(
            value("agents.default_subagent_reasoning_effort"),
            format!("\"{}\"", config.subagent_reasoning_effort)
        );
        assert_eq!(
            value("features.multi_agent_v2.default_wait_timeout_ms"),
            "30000"
        );
        assert_eq!(
            value("features.multi_agent_v2.expose_spawn_agent_model_overrides"),
            "false"
        );
    }

    #[test]
    fn hooks_are_listed_per_trigger_regardless_of_saved_state() {
        let temp = tempfile::tempdir().unwrap();
        let overview = build(
            &temp.path().join("codey"),
            &temp.path().join("codex"),
            &CodeyConfig::default(),
        )
        .unwrap();
        let gate = item(&overview.gate.items, "gate-hooks");
        assert_eq!(
            gate.events
                .iter()
                .map(|event| event.event)
                .collect::<Vec<_>>(),
            [
                "PreToolUse",
                "PostToolUse",
                "UserPromptSubmit",
                "SubagentStart",
                "SubagentStop",
                "Stop",
                "SessionEnd"
            ]
        );
        let scope_events = overview
            .scope_guard
            .iter()
            .flat_map(|item| item.events.iter().map(|event| event.event))
            .collect::<Vec<_>>();
        assert_eq!(scope_events, ["SessionStart", "SubagentStart"]);
        assert_eq!(
            item(&overview.scope_guard, "scope-guard-root")
                .content
                .as_ref()
                .unwrap()
                .text,
            crate::scope_guard::ROOT_GUIDANCE
        );
        for item in overview.scope_guard.iter().chain([gate]) {
            assert_eq!(item.channel, Channel::Hook);
            assert!(item.overrides.iter().any(|entry| entry.key == "hooks"));
        }
    }

    #[test]
    fn broken_template_only_marks_its_own_role() {
        let temp = tempfile::tempdir().unwrap();
        let agents = temp.path().join("codex-constraints/agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("codey_visual_worker.toml"), "name = [").unwrap();
        let config = config_without_writable_roles();
        let overview = build(temp.path(), &temp.path().join("codex"), &config).unwrap();
        let broken = role(&overview, SUBAGENT_ROLE_VISUAL_WORKER);
        assert!(broken.error.is_some());
        assert!(broken.content.is_none());
        assert!(broken.template.exists);
        assert!(
            broken
                .destination
                .ends_with("codex-constraints/runtime/agents/codey_visual_worker.toml")
        );
        assert!(
            overview
                .roles
                .iter()
                .filter(|entry| entry.id != SUBAGENT_ROLE_VISUAL_WORKER)
                .all(|entry| entry.error.is_none() && entry.content.is_some())
        );
    }

    #[test]
    fn titles_never_use_raw_role_ids() {
        let temp = tempfile::tempdir().unwrap();
        let overview = build(
            &temp.path().join("codey"),
            &temp.path().join("codex"),
            &config_without_writable_roles(),
        )
        .unwrap();
        let json = serde_json::to_value(&overview).unwrap();
        let mut titles = Vec::new();
        let mut pending = vec![&json];
        while let Some(value) = pending.pop() {
            match value {
                serde_json::Value::Object(map) => {
                    if let Some(title) = map.get("title").and_then(serde_json::Value::as_str) {
                        titles.push(title.to_string());
                    }
                    pending.extend(map.values());
                }
                serde_json::Value::Array(values) => pending.extend(values),
                _ => {}
            }
        }
        assert!(!titles.is_empty());
        for title in titles {
            assert!(
                SUBAGENT_ROLE_IDS.iter().all(|id| !title.contains(id)),
                "{title}"
            );
            assert!(!title.contains("根代理"), "{title}");
        }
        assert!(json["roles"][0].get("title").is_none());
    }

    #[test]
    fn overview_performs_no_writes() {
        let temp = tempfile::tempdir().unwrap();
        let codey_home = temp.path().join("codey");
        let codex_home = temp.path().join("codex");
        let constraints = codey_home.join("codex-constraints");
        std::fs::create_dir_all(constraints.join("agents")).unwrap();
        std::fs::write(constraints.join("root-instructions.md"), "主代理指导").unwrap();
        std::fs::write(
            constraints.join("agents/codey_quick_scan.toml"),
            crate::codex_config_guidance::QUICK_SCAN_AGENT_CONFIG,
        )
        .unwrap();
        let state_root = codex_home.join(crate::subagent_gate::STATE_DIRECTORY);
        std::fs::create_dir_all(&state_root).unwrap();
        std::fs::write(codex_home.join("config.toml"), "model = \"user-model\"\n").unwrap();
        let before = snapshot(temp.path());
        let mut config = config_without_writable_roles();
        config.fast_context_tools = true;
        let original = config.clone();
        build(&codey_home, &codex_home, &config).unwrap();
        assert_eq!(snapshot(temp.path()), before);
        assert_eq!(config, original);
    }

    #[test]
    fn live_rules_are_read_without_creating_last_good_files() {
        let temp = tempfile::tempdir().unwrap();
        let state_root = temp.path().join(crate::subagent_gate::STATE_DIRECTORY);
        std::fs::create_dir(&state_root).unwrap();
        let path = rules::live_rule_path(&state_root);
        let mut live = rules::embedded().clone();
        live.rules[0].explanation = "这是本地规则的中文解释。".into();
        std::fs::write(&path, serde_json::to_vec(&live).unwrap()).unwrap();
        let overview = build(
            &temp.path().join("missing-codey"),
            temp.path(),
            &CodeyConfig::default(),
        )
        .unwrap();
        let loaded = &overview.gate.rules;
        assert_eq!(loaded.source, "file");
        assert_eq!(loaded.path, Some(path.clone()));
        assert_eq!(loaded.items[0].explanation, live.rules[0].explanation);
        assert_eq!(
            loaded.items[0].definition,
            serde_json::to_string_pretty(&live.rules[0]).unwrap()
        );
        assert_eq!(
            rules::load_read_only(&state_root).unwrap().rules.revision,
            live.revision
        );
        assert_eq!(std::fs::read_dir(&state_root).unwrap().count(), 1);
        std::fs::write(&path, "{invalid").unwrap();
        assert!(
            build(
                &temp.path().join("missing-codey"),
                temp.path(),
                &CodeyConfig::default()
            )
            .is_err()
        );
        assert_eq!(std::fs::read_dir(&state_root).unwrap().count(), 1);
        assert!(!temp.path().join("missing-codey").exists());
    }

    #[test]
    fn role_models_use_the_launchers_canonical_names_without_changing_config() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = CodeyConfig {
            subagent_optimization: true,
            subagent_model: "relay/shared-model".into(),
            subagent_roles: crate::config::uniform_subagent_roles("relay/shared-model", "high"),
            ..Default::default()
        };
        config.attach_current_provider_snapshot(
            crate::model_ownership::CurrentProviderSnapshot::from_parts(
                "relay",
                "https://example.test/v1",
                "responses",
                false,
            ),
        );
        let list_key = config.current_model_list_key().unwrap().to_string();
        config
            .upstream_models_by_provider
            .insert(list_key.clone(), vec!["shared-model".into()]);
        config
            .selected_models_by_provider
            .insert(list_key, vec!["shared-model".into()]);
        config
            .subagent_roles
            .get_mut(SUBAGENT_ROLE_WORKER)
            .unwrap()
            .enabled = false;
        let original = config.clone();
        let overview = build(
            &temp.path().join("codey"),
            &temp.path().join("codex"),
            &config,
        )
        .unwrap();
        let catalog = crate::subagent_policy::catalog_snapshot_for_config(&config);
        assert_eq!(
            crate::launcher::runtime_subagent_model(&config.subagent_model, &catalog),
            "shared-model"
        );
        let mut launch_roles = config.subagent_roles.clone();
        for selection in launch_roles.values_mut() {
            selection.model = crate::launcher::runtime_subagent_model(&selection.model, &catalog);
        }
        let enabled_roles = runtime_subagent_roles(
            Some(&launch_roles),
            &crate::launcher::runtime_subagent_model(&config.subagent_model, &catalog),
            &config.subagent_reasoning_effort,
        );
        let plans = plan_runtime_agent_files(
            &temp.path().join("codey/codex-constraints"),
            &enabled_roles,
            None,
        )
        .unwrap();
        assert_eq!(plans.len(), SUBAGENT_ROLE_IDS.len() - 1);
        for plan in plans {
            let entry = role(&overview, &plan.registration.role);
            assert_eq!(
                entry.content.as_ref().unwrap().text.as_bytes(),
                plan.contents
            );
            assert_eq!(entry.model, "shared-model");
        }
        let worker = role(&overview, SUBAGENT_ROLE_WORKER);
        let parsed: toml_edit::DocumentMut = worker.content.as_ref().unwrap().text.parse().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("shared-model"));
        assert_eq!(
            item(&overview.master, "codex-agent-settings")
                .overrides
                .iter()
                .find(|entry| entry.key == "agents.default_subagent_model")
                .unwrap()
                .value
                .as_deref(),
            Some("\"shared-model\"")
        );
        assert_eq!(config, original);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
}
