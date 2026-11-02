//! 跟随系统代理变化的长期 HTTP 客户端。
//!
//! reqwest 只在构建客户端时读取一次系统代理，运行期间开关代理软件后旧客户端
//! 仍按旧设置连接。全进程共用一份系统代理快照，每 10 秒最多读取一次；各客户端
//! 只和这份快照比较，请求地址的代理判定变化时，在下次使用时按自己的参数重建
//! 一次。新客户端仍由 reqwest 自行读取系统代理及其认证信息。
//!
//! 客户端各自保留连接参数（重定向策略、超时、HTTP/2 调优），不能合并成一个。

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use hyper_util::client::proxy::matcher::Matcher as SystemProxyMatcher;
use tokio_tungstenite::tungstenite::http::Uri;

/// 系统代理的复查间隔，只在间隔到期后的首个请求上读取。
const SYSTEM_PROXY_RECHECK_INTERVAL: Duration = Duration::from_secs(10);

static SYSTEM: SystemProxySource = SystemProxySource::new(
    SystemProxyMatcher::from_system,
    SYSTEM_PROXY_RECHECK_INTERVAL,
);

/// 系统代理快照的来源；生产环境全进程只有 [`SYSTEM`] 一份。
struct SystemProxySource {
    read: fn() -> SystemProxyMatcher,
    interval: Duration,
    state: Mutex<SourceState>,
}

struct SourceState {
    latest: Option<Arc<SystemProxyMatcher>>,
    next_read: Option<Instant>,
    #[cfg(test)]
    reads: usize,
}

