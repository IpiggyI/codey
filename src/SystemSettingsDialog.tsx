import { memo, useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconFolder,
  IconSettings,
} from "@tabler/icons-react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
} from "./components/ui";
import { errorText } from "./appUtils";

const COPY_FEEDBACK_MS = 3000;
const DEFAULT_CODEX_PATH = "/Applications/ChatGPT.app";
const READ_FAILED_FALLBACK = "暂时无法读取 Codex 信息，请稍后重试。";

export type SystemSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  appVersion?: string;
  codexAppVersion?: string;
  codexAppPath?: string;
  /** 打开对话框时重新读取运行状态；只读，不写任何配置。 */
  onRefreshStatus: () => Promise<unknown>;
};

type CopyState = "idle" | "copied" | "error";

function SystemSettingsDialogComponent({
  open,
  onOpenChange,
  container,
  appVersion,
  codexAppVersion,
  codexAppPath,
  onRefreshStatus,
}: SystemSettingsDialogProps) {
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReading(true);
    setReadError(null);
    setCopyState("idle");
    onRefreshStatus().then(
      () => {
        if (!cancelled) setReading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        const reason = error instanceof Error || typeof error === "string"
          ? errorText(error).trim()
          : "";
        setReadError(reason || READ_FAILED_FALLBACK);
        setReading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, onRefreshStatus]);

  const resolvedCodexPath = codexAppPath || DEFAULT_CODEX_PATH;
  const trimmedCodexVersion = codexAppVersion?.trim();
  const formattedCodexVersion = reading
    ? "读取中…"
    : readError
      ? "读取失败"
      : trimmedCodexVersion
        ? `v${trimmedCodexVersion.replace(/^v/, "")}`
        : "未运行 / 未检测到";

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(resolvedCodexPath);
      setCopyState("copied");
    } catch (error) {
      console.error("复制 Codex 路径失败", error);
      setCopyState("error");
    }
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:w-[500px]"
        container={container}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="system-settings-icon">
              <IconSettings size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>系统设置与偏好</DialogTitle>
              <DialogDescription>
                查看 Codey 与 Codex 的版本和本地路径。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="system-settings-body">
          {/* 版本与目录信息：只读 */}
          <div className="system-settings-card">
            <div className="system-settings-versions">
              <div className="system-settings-version-cell">
                <span className="system-settings-label">Codey 版本</span>
                <span className="system-settings-value">
                  v{appVersion || "0.2.0"}
                </span>
              </div>
              <div className="system-settings-version-cell">
                <span className="system-settings-label">Codex 版本</span>
                <span className="system-settings-value" aria-live="polite">
                  {formattedCodexVersion}
                </span>
              </div>
            </div>

            {readError && (
              <p role="status" className="system-settings-error text-danger">
                {readError}
              </p>
            )}

            {/* Codex 目录支持长路径换行与一键复制 */}
            <div className="system-settings-path">
              <div className="system-settings-path-head">
                <div className="system-settings-path-title">
                  <IconFolder size={14} aria-hidden="true" />
                  <span>Codex 目录</span>
                </div>
                <Tooltip content={
                  copyState === "copied"
                    ? "已复制到剪贴板"
                    : copyState === "error"
                      ? "复制失败，请选中路径手动复制"
                      : "复制路径"
                }>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="system-settings-copy"
                    aria-label="复制 Codex 路径"
                    onPress={handleCopyPath}
                  >
                    {copyState === "copied" ? (
                      <IconCheck size={13} className="text-success" aria-hidden="true" />
                    ) : (
                      <IconCopy size={13} aria-hidden="true" />
                    )}
                  </Button>
                </Tooltip>
              </div>
              <div className="system-settings-path-box">
                <code title={resolvedCodexPath}>{resolvedCodexPath}</code>
              </div>
              {copyState !== "idle" && (
                <p
                  role="status"
                  className={`system-settings-copy-feedback ${
                    copyState === "copied" ? "text-success" : "text-danger"
                  }`}
                >
                  {copyState === "copied"
                    ? "已复制到剪贴板"
                    : "复制失败，请选中路径手动复制"}
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="default" onPress={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const SystemSettingsDialog = memo(SystemSettingsDialogComponent);
