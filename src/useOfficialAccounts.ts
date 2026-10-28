import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "./api";
import type { OfficialAccountsResult } from "./App.types";
import {
  createAccountListState,
  createUsageTracker,
  type AccountsView,
  type UsageView,
} from "./officialAccountsRequests";

// 账号较多时连续查询账号额度容易触发官方风控，逐个查询之间留出间隔。
const USAGE_QUERY_STAGGER_MS = 200;

type Options = {
  active: boolean;
  // 渠道切换等外部变更递增此值，触发重新读取账号列表。
  refreshKey: number;
};

export function useOfficialAccounts({ active, refreshKey }: Options) {
  const [view, setView] = useState<AccountsView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [accountSwitched, setAccountSwitched] = useState(false);
  const [usages, setUsages] = useState<Record<string, UsageView>>({});
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({});
  const listRef = useRef<ReturnType<typeof createAccountListState> | null>(null);
  const usageRef = useRef<ReturnType<typeof createUsageTracker> | null>(null);

  useEffect(() => {
    const list = createAccountListState({
      call: invoke,
      onView: (next, switched) => {
        setView(next);
        setLoadError("");
        if (switched) setAccountSwitched(true);
      },
      onError: setLoadError,
    });
    const usage = createUsageTracker({
      call: invoke,
      onUsage: (accountId, next) => setUsages((current) => ({ ...current, [accountId]: next })),
      onLoading: (accountId, loading) => setUsageLoading((current) => ({ ...current, [accountId]: loading })),
    });
    listRef.current = list;
    usageRef.current = usage;
    return () => {
      list.dispose();
      usage.dispose();
    };
  }, []);

  useEffect(() => {
    void listRef.current?.refresh();
  }, [refreshKey]);

  // 页面打开期间按账号列表逐个查询账号额度；页面关闭或列表变化时停止本轮查询。
  const accountKey = view?.accounts.filter((account) => !account.invalid).map((account) => account.id).join("\n") ?? "";
  useEffect(() => {
    if (!active || !accountKey) return;
    let cancelled = false;
    void (async () => {
      for (const [index, accountId] of accountKey.split("\n").entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, USAGE_QUERY_STAGGER_MS));
        if (cancelled) return;
        await usageRef.current?.refresh(accountId, false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, accountKey]);

  const apply = useCallback((result: OfficialAccountsResult) => listRef.current?.apply(result), []);
  const refresh = useCallback(() => listRef.current?.refresh() ?? Promise.resolve(), []);
  const refreshUsage = useCallback(
    (accountId: string) => usageRef.current?.refresh(accountId, true) ?? Promise.resolve(),
    [],
  );

  return { view, loadError, accountSwitched, usages, usageLoading, apply, refresh, refreshUsage };
}
