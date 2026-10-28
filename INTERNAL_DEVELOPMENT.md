# Codey 内部开发文档

本文档面向开发和维护人员，只保留当前架构、开发流程、关键边界和已知限制。用户可见功能维护在 README.md；历史方案和逐版本改动由 Git 记录，不在这里累积。

## 整体结构

- Codey 是 Rust 桌面辅助进程，负责启动、监控和停止官方 Codex Electron 客户端。
- React 控制台构建后嵌入程序，经 CDP 挂载到 Codex 页面；完整界面按需加载，轻量脚本负责日常页面增强。通常没有独立常驻配置窗口。
- Codex 直连当前渠道对应的 provider。本分叉不在进程内代理、转发、别名或绑定线程；Codex 启动代理的本机认证中继只替 Codex 向用户配置的网络代理认证，不涉及 provider 选择。
- `src/` 保存前端，`public/` 保存注入脚本，`backend/src/` 保存后端，`backend/resources/` 保存运行规则，`scripts/` 保存开发与发布脚本。
- `vendor/CodeyRuntime/` 随上游整目录跟踪，提供应用发现、CDP、配置事务、会话存储和平台能力；backend 只调用其中的子集，未调用模块保持原样。FastCtx 作为配套程序分发。

## 启动与退出

启动先恢复 Codey 自有临时状态，再只读检查用户配置、登录状态和应用位置。受控 Codex 停止后完成会话维护、模型目录准备和诊断保护，再生成运行期覆盖、Hook 与页面增强，启动客户端并安装页面桥接。不检查、下载或安装客户端更新，也不建立内置路由。

- 主进程兼容入口只有 CLI 包装器，通过 Codex 原生读取的 `CODEX_CLI_PATH` 指定。当前 Codex 关闭了允许 Node 环境选项和主进程调试的两个 Electron 运行开关；Codey 不检测、缓存或修复这些开关。必要运行配置无法通过包装器确认时停止启动。
- 包装器调用应用内置 CLI，并检查配套工具宿主；通过认证握手或运行记录确认目标已执行。Windows 优先使用可写的运行记录：首次写入成功时不建立握手连接，最终状态写不进时补一次有界握手；首次写入失败时照常握手。该确认不代表 app-server 已完成初始化。
- Windows 每次启动尝试在启动 Codex 前，向 Codey 配置目录的 `codex-cli-launch.json` 原子写入本次 CLI 目标、运行期覆盖和子代理开关，以及格式版本和租约标识。辅助进程丢失包装器环境时，从此文件恢复三个启动值；环境中存在 CLI 目标时只使用环境，完全不读文件。文件来源不参与启动握手，也不读取或转发握手端口、令牌、记录路径和可选握手开关。
- 此文件仅供 Codey 内部使用，内容私有且绝不写入日志；诊断只记录配置来源、子命令类别和启动结果。写入使用私有原子写入器：Windows 继承当前用户配置目录的访问权限，不额外设置文件 ACL；临时文件同步后替换，替换失败保留旧文件并报告错误。不得把配置目录放在其他用户可读取的位置。
- 文件只在其绑定的运行租约有效期间可用；恢复删除租约后，即使文件残留也拒绝使用。新租约使用新的标识，正常角色刷新保留标识；每次启动尝试覆盖文件，最终保留的尝试使用对应配置。缺失、损坏、版本不支持或租约失效时，辅助 app-server 以“缺少本次启动配置”拒绝启动，不能使用空覆盖继续运行。失败清理后残留 Codex 的辅助调用同样拒绝，须退出残留进程再重试。
- macOS 保留私有包装脚本机制。独立工具调用在没有有效持久化配置时仍从已保存应用位置恢复 CLI；受控 app-server 必须携带本次配置，禁止误入桌面启动及进程清理流程。
- 运行期覆盖只通过 CLI 包装器传递，不写入 Codex 的 `config.toml`。macOS 配置目录的 `codex-cli-wrapper` 保存包装器环境，并在准备启动时重写。Windows 启动文件按上述租约规则失效。进程退出不代表这些启动文件立即删除。
- Windows Store 按当前用户注册包定位，每次尝试按原 package family 刷新路径，激活后核验实际身份。包切换时先成功清理再重试，不跨正式版、Beta 或发布者切换。
- 安装目录选择框的前置检查、启动与 CLI 包装器共用同步目录解析，启动器仍通过阻塞任务执行：先按原包系列定位当前注册版本，再检查目录及应用身份。Store 更新删除旧版本目录后不要求重新选择；注册查询或身份校验失败时明确报错，不改选其他安装。Windows 回归检查 `configured_codex_app_dir_recovers_installed_store_update` 默认忽略；设置 `CODEY_TEST_PREVIOUS_APP_DIR` 为已删除的旧目录、`CODEY_TEST_CURRENT_APP_DIR` 为当前注册目录后，用 `cargo test -p codey --lib configured_codex_app_dir -- --include-ignored` 执行，只读检查目录，不启动应用。
- Store 激活在独立任务中监督，临时环境设置先落清理记录；恢复助手核验包、进程和线程身份，再恢复线程并反馈确认。超时或失败先停止本次进程并清理环境，清理失败阻止自动重试和原生恢复。`CODEX_HOME` 有显式设置时必须传递成功。`scripts/diagnose-windows-store-launch.ps1` 提供启动诊断。
- 集成失败只有带已确认清理的错误类型时才允许原生启动。恢复只处理 Codey 临时资产，不写用户配置；原生启动过滤 Codey 注入环境。其他安装目录占用单实例锁时提示用户退出，不停止其他客户端。
- Windows 最多尝试两次，仅暂时性启动错误或已确认包切换允许重试。权限、配置、身份和清理失败直接报错；进程查询失败不能视为已退出或已清理。
- Windows 每个登录会话只运行一个 Codey 桌面实例。重复打开不停止已有 Codex，只尝试切到已显示的窗口；窗口切不过去则提示后退出。
- Windows 停止 Codex 时只处理当前登录会话。安装包里跑在其他会话的系统服务不在停止范围内。读不到会话编号时仍纳入本次清理，避免把查询失败当成已经停止。Codex 自带的沙箱服务、沙箱安装程序和两个提权服务按可执行文件名排除，既不作为清理目标，也不用来扩展后代进程。
- 退出时清理其他 Codey 进程，会放过本次退出开始之后才出现的进程，以及仍持有桌面实例标记的进程，避免正在等待交接的新实例被清掉。
- Windows 发布 Codex 用户运行目录时，若系统拒绝替换正式目录，则改用同级旁路副本启动，下次仍复用已经校验通过的副本。
- Store 配套文件暂存于 Codey 私有目录，通过清单、大小及复制时哈希校验复用。诊断记录阶段、进程身份和退出码，并关联宿主与受控进程的生命周期；自动重启失败作为退出原因保留，主程序以失败状态退出。不记录令牌或完整配置。
- 宠物精简只调整全局状态中的 JSON 偏好，保留其他 JSON 值；主文件失败时尝试备份，仍失败则记录原因并继续启动。浮窗的创建、预热和节流由 Codex 管理。
- Codex 启动代理（配置字段 `codexLaunchProxy`，默认空；`launch_proxy.rs`、`launch_proxy_relay.rs`）由 `with_launch_proxy` 在启动 Codex 前解析。保存和启动解析都经 `config::validate_codex_launch_proxy` 校验：只接受 `http`、`https`、`socks5`、`socks5h`，只能含协议、地址、端口和认证信息（拒绝路径、查询、片段），SOCKS 地址必须带端口，SOCKS 用户名和密码解码后各不超过 255 字节，不接受未指定地址和链路本地地址。地址翻译成两份产物：Chromium 的 `--proxy-server`（`socks5h` 转写为 `socks5`），以及 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和小写同名环境变量（保留原协议前缀）；`NO_PROXY` 保留已有规则并合并 `127.0.0.1`、`localhost`、`::1`。无凭据的地址先对上游探活再启动 Codex。带凭据的地址由回环地址上的认证中继转发（端口由系统分配，同一原始地址复用同一中继）：Codex 的参数和环境里只有无凭据的 `http://127.0.0.1:<端口>`，凭据只在中继侧注入上游，`http`、`https` 上游加 `Proxy-Authorization`，SOCKS 上游走 RFC 1929 握手。探活或中继启动失败时，在启动 Codex 前报错，错误只含上游的主机和端口。该字段变化需要重启 Codex。
- 可兼容设置热更新；启动参数、角色集合、模型能力及上下文预算等变化需要重启。前端等待超时只停止查询，不取消后台重启，可重新查询状态。

退出时先确认 Codex 停止，再关闭监视任务、回收进程、恢复临时运行期产物。停止或恢复失败时保留已建立运行时供重试；启动尚未完成就无法终止进程的情况可能需要人工退出残留 Codex。

## 配置与数据安全

