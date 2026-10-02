//! Reads the Electron fuse wire embedded in the Codex desktop binary.
//!
//! Electron bakes a "fuse wire" into its binary: a sentinel string followed by
//! a version byte, a length byte and one byte per fuse (`0` disabled, `1`
//! enabled, `r` removed). `EnableNodeCliInspectArguments` and
//! `EnableNodeOptionsEnvironmentVariable` are independent: a build can drop
//! `--inspect-brk` while still honouring `NODE_OPTIONS=--require`. Reading the
//! wire before launch lets the launcher prefer `--require` when NODE_OPTIONS is
//! on, then Inspector, then the CLI wrapper, instead of waiting for a debug port
//! that will never answer.

#[cfg(any(windows, target_os = "macos", test))]
use std::io::Read;
#[cfg(any(windows, target_os = "macos", test))]
use std::path::{Path, PathBuf};
#[cfg(any(windows, target_os = "macos"))]
use std::time::Instant;

#[cfg(any(windows, target_os = "macos", test))]
use anyhow::Context;
use anyhow::Result;
#[cfg(any(windows, target_os = "macos", test))]
use serde::{Deserialize, Serialize};

/// Sentinel that precedes the fuse wire in every Electron binary (@electron/fuses).
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const FUSE_SENTINEL: &[u8] = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
#[cfg(any(windows, target_os = "macos", test))]
const FUSE_WIRE_VERSION_V1: u8 = 1;
/// Index of `EnableNodeOptionsEnvironmentVariable` in the v1 fuse wire (`FuseV1Options`).
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const NODE_OPTIONS_FUSE_INDEX: usize = 2;
/// Index of `EnableNodeCliInspectArguments` in the v1 fuse wire (`FuseV1Options`).
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) const NODE_CLI_INSPECT_FUSE_INDEX: usize = 3;
#[cfg(any(windows, target_os = "macos", test))]
const MAX_FUSE_COUNT: usize = 64;
#[cfg(any(windows, target_os = "macos", test))]
const SCAN_CHUNK_BYTES: usize = 8 * 1024 * 1024;
#[cfg(any(windows, target_os = "macos", test))]
const CACHE_FILE: &str = "electron-fuses.json";
#[cfg(any(windows, target_os = "macos", test))]
const MAX_CACHE_BYTES: u64 = 64 * 1024;

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FuseState {
    Enabled,
    Disabled,
    Removed,
    Unknown,
}

#[cfg(any(windows, target_os = "macos", test))]
impl FuseState {
    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FuseState::Enabled => "enabled",
            FuseState::Disabled => "disabled",
            FuseState::Removed => "removed",
            FuseState::Unknown => "unknown",
        }
    }

    /// Only use Inspector when the runtime explicitly enables it.
    pub(crate) fn inspector_possible(self) -> bool {
        self == FuseState::Enabled
    }

    /// An unreadable or unknown fuse is not permission to inject through it.
    pub(crate) fn node_options_possible(self) -> bool {
        self == FuseState::Enabled
    }
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ElectronFuses {
    pub(crate) node_cli_inspect: FuseState,
    pub(crate) node_options: FuseState,
}

#[cfg(any(windows, target_os = "macos", test))]
impl ElectronFuses {
    #[cfg(any(windows, target_os = "macos"))]
    fn unknown() -> Self {
        Self {
            node_cli_inspect: FuseState::Unknown,
            node_options: FuseState::Unknown,
        }
    }

