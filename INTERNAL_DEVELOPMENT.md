# Codey 内部开发文档

本文档面向开发和维护人员，只保留当前架构、开发流程、关键边界和已知限制。用户可见功能维护在 README.md；历史方案和逐版本改动由 Git 记录，不在这里累积。

## 核心设计

- Codey 是 Rust 桌面辅助进程，负责启动、监控和停止官方 Codex Electron 客户端。
- 配置界面由 React 实现，构建后嵌入 Codey，并通过 CDP 注入 Codex 页面；通常没有独立常驻配置窗口。
- Codex 直连用户当前 provider。本分叉不在进程内代理、别名或绑定线程。
- 线路、模型和上游格式分别识别。控制台只读展示当前 Codex 线路；模型清单按 provider 地址指纹归属。
- Codey 配置与 Codex 配置分开保存。用户 Codex 配置原则上只读，异常退出后只恢复 Codey 自有临时状态。
- 无法确认线路、模型归属或兼容能力时应停止请求并给出错误，不猜测、不跨线路自动切换，也不重放可能已经送达的请求。
- 账号额度摘要在 `/account/usage` 返回错误时回退到 `account/rateLimits/read`，仅使用顶层 `rateLimits`，不合并 `rateLimitsByLimitId` 中的模型专属额度。5 小时窗口是否显示取决于账号通用额度实际返回的窗口，不按套餐名称隐藏。输入栏额度芯片优先展示 5 小时窗剩余，否则展示 7 天窗；浮层同时列出两窗。
- 对话用量订 Codex 页面里的 `thread/tokenUsage/updated`，按当前输入栏 conversation id 过滤。CH 用最近一轮 `cachedInputTokens / inputTokens`。费用和输出速度只在通知里带了对应字段时显示，不本地编造单价。

## 目录

- src/：Codey 控制台和前端状态逻辑。
- public/：注入 Codex 页面的轻量脚本。
- backend/src/：启动器、配置、CDP、会话、通知和诊断实现。
- backend/resources/：随二进制分发的运行时规则数据。
- vendor/CodeyRuntime/：backend 实际消费的跨平台能力子集：应用位置发现、CDP 桥接、Codex config.toml 事务读写、Codex SQLite 会话发现与删除、插件市场快照、诊断日志、端口守卫、Windows 进程工具和启动命令构造。2026-09-06 起未被 backend 引用的旧模块（独立启动器、relay/settings 存储、Zed 远程、worktree、stepwise、更新器、旧注入脚本等）及其测试已删除，历史实现从 Git 获取。 2026-09-07 又按 `cargo check --all-targets` 的 dead_code 结果删除了 backend 未引用的零散函数（回环端口守卫锁、CDP 周期求值与新文档脚本注入、旧会话库路径探测、config_manager 备份恢复与 wire_api 写入、运行时版本缓存等）；Windows 专属的 `windows_open_url`、`windows_activate_process_window`、`windows_apply_codey_icon_to_process_window`、`windows_process_control_strategy` 在 backend 中同样无引用，但本机无法交叉编译核实，暂保留。
- scripts/：开发、构建、前端打包和发布脚本。
- tests/ 与 backend 各模块测试：JavaScript 集成测试和 Rust 测试。
- .github/workflows/：质量检查与桌面安装包构建。

## 本地开发

需要稳定版 Rust、Node.js 22 和 pnpm。首次进入仓库先安装依赖：

    pnpm install

常用开发命令：

    pnpm run dev
    pnpm run check
    pnpm run test:js
    cargo test --workspace

pnpm run dev 会先构建完整 Cargo 工作区，再启动 Codey，确保主程序和 FastCtx sidecar 同目录。Windows 若检测到同一构建产物仍在运行，会要求先正常退出；只有确认进程卡死时才使用 CODEY_DEV_FORCE_KILL=1。

## 检查与构建

提交前至少执行：

    pnpm run check
    pnpm run test:js
    pnpm run vite:build
    cargo fmt --all -- --check
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    git diff --check

侧栏额度测试通过 `data-window` 和完整的额度标签检查五小时窗口，避免误匹配重置倒计时中的 `5 小时`；回退场景固定使用约 29.5 小时后的重置时间覆盖该情况。重启测试需保留对 `withTimeout(invoke("restart_codey"), ...)` 调用的检查。

`save_selected_models` 的参数逐项对应命令请求字段，因此仅在该函数上允许 `clippy::too_many_arguments`；工作区继续以 `-D warnings` 检查其他警告。

完整构建使用：

    pnpm run build

该命令先重建前端与注入脚本，再进行 Rust release 构建；随后的 cargo 调用带 `CODEY_SKIP_OVERLAY_BUILD=1`，backend/build.rs 据此跳过再跑一次 Vite，只校验 dist-overlay/codey-overlay.js 已存在。直接运行 cargo 时不设该变量，build.rs 仍会自动构建前端产物。macOS 会额外生成 target/release/bundle/macos/Codey.app；Windows 安装包由 .github/workflows/build-desktop.yml 使用 NSIS 生成。CI 的实际门禁以 .github/workflows/ci.yml 为准。

Windows x64 发布任务通过 CARGO_PROFILE_RELEASE_LTO=thin 和 CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 覆盖默认的 fat LTO 与单代码生成单元，以减少 release 优化和链接耗时；macOS 及本地构建沿用 Cargo.toml 默认配置。Windows 的 Rust 测试、Clippy 和格式检查继续保留。此调整可能影响二进制体积和运行性能，实际提速幅度需由下一次 Windows Actions 构建确认。v0.9.18 的参考耗时为 Windows 任务 12 分 43 秒，其中可执行文件构建 10 分 17 秒、NSIS 打包 36 秒。

macOS 本地调试未签名安装包时，确认来源后可用 `xattr -dr com.apple.quarantine /Applications/Codey.app` 移除隔离属性。此操作不会补齐签名或公证，发布包仍需单独处理。

## 发布