- Codey 配置单独保存于系统配置目录，保留三份有效滚动备份；`CODEX_HOME` 非空时优先使用。
- 用户配置（`~/.codex/config.toml`）和 `auth.json` 在启动、重启、退出、启动失败清理和旧租约恢复中只读：Codey 不写入、不迁移、不重写，也不做自动修复。只有用户在控制台的显式操作可以写 Codex 目录中用户拥有的文件，且写前备份。目前这类操作有：手动修复插件市场（写 `config.toml`）、Codex 配置检查与修复（写 `config.toml`）、MCP 与 Skill 的增删改和导入（写用户级与项目级 MCP 配置和 Skill 目录）、官方账号切换（写 `auth.json`）。本次运行需要的配置，包括渠道切换的 `model_provider` 与 `model`，一律通过运行期覆盖传给单次 Codex 进程。见 [ADR 0002](docs/adr/0002-user-config-is-read-only.md) 的 2026-10-27 收窄修订。
- Hook 定义与信任状态合成单条 `hooks={…}` 运行期覆盖，信任键使用 `/<session-flags>/config.toml:<事件>:<组索引>:<处理器索引>`，不再写入或备份用户 `hooks.json`。Codex 合并加载用户已有的 Hook 和信任项；旧版已写入的 Hook 通过原有租约恢复路径清理一次。应用与恢复都不改写用户的 provider、MCP、模型或未知字段。
- 官方账号通过原生登录探针及严格端点、认证检查识别。旧版 ChatGPT 登录态（缺少 `auth_mode` 但 `tokens` 中仍有有效令牌）视为可用。不依据模糊文本或第三方配置中的残留凭据判定已登录。
- 官方账号端点只认 `https://chatgpt.com/backend-api/codex` 这一形态；带端口、查询、片段或仿冒主机的地址不算官方端点。
- 模型同步和提示词优化共用一个凭据解析器，按 provider 的 `auth` 命令、`env_key` 环境变量、`experimental_bearer_token`、`auth.json` 的 `OPENAI_API_KEY` 的顺序取第一个可用值，最后才回退到 `api_key` 等兼容别名。`auth` 与 `env_key`、`experimental_bearer_token`、`requires_openai_auth` 同时配置时报错。`auth.json` 密钥只在 provider 设置了 `requires_openai_auth = true`（或为内置 `openai`）且 `auth.json` 处于 API 密钥模式（`auth_mode` 为 `apikey`，或缺省且没有 ChatGPT 令牌）时使用；ChatGPT 模式不会使用遗留密钥。`auth.command` 不经 shell，直接运行程序并传入 `args` 与 `cwd`；`timeout_ms` 缺省或为 0 时取 5000 ms，上限 60000 ms；标准输出最多 64 KiB，超时或超限只终止直接子进程。令牌只在内存中按 provider、命令、参数、工作目录缓存，`refresh_interval_ms` 缺省 300000，0 表示不主动过期。HTTP 401 会让缓存的命令令牌失效，且按代数比对，较旧请求的 401 不会清掉已刷新的令牌；请求已带自定义授权头时不清缓存。状态和控制台读取不执行命令。令牌不写日志、不返回前端、不落盘，命令错误不记录命令输出。
- Unix 私有配置、备份和日志限制当前用户访问。第三方密钥、通知凭据和带用户名密码的 Codex 启动代理地址仍以明文保存在私有配置及备份中；后端不会把已保存密钥返回前端，启动代理地址除外：`redacted_config` 不处理 `codexLaunchProxy`，`/settings/get` 把它原样返回控制台输入框，上游同样如此。官方账号库保存完整令牌，见下。
- 普通错误日志只保存脱敏失败信息，不保存提示词、正常响应或认证值。
- 官方账号库（`official_accounts.rs`）位于 Codey 配置目录的 `official-accounts/`，每个账号一个 JSON 文件，文件名是账号标识的 SHA-256，内容是完整的 `auth.json` 文档加套餐与邮箱摘要；文档必须含 `auth_mode`（`chatgpt`）、`tokens.account_id` 和 `tokens.access_token`。Unix 上文件 0600、目录 0700；Windows 写入前用 PowerShell 设置只授予当前用户的受保护 ACL，设置失败则拒绝写入。账号命令（`list_official_accounts`、`import_current_codex_login`、`import_official_account_credential`、`start_official_account_login`、`poll_official_account_login`、`cancel_official_account_login`、`set_default_official_account`、`remove_official_account`、`query_official_account_usage`、`store_official_account_usage`）的响应只含标识、邮箱、套餐、最近刷新时间、是否失效和是否当前账号，不含令牌；日志不记录令牌。浏览器登录用 PKCE 和上游使用的公开客户端，本机回调端口 1455，端口被占用时报告原因。账号额度用该账号自己的凭据查询，`authGeneration` 与请求代次让过时结果被拒绝，凭据变化后缓存失效。
- 切换官方账号（`set_default_official_account`，ADR 0002 收窄修订允许的显式操作）：Codex 运行时，控制台先弹出切换并重启的确认（`App.tsx` 的 `SWITCH_CONFIRMATIONS`，经 `channels.ts` 的 `confirmThroughDialog`），取消时不发送命令；Codex 未运行时不确认。命令先解析该账号渠道的模型：渠道默认模型优先，其次 Codey 全局默认模型，最后使用用户 Codex `config.toml` 顶层的 `model`；三者都为空时在改动任何文件前拒绝，提示先设置默认模型。之后命令在配置写锁和账号锁内依次执行：核对 Codex 凭据存储为文件模式（`config.toml` 的 `cli_auth_credentials_store` 缺省或为 `file`；`keyring`、`auto`、其他值或非字符串时禁用切换和导入当前登录，账号列表返回 `switchDisabledReason`）；把 Codex 刷新过的当前 `auth.json` 抄回账号库；确认用户配置的 `openai` provider 支持官方登录；把原 `auth.json` 备份到 Codey 配置目录的 `official-accounts/backups/<uuid>.json` 并读回比对；再读一次 `auth.json`，与备份时的内容不同就中止，提示重试（Codex 可能刚刷新过令牌）；原子写入目标账号的完整文档并读回校验；最后在同一事务内保存 Codey 设置：选中渠道 `official:<账号标识>`，回退模型按使用时解析，不写入渠道默认模型，`settingsRevision` 加一，并返回 `restartRequired`。任一步失败（含设置保存失败）都按备份恢复 `auth.json`（原先不存在则删除）并报错。命令不重启 Codex：切换前已确认时，前端在成功后直接执行既有的重启操作（`channels.ts` 的 `restart`，经 `restartAfterSwitchPending` 等操作锁释放后调用 `restartCodex`），不再二次询问；Codex 未运行时提示下次启动生效。每次切换留下一份含完整令牌的备份，不清理。
- 启动时（`lib.rs` 的 `sync_official_accounts_at_startup`）唯一允许的账号同步方向，是把 Codex 刷新后的 `auth.json` 抄回账号库，不写 `auth.json`。抄回规则：凭据存储不是文件模式时不抄回；当前登录解析不出稳定账号标识时跳过，不报错；账号库里没有对应账号时不新增；`auth.json` 的 `last_refresh` 早于库内同一账号的时间时，不用较旧的内容覆盖较新的账号（任一方时间缺失或无法解析按较新处理）。切换事务的抄回步骤用同一规则。
- MCP 与 Skill 管理由 `codey-codex-extensions` 包实现，后端经 `codex_extensions` 命令分发（`commands/extensions.rs`，同一时间最多 8 个请求、2 个连接测试）。MCP 读写用户级和项目级 TOML 并保留未知配置；连接测试只做协议握手和工具清单，需要前端确认并带配置版本号。Skill 分用户、项目、系统三个范围，目录或 ZIP 导入前预览并核对摘要，可完整导出和删除，系统范围只读。写入沿用上游的版本检查、文件锁、原子替换、复读校验和逆序回滚。本分叉在每次写入或删除前把原内容备份到 Codey 配置目录的 `codex-extensions/backups/<uuid>/`，带 `manifest.json` 记录来源与备份的对应，目录与文件仅当前用户可访问；备份失败则不写入，复读校验失败时把备份位置返回前端；Skill 的备份以 Skill 根目录为界。MCP 保存后经页面桥接通知 Codex 重读配置，25 秒内未确认返回 `reload-failed`，配置已保存，需重启 Codex。生命周期测试证明启动、重启、退出与租约恢复不改动用户配置、项目配置和 Skill 文件。
- Codex 配置检查与修复（`codex_config/repair.rs`）：控制台只有「修复」一个入口（`repair_codex_config`，先弹确认），无可修复内容时返回检查结果；`check_codex_config` 只读，在命令白名单中，控制台没有按钮。可修复的是 Codex 配置目录或 `config.toml` 缺失（补建），以及指向 Codey 目录的旧版模型目录项：`model_catalog_json` 的值只在精确等于旧版相对位置、旧版绝对路径或 Codey 派生目录时，按字节范围删除，其余字节和注释保持不变。配置目录含符号链接、TOML 无法解析、provider 引用缺失等只报告位置，不改写。修复在运行时锁内进行：先把原文件备份到 Codey 配置目录的 `config-repair-backups/<uuid>/config.toml`（Windows 上限制为当前用户的 ACL）并读回比对，写入前再读一次确认文件未被他人修改，原子写入后读回校验。启动、重启、退出和租约恢复不调用修复。确认框是通用说明，发现的问题在修复后的结果里列出，与上游 `d2e6d5aa` 相同。

## provider 与模型

provider、模型和上游格式分别识别。控制台展示当前 Codex provider 和渠道列表，不提供新增、编辑或删除 provider 的入口；模型清单按 provider id 与规范化地址指纹归属。换模板不会复用旧地址的清单。