    fn from_wire(wire: Option<&FuseWire>) -> Self {
        Self {
            node_cli_inspect: wire
                .map(|wire| wire.state(NODE_CLI_INSPECT_FUSE_INDEX))
                .unwrap_or(FuseState::Unknown),
            node_options: wire
                .map(|wire| wire.state(NODE_OPTIONS_FUSE_INDEX))
                .unwrap_or(FuseState::Unknown),
        }
    }
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FuseWire {
    pub(crate) version: u8,
    pub(crate) states: String,
}

#[cfg(any(windows, target_os = "macos", test))]
impl FuseWire {
    pub(crate) fn state(&self, index: usize) -> FuseState {
        if self.version != FUSE_WIRE_VERSION_V1 {
            return FuseState::Unknown;
        }
        match self.states.as_bytes().get(index) {
            Some(b'1') => FuseState::Enabled,
            Some(b'0') => FuseState::Disabled,
            Some(b'r') => FuseState::Removed,
            _ => FuseState::Unknown,
        }
    }
}

/// Parses the wire that follows a sentinel found at `sentinel_offset`.
/// Returns `None` when the buffer does not yet hold the complete wire.
#[cfg(any(windows, target_os = "macos", test))]
fn parse_fuse_wire(bytes: &[u8], sentinel_offset: usize) -> Option<Result<FuseWire>> {
    let header = sentinel_offset + FUSE_SENTINEL.len();
    let version = *bytes.get(header)?;
    let count = usize::from(*bytes.get(header + 1)?);
    if count == 0 || count > MAX_FUSE_COUNT {
        return Some(Err(anyhow::anyhow!("Electron fuse wire 长度无效：{count}")));
    }
    let states = bytes.get(header + 2..header + 2 + count)?;
    if !states.iter().all(|byte| matches!(byte, b'0' | b'1' | b'r')) {
        return Some(Err(anyhow::anyhow!("Electron fuse wire 包含未知状态字节")));
    }
    Some(Ok(FuseWire {
        version,
        states: String::from_utf8_lossy(states).into_owned(),
    }))
}

/// Streams through `path` looking for the fuse sentinel. `Ok(None)` means the
/// file holds no sentinel, so it is not an Electron binary with fuses.
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn read_fuse_wire(path: &Path) -> Result<Option<FuseWire>> {
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("读取 Electron 二进制失败：{}", path.display()))?;
    Ok(scan_fuse_wire(&mut file, false)?.map(|(_, wire)| wire))
}

#[cfg(any(windows, target_os = "macos", test))]
fn scan_fuse_wire(
    file: &mut std::fs::File,
    require_unique: bool,
) -> Result<Option<(u64, FuseWire)>> {
    let finder = memchr::memmem::Finder::new(FUSE_SENTINEL);
    // Enough trailing context that a sentinel at the end of one chunk is still
    // matched, and its wire completed, by the next read.
    let overlap = FUSE_SENTINEL.len() + 2 + MAX_FUSE_COUNT;
    let mut buffer: Vec<u8> = Vec::with_capacity(SCAN_CHUNK_BYTES + overlap);
    let mut chunk = vec![0_u8; SCAN_CHUNK_BYTES];
    let mut base = 0_u64;
    let mut found: Option<(u64, FuseWire)> = None;
    loop {
        let read = file.read(&mut chunk).context("读取 Electron 二进制失败")?;
        let end_of_file = read == 0;
        buffer.extend_from_slice(&chunk[..read]);
        for offset in finder.find_iter(&buffer) {
            let absolute = base + offset as u64;
            if found.as_ref().is_some_and(|(at, _)| *at == absolute) {
                continue;
            }
            match parse_fuse_wire(&buffer, offset) {
                Some(wire) => {
                    let wire = wire?;
                    // Preserve read-only detection of universal macOS binaries;
                    // only the Windows mutation path requires a unique wire.
                    if !require_unique {
                        return Ok(Some((absolute, wire)));
                    }
                    anyhow::ensure!(
                        found.is_none(),
                        "Electron 二进制包含多个 fuse wire，无法安全识别运行时"
                    );
                    found = Some((absolute, wire));
                }
                None if end_of_file => {
                    anyhow::bail!("Electron fuse wire 在文件末尾被截断");
                }
                None => break,
            }
        }
        if end_of_file {
            return Ok(found);
        }
        if buffer.len() > overlap {
            let keep_from = buffer.len() - overlap;
            buffer.drain(..keep_from);
            base += keep_from as u64;
        }
    }
}

