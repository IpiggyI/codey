use super::*;
use crate::subagent_overview::{
    Channel, Content, HookEvent, Item, Override, Reader, RoleEntry, Template, TriggerItems,
};

/// 按启动流程的同一套函数规划概览内容，只读取文件，不创建或改写任何文件。
pub(crate) fn runtime_overview_items(
    codey_home: &Path,
    codex_home: &Path,
    config: &crate::config::CodeyConfig,
) -> Result<TriggerItems> {
    let constraints = codey_home.join(CODEY_CONSTRAINTS_DIR);
    let catalog = crate::subagent_policy::catalog_snapshot_for_config(config);
    let canonical = |model: &str| crate::launcher::runtime_subagent_model(model, &catalog);
    let mut enabled_roles = runtime_subagent_roles(
        Some(&config.subagent_roles),
        &config.subagent_model,
        &config.subagent_reasoning_effort,
    );
    for selection in enabled_roles.values_mut() {
        selection.model = canonical(&selection.model);
    }
    let registered_roles = SUBAGENT_ROLE_IDS.map(str::to_string);
    let registration_roles = runtime_registration_roles(
        &enabled_roles,
        &registered_roles,
        &canonical(&config.subagent_model),
        &config.subagent_reasoning_effort,
    )?;
    let fastctx = (config.fast_context_tools && fastctx_server_command().is_ok())
        .then_some(CODEY_FASTCTX_GUIDANCE);
    let roles = SUBAGENT_ROLE_IDS
        .into_iter()
        .map(|role| role_entry(&constraints, role, &registration_roles[role], fastctx))
        .collect::<Result<Vec<_>>>()?;
    let policy = runtime_policy_item(
        codex_home,
        &constraints,
        &enabled_roles,
        &registration_roles,
        fastctx,
        &catalog,
    );
    Ok(TriggerItems {
        master: master_items(
            &constraints,
            &canonical(&config.subagent_model),
            &config.subagent_reasoning_effort,
        )?,
        roles,
        scope_guard: scope_guard_items(),
        gate: gate_items(policy),
    })
}

fn role_entry(
    constraints: &Path,
    role: &str,
    selection: &SubagentRoleConfig,
    fastctx: Option<&str>,
) -> Result<RoleEntry> {
    let single = BTreeMap::from([(role.to_string(), selection.clone())]);
    let source_path = runtime_agent_source_path(constraints, role);
    let mut entry = RoleEntry {
        id: role.to_string(),
        destination: runtime_agent_path(constraints, role),
        template: Template {
            exists: source_path.exists(),
            path: source_path,
        },
        overrides: Vec::new(),
        model: selection.model.clone(),
        reasoning_effort: selection.reasoning_effort.clone(),
        content: None,
        error: None,
    };
    let plan = match plan_runtime_agent_files(constraints, &single, fastctx) {
        Ok(mut plans) => plans.pop().context("子代理角色规划结果为空")?,
        Err(error) => {
            entry.error = Some(format!("{error:#}"));
            return Ok(entry);
        }
    };
    if let Some(source_path) = plan.source_path {
        entry.template = Template {
            exists: source_path.exists(),
            path: source_path,
        };
    }
    entry.destination = plan.registration.config_file().to_path_buf();
    entry.overrides = vec![
        Override::new(
            "注册角色配置文件",
            format!("agents.{role}.config_file"),
            Some(entry.destination.display().to_string()),
        ),
        Override::new(
            "角色说明",
            format!("agents.{role}.description"),
            Some(plan.registration.description().to_string()),
        ),
    ];
    entry.content = Some(Content {
        reader: Reader::Codex,
        format: "toml",
        text: String::from_utf8(plan.contents).context("子代理角色文档不是 UTF-8")?,
    });
    Ok(entry)
}