impl SystemProxySource {
    const fn new(read: fn() -> SystemProxyMatcher, interval: Duration) -> Self {
        Self {
            read,
            interval,
            state: Mutex::new(SourceState {
                latest: None,
                next_read: None,
                #[cfg(test)]
                reads: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SourceState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 同步取快照：只供阻塞线程使用，锁保证构建和刷新共用读取间隔。
    fn latest_blocking(&self) -> Arc<SystemProxyMatcher> {
        let mut state = self.lock();
        if let (Some(latest), Some(next_read)) = (&state.latest, state.next_read)
            && Instant::now() < next_read
        {
            return Arc::clone(latest);
        }
        let latest = Arc::new((self.read)());
        state.latest = Some(Arc::clone(&latest));
        state.next_read = Some(Instant::now() + self.interval);
        #[cfg(test)]
        {
            state.reads += 1;
        }
        latest
    }

    async fn latest(&'static self) -> Arc<SystemProxyMatcher> {
        {
            let state = self.lock();
            if let (Some(latest), Some(next_read)) = (&state.latest, state.next_read)
                && Instant::now() < next_read
            {
                return Arc::clone(latest);
            }
        }
        tokio::task::spawn_blocking(move || self.latest_blocking())
            .await
            .expect("系统代理快照任务异常退出")
    }
}

/// 跟随系统代理变化的长期 HTTP 客户端，见模块说明。
pub(crate) struct SystemProxyClient {
    source: &'static SystemProxySource,
    builder: fn() -> reqwest::ClientBuilder,
    state: Mutex<ClientState>,
    rebuild: tokio::sync::Mutex<()>,
}

struct ClientState {
    client: reqwest::Client,
    /// 当前客户端构建时的系统代理快照；只在重建时更新，保证每次都和客户端
    /// 实际使用的设置比较。
    built_with: Arc<SystemProxyMatcher>,
    #[cfg(test)]
    rebuilds: usize,
}

impl SystemProxyClient {
    /// 同步构建：会加载系统证书与代理配置，调用方需在可阻塞的线程上执行。
    pub(crate) fn new_blocking(builder: fn() -> reqwest::ClientBuilder) -> Result<Self> {
        Self::with_source(&SYSTEM, builder)
    }

    fn with_source(
        source: &'static SystemProxySource,
        builder: fn() -> reqwest::ClientBuilder,
    ) -> Result<Self> {
        let built_with = source.latest_blocking();
        let client = builder().build().context("创建 HTTP 客户端失败")?;
        Ok(Self {
            source,
            builder,
            rebuild: tokio::sync::Mutex::new(()),
            state: Mutex::new(ClientState {
                client,
                built_with,
                #[cfg(test)]
                rebuilds: 0,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, ClientState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 返回访问 `url` 应使用的客户端；目标地址的代理判定变化时先重建。
    pub(crate) async fn current(&self, url: &str) -> reqwest::Client {
        let Ok(uri) = url.parse::<Uri>() else {
            return self.lock().client.clone();
        };
        // 串行检查与重建，避免并发请求重复构建或写回较旧的快照。
        let _rebuild = self.rebuild.lock().await;
        let latest = self.source.latest().await;
        {
            let state = self.lock();
            if Arc::ptr_eq(&state.built_with, &latest)
                || same_system_proxy(&state.built_with, &latest, &uri)
            {
                return state.client.clone();
            }
        }
        let builder = self.builder;
        let rebuilt = match tokio::task::spawn_blocking(move || builder().build()).await {
            Ok(Ok(client)) => client,
            _ => {
                eprintln!("系统代理变化后重建 HTTP 客户端失败，将在下次使用时重试");
                return self.lock().client.clone();
            }
        };
        let mut state = self.lock();
        state.client = rebuilt.clone();
        state.built_with = latest;
        #[cfg(test)]
        {
            state.rebuilds += 1;
        }
        rebuilt
    }
}

fn same_system_proxy(left: &SystemProxyMatcher, right: &SystemProxyMatcher, uri: &Uri) -> bool {
    match (left.intercept(uri), right.intercept(uri)) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.uri() == right.uri()
                && left.basic_auth() == right.basic_auth()
                && left.raw_auth() == right.raw_auth()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, Ordering};

    fn test_builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder().no_proxy()
    }

    fn matcher_for(state: &AtomicU8) -> SystemProxyMatcher {
        match state.load(Ordering::SeqCst) {
            0 => SystemProxyMatcher::builder().build(),
            1 => SystemProxyMatcher::builder()
                .https("http://127.0.0.1:7890")
                .build(),
            _ => SystemProxyMatcher::builder()
                .https("http://user:secret@127.0.0.1:7890")
                .build(),
        }
    }

    fn rebuilds(client: &SystemProxyClient) -> usize {
        client.lock().rebuilds
    }

    fn expire(source: &SystemProxySource) {
        source.lock().next_read = Some(Instant::now());
    }

    const URL: &str = "https://api.example.com/v1/responses";

    // 每个测试独占一份假系统代理与快照来源，并行运行互不影响。
    static CHANGES: AtomicU8 = AtomicU8::new(0);
    static CHANGES_SOURCE: SystemProxySource =
        SystemProxySource::new(|| matcher_for(&CHANGES), Duration::ZERO);

    #[tokio::test]
    async fn rebuilds_only_when_the_request_target_proxy_changes() {
        let client = SystemProxyClient::with_source(&CHANGES_SOURCE, test_builder).unwrap();

        client.current(URL).await;
        assert_eq!(rebuilds(&client), 0, "代理不变时复用连接池客户端");

        CHANGES.store(1, Ordering::SeqCst);
        client.current("http://api.example.com/v1/responses").await;
        assert_eq!(rebuilds(&client), 0, "仅 HTTPS 代理变化不影响 HTTP 目标");
        tokio::join!(client.current(URL), client.current(URL));
        assert_eq!(rebuilds(&client), 1, "启用代理后重建客户端");
        client.current(URL).await;
        assert_eq!(rebuilds(&client), 1);

        CHANGES.store(2, Ordering::SeqCst);
        client.current(URL).await;
        assert_eq!(rebuilds(&client), 2, "代理凭据变化后重建客户端");

        CHANGES.store(0, Ordering::SeqCst);
        client.current(URL).await;
        assert_eq!(rebuilds(&client), 3, "关闭代理后重建客户端");
    }

    static SHARED: AtomicU8 = AtomicU8::new(0);
    static SHARED_SOURCE: SystemProxySource =
        SystemProxySource::new(|| matcher_for(&SHARED), Duration::from_secs(3600));

    #[tokio::test]
    async fn clients_share_one_snapshot_read_per_interval() {
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let create = |barrier: Arc<std::sync::Barrier>| {
            tokio::task::spawn_blocking(move || {
                barrier.wait();
                SystemProxyClient::with_source(&SHARED_SOURCE, test_builder).unwrap()
            })
        };
        let (first, second) = tokio::join!(create(Arc::clone(&barrier)), create(barrier));
        let (first, second) = (first.unwrap(), second.unwrap());
        assert_eq!(SHARED_SOURCE.lock().reads, 1, "构建客户端复用有效快照");

        SHARED.store(1, Ordering::SeqCst);
        first.current(URL).await;
        second.current(URL).await;
        assert_eq!(
            rebuilds(&first) + rebuilds(&second),
            0,
            "变化等待下一次读取"
        );

        expire(&SHARED_SOURCE);
        tokio::join!(first.current(URL), second.current(URL));
        first.current(URL).await;
        assert_eq!(SHARED_SOURCE.lock().reads, 2, "两个客户端复用同一次读取");
        assert_eq!(
            (rebuilds(&first), rebuilds(&second)),
            (1, 1),
            "每个客户端只重建一次"
        );
    }
}
