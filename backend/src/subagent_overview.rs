use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::config::CodeyConfig;
use crate::subagent::rules::{self, RuleSource};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overview {
    status: &'static str,
    platform_supported: bool,
    enabled: bool,
    scope_guard_enabled: bool,
    concurrency: Concurrency,
    hooks: Vec<Hook>,
    documents: Vec<Document>,
    rules: Rules,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Concurrency {
    read_only: usize,
    writable: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct Hook {
    pub(crate) event: &'static str,
    pub(crate) purpose: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct Document {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) source: &'static str,
    pub(crate) path: Option<PathBuf>,
    pub(crate) format: &'static str,
    pub(crate) content: String,
}

impl Document {
    pub(crate) fn builtin(
        id: &str,
        title: &str,
        description: &str,
        format: &'static str,
        content: &str,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: description.into(),
            source: "builtin",
            path: None,
            format,
            content: content.into(),
        }
    }

    pub(crate) fn into_override(mut self) -> Self {
        self.source = "override";
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_config::{plan_runtime_agent_files, runtime_subagent_roles};

    fn document<'a>(overview: &'a Overview, id: &str) -> &'a Document {
        overview
            .documents
            .iter()
            .find(|document| document.id == id)
            .unwrap()
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
        for document in &overview.documents {
            let expected = if document.id.ends_with("-hint") {
                "override"
            } else {
                "builtin"
            };
            assert_eq!(document.source, expected, "{}", document.id);
            assert!(document.path.is_none());
        }
        assert_eq!(overview.rules.source, "builtin");
        assert!(overview.rules.path.is_none());
        assert_eq!(overview.rules.items.len(), rules::embedded().rules.len());
        assert_eq!(
            overview.platform_supported,
            cfg!(any(windows, target_os = "macos"))
        );
        assert!(!overview.enabled);
        assert!(!overview.scope_guard_enabled);
        assert!(overview.hooks.is_empty());
        assert_eq!(overview.concurrency.read_only, 3);
        assert_eq!(overview.concurrency.writable, 2);
    }

    #[test]
    fn file_sources_and_role_documents_match_runtime_plans() {
        let temp = tempfile::tempdir().unwrap();
        let constraints = temp.path().join("codex-constraints");
        std::fs::create_dir(&constraints).unwrap();
        let root_path = constraints.join("root-instructions.md");
        let root_text = "自定义主代理指导\r\n保留原始空白。\n\n";
        std::fs::write(&root_path, root_text).unwrap();
        std::fs::write(constraints.join("collaboration-hint.md"), "自定义协作提示").unwrap();
        let role_source = crate::codex_config_guidance::DEFAULT_AGENT_CONFIG
            .replace("你是通用子代理", "你是本项目的通用子代理");
        std::fs::write(constraints.join("subagent.toml"), role_source).unwrap();
        let mut config = CodeyConfig {
            subagent_optimization: true,
            scope_guard: true,
            ..Default::default()
        };
        config
            .subagent_roles
            .get_mut(crate::config::SUBAGENT_ROLE_WORKER)
            .unwrap()
            .enabled = false;
        config
            .subagent_roles
            .get_mut(crate::config::SUBAGENT_ROLE_VISUAL_WORKER)
            .unwrap()
            .enabled = false;
        let overview = build(temp.path(), &temp.path().join("missing-codex"), &config).unwrap();
        let root = document(&overview, "root-guidance");
        assert_eq!(root.content, root_text);
        assert_eq!(root.source, "file");
        assert_eq!(root.path.as_deref(), Some(root_path.as_path()));
        assert_eq!(
            document(&overview, "collaboration-hint").content,
            "自定义协作提示"
        );
        assert_eq!(
            document(&overview, "no-writable-guidance").content,
            crate::codex_config_guidance::NO_WRITABLE_SUBAGENT_GUIDANCE
        );
        let roles = runtime_subagent_roles(
            Some(&config.subagent_roles),
            &config.subagent_model,
            &config.subagent_reasoning_effort,
        );
        let plans = plan_runtime_agent_files(&constraints, &roles, None).unwrap();
        assert_eq!(
            overview
                .documents
                .iter()
                .filter(|document| document.id.starts_with("role:"))
                .count(),
            plans.len()
        );
        for plan in plans {
            let document = document(&overview, &format!("role:{}", plan.registration.role));
            assert_eq!(document.content.as_bytes(), plan.contents);
            assert_eq!(document.path, plan.source_path);
        }
        assert!(!constraints.join("agents").exists());
        assert!(!constraints.join("runtime").exists());
        assert!(!temp.path().join("missing-codex").exists());
        assert_eq!(std::fs::read_dir(&constraints).unwrap().count(), 3);
        assert_eq!(
            overview
                .hooks
                .iter()
                .filter(|hook| hook.event == "SubagentStart")
                .count(),
            1
        );
        assert!(
            overview
                .hooks
                .iter()
                .any(|hook| hook.event == "SessionStart")
        );
        let json = serde_json::to_value(overview).unwrap();
        let mut keys = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "concurrency",
                "documents",
                "enabled",
                "hooks",
                "platformSupported",
                "rules",
                "scopeGuardEnabled",
                "status"
            ]
        );
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
        assert_eq!(overview.rules.source, "file");
        assert_eq!(overview.rules.path, Some(path.clone()));
        assert_eq!(
            overview.rules.items[0].explanation,
            live.rules[0].explanation
        );
        assert_eq!(
            overview.rules.items[0].definition,
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
            .get_mut(crate::config::SUBAGENT_ROLE_WORKER)
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
        assert_eq!(plans.len(), crate::config::SUBAGENT_ROLE_IDS.len() - 1);
        assert_eq!(
            overview
                .documents
                .iter()
                .filter(|document| document.id.starts_with("role:"))
                .count(),
            plans.len()
        );
        assert!(
            !overview
                .documents
                .iter()
                .any(|document| document.id == "role:codey_worker")
        );
        for plan in plans {
            let contents =
                &document(&overview, &format!("role:{}", plan.registration.role)).content;
            assert_eq!(contents.as_bytes(), plan.contents);
            let parsed: toml_edit::DocumentMut = contents.parse().unwrap();
            assert_eq!(parsed["model"].as_str(), Some("shared-model"));
        }
        assert_eq!(config, original);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
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
    let state_root = std::path::absolute(codex_home)?.join(crate::subagent_gate::STATE_DIRECTORY);
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
    Ok(Overview {
        status: "ok",
        platform_supported: cfg!(any(windows, target_os = "macos")),
        enabled: config.subagent_optimization,
        scope_guard_enabled: config.scope_guard,
        concurrency: Concurrency {
            read_only: crate::subagent_orchestrator::READ_ONLY_CONCURRENCY_LIMIT,
            writable: crate::subagent_orchestrator::WRITE_OR_MIXED_CONCURRENCY_LIMIT,
        },
        hooks: crate::codex_config::runtime_overview_hooks(config),
        documents: crate::codex_config::runtime_overview_documents(&codey_home, config)?,
        rules: Rules {
            source: if from_file { "file" } else { "builtin" },
            path: from_file.then(|| rules::live_rule_path(&state_root)),
            items,
        },
    })
}
