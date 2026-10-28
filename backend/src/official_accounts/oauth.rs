use super::Account;
use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const OAUTH_CALLBACK_PORT: u16 = 1455;
const OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE: &str = "openid profile email offline_access";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;

#[async_trait::async_trait]
pub(crate) trait TokenExchange: Send + Sync {
    async fn exchange(&self, grant: Value) -> Result<Value>;
}

#[async_trait::async_trait]
impl TokenExchange for reqwest::Client {
    async fn exchange(&self, grant: Value) -> Result<Value> {
        let response = self
            .post(OAUTH_TOKEN_URL)
            .timeout(Duration::from_secs(20))
            .form(&grant)
            .send()
            .await
            .map_err(|_| anyhow!("官方登录令牌请求失败"))?;
        let status = response.status();
        ensure!(status.is_success(), "官方登录令牌接口返回 {status}");
        let body = crate::http_response::read_bounded_body(response, 256 * 1024, "官方登录响应")
            .await
            .map_err(|_| anyhow!("读取官方登录响应失败"))?;
        serde_json::from_slice(&body).map_err(|_| anyhow!("官方登录响应格式无效"))
    }
}

impl Drop for LoginSession {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
pub enum LoginPhase {
    Waiting,
    Exchanging,
    Completed(Box<Account>),
    Failed(String),
}

pub struct LoginSession {
    pub auth_url: String,
    pub callback_listening: bool,
    pub callback_error: Option<String>,
    created_at: Instant,
    callback: Arc<LoginCallback>,
    task: Option<tokio::task::JoinHandle<()>>,
}

struct LoginCallback {
    phase: Mutex<LoginPhase>,
    state: String,
    verifier: String,
    client: Arc<dyn TokenExchange>,
}

impl LoginSession {
    pub fn phase(&self) -> LoginPhase {
        self.callback
            .phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn expired(&self) -> bool {
        self.created_at.elapsed() > LOGIN_TIMEOUT
    }

    pub fn cancel(&self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }

    pub async fn submit_callback(&self, input: &str) -> Result<Account> {
        ensure!(!self.expired(), "登录已过期或已取消，请重新添加账号");
        let input = input.trim();
        let params = if input.starts_with("http://") || input.starts_with("https://") {
            let url = reqwest::Url::parse(input).map_err(|_| anyhow!("登录回调地址无效"))?;
            query_params(url.query().unwrap_or_default())
        } else {
            query_params(input.trim_start_matches('?'))
        };
        let code = self.callback.claim(&params)?;
        self.cancel();
        self.callback.exchange(&code).await
    }
}

impl LoginCallback {
    fn claim(&self, params: &HashMap<String, String>) -> Result<String> {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            matches!(*phase, LoginPhase::Waiting),
            "登录回调已处理或正在处理"
        );
        ensure!(
            params.get("state") == Some(&self.state),
            "登录状态校验失败，请重新开始登录"
        );
        if params.contains_key("error") {
            bail!(
                "官方登录授权失败：{}",
                params
                    .get("error_description")
                    .or_else(|| params.get("error"))
                    .map(String::as_str)
                    .unwrap_or("授权被拒绝")
            );
        }
        let code = params
            .get("code")
            .filter(|code| !code.is_empty())
            .context("登录回调缺少授权码")?
            .clone();
        *phase = LoginPhase::Exchanging;
        Ok(code)
    }

    async fn exchange(&self, code: &str) -> Result<Account> {
        let result = exchange_code(self.client.as_ref(), code, &self.verifier).await;
        *self
            .phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = match &result {
            Ok(account) => LoginPhase::Completed(Box::new(account.clone())),
            Err(error) => LoginPhase::Failed(error.to_string()),
        };
        result
    }
}

#[derive(Default)]
pub struct LoginSessions {
    sessions: HashMap<String, LoginSession>,
}

impl LoginSessions {
    pub fn insert(&mut self, id: String, session: LoginSession) {
        self.sessions.insert(id, session);
    }

    pub fn get(&self, id: &str) -> Option<&LoginSession> {
        self.sessions.get(id)
    }

    pub fn remove(&mut self, id: &str) -> Option<LoginSession> {
        self.sessions.remove(id)
    }

