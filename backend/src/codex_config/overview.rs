use super::*;
use crate::subagent_overview::{Document, Hook};

pub(crate) fn runtime_overview_documents(
    codey_home: &Path,
    config: &crate::config::CodeyConfig,
) -> Result<Vec<Document>> {
    let constraints = codey_home.join(CODEY_CONSTRAINTS_DIR);
    let mut roles = runtime_subagent_roles(
        Some(&config.subagent_roles),
        &config.subagent_model,
        &config.subagent_reasoning_effort,
    );
    let catalog = crate::subagent_policy::catalog_snapshot_for_config(config);
    for selection in roles.values_mut() {
        selection.model = crate::launcher::runtime_subagent_model(&selection.model, &catalog);
    }
    let mut documents = vec![file_document(
        "root-guidance",
        "主代理指导",
        "启用子代理优化后作为本次启动的根代理指令发送；没有可写角色时追加下方提示。",
        &constraints.join(CODEY_ROOT_INSTRUCTIONS_FILE),
        SUBAGENT_GUIDANCE,
    )?];
    let (collaboration, _) = read_constraint_source(
        &constraints.join(CODEY_COLLABORATION_HINT_FILE),
        ROOT_AGENT_COLLABORATION_USAGE_HINT,
    )?;
    documents.push(
        Document::builtin(
            "collaboration-hint",
            "协作工具提示",
            "启用子代理优化后通过 -c 覆盖 features.multi_agent_v2.root_agent_usage_hint_text。",
            "text",
            &append_constraint_text("", &collaboration),
        )
        .into_override(),
    );
    documents.push(
        Document::builtin(
            "multi-agent-hint",
            "多代理模式提示",
            "启用子代理优化后通过 -c 覆盖 features.multi_agent_v2.multi_agent_mode_hint_text。",
            "text",
            ROOT_AGENT_MULTI_AGENT_MODE_HINT,
        )
        .into_override(),
    );
    if !roles.contains_key(SUBAGENT_ROLE_WORKER) && !roles.contains_key(SUBAGENT_ROLE_VISUAL_WORKER)
    {
        documents.push(Document::builtin(
            "no-writable-guidance",
            "无可写子代理提示",
            "启用子代理优化且没有可写角色时，追加到根代理指令。",
            "markdown",
            NO_WRITABLE_SUBAGENT_GUIDANCE,
        ));
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
    for plan in plan_runtime_agent_files(&constraints, &roles, fastctx.as_deref())? {
        let role = &plan.registration.role;
        documents.push(Document {
            id: format!("role:{role}"),
            title: format!("子代理角色：{role}"),
            description: "启用子代理优化后按所选模型和权限生成最终 TOML，通过运行期角色配置文件交给 Codex；来源路径指向可编辑模板。".into(),
            source: if plan.source_path.is_some() { "file" } else { "builtin" },
            path: plan.source_path,
            format: "toml",
            content: String::from_utf8(plan.contents).context("子代理角色文档不是 UTF-8")?,
        });
    }
    documents.push(Document::builtin(
        "scope-guard-root",
        "主会话防御性编程控制",
        "开启防御性编程控制后，由 SessionStart 钩子在新建、清空和压缩后的会话中发送；恢复会话沿用历史副本。",
        "markdown",
        crate::scope_guard::ROOT_GUIDANCE,
    ));
    documents.push(Document::builtin(
        "scope-guard-child",
        "子代理防御性编程控制",
        "开启防御性编程控制后，由 SubagentStart 钩子向新启动的子代理发送。",
        "markdown",
        crate::scope_guard::CHILD_GUIDANCE,
    ));
    Ok(documents)
}

fn file_document(
    id: &str,
    title: &str,
    description: &str,
    path: &Path,
    builtin: &str,
) -> Result<Document> {
    let (content, from_file) = read_constraint_source(path, builtin)?;
    Ok(Document {
        id: id.into(),
        title: title.into(),
        description: description.into(),
        source: if from_file { "file" } else { "builtin" },
        path: from_file.then(|| path.to_path_buf()),
        format: "markdown",
        content,
    })
}

pub(crate) fn runtime_overview_hooks(config: &crate::config::CodeyConfig) -> Vec<Hook> {
    let mut specs = Vec::new();
    if config.subagent_optimization {
        specs.extend_from_slice(&SUBAGENT_GATE_HOOKS);
    }
    if config.fast_context_tools && fastctx_server_command().is_ok() {
        specs.extend_from_slice(&FASTCTX_ROUTE_HOOKS);
    }
    if config.scope_guard {
        specs.extend_from_slice(&SCOPE_GUARD_HOOKS);
    }
    let mut hooks: Vec<Hook> = Vec::new();
    for spec in specs {
        if hooks.iter().any(|hook| hook.event == spec.toml_event) {
            continue;
        }
        let purpose = match spec.toml_event {
            "SessionStart" => "在新建、清空和压缩后的主会话注入防御性编程控制规则。",
            "PreToolUse" => "调用工具前检查已启用的子代理权限、并发和 FastCtx 工具使用规则。",
            "PostToolUse" => "调用工具后更新子代理状态并决定是否继续等待汇合。",
            "UserPromptSubmit" => "收到用户输入时核对子代理活动状态并推进故障恢复。",
            "SubagentStart" if !config.subagent_optimization => {
                "启动子代理时注入防御性编程控制规则。"
            }
            "SubagentStart" if !config.scope_guard => "启动子代理时登记身份并校验角色策略。",
            "SubagentStart" => "启动子代理时登记身份、校验角色策略并注入防御性编程控制规则。",
            "SubagentStop" => "停止子代理时结算活动状态并释放其占用。",
            "Stop" => "结束主代理回合前检查子代理是否已结算。",
            "SessionEnd" => "会话结束时清理本会话的子代理运行状态。",
            _ => unreachable!("未知的 Codey 钩子事件"),
        };
        hooks.push(Hook {
            event: spec.toml_event,
            purpose,
        });
    }
    hooks
}