发布脚本会同步 package.json、Cargo.toml 和 Cargo.lock 的版本，运行检查，创建提交与标签并推送：

    pnpm run release -- 0.9.13

默认要求工作区干净。确实要把现有改动纳入发布时使用 --include-existing-changes；只在本地创建标签时使用 --no-push。

v* 标签会触发 macOS arm64、macOS x64 和 Windows x64 构建，并附加到 GitHub Release。本分叉不向客户端分发在线更新：安装包只通过 GitHub Release 和 Actions 产物提供，客户端启动和控制台都不会检查、下载或安装更新。发布标签版本必须与项目版本一致。

## 运行流程

宠物精简设置是可选启动步骤：读取 `.codex-global-state.json` 时使用 `serde_json::value::RawValue` 保留非目标字段的原始 JSON 值，兼容 Codex 保存的未配对 UTF-16 代理项，只修改 `electron-avatar-overlay-open`。主文件无法读取时沿用 `.bak` 回退；两者都无法读取时不覆盖文件。顶层字段名包含未配对代理项仍无法解析。解析、写入或后台任务失败均记录 `startup.pet_slim`、`recoverable: true` 和 `fallback: continue_startup`，继续启动，不触发运行配置恢复。回归测试覆盖特殊字符原样保留、备份恢复及宠物开关两种状态下读取失败仍可完成启动准备。

1. 恢复上次异常退出留下的 Codey 自有临时状态。
2. 加载 Codey 配置，只读检查 Codex 配置、登录状态和应用位置。不自动把当前 Codex 线路写入 Codey 线路库。
3. 在 Codex 未运行时完成会话索引维护、旧版 Codey 状态清理和诊断保护准备。
4. 按设置生成本次进程覆盖、Hook、子代理角色和注入脚本。
5. 启动 Codex，通过启动补丁或 CLI 包装入口传递本次 app-server 配置，再通过 CDP 安装桥接与页面增强。macOS 的 `CODEX_CLI_PATH` 指向私有可执行包装脚本，由脚本恢复可能被 Codex 子进程过滤的兼容环境后再进入 Codey CLI 包装分支，禁止把完整 Codey 桌面入口直接暴露为 CLI。包装器使用官方 CLI 的 `-c` 参数，执行目标程序后才完成握手；握手证明目标已执行，不代表 app-server 已完成初始化或接受了所有配置。Inspector 不可用时，以已确认的 CLI 包装入口正常运行；两条入口都失败且存在必须的运行时约束时停止 Codex。
6. 启动健康检查、退出监听、通知和平台保护任务。设置保存后，支持热更新的项目立即替换；影响启动参数、角色集合或能力目录的项目标记为需要重启。
7. Codex 退出或系统信号时，先确认受控 Codex 已停止，再关闭 watcher、回收 Child、恢复临时配置。停止进程失败时保留 watcher、桥接和配置；只有清理完成后才释放 Hook、租约及其他 Codey 自有运行状态。

启动任一步失败都应走同一清理路径。会话数据的安全修复不会在退出时回滚；Hook 和运行文件必须可恢复。初始 Trace/Crashpad 任务在 profile 与路由 Provider 校验通过后创建；应用定位、旧进程停止或维护失败时，仍等待已启动任务结束并更新状态，再返回原始错误。Trace 失败也会等待 Crashpad，避免丢弃 JoinHandle 后后台清理继续运行。旧 Codex 停止后，模型目录准备与会话维护并行；两者及存储保护全部结束后，才写入最终运行配置。并行减少串行步骤，尚未测量问题设备上的冷启动耗时收益。

启动前先读取 Codex Electron 二进制的 fuse wire（`backend/src/electron_fuses.rs`，按 @electron/fuses 的 sentinel 与 v1 位序解析，结果按路径、大小和修改时间缓存在状态目录 `electron-fuses.json`）。`EnableNodeCliInspectArguments` 为关闭或移除时，Electron 会在解析命令行时丢弃 `--inspect-brk`，主进程 Inspector 永远不会出现：Windows 直接以 CLI 包装器作为唯一入口启动，不再传 `--inspect-brk`，也不等待 Inspector；macOS 保留该参数作为进程清理标记，但只等待 CLI 包装器。fuse 未知（二进制缺失、扫描失败）时保留 Inspector 尝试，由运行时证据决定是否放弃。2026-09-06 本机 ChatGPT.app 的 Codex Framework 读到 wire `010011001`，Inspect 位为关闭；Windows 商店包按同一打包配置，实机日志 `launcher.electron_fuses` 会记录实际值。

Windows 的启动兼容安装最多尝试 2 次，仅超时、中断、WouldBlock、启动等待期间进程退出，以及明确的 Windows 文件共享/锁冲突（错误码 32、33）允许重试。目标程序无效、配置解析错误、权限拒绝、Inspector 响应不兼容和清理失败均不重试。仍使用 Inspector 时首次同时等待 Inspector 和 CLI：渲染进程调试端口已应答而 Inspector 端口仍被拒绝，立即判定 Inspector 不可用并把整个预算留给 CLI，不杀进程；Inspector 发现窗口耗尽且调试端口也未就绪，判定主进程可能停在断点，立即结束本轮并在清理后去掉 `--inspect-brk` 重试。首轮失败后先成功清理进程和 Store 临时环境，第二次重新准备包装器，只等待 CLI 执行确认。Inspector 已关闭且包装器无法准备（暂存失败）或 Store 无法应用包装器环境时，不再启动一个随后必被停止的进程：存在运行配置或子代理约束直接报错，否则按基础参数启动并返回 `degraded`。

