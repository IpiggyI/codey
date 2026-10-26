# Codex 26.1021 与 Codey 1.3.1 兼容性排查及修复交接

## 结论与状态

2026 年 10 月 26 日在当前 Windows 客户端完成只读排查。侧栏按钮的常显、错位和不可点击已复现；输入栏 `CH` 消失已复现。两者包含不同的直接原因：前者挂载到了新版无布局盒的动作容器，后者没有发现新版异步会话管理器，导致用量订阅及历史读取都没有开始。

本次还确认了会话管理的连带能力失效、旧同步控制器与新异步接口不兼容、完成状态同步补丁无法安装、中文设置同步失败、插件桥接替换未生效，以及周期采样优化被过时条件跳过。服务档位补偿、账号额度显示、模型目录加载仍有正面运行证据，不能把它们统称为失效。

本交接只新增本文、[只读探针](2026-10-26-codex-compatibility-probe.mjs)和探针结果。没有修改产品代码、用户配置、历史会话或官方资源，没有提交、推送、构建、安装、重启或发送模型请求。修复与功能验收仍待安排。各问题最早出现在哪一版尚未二分，本报告证明它们存在于当前组合，不证明所有问题均首次产生于最近一次更新。

## 修复进展

同日在分支 `sync/upstream-v1.3.8` 处理了全部八项，上游 v1.3.8 已有修复的直接移植，其余由本分叉补齐。逐项对应、验证结果和剩余上游提交的归类见 [2026-10-26 更新计划](../upstream-sync/2026-10-26-plan.md)。离线测试、补丁套用真实资源和运行中页面的只读探测已通过；安装后的实机验收尚未进行，下文各项的验收要求仍然有效。第 6 项中原生 `plugin/list` 的本地插件合并未实施。

## 当前基线

| 对象 | 本次核实值及边界 |
| --- | --- |
| Codex 商店包 | `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`。当前注册包和主进程路径一致。 |
| Codex 应用版本 | `26.1021.31345`。来自包内 `resources/app.asar` 的 `package.json`，与 Codey 后端读取结果一致。商店包号不是应用版本号。 |
| 运行进程 | `C:/Program Files/WindowsApps/OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0/app/ChatGPT.exe`，CDP 端口 `9229`。 |
| 内置 CLI 运行副本 | `%LOCALAPPDATA%/Codey/codex-runtime/d6dedca66c032d0e/codex.exe`，`--version` 返回 `0.164.0-alpha.11.1`。已核对实际 app-server 进程命令行；没有做整个二进制的同源证明。 |
| 运行 Codey | `<安装目录>/Codey.exe`，文件与产品版本均为 `1.3.1`，后端亦报告 `1.3.1`。 |
| Windows 源码 | `D:/Development/GitHub/codey`，`2d08f022cf8c59180d4a4c4a6dd0c50b542926bc`。原有未跟踪 `output/diagnostics/`，没有修改。 |
| WSL 交付仓库 | Ubuntu 中的本仓库，`1207cb9945631f44a148831c4afdeb2d64bb0ae0`。原有未跟踪 `.scratch/`，没有读取其内容或清理。 |
| 两侧差异 | WSL 比 Windows 多一条打包流程提交，仅涉及 `AGENTS.md`、内部说明、打包说明和 `scripts/ci-pack.sh`。本次所查功能源码一致。 |
| 当前主页面资源 | `index-340508751504.js`、`app-shared-955d52676f9c.js`、`app-initial-438d1df57f70.js`。通过实际页面读取并与包内资源路径交叉核实。 |

时间、端口、压缩符号和资源散列名仅作本次证据。修复前重新核对进程、源码及加载资源；任一变化都使上述环境假设过期。运行中关键发现函数已与源码逐项比对，不以版本号代替完整产物一致性证明。

## 已确认问题及处理方向

### 1. 侧栏按钮挂载层级过时，造成错位和点击被其他行截获

优先级为高。实际存在 9 个导出和 9 个删除按钮。抽查第一行：原生置顶、归档按钮的纵坐标为 `254`，Codey 导出、删除按钮的纵坐标为 `274`。按钮父节点为类名 `contents` 的容器，Codey 给它写入了 `data-codey-session-action-row=true`，最终计算样式是 `inline-flex`；按钮被排到了原生行内容之后。按钮中心的 `document.elementFromPoint` 返回其他侧栏行，未命中按钮。这直接解释“图标可见但无法操作”，没有实际点击或删除会话。

