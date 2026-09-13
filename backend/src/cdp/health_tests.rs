use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

async fn accept_bridge(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(stream).await.unwrap();
    for id in 1..=5 {
        let command = socket.next().await.unwrap().unwrap();
        let command: serde_json::Value = serde_json::from_str(command.to_text().unwrap()).unwrap();
        assert_eq!(command["id"], id);
        socket
            .send(Message::Text(
                json!({"id": id, "result": {}}).to_string().into(),
            ))
            .await
            .unwrap();
    }
    socket
}

async fn serve_busy_probe(listener: &TcpListener) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut probe = accept_async(stream).await.unwrap();
    let command = probe.next().await.unwrap().unwrap();
    let command: serde_json::Value = serde_json::from_str(command.to_text().unwrap()).unwrap();
    assert_eq!(command["method"], "Runtime.evaluate");
    let response = json!({
        "id": command["id"],
        "result": {"result": {"type": "string", "value": "busy"}},
    });
    probe
        .send(Message::Text(response.to_string().into()))
        .await
        .unwrap();
}

async fn target_with_pump(close_pump: bool) -> (InjectedTarget, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut socket = Some(accept_bridge(&listener).await);
        if close_pump {
            drop(socket.take());
        }
        serve_busy_probe(&listener).await;
        if let Some(mut socket) = socket {
            while socket.next().await.is_some() {}
        }
    });
    let pump = install_bridge(
        &url,
        codey_runtime_core::bridge::BRIDGE_BINDING_NAME,
        bridge_handler(|_, _| async { json!({"status": "ok"}) }),
        &[],
    )
    .await
    .unwrap();
    if close_pump {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !pump.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("disconnected pump should exit");
    }
    (
        InjectedTarget {
            websocket_url: url.into(),
            pump,
            injection_statuses: Arc::from([]),
        },
        server,
    )
}

#[tokio::test]
async fn disconnected_pump_is_not_mistaken_for_a_busy_renderer() {
    let (target, server) = target_with_pump(true).await;
    let health = is_target_healthy(&target).await.unwrap();
    target.close().await;
    server.abort();
    assert_eq!(health, TargetHealth::Disconnected);
}

#[tokio::test]
async fn live_pump_preserves_busy_renderer_protection() {
    let (target, server) = target_with_pump(false).await;
    let health = is_target_healthy(&target).await.unwrap();
    target.close().await;
    server.await.unwrap();
    assert_eq!(health, TargetHealth::Busy);
}