fn master_items(
    constraints: &Path,
    default_model: &str,
    default_reasoning_effort: &str,
) -> Result<Vec<Item>> {
    let collaboration_path = constraints.join(CODEY_COLLABORATION_HINT_FILE);
    let collaboration_exists = collaboration_path.exists();
    let collaboration = root_agent_collaboration_usage_hint();
    let mut collaboration_item = Item::new(
        "collaboration-hint",
        "协作工具提示",
        "说明主代理使用子代理工具时的约定。追加在 Codex 配置里已有的协作工具提示之后。",
        Channel::Override,
    );
    collaboration_item.template = Some(Template {
        path: collaboration_path,
        exists: collaboration_exists,
    });
    collaboration_item.overrides = vec![Override::new(
        "协作工具提示（追加）",
        "features.multi_agent_v2.root_agent_usage_hint_text".into(),
        None,
    )];
    collaboration_item.content = Some(Content {
        reader: Reader::Codex,
        format: "text",
        text: append_constraint_text("", &collaboration),
    });

    let mut mode_item = Item::new(
        "multi-agent-hint",
        "多代理模式提示",
        "替换 Codex 自带的多代理模式提示。",
        Channel::Override,
    );
    mode_item.overrides = vec![Override::new(
        "多代理模式提示（替换）",
        "features.multi_agent_v2.multi_agent_mode_hint_text".into(),
        None,
    )];
    mode_item.content = Some(Content {
        reader: Reader::Codex,
        format: "text",
        text: ROOT_AGENT_MULTI_AGENT_MODE_HINT.into(),
    });

    let mut settings_item = Item::new(
        "codex-agent-settings",
        "Codex 子代理设置",
        "打开 Codex 的子代理功能，并设定等待时长和派生方式。只在本次启动生效，不改写你的 Codex 配置文件。",
        Channel::Override,
    );
    settings_item.overrides = codex_agent_settings(default_model, default_reasoning_effort)?;
    Ok(vec![collaboration_item, mode_item, settings_item])
}

/// 取值来自启动时同一个 `enable_subagent_optimization`，概览不另抄一份常量。
fn codex_agent_settings(model: &str, reasoning_effort: &str) -> Result<Vec<Override>> {
    let mut document = DocumentMut::new();
    enable_subagent_optimization(&mut document, model, reasoning_effort, None)?;
    let settings: [(&[&str], &str); 12] = [
        (&["agents", "enabled"], "开启 Codex 子代理"),
        (
            &["agents", "max_concurrent_threads_per_session"],
            "每个会话同时运行的子代理上限",
        ),
        (&["agents", "default_subagent_model"], "通用子代理的模型"),
        (
            &["agents", "default_subagent_reasoning_effort"],
            "通用子代理的思考强度",
        ),
        (&["features", "multi_agent_v2", "enabled"], "开启多代理功能"),
        (
            &["features", "multi_agent_v2", "wait_agent_enabled"],
            "允许主代理等待子代理",
        ),
        (
            &["features", "multi_agent_v2", "hide_spawn_agent_metadata"],
            "隐藏派生子代理时的附加信息",
        ),
        (
            &[
                "features",
                "multi_agent_v2",
                "expose_spawn_agent_model_overrides",
            ],
            "派生时允许临时更换模型",
        ),
        (
            &["features", "multi_agent_v2", "tool_namespace"],
            "子代理工具的名称前缀",
        ),
        (
            &["features", "multi_agent_v2", "min_wait_timeout_ms"],
            "单次等待子代理的最短时长（毫秒）",
        ),
        (
            &["features", "multi_agent_v2", "default_wait_timeout_ms"],
            "单次等待子代理的默认时长（毫秒）",
        ),
        (
            &["features", "multi_agent_v2", "max_wait_timeout_ms"],
            "单次等待子代理的最长时长（毫秒）",
        ),
    ];
    settings
        .into_iter()
        .map(|(path, label)| {
            let key = path.join(".");
            let mut value = document_item_at(&document, path)
                .and_then(toml_edit::Item::as_value)
                .with_context(|| format!("Codex 子代理设置缺少 {key}"))?
                .clone();
            value.decor_mut().clear();
            let mut value = value.to_string();
            if key == "agents.max_concurrent_threads_per_session" {
                value = format!("沿用 Codex 配置；未设置时为 {value}");
            }
            Ok(Override::new(label, key, Some(value)))
        })
        .collect()
}

fn hook_overrides() -> Vec<Override> {
    vec![
        Override::new(
            "开启 Codex 钩子功能",
            "features.hooks".into(),
            Some("true".into()),
        ),
        Override::new(
            "注册 Codey 钩子",
            "hooks".into(),
            Some("内联定义，不写入 hooks.json".into()),
        ),
    ]
}

