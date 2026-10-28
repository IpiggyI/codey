# 最新版 Codex 下的 Codey 功能更新清单

## 记录范围与使用方式

本记录保存 2026 年 10 月 18 日的只读兼容性审计结果，供后续维护者安排更新。审计发现九项需要更新或迁移的内容，以及三项需要按原生能力重新评估的内容。优先核对指定轮次删除和依赖主进程补丁的增强。

审计使用 Windows 仓库的 Codey 1.2.1 源码。保存本记录时，WSL 仓库已是 1.2.3。因此，下列发现不能直接视为 WSL 当前源码的已确认缺陷。后续实施前，应先核对 1.2.1 至 1.2.3 的相关改动，再对仍存在的问题建立验证。

本文是一次审计记录，不替代[领域说明](../../CONTEXT.md)、[内部开发文档](../../INTERNAL_DEVELOPMENT.md)或现有架构决策。本文记录更新建议，不表示已经实施修复。

## 版本与证据基线

| 对象 | 已核实的值 | 适用边界 |
| --- | --- | --- |
| 审计日期 | 2026 年 10 月 18 日。 | 官方资料与本机状态以该日读取结果为准。 |
| Windows 源码仓库 | `D:\Development\GitHub\codey`。 | 原始审计使用该仓库。 |
| Windows 源码基线 | `047fa22f039922c3e24708aacdb3e72ea5030233`，Codey `1.2.1`。 | 原始审计前后工作区干净。源码版本不能代替正在运行的 Codey 可执行文件版本。 |
| 当前 Codex 应用版本 | `26.1013.40934`。 | 来自应用更新检查与安装包内的 `package.json`。更新检查返回 `up_to_date`。 |
| 当前 Codex 商店包 | `OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0`。 | 已读取正在运行的进程路径和当前注册包。 |
| Codex 内置 CLI | `0.163.0-alpha.10.2`。 | 官方安装目录和 Codey 运行副本的 `--version` 输出一致；没有据此声称二进制逐字节相同。 |
| WSL 保存位置 | 本仓库。 | 已确认是同一分叉仓库。 |
| WSL 保存时基线 | `bdb87fd5cb0ae1c206fc77f76864f2ac165217ab`，Codey `1.2.3`。 | 保存前已有未跟踪的 `.scratch/`，本次保留。没有对该基线执行完整兼容性复审。 |

下文源码入口均指向审计基线的实现。相对链接用于定位对应文件；在 WSL 当前版本中应按函数名或补丁标签重新定位，不能沿用旧行号断言当前行为。

## 已取得的直接证据