- 渠道（`channels.rs`）是用户配置 `[model_providers.*]` 中的一个 provider（id 为 `provider:<标识>`），或官方账号（id 为 `official:<账号标识>`，账号标识是账号 id 的 SHA-256，provider 固定为 `openai`）。账号库里每个账号各是一个官方渠道；账号库为空时退回当前官方登录，同一格式；没有可用登录时是不可用的 `official:unavailable`，账号库有账号后该占位被去掉。官方渠道不可用的原因有：登录文件无法读取或不是有效 JSON、登录不可用、缺少稳定账号标识、`openai` provider 配置不支持官方登录、凭据存储不是文件模式。当前渠道 `selectedChannelId` 和各渠道默认模型 `defaultModelsByChannel` 保存在 Codey 配置里，不写用户配置。写命令 `select_channel`、`set_channel_default_model` 带 `expectedRevision`，与 `settingsRevision` 不符时报「Codey 设置已被其他操作更新，请刷新后重试」。渠道列表增加 `modelOptions`、`switchModel` 和 `switchModelSource`：官方候选来自本地官方模型目录，不依赖当前登录身份，每次构建列表只读取一次；提供商候选来自按提供商标识与地址指纹归属的已有清单，没有清单时返回空数组，不发起网络请求。切换模型和来源按渠道默认模型、Codey 全局默认模型、用户 Codex `config.toml` 顶层 `model` 的顺序解析，来源分别为 `channel`、`global`、`codex-config`；三者都为空时两字段均为 `null`。`select_channel` 拒绝不可用的渠道和三个模型来源都为空的渠道，响应的 `restartRequired` 由新设置与运行中的渠道和模型比较得出；账号面板切换使用同一模型解析规则。
- 当前 provider 只有一个解析入口 `channels::resolve`，当前 provider 快照、模型清单同步、提示词优化、子代理角色模型和会话导入标记的 provider 都经它取值，并保留 `profile` 分支。没有选择渠道时，结果和运行期覆盖列表与引入渠道前一致；所选渠道在用户配置中已不存在或不可用时，回退到用户配置的默认 provider，渠道列表的 `notice` 提示「所选渠道已不可用，已回退到用户配置的默认 provider。」。
- 切换在下次启动时生效：已选且可用的渠道向运行期覆盖列表加入 `model_provider=<provider id>` 与 `model=<解析后的切换模型>`（`channels::runtime_overrides`），没选渠道时不加；官方渠道同样两项都加，渠道选择、启动覆盖和账号面板切换共用三级回退解析，仅在三个模型来源都为空时报错，回退值不保存为渠道默认模型。CLI 包装器重写 `app-server` 参数时丢弃桌面端传入的 `model_provider` 与 `model`（`-c` 与 `--config` 两种写法），换成覆盖列表里的值。侧栏的 `thread/list` 筛选参数没有改动。选中 provider 渠道时，官方登录文件损坏只让官方渠道不可用。控制台渠道面板在 `src/ChannelSection.tsx`：渠道条目带 `switchModel` 与 `switchModelSource`（后端按渠道默认模型、全局默认模型、Codex 配置顶层 `model` 解析），`switchModel` 有值时「切换到此渠道」直接切换，为空时才先填写再「保存并切换」；候选模型取条目的 `modelOptions`（当前渠道另并入当前 provider 的清单），清单为空时渠道面板的 `ManualModelCombobox` 不挂载下拉层，只在输入框下方给出提示。编辑行关闭后焦点回到打开它的按钮。选择渠道（含「保存并切换」与「跟随用户配置」）和切换官方账号在 Codex 运行时先确认再发命令，确认在保存默认模型之前；确认后成功且 `restartRequired` 时直接重启。单独保存默认模型不确认、不重启，只提示重启后生效。
- 派生模型目录记录所用 Codex 运行程序的来源（`codey_runtime_source`：路径、大小、修改时间），所有读取方按配置的安装路径校验，来源不符时拒绝并附原因，回退为只读 `models_cache.json`；旧版没有来源记录的目录在首次刷新时重建并记录。自动定位 Codex 安装时跳过 Codey 数据目录和缺失的安装，不隐藏不完整或有歧义的安装。删除预算覆盖后保留必需模型，覆盖层保留上下文预算，页面显示的预算按已生效配置计算。第三方模型不继承官方条目的压缩兼容标识，官方条目不变。
- 无法确认 provider、模型归属或兼容能力时应停止请求并给出错误，不猜测、不跨 provider 自动切换，也不重放可能已经送达的请求。
- 用户配置解析失败则拒绝启动。不把当前 Codex provider 自动写入 Codey 自己的配置档案。历史 `codey_router` 会话由控制台显式迁移，改写会话库与 rollout，不碰用户配置。
- 模型目录优先复用可信本机元数据，第三方能力不从无关模型继承。空目录不传给 Codex；用户自己启用 `model_catalog_json` 时，Codey 让位并另存只读派生副本。生成的模型目录写在 Codey 数据目录，不写入 CODEX_HOME。
- 官方模型以本机 Codex 可见模型为基础，设置保存显式排除项，新增模型默认保留。旧选择记录只在旧版可选模型范围内转换为排除项。页面合并原生模型结果与 Codey 增强项，并保留原生描述符供重新勾选时恢复；未知原生模型的能力和可见性保持原样。显式用户模型目录仍拥有模型集合的优先权。
- 第三方模型 id 命中官方模板时（带不带 provider 前缀都算）继承该模板的可信声明，包括显式的禁用标记；命中不到官方模板的 id 是叶子模型，不继承多代理能力。官方目录不为缺字段的模型编造多代理元数据。
- GPT-6.1 Sol 的第三方思考强度按精确模型标识补齐 `low`、`medium`、`high`、`xhigh`、`max`、`ultra`，覆盖模板缺失或停在四档的情况。页面能力和生成目录共用该声明；此兼容声明不扩展未知模型，也不从其他模型继承上下文或多代理能力。其他第三方模型的 `ultra` 名单（`third_party_template_supports_ultra`）是 `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`，Luna 在模板停在 `max` 时也转发 `ultra`；名单外模型不声明 `ultra`。选择器侧见页面补丁清单中的第三方 Ultra 思考。
- `modelOrderModeByProvider` 按 provider 指纹记录 `official` 或 `manual`；最终顺序沿用 `selectedModelsByProvider`。旧配置没有模式时默认跟随官方排序；启动和设置初始化在迁移 provider 指纹后应用并持久化顺序，无需联网同步或打开同步弹窗。手动模式保留已选模型顺序，新发现候选追加末尾；跟随官方模式在同步时按可用官方目录的 `priority` 稳定排序，缺少优先级的已知模型排在有优先级项目之后，未知模型保留同步顺序。没有官方顺序时不阻断操作。
- 模型排序保存沿用现有交付流程；卡片保存不提交上下文预算或自动审核设置。卡片和同步弹窗通过拖动模型本身调整完整清单，方向键也可操作；拖动只修改草稿，保存后生效，取消恢复原顺序。第三方生成目录同步更新数组顺序及优先级，页面按同一清单更新；默认模型标记不参与排序。显式用户模型目录仍按既有所有权规则保留其原始顺序。
- 排序交互检查使用 `tests/model-order-browser.html` 与 `tests/model-order-browser.mjs`，通过 Vite 的本机 `1432` 端口运行；检查脚本使用环境中已有的 Playwright，也可通过 `CODEY_PLAYWRIGHT_MODULE` 指定其入口，不新增产品依赖。Rust 模型保存与目录测试、页面脚本测试分别验证持久化及交付；浏览器检查不代替已安装 Windows 客户端验收。
- 无法识别容量的第三方模型使用 32,768 token 保守预算；列入 1M 上下文白名单的模型改用 1,000,000 token。原始声明另存在 `codey_context_base`，撤销覆盖时不残留旧阈值。
- 模型增删可更新页面列表；能力或预算变化仍按实际运行配置提示重启。热更新串行获取运行操作锁和目录交付锁，锁内读取最新配置，缓存写入校验及页面目标稳定后才更新运行快照。失败恢复上一份已交付目录；已有查询缓存未更新不能按延后交付报告成功。
- 网页搜索、自动审核和远程压缩由当前 Codex provider 与模型目录共同决定。
- Fast 选项通过页面原生控件兼容显示和保存；选项可见不代表上游承诺加速。
- 服务档位同时覆盖原生选择控件和发送前的独立读取。页面兼容入口经现有桥接在原生模块作用域重新绑定读取和选择函数。函数调用断点的条件始终返回假，安装结束后移除断点、远程对象并关闭连接；不改安装包、认证或用户配置。
- 服务档位状态刷新也复核已失败的登记，通过模块导出的 `codeyReadServiceTier` 函数及其 `__codeyServiceTier === 1` 标记确认安装后恢复生效状态并清除旧错误；缺少函数或标记时保留原始安装错误。复核不调用读取函数、不重新绑定模块。每次安装在 `codey.log` 中记录 `service_tier_renderer` 事件，字段包括 `targetId`、`phase`（`prepare`、`bind`、`ready`、`failed`）、`reachedPhase`、`elapsedMs` 和 `error`；连接失败、安装超时和清理失败也记录失败事件。轮询预算保持不变，整体注入耗时不能证明作用域的具体就绪时刻。
- 页面兼容入口从模块预加载链接和性能资源记录定位模块，只接受唯一识别的原生形态。显式默认档位保持默认，快速档位仍由当前模型的原生档位列表校验；未知形态保留原逻辑，并在注入状态及错误日志报告失败；失败信息只保留页面异常或调试协议错误的首行，用于区分源码形态不兼容和调试连接失败。桥接注册新文档脚本前启用 `Page` 调试域，每次页面重载重新安装，桥接重连重试，已生效的模块不重复包装。共用桥接的请求编号包含页面独有标识，防止旧页面结果交给新页面回调。连接复用运行库既有的回环地址回退及超时预算。
- 服务档位回归使用 `tests/fixtures/codex-service-tier.js` 中的原生函数，检查快速、默认、配置继承、模型切换和已挂载组件的访问状态更新。档位访问辅助函数放在 `tests/fixtures/codex-service-tier-shared.js`，浏览器检查按真实资源的方式从另一个模块导入它们。`tests/fixtures/codex-service-tier-legacy.js` 是旧版布尔权限形态：页面兼容入口用它检查不兼容形态，启动资源补丁测试仍用它作为正向夹具。`node tests/service-tier-browser.mjs` 在隔离 Chromium 中调用生产 Rust 桥接及安装入口，检查重连、重载和不兼容形态恢复；可用 `CODEY_PLAYWRIGHT_MODULE` 与 `CODEY_CHROMIUM_EXECUTABLE` 指定已有浏览器工具。浏览器检查不发送模型消息，不能代替安装后的请求链与上游档位验收。
- 模型显示名里的 `GPT-` 前缀由页面注入保留。Codex 在 Statsig 开关 `3849065407` 为假时，会从显示名去掉开头的 `GPT-`。注入只把这个开关的读取结果改为真，并在这次读取时传入 `disableExposureLog`。其他开关、模型 id 和模型请求保持原样。这个开关编号跟当前官方前端资源绑定，不是稳定接口。复查时看当前页面实际加载的资源：在 `app-primary-*.js` 里确认名称组件读取的开关编号，在 `app-initial-*.js` 里确认格式化函数仍是在删除选项为真时执行 `replace(/^GPT-/iu, "")`。两边对上以后，再改注入脚本里的编号。资源哈希和压缩后的函数名只对那一版有效。不用 Codey、从官方快捷方式直接启动 Codex 时，这段注入不会运行。已经保存的用户脚本如果发现 `window.__codeyKeepGptPrefix` 会直接返回；不要为了这项显示去清空用户脚本。
- 会话标题由 Codex 原生逻辑生成。