fn hook_events(specs: &[CodeyHookSpec], purpose: fn(&str) -> &'static str) -> Vec<HookEvent> {
    specs
        .iter()
        .map(|spec| HookEvent {
            event: spec.toml_event,
            name: hook_event_name(spec.toml_event),
            purpose: purpose(spec.toml_event),
        })
        .collect()
}

fn hook_event_name(event: &str) -> &'static str {
    match event {
        "SessionStart" => "会话开始时",
        "PreToolUse" => "调用工具前",
        "PostToolUse" => "调用工具后",
        "UserPromptSubmit" => "收到用户输入时",
        "SubagentStart" => "子代理启动时",
        "SubagentStop" => "子代理停止时",
        "Stop" => "主代理结束回合时",
        "SessionEnd" => "会话结束时",
        _ => unreachable!("未知的 Codey 钩子事件"),
    }
}

fn gate_hook_purpose(event: &str) -> &'static str {
    match event {
        "PreToolUse" => "检查子代理角色的权限和并发上限。",
        "PostToolUse" => "更新子代理状态，决定是否继续等待汇合。",
        "UserPromptSubmit" => "核对子代理活动状态，推进故障恢复。",
        "SubagentStart" => "登记子代理身份，校验角色策略。",
        "SubagentStop" => "结算子代理的活动状态，释放其占用。",
        "Stop" => "检查子代理是否都已结算。",
        "SessionEnd" => "清理本会话的子代理运行状态。",
        _ => unreachable!("未知的子代理门禁钩子事件"),
    }
}

fn scope_guard_hook_purpose(event: &str) -> &'static str {
    match event {
        "SessionStart" => {
            "新建、清空和压缩后的主会话开始时注入完整规则；恢复的会话沿用历史中的副本。"
        }
        "SubagentStart" => "新启动的子代理开始时注入短版规则。",
        _ => unreachable!("未知的防御性编程控制钩子事件"),
    }
}

fn scope_guard_items() -> Vec<Item> {
    let item = |spec: &CodeyHookSpec,
                id: &'static str,
                title: &'static str,
                description: &'static str,
                text: &str| {
        let mut item = Item::new(id, title, description, Channel::Hook);
        item.events = hook_events(std::slice::from_ref(spec), scope_guard_hook_purpose);
        item.overrides = hook_overrides();
        item.content = Some(Content {
            reader: Reader::Codex,
            format: "markdown",
            text: text.into(),
        });
        item
    };
    vec![
        item(
            &SCOPE_GUARD_HOOKS[0],
            "scope-guard-root",
            "主会话规则",
            "钩子把规则作为附加上下文交给主代理。",
            crate::scope_guard::ROOT_GUIDANCE,
        ),
        item(
            &SCOPE_GUARD_HOOKS[1],
            "scope-guard-child",
            "子代理规则",
            "钩子把规则作为附加上下文交给子代理。",
            crate::scope_guard::CHILD_GUIDANCE,
        ),
    ]
}

fn gate_items(policy: Item) -> Vec<Item> {
    let mut hooks = Item::new(
        "gate-hooks",
        "门禁钩子",
        "每个事件都调用 Codey 检查程序，按下方门禁规则放行或拦截。同时开启 FastCtx 上下文工具时，调用工具前还会检查 FastCtx 工具的用法。",
        Channel::Hook,
    );
    hooks.events = hook_events(&SUBAGENT_GATE_HOOKS, gate_hook_purpose);
    hooks.overrides = hook_overrides();
    vec![hooks, policy]
}

