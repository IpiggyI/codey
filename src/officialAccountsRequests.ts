import type { CodeyApiCommand } from "./api";
import type { OfficialAccount, OfficialAccountsResult, OfficialUsageSnapshot } from "./App.types";
import { errorText } from "./appUtils";

export type AccountsCall = <T>(command: CodeyApiCommand, args?: Record<string, unknown>) => Promise<T>;

export type AccountsView = Omit<OfficialAccountsResult, "status" | "accountId">;

export type UsageView =
  | { status: "ok"; snapshot: OfficialUsageSnapshot }
  | { status: "error"; message: string };

type UsageQueryResult =
  | (OfficialUsageSnapshot & { status: "ok"; authGeneration: number })
  | { status: "error"; message?: string };

type LoginPollResult =
  | { status: "wait" }
  | { status: "expired"; message?: string }
  | (OfficialAccountsResult & { status: "ok" });

export const LOGIN_POLL_INTERVAL_MS = 1500;

const pickAccount = (raw: OfficialAccount): OfficialAccount => ({
  id: raw.id,
  accountId: raw.accountId,
  addedAt: raw.addedAt,
  invalid: raw.invalid === true,
  isDefault: raw.isDefault === true,
  ...(typeof raw.email === "string" ? { email: raw.email } : {}),
  ...(typeof raw.planType === "string" ? { planType: raw.planType } : {}),
  ...(typeof raw.lastRefresh === "string" ? { lastRefresh: raw.lastRefresh } : {}),
});

// 只保留已声明的摘要字段，响应里多出的字段（包括误带的凭据）不会进入界面状态。
export function accountsView(result: OfficialAccountsResult): AccountsView {
  if (!Array.isArray(result.accounts)) throw new Error("官方账号列表格式无效，请重新读取");
  return {
    accounts: result.accounts.map(pickAccount),
    defaultAccountId: result.defaultAccountId ?? null,
    officialAccountAvailable: result.officialAccountAvailable === true,
    officialAccountStatus: result.officialAccountStatus,
    switchDisabledReason: result.switchDisabledReason ?? null,
  };
}

// 每次列表请求或账号变更结果都使在途的列表请求作废，旧响应不能覆盖较新的账号状态。
// Codex 当前登录的账号换成另一个库内账号时 switched 为 true，无论切换来自账号面板还是渠道列表。
export function createAccountListState(deps: {
  call: AccountsCall;
  onView: (view: AccountsView, switched: boolean) => void;
  onError: (message: string) => void;
}) {
  let generation = 0;
  let disposed = false;
  let lastDefault: string | null | undefined;

  function accept(result: OfficialAccountsResult) {
    const view = accountsView(result);
    const switched = lastDefault !== undefined && view.defaultAccountId !== null && view.defaultAccountId !== lastDefault;
    lastDefault = view.defaultAccountId;
    deps.onView(view, switched);
  }

  async function refresh() {
    const request = ++generation;
    try {
      const result = await deps.call<OfficialAccountsResult>("list_official_accounts");
      if (disposed || request !== generation) return;
      accept(result);
    } catch (error) {
      if (disposed || request !== generation) return;
      deps.onError(errorText(error));
    }
  }

  function apply(result: OfficialAccountsResult) {
    if (disposed) return;
    generation += 1;
    try {
      accept(result);
    } catch (error) {
      deps.onError(errorText(error));
    }
  }

  return {
    refresh,
    apply,
    dispose: () => {
      disposed = true;
      generation += 1;
    },
  };
}

// 账号额度按账号分别守卫：请求代次挡住较早发出的请求，凭据代次挡住旧凭据的结果。
export function createUsageTracker(deps: {
  call: AccountsCall;
  onUsage: (accountId: string, view: UsageView) => void;
  onLoading: (accountId: string, loading: boolean) => void;
}) {
  const requests = new Map<string, number>();
  const credentials = new Map<string, number>();
  let disposed = false;

  async function refresh(accountId: string, forceRefresh: boolean) {
    const request = (requests.get(accountId) ?? 0) + 1;
    requests.set(accountId, request);
    const latest = () => !disposed && requests.get(accountId) === request;
    const outdated = (authGeneration: number) => authGeneration < (credentials.get(accountId) ?? 0);
    deps.onLoading(accountId, true);
    try {
      const result = await deps.call<UsageQueryResult>("query_official_account_usage", { accountId, forceRefresh });
      if (!latest()) return;
      if (result.status !== "ok") {
        deps.onUsage(accountId, { status: "error", message: result.message || "账号额度暂不可用" });
        return;
      }
      const { status: _status, authGeneration, ...snapshot } = result;
      if (outdated(authGeneration)) return;
      await deps.call("store_official_account_usage", { accountId, authGeneration, snapshot });
      if (!latest() || outdated(authGeneration)) return;
      credentials.set(accountId, authGeneration);
      deps.onUsage(accountId, { status: "ok", snapshot });
    } catch (error) {
      if (latest()) deps.onUsage(accountId, { status: "error", message: errorText(error) });
    } finally {
      if (latest()) deps.onLoading(accountId, false);
    }
  }

  return {
    refresh,
    dispose: () => {
      disposed = true;
    },
  };
}

// 浏览器登录轮询：取消、换成新的登录或到达终态后停止，旧 loginId 的结果一律忽略。
export function createLoginPoll(deps: {
  call: AccountsCall;
  onSuccess: (result: OfficialAccountsResult) => void;
  onFailure: (message: string) => void;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (handle: unknown) => void;
}) {
  let current: string | null = null;
  let timer: unknown;

  function stop() {
    current = null;
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
  }

  async function poll(loginId: string) {
    timer = undefined;
    let result: LoginPollResult;
    try {
      result = await deps.call<LoginPollResult>("poll_official_account_login", { loginId });
    } catch (error) {
      if (current !== loginId) return;
      stop();
      deps.onFailure(errorText(error));
      return;
    }
    if (current !== loginId) return;
    if (result.status === "wait") {
      timer = deps.setTimer(() => void poll(loginId), LOGIN_POLL_INTERVAL_MS);
      return;
    }
    stop();
    if (result.status === "ok") deps.onSuccess(result);
    else deps.onFailure(result.message || "登录已过期，请重新开始");
  }

  return {
    start(loginId: string) {
      stop();
      current = loginId;
      void poll(loginId);
    },
    stop,
  };
}
