import { useEffect, useState, type ReactNode } from "react";
import { IconChevronRight } from "@tabler/icons-react";

import { invoke } from "../api";
import { errorText } from "../appUtils";
import type {
  Config,
  SubagentRoleConfig,
  SubagentRoleId,
  SubagentRuntimeChannel,
  SubagentRuntimeContent,
  SubagentRuntimeItem,
  SubagentRuntimeOverride,
  SubagentRuntimeOverview,
  SubagentRuntimeRole,
  SubagentRuntimeTemplate,
} from "../App.types";
import { Badge, Button } from "./ui";

// 名称与页面上的开关保持一致：一个概念只用一个名字。
const MASTER_SWITCH = "Codey 子代理角色与调度增强";
const SCOPE_GUARD_SWITCH = "防御性编程控制";
// 内部兼容角色，角色列表里没有它；README 称之为「通用」角色。
const GENERAL_ROLE: SubagentRuntimeRoleLabel = { id: "default", name: "通用子代理", access: "readOnly" };

const CHANNEL_LABELS: Record<SubagentRuntimeChannel, string> = {
  file: "写入文件",
  override: "启动参数覆盖",
  hook: "钩子注入",
};
const FORMAT_LABELS: Record<SubagentRuntimeContent["format"], string> = {
  markdown: "Markdown",
  toml: "TOML",
  json: "JSON",
  text: "文本",
};

export type SubagentRuntimeRoleLabel = {
  id: SubagentRoleId;
  name: string;
  access: "readOnly" | "write";
};

/** 页面上的草稿设置；概览内容来自已保存的设置，两者不同时要标出来。 */
export type SubagentRuntimeDraft = Pick<
  Config,
  "subagentOptimization" | "scopeGuard" | "subagentRoles" | "subagentModel" | "subagentReasoningEffort"
>;

export type SubagentRuntimeOverviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; overview: SubagentRuntimeOverview };

type OverviewContext = {
  draft: SubagentRuntimeDraft;
  saved: SubagentRuntimeOverview["saved"];
  effortLabels: Record<string, string>;
};

const SUMMARY_CLASS =
  "flex cursor-pointer list-none items-start gap-1.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden";
const CHEVRON_CLASS =
  "mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-90";
const CODE_BLOCK_CLASS =
  "m-0 max-h-96 overflow-auto whitespace-pre rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-relaxed";
const CODE_CLASS = "rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[11px]";
const PATH_CLASS = "break-all font-mono text-[11px]";
const CARD_CLASS = "space-y-1.5 rounded-md border border-default px-2.5 py-2";

function draftRole(draft: SubagentRuntimeDraft, id: SubagentRoleId): SubagentRoleConfig {
  return draft.subagentRoles[id] ?? {
    enabled: true,
    model: draft.subagentModel,
    reasoningEffort: draft.subagentReasoningEffort,
  };
}

function roleUnsaved(context: OverviewContext, id: SubagentRoleId) {
  const draft = draftRole(context.draft, id);
  const saved = context.saved.roles[id];
  return (
    !saved ||
    draft.enabled !== saved.enabled ||
    draft.model !== saved.model ||
    draft.reasoningEffort !== saved.reasoningEffort
  );
}

// 以下是普通函数而非组件：直接调用，元素树里就能看到展开后的文案。
function renderStateBadges(active: boolean, unsaved: boolean, labels: [string, string]) {
  return (
    <>
      <Badge variant={active ? "success" : "secondary"}>{active ? labels[0] : labels[1]}</Badge>
      {unsaved ? <Badge variant="warning">未保存</Badge> : null}
    </>
  );
}

function renderRoleId(id: string) {
  return (
    <span className="text-[11px] text-muted">
      角色标识 <code className={CODE_CLASS}>{id}</code>
    </span>
  );
}

function renderField(label: string, children: ReactNode) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-relaxed">
      <span className="shrink-0 text-muted">{label}：</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function renderTemplate(template: SubagentRuntimeTemplate | null, channel: SubagentRuntimeChannel) {
  if (!template) {
    return renderField("模板", channel === "file" ? "无，内容在启动时生成" : "内置，不可编辑");
  }
  if (template.exists) {
    return renderField(
      "模板",
      <>
        <span className={PATH_CLASS}>{template.path}</span>
        <span className="text-muted">（可编辑）</span>
      </>,
    );
  }
  return renderField(
    "模板",
    <>
      <span>内置。生效后首次启动 Codex 时写到下面的位置，之后可在那里编辑：</span>
      <span className={`block ${PATH_CLASS}`}>{template.path}</span>
    </>,
  );
}