原因在 [页面会话脚本](../../public/codey-inject.js)的 `archivePlacementTarget`（基线第 3134 行）：它无条件把原生归档按钮的父节点作为放置目标。新版这个父节点承担原生悬停布局，父节点之外是 `contents` 层。`installSessionExportButtons` 和 `installSessionDeleteButtons` 再把新按钮插到目标之外，并给更外层强加布局。导出和删除必须一起修复。

建议以当前原生动作组为边界，把按钮放入相同的布局及悬停容器，避免把 `contents` 层变为布局盒。仍保留 Codex 与 Work 两种入口、键盘聚焦、右键菜单、忙碌与禁用行为。不要只加绝对定位或提高层叠顺序掩盖错误层级。

验收需用真实浏览器布局检查：未悬停时隐藏，悬停或键盘聚焦时出现；按钮中心命中自身；按钮不遮挡邻行；切换模式及虚拟行复用后仍正确。现有模拟 DOM 测试没有几何命中验证。

### 2. 管理器发现仍匹配旧契约，使 CH 及多项会话能力失效

优先级为高。实际调用 `__codeyLoadCodexSessionController` 的 `session`、`sidebarDelete`、`deleteMessages`、`refresh`、`usage`、`mcpReload`、`reconcile` 七种发现入口，均返回 `codey_capability_unavailable`。未调用各功能的写操作。

当前两个发现资源均没有 `getForHostId(`。旧 RPC 解析器要求错误文本 `AppServerManager RPC is not connected`，当前实现已改成 `AppServerManager RPC is unavailable for hostId:`。旧注册类、旧 RPC、旧信号和旧状态键四条发现路径均没有取得控制器，不能把这解释成原生会话接口已全部删除。

当前 `app-initial` 导出 `irr` 对应的函数 `kg` 仍负责根据作用域和主机取得管理器。只读执行 `__codeyAppServerManagerFromReact(module.irr)` 得到函数类型的 RPC 对象；`await manager.getHostId()` 返回 `local`；读取当前会话的 `latestTokenUsageInfo` 返回包含 `total`、`last`、`modelContextWindow` 的对象。没有读取聊天正文，也没有把此对象安装成 Codey 控制器。

与此同时，Codey 的用量快照为 `usageVisible=false`、`subscribed=false`、`threadCount=0`、`storedUsageRead=""`，且 `usageError=null`。原生有用量而 Codey 没有开始订阅，是 `CH` 丢失的直接证据。当前可见输入栏已经找到，不能优先把原因归为输入框选择器失配。

修复入口是 [会话发现](../../public/codey-inject.js)的 `appServerManagerResolverFromModule`（第 2099 行）、`appServerManagerStateKeyResolverFromSource`（第 2285 行）、`discoverCodexSessionController`（第 2542 行），以及 [用量模块](../../public/composer-usage.js)的 `subscribeNotifications`。按实际语义发现唯一解析器，再只读验证主机和最小能力，兼容旧实现并在无法唯一确认时明确失败。不要硬编码 `irr`、`kg` 或资源文件名。

同一原因影响以下调用：

| 功能 | 当前证据及修复后的验证 |
| --- | --- |
| 输入栏用量、缓存圈与详情 | 订阅未建立，历史读取未开始。复用已有 RPC 用量分支，检查当前会话已有用量立即显示，实时通知更新，切换会话不串数据，断线及卸载释放订阅。 |
| 整会话删除 | 发现不可用，尚未进入原生释放。恢复后仍须先成功释放，再允许持久化删除。 |
| 指定轮次删除 | `deleteMessages` 发现不可用。还必须解决下节的同步与异步契约差异，不能以发现恢复表示轮次删除可用。 |
| 导入后的列表刷新 | `refresh` 发现不可用。导入持久化由独立后端负责，当前不能说导入写入一定失败；导入后的自动列表同步受影响。 |
| 账号额度的原生备用读取 | `usage` 发现不可用。当前后端额度块仍显示，此问题只覆盖备用路径。 |
| MCP 热刷新 | 发现不可用，备用 `__codeyAppServerRequestClients` 也不存在。未发送 `config/mcpServer/reload`。 |
| 子代理详情模型标签 | [渲染入口](../../public/renderer-inject.js)的 `syncSubagentHeaders` 依赖同一发现结果及 `readThread`。当前路径受阻；本次没有新建子代理或打开详情做最终验收。 |