每次系统激活返回后重新建立 60 秒的 CLI 确认上限；Inspector 发现窗口仍为 20 秒，补丁安装和 app-server 覆盖校验各 10/24 秒。等待期间每秒检查进程是否存活（直接子进程用 `try_wait`，Store 激活优先使用保留的进程句柄，打开句柄失败时按 PID 检查），进程退出立即结束等待并允许重试一次，不会等到上限。进程清理保留独立的 20 秒上限；文件暂存和系统激活不通过取消 Future 强行中断，因此上述数值不是整个启动过程的硬性耗时保证。回归模拟首轮 Inspector/CLI 均不可用、长清理等待、第二轮 45 秒后握手成功、进程提前退出、渲染端口就绪时的 Inspector 放弃，并检查缺少包装器、不可重试错误和最多两次的限制。Windows Store 系统激活与环境继承仍需 Windows 实机验证。

准备 CLI 包装入口时，先确认真实内置 CLI 同目录的 `codex-code-mode-host`（Windows 为 `.exe`）存在且为普通文件，因为 Codex Desktop 会显式启用 `features.code_mode_host`。缺失时返回具体路径和修复安装提示，避免到工具调用阶段才发现宿主不可用；这项检查不代表宿主已成功执行。Windows Store 仍先校验并修复暂存副本，回归同时覆盖主程序损坏和各配套执行文件被删除。

CLI 包装器在目标校验和创建进程前建立认证连接。回连单次 500ms，端口被拒绝（启动器已不再监听，例如 app-server 重启）立即放弃，超时等暂时性错误在 3 秒内重试，避免回环被安全软件或高负载拖慢时一次失败就静默放弃握手。除握手连接外，包装器还按 `CODEY_CODEX_CLI_WRAPPER_MARKER` 指定的路径（状态目录 `cli-wrapper/<令牌>.json`）写入记录文件：连接前写 `launching`，创建目标进程后写 `executed`，失败写 `failed` 并附原因与是否可重试；macOS 在 exec 前先写 `executed`。启动器同时监听握手端口和每 250ms 轮询记录文件，任一确认即成功，等待结束后删除记录，准备包装器时清理一小时以上的残留记录。令牌后的 EOF 仍只表示目标已执行；失败时发送 `!` 和最多 8 KiB 的结构化错误，保留具体原因与是否允许重试。收到明确失败立即结束兼容等待；创建进程不再使用独立的 750ms 确认窗口，改为共享启动截止时间。握手监听器只服务首次启动，其关闭后仍允许后续 app-server 调用 CLI。回归使用真实子进程覆盖目标缺失、配置无效、执行失败、参数和环境隔离、监听器关闭后的重启；退出码与监听器关闭后的重启回归复用测试程序作为固定返回 17 的原生子进程，避免让 CLI 配置参数参与 shell 命令解析；断言失败时保留子进程输出。Windows 测试另用独占文件句柄验证共享冲突分类。重试分类、截止时间和立即返回通过 Rust 行为测试覆盖，源码检查只保留平台清理顺序等约束。

浏览器和计算机操作执行器会从 Codex 获取 `CODEX_CLI_PATH`，但其子进程环境可能过滤 `CODEY_CODEX_CLI_WRAPPER_*`。CLI 包装分流因此不能只依赖目标环境变量：辅助参数先由各自入口处理；其余带参数的调用从 Codey 保存的应用位置恢复真实内置 CLI，Windows Store 继续复用已校验的用户运行目录。定位该目录时优先采用绝对路径的 `LOCALAPPDATA`；变量被辅助进程过滤、为空或为相对路径时，通过现有 `directories` 依赖调用 Windows Known Folder API 获取本地应用数据目录，不拼接用户主目录，也不扩大子进程的环境变量集合。正常启动与 CLI 回退共用此解析，保留运行文件完整性校验；回归覆盖缺失、空值、相对路径及有效目录优先级。找不到目标、配置损坏或执行失败时直接报错，禁止进入桌面启动及 Codex 进程清理流程。无参数启动、旧 watcher 的 `--debug-port` 和 macOS 的 `-psn_` 启动参数保留桌面行为。此恢复不依赖主进程 Inspector；现有兼容环境完整时仍优先使用本次启动指定的目标和运行配置。回归覆盖环境缺失、保存位置无效、参数及退出码转发和正常桌面分流；Windows 下的 Chrome 端到端行为仍需实机验证。

诊断日志记录 fuse 探测结果与扫描耗时（`launcher.electron_fuses`）、Store 临时环境启用与清理、激活返回的 PID、线程恢复结果、Inspector 发现或探测汇总（`launcher.inspector_probe_summary`：拒绝/超时/其他错误次数、渲染端口是否就绪）、尝试次数及是否为无断点 CLI 启动、包装器自身的启动时间与回连结果（`launcher.cli_wrapper_started`、`launcher.cli_wrapper_handshake_connect`）、CLI 认证和执行确认、记录文件确认（`launcher.cli_wrapper_marker_*`）以及进程提前退出（`launcher.startup_process_exited`）；环境只记录是否存在，不记录令牌或完整配置。CLI 超时区分未收到有效握手与已认证但未确认执行，便于识别桌面未启动包装器和目标程序启动缓慢。Inspector 探测报「被拒绝」还是「超时」是关键区分：fuse 关闭时无人监听，应当立即被拒绝；连续超时说明回环连接被拖住，同一原因也会拖慢包装器回连。

### 启动与补丁核验基线（2026-09-05）

Codey 当前声明版本为 0.9.18，不固定安装某一版 Codex。macOS 根据应用位置启动桌面客户端，CLI 包装器的目标来自该应用的 Resources，不能用 PATH 中的 `codex --version` 代替桌面运行版本。

本次本机证据：`/Applications/ChatGPT.app` 的 Info.plist 与 app.asar/package.json 均为 26.901.22334，构建号 7746，签名标识 com.openai.codex、TeamIdentifier 2DC432GLL2；运行主进程及 app-server 均来自此应用。内置 CLI 为 0.153.0，PATH 中独立安装的 CLI 为 0.145.0。包内开发依赖声明 Electron 42.3.0，实际 CDP 报告 Chromium 152.0.7977.64；不能把开发依赖版本当成定制运行时版本。