function renderOverrides(overrides: SubagentRuntimeOverride[]) {
  if (overrides.length === 0) return null;
  return renderField(
    "启动参数",
    <ul className="m-0 space-y-0.5 pl-0">
      {overrides.map((entry) => (
        <li key={entry.key} className="list-none">
          <span>{entry.label}</span>
          <span>{entry.value === null ? "：内容见下方" : `：${entry.value}`}</span>{" "}
          <code className={CODE_CLASS}>{entry.key}</code>
        </li>
      ))}
    </ul>,
  );
}

function renderEvents(events: SubagentRuntimeItem["events"]) {
  if (events.length === 0) return null;
  return renderField(
    "钩子",
    <ul className="m-0 space-y-0.5 pl-0">
      {events.map((hook) => (
        <li key={hook.event} className="list-none">
          <span>{hook.name}</span> <code className={CODE_CLASS}>{hook.event}</code>
          <span className="text-muted">：{hook.purpose}</span>
        </li>
      ))}
    </ul>,
  );
}

function renderContent(content: SubagentRuntimeContent | null) {
  if (!content) return null;
  return (
    <details className="group">
      <summary className={SUMMARY_CLASS}>
        <IconChevronRight size={13} className={CHEVRON_CLASS} aria-hidden="true" />
        <span>{`查看内容（${FORMAT_LABELS[content.format] ?? content.format}）`}</span>
      </summary>
      <pre className={`${CODE_BLOCK_CLASS} mt-1.5`}>{content.text}</pre>
    </details>
  );
}

function renderItem(item: SubagentRuntimeItem, trigger: string) {
  return (
    <div key={item.id} className={CARD_CLASS}>
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="text-xs">{item.title}</strong>
        <Badge variant="outline">{CHANNEL_LABELS[item.channel] ?? item.channel}</Badge>
      </div>
      <p className="m-0 text-[11.5px] leading-relaxed text-muted">{item.description}</p>
      {renderField("触发", trigger)}
      {item.destination ? renderField("写入位置", <span className={PATH_CLASS}>{item.destination}</span>) : null}
      {renderTemplate(item.template, item.channel)}
      {renderOverrides(item.overrides)}
      {renderEvents(item.events)}
      {renderContent(item.content)}
    </div>
  );
}

function roleStatus(context: OverviewContext, label: SubagentRuntimeRoleLabel, unsaved: boolean) {
  const masterOff = `「${MASTER_SWITCH}」未开启，启动时不写入任何角色；下方是开启后会写入的内容。`;
  let status: string;
  if (label.id === GENERAL_ROLE.id) {
    status = context.draft.subagentOptimization
      ? `派生时未指定角色就使用它。它随「${MASTER_SWITCH}」启用，角色列表里没有它的开关。`
      : masterOff;
  } else if (!draftRole(context.draft, label.id).enabled) {
    status = `未启用：启动时不写入、不注册这个角色；「${MASTER_SWITCH}」开启时，启动还会删除此前留下的该角色配置文件。下方是启用后会写入的内容。`;
  } else {
    status = context.draft.subagentOptimization ? "启动 Codex 时写入下方文件，并注册这个角色。" : masterOff;
  }
  return unsaved ? `${status}下方内容按已保存的设置生成。` : status;
}

function renderRole(
  label: SubagentRuntimeRoleLabel,
  plan: SubagentRuntimeRole | undefined,
  context: OverviewContext,
) {
  const general = label.id === GENERAL_ROLE.id;
  const unsaved = !general && roleUnsaved(context, label.id);
  // 角色自身的启用状态与总开关分开显示：总开关关闭时另标「未生效」。
  const enabled = general || draftRole(context.draft, label.id).enabled;
  const effort = plan ? context.effortLabels[plan.reasoningEffort] ?? plan.reasoningEffort : "";
  return (
    <div key={label.id} className={CARD_CLASS}>
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="text-xs">{label.name}</strong>
        {general ? null : (
          <Badge variant={label.access === "write" ? "warning" : "secondary"}>
            {label.access === "write" ? "可写" : "只读"}
          </Badge>
        )}
        {renderStateBadges(enabled, unsaved, ["已启用", "未启用"])}
        {context.draft.subagentOptimization ? null : <Badge variant="secondary">未生效</Badge>}
        <Badge variant="outline">{CHANNEL_LABELS.file}</Badge>
        {renderRoleId(label.id)}
      </div>
      <p className="m-0 text-[11.5px] leading-relaxed text-muted">{roleStatus(context, label, unsaved)}</p>
      {renderField("触发", general ? `开启「${MASTER_SWITCH}」` : `开启「${MASTER_SWITCH}」并启用这个角色`)}
      {plan ? (
        <>
          {renderField("写入位置", <span className={PATH_CLASS}>{plan.destination}</span>)}
          {renderTemplate(plan.template, "file")}
          {renderOverrides(plan.overrides)}
          {renderField("模型", `${plan.model}；思考强度：${effort}（启动时可能按模型目录调整，见上方说明）`)}
          {plan.error ? <p className="m-0 text-danger" role="alert">{`无法生成角色配置：${plan.error}`}</p> : null}
          {renderContent(plan.content)}
        </>
      ) : (
        <p className="m-0 text-danger" role="alert">后端没有返回这个角色的计划。</p>
      )}
    </div>
  );
}