### 3. 只改发现文本仍不能恢复删除，控制器要求同步本地对象

优先级为高。这是修复方案必须覆盖的第二层问题，并非已实施修复后发现的新回归。

新版管理器是函数类型的异步 RPC 对象。读取 `sendRequest`、`discardConversationFromCache`、`handleThreadDeletion`、`refreshRecentConversations` 等属性时均可得到函数，但当前 `declaredMethod` 通过对象及原型的属性描述符查找，结果全部为无声明方法。因此 `managerSessionController` 生成的删除和刷新包装器仍为空。

`isLocalMessageDeletionManager` 还要求同步的 `getHostId() === "local"`，并直接检查 `inactiveThreadUnsubscriber`；轮次计划会同步读取、遍历和修改 `getConversation()` 的返回对象。异步 RPC 不能按这个契约使用，单纯放宽 `declaredMethod` 或把所有属性函数都视为已实现，会制造假阳性。

建议在既有控制器边界区分本地同步管理器和异步 RPC。优先复用原生公开操作或原生调用点，异步读取最少数据；不要把本地回调函数与原生对象修改逻辑直接跨 RPC 传输。整会话删除可以单独恢复，但每项能力必须通过具体调用契约验证。轮次删除如暂时没有足够接口，应保持明确不可用，不得跳过运行中、跟随窗口、历史完整性和释放保护。原生撤回后的继续发送、重新打开及多窗口一致性仍须隔离会话验收。

### 4. 完成状态同步补丁依赖旧会话实现，当前未安装

优先级为高。[资源补丁](../../backend/src/renderer_asset_patch.js)第 392 行仍要求 `isLocalConversationInProgress` 和旧 `async resumeConversation(单参数)` 实现。当前 `app-initial` 没有前一标识，实际恢复方法为 `async resumeConversation(e,t){return this.#t(...)}`。离线应用补丁没有产生 `codeyReconcileCompletedConversation`，当前 `reconcile` 发现也不可用。

因此，即使先修好管理器发现，现有“页面错过完成通知后重新同步”的补偿也不能自动恢复。应先确认当前原生恢复、流所有权及分页历史的契约，判断是否仍需 Codey 补偿，再做最小适配。必须保留两次服务端状态核对、并发修订和跟随窗口保护，不能仅把页面强行标成完成。没有复现当前会话卡在运行中的最终症状，本项证明的是补偿未安装。

### 5. 中文设置同步调用已移除的接口，首次渲染补丁也未覆盖新资源

优先级为普通。[语言脚本](../../public/default-chinese-locale.js)第 327 行仍通过 `vscode://codex/get-setting` 与 `set-setting` 同步 `localeOverride`。实际快照为 `rendererAssetPatched=false`、`settingSynced=false`、`settingSyncAttempts=18`，错误原文为 `get-setting not implemented in the current Electron process. Restart ChatGPT to load the latest Electron handlers.`。这是已加载实例的接口错误，不能把消息中的重启建议当作根因或修复证明。

当前语言初始化位于 `initialize-app-host-services-b944587b60fb.js`，不在资源改写入口的固定资源集合中。按真实 URL 离线应用返回不改写；仅在隔离环境把 URL 视为适配资源时，既有 `default Chinese locale` 正则唯一命中并改写。说明此处既有算法仍能匹配，资源覆盖范围已经落后。

建议优先核实当前原生语言设置入口，再决定是否取消旧持久设置同步；若保留首次渲染补偿，则更新实际资源发现及覆盖范围。不要通过写用户 `config.toml` 修复。当前 `navigator` 和 Statsig 语言补偿仍在，页面也是中文，所以不能宣称中文界面整体失效。验收需覆盖首次启动、重新加载、窗口聚焦及原生已设中文的情况。

### 6. 插件兼容脚本未替换冻结桥接，却报告已接管

优先级为普通。当前 `Object.isFrozen(window.electronBridge) === true`，`sendMessageFromView` 的描述符为 `writable=false`、`configurable=false`，函数仍为原生函数，`.__codeyPatched` 不存在。但注入状态报告 `effective`、详情为“插件市场桥接已接管”。

