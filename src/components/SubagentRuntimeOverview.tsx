import { useEffect, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";

import { invoke } from "../api";
import { errorText } from "../appUtils";
import type {
  SubagentRuntimeDocument,
  SubagentRuntimeOverview,
} from "../App.types";
import { Badge, Button } from "./ui";

const DOCUMENT_SOURCE_LABELS: Record<SubagentRuntimeDocument["source"], string> = {
  file: "文件",
  builtin: "内置，尚未写入文件",
  override: "启动参数 -c 传入",
};
const DOCUMENT_FORMAT_LABELS: Record<SubagentRuntimeDocument["format"], string> = {
  markdown: "Markdown",
  toml: "TOML",
  json: "JSON",
  text: "文本",
};

export type SubagentRuntimeOverviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; overview: SubagentRuntimeOverview };

const SUMMARY_CLASS =
  "flex cursor-pointer list-none items-start gap-1.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden";
const CHEVRON_CLASS =
  "mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-90";
const CODE_BLOCK_CLASS =
  "m-0 max-h-96 overflow-auto whitespace-pre rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-relaxed";

// 以下两个是普通函数而非组件：直接调用，元素树里就能看到展开后的文案。
function renderSourceBadges(label: string, path: string | null) {
  return (
    <>
      <Badge variant="outline">{label}</Badge>
      {path ? <span className="break-all font-mono text-[11px]">{path}</span> : null}
    </>
  );
}

function renderDocumentItem(document: SubagentRuntimeDocument) {
  return (
    <details key={document.id} className="group rounded-md border border-default px-2.5 py-2">
      <summary className={SUMMARY_CLASS}>
        <IconChevronRight size={13} className={CHEVRON_CLASS} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="text-xs">{document.title}</strong>
            {renderSourceBadges(
              DOCUMENT_SOURCE_LABELS[document.source] ?? document.source,
              document.source === "file" ? document.path : null,
            )}
            <Badge variant="secondary">
              {DOCUMENT_FORMAT_LABELS[document.format] ?? document.format}
            </Badge>
          </div>
          <p className="m-0 text-[11.5px] leading-relaxed text-muted">
            {document.description}
          </p>
        </div>
      </summary>
      <pre className={`${CODE_BLOCK_CLASS} mt-2`}>{document.content}</pre>
    </details>
  );
}

export function SubagentRuntimeOverviewPanel({
  state,
  onRetry,
}: {
  state: SubagentRuntimeOverviewState;
  onRetry: () => void;
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

  const { overview } = state;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={overview.platformSupported ? "success" : "warning"}>
          {overview.platformSupported ? "当前平台支持" : "当前平台不支持"}
        </Badge>
        <Badge variant="secondary">
          {`子代理增强${overview.enabled ? "已开启" : "未开启"}`}
        </Badge>
        <Badge variant="secondary">
          {`防御性编程控制${overview.scopeGuardEnabled ? "已开启" : "未开启"}`}
        </Badge>
        <span className="text-muted">
          {`并发上限：只读角色 ${overview.concurrency.readOnly}，可写角色 ${overview.concurrency.writable}`}
        </span>
      </div>
      {!overview.platformSupported ? (
        <p className="m-0 text-muted">仅原生 Windows 和 macOS 支持子代理增强。</p>
      ) : null}

      <div className="space-y-1.5">
        <h3 className="m-0 text-xs font-semibold">注册的钩子事件</h3>
        {overview.hooks.length === 0 ? (
          <p className="m-0 text-muted">没有注册钩子。</p>
        ) : (
          <ul className="m-0 space-y-1 pl-0">
            {overview.hooks.map((hook) => (
              <li key={hook.event} className="flex flex-wrap items-baseline gap-1.5">
                <code className="rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[11px]">
                  {hook.event}
                </code>
                <span className="text-muted">{hook.purpose}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <h3 className="m-0 text-xs font-semibold">发送给 Codex 的文档</h3>
        {overview.documents.length === 0 ? (
          <p className="m-0 text-muted">没有文档。</p>
        ) : (
          overview.documents.map(renderDocumentItem)
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="m-0 text-xs font-semibold">汇合门禁规则</h3>
          {renderSourceBadges(
            DOCUMENT_SOURCE_LABELS[overview.rules.source],
            overview.rules.source === "file" ? overview.rules.path : null,
          )}
        </div>
        {overview.rules.items.length === 0 ? (
          <p className="m-0 text-muted">没有门禁规则。</p>
        ) : (
          overview.rules.items.map((rule) => (
            <details key={rule.id} className="group rounded-md border border-default px-2.5 py-2">
              <summary className={SUMMARY_CLASS}>
                <IconChevronRight size={13} className={CHEVRON_CLASS} aria-hidden="true" />
                <span className="min-w-0 flex-1 leading-relaxed">{rule.explanation}</span>
              </summary>
              <pre className={`${CODE_BLOCK_CLASS} mt-2`}>{rule.definition}</pre>
            </details>
          ))
        )}
      </div>
    </div>
  );
}

/** 只读展示：展开时读取一次，每次重新展开都会刷新，不提供任何编辑入口。 */
export function SubagentRuntimeOverviewSection() {
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
            只读查看 Codey 向 Codex 传递的提示词、钩子和门禁规则；这里不能修改。
          </p>
        </div>
      </summary>
      {open ? (
        <div className="mt-3">
          <SubagentRuntimeOverviewPanel
            state={state}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        </div>
      ) : null}
    </details>
  );
}