function renderGroup(title: string, badges: ReactNode, summary: string, children: ReactNode) {
  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="m-0 text-xs font-semibold">{title}</h3>
        {badges}
      </div>
      <p className="m-0 leading-relaxed text-muted">{summary}</p>
      {children}
    </section>
  );
}

function renderBasis(overview: SubagentRuntimeOverview, context: OverviewContext, roles: readonly SubagentRuntimeRoleLabel[]) {
  const unsaved =
    context.draft.subagentOptimization !== context.saved.subagentOptimization ||
    context.draft.scopeGuard !== context.saved.scopeGuard ||
    roles.some(({ id }) => roleUnsaved(context, id));
  const low = context.effortLabels.low ?? "low";
  return (
    <div className="space-y-1 rounded-md bg-black/[0.03] px-2.5 py-2 leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={overview.platformSupported ? "success" : "warning"}>
          {overview.platformSupported ? "当前平台支持" : "当前平台不支持"}
        </Badge>
        {unsaved ? <Badge variant="warning">有未保存的修改</Badge> : null}
      </div>
      {!overview.platformSupported ? (
        <p className="m-0">{`仅原生 Windows 和 macOS 支持「${MASTER_SWITCH}」，当前平台启动时不会交付以下内容。`}</p>
      ) : null}
      <p className="m-0">
        {unsaved
          ? "内容依据：已保存的设置。标有「未保存」的部分，下方内容仍按已保存的设置显示；保存后这里会自动刷新。"
          : "内容依据：已保存的设置，与页面当前的设置一致。"}
      </p>
      <p className="m-0">
        {`生效时机：「${MASTER_SWITCH}」「${SCOPE_GUARD_SWITCH}」两个开关和角色的启用状态，保存并重启 Codex 后生效。已启用角色的模型和思考强度保存后，从下一次派生子代理起生效；Codex 未运行时在下次启动时生效。直接编辑模板文件后，下次启动 Codex 时生效。`}
      </p>
      <p className="m-0">
        {`思考强度：这里显示已保存的值。启动时 Codey 会按当时的模型目录再核对一次；所选模型不支持这一档时，改用「${low}」或该模型的默认档位，所以实际值可能不同。`}
      </p>
    </div>
  );
}

function renderGate(overview: SubagentRuntimeOverview, context: OverviewContext) {
  const { gate } = overview;
  const trigger = `开启「${MASTER_SWITCH}」`;
  return renderGroup(
    "门禁、钩子与并发",
    renderStateBadges(context.draft.subagentOptimization, context.draft.subagentOptimization !== context.saved.subagentOptimization, ["已开启", "未开启"]),
    `随「${MASTER_SWITCH}」一起开启。子代理工作期间，Codey 用钩子检查每次工具调用和子代理的启动与停止，按门禁规则限制子代理的权限、并发和汇合。`,
    <>
      {gate.items.map((item) => renderItem(item, trigger))}
      <div className={CARD_CLASS}>
        <strong className="text-xs">门禁并发上限</strong>
        <p className="m-0 leading-relaxed">
          {`只有只读子代理时最多同时 ${gate.concurrency.readOnly} 个；有可写子代理时最多同时 ${gate.concurrency.writable} 个。由调用工具前的钩子检查，和「Codex 子代理设置」里每个会话同时运行的子代理上限是两项不同的限制。`}
        </p>
      </div>
      <div className={CARD_CLASS}>
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="text-xs">门禁规则</strong>
          <Badge variant="outline">规则文件</Badge>
        </div>
        {renderField("触发", trigger)}
        {renderField(
          "来源",
          gate.rules.source === "file" && gate.rules.path ? (
            <span className={PATH_CLASS}>{gate.rules.path}</span>
          ) : (
            "内置规则；钩子每次检查时读取"
          ),
        )}
        {gate.rules.items.length === 0 ? (
          <p className="m-0 text-muted">没有门禁规则。</p>
        ) : (
          gate.rules.items.map((rule) => (
            <details key={rule.id} className="group">
              <summary className={SUMMARY_CLASS}>
                <IconChevronRight size={13} className={CHEVRON_CLASS} aria-hidden="true" />
                <span className="min-w-0 flex-1 leading-relaxed">{rule.explanation}</span>
              </summary>
              <pre className={`${CODE_BLOCK_CLASS} mt-1.5`}>{rule.definition}</pre>
            </details>
          ))
        )}
      </div>
    </>,
  );
}