/// Candidate runtime files in priority order: a split `chrome.dll` first, then
/// the main executable; a macOS bundle resolves to its Electron framework.
/// Split runtimes may keep the fuse wire in either file, so callers that need
/// the wire must use [`electron_runtime_with_wire`] instead of the first entry.
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn electron_binary_candidates(app_dir: &Path) -> Vec<PathBuf> {
    if app_dir
        .extension()
        .is_some_and(|extension| extension == "app")
    {
        let Some(frameworks) = std::fs::read_dir(app_dir.join("Contents").join("Frameworks")).ok()
        else {
            return Vec::new();
        };
        let mut frameworks = frameworks
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(" Framework.framework"))
            })
            .collect::<Vec<_>>();
        frameworks.sort();
        let mut candidates = Vec::new();
        for framework in frameworks {
            let Some(stem) = framework
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(ToString::to_string)
            else {
                continue;
            };
            let Ok(versions) = std::fs::read_dir(framework.join("Versions")) else {
                continue;
            };
            let mut version_dirs = versions
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name != "Current")
                })
                .collect::<Vec<_>>();
            version_dirs.sort();
            if let Some(binary) = version_dirs
                .into_iter()
                .map(|version| version.join(&stem))
                .find(|binary| binary.is_file())
            {
                candidates.push(binary);
            }
        }
        return candidates;
    }
    let mut candidates = Vec::new();
    let runtime = app_dir.join("chrome.dll");
    if runtime.is_file() {
        candidates.push(runtime);
    }
    let executable = codey_runtime_core::app_paths::build_codex_executable(app_dir);
    if executable.is_file() && candidates.iter().all(|candidate| candidate != &executable) {
        candidates.push(executable);
    }
    candidates
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Serialize, Deserialize)]
struct FuseCacheEntry {
    path: String,
    len: u64,
    modified_ms: Option<u64>,
    version: Option<u8>,
    states: Option<String>,
}

/// Bounded cache with one entry per candidate runtime. A split runtime probes
/// `chrome.dll` and then the main executable, so a single shared entry would let
/// the two candidates evict each other and force a full scan on every probe.
#[cfg(any(windows, target_os = "macos", test))]
const MAX_CACHE_ENTRIES: usize = 8;

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Default, Serialize, Deserialize)]
struct FuseCache {
    #[serde(default)]
    entries: Vec<FuseCacheEntry>,
}