## 上下文与远程压缩

历史、Token 记账、压缩触发和结果提交由 Codex 管理；Codey 配置模型目录并声明预算，不维护第二份可写会话历史，也不在进程内转发压缩请求。

- 远程压缩是否可用遵循 provider 显式的 `capabilities.remote_compaction`：`v2` 为真，`unsupported` 为假，其他取值为假并输出诊断。未声明时，官方账号鉴权或内置 provider id `openai` 为真，其余为假，不依据显示名推断。`capabilities.external_web_access` 作为可选布尔值读取，并随 provider 快照展示。
- 官方和第三方模型均可声明窗口、自动压缩阈值和输出预留。预算按显式配置、旧 1M 声明、精确官方元数据、未知模型保守值的顺序解析；未知模型使用 32768 Token、95% 有效比例。
- 输出预留保守投影到有效窗口，自动阈值不超过窗口的 90% 和扣除预留后的容量；这不限制实际输出长度，也不能扩大服务端容量。
- 预算变化要求重启。只校验已启用模型；用户目录缺少或重复预算模型会产生类型化错误，保存前校验不写目录，启动副本按内容哈希写入 Codey 数据目录。恢复默认从原目录生成，不改写用户指令与未知元数据。Windows 和 macOS 原生确认后才清除 Codey 的全部自定义预算并重试一次；Linux 没有原生确认入口，保留预算并明确报错。配置使用既有备份链。官方模型入口展示预算，空窗口恢复默认。

## 控制台与页面增强

- 页面资源由浏览器级补丁服务（`renderer_asset_patch.rs`）改写。启动器在启动 Codex 前调用 `start_service`，服务以 25 毫秒间隔重连浏览器调试端点（总预算 60 秒），用一条浏览器级 CDP 连接覆盖全部页面：`Target.setAutoAttach` 以 `waitForDebuggerOnStart` 挂住之后创建的目标，再显式挂上连接前已存在的页面（主窗口常在端点就绪前已创建）。注入路径调用 `ensure_service`，同一端口的服务仍在运行时不做事；看门狗重注入或 Codex 自行重启后由它补拉起服务。服务独立于桥接，失败不阻断注入。
- 每个页面先启用 `Fetch`（只匹配补丁名单内的 `app://*/assets/<前缀>*` 脚本，入口文档和其余资源不经过 Codey），再放行暂停的页面，因此在首次导航前挂上时能覆盖首个文档。暂停目标一律放行：非页面目标、已登记的重复目标和启用 `Fetch` 失败的目标都立即恢复并分离，不会停在暂停状态。
- 拦截先在请求阶段按「补丁脚本摘要 + 资源文件名」查磁盘缓存（Codey 数据目录的 `renderer-patch-cache`，上限 96 MiB，只缓存文件名带内容哈希的资源），命中则直接交付。未命中才在响应阶段暂停，取正文后在请求它的页面里执行 `renderer_asset_patch.js` 的纯文本改写入口（最多同时处理 2 份），重新交付并删除失效的长度、编码及摘要响应头。入口缺失时就地安装；单项锚点失配只跳过该项，状态码非 2xx、求值失败或交付失败时放行原资源，失败结果不进缓存。页面里的补丁失败记录随求值结果带回，由 Rust 写入错误日志，不依赖 CDP binding。没有事后改写已加载脚本的通道，资源只能在响应阶段改写。
- 目标预取（`target_prefetch.rs`）与 Codex 启动并行，每 100 毫秒枚举一次 `/json`，主页面一出现就交给注入，只省掉注入重试循环里第一次枚举的等待，不暂停页面。交接期限取 8 秒与「剩余注入预算减去 3.1 秒校验预留」中较小者；到期仍无目标时取消预取，改走普通页面发现，已找到的目标仍交给注入。
- 主窗口就绪由装桥会话顺带执行的同步探针确认：读取页面地址、桥接、浮层控制器和模型补丁入口。目标是辅助窗口、或桥接与浮层缺失，需整轮重装；页面仍是空白文档，只保留桥接继续确认。探针摘要写入注入摘要；辅助窗口不算注入成功。
- 挂上时页面已有 `app://` 地址、且不是在暂停状态收到的，属于晚挂载：不重载，只记 `renderer_asset_patch.late_attach`，页面统计里 `attachedBeforeLoad` 为假且 `patched` 为 0，该窗口本次运行的主 bundle 没有补丁，下次启动恢复。桥接在资源覆盖之外独立安装，并保留启用 `Page` 域的新文档脚本注册，后续重载仍会重新安装页面增强及服务档位兼容脚本。
- 诊断：`target_prefetch.summary` 记录预取结果、耗时和是否到达调试端点；`cdp.injection_retry_summary` 带预取与就绪探针结果；`cdp.renderer_asset_patch_summary` 记录该页面的补丁统计（`attachedBeforeLoad`、`intercepted`、`patched`、`cacheHits`、`skipped`）；`renderer_asset_patch.*` 记录服务与页面事件（`service_unavailable`、`service_failed`、`auto_attach_failed`、`fetch_enable_failed`、`page_attached`、`late_attach`、`rewrite`、`request_skipped`、`cache_write_failed`）。回归检查：`renderer_asset_patch.rs` 内的 Rust 单元测试用模拟 CDP 服务端验证挂载、恢复、分离和降级决定；`tests/renderer-asset-patch.test.mjs` 与 `tests/codex-renderer-patch.test.mjs` 校验改写文本。这些检查不代替 Windows 实机冷启动验收。
- CDP 负责桥接、注入及健康检查；就绪校验重试复用仍有效的桥接，安装失败或会话失效时重新发现页面并重建。常驻桥接的消息泵一结束，看门狗立即重建，不等下一轮巡检；页面答复桥接失效后 5 秒复核一次，不再等满 30 秒。页面侧健康检查把 `bridge_reinstalled` 结束的调用和主线程卡顿造成的超时视为无结论，不计入失败；判定中断后每 5 秒复查，点击中断提示前先当场复查一次。配置面板按需加载的请求限时 15 秒，遇到 `bridge_reinstalled` 重发一次，后端超时但页面已生成浮层时照常打开。重装前注销该目标上一批持久文档脚本，并将仍等待的页面调用置为失败，错误码为 `bridge_reinstalled`。后台任务仍在运行时，页面忙或超时保持保守状态；看门狗连续三轮重装都未能枚举页面目标时，把重试间隔从 30 秒放宽到 120 秒，并记录 `bridge.recovery_backoff`；此后相同的端点故障不再重复写错误日志。曾经成功枚举、只是没有可注入页面或桥接失败的轮次不计入。健康检查成功或重装成功后，间隔回到 30 秒，失联计数清零，注入状态恢复为当前桥接的状态。用户脚本在同一文档成功执行后不因恢复重复运行。整轮注入期限到达时，诊断记录所在阶段、总耗时、本轮耗时和剩余时间；浮层校验受整轮期限约束，临近期限时直接释放失效桥接，不等待关闭握手。
- 前端使用 HeroUI、React Aria 和 Tailwind；内嵌界面通过 Shadow DOM 隔离样式，统一管理主题、焦点、弹层和提示挂载位置。HeroUI 样式按实际渲染的组件逐个导入，新增组件时需同步补充样式入口。
- 控制台列出渠道并支持切换，不提供新增、编辑或删除 provider 的入口，也不提供请求日志页或检查更新入口。侧栏是左侧分组导航（`src/SettingsLayout.tsx`）：「核心配置」组含基础功能、provider 与模型、提示词优化、子代理优化，「扩展生态」组含 MCP 管理、Skill 管理。页面首次访问时挂载，之后隐藏而不卸载，保留草稿、展开状态和异步结果，隐藏页面不增加轮询。新增页面时追加页面条目，并在 App 的 `sections` 提供内容。
- 标题栏的「系统设置与偏好」对话框（`src/SystemSettingsDialog.tsx`）的版本与目录部分只读，不写配置。每次打开先调用 `refreshStatus` 重新读取运行状态：读取中显示「读取中…」，失败显示原因，Codex 没有版本时显示「未运行 / 未检测到」。目录路径经 `navigator.clipboard` 复制，复制结果显示 3 秒。运行面板不再显示 Codex 版本与目录。没有设备号一行，更新策略行未接入，不放占位。「修复 Codex 配置」行经 App 的确认框，确认后才向后端发 `repair_codex_config`。回归检查 `tests/system-settings-dialog.test.mjs`，不代替 Windows 实机验收。
- 注入的设置入口按钮显示 Codey 应用图标：`public/renderer-inject.js` 里的占位符 `__CODEY_APP_ICON_DATA_URL__` 由 `scripts/build-overlay.mjs` 以 `backend/icons/favicon.png` 内联为数据地址，构建后不应残留占位符。
- 配置保存后的后台应用（`commands/config_apply.rs`）：保存在配置写锁内调用 `enqueue`，`revision` 递增并把状态置为 `pending`；后台任务 `run` 在运行操作锁内读取最新配置，依次同步通知监听、微信 ClawBot 服务、Crashpad 保护、Trace 保护、模型热更新，需要时再做子代理角色热更新，最后给出 `applied`、`restart_required`、`failed`（带原因）或 `saved`（运行时未启动或正在退出）。连续保存时较旧的任务只能补做，只有 `revision` 与最新一致才发布状态。状态经 `runtime_status` 的 `configApply` 返回；启动完成后 `confirm_launch` 在配置未变时把非 `applied` 的状态置为 `applied`。前端 `src/configApply.ts` 的 `reconcileConfigApply` 忽略版本更低、或同版本已终结的结果；横幅只在 `pending`、`failed` 或状态查询失败时显示，成功后隐藏并提示最终结果。应用只写 Codey 自己的配置和运行文件，不写用户配置。
- 模型选择器使用分组、搜索及虚拟列表，手动输入保留自定义模型；列表更新通过 QueryClient 发布，避免直接修改共享查询对象。
- 子代理详情从原生会话控制器异步读取实际模型及思考强度；切换后丢弃旧响应，缺失时显示待获取，不使用父任务或角色默认值代替。
- 页面补丁按功能锚点和语义定位，匹配失败保留原代码及失败状态。页面侧 `isCodexRendererAssetUrl` 与 Rust 侧 `PATCHABLE_ASSET_PREFIXES`（`renderer_asset_patch.rs`）维护同一份资源名单，后者同时生成 `Fetch` 的拦截模式；关闭宠物时再追加 `PET_ASSET_PREFIXES` 中的设置页脚本。当前包括：`app-initial` 中的管理器登记、完成状态同步（锚定 `getHasInProgressLocalConversation`，两次核对服务端状态并排除并发修订、未确认提交和跟随窗口）、请求跟踪；`app-shared` 中的交互采样与心跳精简；`initialize-app-host-services` 中的默认中文首次渲染；模型选择器资源中的第三方 Ultra 思考（锚点是同时含 `includeUltraReasoningEffort:`、`isCustomModelProvider:`、`modelCatalogPath:` 和开关 `1186680773` 的函数，把 `includeUltraReasoningEffort && get(…, "1186680773")` 改为 `includeUltraReasoningEffort && (isCustomModelProvider || get(…, "1186680773"))`，保留调用方和用户的思考强度设置；失配只跳过该项并记录；不改写 Ultrafast）。页面补丁不支持实时编辑，与上游一致。Codex 已移除 `get-setting`/`set-setting` 时，中文脚本识别接口缺失后停止持久语言同步，只保留首次渲染补丁和 navigator、Statsig 补偿，不写用户配置。`performanceStatus` / `performanceDetail` 表达启动健康状态。

