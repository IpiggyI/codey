//! 本机 Codex 内置的模型目录。
//!
//! Codey 随附的目录停在上次同步上游时，新版 Codex 自带的模型（如新一代 Sol、Astra）
//! 不在其中。`codex debug models --bundled` 输出当前安装的 Codex 内置目录，
//! 不联网；直接打开 Codex 且没有服务端缓存时，模型选择器显示的就是这份目录。

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::runtime_source::RuntimeCatalogSource;
use super::*;

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;
/// Codex 运行时会在 `CODEX_HOME` 下建临时目录；用 Codey 自己的目录，不碰用户的 Codex 数据。
const SCRATCH_HOME_DIR_NAME: &str = "installed-catalog-home";

pub(super) struct InstalledCatalog {
    pub(super) models: Vec<Value>,
    /// `codex --version` 去掉预发布后缀，例如 `0.171.0`。
    pub(super) client_version: Option<String>,
}

type InstalledCatalogCache = Mutex<Option<(RuntimeCatalogSource, Option<Arc<InstalledCatalog>>)>>;
static CACHE: OnceLock<InstalledCatalogCache> = OnceLock::new();

/// 读取本机 Codex 的内置目录。结果按运行程序的路径、大小和修改时间缓存，
/// 失败同样缓存并只记录一次，调用方退回随附目录。
pub(super) fn installed_catalog(
    source: &RuntimeCatalogSource,
    catalog_dir: &Path,
) -> Option<Arc<InstalledCatalog>> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock()
        && let Some((cached_source, catalog)) = guard.as_ref()
        && cached_source == source
    {
        return catalog.clone();
    }
    let catalog = match load(source.path(), &catalog_dir.join(SCRATCH_HOME_DIR_NAME)) {
        Ok(catalog) => Some(Arc::new(catalog)),
        Err(error) => {
            let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                "model_catalog.installed_catalog_unavailable",
                json!({ "executable": source.path(), "error": format!("{error:#}") }),
            );
            None
        }
    };
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((source.clone(), catalog.clone()));
    }
    catalog
}

#[cfg(not(test))]
fn load(executable: &Path, scratch_home: &Path) -> Result<InstalledCatalog> {
    fs::create_dir_all(scratch_home)
        .with_context(|| format!("创建临时 Codex 目录失败：{}", scratch_home.display()))?;
    let catalog = run(executable, scratch_home, &["debug", "models", "--bundled"])?;
    let version = run(executable, scratch_home, &["--version"])
        .map_err(|error| eprintln!("读取 Codex 版本失败：{error:#}"))
        .ok();
    parse(&catalog, version.as_deref())
}

#[cfg(test)]
fn load(_executable: &Path, _scratch_home: &Path) -> Result<InstalledCatalog> {
    tests::load_override()
}

#[cfg_attr(test, allow(dead_code))]
fn run(executable: &Path, scratch_home: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .env("CODEX_HOME", scratch_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(codey_runtime_core::windows_create_no_window());
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("无法运行 {}", executable.display()))?;
    let stdout = child.stdout.take().context("无法读取 Codex 输出")?;
    // 目录输出约 1 MB，必须边运行边读，否则管道写满后子进程会停住。
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("等待 Codex 退出失败")? {
            break status;
        }
        if started.elapsed() >= RUN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "codex {} 超过 {} 秒未结束",
                args.join(" "),
                RUN_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("读取 Codex 输出的线程异常退出"))?
        .context("读取 Codex 输出失败")?;
    if !status.success() {
        bail!("codex {} 退出状态 {status}", args.join(" "));
    }
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        bail!(
            "codex {} 输出超过 {} 字节",
            args.join(" "),
            MAX_OUTPUT_BYTES
        );
    }
    Ok(bytes)
}

fn parse(catalog: &[u8], version: Option<&[u8]>) -> Result<InstalledCatalog> {
    let mut value: Value =
        serde_json::from_slice(catalog).context("Codex 内置模型目录不是有效 JSON")?;
    codey_runtime_core::model_suffix::remove_model_prompt_fields(&mut value);
    let models = official_models_from_value(&value);
    if models.is_empty() {
        bail!("Codex 内置模型目录没有模型");
    }
    Ok(InstalledCatalog {
        models,
        client_version: version.and_then(parse_version),
    })
}

/// `codex-cli 0.171.0-alpha.13` 记为 `0.171.0`，与 `models_cache.json` 的 `client_version` 同一口径。
fn parse_version(output: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(output).ok()?;
    let version = text.split_whitespace().last()?;
    let release = version.split(['-', '+']).next()?;
    (!release.is_empty() && release.chars().all(|ch| ch.is_ascii_digit() || ch == '.'))
        .then(|| release.to_string())
}