#[cfg(any(windows, target_os = "macos", test))]
impl FuseCache {
    /// An unreadable cache is not an error: it only costs one rescan. Entries in
    /// the previous single-entry format are discarded the same way.
    fn read(cache: &Path) -> Self {
        crate::fs_util::read_bounded(cache, MAX_CACHE_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Only the size and modification time guard a hit, so a same-size in-place
    /// runtime update still invalidates its own entry once the timestamp moves.
    fn entry_for(&self, binary: &Path, signature: (u64, Option<u64>)) -> Option<&FuseCacheEntry> {
        let path = binary.to_string_lossy();
        self.entries.iter().find(|entry| {
            entry.path == path && entry.len == signature.0 && entry.modified_ms == signature.1
        })
    }

    fn insert(&mut self, entry: FuseCacheEntry) {
        self.entries.retain(|saved| saved.path != entry.path);
        if self.entries.len() >= MAX_CACHE_ENTRIES {
            self.entries.remove(0);
        }
        self.entries.push(entry);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn cache_path() -> PathBuf {
    codey_runtime_core::paths::default_app_state_dir().join(CACHE_FILE)
}

#[cfg(any(windows, target_os = "macos", test))]
fn binary_signature(path: &Path) -> Option<(u64, Option<u64>)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));
    Some((metadata.len(), modified_ms))
}

#[cfg(any(windows, target_os = "macos", test))]
fn load_cached_wire(
    cache: &Path,
    binary: &Path,
    signature: (u64, Option<u64>),
) -> Option<Option<FuseWire>> {
    let store = FuseCache::read(cache);
    let entry = store.entry_for(binary, signature)?;
    Some(match (entry.version, entry.states.clone()) {
        (Some(version), Some(states)) => Some(FuseWire { version, states }),
        _ => None,
    })
}

#[cfg(any(windows, target_os = "macos", test))]
fn store_cached_wire(
    cache: &Path,
    binary: &Path,
    signature: (u64, Option<u64>),
    wire: Option<&FuseWire>,
) -> Result<()> {
    let mut store = FuseCache::read(cache);
    store.insert(FuseCacheEntry {
        path: binary.to_string_lossy().into_owned(),
        len: signature.0,
        modified_ms: signature.1,
        version: wire.map(|wire| wire.version),
        states: wire.map(|wire| wire.states.clone()),
    });
    crate::fs_util::atomic_write_private_with_parent(cache, &serde_json::to_vec(&store)?)
}

/// Reads the wire for `binary`, reusing a cached result while the binary's
/// size and modification time are unchanged.
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn cached_fuse_wire(binary: &Path, cache: &Path) -> Result<(Option<FuseWire>, bool)> {
    let signature = binary_signature(binary)
        .with_context(|| format!("读取 Electron 二进制信息失败：{}", binary.display()))?;
    if let Some(wire) = load_cached_wire(cache, binary, signature) {
        return Ok((wire, true));
    }
    let wire = read_fuse_wire(binary)?;
    if let Err(error) = store_cached_wire(cache, binary, signature, wire.as_ref()) {
        crate::error_log::record_failure(
            "compatibility_fallback",
            "store_electron_fuse_cache",
            format!("{error:#}"),
            serde_json::json!({ "cache": cache }),
        );
    }
    Ok((wire, false))
}

/// Resolves the runtime together with its fuse wire. `cache` stores the parsed
/// wire between launches; repair helpers that only validate a target pass
/// `None` and read the wire directly. When no candidate carries a wire the
/// first candidate is returned so callers keep reporting a useful error.
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn electron_runtime_with_wire(
    app_dir: &Path,
    cache: Option<&Path>,
) -> Result<(PathBuf, Option<FuseWire>, bool)> {
    let candidates = electron_binary_candidates(app_dir);
    anyhow::ensure!(!candidates.is_empty(), "找不到 Codex 的 Electron 运行时");
    let mut without_wire = None;
    let mut failure = None;
    for candidate in candidates {
        let wire = match cache {
            Some(cache) => cached_fuse_wire(&candidate, cache),
            None => read_fuse_wire(&candidate).map(|wire| (wire, false)),
        };
        match wire {
            Ok((Some(wire), cached)) => return Ok((candidate, Some(wire), cached)),
            Ok((None, cached)) => {
                if without_wire.is_none() {
                    without_wire = Some((candidate, cached));
                }
            }
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error.context(format!(
                        "读取 Electron fuse wire 失败：{}",
                        candidate.display()
                    )));
                }
            }
        }
    }
    if let Some((candidate, cached)) = without_wire {
        return Ok((candidate, None, cached));
    }
    Err(failure.unwrap_or_else(|| anyhow::anyhow!("找不到 Codex 的 Electron 运行时")))
}

/// Resolves the Inspector and `NODE_OPTIONS` fuses for the Codex desktop app.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn read_electron_fuses(app_dir: &Path) -> ElectronFuses {
    let started = Instant::now();
    match electron_runtime_with_wire(app_dir, Some(&cache_path())) {
        Ok((binary, wire, cached)) => {
            let fuses = ElectronFuses::from_wire(wire.as_ref());
            let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                "launcher.electron_fuses",
                serde_json::json!({
                    "binary": binary,
                    "cached": cached,
                    "version": wire.as_ref().map(|wire| wire.version),
                    "states": wire.as_ref().map(|wire| wire.states.as_str()),
                    "nodeCliInspect": fuses.node_cli_inspect.as_str(),
                    "nodeOptions": fuses.node_options.as_str(),
                    "scanMs": started.elapsed().as_millis(),
                }),
            );
            fuses
        }
        Err(error) => {
            crate::error_log::record_failure(
                "compatibility_fallback",
                "read_electron_fuses",
                format!("{error:#}"),
                serde_json::json!({ "appPath": app_dir }),
            );
            let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                "launcher.electron_fuses",
                serde_json::json!({
                    "appPath": app_dir,
                    "nodeCliInspect": FuseState::Unknown.as_str(),
                    "nodeOptions": FuseState::Unknown.as_str(),
                    "error": format!("{error:#}"),
                    "scanMs": started.elapsed().as_millis(),
                }),
            );
            ElectronFuses::unknown()
        }
    }
}

