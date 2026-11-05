use super::*;
use crate::subagent_overview::{
    Channel, Content, HookEvent, Item, Override, RoleEntry, Template, TriggerItems,
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
    let enabled_roles = runtime_subagent_roles(
        Some(&config.subagent_roles),
        &config.subagent_model,
        &config.subagent_reasoning_effort,
    );
    // 未启用的角色也按启用后的样子规划；回退规则与 runtime_subagent_roles 相同。
    let mut every_role = config.subagent_roles.clone();
    for selection in every_role.values_mut() {
        selection.enabled = true;
    }
    let mut every_role = runtime_subagent_roles(
        Some(&every_role),
        &config.subagent_model,
        &config.subagent_reasoning_effort,
    );
    for selection in every_role.values_mut() {
        selection.model = canonical(&selection.model);
    }
    let fastctx = if config.fast_context_tools && fastctx_server_command().is_ok() {
        let (source, _) = read_constraint_source(
            &constraints.join(CODEY_FASTCTX_INSTRUCTIONS_FILE),
            CODEY_FASTCTX_GUIDANCE,
        )?;
        Some(versioned_constraint_contents(
            source,
            CODEY_FASTCTX_GUIDANCE,
            CODEY_FASTCTX_GUIDANCE_VERSIONS,
        ))
    } else {
        None
    };
    let roles = SUBAGENT_ROLE_IDS
        .into_iter()
        .map(|role| role_entry(&constraints, role, &every_role[role], fastctx.as_deref()))
        .collect::<Result<Vec<_>>>()?;
    Ok(TriggerItems {
        master: master_items(
            &constraints,
            &enabled_roles,
            &canonical(&config.subagent_model),
            &config.subagent_reasoning_effort,
        )?,
        roles,
        scope_guard: scope_guard_items(),
        gate: gate_items(codex_home),
    })
}

fn role_entry(
    constraints: &Path,
    role: &str,
    selection: &SubagentRoleConfig,
    fastctx: Option<&str>,
) -> Result<RoleEntry> {
    // 逐个角色规划：某个角色的模板损坏只影响它自己的条目。
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
    entry.template.exists = plan.source_path.is_some();
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
        format: "toml",
        text: String::from_utf8(plan.contents).context("子代理角色文档不是 UTF-8")?,
    });
    Ok(entry)
}

fn master_items(
    constraints: &Path,
    enabled_roles: &BTreeMap<String, SubagentRoleConfig>,
    default_model: &str,
    default_reasoning_effort: &str,
) -> Result<Vec<Item>> {
    let root_path = constraints.join(CODEY_ROOT_INSTRUCTIONS_FILE);
    let (root, root_exists) = read_constraint_source(&root_path, SUBAGENT_GUIDANCE)?;
    let collaboration_path = constraints.join(CODEY_COLLABORATION_HINT_FILE);
    let (collaboration, collaboration_exists) =
        read_constraint_source(&collaboration_path, ROOT_AGENT_COLLABORATION_USAGE_HINT)?;
    let mut root_item = Item::new(
        "root-guidance",
        "主代理指导",
        "告诉主代理何时派生子代理、如何写任务和如何验收。追加在 Codex 配置里已有的主代理指令之后；没有启用可写角色时，末尾再追加一段「无可写子代理」提示，下方内容已按已保存的角色计算。",
        Channel::Override,
    );
    root_item.template = Some(Template {
        path: root_path,
        exists: root_exists,
    });
    root_item.overrides = vec![Override::new(
        "主代理指令（追加）",
        "developer_instructions".into(),
        None,
    )];
    root_item.content = Some(Content {
        format: "markdown",
        text: runtime_root_instructions_for_roles(&root, enabled_roles),
    });

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
    Ok(vec![
        root_item,
        collaboration_item,
        mode_item,
        settings_item,
    ])
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

fn gate_items(codex_home: &Path) -> Vec<Item> {
    let mut hooks = Item::new(
        "gate-hooks",
        "门禁钩子",
        "每个事件都调用 Codey 检查程序，按下方门禁规则放行或拦截。同时开启 FastCtx 上下文工具时，调用工具前还会检查 FastCtx 工具的用法。",
        Channel::Hook,
    );
    hooks.events = hook_events(&SUBAGENT_GATE_HOOKS, gate_hook_purpose);
    hooks.overrides = hook_overrides();
    let mut policy = Item::new(
        "runtime-policy",
        "子代理身份记录",
        "记录本次启动启用的角色、模型和角色配置文件的校验值，门禁据此核对子代理身份。这里不展示文件内容。",
        Channel::File,
    );
    policy.destination = Some(crate::subagent_gate::runtime_subagent_policy_paths(codex_home).0);
    vec![hooks, policy]
}