    pub async fn cancel_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            session.cancel();
            if let Some(task) = session.task.take() {
                let _ = task.await;
            }
        }
    }

    pub fn remove_expired(&mut self) {
        let expired = self
            .sessions
            .iter()
            .filter(|(_, session)| session.expired())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(session) = self.sessions.remove(&id) {
                session.cancel();
            }
        }
    }
}

struct PkcePair {
    verifier: String,
    challenge: String,
}

fn pkce_pair() -> PkcePair {
    let mut seed = Vec::with_capacity(48);
    for _ in 0..3 {
        seed.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    let verifier = URL_SAFE_NO_PAD.encode(&seed);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair {
        verifier,
        challenge,
    }
}

fn build_authorize_url(state: &str, challenge: &str) -> String {
    let mut url = reqwest::Url::parse(OAUTH_AUTHORIZE_URL).expect("static authorize url");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", OAUTH_REDIRECT_URI)
        .append_pair("scope", OAUTH_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", "codex_cli_rs");
    url.to_string()
}

async fn bind_callback_listener(port: u16) -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            anyhow!("登录回调端口 127.0.0.1:{port} 已被占用，当前登录流程使用固定回调地址；请释放该端口后重试，或导入 Codex 现有登录。端口也可能被 WSL 或 Docker 进程占用，例如 WSL 镜像网络下发布 1455 端口的容器，Windows netstat 可能不会列出它")
        } else {
            anyhow!("无法监听登录回调端口 127.0.0.1:{port}（{error}）")
        }
    })
}

pub async fn start_login(client: reqwest::Client) -> Result<LoginSession> {
    start_login_on_port(Arc::new(client), OAUTH_CALLBACK_PORT).await
}

pub(crate) async fn start_login_on_port(
    client: Arc<dyn TokenExchange>,
    port: u16,
) -> Result<LoginSession> {
    let listener = bind_callback_listener(port).await;
    Ok(start_login_with_listener(client, listener))
}

pub(crate) fn start_login_with_listener(
    client: Arc<dyn TokenExchange>,
    listener: Result<TcpListener>,
) -> LoginSession {
    let callback_error = listener.as_ref().err().map(ToString::to_string);
    let pkce = pkce_pair();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let auth_url = build_authorize_url(&state, &pkce.challenge);
    let callback = Arc::new(LoginCallback {
        phase: Mutex::new(LoginPhase::Waiting),
        state,
        verifier: pkce.verifier,
        client,
    });
    let task_callback = Arc::clone(&callback);
    let task = listener.ok().map(|listener| {
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(
                LOGIN_TIMEOUT,
                run_callback_server(listener, Arc::clone(&task_callback)),
            )
            .await;
            let next = match outcome {
                Ok(Ok(())) => return,
                Ok(Err(error)) => LoginPhase::Failed(format!("{error:#}")),
                Err(_) => LoginPhase::Failed("登录等待超时，请重新开始添加账号".to_string()),
            };
            let mut phase = task_callback
                .phase
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(*phase, LoginPhase::Waiting | LoginPhase::Exchanging) {
                *phase = next;
            }
        })
    });
    LoginSession {
        auth_url,
        callback_listening: task.is_some(),
        callback_error,
        created_at: Instant::now(),
        callback,
        task,
    }
}

async fn run_callback_server(listener: TcpListener, callback: Arc<LoginCallback>) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await.context("接受登录回调连接失败")?;
        let request = match read_request_head(&mut socket).await {
            Ok(request) => request,
            Err(_) => continue,
        };
        let Some(target) = request_target(&request) else {
            let _ = write_response(&mut socket, 400, "Bad Request").await;
            continue;
        };
        let Some(query) = target.strip_prefix("/auth/callback?") else {
            let _ = write_response(&mut socket, 404, "Not Found").await;
            continue;
        };
        let params = query_params(query.trim_start_matches('?'));
        let code = match callback.claim(&params) {
            Ok(code) => code,
            Err(error) => {
                let _ = write_response(
                    &mut socket,
                    400,
                    "登录回调无效或已处理，请回到 Codey 查看。",
                )
                .await;
                if params.contains_key("error") && params.get("state") == Some(&callback.state) {
                    return Err(error);
                }
                continue;
            }
        };
        let exchanged = callback.exchange(&code).await;
        match exchanged {
            Ok(_) => {
                let _ = write_response(
                    &mut socket,
                    200,
                    "登录成功，账号已添加到 Codey，可关闭此页面。",
                )
                .await;
                return Ok(());
            }
            Err(error) => {
                let _ =
                    write_response(&mut socket, 500, "换取令牌失败，请回到 Codey 查看错误。").await;
                return Err(error);
            }
        }
    }
}

