# 侧栏会话删除不可用的修复交接

## 状态与范围

2026 年 10 月 18 日完成 Windows 实际页面的只读诊断。原因已定位；修复已合入 `master`（`26b31550`），实施与验收情况见「实施状态」。本文交接给 WSL 仓库后续实施，不授权执行真实删除、安装、部署或提交。

用户操作 Codey 提供的整会话删除时，收到“删除失败：当前 Codex 的会话删除接口不可用，未执行删除”。本次问题属于侧栏整会话删除的接口发现失败，与指定轮次删除的数据一致性问题分别处理。

## 结论

Codey 能找到并加载当前 Codex 的资源文件，但管理器发现逻辑仍要求模块导出特定注册类或旧 RPC 函数。当前 Codex 未导出该注册类，另外两条既有发现路径也未匹配到入口。因此，Codey 无法取得会话控制器，将删除能力判为不可用，并在后端持久化删除前拒绝操作。

当前 Codex 仍保留释放会话和删除通知所需的方法。诊断通过只读查询 React 状态取得了真实本地管理器，确认方法存在。不能将本次提示解释为 Codex 移除了相关方法，也不能解释为数据库删除失败。

## 版本基线

| 对象 | 本次核实结果 |
| --- | --- |
| Windows 仓库 | `D:/Development/GitHub/codey`。诊断基线为 `31fe3f2464c6d842002c2e2d252b852acc1ce4df`，`package.json` 为 `1.3.0`。 |
| WSL 仓库 | Ubuntu 中的 `/home/hyy/develop/personal/GitHub/codey`。保存前提交同为 `31fe3f2464c6d842002c2e2d252b852acc1ce4df`，远端为 `git@github.com:IpiggyI/codey.git`。 |
| 两侧源码比对 | `public/codey-inject.js` 和 `tests/session-delete-ui.test.mjs` 在统一换行后文本完全相同。Windows 为 CRLF，WSL 为 LF。不能用原始文件摘要不同推断功能差异。 |
| WSL 原有改动 | 保存前 `git status --short` 只有未跟踪的 `.scratch/`。本次保留，不读取或清理其内容。 |
| 运行中的 Codey | `D:/Software/Codey/Codey.exe`。未读取其产品版本，也未证明整个可执行文件与仓库产物一致；相关运行中发现函数的关键判定已逐项核对。 |
| 运行中的 Codex | `C:/Program Files/WindowsApps/OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0/app/ChatGPT.exe`。本次读取时主进程 PID 为 `97804`，CDP 端口为 `9229`。商店包版本不等同于应用显示版本。 |
| 实际页面资源 | `index-a092859c3d97.js`、`app-shared-bbfeca5e5737.js`、`app-initial-5851df3f6cb1.js`，均由实际页面的 `app://-/assets/` 地址读取。 |

上述进程、端口、资源散列名及压缩符号只适用于本次运行。后续开始修复前重新探测，不能沿用为固定接口。

## 已验证的证据链

1. 实际注入页面的 `window.__codeyCodexSessionController` 为空，`window.__codeyCodexSignalDispatcher` 为 `undefined`。页面的 `session`、`sidebarDelete` 和 `reconcile` 能力记录均为不可用。本次没有逐项执行后两者之外的业务操作，不能据此扩展为所有会话功能失效。
2. 调用 `await window.__codeyLoadCodexSessionController({feature:'sidebarDelete'})`，返回错误代码 `codey_capability_unavailable`，消息为“当前 Codex 暂不支持此功能，请稍后重试”。这一步只运行能力发现，不释放或删除会话。
3. 从实际入口源码调用 `window.__codeyCodexAssetReferencesFromSource(source, entryUrl)`，成功发现上述 `app-shared` 和 `app-initial` 模块，排除本次运行中资源名称发现失败。
4. 对两个实际模块分别调用已有的 `__codeyAppServerManagerRegistryResolverFromModule`、`__codeyAppServerManagerResolverFromModule` 和 `__codeySignalDispatcherFromModule(module, false)`，结果均为空。
5. 当前 `app-initial` 源码内部仍存在注册类 `Okl`，包含 `getAll`、`getForHostId`。导出表没有导出 `Okl` 或其初始化函数 `kkl`。现有注册表解析器只遍历模块导出的函数及其原型，因此无法匹配内部注册类。
6. 本次资源把管理器状态键 `QO` 导出为 `G6n`。调用既有 `window.__codeyAppServerManagerFromReact((scope, host) => scope.get(module.G6n, host))`，在第一个候选作用域取得管理器。其 `getHostId()` 为 `local`，构造函数为 `Hfn`。此路径只查询状态，没有把结果安装到 Codey 控制器，也没有绕过能力判定来执行删除。
7. 对该真实管理器读取属性描述符，确认 `discardConversationFromCache`、`handleThreadDeletion`、`sendRequest`、`refreshRecentConversations` 都是原型上的函数。读取函数体确认 `discardConversationFromCache` 仍先等待原生释放操作，再清理会话缓存；没有执行该方法。
8. 运行中的 Codey 发现函数经过压缩，无法与仓库源码逐字匹配。读取函数体后确认关键条件一致，包括导出函数检查、`getAll`、`getForHostId`、`.scope.get(`、旧 RPC 错误文本和 `.forHost(`。

