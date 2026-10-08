use anyhow::{Context, Result, anyhow, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

const PREPARE: &str = include_str!("service_tier.js");
const OBJECT_GROUP: &str = "codey-service-tier";
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
            if response["id"].as_u64() != Some(id) {
                continue;
            }
            ensure!(
                response.get("error").is_none(),
                "服务档位调试命令失败：{method}"
            );
            let result = response["result"].clone();
            ensure!(
                result.get("exceptionDetails").is_none(),
                "服务档位页面检查失败：{method}"
            );
            return Ok(result);
        }
        Err(anyhow!("服务档位调试连接已关闭"))
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

    async fn apply(&mut self) -> Result<()> {
        self.command("Debugger.enable", json!({})).await?;
        let prepared = self.command("Runtime.evaluate", json!({
            "expression": format!("(async()=>{{{PREPARE};return codeyPrepareServiceTier()}})()"),
            "awaitPromise": true, "objectGroup": OBJECT_GROUP,
        })).await?;
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

fn object_id(response: &Value) -> Result<String> {
    response
        .pointer("/result/objectId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("服务档位页面对象不存在")
}

pub(super) async fn install(websocket_url: &str) -> Result<()> {
    let socket = codey_runtime_core::bridge::connect_cdp_websocket(websocket_url)
        .await
        .context("连接服务档位调试入口失败")?;
    let mut session = Session {
        socket,
        id: 0,
        breakpoint: None,
    };
    let result = tokio::time::timeout(Duration::from_secs(15), session.apply())
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
