import { memo, useEffect, useState } from "react";

import { invoke } from "./api";
import { errorText } from "./appUtils";
import type {
  Confirmation,
  Notice,
  OfficialAccount,
  OfficialAccountsResult,
  OfficialUsageWindow,
} from "./App.types";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui";
import { createLoginSession, type UsageView } from "./officialAccountsRequests";
import { useOfficialAccountLoginPoll } from "./useOfficialAccountLoginPoll";
import { useOfficialAccounts } from "./useOfficialAccounts";

// 浏览器登录会话在后端 10 分钟后过期。
const LOGIN_VALID_MS = 10 * 60_000;

export const SWITCH_TIP = "切换会把 Codex 的登录改写为该账号，并需要重启 Codex 后生效";
export const SESSION_NOTICE =
  "已切换官方账号。在之前账号下开始的对话可能无法在新账号下继续；继续对话失败时，请新开对话。";

type LoginStart = {
  loginId: string;
  authUrl: string;
  browserOpened: boolean;
  // 回调端口无法监听时为 false，登录只能靠粘贴回调地址完成；callbackError 是后端给出的原因。
  callbackListening: boolean;
  callbackError: string | null;
  expiresAt: number;
};

function loginDescription(login: LoginStart | null) {
  if (login?.callbackListening === false) {
    return "请在浏览器中打开下方链接并完成 ChatGPT 登录，然后把回调地址粘贴到下方提交。";
  }
  if (login?.browserOpened === false) {
    return "未能自动打开浏览器。请复制下方链接，在浏览器中打开并完成 ChatGPT 登录。";
  }
  return "已在浏览器打开 ChatGPT 登录页。完成登录后，账号会自动加入列表。";
}

export function normalizePlan(plan?: string) {
  const value = plan?.trim().toLowerCase() || "";
  const compact = value.replace(/[\s_$-]/g, "");
  if (compact === "pro100") return "prolite";
  if (compact === "pro200") return "pro";
  if (compact === "pro500") return "promax";
  if (compact === "5x" || compact === "pro5x") return "pro5x";
  if (compact === "pro20x") return "pro20x";
  return value;
}

export function isProPlan(plan?: string) {
  const p = normalizePlan(plan);
  return p === "prolite" || p === "pro" || p === "promax" || p === "pro5x" || p === "pro20x";
}

export function formatPlan(plan?: string) {
  const known: Record<string, string> = {
    free: "Free", plus: "Plus", prolite: "Pro 100", pro: "Pro 200", promax: "Pro 500",
    pro5x: "Pro 5x", pro20x: "Pro 20x", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
  };
  const label = Object.prototype.hasOwnProperty.call(known, normalizePlan(plan)) ? known[normalizePlan(plan)] : undefined;
  return label ?? (plan?.trim() || "");
}

export function planTagClass(plan?: string) {
  const p = normalizePlan(plan);
  if (p === "plus") return "official-account-plan-badge is-plus";
  if (p === "prolite") return "official-account-plan-badge is-pro is-pro-100";
  if (p === "pro") return "official-account-plan-badge is-pro is-pro-200";
  if (p === "promax") return "official-account-plan-badge is-pro is-pro-500";
  if (p === "pro5x") return "official-account-plan-badge is-pro is-pro-100";
  if (p === "pro20x") return "official-account-plan-badge is-pro is-pro-200";
  if (p === "team" || p === "business" || p === "enterprise") return "official-account-plan-badge is-team";
  return "official-account-plan-badge is-default";
}

