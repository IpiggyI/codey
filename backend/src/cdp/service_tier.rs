use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

const PREPARE: &str = include_str!("service_tier.js");
const OBJECT_GROUP: &str = "codey-service-tier";
/// Time for the module to load and the React scope to mount after the page
/// starts; matches the previous in-page polling budget.
const DISCOVERY_BUDGET: Duration = Duration::from_secs(10);
pub(super) const INSTALL_PATH: &str = "/internal/codey/service-tier/install";
pub(super) const LOADER: &str = r#"(() => {
  const bridge = window.__codexSessionDeleteBridge;
  if (window.__codeyServiceTierBridge === bridge
    && ['pending','ready'].includes(window.__codeyServiceTierStatus?.status)) return;
  const state = {status:'pending'};
  window.__codeyServiceTierStatus = state;
  window.__codeyServiceTierBridge = bridge;
  window.__codeyServiceTierInstallation = bridge(
    '/internal/codey/service-tier/install', {}, {timeoutMs:25000}
  ).then(result => {
    if (result?.status !== 'ok') throw new Error(result?.message || '服务档位兼容未生效');
    state.status = 'ready';
  }).catch(error => {
    console.error('[Codey] 服务档位兼容失败', error);
    state.status = 'failed';
    state.error = String(error.message || error);
  });
})()"#;

struct Session {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    breakpoint: Option<String>,
    /// `app-initial` script URLs reported by `Debugger.scriptParsed`. Current
    /// Codex loads the module through a dynamic import chain that leaves no
    /// page tag, and its resource timings may be cleared.
    modules: BTreeSet<String>,
}

struct InstallAttempt<'a> {
    target_id: &'a str,
    started: Instant,
    phase: &'static str,
}

impl InstallAttempt<'_> {
    fn record(&self, phase: &str, error: Option<&anyhow::Error>) {
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "service_tier_renderer",
            json!({
                "targetId": self.target_id,
                "phase": phase,
                "reachedPhase": self.phase,
                "elapsedMs": self.started.elapsed().as_millis() as u64,
                "error": error.map(|error| format!("{error:#}")),
            }),
        );
    }
}

