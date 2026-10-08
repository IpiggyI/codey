use super::*;
use std::sync::Arc;

async fn evaluate(probe: &mut Session, expression: &str) -> Value {
    probe
        .command(
            "Runtime.evaluate",
            json!({
                "expression": expression, "awaitPromise": true, "returnByValue": true,
            }),
        )
        .await
        .unwrap()["result"]["value"]
        .clone()
}

async fn wait_status(probe: &mut Session, expected: &str) {
    let result = tokio::time::timeout(Duration::from_secs(28), async {
        loop {
            let response = probe.command("Runtime.evaluate", json!({
                "expression": "window.__codeyServiceTierStatus?.status", "returnByValue": true,
            })).await;
            if let Ok(response) = response {
                let status = &response["result"]["value"];
                if status == expected {
                    break;
                }
                assert_ne!(status, "failed", "unexpected installation failure");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "expected {expected}, page state: {}",
        evaluate(
            probe,
            "({status:window.__codeyServiceTierStatus,ready:window.ready,path:location.pathname})"
        )
        .await
    );
}

async fn bridge(url: &str) -> codey_runtime_core::bridge::BridgePumpHandle {
    let handler = super::super::bridge_handler(|path, _| async move {
        panic!("unexpected bridge route: {path}");
    });
    codey_runtime_core::bridge::install_bridge(
        url,
        codey_runtime_core::bridge::BRIDGE_BINDING_NAME,
        super::super::with_lazy_loaders(handler, Arc::from(url)),
        &[
            LOADER.to_string(),
            "window.codeyOtherScriptRuns=(window.codeyOtherScriptRuns||0)+1".to_string(),
        ],
    )
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires the isolated browser from tests/service-tier-browser.mjs"]
async fn browser_install() {
    let url = std::env::var("CODEY_TIER_TEST_WS").unwrap();
    let page_url = std::env::var("CODEY_TIER_TEST_URL").unwrap();
    let (socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let mut probe = Session {
        socket,
        id: 0,
        breakpoint: None,
    };
    assert_eq!(
        evaluate(
            &mut probe,
            "nativeTier.read(nativeTierEnvironment.scope,'local','supported','priority')"
        )
        .await,
        Value::Null
    );
    let mut pump = bridge(&url).await;
    for round in 0..3 {
        wait_status(&mut probe, "ready").await;
        assert_eq!(
            evaluate(&mut probe, "window.codeyOtherScriptRuns").await,
            if round == 1 { 2 } else { 1 }
        );
        assert_eq!(evaluate(&mut probe,
            "(async()=>{const s=nativeTierEnvironment.scope;return [await nativeTier.read(s,'local','supported','priority'),await nativeTier.read(s,'local','supported','default'),await nativeTier.read(s,'local','unsupported','priority')]})()"
        ).await, json!(["priority", null, null]));
        if round == 0 {
            // Replacing the bridge must not retain the previous document promise.
            pump.close().await;
            pump = bridge(&url).await;
        } else if round == 1 {
            evaluate(
                &mut probe,
                "window.__codeyServiceTierStatus=null;window.ready=false",
            )
            .await;
            probe.command("Page.reload", json!({})).await.unwrap();
        }
    }
    evaluate(&mut probe, "window.__codeyServiceTierStatus=null").await;
    probe
        .command(
            "Page.navigate",
            json!({"url": format!("{page_url}/incompatible")}),
        )
        .await
        .unwrap();
    wait_status(&mut probe, "failed").await;
    assert_eq!(
        evaluate(&mut probe, "nativeTier.read.__codeyServiceTier===1").await,
        false
    );
    // Failed preparation leaves the page responsive and a later navigation recovers.
    evaluate(&mut probe, "window.__codeyServiceTierStatus=null").await;
    probe
        .command("Page.navigate", json!({"url": page_url}))
        .await
        .unwrap();
    wait_status(&mut probe, "ready").await;
    pump.close().await;
    pending_calls_survive_reload(&url, &mut probe).await;
    probe.socket.close(None).await.unwrap();
}

async fn pending_calls_survive_reload(url: &str, probe: &mut Session) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for old_fails in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let release_old = Arc::new(tokio::sync::Notify::new());
        let release_new = Arc::new(tokio::sync::Notify::new());
        let handler: codey_runtime_core::bridge::BridgeHandler = {
            let (calls, old, new) = (calls.clone(), release_old.clone(), release_new.clone());
            Arc::new(move |_, _| {
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                let release = if first { old.clone() } else { new.clone() };
                Box::pin(async move {
                    release.notified().await;
                    if first && old_fails {
                        anyhow::bail!("old document failure");
                    }
                    Ok(json!({"document": if first { "old" } else { "new" }}))
                })
            })
        };
        let pump = codey_runtime_core::bridge::install_bridge(url,
            codey_runtime_core::bridge::BRIDGE_BINDING_NAME, handler,
            &["window.pendingResult='pending';window.__codexSessionDeleteBridge('/test/delayed',{}).then(r=>window.pendingResult=r)".to_string()]
        ).await.unwrap();
        evaluate(probe, "window.beforeReload=true").await;
        probe.command("Page.reload", json!({})).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while evaluate(
                probe,
                "window.beforeReload!==true && window.__codexSessionDeleteCallbacks?.size===1",
            )
            .await
                != true
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        release_old.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            evaluate(
                probe,
                "new Promise(resolve=>setTimeout(()=>resolve(window.pendingResult),100))"
            )
            .await,
            "pending",
            "old result must not settle a new document callback (old_fails={old_fails})"
        );
        release_new.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            while evaluate(probe, "window.pendingResult?.document==='new'").await != true {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        pump.close().await;
    }
}

#[tokio::test]
async fn binding_failure_releases_breakpoint_and_objects() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        for (method, response) in [
            ("Debugger.enable", json!({})),
            ("Runtime.evaluate", json!({"result":{"objectId":"holder"}})),
            ("Runtime.callFunctionOn", json!({"result":{"value":false}})),
            (
                "Runtime.callFunctionOn",
                json!({"result":{"objectId":"reader"}}),
            ),
            ("Runtime.callFunctionOn", json!({"result":{"value":"true"}})),
            (
                "Debugger.setBreakpointOnFunctionCall",
                json!({"breakpointId":"owned"}),
            ),
            (
                "Runtime.callFunctionOn",
                json!({"exceptionDetails":{"text":"fixture failure"}}),
            ),
            ("Debugger.removeBreakpoint", json!({})),
            ("Runtime.releaseObjectGroup", json!({})),
            ("Debugger.disable", json!({})),
        ] {
            let message = ws.next().await.unwrap().unwrap();
            let command: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(command["method"], method);
            if method == "Debugger.setBreakpointOnFunctionCall" {
                assert_eq!(command["params"]["condition"], "(true,false)");
            }
            if method == "Debugger.removeBreakpoint" {
                assert_eq!(command["params"]["breakpointId"], "owned");
            }
            ws.send(Message::Text(
                json!({"id":command["id"],"result":response})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        }
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
    });
    assert!(
        install(&url)
            .await
            .unwrap_err()
            .to_string()
            .contains("页面检查失败")
    );
    server.await.unwrap();
}

#[tokio::test]
async fn disconnected_debugger_reports_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.next().await.unwrap().unwrap();
        ws.close(None).await.unwrap();
    });
    assert!(install(&url).await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn unresponsive_debugger_times_out_and_cleans_up() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.next().await.unwrap().unwrap();
        for method in ["Runtime.releaseObjectGroup", "Debugger.disable"] {
            let message = ws.next().await.unwrap().unwrap();
            let command: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(command["method"], method);
            ws.send(Message::Text(
                json!({"id":command["id"],"result":{}}).to_string().into(),
            ))
            .await
            .unwrap();
        }
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
    });
    assert!(
        install(&url)
            .await
            .unwrap_err()
            .to_string()
            .contains("补偿超时")
    );
    server.await.unwrap();
}