function windowLabel(minutes: number) {
  if (minutes === 300) return "5 小时";
  if (minutes === 10080) return "每周";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatTime(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

const accountLabel = (account: OfficialAccount) => account.email?.trim() || account.accountId || account.id;

function UsageLine({ usage, loading }: { usage: UsageView | undefined; loading: boolean }) {
  if (!usage) return <small className="text-xs text-[#6e6e73]">{loading ? "正在读取账号额度…" : "尚未读取账号额度"}</small>;
  if (usage.status === "error") return <small className="text-xs text-[#9a6700]">{usage.message}</small>;
  const windows = [usage.snapshot.primary, usage.snapshot.secondary].filter(
    (window): window is OfficialUsageWindow => Boolean(window),
  );
  if (windows.length === 0) return <small className="text-xs text-[#6e6e73]">官方未返回额度窗口</small>;
  return (
    <div className="official-account-usage-grid">
      {windows.map((window) => {
        const remaining = Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
        const tone = remaining <= 10 ? "is-danger" : remaining <= 30 ? "is-warning" : "is-normal";
        return (
          <div key={window.windowMinutes} className="official-account-usage-cell">
            <div className="flex items-center justify-between text-xs">
              <span>{windowLabel(window.windowMinutes)}</span>
              <span className={`official-account-usage-percent ${tone}`}>剩余 {remaining}%</span>
            </div>
            <div className="official-account-progress-track" aria-hidden="true">
              <div className={`official-account-progress-fill ${tone}`} style={{ width: `${remaining}%` }} />
            </div>
            <small className="text-[11px] text-[#6e6e73]">
              {window.resetsAt ? `${formatTime(window.resetsAt * 1000)} 重置` : "暂无重置信息"}
            </small>
          </div>
        );
      })}
    </div>
  );
}

export type OfficialAccountsPanelProps = {
  active: boolean;
  disabled: boolean;
  refreshKey: number;
  popupContainer: HTMLElement | null;
  // 由 App 在 Codex 运行时先确认重启，再在操作锁内执行切换并接纳配置；
  // 后端切换成功时返回账号列表，取消或失败时返回 null。
  onSwitch: (accountId: string) => Promise<OfficialAccountsResult | null>;
  // 添加、导入或移除账号后调用，用于刷新渠道列表。
  onAccountsChanged: () => void;
  onNotice: (notice: Notice) => void;
  onRequestConfirmation: (confirmation: Confirmation) => void;
};

function OfficialAccountsPanelComponent({
  active,
  disabled: externallyDisabled,
  refreshKey,
  popupContainer,
  onSwitch,
  onAccountsChanged,
  onNotice,
  onRequestConfirmation,
}: OfficialAccountsPanelProps) {
  const { view, loadError, accountSwitched, usages, usageLoading, apply, refresh, refreshUsage } =
    useOfficialAccounts({ active, refreshKey });
  const [pending, setPending] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginStart | null>(null);
  // 关闭登录对话框或卸载面板时递增，使在途的开始登录请求作废。
  const [loginAttempt] = useState(() => ({ current: 0 }));
  const [loginError, setLoginError] = useState("");
  // 轮询成功、提交回调地址成功和关闭对话框谁先到谁收尾，之后到达的结果被忽略。
  const [loginSession] = useState(createLoginSession);
  const [callbackInput, setCallbackInput] = useState("");
  const [callbackError, setCallbackError] = useState("");
  const [callbackSubmitting, setCallbackSubmitting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [manualError, setManualError] = useState("");
  const disabled = externallyDisabled || pending !== null;
  const switchDisabledReason = view?.switchDisabledReason ?? null;

  const accountsChanged = (result: OfficialAccountsResult) => {
    apply(result);
    onAccountsChanged();
  };

  useOfficialAccountLoginPoll({
    loginId: login?.loginId,
    onSuccess: (result) => {
      const loginId = loginSession.active();
      if (loginId === null || !loginSession.finish(loginId)) return;
      accountsChanged(result);
      setLogin(null);
      onNotice({ tone: "success", text: "官方账号已添加" });
    },
    onFailure: (message) => {
      if (loginSession.active() !== null) setLoginError(message);
    },
  });

  useEffect(() => () => {
    loginAttempt.current += 1;
  }, [loginAttempt]);

  async function cancelLogin(loginId: string) {
    try {
      await invoke("cancel_official_account_login", { loginId });
    } catch (error) {
      onNotice({ tone: "info", text: `取消登录失败，登录会话会在过期后自动失效：${errorText(error)}` });
    }
  }

  async function startLogin() {
    const attempt = ++loginAttempt.current;
    setPending("login");
    setLoginError("");
    setCallbackInput("");
    setCallbackError("");
    try {
      const result = await invoke<Omit<LoginStart, "expiresAt">>("start_official_account_login");
      if (attempt !== loginAttempt.current) {
        // 请求返回前已关闭对话框：不再打开，并释放后端的登录会话。
        await cancelLogin(result.loginId);
        return;
      }
      loginSession.begin(result.loginId);
      setLogin({ ...result, expiresAt: Date.now() + LOGIN_VALID_MS });
    } catch (error) {
      onNotice({ tone: "error", text: errorText(error) });
    } finally {
      setPending(null);
    }
  }

  async function closeLogin() {
    const current = login;
    loginAttempt.current += 1;
    loginSession.clear();
    setLogin(null);
    setLoginError("");
    setCallbackError("");
    if (current) await cancelLogin(current.loginId);
  }

  async function copyAuthUrl() {
    if (!login) return;
    try {
      await navigator.clipboard.writeText(login.authUrl);
      onNotice({ tone: "success", text: "已复制登录链接" });
    } catch {
      onNotice({ tone: "info", text: "无法访问剪贴板，请手动复制登录链接" });
    }
  }

  // 提交成功与轮询成功等价；失败只在对话框内显示原因，登录保持打开，可以重新粘贴。
  async function submitCallback() {
    const current = login;
    const callbackUrl = callbackInput.trim();
    if (!current || !callbackUrl || callbackSubmitting) return;
    setCallbackSubmitting(true);
    setCallbackError("");
    try {
      const result = await invoke<OfficialAccountsResult>("submit_official_account_login_callback", {
        loginId: current.loginId,
        callbackUrl,
      });
      // 账号已经由后端写入；对话框已被关闭或已由轮询收尾时只同步列表。
      accountsChanged(result);
      if (loginSession.finish(current.loginId)) {
        setLogin(null);
        onNotice({ tone: "success", text: "官方账号已添加" });
      }
    } catch (error) {
      if (loginSession.active() === current.loginId) setCallbackError(errorText(error));
    } finally {
      setCallbackSubmitting(false);
    }
  }

  async function runAccountCommand(
    name: string,
    command: "import_current_codex_login" | "import_official_account_credential" | "remove_official_account",
    args: Record<string, unknown>,
    success: string,
  ) {
    setPending(name);
    try {
      accountsChanged(await invoke<OfficialAccountsResult>(command, args));
      onNotice({ tone: "success", text: success });
      return null;
    } catch (error) {
      return errorText(error);
    } finally {
      setPending(null);
    }
  }

  async function importCurrent() {
    const error = await runAccountCommand("import", "import_current_codex_login", {}, "已导入 Codex 当前登录的官方账号");
    if (error) onNotice({ tone: "error", text: error });
  }

  async function submitManual() {
    const credential = manualInput.trim();
    if (!credential) {
      setManualError("请粘贴刷新令牌或 OAuth JSON");
      return;
    }
    setManualError("");
    const error = await runAccountCommand("manual", "import_official_account_credential", { credential }, "官方账号已添加");
    if (error) {
      setManualError(error);
      return;
    }
    setManualOpen(false);
    setManualInput("");
  }

  function askRemove(account: OfficialAccount) {
    onRequestConfirmation({
      action: "delete-official-account",
      title: `移除官方账号「${accountLabel(account)}」？`,
      description: account.isDefault
        ? "它是 Codex 当前登录的账号。移除只删除账号库中的记录，不会退出 Codex 登录，也不会自动切换到其他账号。"
        : "移除后需要重新添加，才能再切换到该账号。",
      confirmLabel: "移除账号",
      run: () => {
        void (async () => {
          const error = await runAccountCommand(`remove:${account.id}`, "remove_official_account", { accountId: account.id }, "官方账号已移除");
          if (error) onNotice({ tone: "error", text: error });
        })();
      },
    });
  }

  async function switchTo(account: OfficialAccount) {
    setPending(`switch:${account.id}`);
    try {
      const result = await onSwitch(account.id);
      if (result) {
        apply(result);
      } else {
        // 使用者取消或切换失败；失败的原因可能是账号状态已变化，重新读取列表。
        await refresh();
      }
    } catch (error) {
      onNotice({ tone: "error", text: errorText(error) });
    } finally {
      setPending(null);
    }
  }

  const accounts = view?.accounts ?? null;

  return (
    <aside className="current-provider-snapshot" aria-label="官方账号">
      <div className="mb-2 flex flex-wrap items-start gap-2">
        <div className="current-provider-snapshot-heading mb-0 min-w-0 flex-1">
          <strong>官方账号{accounts && accounts.length > 0 ? `（${accounts.length} 个）` : ""}</strong>
          <small>保存多个 ChatGPT 官方账号，查看每个账号的账号额度，并切换 Codex 当前登录的账号。每个官方账号也是一个渠道。</small>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || switchDisabledReason !== null}
            loading={pending === "import"}
            onPress={() => void importCurrent()}
          >
            导入当前登录
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={disabled}
            onPress={() => {
              setManualError("");
              setManualInput("");
              setManualOpen(true);
            }}
          >
            粘贴凭据
          </Button>
          <Button size="xs" disabled={disabled} loading={pending === "login"} onPress={() => void startLogin()}>
            浏览器登录添加
          </Button>
        </div>
      </div>

      {switchDisabledReason ? (
        <p role="alert" className="mb-2 text-xs text-[#9a6700]">{switchDisabledReason}</p>
      ) : null}
      {accountSwitched ? (
        <p role="status" className="mb-2 text-xs text-[#9a6700]">{SESSION_NOTICE}</p>
      ) : null}
      {loadError ? (
        <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-[#c4271c]">
          <span className="min-w-0 flex-1">{loadError}</span>
          <Button variant="outline" size="xs" disabled={disabled} onPress={() => void refresh()}>重新读取</Button>
        </div>
      ) : null}
      {!accounts && !loadError ? <small className="text-xs text-[#6e6e73]">正在读取官方账号</small> : null}
      {accounts && accounts.length === 0 ? (
        <small className="text-xs text-[#6e6e73]">尚未添加官方账号。添加后，每个官方账号都会作为一个渠道出现在渠道列表中。</small>
      ) : null}

      {accounts && accounts.length > 0 ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {accounts.map((account) => {
            const label = accountLabel(account);
            const usage = usages[account.id];
            // 账号额度返回的套餐比账号记录里的更新。
            const planType = (usage?.status === "ok" ? usage.snapshot.planType : undefined) || account.planType;
            const plan = formatPlan(planType);
            const loading = usageLoading[account.id] === true;
            const switchable = !account.isDefault && !account.invalid && switchDisabledReason === null;
            return (
              <li
                key={account.id}
                className={`official-account-item grid gap-2 rounded-lg border border-black/5 bg-white px-3 py-2${account.invalid ? " is-invalid" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="min-w-0 truncate text-[13px]" title={label}>{label}</strong>
                  {plan ? <span className={planTagClass(planType)}>{plan}</span> : null}
                  {account.isDefault ? (
                    <Badge variant="success">{view?.officialAccountAvailable ? "当前账号" : "当前账号（未登录）"}</Badge>
                  ) : null}
                  {account.invalid ? <Badge variant="destructive">已失效</Badge> : null}
                  {account.lastRefresh ? (
                    <span className="ml-auto text-xs text-[#6e6e73]">上次刷新：{formatTime(account.lastRefresh)}</span>
                  ) : null}
                </div>
                {account.invalid ? (
                  <small className="text-xs text-[#c4271c]">账号凭据已失效，不再查询账号额度；请移除后重新添加。</small>
                ) : (
                  <UsageLine usage={usage} loading={loading} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    title={SWITCH_TIP}
                    disabled={disabled || !switchable}
                    loading={pending === `switch:${account.id}`}
                    onPress={() => void switchTo(account)}
                  >
                    切换到此账号
                  </Button>
                  {!account.invalid ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={disabled || loading}
                      loading={loading}
                      onPress={() => void refreshUsage(account.id)}
                    >
                      刷新账号额度
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    color="danger"
                    size="xs"
                    disabled={disabled}
                    loading={pending === `remove:${account.id}`}
                    onPress={() => askRemove(account)}
                  >
                    移除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Dialog open={login !== null} onOpenChange={(open) => { if (!open) void closeLogin(); }}>
        <DialogContent container={popupContainer}>
          <DialogHeader>
            <DialogTitle>添加官方账号</DialogTitle>
            <DialogDescription>{loginDescription(login)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {login?.callbackListening === false ? (
              <small role="alert" className="text-xs text-[#9a6700]">
                无法自动完成登录{login.callbackError ? `：${login.callbackError}` : ""}
              </small>
            ) : null}
            {login ? (
              <code className="block select-text break-all rounded bg-[#f2f2f4] p-2 text-xs">{login.authUrl}</code>
            ) : null}
            {login && !loginError ? (
              <div className="grid gap-1">
                <small className="text-xs text-[#6e6e73]">
                  在浏览器中完成授权后，浏览器会跳转到以 http://localhost:1455/auth/callback 开头的地址。
                  如果该页面没有自动完成，或打不开，请从浏览器地址栏复制完整地址，粘贴到下方。
                </small>
                <textarea
                  aria-label="回调地址"
                  autoComplete="off"
                  className="min-h-[72px] resize-y font-mono text-xs"
                  disabled={callbackSubmitting}
                  placeholder="http://localhost:1455/auth/callback?code=…"
                  spellCheck={false}
                  value={callbackInput}
                  onChange={(event) => {
                    setCallbackInput(event.target.value);
                    if (callbackError) setCallbackError("");
                  }}
                />
                {callbackError ? <small role="alert" className="text-xs text-[#c4271c]">{callbackError}</small> : null}
                <div>
                  <Button
                    variant={login.callbackListening === false ? undefined : "outline"}
                    size="sm"
                    disabled={callbackInput.trim() === "" || callbackSubmitting}
                    loading={callbackSubmitting}
                    onPress={() => void submitCallback()}
                  >
                    提交回调地址
                  </Button>
                </div>
              </div>
            ) : null}
            {loginError ? (
              <small role="alert" className="text-xs text-[#c4271c]">{loginError}</small>
            ) : login ? (
              <small className="text-xs text-[#6e6e73]">等待浏览器完成登录。登录链接在 {formatTime(login.expiresAt)} 前有效。</small>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onPress={() => void copyAuthUrl()}>复制登录链接</Button>
            {loginError ? (
              <Button size="sm" disabled={pending === "login"} onPress={() => void startLogin()}>重新开始</Button>
            ) : (
              <Button variant="secondary" size="sm" onPress={() => void closeLogin()}>取消</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manualOpen} onOpenChange={(open) => { if (!open && pending !== "manual") setManualOpen(false); }}>
        <DialogContent container={popupContainer}>
          <DialogHeader>
            <DialogTitle>粘贴官方账号凭据</DialogTitle>
            <DialogDescription>
              粘贴刷新令牌，或包含访问令牌与刷新令牌的 OAuth JSON。只有刷新令牌时，Codey 会向官方换取登录。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <textarea
              aria-label="刷新令牌或 OAuth JSON"
              autoComplete="off"
              className="min-h-[148px] resize-y font-mono text-xs"
              disabled={pending === "manual"}
              placeholder="刷新令牌或 OAuth JSON"
              spellCheck={false}
              value={manualInput}
              onChange={(event) => {
                setManualInput(event.target.value);
                if (manualError) setManualError("");
              }}
            />
            {manualError ? <small role="alert" className="text-xs text-[#c4271c]">{manualError}</small> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={pending === "manual"} onPress={() => setManualOpen(false)}>取消</Button>
            <Button
              size="sm"
              disabled={disabled || manualInput.trim() === ""}
              loading={pending === "manual"}
              onPress={() => void submitManual()}
            >
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

export const OfficialAccountsPanel = memo(OfficialAccountsPanelComponent);