已读取早期标签 0.2.0（e8082e6）和 0.2.1（48937a3）：两版都传递 `--inspect-brk` 并把主进程补丁失败视为启动失败，WMI Worker 拦截已存在，尚无 Git 请求保护。两版之间主进程补丁文件未变，页面注入改为延迟加载会话工具；没有旧 Codex 安装包，无法证明当时实际二进制是否开放 Inspector。CLI 兼容入口由 e8d485b 于 2026-09-03 加入，2f844dd 随后隔离包装器环境，Windows Store 使用 86b1af4 的用户目录运行文件暂存方案。

本次实际进程携带 Inspector 参数，但对应端口拒绝连接；renderer CDP 可用。Codex Framework 的 Electron fuse wire 为 v1、9 项、`010011001`，`EnableNodeCliInspectArguments` 为关闭状态。由此确认本机主进程 Inspector 不可用的直接原因。保持只读检查，不改写 fuse、应用包或签名。桌面 bundle 的 `src-BXVxNf6C.js` 中仍有 `CODEX_CLI_PATH` 解析及 app-server 子进程入口，实际 app-server 参数包含 Codey 的运行时覆盖。

当前保留 renderer CDP 页面增强和 CLI 包装器运行配置；主进程 Inspector 可用时还会安装桌面统计上报和定时状态采集精简、窗口聚焦触发的插件刷新去重、任务标题模型处理，以及模型/页面控件兼容等可选修改。CLI 包装入口不安装这些主进程修改。

第三方 Fast 控件另有页面侧兼容（模型注入脚本 v52）：模型菜单的鼠标或键盘交互在原生处理前，按当前或即将选择的第三方模型 `serviceTiers` 修正该选择器的原生权限缓存。菜单及 `serviceTierForRequest` 在随后的原生渲染中共同使用修正结果，继续由原生控件和回调保存设置，无需主进程 Inspector、替代按钮或独立 Fast 状态。仅处理模型声明的 `priority` 档位；保留加载状态，切回官方或不支持 Fast 的模型、卸载脚本时恢复原值。React 父节点查找最多 80 层，待恢复的权限对象最多 64 个，不扫描全页、不改写安装包。回归模拟 API Key 账号的原生权限返回缓存，覆盖权限关闭时回调为 undefined、React alternate 缓存、按钮和请求档位、开关、键盘打开、官方模型恢复、无 Fast 能力及加载状态。本机 Codex 26.901.51231 页面将权限返回对象置为 false 后可复现按钮消失，加载修复后原生按钮恢复，点击开关使原生请求档位在 priority/default 间切换；未发送模型请求。该验证不等同于 Windows 实机或上游加速验证，Windows 设备仍需用更新后的 Codey 验证实际菜单。

