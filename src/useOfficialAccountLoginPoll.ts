import { useEffect, useRef } from "react";

import { invoke } from "./api";
import type { OfficialAccountsResult } from "./App.types";
import { createLoginPoll } from "./officialAccountsRequests";

type Options = {
  loginId?: string;
  onSuccess: (result: OfficialAccountsResult) => void;
  onFailure: (message: string) => void;
};

// loginId 变化、清空或组件卸载时停止上一轮轮询。
export function useOfficialAccountLoginPoll(options: Options) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const { loginId } = options;
  useEffect(() => {
    if (!loginId) return;
    const poll = createLoginPoll({
      call: invoke,
      onSuccess: (result) => callbacks.current.onSuccess(result),
      onFailure: (message) => callbacks.current.onFailure(message),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    });
    poll.start(loginId);
    return poll.stop;
  }, [loginId]);
}
