use anyhow::{Context, bail};
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::Duration;

const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
static CDP_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CdpTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}

pub async fn list_targets(debug_port: u16) -> anyhow::Result<Vec<CdpTarget>> {
    let client = cdp_http_client()?;
    // Chrome 150+ rejects DevTools HTTP when the Host header is an IP literal
    // and answers the same listener for `localhost`. Older builds and an
    // IPv6-only socket still need the explicit loopback URLs.
    let urls = [
        format!("http://localhost:{debug_port}/json"),
        format!("http://127.0.0.1:{debug_port}/json"),
        format!("http://[::1]:{debug_port}/json"),
    ];
    let mut errors = Vec::new();
    for url in urls {
        match query_targets_url(client, &url).await {
            Ok(targets) => return Ok(targets),
            Err(error) => errors.push(format!("{url}: {error:#}")),
        }
    }

    bail!(
        "failed to query CDP targets on loopback addresses: {}",
        errors.join("; ")
    )
}

/// 浏览器端点（`/json/version`）的 WebSocket 地址：Target 域的自动挂载
/// 只能在这条会话上做，page 级会话拿不到 Target 协议。
pub async fn browser_websocket_url(debug_port: u16) -> anyhow::Result<String> {
    let client = cdp_http_client()?;
    // 与 list_targets 相同的回环地址顺序：Chrome 150+ 拒绝 IP 字面量 Host。
    let urls = [
        format!("http://localhost:{debug_port}/json/version"),
        format!("http://127.0.0.1:{debug_port}/json/version"),
        format!("http://[::1]:{debug_port}/json/version"),
    ];
    let mut errors = Vec::new();
    for url in urls {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.json::<serde_json::Value>().await {
                    Ok(payload) => {
                        if let Some(ws_url) = payload
                            .get("webSocketDebuggerUrl")
                            .and_then(serde_json::Value::as_str)
                            .filter(|url| !url.is_empty())
                        {
                            return Ok(ws_url.to_string());
                        }
                        errors.push(format!("{url}: 响应缺少 webSocketDebuggerUrl"));
                    }
                    Err(error) => errors.push(format!("{url}: {error:#}")),
                },
                Err(error) => errors.push(format!("{url}: {error:#}")),
            },
            Err(error) => errors.push(format!("{url}: {error:#}")),
        }
    }
    anyhow::bail!(
        "failed to query CDP browser endpoint on loopback addresses: {}",
        errors.join("; ")
    )
}

fn cdp_http_client() -> anyhow::Result<&'static reqwest::Client> {
    if let Some(client) = CDP_HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CDP_HTTP_TIMEOUT)
        .build()
        .context("failed to build CDP HTTP client")?;
    let _ = CDP_HTTP_CLIENT.set(client);
    Ok(CDP_HTTP_CLIENT
        .get()
        .expect("CDP HTTP client must be initialized"))
}

async fn query_targets_url(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<CdpTarget>> {
    let response = client
        .get(url)
        .send()
        .await
        .context("failed to query CDP targets")?
        .error_for_status()
        .context("CDP target query failed")?;

    response
        .json::<Vec<CdpTarget>>()
        .await
        .context("failed to deserialize CDP targets")
}

pub fn pick_injectable_codex_page_target(targets: &[CdpTarget]) -> anyhow::Result<CdpTarget> {
    for target in targets
        .iter()
        .filter(|target| is_injectable_page_target(target))
    {
        if is_primary_codex_page_target(target) {
            return Ok(target.clone());
        }
    }

    bail!("No injectable Codex page target found")
}

pub fn is_injectable_page_target(target: &CdpTarget) -> bool {
    target.target_type == "page"
        && target
            .web_socket_debugger_url
            .as_deref()
            .is_some_and(|url| !url.is_empty())
}

pub fn is_codex_page_target(target: &CdpTarget) -> bool {
    if target.target_type != "page"
        || target
            .url
            .trim()
            .to_ascii_lowercase()
            .starts_with("data:text/html")
    {
        return false;
    }
    let haystack = format!("{} {}", target.title, target.url).to_lowercase();
    haystack.contains("codex")
        || is_chatgpt_desktop_page(&target.title, &target.url)
        || is_packaged_codex_page(&target.url)
}

pub fn is_primary_codex_page_target(target: &CdpTarget) -> bool {
    is_codex_page_target(target) && !is_avatar_overlay_page_target(target)
}

pub fn is_avatar_overlay_page_target(target: &CdpTarget) -> bool {
    if !is_injectable_page_target(target) {
        return false;
    }
    let url = target.url.trim().to_ascii_lowercase();
    url.starts_with("app://-/index.html?")
        && (url.contains("initialroute=%2favatar-overlay")
            || url.contains("initialroute=/avatar-overlay"))
}

fn is_chatgpt_desktop_page(title: &str, url: &str) -> bool {
    let title = title.trim().to_ascii_lowercase();
    let url = url.trim().to_ascii_lowercase();
    title == "chatgpt"
        && (url == "https://chatgpt.com"
            || url.starts_with("https://chatgpt.com/")
            || url == "https://chat.openai.com"
            || url.starts_with("https://chat.openai.com/"))
}

fn is_packaged_codex_page(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    url == "app://-/index.html"
        || url.starts_with("app://-/index.html?")
        || url.starts_with("app://-/index.html#")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdp_http_client_is_reused() {
        let first = cdp_http_client().unwrap();
        let second = cdp_http_client().unwrap();

        assert!(std::ptr::eq(first, second));
    }

    #[tokio::test]
    async fn browser_endpoint_reads_the_version_websocket_url() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let size = stream.read(&mut request).await.unwrap();
            let request = std::str::from_utf8(&request[..size]).unwrap();
            assert!(request.starts_with("GET /json/version HTTP/1.1\r\n"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains(&format!("host: localhost:{port}"))
            );
            let body = r#"{"webSocketDebuggerUrl":"ws://localhost/devtools/browser/test"}"#;
            stream.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len(),
            ).as_bytes()).await.unwrap();
        });
        assert_eq!(
            browser_websocket_url(port).await.unwrap(),
            "ws://localhost/devtools/browser/test"
        );
        server.await.unwrap();
    }
}