impl Session {
    async fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        let id = self.id;
        self.socket
            .send(Message::Text(
                json!({"id": id, "method": method, "params": params})
                    .to_string()
                    .into(),
            ))
            .await?;
        while let Some(message) = self.socket.next().await {
            let message = message?;
            let Message::Text(text) = message else {
                continue;
            };
            let response: Value = serde_json::from_str(&text)?;
            self.observe(&response);
            if response["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                bail!(
                    "服务档位调试命令失败：{method}：{}",
                    failure_detail(error.get("message"))
                );
            }
            let result = response["result"].clone();
            if let Some(details) = result.get("exceptionDetails") {
                bail!(
                    "服务档位页面检查失败：{method}：{}",
                    failure_detail(
                        details
                            .pointer("/exception/description")
                            .or_else(|| details.get("text"))
                    )
                );
            }
            return Ok(result);
        }
        Err(anyhow!("服务档位调试连接已关闭"))
    }

    fn observe(&mut self, message: &Value) {
        if message["method"] != "Debugger.scriptParsed" {
            return;
        }
        if let Some(url) = message.pointer("/params/url").and_then(Value::as_str)
            && is_service_tier_module(url)
        {
            self.modules.insert(url.to_string());
        }
    }

    /// Enabling the debugger replays every parsed script, so a loaded module
    /// is found at once; during startup this waits for the module to parse.
    async fn discover_module(&mut self, deadline: Instant) -> Result<String> {
        while self.modules.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(message) = tokio::time::timeout(remaining, self.socket.next()).await else {
                break;
            };
            let message = message.context("服务档位调试连接已关闭")??;
            if let Message::Text(text) = message {
                self.observe(&serde_json::from_str(&text)?);
            }
        }
        match self.modules.len() {
            1 => Ok(self.modules.first().cloned().unwrap_or_default()),
            0 => bail!(
                "未找到服务档位模块：调试器 {} 秒内没有报告已加载的 app-initial 脚本",
                DISCOVERY_BUDGET.as_secs()
            ),
            count => bail!(
                "找到 {count} 个服务档位模块：{}",
                self.modules.iter().cloned().collect::<Vec<_>>().join("、")
            ),
        }
    }

    async fn call(&mut self, object: &str, declaration: &str, by_value: bool) -> Result<Value> {
        self.command(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object, "functionDeclaration": declaration,
                "awaitPromise": true, "returnByValue": by_value, "objectGroup": OBJECT_GROUP,
            }),
        )
        .await
    }

    async fn apply(&mut self, attempt: &mut InstallAttempt<'_>) -> Result<()> {
        let deadline = Instant::now() + DISCOVERY_BUDGET;
        self.command("Debugger.enable", json!({})).await?;
        let module = self.discover_module(deadline).await?;
        let attempts = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .div_ceil(100)
            .max(1);
        let prepared = self
            .command(
                "Runtime.evaluate",
                json!({
                    "expression": format!(
                        "(async()=>{{{PREPARE};return codeyPrepareServiceTier({},{attempts})}})()",
                        serde_json::to_string(&module)?
                    ),
                    "awaitPromise": true, "objectGroup": OBJECT_GROUP,
                }),
            )
            .await?;
        let holder = object_id(&prepared)?;
        if self
            .call(&holder, "function(){return this.ready===true}", true)
            .await?
            .pointer("/result/value")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Ok(());
        }
        attempt.phase = "bind";
        attempt.record("bind", None);
        self.bind(&holder).await
    }

    async fn bind(&mut self, holder: &str) -> Result<()> {
        let reader = object_id(
            &self
                .call(holder, "function(){return this.reader}", false)
                .await?,
        )?;
        let expression = self
            .call(holder, "function(){return this.expression}", true)
            .await?;
        let expression = expression
            .pointer("/result/value")
            .and_then(Value::as_str)
            .context("服务档位补偿表达式不存在")?;
        // A false condition runs in the module's lexical scope without pausing
        // the renderer. The owned call below reads only the default tier.
        let breakpoint = self
            .command(
                "Debugger.setBreakpointOnFunctionCall",
                json!({
                    "objectId": reader, "condition": format!("({expression},false)"),
                }),
            )
            .await?;
        self.breakpoint = Some(
            breakpoint["breakpointId"]
                .as_str()
                .context("服务档位函数断点未建立")?
                .to_string(),
        );
        let result = self.call(holder,
            "async function(){await this.reader(this.scope,'local',null,'default');return this.check()}", true).await?;
        ensure!(
            result.pointer("/result/value").and_then(Value::as_bool) == Some(true),
            "服务档位模块绑定未生效"
        );
        Ok(())
    }

    async fn cleanup(&mut self) -> Result<()> {
        if let Some(id) = self.breakpoint.take() {
            self.command("Debugger.removeBreakpoint", json!({"breakpointId": id}))
                .await?;
        }
        self.command(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup": OBJECT_GROUP}),
        )
        .await?;
        self.command("Debugger.disable", json!({})).await?;
        Ok(())
    }
}

/// Same rule as the page check: the file name starts with `app-initial`.
fn is_service_tier_module(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or(path);
    name.starts_with("app-initial") && name.ends_with(".js")
}

/// Keeps only the first line of the error so page stacks stay out of the log.
fn failure_detail(value: Option<&Value>) -> String {
    let line = value
        .and_then(Value::as_str)
        .and_then(|text| text.lines().next())
        .unwrap_or("无详情");
    super::truncate_chars(line, 160)
}

fn object_id(response: &Value) -> Result<String> {
    response
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("服务档位页面对象不存在")
}

pub(super) async fn install(websocket_url: &str) -> Result<()> {
    let mut attempt = InstallAttempt {
        target_id: websocket_url.rsplit('/').next().unwrap_or(""),
        started: Instant::now(),
        phase: "prepare",
    };
    attempt.record("prepare", None);
    let result = install_attempt(websocket_url, &mut attempt).await;
    attempt.record(
        if result.is_ok() { "ready" } else { "failed" },
        result.as_ref().err(),
    );
    result
}

async fn install_attempt(websocket_url: &str, attempt: &mut InstallAttempt<'_>) -> Result<()> {
    let socket = codey_runtime_core::bridge::connect_cdp_websocket(websocket_url)
        .await
        .context("连接服务档位调试入口失败")?;
    let mut session = Session {
        socket,
        id: 0,
        breakpoint: None,
        modules: BTreeSet::new(),
    };
    let result = tokio::time::timeout(Duration::from_secs(15), session.apply(attempt))
        .await
        .context("服务档位补偿超时")
        .and_then(|result| result);
    let cleanup = tokio::time::timeout(Duration::from_secs(2), session.cleanup())
        .await
        .context("服务档位补偿清理超时")
        .and_then(|result| result);
    // Closing also releases this connection's breakpoint if cleanup failed.
    let _ = tokio::time::timeout(Duration::from_secs(1), session.socket.close(None)).await;
    result.and(cleanup)
}

#[cfg(test)]
#[path = "service_tier_tests.rs"]
mod tests;