原因在 [插件兼容脚本](../../public/plugin-marketplace-fix.js)的 `patchElectronBridge`（第 269 行）：赋值后没有验证实际引用是否改变，随后无条件发布成功。当前官方插件列表通过原生管理器发送 `plugin/list`；脚本的列表等待、刷新分支仍专门匹配 `list-plugins`，安装变更仍匹配 `install-plugin`、`uninstall-plugin`。这两层契约都需要重核。

建议先确认原生插件功能是否已满足需求，仅对仍需要的本地插件合并或兼容行为，在可用的请求结果或查询缓存边界适配 `plugin/list`、`plugin/install` 等当前接口。保留现有独立 Fetch 备用路径的单独验证，不能从冻结桥接推出所有插件路径均失效。禁止仅把对象解冻或绕过原生安全边界；发布成功前校验真实安装结果。插件市场手动修复和离线载荷是独立后端能力，本次未执行安装或市场写入，未证明它们整体失效。

### 7. 周期采样优化被过时的外围标识静默跳过

优先级为普通。[资源补丁](../../backend/src/renderer_asset_patch.js)第 679 行同时要求 `rendererProcessCpuPercentAvg`、`beginCpuSampling`、`activeInteractions=new Map` 和心跳方法。当前 `app-shared` 保留 CPU 采样表达式与 `ensureHeartbeat(){this.heartbeatTimer??=setInterval...}`，但已没有 `rendererProcessCpuPercentAvg`，所以整个分支不进入，也不记录锚点错误。

建议先确认新指标实现及分析关闭后的实际开销；只有仍有必要时，缩小到当前可验证的采样与心跳结构做唯一匹配。保留交互生命周期，避免整类删除。本次证明旧优化未应用，没有测量 CPU 占用，也没有把它列为当前性能问题的已证实原因。

### 8. 生效状态没有表达真正可用的功能边界

优先级为普通。[用量模块](../../public/composer-usage.js)第 76、1392 行把模块扫描就绪视为 `effective`；它在无订阅、无数据、无错误解释的情况下仍显示“输入栏用量芯片已就绪”。插件脚本也在冻结对象赋值无效后发布成功。后端健康接口返回 `healthy` 只证明桥接响应，并不证明以上功能可用。

建议让功能状态至少区分模块已加载、入口已找到、订阅已建立、已有可展示数据，以及不支持、关闭和暂时失败。没有用量的新会话应合法隐藏，不能直接标异常；原生已有用量但发现失败时则必须给出原因。避免引入与现有能力表平行的状态系统，复用现有状态及诊断结构。后端 `/backend/status` 默认不复核注入，出现“启动后复核注入状态”的 `unknown` 不单独作为新缺陷。

## 全部主要功能的覆盖与边界