## 实施入口

| 文件 | 基线行号与作用 |
| --- | --- |
| [页面注入脚本](../../public/codey-inject.js) | 第 2036 行的 `discoverCodexAppAssetUrls` 负责资源发现；本次运行中该环节正常。 |
| [页面注入脚本](../../public/codey-inject.js) | 第 2099 行的 `appServerManagerResolverFromModule` 匹配旧 RPC 函数。第 2252 行的 `appServerManagerRegistryResolverFromModule` 只检查导出的注册类。 |
| [页面注入脚本](../../public/codey-inject.js) | 第 2447 行的 `managerSessionController` 包装原生方法；第 2468 行按具体功能校验能力；第 2505 行的 `discoverCodexSessionController` 串起各条发现路径。 |
| [页面注入脚本](../../public/codey-inject.js) | 第 2744 行的 `unsubscribeNativeSidebarSession` 在能力失败时包装出用户提示；第 3245 行先等待释放，第 3252 行随后才会调用 `/session/delete`。 |
| [侧栏删除测试](../../tests/session-delete-ui.test.mjs) | 第 261 行的模块替身显式导出 `Registry`；第 590 行覆盖接口不可用时拒绝持久化删除。 |
| [内部开发文档](../../INTERNAL_DEVELOPMENT.md) | 第 98 行描述会话管理器发现及删除前释放保护。实现变化后同步维护，不创建平行的机制说明。 |

行号对应上述基线。后续以函数名重新定位。

## 已执行的验证与缺口

在 Windows 仓库执行以下命令，分别得到 1 项通过和 27 项通过：

```bash
node --test --test-name-pattern='reports unavailable deletion support separately' tests/session-delete-ui.test.mjs
node --test tests/session-delete-ui.test.mjs
```

前一项验证实际注入脚本会显示接口不可用提示，并且不调用 `/session/delete`。整组测试验证现有模拟场景；其注册表替身仍导出 `Registry`，没有覆盖当前真实资源不导出注册类的情况，不能作为当前 Codex 兼容的证明。

没有执行真实会话释放或删除，没有写会话数据库，没有构建、安装、重启或发送模型请求。运行时只读探针使用的 WebSocket 已关闭。本次测试没有产生需要保留的编译或测试中间产物。

## 修复约束与验收

1. 修复者先重核当前 WSL 源码、目标 Codex 资源和实际导出结构。若任一基线已变化，先判断本结论是否仍成立。
2. 在现有管理器发现路径中适配当前结构。先复用现有原生入口和 React 作用域发现能力，再决定最小实现。`G6n`、`QO`、`Okl` 和 `Hfn` 仅用于本次证据定位，不能硬编码为跨版本契约。
3. 增加能在旧实现上失败的覆盖：注册类未导出，但真实管理器及所需方法存在。检查必须经过实际发现和能力校验链，不能直接预装控制器来绕过故障点。
4. 保留释放成功后才允许持久化删除的顺序。继续覆盖接口确实缺失、释放拒绝、释放超时、会话重新打开及页面卸载；这些情况不得进入后端删除。
5. 修复者运行侧栏删除测试及受共享发现逻辑影响的适用测试。共享入口还被轮次删除、列表刷新、完成状态同步等功能使用；检查调用契约，不能只验证按钮出现。
6. Windows 验证者确认实际运行产物后，先只读验证控制器发现和两个必需方法。经具体删除授权后，用可丢弃的隔离会话验证删除、列表同步与重新打开；原生方法存在和模拟测试通过都不能替代该验收。
7. 依照仓库约定更新内部机制说明。用户能感知到行为变化时，按需更新面向使用者的说明。构建或测试结束后清理本任务中间产物，保留必要证据。