async fn read_request_head(socket: &mut tokio::net::TcpStream) -> Result<String> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut chunk))
            .await
            .context("读取登录回调请求超时")??;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        ensure!(
            buffer.len() <= MAX_CALLBACK_REQUEST_BYTES,
            "登录回调请求过大"
        );
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn request_target(request: &str) -> Option<&str> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if method != "GET" {
        return None;
    }
    parts.next()
}

fn query_params(query: &str) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .map(|url| {
            url.query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

async fn write_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    message: &str,
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Codey</title></head>\
         <body style=\"font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#222\">\
         <p style=\"font-size:18px\">{}</p></body></html>",
        html_escape(message)
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await?;
    let _ = socket.shutdown().await;
    Ok(())
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

async fn exchange_code(client: &dyn TokenExchange, code: &str, verifier: &str) -> Result<Account> {
    let payload = client
        .exchange(json!({"grant_type":"authorization_code", "code":code,
        "redirect_uri":OAUTH_REDIRECT_URI,"client_id":OAUTH_CLIENT_ID,"code_verifier":verifier}))
        .await?;
    account_from_response(payload)
}

fn account_from_response(payload: Value) -> Result<Account> {
    let mut auth = json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null, "tokens":payload,
        "last_refresh":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
    complete_identity(&mut auth);
    Account::from_auth(auth)
}

pub(super) fn complete_identity(auth: &mut Value) {
    if auth["tokens"]["account_id"]
        .as_str()
        .is_none_or(|id| id.trim().is_empty())
    {
        let id = ["id_token", "access_token"].iter().find_map(|key| {
            crate::account_usage::account_id_from_jwt(auth["tokens"][key].as_str()?)
        });
        if let Some(id) = id {
            auth["tokens"]["account_id"] = json!(id);
        }
    }
}

pub(crate) async fn import_credential(client: &reqwest::Client, input: &str) -> Result<Account> {
    import_with(client, input).await
}

async fn import_with(client: &dyn TokenExchange, input: &str) -> Result<Account> {
    ensure!(input.len() <= 64 * 1024, "官方账号凭据输入过长");
    let input = input.trim().trim_start_matches('\u{feff}');
    let input = input
        .strip_prefix("```json")
        .or_else(|| input.strip_prefix("```"))
        .unwrap_or(input)
        .trim()
        .trim_end_matches("```")
        .trim();
    ensure!(!input.is_empty(), "请粘贴刷新令牌或 OAuth JSON");
    let value = if input.starts_with(['{', '[', '"']) {
        serde_json::from_str::<Value>(input).map_err(|_| anyhow!("OAuth JSON 格式无效"))?
    } else {
        json!(input)
    };
    let token = match value {
        Value::String(token) => token,
        Value::Object(_) => {
            let source = value.get("auth").unwrap_or(&value);
            let tokens = source.get("tokens").unwrap_or(source);
            let field = |names: &[&str]| {
                names
                    .iter()
                    .find_map(|key| tokens[*key].as_str())
                    .map(str::to_owned)
            };
            if let Some(access) = field(&["access_token", "accessToken"]) {
                let mut auth = if source.get("tokens").is_some() {
                    source.clone()
                } else {
                    json!({"auth_mode":"chatgpt", "OPENAI_API_KEY":null, "tokens":{}})
                };
                if auth.get("auth_mode").is_none() {
                    auth["auth_mode"] = json!("chatgpt");
                }
                auth["tokens"]["access_token"] = json!(access);
                for (name, aliases) in [
                    ("refresh_token", ["refresh_token", "refreshToken"]),
                    ("id_token", ["id_token", "idToken"]),
                    ("account_id", ["account_id", "accountId"]),
                ] {
                    if let Some(token) = field(&aliases) {
                        auth["tokens"][name] = json!(token);
                    }
                }
                complete_identity(&mut auth);
                let mut account = Account::from_auth(auth)?;
                account.email = source["email"]
                    .as_str()
                    .or_else(|| value["email"].as_str())
                    .map(str::to_owned);
                account.plan_type = source["plan_type"]
                    .as_str()
                    .or_else(|| source["planType"].as_str())
                    .map(str::to_owned);
                return Ok(account);
            }
            field(&["refresh_token", "refreshToken", "rt"])
                .context("OAuth JSON 缺少访问令牌或刷新令牌")?
        }
        _ => bail!("OAuth JSON 必须是对象"),
    };
    let token = token.trim().strip_prefix("Bearer ").unwrap_or(token.trim());
    ensure!(
        token.len() >= 20
            && !token.chars().any(char::is_whitespace)
            && !token.starts_with("sk-")
            && token.split('.').count() != 3,
        "刷新令牌格式无效"
    );
    let mut payload = client
        .exchange(json!({"grant_type":"refresh_token", "refresh_token":token,
        "client_id":OAUTH_CLIENT_ID}))
        .await?;
    if payload["refresh_token"].as_str().is_none_or(str::is_empty) {
        payload["refresh_token"] = json!(token);
    }
    account_from_response(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeExchange;
    #[async_trait::async_trait]
    impl TokenExchange for FakeExchange {
        async fn exchange(&self, grant: Value) -> Result<Value> {
            assert_eq!(grant["client_id"], OAUTH_CLIENT_ID);
            Ok(json!({"access_token":"fake-access", "account_id":"fake-account"}))
        }
    }
    #[tokio::test]
    async fn official_accounts_imports_refresh_token_and_complete_oauth_without_network() {
        let account = import_with(&FakeExchange, "refresh-token-at-least-twenty")
            .await
            .unwrap();
        assert_eq!(
            account.auth["tokens"]["refresh_token"],
            "refresh-token-at-least-twenty"
        );
        assert_eq!(account.auth["auth_mode"], "chatgpt");
        let input = json!({"tokens":{"access_token":"a","account_id":"b"},"custom":"preserved"});
        let account = import_with(&FakeExchange, &input.to_string())
            .await
            .unwrap();
        assert_eq!(account.auth["custom"], "preserved");
        for bad in [
            "",
            "{}",
            "[]",
            "sk-api-key-not-refresh-token",
            "你好你好你好",
        ] {
            assert!(import_with(&FakeExchange, bad).await.is_err());
        }
    }
    #[test]
    fn official_accounts_pkce_uses_upstream_client_and_callback() {
        let pair = pkce_pair();
        assert_eq!(
            pair.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(pair.verifier.as_bytes()))
        );
        let url = build_authorize_url("state", &pair.challenge);
        let url = reqwest::Url::parse(&url).unwrap();
        let params: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["client_id"], OAUTH_CLIENT_ID);
        assert_eq!(params["redirect_uri"], OAUTH_REDIRECT_URI);
        assert_eq!(params["state"], "state");
    }
    #[tokio::test]
    async fn official_accounts_busy_callback_port_has_reason() {
        let listener = bind_callback_listener(0).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let error = bind_callback_listener(port).await.unwrap_err().to_string();
        assert!(error.contains("已被占用"));
        assert!(error.contains("WSL") && error.contains("Docker") && error.contains("netstat"));
        let mut session = start_login_on_port(Arc::new(FakeExchange), port)
            .await
            .unwrap();
        assert!(!session.callback_listening);
        assert_eq!(session.callback_error.as_deref(), Some(error.as_str()));
        assert!(matches!(session.phase(), LoginPhase::Waiting));
        assert!(session.task.is_none());
        session.created_at = Instant::now() - LOGIN_TIMEOUT - Duration::from_secs(1);
        assert!(
            session
                .submit_callback("code=fake&state=wrong")
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("已过期")
        );
    }

    #[tokio::test]
    async fn official_account_oauth_paste_stops_listener_and_rejects_second_claim() {
        let listener = bind_callback_listener(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        let session = start_login_with_listener(Arc::new(FakeExchange), Ok(listener));
        assert!(session.callback_listening);
        assert!(session.callback_error.is_none());
        let query = format!("code=fake&state={}", session.callback.state);
        session.submit_callback(&query).await.unwrap();
        assert!(session.submit_callback(&query).await.is_err());
        assert!(session.callback.claim(&query_params(&query)).is_err());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !session.task.as_ref().unwrap().is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        assert!(matches!(session.phase(), LoginPhase::Completed(_)));
    }
}