| 功能面 | 本次结果 | 后续处理 |
| --- | --- | --- |
| 启动、CLI 包装器、控制台入口 | 当前进程已启动，后端健康，Codey 按钮存在，设置可只读获取。 | 不需要因页面兼容问题重做启动器；完整启动失败恢复未重测。 |
| provider 只读展示与模型目录 | `openai` 目录已加载，含七个模型；目录发布记录有 1 个查询客户端和条目，结果改写已安装。可见模型控件保留 `GPT-6.1 Sol` 前缀。 | 没有切换 provider、保存目录或发真实请求；不能扩大为所有模型及认证方式已验收。 |
| 模型筛选与思考强度 | 当前资源包含原生自定义 provider 访问逻辑，离线补丁没有旧白名单零匹配错误。控件存在六档强度文本。 | 第三方目录、排序、热更新仍需修复后的原生选择器验收。不要重做已由原生覆盖的白名单逻辑。 |
| 服务档位 | `__codeyServiceTierStatus.status=ready`。旧 `isServiceTierAllowed` 页面补丁条件在当前资源不成立，但此前修复后的独立补偿已就绪。 | 未验证 Fast 请求字段及服务商实际响应；不要把旧静态分支未运行写成 Fast 已整体失效。 |
| 账号额度与多组额度 | 侧栏额度块实际可见，后端报告有官方账号；原生备用读取受第 2 项影响。 | 没有请求新的额度、切换账号或验证每个额度组。已有数据显示不证明上游全链路正常。 |
| 额度用尽后继续发送 | 已安装 JSON 与 WebSocket 处理；运行计数显示已处理 7 次额度载荷。 | 未制造额度耗尽或发送失败场景，发送解锁未最终验收。 |
| 对话用量及缓存详情 | 已确认失效，见第 2、8 项。 | 修复共同发现后验收历史、实时、缓存锚点与切换。 |
| 侧栏置顶、归档、导出、删除 | 新增导出及删除几何挂载失效；删除另有控制器问题。原生置顶、归档保留。 | 未点击真实归档或导出，不宣称原生按钮业务失败。 |
| 会话导入、轮次选择和删除 | 轮次选择按钮存在；轮次删除与导入后刷新受共同入口影响。 | 未执行导入和持久化删除；后端文件及数据库算法未以破坏性场景复验。 |
| 时间及运行状态展示 | 有原生会话行和 Codey 时间增强；完成状态补偿未安装，见第 4 项。 | 未验证所有时间、排序、隐藏运行项恢复及多窗口状态。 |
| 插件与桌面操作插件准备 | 页面插件桥接失效，见第 6 项；独立后端准备路径未执行。 | 不擅自修复市场、安装、启用插件或删除备用载荷。 |
| 提示词优化 | 当前配置关闭，页面状态为 `inactive`。 | 不列为更新导致失效；没有切换开关或外部连通测试。 |
| 子代理角色与详情标签 | Codey 的角色优化当前关闭；详情标签的共同发现入口已阻塞。 | 角色运行覆盖、Hook 与并发策略没有实测，不能说原生子代理或全部角色失效。 |
| FastCtx | Codey 内置开关关闭；本会话外部 FastCtx 工具可调用。 | 两者分别记录；不把外部工具可用视为 Codey 内置部署已验收。 |
| 消息通知 | 后端报告 0 个启用渠道。 | 未发送通知或测试渠道；关闭状态不是兼容故障。 |
| Trace、Crashpad 与 GPU | Trace 保护后端报告启用；未进行文件写入、清理或 GPU 切换验证。 | 不从状态字段推导磁盘保护和 GPU 模式全部生效。 |
| 宠物精简与完全访问提示 | 页面盾脚本存在，宠物精简开关为启用；宠物设置资源的离线改写有命中。 | 没有切换设置或创建宠物；可见场景未全验。 |
| 中文与周期性能补丁 | 部分失效，见第 5、7 项。 | 保留仍生效的语言补偿，先确认优化仍有必要。 |

## 验证方法、结果与缺口

1. 使用当前进程 CDP 只读读取页面、能力发现、元素计算样式、按钮几何和命中、语言快照、模型目录及服务档位状态。实际探测七个能力入口，直接读取原生已有用量。所有短连接完成后关闭；没有模拟点击、安装控制器、重载或真实删除。
2. 只读解析当前 `app.asar`，枚举 15475 个页面 JavaScript 资源，按功能标识定位当前实现；没有解包写回官方目录。将仓库 `renderer_asset_patch.js` 放入隔离 Node 虚拟机，对现有固定资源候选执行真实文本改写，并另核对新语言初始化资源。当前 `app-initial` 仅命中三项请求与结果跟踪补丁，`app-shared` 命中一项发送前跟踪补丁；宠物设置路由也有改写。没有错误日志不等于所有功能补丁均已尝试，外围条件跳过需要另查。
3. 在 Windows Node `v24.19.0` 执行 `node --test --test-reporter=spec tests/session-delete-ui.test.mjs tests/renderer-asset-patch.test.mjs tests/codex-renderer-patch.test.mjs tests/plugin-marketplace-fix.test.mjs`，报告 38 项通过。测试替身仍偏向旧本地管理器和可改桥接；通过不证明新版 RPC、冻结桥接或实际 CSS 命中兼容。
4. 同时加上 `tests/composer-usage.test.mjs` 执行，报告 82 项、80 通过、2 失败。串行复跑仍为 2 失败；隔离两个用例时 1 通过、1 失败。失败分别为第 534 行期望 `unknown:no-usage`、第 560 行期望 `unknown:failed`，实际值为空。用例使用零延时缩放和有限次等待，存在计时敏感迹象，但没有完成确定性根因证明。不得将测试失败写成当前 `CH` 消失的原因，也不得报告全绿。建议后续用可控时钟或等到明确重试结束的状态核验，单列处理。
5. 未构建或运行完整 Rust 检查，因为本次交付只含诊断资料。未验证真实发送、上游服务档位、真实删除、通知送达、插件安装、重启后的行为及其他平台。首次流程咨询超时；第二次流程咨询返回交接建议，已采纳其分项证据与验收边界要求。流程建议不替代独立功能验收。