/// Blocking-pool wrapper for [`read_electron_fuses`]; the first scan of a
/// new Codex build reads the whole executable.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) async fn detect_electron_fuses(app_dir: PathBuf) -> ElectronFuses {
    tokio::task::spawn_blocking(move || read_electron_fuses(&app_dir))
        .await
        .unwrap_or_else(|_| ElectronFuses::unknown())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The preferred runtime file: the main executable on Windows and Linux
    /// (including split chrome.dll runtimes), or the renamed Electron framework
    /// inside a macOS bundle.
    fn electron_binary_path(app_dir: &Path) -> Option<PathBuf> {
        electron_binary_candidates(app_dir).into_iter().next()
    }

    pub(super) fn wire_bytes(states: &str) -> Vec<u8> {
        let mut bytes = FUSE_SENTINEL.to_vec();
        bytes.push(FUSE_WIRE_VERSION_V1);
        bytes.push(states.len() as u8);
        bytes.extend_from_slice(states.as_bytes());
        bytes
    }

    #[test]
    fn fuse_wire_maps_each_state_byte() {
        let wire = FuseWire {
            version: 1,
            states: "010011001".to_string(),
        };
        assert_eq!(wire.state(0), FuseState::Disabled);
        assert_eq!(wire.state(1), FuseState::Enabled);
        assert_eq!(wire.state(NODE_OPTIONS_FUSE_INDEX), FuseState::Disabled);
        assert_eq!(wire.state(NODE_CLI_INSPECT_FUSE_INDEX), FuseState::Disabled);
        assert_eq!(wire.state(9), FuseState::Unknown);
        assert_eq!(
            FuseWire {
                version: 2,
                states: "1".to_string()
            }
            .state(0),
            FuseState::Unknown
        );
        assert!(FuseState::Enabled.inspector_possible());
        assert!(!FuseState::Unknown.inspector_possible());
        assert!(!FuseState::Disabled.inspector_possible());
        assert!(!FuseState::Removed.inspector_possible());
        assert!(FuseState::Enabled.node_options_possible());
        assert!(!FuseState::Unknown.node_options_possible());
        assert!(!FuseState::Disabled.node_options_possible());
        assert!(!FuseState::Removed.node_options_possible());
        let fuses = ElectronFuses::from_wire(Some(&wire));
        assert_eq!(fuses.node_cli_inspect, FuseState::Disabled);
        assert_eq!(fuses.node_options, FuseState::Disabled);
    }

    #[test]
    fn scanner_finds_the_wire_across_chunk_boundaries_and_reports_absence() {
        let temp = tempfile::tempdir().unwrap();
        // Straddle the chunk boundary so half of the sentinel sits in each read.
        let padding = SCAN_CHUNK_BYTES - FUSE_SENTINEL.len() / 2;
        let mut bytes = vec![b'x'; padding];
        bytes.extend(wire_bytes("0100110r1"));
        bytes.extend(std::iter::repeat_n(b'y', 4096));
        let binary = temp.path().join("straddle.bin");
        std::fs::write(&binary, &bytes).unwrap();
        assert_eq!(
            read_fuse_wire(&binary).unwrap(),
            Some(FuseWire {
                version: 1,
                states: "0100110r1".to_string()
            })
        );

        // A wire cut off by the end of one chunk must be completed by the next.
        let mut bytes = vec![b'x'; SCAN_CHUNK_BYTES - FUSE_SENTINEL.len() - 3];
        bytes.extend(wire_bytes("110011001"));
        let binary = temp.path().join("tail.bin");
        std::fs::write(&binary, &bytes).unwrap();
        assert_eq!(
            read_fuse_wire(&binary)
                .unwrap()
                .unwrap()
                .state(NODE_CLI_INSPECT_FUSE_INDEX),
            FuseState::Disabled
        );

        let plain = temp.path().join("plain.bin");
        std::fs::write(&plain, b"no electron here").unwrap();
        assert_eq!(read_fuse_wire(&plain).unwrap(), None);

        let truncated = temp.path().join("truncated.bin");
        std::fs::write(&truncated, &wire_bytes("0101")[..FUSE_SENTINEL.len() + 2]).unwrap();
        assert!(read_fuse_wire(&truncated).is_err());

        let invalid = temp.path().join("invalid.bin");
        let mut bytes = FUSE_SENTINEL.to_vec();
        bytes.extend([1, 3, b'0', b'x', b'1']);
        std::fs::write(&invalid, bytes).unwrap();
        assert!(read_fuse_wire(&invalid).is_err());
    }

    #[test]
    fn cache_is_reused_only_while_the_binary_signature_matches() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("Codex.exe");
        std::fs::write(&binary, wire_bytes("010011001")).unwrap();
        let cache = temp.path().join("state").join(CACHE_FILE);

        let (wire, cached) = cached_fuse_wire(&binary, &cache).unwrap();
        assert!(!cached);
        assert_eq!(wire.unwrap().states, "010011001");
        let (wire, cached) = cached_fuse_wire(&binary, &cache).unwrap();
        assert!(cached);
        assert_eq!(wire.unwrap().states, "010011001");

        // A different build (size change) must be scanned again.
        std::fs::write(&binary, wire_bytes("0101110011")).unwrap();
        let (wire, cached) = cached_fuse_wire(&binary, &cache).unwrap();
        assert!(!cached);
        assert_eq!(wire.unwrap().states, "0101110011");

        // Binaries without a wire are cached as such too.
        let plain = temp.path().join("plain.exe");
        std::fs::write(&plain, b"not electron").unwrap();
        assert_eq!(cached_fuse_wire(&plain, &cache).unwrap(), (None, false));
        assert_eq!(cached_fuse_wire(&plain, &cache).unwrap(), (None, true));
    }

    #[test]
    fn electron_binary_is_the_executable_or_the_bundled_framework() {
        let temp = tempfile::tempdir().unwrap();
        let windows_app = temp.path().join("app");
        std::fs::create_dir_all(&windows_app).unwrap();
        assert_eq!(electron_binary_path(&windows_app), None);
        std::fs::write(windows_app.join("Codex.exe"), "exe").unwrap();
        assert_eq!(
            electron_binary_path(&windows_app),
            Some(windows_app.join("Codex.exe"))
        );
        std::fs::write(windows_app.join("chrome.dll"), wire_bytes("010011001")).unwrap();
        assert_eq!(
            electron_binary_path(&windows_app),
            Some(windows_app.join("chrome.dll"))
        );
        assert_eq!(
            read_fuse_wire(&electron_binary_path(&windows_app).unwrap())
                .unwrap()
                .unwrap()
                .state(NODE_OPTIONS_FUSE_INDEX),
            FuseState::Disabled
        );

        let bundle = temp.path().join("Codex.app");
        let framework =
            bundle.join("Contents/Frameworks/Codex Framework.framework/Versions/152.0.1");
        std::fs::create_dir_all(&framework).unwrap();
        std::fs::create_dir_all(bundle.join("Contents/Frameworks/Other.framework/Versions/A"))
            .unwrap();
        assert_eq!(electron_binary_path(&bundle), None);
        std::fs::write(framework.join("Codex Framework"), "framework").unwrap();
        assert_eq!(
            electron_binary_path(&bundle),
            Some(framework.join("Codex Framework"))
        );
    }

    /// A backup as an older Codey build would have recorded it: the byte the
    /// fuse had before Codey enabled it, plus the runtime fingerprint.
    #[test]
    fn wire_is_read_from_the_executable_when_the_preferred_file_has_none() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        let dll = app.join("chrome.dll");
        std::fs::write(&dll, b"no fuse wire here").unwrap();
        let executable = app.join("Codex.exe");
        std::fs::write(&executable, wire_bytes("010011001")).unwrap();
        assert_eq!(electron_binary_path(&app), Some(dll.clone()));
        let (binary, wire, cached) = electron_runtime_with_wire(&app, None).unwrap();
        assert_eq!(binary, executable);
        assert_eq!(wire.unwrap().states, "010011001");
        assert!(!cached);

        // Without any wire the preferred runtime is reported so callers keep a
        // useful error message.
        std::fs::write(&executable, b"no fuse wire here either").unwrap();
        let (binary, wire, _) = electron_runtime_with_wire(&app, None).unwrap();
        assert_eq!(binary, dll);
        assert!(wire.is_none());
        assert!(electron_runtime_with_wire(&temp.path().join("missing"), None).is_err());
    }

    #[test]
    fn split_runtime_keeps_a_cache_entry_for_every_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        let dll = app.join("chrome.dll");
        std::fs::write(&dll, b"no fuse wire here").unwrap();
        let executable = app.join("Codex.exe");
        std::fs::write(&executable, wire_bytes("010011001")).unwrap();
        let cache = temp.path().join(CACHE_FILE);

        let (binary, wire, cached) = electron_runtime_with_wire(&app, Some(&cache)).unwrap();
        assert_eq!(binary, executable);
        assert_eq!(wire.unwrap().states, "010011001");
        assert!(!cached);
        // 无 wire 的候选也要留下自己的条目:单条目缓存会被两个候选互相覆盖,
        // 于是每次探测都要重新扫描整个无 wire 的运行时。
        let store = FuseCache::read(&cache);
        for candidate in [&dll, &executable] {
            assert!(
                store
                    .entries
                    .iter()
                    .any(|entry| entry.path == candidate.to_string_lossy()),
                "缺少 {} 的缓存条目",
                candidate.display()
            );
        }

        let (binary, wire, cached) = electron_runtime_with_wire(&app, Some(&cache)).unwrap();
        assert_eq!(binary, executable);
        assert_eq!(wire.unwrap().states, "010011001");
        assert!(cached);
        // 缓存命中必须逐候选判定:第二次探测时无 wire 的 DLL 也要直接命中,
        // 否则它仍会在每次探测时被重新扫描。
        let dll_signature = binary_signature(&dll).unwrap();
        assert!(
            matches!(load_cached_wire(&cache, &dll, dll_signature), Some(None)),
            "无 wire 的候选在第二次探测时仍被重新扫描"
        );
    }

    /// Real-world check against the installed Codex desktop app when present.
    #[test]
    fn installed_codex_desktop_reports_its_inspect_fuse() {
        let candidates = ["/Applications/ChatGPT.app", "/Applications/Codex.app"];
        let Some(binary) = candidates
            .iter()
            .map(Path::new)
            .find_map(electron_binary_path)
        else {
            return;
        };
        let wire = read_fuse_wire(&binary)
            .expect("installed Electron binary should be readable")
            .expect("installed Electron binary should carry a fuse wire");
        assert_eq!(wire.version, FUSE_WIRE_VERSION_V1);
        assert_ne!(
            wire.state(NODE_CLI_INSPECT_FUSE_INDEX),
            FuseState::Unknown,
            "{wire:?}"
        );
        assert_ne!(
            wire.state(NODE_OPTIONS_FUSE_INDEX),
            FuseState::Unknown,
            "{wire:?}"
        );
    }
}