## 会话、插件与提示词

- 侧栏增强同时适配原生行内归档和 Work 操作菜单布局。Work 行从已提交的 React 操作组件读取 `archive` 回调，点击时重新读取，保留原生运行中确认逻辑；不直接调用底层归档接口。新增行内归档后复用导出、删除入口，原生置顶节点保持不动。归档按钮直接位于原生操作栏（`flex`/`grid`、绝对定位或含多个按钮）时，导出、删除按钮插入该操作栏内，继承其悬停显隐；只有旧版的单按钮提示包装层才插在包装层旁，不把外层 `contents` 容器改成布局盒。菜单按钮在普通悬停时收起，键盘聚焦或菜单打开时恢复显示，右键菜单保留。原生动作缺失、忙碌、禁用或恢复行内归档时撤销适配，不使用旧回调。`tests/session-actions-browser.mjs` 以隔离 React 页面验证布局、键盘、确认、行复用与模式切换；真实安装效果另行验收。
- 会话管理能力发现依次尝试：资源补丁在原生管理器读取会话时登记的本地实例（仅轮次删除使用，已销毁实例不可用）；React 作用域中已挂载且唯一的本地管理器，只读取已有的 `local` 信号绑定，不初始化未使用的信号，也不发送探测请求；原生本地注册表与旧 RPC 入口。资源未导出注册类时，从资源源码中注册类 `getForHostId` 读取的唯一状态键定位其导出名（或导入来源），再通过 React 作用域按该键取得本地管理器；不对其他导出值调用作用域读取。侧栏删除、轮次删除、列表刷新等调用仍分别校验所需方法。侧栏整会话删除必须等待原生 `discardConversationFromCache` 成功，再执行持久化删除；接口不可用、释放失败及超时分别报告，均不会跳过释放保护。
- 会话导入、导出和删除轮次先校验大小、并发变化和路径；无法稳定确认目标时拒绝删除。轮次删除只选择可见会话，按所选轮次在 Codex 显示顺序中的位置分两条路径，无法确定某轮位置时按中间轮次处理。末尾轮次（所选范围延伸到会话结尾）走 Codex 原生撤回：分页会话在 app-server 声明 `threadRevert` 能力时调用 `thread/revert`，非分页会话调用旧的 `thread/rollback`，页面状态由原生 applier 更新，不改写文件、不重启；分页会话的末尾历史未完整加载时拒绝。中间轮次先弹确认，说明删除无法撤销且 Codex 将重启；此窗口内任何任务运行时拒绝；通过后由后端 `/session/delete-messages`（带 `restartCodex`）先写持久墓碑，再原地改写 rollout（先写私有恢复记录，加锁复核文件内容与身份未变后覆盖；中断后下次删除或启动重放按记录还原，保留已完成的追加），仅在全部轮次删除成功且没有未清理的数据库时才安排重启，启动期维护在新进程启动前重放墓碑；失败或部分删除时页面与流状态保持不变，也不重启。重放遇到无法识别结构的库且会话记录文件已找不到时，按现存行查证被删轮次和会话引用，不按原始字节扫描（空闲页里的已删数据不算引用）；线程历史库按 `thread_id` 和 `turn_id` 查询，带 `threads(id)` 表的库只以该表判断会话是否存活。确认已无处可落才清理墓碑；超大、无法读取或无法识别的库按仍被引用处理。会话目录扫描不跟随目录链接。之所以不能先卸载会话再改写：app-server 在取消订阅后仍保持线程已加载，直到 30 分钟无订阅者或活动，打开会话会调用 `thread/resume`，既没有强制卸载手段，也没有中间轮次删除方法，已加载线程可能回写旧历史，因此用重启加墓碑重放保证一致。删除后清空该会话在数据库里的历史投影，由 Codex 从 rollout 重建；运行任务、跟随窗口和不完整接口拒绝删除。数据库锁等待 5 秒，重试合并已删除标识，部分成功计数不会丢失；未知索引不报告完整成功。页面能力分项探测与退避，旧安装卸载后不发布迟到接口；侧栏整会话删除仍保留本地活跃会话保护。会话删除不保留用户可恢复的备份。
- 会话索引及元数据读取已有 SQLite 和 rollout；启动期写入只在 Codex 停止后执行，且不改写历史会话的 provider。
- 页面插件兼容替换 `electronBridge.sendMessageFromView` 后核对实际引用；Codex 冻结桥接时替换无效，注入状态报告未生效并停止重试，请求拦截路径不受影响。当前官方插件列表经原生管理器发送 `plugin/list`，不经过该桥接，本地插件尚未并入这条路径。
- 插件市场修复使用随包快照及可回滚替换，读取状态不触发修改；桌面操作插件仅由 `prepare_computer_use` 显式准备，资源位于 Codey 数据目录的 `marketplaces/codey-local`。运行期通过既有 `-c` 覆盖注册 `codey-local`；准备不写用户配置、不安装或启用插件，不另注册重复 MCP 服务。新注册需重启 Codex，安装、更新和启停由 Codex 插件页管理。用户自定义同名来源会明确报错并保留。读取状态不写资源；损坏清单、载荷或符号链接不会被报告为就绪。禁用插件仍报告已安装，启用状态单列。
- 提示词优化可走官方账号、当前 provider 或独立配置，后端校验地址、认证和模型。成功响应只保留最终提示词正文，丢弃推理过程；日志不保存提示词正文或凭据。