/// 服务端缓存来自同一版本 Codex 时以缓存为准，否则以本机内置目录为准；
/// 另一方多出的模型按它自己的顺序补在后面。
pub(super) fn merge_official_order(
    cache_order: &[String],
    cache_client_version: Option<&str>,
    installed: &InstalledCatalog,
) -> Vec<String> {
    let installed_order = crate::model_order::official_order(&installed.models);
    let cache_is_current = cache_client_version.is_some()
        && cache_client_version.map(str::trim) == installed.client_version.as_deref();
    let (primary, secondary) = if cache_is_current || installed_order.is_empty() {
        (cache_order, installed_order.as_slice())
    } else {
        (installed_order.as_slice(), cache_order)
    };
    model_id::dedupe_preserving_first(primary.iter().chain(secondary.iter()).map(String::as_str))
}

#[cfg(test)]
pub(super) mod tests {
    use std::cell::RefCell;

    use super::*;

    /// 模拟的 `debug models --bundled` 与 `--version` 输出。
    type CommandOutput = (Vec<u8>, Option<Vec<u8>>);

    thread_local! {
        static OVERRIDE: RefCell<Option<CommandOutput>> = const { RefCell::new(None) };
    }

    /// 测试默认没有本机 Codex；设置后由 `load` 解析给定的输出。
    pub(crate) fn set_installed_catalog_output(catalog: Option<CommandOutput>) {
        OVERRIDE.with(|cell| *cell.borrow_mut() = catalog);
    }

    pub(super) fn load_override() -> Result<InstalledCatalog> {
        OVERRIDE.with(|cell| match cell.borrow().as_ref() {
            Some((catalog, version)) => parse(catalog, version.as_deref()),
            None => bail!("测试未提供本机 Codex 内置目录"),
        })
    }

    fn installed(order: &[&str], version: Option<&str>) -> InstalledCatalog {
        InstalledCatalog {
            models: order
                .iter()
                .enumerate()
                .map(|(index, slug)| json!({ "slug": slug, "visibility": "list", "priority": index + 1 }))
                .collect(),
            client_version: version.map(str::to_string),
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_removes_prompt_fields_and_reads_release_version() {
        let output = br#"{"models":[
            {"slug":"gpt-6.2-sol","visibility":"list","priority":1,"base_instructions":"secret",
             "model_messages":{"instructions_template":"secret"}},
            {"slug":"codex-auto-review","visibility":"hide","priority":20}
        ]}"#;
        let catalog = parse(output, Some(b"codex-cli 0.171.0-alpha.13\r\n")).unwrap();
        assert_eq!(catalog.client_version.as_deref(), Some("0.171.0"));
        assert_eq!(catalog.models.len(), 2);
        let text = serde_json::to_string(&catalog.models).unwrap();
        assert!(!text.contains("secret"), "{text}");
        assert_eq!(
            crate::model_order::official_order(&catalog.models),
            ["gpt-6.2-sol"]
        );
    }

    #[test]
    fn parse_rejects_empty_or_invalid_output() {
        assert!(parse(br#"{"models":[]}"#, None).is_err());
        assert!(parse(b"WARNING: not json", None).is_err());
        assert_eq!(parse_version(b"garbage"), None);
    }

    #[test]
    fn stale_cache_from_older_codex_follows_installed_order() {
        let cache = strings(&["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-5.5"]);
        let installed = installed(
            &[
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6.1-terra",
                "gpt-6.1-sol",
                "gpt-6-astra",
            ],
            Some("0.171.0"),
        );
        assert_eq!(
            merge_official_order(&cache, Some("0.170.0"), &installed),
            [
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6.1-terra",
                "gpt-6.1-sol",
                "gpt-6-astra",
                "gpt-5.5"
            ]
        );
        assert_eq!(
            merge_official_order(&cache, None, &installed)[..2],
            strings(&["gpt-6.2-sol", "gpt-6.2-astra"])
        );
    }

    #[test]
    fn cache_from_the_same_codex_keeps_server_order() {
        let cache = strings(&["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra"]);
        let installed = installed(
            &[
                "gpt-6.2-sol",
                "gpt-6.2-astra",
                "gpt-6.1-terra",
                "gpt-6.1-sol",
            ],
            Some("0.171.0"),
        );
        assert_eq!(
            merge_official_order(&cache, Some("0.171.0"), &installed),
            [
                "gpt-6.2-sol",
                "gpt-6.1-sol",
                "gpt-6.1-terra",
                "gpt-6.2-astra"
            ]
        );
    }
}
