use anyhow::{Context, Result};
use std::time::Duration;

const MCP_RELOAD_EVALUATE_TIMEOUT: Duration = Duration::from_secs(20);
const SESSION_TOOLS_INJECT_TIMEOUT: Duration = Duration::from_secs(8);

fn runtime_value(response: &serde_json::Value) -> Option<&serde_json::Value> {
    response.get("result")?.get("result")?.get("value")
}

pub async fn reload_mcp_servers(websocket_url: &str) -> Result<()> {
    // 会话工具是按需注入的。若在已阻塞的 awaitPromise 里再走页面桥接去
    // Runtime.evaluate 注入脚本，部分 Chromium/Electron 会把后续 evaluate 排
    // 到当前 Promise 之后，形成死等。这里先用独立命令装好刷新入口。
    ensure_mcp_reload_function_ready(websocket_url).await;
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        r#"(async () => {
  const pickClient = () => {
    const clients = window.__codeyAppServerRequestClients;
    if (!clients || typeof clients.get !== "function") return null;
    const local = clients.get("local");
    if (local && typeof local.sendRequest === "function") return local;
    if (typeof clients.values !== "function") return null;
    const all = [...clients.values()].filter((client) => typeof client?.sendRequest === "function");
    return all.length === 1 ? all[0] : null;
  };
  for (const delay of [0, 200, 500, 1000, 2000]) {
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    try {
      const client = pickClient();
      if (client) {
        await client.sendRequest("config/mcpServer/reload", {});
        return true;
      }
      if (typeof window.__codeyReloadMcpServers === "function") {
        const result = await window.__codeyReloadMcpServers();
        if (result?.ok === true) return true;
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (/unknown method/i.test(message)) return false;
    }
  }
  return false;
})()"#,
        true,
        MCP_RELOAD_EVALUATE_TIMEOUT,
    )
    .await
    .context("请求 Codex 刷新 MCP 配置失败")?;
    anyhow::ensure!(
        runtime_value(&response).and_then(serde_json::Value::as_bool) == Some(true),
        "Codex 未确认 MCP 配置刷新"
    );
    Ok(())
}

async fn mcp_reload_function_available(websocket_url: &str) -> bool {
    codey_runtime_core::bridge::evaluate_script(
        websocket_url,
        r#"typeof window.__codeyReloadMcpServers === "function"
          || typeof window.__codeyAppServerRequestClients?.get?.("local")?.sendRequest === "function""#,
    )
    .await
    .ok()
    .and_then(|response| runtime_value(&response).and_then(serde_json::Value::as_bool))
    .unwrap_or(false)
}

async fn ensure_mcp_reload_function_ready(websocket_url: &str) {
    if mcp_reload_function_available(websocket_url).await {
        return;
    }
    let _ = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        &crate::cdp::prepared_session_tools_load_script(),
        false,
        SESSION_TOOLS_INJECT_TIMEOUT,
    )
    .await;
    for delay_ms in [80_u64, 200, 500, 1000] {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        if mcp_reload_function_available(websocket_url).await {
            return;
        }
    }
}