## 子代理与 FastCtx

- 增强在原生 macOS、Windows 上生成五种 Codey 角色和内部默认角色，复用 Codex agents 工具及生命周期 Hook；角色选择提示按用途推荐，不替代权限检查，也不是强制分工。
- Hook 通过内联运行期覆盖提供，角色副本和策略保存在 Codey 自有运行资产中。CLI 包装器只为原生应用服务器传递覆盖，并过滤旧启动文件中的 WSL 专用条目。主进程补丁移除后，WSL 托管的应用服务器没有接收 Codey 运行期 Hook 的入口，因此不会收到这些 Hook。只读角色最多并行三个，出现写入角色时最多两个，由根代理在所有尝试结束后验收。
- 模型和思考强度按当前 Codex provider 的可用模型校验。不可用的角色模型会明确标出待重选，不会悄悄替换。
- 门禁结合任务绑定、能力证明和账本限制工具，策略缺失或身份不明时保守拒绝。仅完整无筛选列表可全量核对状态，等待超时不视为任务结束。
- 正常任务不按运行时长或不变状态回收。初始化异常、状态损坏及明确的状态工具未注册错误仍走对应恢复路径；状态工具故障恢复等待 30 秒且禁止回收仍有工具在执行的子代理。失联不代表成功。
- 历史规则只按已知 Codey 自有文本迁移；保留保守派发策略，调用入口按客户端实际声明适配。
- 只读 SQL 使用保守词法检查，仍须数据库只读账号；Hook 和角色名不构成操作系统沙箱。
- 视觉角色获得对应图像及界面工具能力，协议回退保留图像块。任务载荷缺失或解密失败只触发一次任务重述，不尝试本地解密。
- 内置 FastCtx 提供文件读取、搜索、发现和批量替换；已有服务不重复注册，使用进程覆盖加载，不写入用户配置。

## 账号额度与对话用量

- 侧栏账号额度只认 `auth.json` 里的 ChatGPT 登录和 `showAccountUsageInHeader`，不读取 Codey 配置里的 profiles。开关文案是「额度显示」，语义是控制侧栏底部额度块。页面每 60 秒请求 `/account/usage`，单次超时 8 秒。块挂在 Codex 侧栏贴底 footer 里，插在该容器最后一个子元素之前。
- 套餐标签由 `accountUsagePlanLabel` 映射：`prolite`、`pro`、`promax` 显示 Pro 100、Pro 200、Pro 500，`pro100` 等紧凑写法按数字，`5x`、`pro5x` 显示 Pro 5x，`pro20x` 显示 Pro 20x，另有 Plus、Free，未知值原样显示。标签带 `data-pro-tier`（100、200、500）属性，三档分别用银、金、紫渐变。回归检查 `tests/account-usage-sidebar.test.mjs`。
- `/account/usage` 由后端解析后，经 CDP bridge 的 `Runtime.evaluate` 对象字面量交给页面，不经过页面 `JSON.parse`。快照是 camelCase 的 `primary` / `secondary` / `credits`，没有 `rateLimits` 这类解锁标记。页面同时接受 `used_percent` 与 `usedPercent`。刷新失败或快照标为 stale 时，只有额度解锁没有改写解析结果才回退 Codex `account/rateLimits/read`；解锁生效时保留后端数字。
- `quotaUnlockEnabled` 缺省为 true，旧配置没有该字段时也是打开。为 true 时 `quota-unlock.js` 放进 document-start 注入包，为 false 时不注入。脚本在替换 `JSON.parse` 之前把原函数留在 `window.__codeyNativeJsonParse`。页面 `localStorage` 键 `codeyQuotaUnlock=off` 仍可停用漂白。这个开关在启动时决定是否注入，所以保存后需要重启 Codex。
- 输入框下方的统计条不展示账号窗口、套餐或 Credits。对话用量来自两路：后端 `/session/stats` 的会话记录统计，和 Codex 的 `thread/tokenUsage/updated` 通知对象；通知对象不含解锁标记键，也不经过被替换的 `JSON.parse`。统计条由 `public/conversation-stats-inject.js` 注入，挂在输入框所在列容器的末尾，探针为 `window.__codeyConversationStats`；详情卡片是独立挂在文档上的浮层，避免输入栏的 `transform` 或 `overflow` 影响定位。
- 有效的 7 天快照可在刷新失败时继续使用，并标明统计截止时间保持不变。成功缓存随账号变化失效。
- 统计条优先通过函数类型的管理器 RPC `subscribe` 订阅 `thread/tokenUsage/updated`，兼容旧管理器与输入栏的 `requestClient` 通知回调。RPC 订阅请求和返回的订阅句柄都通过 `Symbol.dispose` 释放，连接断开后重新订阅。注入状态只在订阅建立后报告生效；未取得会话管理器或没有通知入口时报告失败并附带原因；已订阅但当前对话暂无用量时，用量相关项显示「—」，属于正常状态。
- 进入或重新进入对话时，先订阅，再读取管理器保存的 `latestTokenUsageInfo`；RPC 属性读取只传回用量，不传回聊天正文。历史读取结果不能覆盖读取期间收到的新通知，切换任务后不能展示前一个任务的结果。按当前输入栏的 `conversation id` 过滤；未确定任务或没有已保存用量时，用量相关项显示「—」。费用只在实际用量中带了对应字段时显示，不本地编造单价。
- 对话缓存剩余从该对话会话记录里最后一条带用量的 `token_count` 的时间戳起算，取自 `/session/stats` 快照里的 `lastModelRequest`（页面空闲时每 3 秒轮询一次，本轮进行中每 1.1 秒）。后端先查 `threads.rollout_path`，查不到再按文件名找 `sessions/`、`archived_sessions/`，路径按会话缓存。不要看文件修改时间或目录项大小：Codex 追加写入期间它们会滞后。页面在两种情况下采用返回的时间：通知里 `last` 的输入、缓存读取、输出三个数字与 `lastTokenUsage` 一致；或记录里的 `threadTotalTokens` 已大于通知里的累计数（其他窗口又发过请求）。累计数会重置，所以只用来判断「记录已领先」，不用来判断「相同」。每收到一次 `thread/tokenUsage/updated`（实时通知、进入对话时的重放、历史读取都算），页面立即重读并改为每 500 ms 重读，对上为止，最多 6 次。`stats` 为空表示本机没有该对话的记录（`no-rollout`），立即显示「未知」不重试；`no-usage`、数字对不上（`mismatch`）、桥接失败（`failed`，刷新后桥接可能尚未就绪）在重试用尽后显示「未知」。原因记在 `snapshot().cacheAnchor`。不要回退到通知到达时刻，也不要用输入框回车、发送按钮点击等页面信号判断「发了一轮」：重放和新一轮只能靠记录时间区分，其他窗口发送的对话本页也看不到。已知偏差：`token_count` 在响应结束时写入，服务端缓存在请求开始时刷新，所以剩余时间最多多算一次请求的耗时。每条对话各自保留时间；刷新、重启后重新读取，不再全部视为过期。后端同时保留 `/session/last-model-request` 路由，页面脚本不再调用。
- 统计条有三个按钮，各对应一张卡片，行序固定，卡片内不分节。第一个按钮显示「轮数 · 步数」与本轮平均速度，卡片「最近一轮统计」依次为模型用时、工具调用用时、最近一次用时、平均速度（本轮）、最近一次速度、本轮推理。第二个按钮显示会话累计 Token 与缓存命中，卡片「Token 用量」依次为会话缓存命中、最近一次缓存命中、未缓存输入、缓存读取、输出。第三个按钮显示费用估算与上下文占用（`上下文 37.5% · 96k`，未知时为 `上下文 —`），卡片「会话」依次为账号、开始时间、上次回复、缓存剩余时间、上下文、最近一次 未缓存 / 输出 / 缓存读取、压缩次数、会话费用估算。没有费用字段时隐藏费用按钮项和该行。Codex 的 `input_tokens` 已含缓存读取，所以「未缓存输入」显示 `input − cached`；最近一次请求的三项取通知里 `last` 的单次模型请求，不与 `total` 混用。上下文写成 `14.9% (70.9k/475k)`。交互：悬停或聚焦预览，离开 350 ms 后收起，点击固定，点击外部或按 Esc 关闭；展开动画为 150 ms 淡入并上浮 4 px，`prefers-reduced-motion: reduce` 时关闭。
- `/session/stats`（`conversation_stats.rs`）只读会话记录，返回 `lastTurn`（轮次编号、状态、步数、模型用时、工具用时、本轮平均速度、本轮推理 Token、`coverage`）、会话累计 Token、`turnCount` 和 `lastModelRequest`。`lastModelRequest` 的字段与 `rollout_last_request.rs` 的结果一致：`requestedAt`、`lastTokenUsage`、`threadTotalTokens`、`sessionStartedAt`、`compactionCount`、`responseWindow`、`turnReasoningOutputTokens`。开始时间、上次回复、压缩次数在这条记录与通知匹配（见上一条）后才显示；新通知等待匹配期间沿用上一次匹配的记录；最终读不到或对不上时显示「—」，缓存剩余时间显示「未知」。请求时长（`responseWindow`）的起点是上一条 `token_count` 与这次请求首个 `response_item` 前最后一个输入事件中较晚者，终点是这次请求的 `token_usage_record`，包含等待首个 Token 的时间，与 cc-usage 的 Codex 估算一致；读取范围内找不到起点时为 `null`，速度和用时一起显示「—」。最近一次请求的速度用记录里的 `outputTokens` 除以窗口秒数，不用通知里的输出，否则新通知到达而记录尚未写好时会拿上一次请求的窗口除这一次的输出。本轮平均速度等于本轮输出 Token 除以本轮各次请求时长之和，任一请求缺少时长时为未知；工具调用用时按时间区间并集计算，并行调用不重复计时；读不到可靠边界时显示「—」。速度 ≥60 tok/s 绿、30–60 黄、低于 30 红；用时低于 15 秒绿、15–40 秒黄、40 秒以上红，颜色与缓存倒计时文字的三色相同。会话记录只在输出完成时写时间戳，首个 Token 等待时间拿不到，不提供。
- `/session/stats` 按（会话记录路径，会话 id）在内存中缓存解析状态，最多保留 8 个会话，每次只解析追加的完整行。判定文件被改写的条件有三个，任一成立就从头重读：长度变短，长度不变而修改时间变了，已读区域的头 4 KiB 与尾 64 KiB 的 SHA-256 摘要变了；每次轮询为此至多读 68 KiB。单行超过 8 MiB 或无法解析的行把统计标为 `partial`，步数和用时随之未知。`compactionCount` 来自同一增量状态，不需要每次重读整个文件。
- 已知限制：生成中不显示带「≈」的速度估算值。会话记录只在每次模型请求完成时写入 Token 数，生成期间页面显示「生成中」，所以 `public/conversation-stats-inject.js` 读取的 `speedIsEstimate` 从不为真。生成中的估算需要请求代理，本分叉没有，见 [ADR 0001](docs/adr/0001-remove-built-in-router.md)。
- 账号行：`/account/identity` 返回 `loggedIn`、`accountEmail`、`providerName` 和 `usesOfficialAccountAuth`，只读本机 `auth.json` 与用户配置，不联网，不受「额度显示」开关影响；用户配置无法解析时，其余字段照常返回，两项 provider 字段为空。`usesOfficialAccountAuth` 为真时显示 `accountEmail`，`loggedIn` 为假显示「未登录」；为假时显示 `providerName`，缺失则回退到 `currentProviderSnapshot` 的 provider id；读不到时显示「—」。统计条在启动、窗口获得焦点和 `codey:config-changed` 时重新读取身份。
- `latestTokenUsageInfo` 的读取结果记在 `snapshot().storedUsageRead`（`ok` / `empty` / `failed`），只作诊断。历史读取即使失效，统计条也会被订阅重放填上，所以不靠这个字段就看不出它坏了。
- `cacheValidMinutes` 是全局整数，默认 30，保存时限制在 1–180。已用掉有效时间的 75% 变黄，90% 变红，到点显示「已过期」。倒计时只写会话卡片里「缓存剩余时间」一格，每秒更新，页面隐藏时暂停，重新可见时重算；条上没有倒计时。热度色为绿 `#22c55e`、黄 `#ffbf00`、红 `#ff3b30`，未过期时显示 `分:秒` 且文字按热度着色，过期显示「已过期」且不加额外颜色。计时只看最近一次实时用量的时刻：在输入栏切换模型、思考强度或切换 provider 但没发新消息时都不动计时，下一轮用量到达时自然重新起算。不要从输入栏按钮文字推断「换了模型」——`$`、`@` 等浮层的条目也是输入框附近的按钮，文字里带 model 的条目会被认成模型选择器。`currentProviderSnapshot` 带 `#[serde(skip)]`，不在配置正文里；`/settings/get` 和 `codey:config-changed` 另外带上快照 id 与 `usesOfficialAccountAuth`。重新读取 Codex 配置也会派发该事件。
- 当 provider 是账号池型中转时，账号额度数字不代表实际消耗。对话用量描述这次对话发生了什么，不是套餐剩余。