## 修复批次与验收安排

以下每批均由修复者执行本地检查，再由 Windows 验证者确认实际产物及真实客户端结果。每批结束保存命令、实际结果和未验项；仅模拟测试通过时保持运行验收待定。

| 批次 | 范围与可执行检查 | 完成条件与停止条件 |
| --- | --- | --- |
| 一 | 同时修复侧栏布局，以及管理器发现和用量订阅。执行 `node --test tests/session-delete-ui.test.mjs tests/composer-usage.test.mjs`；在 `tests/session-actions-browser.mjs` 增加当前 `contents` 层级和真实命中检查；运行本文附带探针。 | 原生有用量时 `subscribed=true`、`storedUsageRead=ok` 且显示 `CH`，侧栏按钮位置及命中正确。发现不唯一、主机不符或数据归属不明时停止，不启用写操作。 |
| 二 | 适配异步控制器的删除、刷新、MCP 与详情标签；为真实异步 RPC 形态增加测试，不预装控制器绕过发现。 | 先只读确认能力，再经具体授权用可丢弃会话检查释放后持久化删除、末尾撤回、中间轮删除、继续发送、重开与多窗口。没有安全契约的操作保持不可用。 |
| 三 | 重新评估完成状态补偿，修复语言入口及资源覆盖、插件结果适配和真实状态报告。执行 `node --test tests/codex-renderer-patch.test.mjs tests/renderer-asset-patch.test.mjs tests/plugin-marketplace-fix.test.mjs`，补充冻结对象与新资源条件的失败用例。 | 实际请求路径被覆盖，失败不会报成功；语言首次启动及聚焦均不再请求废弃接口。插件安装和市场写入须另获当前任务授权。 |
| 四 | 核实周期采样优化是否必要，处理仍有价值的过时条件，归档原生已覆盖的旧补偿。 | 用当前真实资源唯一匹配，并对需要的性能结论测量；未测量时只报告补丁应用状态。 |

后续构建遵循目标仓库当前打包文档及授权规则。包由用户安装；本次没有授权提交、推送、触发远程构建或安装。按[用户配置只读决策](../adr/0002-user-config-is-read-only.md)保持 `config.toml` 与认证文件不变。实现变化后同步[内部开发文档](../../INTERNAL_DEVELOPMENT.md)，用户可感知能力变化才更新[使用说明](../../README.md)。

## 重复探测及交付文件

在当前运行 Codey 的 Windows 主机，用具有原生 WebSocket 的 Node 执行：

```bash
node docs/handoffs/2026-10-26-codex-compatibility-probe.mjs 9229
```

WSL 保存脚本后，从 Windows 仓库运行时可使用脚本的 `\\wsl.localhost\Ubuntu\<仓库路径>\docs\handoffs\2026-10-26-codex-compatibility-probe.mjs` 完整路径。这是读取脚本，不是从 WSL 共享目录构建。探针返回 JSON，不输出会话标题、正文、账号邮箱或凭据；发现调用只更新 Codey 自身的能力缓存。原生查询仅为主机与当前会话已保存用量，产生的临时 RPC 查询句柄在结束后释放。

脚本通过语义标识重新发现新版解析器，不依赖当前压缩导出名。它是一份针对当前迁移边界的诊断工具；未来资源再次改变时，找不到候选不代表原生能力不存在。修复后必须同时确认真实业务结果，不能只看探针可用字段。

同目录 [探针结果](2026-10-26-codex-compatibility-evidence.json)保存本次最终复测。旧交接 [26.1013 兼容性审计](2026-10-18-codex-compatibility-audit.md)、[会话删除发现](2026-10-18-session-delete-discovery.md)和[服务档位修复](2026-10-19-service-tier-base-error.md)仅提供历史背景；它们已经实施或改变的条目不能重新当成本次未修缺陷。
