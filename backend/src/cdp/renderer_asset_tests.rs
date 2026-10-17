use super::*;
use codey_runtime_core::bridge::{BridgeHandler, install_bridge};
use std::io::Write;
use std::process::{Command, Stdio};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;

#[derive(Default)]
struct PageState {
    scripts: HashMap<String, String>,
    reloads: usize,
    documents: Vec<Vec<String>>,
    methods: Vec<String>,
}

struct TestPage {
    url: String,
    state: Arc<Mutex<PageState>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for TestPage {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl TestPage {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/devtools/page/test", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(PageState::default()));
        let shared = state.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let state = shared.clone();
                        connections.spawn(async move {
                            let mut socket = accept_async(stream).await.unwrap();
                            let mut page_enabled = false;
                            while let Some(Ok(Message::Text(text))) = socket.next().await {
                                let command: Value = serde_json::from_str(&text).unwrap();
                                let (result, events) = reply(&command, &state, &mut page_enabled);
                                for event in events {
                                    socket.send(Message::Text(event.to_string().into())).await.unwrap();
                                }
                                socket.send(Message::Text(json!({
                                    "id": command["id"], "result": result,
                                }).to_string().into())).await.unwrap();
                            }
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Self { url, state, server }
    }
}

fn context_event(id: u64) -> Value {
    json!({"method": "Runtime.executionContextCreated", "params": {"context": {
        "id": id, "auxData": {"isDefault": true, "frameId": "main"},
    }}})
}

fn entry_event() -> Value {
    json!({"method": "Fetch.requestPaused", "params": {
        "requestId": "document", "request": {"url": "app://-/index.html"},
        "responseStatusCode": 200,
    }})
}

fn reply(
    command: &Value,
    state: &Mutex<PageState>,
    page_enabled: &mut bool,
) -> (Value, Vec<Value>) {
    let method = command["method"].as_str().unwrap();
    let mut state = state.lock().unwrap();
    state.methods.push(method.to_string());
    match method {
        "Runtime.enable" => (json!({}), vec![context_event(1)]),
        "Page.enable" => {
            *page_enabled = true;
            (json!({}), vec![])
        }
        "Page.getFrameTree" => (json!({"frameTree": {"frame": {"id": "main"}}}), vec![]),
        "Page.addScriptToEvaluateOnNewDocument" => {
            // 此模拟遵守 Chromium 的 Page 域约束；去掉生产 Page.enable 会使重载断言失败。
            let identifier = format!("script-{}", state.scripts.len());
            if *page_enabled {
                state.scripts.insert(
                    identifier.clone(),
                    command["params"]["source"].as_str().unwrap().to_string(),
                );
            }
            (json!({"identifier": identifier}), vec![])
        }
        "Page.removeScriptToEvaluateOnNewDocument" => {
            state
                .scripts
                .remove(command["params"]["identifier"].as_str().unwrap());
            (json!({}), vec![])
        }
        "Runtime.callFunctionOn" => {
            let value = if command["params"].get("arguments").is_some() {
                Value::Null
            } else {
                json!({"ready": "complete", "url": "app://-/index.html"})
            };
            (json!({"result": {"value": value}}), vec![])
        }
        "Page.reload" => {
            assert!(state.methods.iter().any(|method| method == "Fetch.enable"));
            state.reloads += 1;
            let scripts = state.scripts.values().cloned().collect();
            state.documents.push(scripts);
            (
                json!({}),
                vec![
                    json!({"method": "Runtime.executionContextsCleared"}),
                    context_event(2),
                    entry_event(),
                ],
            )
        }
        "Fetch.getResponseBody" => (
            json!({"body": "<html></html>", "base64Encoded": false}),
            vec![],
        ),
        _ => (json!({}), vec![]),
    }
}

async fn close_session(session: Arc<RendererAssetPatchSession>) {
    if let Some(pump) = session.pump.lock().unwrap().take() {
        pump.abort();
    }
    patch_sessions()
        .lock()
        .unwrap()
        .remove(session.websocket_url.as_ref());
    covered_targets()
        .lock()
        .unwrap()
        .remove(session.websocket_url.as_ref());
    patch_doc_scripts()
        .lock()
        .unwrap()
        .remove(session.websocket_url.as_ref());
}

#[tokio::test]
async fn late_attach_reloads_once_and_persistent_bridge_scripts_run_in_the_new_document() {
    let page = TestPage::start().await;
    let handler: BridgeHandler = Arc::new(|_, _| Box::pin(async { Ok(json!({"status": "ok"})) }));
    let bridge = install_bridge(
        &page.url,
        "testBinding",
        handler,
        &["window.featureRuns = (window.featureRuns || 0) + 1;".to_string()],
    )
    .await
    .unwrap();
    let session = install_renderer_asset_patch(&page.url, false, false)
        .await
        .unwrap();
    session.ensure_document_coverage().await.unwrap();
    session.ensure_document_coverage().await.unwrap();
    let scripts = {
        let state = page.state.lock().unwrap();
        assert_eq!(state.reloads, 1);
        state.documents[0].clone()
    };
    // 执行真实 install_bridge 注册的脚本，而不是仅检查注册命令或脚本文本。
    let mut child = Command::new("node")
        .args([
            "-e",
            r#"
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const scripts = JSON.parse(fs.readFileSync(0, 'utf8'));
const page = vm.createContext({ console, URL, crypto: { randomUUID: () => 'new-document' } });
page.window = page;
page.testBinding = () => {};
for (const source of scripts) vm.runInContext(source, page);
assert.equal(page.featureRuns, 1);
assert.equal(typeof page.__codeyRendererPatchEntry, 'function');
assert.equal(typeof page.__codexSessionDeleteBridge, 'function');
page.__codexSessionDeleteBridge('/backend/health', {});
assert.equal(page.__codexSessionDeleteCallbacks.has('new-document:1'), true);
"#,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&scripts).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    bridge.close().await;
    close_session(session).await;
}

#[tokio::test]
async fn early_attach_installs_fetch_without_evaluating_or_reloading_a_paused_page() {
    let page = TestPage::start().await;
    let session = install_renderer_asset_patch(&page.url, true, true)
        .await
        .unwrap();
    {
        let state = page.state.lock().unwrap();
        assert!(state.methods.iter().any(|method| method == "Fetch.enable"));
        assert!(
            !state
                .methods
                .iter()
                .any(|method| method == "Runtime.evaluate")
        );
    }
    // 即使首导航的入口事件尚未到达，也不把提前连接误判为晚连接。
    session.ensure_document_coverage().await.unwrap();
    assert_eq!(page.state.lock().unwrap().reloads, 0);
    close_session(session).await;
}

#[tokio::test]
async fn paused_assets_are_fulfilled_or_continued_with_rewrite_statistics() {
    for patched in [true, false] {
        let (command_tx, mut commands) = mpsc::unbounded_channel();
        let (_context_tx, context_rx) = watch::channel(Some(7));
        let counters = Arc::new(PatchSessionCounters::default());
        let evaluator = PatchEvaluator::new("not-a-websocket-url", Arc::from(""));
        let server = tokio::spawn(async move {
            let mut methods = Vec::new();
            while let Some(command) = commands.recv().await {
                match command {
                    SessionCommand::Cdp {
                        method,
                        params,
                        respond,
                    } => {
                        methods.push(method);
                        let result = match method {
                            "Fetch.getResponseBody" => {
                                json!({"body": "b3JpZ2luYWw=", "base64Encoded": true})
                            }
                            "Runtime.callFunctionOn" => {
                                assert_eq!(params["executionContextId"], 7);
                                assert_eq!(params["arguments"][1]["value"], "original");
                                json!({"result": {"value": if patched { json!("rewritten") } else { Value::Null }}})
                            }
                            "Fetch.fulfillRequest" => {
                                assert!(patched);
                                assert_eq!(params["responseCode"], 203);
                                assert_eq!(params["body"], "cmV3cml0dGVu");
                                assert_eq!(
                                    params["responseHeaders"],
                                    json!([
                                        {"name": "Content-Type", "value": "text/javascript"},
                                    ])
                                );
                                let _ = respond.send(Ok(json!({"result": {}})));
                                return methods;
                            }
                            _ => panic!("unexpected method: {method}"),
                        };
                        respond.send(Ok(json!({"result": result}))).unwrap();
                    }
                    SessionCommand::CdpFireAndForget { method, params } => {
                        assert!(!patched);
                        assert_eq!(method, "Fetch.continueRequest");
                        assert_eq!(params["requestId"], "asset");
                        methods.push(method);
                        return methods;
                    }
                }
            }
            panic!("paused request was never released");
        });
        tokio::time::timeout(
            Duration::from_secs(2),
            process_paused_asset(
                command_tx,
                context_rx,
                Arc::from(""),
                evaluator,
                counters.clone(),
                json!({
                    "requestId": "asset", "request": {"url": "app://-/assets/app-shared-test.js"},
                    "responseStatusCode": 203,
                    "responseHeaders": [
                        {"name": "Content-Type", "value": "text/javascript"},
                        {"name": "Content-Length", "value": "8"},
                        {"name": "Content-Encoding", "value": "br"},
                    ],
                }),
            ),
        )
        .await
        .unwrap();
        let methods = server.await.unwrap();
        assert_eq!(methods.len(), 3);
        assert_eq!(counters.evaluated.load(Ordering::Relaxed), 1);
        assert_eq!(counters.patched.load(Ordering::Relaxed), u64::from(patched));
        assert_eq!(
            counters.skipped.load(Ordering::Relaxed),
            u64::from(!patched)
        );
    }
}