## 通知与诊断

- 飞书、企业微信、Telegram、微信 ClawBot 和 ntfy 五类通知渠道共用任务状态及去重机制，最多保存 32 个；已配置的通知渠道同时接收完成、失败和等待介入。
- ntfy（`notifications/channels/ntfy.rs`）复用现有字段：服务器地址存在通知渠道配置的 `url`，必须是 HTTPS 根地址（允许端口，拒绝路径、查询、片段和用户信息）；主题存在接收者字段，只允许字母、数字、下划线和连字符，最长 64 字符；访问令牌存在机器人令牌字段，非空时以 Bearer 鉴权，为空不带鉴权头。请求向根地址 POST JSON，正文含主题、标题、消息、优先级和标签，完成与测试优先级为 3，失败与等待介入为 4。响应必须带消息编号，带 `error` 字段时报错。错误文本中的地址与令牌脱敏，后端不把已保存的地址和令牌返回前端。
- 持久投递：事件先写入 SQLite 队列（Codey 配置所在目录的 `notification-outbox.sqlite3`，同名 `.lock` 文件保证同一时间只有一个进程使用），再由投递任务发送。事件键去重：完成与失败共用同一终止事件键，等待介入按会话、轮次和提问标识区分；已有事件保留首次入队的通知渠道集合。队列只保存会话名等必要元数据和各通知渠道绑定的 SHA-256 摘要（微信 ClawBot 的上下文令牌与同步游标不参与摘要），不保存地址、接收者、凭据和错误正文；已结束的事件保留 7 天用于去重，单条事件上限 16 KiB。
- 投递任务最多并发 4 条，每个通知渠道同一时间只发一条，认领事务提交后才发起网络请求。发送前核验该通知渠道仍启用、已配置且绑定摘要未变，等待介入还要核验仍未被回答，否则取消。可重试失败按指数退避（1 秒起，加抖动，上限 5 分钟，不小于服务端要求的等待），最多 12 次或存活满 24 小时后放弃。重启后恢复待发项，上次中断时发送中的记录标为送达不明，不自动重发。
- 会话记录文件事件监听（`pending_approval/file_events.rs`）：`notify` 推荐后端监听会话主目录、`sessions`（递归）和 `sqlite`，macOS 另对已核验的会话记录文件做 kqueue 注册（最多 512 个描述符，不递归）。事件按 50 毫秒合并，路径集合溢出时转为完整扫描。监听健康时，通知扫描只增量读取有变化的会话记录，并保留 60 秒一次的完整扫描作补查；监听出错或要求重新扫描时标为不健康，改为定时轮询（间隔 3 秒起，空闲时逐级放宽到 30 秒）并记录 `notification.watcher_degraded`。
- 通知回归检查：`backend/src/commands/webhooks/` 下的 `runtime_tests.rs`、`observation_tests.rs`，`notifications/outbox.rs` 内的队列测试，`tests/ntfy-notification-channel.test.mjs`。这些检查不代替真实通知渠道、重启续投和 Windows 实机验收。
- 等待介入同时识别同步、异步提问；异步 accepted 只表示问题已发布，按实际回答清除等待。
- Trace 与 Crashpad 分别按设置执行保护和手动清理，复用互斥锁、文件白名单及静默期保护，不处理会话或账号数据；清理失败不将缺失统计显示为零。
- 构建将前端及注入脚本嵌入 Rust 程序，内容未变时保留产物时间戳以复用增量编译；平台打包及发布由现有脚本和工作流负责。客户端启动和控制台都不读取发布清单。

## 本地开发

需要稳定版 Rust、Node.js 22 和 pnpm。首次进入仓库先安装依赖：

    pnpm install

常用开发命令：

    pnpm run dev
    pnpm run check
    pnpm run test:js
    cargo test --workspace

`pnpm run dev` 会先构建完整 Cargo 工作区，再启动 Codey，确保主程序和 FastCtx sidecar 同目录。Windows 若检测到同一构建产物仍在运行，会要求先正常退出；只有确认进程卡死时才使用 `CODEY_DEV_FORCE_KILL=1`。

## 检查与构建

提交前至少执行：

    pnpm run check
    pnpm run test:js
    pnpm run vite:build
    cargo fmt --all -- --check
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    git diff --check

`save_selected_models` 的参数逐项对应命令请求字段，因此仅在该函数上允许 `clippy::too_many_arguments`；工作区继续以 `-D warnings` 检查其他警告。

完整构建使用：

    pnpm run build

未设置 `CODEY_SKIP_OVERLAY_BUILD` 时，该命令先重建前端与注入脚本。该变量已为 `1` 时，要求 `dist-overlay/codey-overlay.js` 已经存在，不再重建。随后的 cargo 调用只编译 `codey` 包的 release 二进制（`cargo build --release -p codey --bins`），并带 `CODEY_SKIP_OVERLAY_BUILD=1`，`backend/build.rs` 据此跳过再跑一次 Vite，只校验 overlay 产物已存在。直接运行 cargo 时不设该变量，build.rs 仍会自动构建前端产物。macOS 会额外生成 `target/release/bundle/macos/Codey.app`。Windows 安装包由 `.github/workflows/build-desktop.yml` 用固定版本的 NSIS 压缩包生成，不经过 Chocolatey。桌面发布任务先执行一次 `pnpm run vite:build`，再以 `CODEY_SKIP_OVERLAY_BUILD=1` 调用上述构建，打包时不再重编前端。CI 的实际门禁以 `.github/workflows/ci.yml` 为准。