修复验收当前待执行。本文不承诺真实删除后的服务端卸载及数据一致性已经验证。

## 实施状态

2026 年 10 月 18 日在 WSL 仓库完成实现，尚未提交，也没有构建或安装。

1. 改动：`public/codey-inject.js` 新增 `appServerManagerStateKeyResolverFromSource`。现有注册表和旧 RPC 解析器都没有结果时，它读取资源源码，从注册类 `getForHostId` 中的 `.scope.get(键,hostId)` 识别唯一的状态键，再按导出表取得导出值，或按导入表到来源资源取值。随后复用 React 作用域发现和各功能的能力校验。`tests/session-delete-ui.test.mjs` 新增导出和导入两种结构的用例；改动前两项都失败，改动后通过。`INTERNAL_DEVELOPMENT.md` 已同步。
2. 测试：侧栏删除测试 30 项通过。`node --test tests/*.test.mjs` 共 541 项通过、0 项失败、18 项按平台跳过。
3. 真实资源只读探测：Codex 仍为 `app-initial-5851df3f6cb1.js`。从仓库源码截取的新函数唯一识别 `QO`，导出名为 `G6n`。取得的管理器为 `Hfn`，`getHostId()` 为 `local`；两次读取返回同一实例；导出的主机列表包含 `local`，满足原生 `getForHostId` 的前置检查。侧栏删除所需的两个方法存在。没有安装控制器，也没有调用释放、删除或其他写操作。
4. 连带影响：同一管理器满足轮次删除的全部方法前置条件，`thread/revert` 与 `thread/rollback` 的应用方法均存在，服务版本为 `0.163.0-alpha.10.2`。修复后轮次删除会在此版本重新可用。[此前兼容性审计](2026-10-18-codex-compatibility-audit.md)第 1 项针对的“取消订阅后改写记录”已在提交 `5da10525` 改为末尾轮次走原生撤回、中间轮次确认后改写并重启 Codex，因此不随本次修复重新暴露；用户确认保持开启。完成状态同步依赖主进程补丁方法，探测中仍不存在，本次修复不会恢复该功能。
5. 原待执行：Windows 构建安装后，先只读确认已安装产物的控制器发现；经具体删除授权后，按上文第 6 项用可丢弃会话验收。
6. 验收进展：本机缺少 Windows `go.exe`，改为提交到分支 `fix/session-delete-discovery`（`26b31550`）并手动触发 Actions 运行 `39127285356` 打包，未创建 Release。用户安装该包后自行删除一个会话，报告成功。随后只读检查已安装页面：控制器类型为 `manager`，管理器为 `Hfn`、主机 `local`，侧栏删除两个方法存在，`session`、`sidebarDelete`、`refresh` 能力均为可用。删除后重新打开及多窗口情况未单独核验；修复随后快进合入 `master` 并推送。

## 关联记录

- Windows 原始证据文件为 `D:/Development/GitHub/codey/output/diagnostics/2026-10-18-session-delete.md`，WSL 可从 `/mnt/d/Development/GitHub/codey/output/diagnostics/2026-10-18-session-delete.md` 读取。本文已包含独立继续实施所需的关键证据，不依赖原文件长期保留。
- [此前兼容性审计](2026-10-18-codex-compatibility-audit.md)使用更早源码基线，包含指定轮次删除的另一类风险，不能替代本次故障的诊断。
- 流程咨询多次返回 `unsupported_content`，没有提供建议；诊断结论来自本地源码与真实页面探针，不代表已有独立审阅。