1. 当前 Windows 包的 `ChatGPT.exe` 不含 Electron fuse 标记，`chrome.dll` 含版本为 `1` 的状态串 `010011001`。`NODE_OPTIONS` 与 Inspector 对应位均为 `0`，明确关闭了两个既有主进程注入入口。此结论仅覆盖该安装包与这两个入口。
2. 在隔离的 Node 环境中，将 Codey 页面补丁应用到当前官方真实资源 `webview/assets/app-initial-5851df3f6cb1.js`，得到 `model allowlist gate matched 0 times` 和 `model visibility gate matched 0 times`。这证明旧锚点失配，不证明所有模型选择功能失效。
3. 扫描当前官方页面 JavaScript 后，未找到旧速度门禁标识 `isServiceTierAllowed`。`modelPickerTriggerConfig` 出现在当前 `app-primary` 资源中。现有补丁的部分定位前提已经变化。
4. 只读检查当前本机官方模型缓存，其 `client_version` 为 `0.163.0`。缓存包含可见的 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol` 和 `gpt-6-luna`，没有 `gpt-5.5`。其中 Sol 6.1 和 Astra 原生元数据都包含六档思考强度。这不证明其他账号或第三方 provider 的能力。
5. 对照最新官方接口契约，`thread/unsubscribe` 的返回不等于服务端会话立即卸载。Codey 审计基线在该请求返回后继续执行轮次删除。没有执行真实删除，也没有复现数据损坏。

## 需要更新或迁移的九项内容

| 编号 | 优先级与功能 | 审计基线下的发现 | 更新方向与验收重点 |
| --- | --- | --- | --- |
| 1 | 最高优先级：指定轮次删除。 | `messageDeletionMethods.prepare` 在 `thread/unsubscribe` 返回后继续，随后调用本地记录删除。官方契约规定，最后一个订阅移除后，服务端仍可能保留会话，直到无订阅且无活动达 30 分钟。取消订阅不能作为记录已释放的证明。 | 先核对当前服务的卸载与持久化契约，再保证直接改写记录的安全边界。可复用的原生撤回或删除接口应分别评估；从尾部撤回不能直接替代任意轮删除。验收需覆盖删除后继续发送、重新打开、多窗口与服务端仍持有会话的情况。 |
| 2 | 最高优先级：依赖主进程补丁的增强。 | 当前 Windows 安装包关闭了 `NODE_OPTIONS` 和 Inspector 两个既有入口。CLI 包装器的参数确认不能证明主进程补丁已应用。 | 逐项核对辅助模型、周期采样优化、宠物预热等依赖；迁移到可用入口，或明确显示该项不可用。保留 CLI 包装器、页面 CDP 注入与主进程补丁各自的能力边界。不得把修正 fuse 检测当成恢复注入。 |
| 3 | 高优先级：模型与速度选择器页面补丁。 | 当前真实资源让两处模型筛选补丁匹配零次，旧服务档位门禁标识也已变化。 | 按当前资源建立最小适配，并补充真实资源验证。先判断旧补偿是否仍有必要，再调整匹配逻辑。模拟片段通过不能代替已安装 Windows 客户端验收。 |
| 4 | 高优先级：官方模型兜底清单。 | 固定 `OFFICIAL_MODELS` 仍含 `gpt-5.5`，缺少 `gpt-6.1-sol`、`gpt-6-sol` 和 `gpt-6-luna`。官方已于 10 月 14 日在 ChatGPT 登录的 Codex 中退役 GPT-5.5；API 场景不在该退役范围内。 | 更新兜底清单和模板校验，保留正常路径的原生目录优先机制。验收应分别覆盖原生目录正常、原生目录缺失与用户显式目录。不能把兜底清单问题表述为当前一定显示退役模型。 |
| 5 | 高优先级：provider 的网页搜索和远程压缩能力识别。 | Codex 已提供 `capabilities.external_web_access` 和 `capabilities.remote_compaction`。Codey 的远程压缩状态仍使用 `official || name == "OpenAI"` 这一启发式判断。 | 优先读取显式能力声明，再结合模型元数据判断。区分配置声明支持和真实服务验证通过；不能从名称推断能力，也不能自动改写用户配置。 |
| 6 | 高优先级：模型同步与提示词优化的认证读取。 | 原生 Codex 已支持 `model_providers.<id>.auth.command`。Codey 主要识别环境变量与静态令牌，提示词优化的当前 provider 入口还要求 `env_key`。 | 兼容命令取令牌，或明确报告该认证方式暂不支持，避免原生可用而 Codey 提示没有密钥。验收不得记录令牌，不应扩大命令执行授权，也不应把令牌回写配置。 |
| 7 | 高优先级：子代理与 FastCtx 的 Hook 安装。 | 仓库以“Codex 无法用运行期配置提供 Hook”作为必须写入 `hooks.json` 的依据。现在官方支持内联 `[hooks]` 和插件携带 Hook，这一依据需要重核。 | 验证内联运行期覆盖或插件入口，确认合并、信任、退出与恢复行为后，再减少用户 `hooks.json` 的写入。官方支持内联配置不等于 Codey 的命令行覆盖入口已经验收。 |
| 8 | 普通优先级：Fast 与服务档位元数据。 | Codey 的补充逻辑以 Fast 为主，并写死“1.5 倍速度”描述。当前原生还提供 Ultrafast，不同模型的速度说明不同。 | 优先保留原生档位与描述，按模型及账号能力展示。不要统一承诺 1.5 倍，也不要将档位可见当成服务端已授权。分别验证原生元数据完整和需要兜底的路径。 |
| 9 | 普通优先级：账号额度展示。 | Codey 的快照只保存一组 `primary`、`secondary` 和 Credits；官方已提供 `rateLimitsByLimitId` 多组额度视图。 | 支持额度组标识与名称，明确当前展示范围，并兼容旧单组接口。不得把一组数字概括成所有模型和服务档位的额度。本轮没有请求真实账号额度。 |

## 源码入口

| 编号 | 对应文件与定位标识 |
| --- | --- |
| 1 | [页面会话操作](../../public/codey-inject.js)中的 `messageDeletionMethods.prepare`、`prepareMessageDeletion` 和 `/session/delete-messages`。 |
| 2 | [启动说明](../../INTERNAL_DEVELOPMENT.md)、[fuse 检测](../../backend/src/electron_fuses.rs)和[控制台状态](../../src/OperationsPanel.tsx)中的 `startupInjectionMode`。 |
| 3 | [启动补丁](../../backend/src/codex_startup_patch.js)中的 `patchCodexRendererAsset`，以及 `model allowlist`、`model visibility`、`service tier request entitlement` 等补丁标签。 |
| 4 | [模型目录](../../backend/src/model_catalog.rs)中的 `OFFICIAL_MODELS` 和 `read_official_entries_uncached`。 |
| 5 | [当前 provider 解析](../../backend/src/codex_provider.rs)中的 `local_provider_with_auth_policy` 与 `supports_remote_compaction`。 |
| 6 | [当前 provider 解析](../../backend/src/codex_provider.rs)中的 `current_provider_model_sync`、`prompt_optimization_provider_overlay_with_env` 和 `provider_config_api_key_with_env`。 |
| 7 | [用户配置只读决策](../adr/0002-user-config-is-read-only.md)与[运行期配置](../../backend/src/codex_config.rs)中的 Hook 安装、信任项及恢复流程。 |
| 8 | [模型目录](../../backend/src/model_catalog.rs)中的 `add_fast_speed_controls`、`service_tiers` 和 `additional_speed_tiers`。 |
| 9 | [账号额度](../../backend/src/account_usage.rs)中的 `AccountUsageSnapshot` 和 `parse_account_usage`。 |

模型与服务档位的已有交接见[发送消息后丢失快速服务档位的修复交接](2026-10-08-fast-service-tier.md)。该文件包含后续源码进展。实施第三项和第八项前，应先读取这些进展，避免重复处理已经完成的改动。

## 需要重新评估的三项内容

| 功能 | 重新评估的依据 | 保留与调整边界 |
| --- | --- | --- |
| 桌面操作插件准备。 | 原生 Codex 已覆盖 Windows 和 macOS 的基础桌面操作能力。Codey 仍提供[自有插件准备入口](../../backend/src/computer_use.rs)。 | 考虑原生优先，将 Codey 插件保留为明确的备用入口。尚未验证本账号的原生权限和两套实现的能力等价性，不能直接删除。 |
| 插件市场手动修复。 | [现有修复入口](../../backend/src/plugin_marketplace.rs)仍调用写用户配置的路径，[内部开发文档](../../INTERNAL_DEVELOPMENT.md)已记录其与用户配置只读决策的偏差。 | 先复现当前版本的具体市场故障，再决定保留哪些修复动作。离线插件内容仍可能有独立价值，不应与修复路径一并移除。 |
| 子代理角色注册适配。 | 官方已支持独立代理 TOML 文件和原生发现；Codey 仍通过 `agents.<role>.config_file` 注册。 | 核对新旧入口兼容范围。五类角色选择、模型绑定及并发约束仍有独立价值，不能因为原生能够派发子代理就整体删除。 |

## 暂无依据列为过时的功能

- 原生模型目录优先和显式模型排除项仍有保留价值。
- 自定义模型目录和上下文预算界面仍有保留价值。
- 提示词优化仍有保留价值，认证适配缺口应单独处理。
- 飞书、企业微信、Telegram 和微信 ClawBot 通知仍有保留价值。
- FastCtx 仍有保留价值，Hook 交付方式应单独评估。
- 对话 Token、缓存命中和缓存倒计时仍有保留价值；倒计时仍是本机估计，不能表述为服务端到期时间。
- `GPT-` 前缀显示补偿依赖的开关 `3849065407` 仍存在于当前官方资源中。本轮没有完成实际界面显示验收。

## 后续执行与验收边界

1. 修复者先在 WSL 当前源码中重核九项发现，并将每项标为仍存在、已处理、无需处理或待验证。尤其先阅读 1.2.2 与 1.2.3 的相关改动。
2. 对仍存在的问题，修复者先建立能够经过实际故障入口的检查。涉及服务契约时，应使用当前运行版本验证，不能只依赖文档或旧版模拟片段。
3. Windows 验证者分别确认源码验证、安装包与实际运行进程，避免把源码版本当作已部署版本。页面补丁命中不能代替真实操作结果。
4. 真实删除、模型请求、安装、部署和远程操作应按具体动作获得授权。本文保存审计建议，不授权执行这些动作。
5. 实施时继续遵守用户配置只读和请求直接发往用户所选 provider 的约束。变更使权威文档失真时，应在同一改动中同步相关说明。

本轮未修改产品代码、用户配置或会话记录，未构建、重启、发送模型请求或执行真实删除。安装包探针仅覆盖 Windows，没有验证 macOS 或 Linux。流程咨询四次返回 `unsupported_content` 后自动停用，没有形成独立审阅意见。

## 官方资料

以下资料于 2026 年 10 月 18 日读取。后续实施前应重新核对关键契约。

- [官方更新日志](https://learn.chatgpt.com/docs/changelog)提供模型退役与客户端能力变更。
- [官方应用服务器接口](https://learn.chatgpt.com/docs/app-server)说明会话订阅、卸载、删除与多组额度结构。
- [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)说明 provider 能力和命令取令牌配置。
- [官方 Hook 文档](https://learn.chatgpt.com/docs/hooks)说明内联、文件及插件入口的合并与信任行为。
- [官方速度说明](https://learn.chatgpt.com/docs/agent-configuration/speed)说明 Fast、Ultrafast 与可用范围。
- [官方子代理说明](https://learn.chatgpt.com/docs/agent-configuration/subagents)说明代理文件和原生配置。
- [官方桌面操作说明](https://learn.chatgpt.com/docs/computer-use)说明原生能力与平台边界。