function renderReady(
  overview: SubagentRuntimeOverview,
  draft: SubagentRuntimeDraft,
  roles: readonly SubagentRuntimeRoleLabel[],
  effortLabels: Record<string, string>,
) {
  const context: OverviewContext = { draft, saved: overview.saved, effortLabels };
  const plan = (id: SubagentRoleId) => overview.roles.find((role) => role.id === id);
  const masterTrigger = `开启「${MASTER_SWITCH}」`;
  const scopeTrigger = `开启「${SCOPE_GUARD_SWITCH}」`;
  return (
    <div className="space-y-4 text-xs">
      {renderBasis(overview, context, roles)}
      {renderGroup(
        `「${MASTER_SWITCH}」开关`,
        renderStateBadges(draft.subagentOptimization, draft.subagentOptimization !== overview.saved.subagentOptimization, ["已开启", "未开启"]),
        "开启后，Codey 每次启动 Codex 时用启动参数交给 Codex 主代理指导和子代理设置，并写入通用子代理的配置文件。你的 Codex 配置文件不会被改写。",
        <>
          {overview.master.map((item) => renderItem(item, masterTrigger))}
          {renderRole(GENERAL_ROLE, plan(GENERAL_ROLE.id), context)}
        </>,
      )}
      {renderGroup(
        "子代理角色",
        null,
        `每个启用的角色在启动时写入一份角色配置文件，并用启动参数注册给 Codex；未启用的角色不写入、不注册。角色只在「${MASTER_SWITCH}」开启时生效。`,
        roles.map((label) => renderRole(label, plan(label.id), context)),
      )}
      {renderGroup(
        `「${SCOPE_GUARD_SWITCH}」开关`,
        renderStateBadges(draft.scopeGuard, draft.scopeGuard !== overview.saved.scopeGuard, ["已开启", "未开启"]),
        `开启后，Codey 用钩子把防御性编程规则交给新建、清空和压缩后的主会话，以及新启动的子代理。不写入文件，不依赖「${MASTER_SWITCH}」。`,
        overview.scopeGuard.map((item) => renderItem(item, scopeTrigger)),
      )}
      {renderGate(overview, context)}
    </div>
  );
}

export function SubagentRuntimeOverviewPanel({
  state,
  onRetry,
  draft,
  roles,
  reasoningEffortLabels,
}: {
  state: SubagentRuntimeOverviewState;
  onRetry: () => void;
  draft: SubagentRuntimeDraft;
  roles: readonly SubagentRuntimeRoleLabel[];
  reasoningEffortLabels: Record<string, string>;
}) {
  if (state.status === "loading") {
    return (
      <p className="m-0 text-xs text-muted" role="status">
        正在读取运行方式…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-danger" role="alert">
        <span>读取运行方式失败：{state.message}</span>
        <Button variant="light" size="xs" onPress={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  return renderReady(state.overview, draft, roles, reasoningEffortLabels);
}

/** 只读展示：展开时读取，重新展开或保存设置后刷新，不提供任何编辑入口。 */
export function SubagentRuntimeOverviewSection({
  draft,
  roles,
  reasoningEffortLabels,
}: {
  draft: SubagentRuntimeDraft;
  roles: readonly SubagentRuntimeRoleLabel[];
  reasoningEffortLabels: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SubagentRuntimeOverviewState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: "loading" });
    invoke<SubagentRuntimeOverview>("subagent_runtime_overview")
      .then((overview) => {
        if (!cancelled) setState({ status: "ready", overview });
      })
      .catch((error: unknown) => {
        console.error("读取子代理运行方式失败", error);
        if (!cancelled) setState({ status: "error", message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  // 概览按已保存的设置生成，保存成功后重新读取。
  useEffect(() => {
    if (!open) return;
    const refresh = () => setAttempt((value) => value + 1);
    window.addEventListener("codey:config-changed", refresh);
    return () => window.removeEventListener("codey:config-changed", refresh);
  }, [open]);

  return (
    <details
      className="group rounded-lg border border-default px-3 py-2.5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={SUMMARY_CLASS}>
        <IconChevronRight size={14} className={CHEVRON_CLASS} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="text-xs">运行方式</strong>
          <p className="m-0 mt-0.5 text-[11.5px] leading-relaxed text-muted">
            只读查看 Codey 启动 Codex 时为子代理交付的内容：写入哪些文件、用启动参数覆盖哪些设置、通过哪些钩子注入规则，以及现在是否生效。这里不能修改。
          </p>
        </div>
      </summary>
      {open ? (
        <div className="mt-3">
          <SubagentRuntimeOverviewPanel
            state={state}
            onRetry={() => setAttempt((value) => value + 1)}
            draft={draft}
            roles={roles}
            reasoningEffortLabels={reasoningEffortLabels}
          />
        </div>
      ) : null}
    </details>
  );
}