Windows 桌面工具由 Go 1.26 编译，支持 x64 和 arm64；可用 `CODEY_COMPUTER_USE_GO` 指定编译器。macOS 用 Xcode 的 Swift 编译器构建 macOS 14 及以上载荷，并生成本地临时签名；Linux 无原生载荷。原生源目录 `vendor/ComputerUse` 与上游固定目标逐字节一致，MIT 许可随插件和安装包分发。

验证包默认由 `scripts/ci-pack.sh` 在已推送的功能分支上手动触发 `.github/workflows/build-desktop.yml`，再下载产物，流程见 `docs/agents/ci-pack.md`。GitHub 不可用或需要离线出包时，本机 Windows 验证包只走 `scripts/build-windows.sh`，流程见 `docs/agents/windows-pack.md`。脚本会复制桌面工具源并校验本机 Go，可传 `-ComputerUseGo` 指定 Windows `go.exe`；加 `-RunComputerUseTests` 会先在 NTFS 副本中执行原生协议与资源隔离测试，不执行桌面动作。GitHub 的 `v*` 标签仍由 `.github/workflows/build-desktop.yml` 打发布安装包。

Windows x64 与 macOS arm64 发布打包任务通过 `CARGO_PROFILE_RELEASE_LTO=thin` 和 `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` 覆盖默认的 fat LTO 与单代码生成单元，以减少 release 优化和链接耗时。Windows 发布打包另用 `rust-lld` 链接。本地构建，以及与 macOS 打包并行的检查任务，沿用 Cargo.toml 默认配置。Windows 发布打包不再重复 Rust 测试、Clippy 和格式检查，这些留在 `.github/workflows/ci.yml` 的 Windows 任务。macOS 的 TypeScript、JavaScript 与 Rust 检查在独立任务里与打包并行，发布前都要通过。此调整可能影响二进制体积和运行性能。

macOS 本地调试未签名安装包时，确认来源后可用 `xattr -dr com.apple.quarantine /Applications/Codey.app` 移除隔离属性。此操作不会补齐签名或公证，发布包仍需单独处理。

## 发布

发布脚本会同步 package.json、Cargo.toml 和 Cargo.lock 的版本，运行检查，创建提交与标签并推送：

    pnpm run release -- <version>

默认要求工作区干净。确实要把现有改动纳入发布时使用 `--include-existing-changes`；只在本地创建标签时使用 `--no-push`。

`v*` 标签会并行打出 macOS arm64 与 Windows x64 安装包，并同时运行 macOS 检查，然后把安装包附加到 GitHub Release。本分叉不向客户端分发在线更新：安装包只通过 GitHub Release 和 Actions 产物提供，客户端启动和控制台都不会检查、下载或安装更新。发布标签版本必须与项目版本一致。分叉的版本号自行递增，不跟随上游。本地把上游标签取到 `upstream/` 标签命名空间（`remote.upstream.fetch` 含 `+refs/tags/*:refs/tags/upstream/*`，`remote.upstream.tagopt` 为 `--no-tags`），因此分叉标签不会与上游标签撞名。每次发布在 README 和 GitHub Release 说明里写明这次同步到的上游版本。

## 维护约束

- 不恢复内置路由。见 [ADR 0001](docs/adr/0001-remove-built-in-router.md)。`local_router_enabled` 缺省为关闭；加载和保存 Codey 配置时若磁盘上仍为 true，按关闭处理。这不是保留路由，只是清掉同步残留的开关。
- 用户配置生命周期内只读：启动、重启、退出、启动失败清理和旧租约恢复不写 `config.toml`、`auth.json` 等用户拥有的文件，只有控制台的显式操作可以写，且写前备份：修复插件市场、Codex 配置修复、MCP 与 Skill 管理、官方账号切换。见 [ADR 0002](docs/adr/0002-user-config-is-read-only.md) 及其 2026-10-27 收窄修订。运行期配置及 Hook 定义、信任状态通过 CLI 包装器传递命令行覆盖；仅保留旧版 `hooks.json` 租约的一次性恢复。
- 按提交挑选跟踪上游，不整段 merge。见 [ADR 0003](docs/adr/0003-track-upstream-by-cherry-pick.md)。与上游的当前差异及原因维护在 [docs/agents/fork-upstream.md](docs/agents/fork-upstream.md)；对照、挑选或跳过上游后必须同步更新该文件，用户可感知的条目同步 README「与上游的差异」。
- `vendor/CodeyRuntime` 整目录替换，内部未调用代码不删。见 ADR 0003。同步时不要在 vendor 内手工删除未引用模块；backend 只停止调用。
- 自动更新必须关闭。见 ADR 0003 后果。默认更新源硬编码指向上游发布清单，一次在线更新会把上游正式版装回来，覆盖本分叉。保留 `tests/update-disabled.test.mjs`。
- README.md 只写用户能感知的功能与必要注意事项；实现、构建、发布、路径和限制写在本文档。
- 新功能先复用现有配置事务、桥接、URL 校验、错误脱敏和原子文件工具，不建立第二套流程。
- 对 Codex 持久数据的写入必须有所有权证据、快照复核、备份和原子替换；不确定时保持只读。
- 网络请求必须有输入与响应上限，凭据不能进入错误文本、URL、前端状态或日志。
- 兼容窗口：只保证从最近两个已发布版本升级时的平滑迁移，更早版本的数据格式迁移代码不再保留。
- 本文档描述当前稳定结构，不记录调参历史、已删除方案或逐版本迁移过程。

## 已知限制

- 只支持 Codex Electron 桌面客户端；页面和 bundle 大改时可能需要更新补丁与注入适配。不固定安装某一版 Codex。
- 第三方 provider 只能使用目标服务可表达的能力；无法无损转换的请求会在发送前拒绝。
- Codex 直连当前 provider，不在本机做跨 provider 容灾，也不会重放已发送请求。
- 手动修复插件市场是 ADR 0002 收窄修订所允许的显式操作：它通过运行组件的配置管理器写 `config.toml`，写前校验新文档，并轮换保留最多 5 份 `config.toml.bak`。桌面插件准备不写用户配置。Codex 配置修复、MCP 与 Skill 管理、官方账号切换同属显式操作，备份放在 Codey 自己的目录，见上文。
- 系统设置与偏好对话框在拿不到 Codex 目录时回退显示 `/Applications/ChatGPT.app`，Windows 用户会看到这个 macOS 默认路径。
- 子代理 Hook 用于本地协作约束，不等同于操作系统沙箱。
- FastCtx 不提供 PDF、MCP Resources 或 shell 工具，这些任务继续使用 Codex 自带能力。
- 进程内请求日志已随内置路由删除，控制台不再提供该页面。
- 当前发布的 macOS 与 Windows 安装包可能未签名，正式分发前应补齐平台签名与公证。未签名的 Windows 可执行文件可能被 Defender 在首次可见时拦截或拖慢启动，签名属于发布链路事项。
- 若系统拒绝终止 Codex，已建立的运行时会保留依赖供停止重试；若首次启动尚未建好运行时就发生注入失败且无法终止进程，需要人工退出残留 Codex 后重启。
- Windows 原生存活检测、Store 实际启动和完整 Windows 工作区编译以 Windows CI 或实机为准；Linux 上的检查不能替代。vendor 中仅 Windows 编译的入口随整目录保留，不因当前 backend 未引用而删除。
- 重启状态查询：前端 `runtime_status` 与 `restart_codey` 请求均设 10 秒等待上限；超时仅结束前端等待，不取消后台重启。连续失败或达到上限且仍未完成时显示状态未知并停止加载，按钮改为重新查询。
- Codex 启动代理带用户名密码时：地址以明文保存在 Codey 配置及其备份中，并原样返回控制台（与上游相同）；认证中继监听回环地址，运行期间本机任何进程无需凭据即可经它使用该代理。
- 页面资源补丁不支持实时编辑，与上游一致。
- MCP 与 Skill 的扩展备份不会清理，每次写入或删除留下一份。Windows 上备份含符号链接的 Skill 目录需要创建符号链接的权限，缺权限时备份失败，写入随之中止。
- 控制台侧栏在窗口宽度约 900–1100 px 时较拥挤。
- 只有第三方 provider、没有 `models_cache.json` 的用户，升级后派生模型目录因来源校验被拒绝时没有可回退的目录，直到该文件出现；没有任何重新探测。
- 官方账号切换的备份每次一份，含完整令牌，不会删除。Codex 可能在变更检查与写入之间刷新令牌，这一小段竞争无法消除；切换后重启 Codex 会缩短受影响的时间窗口。
- 未验证：官方账号 B 是否接受官方账号 A 下开始的对话中的加密推理内容；Codex 凭据存储为 `keyring` 或 `auto` 时的行为（此时禁用账号切换并显示原因）。
- 以下行为只在本机测试和 WSL 中验证，待 Windows 实机验收：桌面版内置 CLI 接受 `model_provider` 与 `model` 覆盖，切换渠道后新会话发往新渠道而旧会话仍用原 provider；官方账号浏览器登录、真实切换与切换后对话；第三方服务端接受 `ultra`；统计条在真实 Codex 中的位置、数值与动画（浅色和深色主题各一次）。