/// 内容由启动时提交策略所用的同一个生成函数给出；规划失败只记在这一项上。
fn runtime_policy_item(
    codex_home: &Path,
    constraints: &Path,
    roles: &BTreeMap<String, SubagentRoleConfig>,
    registration_roles: &BTreeMap<String, SubagentRoleConfig>,
    fastctx: Option<&str>,
    catalog: &crate::subagent_policy::SubagentCatalogSnapshot,
) -> Item {
    let mut policy = Item::new(
        "runtime-policy",
        "子代理身份记录",
        "记录本次启动启用的角色、模型、思考强度和角色配置文件的校验值，门禁据此核对子代理身份。思考强度同样可能在启动时按模型目录调整。",
        Channel::File,
    );
    policy.destination = Some(crate::subagent_gate::runtime_subagent_policy_paths(codex_home).0);
    let contents =
        plan_runtime_agent_files(constraints, registration_roles, fastctx).and_then(|plans| {
            crate::subagent_gate::runtime_subagent_policy_bytes(
                roles,
                &runtime_agent_plan_hashes(&plans),
                catalog,
            )
        });
    match contents.and_then(|bytes| String::from_utf8(bytes).context("子代理身份记录不是 UTF-8"))
    {
        Ok(text) => {
            policy.content = Some(Content {
                format: "json",
                reader: Reader::Codey,
                text,
            });
        }
        Err(error) => policy.error = Some(format!("{error:#}")),
    }
    policy
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SUBAGENT_ROLE_WORKER;

    #[test]
    fn runtime_policy_content_is_the_file_launch_writes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex-home");
        let codey_home = temp.path().join("codey-state");
        let marker = codey_home.join("codex-lease.json");
        fs::create_dir_all(&home).unwrap();
        let mut config = crate::config::CodeyConfig {
            subagent_optimization: true,
            ..Default::default()
        };
        config
            .subagent_roles
            .get_mut(SUBAGENT_ROLE_WORKER)
            .unwrap()
            .enabled = false;
        // 与启动器相同：目录快照取自当前设置，而不是测试辅助函数的空快照。
        let applied = apply_isolated_runtime_router_config(
            &home,
            RouterApplyOptions {
                model_catalog_path: None,
                default_model: None,
                fastctx_command: None,
                subagent_optimization: true,
                scope_guard: true,
                subagent_model: &config.subagent_model,
                subagent_reasoning_effort: &config.subagent_reasoning_effort,
                subagent_roles: Some(&config.subagent_roles),
                subagent_catalog: crate::subagent_policy::catalog_snapshot_for_config(&config),
                marker: &marker,
                backup_root: &codey_home.join("codex-backups"),
            },
        )
        .unwrap();
        let (policy_path, _) = crate::subagent_gate::runtime_subagent_policy_paths(&home);
        let written = fs::read(&policy_path).unwrap();

        let items = runtime_overview_items(&codey_home, &home, &config).unwrap();
        let policy = items
            .gate
            .iter()
            .find(|item| item.id == "runtime-policy")
            .unwrap();
        assert_eq!(policy.destination.as_deref(), Some(policy_path.as_path()));
        assert!(policy.error.is_none());
        let content = policy.content.as_ref().unwrap();
        assert_eq!(content.reader, Reader::Codey);
        assert_eq!(content.text.as_bytes(), written);
        let policy: serde_json::Value = serde_json::from_slice(&written).unwrap();
        assert!(policy["roles"].get(SUBAGENT_ROLE_WORKER).is_none());
        for role in &items.roles {
            assert_eq!(
                role.content.as_ref().unwrap().text.as_bytes(),
                fs::read(&role.destination).unwrap()
            );
        }
        for master in &items.master {
            if let Some(content) = &master.content {
                let key = &master.overrides[0].key;
                let entry = applied
                    .runtime_config_overrides
                    .iter()
                    .find(|entry| entry.starts_with(&format!("{key}=")))
                    .unwrap();
                let document: DocumentMut = format!("text={}", entry.split_once('=').unwrap().1)
                    .parse()
                    .unwrap();
                assert_eq!(
                    document["text"].as_str().unwrap().as_bytes(),
                    content.text.as_bytes()
                );
                if let Some(template) = &master.template {
                    assert_eq!(fs::read(&template.path).unwrap(), content.text.as_bytes());
                }
            }
        }
        let hooks = applied
            .runtime_config_overrides
            .iter()
            .find(|entry| entry.starts_with("hooks="))
            .unwrap();
        assert!(hooks.contains(crate::scope_guard::HOOK_ARGUMENT));
        assert_eq!(
            items.scope_guard[0]
                .content
                .as_ref()
                .unwrap()
                .text
                .as_bytes(),
            crate::scope_guard::ROOT_GUIDANCE.as_bytes()
        );
        assert_eq!(
            items.scope_guard[1]
                .content
                .as_ref()
                .unwrap()
                .text
                .as_bytes(),
            crate::scope_guard::CHILD_GUIDANCE.as_bytes()
        );
    }
}