Inspector 与 CLI 包装器是内部启动路径，不是用户可切换的运行模式。任一入口安装成功即返回 `ready`；页面继续按实际功能探针显示正常、待确认或异常，不再把 CLI 路径显示为兼容模式或声称所有优化均已生效。只有 Windows 在两条入口均失败、且没有必须的运行时约束时，才可按基础参数重新启动并返回 `degraded`，界面显示需检查和具体原因。必要配置或子代理约束无法确认时仍中止启动。`performanceStatus`/`performanceDetail` 保留现有接口名称，当前表达启动健康状态。官方文档公开的 [codex app](https://developers.openai.com/codex/cli/reference) 用于打开客户端，[app-server](https://developers.openai.com/codex/app-server) 用于客户端协议；`CODEX_CLI_PATH` 按当前 bundle 的兼容入口维护，不标为官方稳定扩展 API。

### 性能补丁删除与依赖审查（2026-09-05）

按维护者明确要求，彻底删除 WMI 周期采样 Worker 拦截、主进程和 renderer Git 请求限流、临时 WebView 生命周期管理、Codex 执行环境及子代理的额外回收补丁、avatar overlay 预加载改写与隐藏窗口限速。同步删除状态 IPC、自检、renderer 探针、平台筛选、预览状态、专属脚本和已失效的测试。上述行为交回 Codex 自身处理，删除决定不代表已确认所有上游性能问题都已修复。

WMI 拦截自 0.2.0 存在；Git renderer 保护由 3280462 引入，主进程 IPC 由 1a0c4c7 引入。审查时上游 `worker.js` 已有 `sharedRuns` 去重、`repositoryRuns` 排队与 watcher 复用，缺少当前 Windows 实机证据。历史实现可从 Git 查询，当前代码不再保留兼容分支或等待命中状态。

Windows Store 运行文件暂存、CLI 环境隔离、Inspector 启动时防止 Worker 继承调试参数，以及用户可选的 Trace/Crashpad 管理仍有独立用途，予以保留。

### Windows 启动稳定性改造（2026-09-07）

现场报错「Codex 启动补丁失败：等待 Codex 启动补丁超时 … operation timed out；CLI 兼容入口失败：等待 Codex CLI 兼容执行器超时」的结构性原因：Inspector 路径在当前 Codex 构建上不可能成功（fuse 关闭），却决定了等待结构；CLI 握手窗口固定 20 秒且包装器回连只尝试一次 500ms，冷启动、Defender 首次扫描未签名的 codey.exe 或安全软件拖慢回环连接时，健康的 Codex 会被当作失败杀掉重启。v0.10.2 还让两次尝试共用一个 44 秒总时限。本轮改动：

- 启动前读取 Electron fuse，Inspect 位关闭时 Windows 不带 `--inspect-brk`、不等 Inspector；macOS 保留参数作为清理标记但只等 CLI。
- 包装器回连可重试，并新增记录文件作为第二确认通道；启动器不会因握手丢失杀掉已执行目标的 Codex。
- 等待按证据结束：确认进程退出后失败并重试一次；渲染进程调试端口就绪而 Inspector 被拒绝时立即放弃 Inspector；单轮 CLI 确认上限 60 秒。
- Windows Store 启动进程通过 `OpenProcess(PROCESS_SYNCHRONIZE)` 和 `WaitForSingleObject(0)` 检查存活状态。仅 PID 确实不存在或进程句柄已结束时报告退出；访问被拒绝等查询错误记录为 `launcher.process_probe_failed`，继续等待原有握手时限，不跳过运行时覆盖确认。退出监视与维护锁检查也保留查询不确定状态。
- Windows 进程枚举返回 `Result`，快照创建、首项读取或后续项读取异常均不能转换为空列表或不完整列表；仅 `ERROR_NO_MORE_FILES` 表示遍历正常结束。查询最多尝试 3 次，间隔 50ms。激活前检测、旧实例清理及清理结果确认在持续查询失败时明确报错，避免误报清理成功。
- Inspector 关闭且没有可用包装器时在启动前决策，不再启动随后必被停止的进程。
- Windows Store 运行文件存放于 `%LOCALAPPDATA%\Codey\codex-runtime\<哈希>`，临时复制目录也位于此根目录。Codex Desktop 会清理自身 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下的旧 16 位哈希目录，因此 Codey 不再向该公共目录写入或复用副本；首次使用新位置时重新复制，旧目录留给 Codex 自身管理。回归模拟官方清理规则，确认四个运行文件及清单仍完整，后续启动能直接复用。运行文件暂存按包文件的大小与修改时间识别，复制时校验一次 SHA-256 并写入目录清单 `.codey-staged.json`，后续启动只核对清单与文件大小，不再每次对约 300 MB 的运行文件全量哈希；副本大小不符时重新暂存。
- 补充探测与包装器阶段的诊断日志，见上文诊断段落。
- Electron fuse 模块仅在 Windows、macOS 或单元测试中编译；诊断和异步探测入口仅在 Windows、macOS 编译，Linux 仍运行解析、扫描和缓存测试。`startup_launch_arguments` 仅在 Windows 及 macOS 单元测试中编译，与调用方保持一致，避免 Linux CI 在 `-D warnings` 下报告未使用代码。

本机验证：`cargo test -p codey --lib`（electron_fuses、launcher、codex_startup_patch 相关用例，含读取已安装 ChatGPT.app 的真实 fuse wire）、`cargo test -p codey --test codex_cli_wrapper`、`cargo clippy -p codey --all-targets -- -D warnings`、`cargo fmt --check`、`pnpm test:js`。本次进程检测修复另通过 `cargo check --workspace --locked`、`cargo test --workspace --locked`（后端库 1077 项）及 14 项相关 JavaScript 测试。完整 `windows_integration.rs` 及其原生测试通过临时最小 crate 的 Windows 目标类型检查；完整 Windows 工作区交叉编译因本机缺少 Windows SDK 停在已有 C 依赖。Windows 原生存活检测、清理快照故障注入及 Store 实际启动仍需 Windows CI 与实机验证。未签名的 codey.exe 仍是 Defender「首次可见即阻止」拖慢启动的诱因，签名属于发布链路事项。

启动连接测试不依赖关闭的本机端口及时返回 `ConnectionRefused`：Windows 在单次连接时限内可能只返回 `TimedOut`。握手测试通过可替换的连接函数分别验证拒绝时不重试、超时后重试成功和达到截止时间后结束；成功路径仍连接真实监听端口。Inspector 测试明确提供先超时后拒绝的探测结果，并使用真实渲染进程监听端口，验证超时本身不会触发 `InspectorUnavailable`。生产环境仍使用原有 TCP 和 HTTP 请求及超时配置。

Windows 集成模块已删除无调用方且未对外导出的快捷方式创建、桌面目录查询、注册表写入与删除、仅按 PID 终止进程函数，以及这些函数专用的 COM 和注册表辅助代码。现有窗口操作、进程枚举及校验路径或创建时间后终止进程的入口保持不变，避免 Windows CI 在 `-D warnings` 下因遗留代码失败。

依赖审查结合三个 Cargo 包、前端清单、构建脚本、平台 cfg 和源码调用；`cargo-machete .` 未发现未使用的直接依赖。`pnpm why @mantine/hooks` 确认它是 Mantine Core 的必需 peer，删除根声明不会减少安装树；`cargo tree --locked -i zopfli -e features` 确认 ZIP 的 deflate 特性同时由 FastCtx 启用，仅调整本项目不会移除 Zopfli。系统代理、系统证书、二维码、压缩包读取及原生平台依赖均保留，未改动依赖版本或锁文件。此次删除减少注入代码及随包资源，不宣称减少第三方依赖数量。

上轮审查清理复用 `http_response::read_bounded_body`，删除模型列表的重复限长读取实现；保留声明长度和分块读取的双重限制。发布脚本及标签打包流程均执行带锁定依赖的 Rust 测试和 Clippy，不能假设只监听 master/PR 的 CI 已验证标签。

此次删除后的 macOS 验证：`pnpm run check`、`pnpm run test:js`（348 项）、`cargo fmt --all -- --check`、`cargo test --workspace --locked`（1591 项）、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`pnpm run build`、`git diff --check` 全部通过。计数来自共享工作区，包含其他任务尚未提交的模型测试。回归确认原生 Worker 和 IPC handler 不再被 WMI/Git 补丁拦截，用户脚本隔离、CLI 启动和剩余页面增强保持通过。

release 应用通过 `plutil -lint`、`codesign --verify --deep --strict` 和可执行权限检查；使用临时 HOME/CODEX_HOME，经 release 包装器调用内置 CLI 0.153.0，app-server 的 initialize 请求成功且退出码为 0。未重启当前桌面会话。`cargo check --workspace --all-targets --locked --target x86_64-pc-windows-msvc` 在 ring 的 C 编译阶段因本机缺少 Windows SDK 的 `assert.h` 失败，不计为 Windows 验证通过；原生 Windows 测试由发布/CI 工作流执行，仍需实际运行。

### Windows 启动退出补查（2026-09-08）

现场截图对应 `StartupProcessExited`，表示兼容等待时检测到启动进程结束。旧错误仅包含 PID，缺少退出码和进程身份，无法据此区分原生崩溃、正常退出或单实例交接；重试后恢复也不足以证明具体原因。本次补齐以下流程与诊断：

- Windows Store 激活后尽早保留 `OwnedHandle`，启动等待通过同一个进程句柄判断退出，避免轮询期间 PID 重用干扰；句柄保留到启动流程结束，进程结束后仍能读取退出码。打开句柄失败时记录原因并沿用原有保守 PID 检查，查询错误仍不等同于退出。
- `launcher.startup_process_exited` 和启动错误增加十进制、十六进制退出码；`launcher.windows_package_activated` 及兼容失败记录增加包内进程和激活 PID 对应的路径、名称、父 PID、创建时间。快照失败记录查询错误，不影响启动判断；不记录令牌或运行配置。根据这两处事件可核对激活进程退出时是否仍有同包进程，但代码不会未经兼容确认自动接管另一个 PID。
- 系统激活、直接创建进程的可重试错误纳入原有最多两次尝试；Store 的共享或锁冲突 HRESULT（32、33）、Windows 超时（1460）及 `E_APPLICATION_ACTIVATION_TIMED_OUT` 允许重试。激活失败后显式停止可能已创建的 Codex，并清理 Store 临时环境；任何一项清理失败都保留错误并禁止重试。环境安装失败也先显式清理，再决定是否允许原有降级路径。

本机验证通过 17 项 CLI 启动 Rust 回归、8 项相关 JavaScript 回归及后端库 `cargo check`。完整 `launcher/platform.rs`、原生进程模块及平台测试通过临时最小 crate 的 Windows 目标类型检查（应用发现、日志等非目标依赖使用替身）；完整 Windows 工作区检查因缺少 Windows SDK 的 `assert.h` 停在 ring 编译阶段。新增 Windows 原生测试覆盖进程回收后读取退出码，以及合法退出码 259 不被当作仍在运行；这些测试尚需 Windows CI 实际执行。此次改动补齐已确认的流程缺口，截图所涉具体退出原因仍需问题设备的当次日志验证。

## 配置与数据

生成的模型目录写在 Codey 数据目录，不写入 CODEX_HOME。

- Codey 配置由 directories crate 放在系统配置目录的 config.json，并保留三份有效滚动备份。Unix 下配置、备份和日志应限制为当前用户可读写。
- CODEX_HOME 非空时始终优先；否则使用 Codex 默认目录。
- auth.json 只读，Codey 不修改官方登录凭据。
- config.toml 在启动准备和正式启动前做快照复核。apply 与 restore 都不改写用户 Provider、MCP、模型或未知字段，也不改写用户 config.toml。
- codex-lease.json、hooks.json 中的 Codey 组、角色运行副本和证明状态均属于临时运行资产，异常退出后由下次启动恢复。
- 第三方 API Key、通知地址和机器人令牌目前仍以明文保存在 Codey 私有配置及备份中；后端不会把已保存值返回前端。后续若迁移系统凭据库，应同时处理备份格式和升级兼容。
- codey-errors.log 只记录脱敏后的失败信息。不要把提示词、响应正文、认证值或完整敏感地址写入日志。
- 输入栏额度只认 auth.json 里的 ChatGPT 登录和 showAccountUsageInHeader，不读取 CodeyConfig.profiles。开关文案仍是「额度显示」，语义是控制输入栏额度芯片。

## 主要子系统

### 线路与模型

官方模型目录包含 `gpt-6-astra`，优先使用本机 Codex 缓存中的运行参数与推理强度；内置兼容元数据不包含提示词。GPT-6 的第三方线路别名仅在原模型模板声明 Ultra 和多代理能力时保留对应能力，通用第三方模型不继承这些参数。运行时只校验本次生成的模型条目；旧缓存缺少 GPT-6 模板时仍可使用已有模型，使用 GPT-6 前需直接启动官方 Codex 刷新缓存。

本分叉删除进程内本地路由。Codex 使用用户当前 provider 直连，Codey 不代理、不绑定线程。`local_router_enabled` 缺省为关闭；加载和保存 Codey 配置时若磁盘上仍为 true，按关闭处理。模型目录与页面注入都走当前 Codex provider，不使用已保存线路上的清单。第三方模型清单按当前 Codex provider 的 id 加规范化地址指纹归属；换模板不会复用旧地址目录。用户 config.toml 解析失败则拒绝启动。历史会话可在控制台显式迁移。

Codex 直连用户当前 provider。本分叉不在进程内做认证隔离、模型别名或流式转发。网页搜索、自动审核和远程压缩能力由当前 Codex provider 与模型目录共同决定。

仅在主进程 Inspector 可用且标题补丁安装成功时，Codey 才调整 Codex 自动标题模型：优先使用可用官方账号的 `gpt-5.6-luna`；没有官方账号时，依次使用当前默认第三方线路的同名模型和当前默认模型，推理强度保持 `low`，请求失败则保留客户端临时标题。CLI 包装入口沿用 Codex 自身的标题生成行为。

### 控制台与页面注入

cdp.rs 负责准备嵌入资源、安装桥接、首次注入和健康复核。src/overlay.tsx 挂载 React 控制台；public/ 中的脚本分别处理模型、插件、会话、提示词、输入栏用量额度和平台增强。`composer-usage.js` 把账号额度芯片和对话用量芯片挂到 Codex 输入栏，不再写入侧栏 `#codey-account-usage`。

控制台首次打开时再加载完整界面。轻量健康探针持续确认桥接状态，只有确定桥接缺失时才重注入；页面忙或探测超时保持保守状态。

用户脚本在同一文档成功执行后不会因桥接恢复而重复运行，失败可重试，新文档正常运行。内置脚本保留自身的恢复逻辑。桥接安装检查 Runtime.evaluate 的 exceptionDetails；失败释放新连接，成功替换后关闭旧 pump。new-document 注册随各次 CDP 会话维护，不使用跨连接 target 缓存。

模型列表热更新通过 QueryClient 发布新结果，不直接修改 React 共享查询对象，确保已挂载的对话模型选择器收到通知。模型增删立即同步页面列表；对应的 app-server 模型能力仍按启动配置判断是否需要重启，不能因页面刷新成功而清除重启状态。热更新检查只阻止远程压缩身份、官方线路连接等不兼容变更，不再因模型集合变化阻止刷新。保存提示分别报告模型投递、能力待重启和子代理配置失败，未执行热更新不再显示为刷新失败。

Codex 更新后，优先检查启动补丁、app-server 参数结构、入口资源和页面语义选择器。兼容判断必须唯一命中，不能用宽泛文本或 DOM 位置猜测。

### 会话与插件

启动期会话维护只在受控 Codex 停止后修改 rollout、SQLite 和索引。启动时不改写会话 provider。历史 builtin-router 会话由控制台显式迁移。运行中的导入、导出、删除轮次与恢复备份会先释放目标会话，再使用临时文件、大小限制、原子替换和并发校验；无法稳定确认轮次或当前页面已切离时拒绝删除。

插件市场修复使用随程序分发的快照和回滚替换。状态读取保持只读，只有用户触发修复时才更新 Codey 管理的市场目录与注册项。

Computer Use 沿用 Codex 管理的 `unified-computer-use` 插件及其 `cua_repl` 服务。新版桌面端可能自动关闭旧 `computer-use` MCP，不能仅据此认定电脑操作不可用，应验证官方统一入口。Codey 不再创建 `codey_computer_use`，也不重写旧服务或插件开关；启动时保留用户原配置。回归测试覆盖旧服务开启、关闭以及两种启动方式，验证磁盘配置和退出恢复保持原样，运行参数不新增 MCP 或插件覆盖。此前生成的重复条目可在确认官方入口可用后从用户配置及 Codey 保存的配置中移除。

### 提示词、子代理与 FastCtx

子代理详情标题栏由 `public/renderer-inject.js` 在页面增强阶段添加，不依赖启动期原生资源改写。通过原生标题组件的 `seed` 与父组件 `conversationId` 一致性识别子会话，复用现有会话控制器，等待 `manager.readThread(id, { includeTurns: false })` 的异步结果后读取 `thread.model` 和 `thread.reasoningEffort`。详情页缓存的 `latestModel` 可能为空，不能作为唯一数据源，也不能把 RPC Promise 当作同步状态。打开或交互时刷新，合并同一请求并限制一秒内重复读取，不新增定时轮询；切换和关闭详情时移除标识并丢弃旧响应。标题右侧显示模型名和推理强度，悬停提供完整模型标识；数据缺失时显示待获取，不回退到父任务或角色默认配置。回归位于 `tests/subagent-header.test.mjs`，覆盖异步读取、切换竞争、缺失值和关闭清理。本机已在现有 Codex 子代理详情实测显示 `gpt-5.6-luna · xhigh`。

子代理门禁与 FastCtx 路由 Hook 的定义只写入运行期 hooks.json，并通过 `-c features.hooks=true` 与 `hooks.state.*.trusted_hash` 覆盖项交给 Codex；启动补丁生成的临时 config.toml 文档不再携带 `[[hooks.*]]` 表，相关 TOML 写入和旧组清理代码已于 2026-09-06 删除。同日移除了隔离运行时设计之前的租约恢复路径（AGENTS.md / agents/default.toml 快照回滚）：旧版本遗留的 codex-lease.json 仍会被读取并释放，hooks.json 与策略文件按当前流程回滚，但不再回写 AGENTS.md 与 default.toml。

不可用的子代理角色模型会明确标出，不会悄悄替换。

提示词优化使用当前 Codex 线路或独立配置。地址、认证和模型由后端校验；日志不保存提示词正文或凭据。

子代理模型校正保留线路别名，并校正对应的思考深度。第三方模型优先使用精确别名元数据；只有当前线路可以回退到原始模型名元数据，避免把另一线路的同名模型能力混用。官方模型使用官方能力列表。其他线路缺少对应元数据时保留原设置，由后续运行校验处理，不推断支持能力；实际模型与思考深度的严格校验保持不变。

子代理增强只在原生 macOS 和 Windows 启用。五个用户角色与内部 default 角色的配置源位于 backend/src/codex_config_guidance.rs，默认规则数据位于 backend/resources/subagent-rules.default.json。关闭本地路由时，启动器会按当前 Codex Provider 的可用模型重新校正角色模型与思考深度，再生成本次运行配置。当前路径直接使用 Codex 原生 agents 工具和生命周期 Hook，不再使用旧版 sidecar、逐任务回执、prepare_delegation 或 resolve_batch 流程。只读任务最多并行三个；出现写入角色时最多两个，并由根代理在所有尝试结束后验收结果。活动 attempt 全部通过绑定、marker 和 `files.read` 能力校验时，可信根 turn 可继续使用规则确认的本地读取、网页检索、MCP Resource 与数据库 schema/只读 SQL 工具；SQL 只接受单条、可保守证明为只读的语句，写入、命令、视觉、未知工具以及 writer/mixed/unverified 批次仍保持关闭。角色名、词法 SQL 校验和 Hook 不是最终安全边界，真实权限仍由数据库只读账号以及 Codex sandbox 与 approval 设置决定。

完整且无筛选的 agents 列表若只包含根代理，会精准回收从未绑定、从未启动的 pending spawn，覆盖 provider 在线程上限等失败后缺少 PostToolUse 回执的路径；已绑定或已启动 attempt 不受影响。顶层 wait 超时和仅根代理快照不算语义进展，不得重置 Stop 的 10 分钟停滞恢复窗口，只有带具体代理身份的状态或输出变化才会重置。

停止后继续可能产生新的 turn_id，且不触发 UserPromptSubmit。门禁在 PreToolUse 和 wait/list 回执路径发现根轮次不匹配时，会核验 sessions 内本会话的根 rollout：会话 ID、cli/vscode 来源、旧绑定轮次的 turn_aborted，以及随后当前轮次的 task_started 必须全部匹配，才更新根绑定。读取限定为首行 64 KiB 和末尾 2 MiB；证据缺失时仍拒绝编排调用。恢复绑定不会清空子代理状态，仍需权威终态或中断成功回执结算。

2026-09-07 审查修复：全量快照恢复仅由无筛选的 `list_agents` 触发；`wait_agent` 即使返回 `agents` 数组，也只能结算明确提及的代理，不能把未出现的兄弟任务判为结束。wait/list 续行文案先给出全部门禁指令，再将工具原文放入明确标为不可信数据的 Markdown 围栏；围栏长度超过原文内最长的反引号连续段，防止原文提前结束围栏。该格式用于区分内容来源，不构成模型提示注入的完整防护。

运行时策略缺失时，角色准入（含省略角色的默认派发）和尚未缓存成功证明的 child 数据工具均返回 `CODEY_SUBAGENT_RUNTIME_POLICY_MISSING`。已缓存的证明仍允许原任务结束；向 `/root` 回报异常的消息不依赖策略文件。pending 更新不能仅因时间经过而忽略：进程可能在角色文件、lease 和策略提交之间退出，旧策略未必与磁盘上的角色一致。需通过重新保存设置或由 Codey 重启 Codex，执行现有完整校验与重建；Hook 拒绝文案包含此恢复办法。

SQL 词法检查拒绝引号内反斜杠、引号外的 `#`、方括号、美元引用、PostgreSQL `E` 字符串、嵌套块注释以及 `--` 后无空白的方言歧义。带引号的标识符同样检查禁用词；服务端文件访问、远程执行、延时和已知副作用函数不予放行。正常单条 SELECT、WITH、EXPLAIN 和元数据查询仍按原规则判断。该词法器不能证明自定义函数没有副作用，必须继续使用只读数据库账号。

当前跨会话写冲突检查仅覆盖相同 runtime generation；不同 app-server 的写入互斥仍需调用方安排。损坏的其他会话账本可能隐藏活动 writer，不能直接跳过，也不能仅按文件年龄忽略。无可靠身份关联的 marker 与 reservation 保持分别计数；身份未确认时不适用三个只读代理的上限。Stop 自首次受阻起累计 60 分钟达到绝对上限后会 fence 遗留 attempt，原代理是否已在上游停止不能由此推断；下一轮用户输入会提示先调用无筛选 list 对账，后续派发拒绝文案保留真实的超时原因。

视觉角色由原生任务胶囊授予 `visual.inspect`，受信的图像、截图、CUA 和 `open_in_codex` 工具只对视觉角色开放。Responses 工具结果中的图像在 Chat Completions 与 Anthropic 回退协议中会转换为紧随 tool result 的用户图像块，不能退化成 base64 JSON 文本。协作响应中的解密失败、空 payload 或任务体缺失统一触发一次活动代理任务重述恢复；Codey 不尝试本地解密 provider 载荷。

内置 FastCtx 只提供文件读取、搜索、发现和批量替换。检测到用户已有 FastCtx 时不重复注册；内置版本通过本次进程覆盖加载，不写入用户 Codex 配置。版本与固定提交以 Cargo.toml 和 THIRD_PARTY_NOTICES.md 为准。

## 维护约束

- 兼容窗口：只保证从最近两个已发布版本升级时的平滑迁移，更早版本的数据格式迁移代码不再保留。2026-09-06 据此删除了 v0.10.2 之前的迁移路径：历史 guidance 版本常量（三段提示词只识别当前文本）、`ccSwitch*` 配置别名、`defaultModelByProvider` 旧字段与迁移、API-key 线路中官方模型的重分类迁移、config.toml 子代理并发的旧键迁移、请求日志 SQLite 列迁移与读侧列探测、旧模型目录 description 修复、子代理账本 schema 升级（仅接受当前 schema）、`codey/` 旧模型前缀识别，以及隔离运行时之前的租约恢复路径。

- README.md 只写用户能感知的功能与必要注意事项；实现、构建、发布、路径和限制写在本文档。
- 新功能先复用现有配置事务、桥接、URL 校验、错误脱敏和原子文件工具，不建立第二套流程。
- 对 Codex 持久数据的写入必须有所有权证据、快照复核、备份和原子替换；不确定时保持只读。
- 网络请求必须有输入与响应上限，凭据不能进入错误文本、URL、前端状态或请求日志。
- 本文档描述当前稳定结构，不记录调参历史、已删除方案或逐版本迁移过程。

## 已知限制

重启状态查询：前端 `runtime_status` 与 `restart_codey` 请求均设 10 秒等待上限；超时仅结束前端等待，不取消后台重启。重启轮询连续失败 5 次或达到 5 分钟上限且仍未完成时，通过 `onExhausted` 显示状态未知并停止加载，保留最后一次后台状态。按钮改为重新查询，仅调用状态接口；确认后台仍在重启时恢复轮询。超时请求的迟到响应不会提交前端状态。`tests/injection-status.test.mjs` 覆盖失败耗尽、轮询期限、恢复查询和迟到响应。

- 只支持 Codex Electron 桌面客户端；页面和 bundle 大改时可能需要更新补丁与注入适配。
- 第三方线路只能使用目标服务可表达的能力；无法无损转换的请求会在发送前拒绝。
- Codex 直连当前 provider，不在本机做跨线路容灾，也不会重放已发送请求。
- 子代理 Hook 用于本地协作约束，不等同于操作系统沙箱。
- FastCtx 不提供 PDF、MCP Resources 或 shell 工具，这些任务继续使用 Codex 自带能力。
- 进程内请求日志已随本地路由删除，控制台不再提供该页面。
- 当前发布的 macOS 与 Windows 安装包可能未签名，正式分发前应补齐平台签名与公证。
- 若系统拒绝终止 Codex，已建立的运行时会保留依赖供停止重试；若首次启动尚未建好运行时就发生注入失败且无法终止进程，需要人工退出残留 Codex 后重启。当前测试不能替代 Windows 实机或完整桌面重启验证。

