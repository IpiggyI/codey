# 发送消息后丢失快速服务档位的修复交接

## 任务与状态

用户开启模型选择器中的 Fast，随后发送消息。发送后闪电图标变灰，用户报告上游网关按默认服务档位处理。目标是让用户明确选择的服务档位在发送、恢复聊天和发送后显示中保持一致。

原始交接于 2026-10-08 完成 Windows 环境的只读排查。当时已验证本地兼容缺口，尚未实施修复，也未捕获截图对应消息的完整请求链。后续源码修改与验证进展见本文末尾；安装后的真实请求链仍待验收。

本文是一次修复任务的交接证据，不替代 [领域说明](../../CONTEXT.md)、[内部开发文档](../../INTERNAL_DEVELOPMENT.md) 或现有架构决策。

## 版本与工作区

| 对象 | 已核实的值 | 证据范围 |
| --- | --- | --- |
| WSL 源码仓库 | `/home/hyy/develop/personal/GitHub/codey` | 本次写入交接的仓库。 |
| WSL 分支与基线 | `master`，`047fa22f039922c3e24708aacdb3e72ea5030233` | 写入前工作区干净，最新提交为 `release: v1.2.1`。 |
| WSL 源码版本 | `1.2.1` | 已读取 `package.json`，并核对下文三个源码入口。 |
| Windows 已安装 Codey | `1.2.0` | 已读取正在运行的 `D:\Software\Codey\Codey.exe` 文件版本。 |
| Windows Codex 桌面包 | `OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0` | 已核对正在运行的 `ChatGPT.exe` 路径。 |
| Windows 应用服务器 | `C:\Users\Shy\AppData\Local\Codey\codex-runtime\cd8c322c12d11389\codex.exe` | 进程父子关系确认经过 Codey 包装器。 |

不得把 WSL 源码版本当成正在运行的 Codey 版本。更换桌面包、Codey 可执行文件、provider 或重新启动后，必须重新核对运行证据。下文的压缩函数名和资源哈希仅适用于上述 Codex 桌面包。

## 已验证的运行证据

### 磁盘配置与进程配置不同

Windows 的 `C:\Users\Shy\.codex\config.toml` 设置了 `model_provider="official"`、`service_tier="priority"` 和 `features.fast_mode=true`。

这个名为 `official` 的 provider 实际指向自建网关，使用 `env_key`，没有启用 `requires_openai_auth`。它的名称不代表官方账号认证。

Codey 的 `C:\Users\Shy\AppData\Roaming\Codey\Codey\config\codex-cli-launch.json` 含有 `service_tier="default"`。磁盘配置的修改时间晚于启动载体及进程启动时间。

通过当前窗口的应用服务器管理器执行只读请求，得到以下结果：

| 检查 | 返回结果 |
| --- | --- |
| `config/read` | `service_tier="default"`、`model_provider="official"`、`features.fast_mode=true`。 |
| `account/read` | `account=null`、`requiresOpenaiAuth=false`。 |
| `configRequirements/read` | 没有返回明确的 `requirements.featureRequirements.fast_mode=false`。 |

这些结果证明本次运行仍采用旧的默认档位覆盖。它们不能单独证明截图中手动选择的快速档位因此丢失，也不能证明运行期覆盖机制整体错误。

### 原生档位读取会清空显式选择

当前实际加载的 `app-initial-25361a10f2bf.js` 中，内部函数 `Mq` 的导出名为 `Sdt`。原生认证读取导出 `wdt` 在两个当前 React 作用域中都返回 `null`。将当前作用域、`local`、`gpt-6.1-sol` 和显式 `priority` 传给 `Sdt`，两个作用域都得到 `null`。

这次探测只读取认证与配置，没有发送模型请求。

通过 `Debugger.getScriptSource` 检查实际执行脚本，确认原生权限函数 `cia` 仍包含以下条件：

```javascript
let n = await aia(e, t);
if (n !== `chatgpt` && n !== `personalAccessToken`) return !1;
```

`Mq` 将这个结果交给归一化函数。桌面包的 `app-shared-40678a67f0e3.js` 中，归一化函数 `yjt` 在权限参数为 `false` 时直接返回 `null`；该函数也将 `default` 转成 `null`。

当前 React 缓存还出现了 `isServiceTierAllowed=false`、`selectedServiceTier=null` 和 `serviceTierForRequest=null`，对应加载状态为 `false`。这些是发送后的当前状态，没有在用户点击前后连续采样。

### Codey 的两类补偿没有保持一致

当前窗口确认 Codey 的 `model-whitelist` 脚本已执行。源码中的界面补偿修改模型选择器组件缓存的权限结果，允许用户选择快速档位；它没有替换上述独立认证读取函数。

当前源码的发送权限补丁只匹配旧版条件 `if(auth!==chatgpt)return false`。同一个函数在当前 Codex 增加了 `personalAccessToken` 条件。使用 Node 对当前桌面包真实的 `app-initial` 脚本执行源码中的正则，匹配数量为 `0`。

WSL 仓库中的正则与此次检查的 Windows 源码相同。更新到这份 `1.2.1` 源码并不能自动消除该兼容问题。当前实际执行脚本也没有解除这项校验，但尚未核实本次主进程补丁入口为何没有覆盖它。

## 修复入口

| 入口 | 当前机制 | 接手时需要解决的问题 |
| --- | --- | --- |
| [模型选择器补偿](../../public/model-whitelist-inject.js#L1687) 的 `repairNativeFastControls` | 修改 React 缓存中的 `isServiceTierAllowed`。 | 界面补偿不能作为独立发送读取已经生效的证据。核对重新渲染和恢复聊天后的行为。 |
| [发送权限补丁](../../backend/src/codex_startup_patch.js#L834) | 正则匹配原生认证检查并替换函数。 | 以当前真实脚本建立失败检查，支持当前条件形态，并确认实际 Windows 启动路径执行了补丁。只修正正则不足以验收。 |
| [运行期覆盖生成](../../backend/src/codex_config.rs#L1715) | 将 `service_tier` 加入启动覆盖列表。 | 查清默认档位策略与运行期间用户选择的关系，再决定是否调整该键的覆盖方式。 |
| [缺省档位补充](../../backend/src/codex_config.rs#L2282) 的 `ensure_default_service_tier` | 缺少配置时补 `default`。 | 分别验证配置缺失、配置为 `priority`、配置为 `default`，不能把启动后修改文件立即生效当成既有契约。 |
| [补丁现有测试](../../tests/native-model-controls-patch.test.mjs) 与 [模型选择器现有测试](../../tests/codey-model-whitelist-inject.test.mjs) | 已有界面与请求档位的检查。 | 新检查须经过真实故障入口，不能只断言闪电可见或旧版构造字符串可以匹配。 |

上述行号以交接基线为准。源码发生变化后，以函数名及补丁标签 `service tier request entitlement` 定位。

## 修复边界与实施顺序

1. 先捕获一次用户复现，记录选择的模型与服务档位、`thread/start` 或 `thread/resume`、`turn/start`、发送后聊天状态以及上游档位。只保留必要字段，脱敏认证信息和消息内容。该复现会发送真实请求，应由用户操作或明确授权执行。
2. 沿实际入口找到第一个清空档位的位置。已有证据证明独立档位读取会清空 `priority`，但尚未证明截图对应请求必然经过这个入口。不要把修复锁死在单个正则上。
3. 在已有测试框架中加入能重现该入口的失败检查。至少包含当前认证条件、显式快速选择、默认选择和不支持快速档位的模型。验证检查在当前实现失败后，再修改源码。
4. 让界面选择与请求读取采用一致的模型支持判断。保留用户明确选择，不伪造官方认证结果，不把所有请求强制升级成 `priority`，不向不支持该档位的模型携带残留选择。
5. 核实服务档位的运行期覆盖是否需要调整。保留其他覆盖，不将“全部删除覆盖”当成修复。遵守[用户配置只读决策](../adr/0002-user-config-is-read-only.md)，不自动改写用户的 `config.toml`、`auth.json` 或官方模型缓存。
6. 在当前 Windows 启动方式下验证实际补丁与请求。遵守[移除内置路由决策](../adr/0001-remove-built-in-router.md)，保持请求由 Codex 按用户配置直接发出。

## 验收计划

交接本身只进行文档核对。下列检查由接手修复者执行，运行证据验收需 Windows 环境或用户配合。

| 检查 | 执行者与检查点 | 通过条件 |
| --- | --- | --- |
| 当前真实脚本的补丁匹配与档位读取回归 | 修复者在修改前后执行已有 JavaScript 测试。 | 当前版本分支确实被覆盖；显式选择按模型支持保留；无匹配时能定位失败。 |
| 启动覆盖生成回归 | 修复者在调整覆盖逻辑后执行相关 Rust 测试。 | 三类配置输入得到约定结果；其他覆盖与用户文件不受影响。 |
| JavaScript 静态检查与差异检查 | 修复者在实现完成后执行 `pnpm run check` 和 `git diff --check`。 | 检查通过，差异只包含本任务需要的代码、检查和权威文档。 |
| 新建聊天首次发送快速消息 | Windows 验证者在补丁生效后执行一次真实请求。 | 发送边界保留 `serviceTier="priority"`；上游请求包含 `service_tier="priority"`；发送后选择仍一致。 |
| 现有聊天继续发送与恢复聊天 | Windows 验证者覆盖继续、重新打开和恢复入口。 | 用户选择在对应入口均保持一致，没有被独立认证校验清空。 |
| 快速切回默认 | Windows 验证者或可覆盖真实入口的测试执行。 | 请求采用默认档位，显示同步恢复，不能被补丁强制升级。 |
| 切换到不支持快速档位的模型 | 修复者先执行行为检查，再核验界面。 | 界面与请求均没有上一模型残留的快速档位。 |
| 上游实际处理档位 | Windows 验证者核对响应或网关记录。 | 区分“请求了快速档位”与“实际按快速档位处理”，不能以图标或请求字段代替上游证据。 |

调用层验收应逐项记录 `thread/start`、`thread/resume` 和 `turn/start` 中实际存在的档位字段。没有经过的入口应标为未验证，不能沿用其他入口的结果。

如需 Windows 安装包，只按仓库 [Windows 打包约定](../agents/windows-pack.md) 使用 `scripts/build-windows.sh`。打包、安装、运行和上游验收是不同阶段；包构建成功不代表运行行为已修复。

实现若改变公开行为或运行机制，应在相同改动中更新适用的现有权威文档。交接文档本身不增加永久兼容策略。

## 证据边界与资料

- 用户截图证明界面从选中状态变为未选中状态；上游默认档位由用户报告，未取得该消息原始请求与响应。
- 只读探测证实当前配置、认证结果、档位读取结果及源码匹配失败，未重新发送完整截图场景。
- 未验证上游对该 provider、模型和快速服务档位的实际支持，也未验证修复后的运行结果。
- 本次 Windows 详细记录保存在 `D:\Development\Local\harness\.scratch\2026-10-08-fast-tier-diagnosis.md`。本文已包含必要证据，接手不依赖访问该路径。
- [OpenAI 服务速度文档](https://developers.openai.com/codex/speed/)与[快速处理文档](https://developers.openai.com/api/docs/guides/priority-processing)于 2026-10-08 实际读取。API 文档允许 `priority` 和 `fast` 请求快速处理；这不证明第三方网关行为。当前客户端内部已核实的快速选择值是 `priority`。

接手后的第一个动作是完成一次带档位字段的用户复现捕获，再将失败检查落到实际清空档位的入口。

## 接手进展：源码兼容修复与交付验证

以下记录于 2026-10-08 接手修复时补充，不改写前述原始排查证据。

### 已完成的源码修改

- `backend/src/codex_startup_patch.js` 的发送权限补丁兼容同时检查 `chatgpt` 与 `personalAccessToken` 的原生条件，仍支持旧版单一认证条件。
- 同一文件的界面加载补丁兼容新增的 `i?.isLoading===!0` 条件。它保留设置加载状态，只移除账号要求查询对服务档位加载状态的影响。
- `tests/fixtures/codex-service-tier.js` 保存当前桌面包的十个原生函数，逐字节核对过来源。页面函数来自 `app-initial-25361a10f2bf.js`，档位归一化函数来自 `app-shared-40678a67f0e3.js`。前者共 11,147,906 字节，SHA-256 为 `bddf0e4e79918f7157682015c598b97eb833553c036026004555f88fa0cb9d3b`。
- `tests/native-model-controls-patch.test.mjs` 在原有协议响应补丁入口中执行上述函数。新增检查覆盖无账号、API 密钥、ChatGPT 和个人访问令牌认证，显式快速和默认选择，新旧聊天的选择归一化，不支持快速档位的模型，以及配置缺失、配置快速和配置默认时的读取。

没有修改运行期覆盖生成。源码及原生读取检查表明：显式传入档位时，读取函数在访问配置前返回；缺省读取才使用启动配置或已有选择。旧启动载体中的 `default` 不能单独解释显式 `priority` 被清空。启动后修改用户文件是否立即生效仍不在已验证契约内。

### 已执行的检查

1. 修改前，`node --test tests/native-model-controls-patch.test.mjs` 在真实请求读取函数上失败：预期 `priority`，实际为 `null`，发送权限补丁匹配次数为零。
2. 修改后，相关六个 JavaScript 测试文件共 142 项检查全部通过。执行文件为 `native-model-controls-patch`、`codey-model-whitelist-inject`、`codex-renderer-patch`、`windows-startup-patch-fallback`、`startup-patch-platform` 和 `session-delete-ui`，均位于 `tests/`，后缀为 `.test.mjs`。
3. 将当前桌面包的完整页面脚本交给同一协议响应补丁入口后，整个模块语法检查通过；从处理结果取出的原生读取与选择函数通过快速、默认和加载状态检查。该整包检查另外报告了既有模型白名单与可见性补丁匹配失败，未在本次修改中处理。
4. `pnpm run check` 和 `git diff --check` 通过。没有修改 Rust 配置逻辑，没有执行 Rust 编译、Windows 打包或安装。

以上是本地函数和脚本层证据，不等于真实 `thread/start`、`thread/resume`、`turn/start` 或上游处理已经通过验收。检查未发送模型消息，未启动或终止用户应用，也未留下构建目录或临时脚本。

### Windows 启动路径的新证据与下一步

只读查询确认当前安装包仍是 `OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0`。其 `chrome.dll` 中 Electron 开关版本为 1，状态串为 `010011001`；索引 2 的 `NODE_OPTIONS` 与索引 3 的主进程 Inspector 均为关闭状态。主程序本身不包含对应开关表。关闭的是安装包的主进程入口，不是用户的 Fast 设置，也不代表页面调试入口不可用。

本次首次运行探测没有发现 `Codey.exe`，页面调试端口 `9229` 在 WSL 与 Windows 上均不可达。用户随后说明当前 Codex 没有通过 Codey 打开，需要稍后重新通过 Codey 启动。因此，没有沿用原始交接中运行进程的结论，也没有宣称本次源码修改已经在当前 Windows 安装中生效。

用户随后通过 Codey 启动了 Codex，实机核验结果见下节。真实模型消息仍由用户操作或另行明确授权发送。

### 通过 Codey 启动后的实机核验

用户报告“已打开”后，重新确认主窗口 `app://-/index.html` 的页面调试端口 `9229` 可达。运行中的 Codey 文件版本与状态接口都返回 `1.2.0`；本地修改仍属于尚未打包的 `1.2.1` 源码，不能混为同一产物。

- Codey 状态接口返回 `startupInjectionMode=cli_fuses_disabled`、`performanceStatus=ready`。这表示应用正常启动，但只有命令行包装入口，主进程资源补丁没有应用。
- 页面确认 `model-whitelist` 等 Codey 脚本已执行。通过 `Debugger.getScriptSource` 读取实际执行脚本，`cia`、`qfi` 和 `Mq` 仍保留原生认证和档位读取逻辑。
- 当前应用服务器的 `config/read` 返回 `service_tier=default`、`model=gpt-6.1-sol`、`model_provider=official`、`features.fast_mode=true`；`account/read` 返回 `account=null`、`requiresOpenaiAuth=false`；没有明确的 `fast_mode=false` 要求。
- 通过真实 React 作用域调用已加载模块的原生读取函数 `Sdt`：显式传入 `priority` 返回 `null`；传入 `default` 也返回 `null`。只读调用复现了快速档位清空，没有调用模型发送接口。
- 当前可见会话行标记为 `local`，行内只有“聊天操作”和“置顶聊天”按钮，没有 Codey 的导出、删除按钮，也没有行内归档按钮。

重新启动 Codey 没有消除已验证的独立读取缺口。现有两个正则修改只能修复可应用主进程补丁的启动路径，尚未完成当前 Windows 路径的修复。

### 页面兼容入口的可行性探测

这些探测没有替换 Codex 业务函数。所有临时断点、调试域、拦截设置、远程对象和连接均在探测后释放。

1. 当前协议声明存在 `Debugger.setScriptSource` 的 `dryRun` 参数，描述为不实际应用修改。实机对该检查返回 `setScriptSource functionality no longer available`，因此不能采用整份脚本更新方案。之前 Node 环境的成功探测不适用于这份桌面运行时。
2. 对带唯一查询标记的页面脚本执行文本读取，分别启用响应阶段和请求阶段的 `Fetch` 拦截。读取成功，网络事件可见，但没有进入 `Fetch.requestPaused`。这只验证了该自定义协议资源的文本读取路径，没有测试页面重载后的模块加载拦截。
3. 在独立测试闭包中，用函数调用断点暂停，通过 `Debugger.evaluateOnCallFrame` 重新绑定测试函数，再恢复执行，返回值从预设的假值变为真值。该测试没有接触 Codex 的业务函数。
4. 对原生 `Sdt` 的默认档位读取设置一次函数断点，暂停后只读检查作用域。作用域链包含模块作用域，并可读取 `cia`、`qfi`、`whi` 三个函数。随后移除断点并恢复，读取仍返回 `null`。未对这些函数赋值。

剩余方案是在现有页面调试连接中增加服务档位专用补偿，替换独立权限读取，并让界面结果继续遵守原生模型档位归一化。实现需覆盖首次注入、页面重载和重新连接；仅在识别出支持的原生函数形态后处理，失败沿用现有状态与日志机制报告。不得伪造官方认证，也不得将默认选择改为快速选择。

此阶段的实机证据限于独立闭包重绑定和原生模块作用域可读。用户随后明确要求在 Codey 源码中完成修复并重新打 Windows 安装包，因此实施与打包已有授权；不以修改当前本机进程作为交付。真实请求链与上游处理档位继续保持未验收状态。

### Work 模式会话按钮差异

`public/codey-inject.js` 的 `installSessionExportButtons` 与 `installSessionDeleteButtons` 都先调用 `findArchiveControl`，只有在会话行内找到归档按钮后才添加增强按钮。该函数仅检查行内按钮的无障碍标签、标题、测试标记、动作标记和文字。归档位于三点菜单时，不满足这一前提。

当前桌面包的 `app-initial-25361a10f2bf.js` 中，原生会话行函数 `fUo` 用 `fe=J(de??jj)===\`work\`` 判断 Work 模式，用 `pe=fe||i` 启用操作菜单，并将 `wt=pe&&!fe&&!Ct` 传给操作组件的 `retainArchiveAction`。Work 模式使这个值为假，因此原生布局主动将归档收进三点菜单。

Codey 源码没有按 Codex 或 Work 模式主动隐藏导出、删除按钮的开关。结论分为两层：三点菜单属于 Codex 的原生模式设计；Codey 没有适配该布局，导致导出和删除快捷按钮缺失。本轮没有修改会话按钮。通过 Codey 启动后的实际页面结构已确认满足上述遗漏条件。

### 页面兼容入口的实现与验证进度

`backend/src/cdp/service_tier.js` 识别原生模块中的独立读取、权限控件和选择控件；`service_tier.rs` 通过现有页面桥接执行安装。安装时用条件为假的函数调用断点，在原生模块词法作用域中替换绑定，页面不会因该断点暂停。读取保留配置继承，并对快速档位执行原生模型校验。识别或安装失败通过内部注入状态和错误日志报告，不伪造成功。

已有主进程补丁与页面入口可组合；页面重载通过现有新文档脚本重装，桥接更换后重新检查；旧桥接的异步完成只更新旧状态。准备、连接和清理均有时间预算，清理后关闭本次连接。

2026-10-08 重新只读检查完整的 11,147,906 字节模块，生成表达式并通过语法检查。实机性能资源记录中没有模块条目，但页面预加载链接仍包含该模块；定位代码已兼容两种来源。对实机执行准备步骤返回真实作用域、独立读取函数及 4,894 字节表达式，没有应用表达式或发送模型请求。

主会话负责以下验收批次，记录最终结果后再进入独立审查与打包：

| 检查 | 范围 | 当前结果 |
| --- | --- | --- |
| `pnpm run test:js` | 全部 JavaScript 回归及新服务档位检查 | 510 项通过，18 项 Windows 专用检查跳过，无失败。 |
| `pnpm run check` | 原有脚本语法及 TypeScript 检查 | 通过。 |
| `cargo test -p codey --lib cdp:: --locked` | 页面注入、健康检查、安装失败和超时清理 | 最终实现下 21 项通过；浏览器检查单独执行。新增命令对应的旧模拟协议夹具已同步更新。 |
| `node tests/service-tier-browser.mjs` | 生产 Rust 桥接与隔离 Chromium，首次安装、重连、重载、不兼容形态恢复 | 最终实现下通过，耗时 0.63 秒；包括另一路脚本重载，以及旧页面未完成请求成功、失败时的回调隔离。 |
| `cargo test -p codey-runtime-core --test cdp_bridge --locked` | 共用桥接注册、事件和连接生命周期 | 29 项通过。 |
| 独立只读审查 | 全部改动及上述证据 | 两次派发均被插件路由检查拦截，未开始；验收保持未完成。 |
| `scripts/build-windows.sh` | Windows 安装包构建与副本清理 | 显式指定 Go 后成功，Windows 原生编译用时 3 分 7 秒，返回 `NSIS_OK` 与退出码 0。首次因当前路径缺少 Go 在编译前退出。 |

本轮临时验证目录为 `/tmp/codey-fast-validation-JOR9GE`，Rust 输出仅写其 `target` 子目录。结果摘要已保存在本文；收尾确认进程结束后，已清理该目录、测试日志、下载归档与本任务的 `dist-overlay`，并核对没有残留。未授权安装、提交或推送。

隔离浏览器曾在重载检查中失败：首次安装和重连成功，重载后页面正常但没有兼容状态。进一步对同一会话分别注册新文档脚本，未调用 `Page.enable` 时重载不执行，调用后执行。已在共用 `install_bridge` 入口补齐该步骤；随后生产桥接检查通过，包含另一份同路径注册脚本的重载执行。该修复影响共用注册路径，因此同时补验运行库的桥接测试。

最终增加实际函数源码与读取资源的严格一致性校验，校验失败不会先修改其他绑定。相关五项 JavaScript 检查复验通过；新增文件语法、限定 Rust 格式与 `git diff --check` 均通过。没有改动 Windows 已安装应用的业务函数。Linux 全量 JavaScript 检查跳过的 18 项是既有 Windows 打包生命周期测试；本轮没有修改打包脚本。

独立审查两次均被 `PreToolUse` 拦截，报 `Start message with task_name, a blank line, then Route:.`，没有创建审查线程，也没有审查结论。主会话已读取插件解析规则并以小写 `role=advisor` 和规定头部重试，结果相同；没有修改或绕过插件。过程咨询随后确认可继续构建已授权的本地验证包，独立验收仍未完成。

该次咨询另指出重载时未完成请求的竞争条件。新增真实浏览器场景复现：旧页面成功结果错误地完成了新页面回调。原因是共用桥接在每个页面把序号重置为零，完成响应只按该编号查找回调。已在共用编号中加入页面独有标识，保留现有不透明字符串编号接口。当前 Windows 页面只读确认 `crypto.randomUUID` 可用；复验同时覆盖旧请求成功与失败，当前请求仍须等待自己的结果。

浏览器夹具的应用状态目录已改为其自动清理的临时目录。早先检查产生的四条 Linux 服务档位失败日志已逐条核对归属并清理，原有应用目录及旧锁文件保持原样。

本机未找到可复用的 Windows Go。通过 [Go 官方下载清单](https://go.dev/dl/?mode=json) 取得 `go1.26.8.windows-amd64.zip`，SHA-256 核对为 `b92c3b2adae85a11ba71fe7216daf0d84e82af4c8ab6c5625807f28622043a59`，解压后的 `go version` 返回 `go1.26.8 windows/amd64`。经唯一脚本传入 `-ComputerUseGo C:\Users\Shy\AppData\Local\Temp\codey-fast-tools-20261008-JOR9GE\go\bin\go.exe` 重试打包，没有改系统路径。该临时工具目录已确认无占用、无重解析点后清理，下载归档也已清理。历史 `codey-windows-pack\app-20261003-020823783` 不属于本任务，保持原样。

### 本地验证包

- 安装包：`C:\Users\Shy\Downloads\Codey-1.2.1-local-20261008-182345832-windows-x64-setup.exe`。
- 大小：28,355,329 字节。
- SHA-256：`829498f32435f410f2e27b941ce4161d18f993c23109d7d2bf5a5f5137b04a64`。
- 构建期间已逐字节核对副本中五个生产文件与最终工作区一致：主进程补丁、`cdp.rs`、服务档位 JavaScript 与 Rust 模块、运行库桥接。构建后没有修改产品源码。
- 页面资源构建报告两个既有 CSS 空选择器警告；编译和安装包生成成功。
- 尚未安装，未提交或推送。安装后的真实新聊天、恢复聊天、默认模式及上游 `service_tier` 仍待用户验收。独立只读审查因插件拦截未开始，不能将本地验证包宣称为完整验收通过。
- 打包脚本已自动清理本次 NTFS 源码和编译副本；主会话再次核对路径不存在。共享依赖缓存、安装包及历史其他任务目录保留。

## Work 会话按钮修复（2026-10-08）

用户安装前述本地包后确认“fast 模式已生效”，随后报告 Work 仍只有菜单和置顶，并授权继续修复。该反馈确认了用户观察到的 Fast 效果；没有增加上游请求字段的抓包证据。

当前 Windows 页面只读核对：菜单按钮所属原生操作组件有 `archive`、`getMenuItems`、`retainArchiveAction: false`；原生操作条只有菜单和置顶。读取实际桌面包又确认远程及待建工作树的 `yUo` 同样转交给 `FBo`。修复以这些属性识别入口，不依赖压缩函数名。复用操作组件持有的归档回调，保留原生确认流程；不调用更外层的底层归档方法。未点击真实会话的归档或删除，也未改写已安装页面的函数。

`public/codey-inject.js` 在同一安装入口补齐 Work 行内归档，然后复用导出、删除按钮。原生置顶与菜单节点均由 React 继续管理。悬停时显示置顶、导出、归档、删除；菜单按钮在键盘聚焦或打开时显示，右键菜单保持可达。点击归档时读取当前已提交的 React 分支；禁用、忙碌或动作缺失时不调用旧回调。切回原生行内归档布局及卸载脚本时清理新增节点与菜单样式。

验证进度：

- `tests/session-delete-ui.test.mjs` 先新增 Work 复现检查，修改产品前 3 项失败，其余 19 项通过；修复后 22 项全部通过。
- 完整 JavaScript 检查为 532 项，其中 514 项通过、18 项 Windows 专属夹具按环境跳过，失败为零。`pnpm run check` 通过。
- 隔离 Chromium 使用真实 React 渲染受控夹具，已覆盖四按钮顺序与不重叠、置顶、原生归档确认、更新回调、导出会话标识、删除确认和右键及键盘菜单。夹具只记录动作，不调用用户真实会话。
- 自动扫描、模式切换、忙碌状态恢复和卸载重装的浏览器补验通过；同一检查使用构建后的注入脚本复验也通过。侧栏与增量扫描的 32 项检查全部通过。`git diff --check` 和产物语法检查通过。文档无专用校验器，已检查变更范围及表述一致性。
- 本次通过唯一脚本传入临时 Windows Go 1.26.8 开始打包。官方归档 SHA-256 与前述记录一致，`go version` 通过；未修改系统路径。构建副本中的六个相关生产源码及 `dist-overlay/inject/codey-inject.js` 与工作区逐字节一致。
- Work 源码 SHA-256：`1e80bdf06a401f055fe8f8344a07e8a281f153c3b4793576594dc0a921cf6991`。构建后的注入脚本 SHA-256：`a83f8e5ae4d7b34a25c2fa5fbbd314e74263a616f3002ff2e9bd87f4ad285cef`。
- Windows 打包脚本返回 `NSIS_OK`，退出码为零；两个既有 CSS 空选择器警告仍存在。生成包后再次核对前述七个文件的哈希，产品源码和构建资源均未变化。真实安装效果待用户验收。

### Work 本地验证包

- 路径：`C:\Users\Shy\Downloads\Codey-1.2.1-local-20261008-185544947-windows-x64-setup.exe`。
- 大小：28,421,258 字节。
- SHA-256：`1316e9f2758cb9211a68956d268c17be3a2f753f2727290e144dd9d95d2cf95c`。
- 保留前述 Fast 修复，并包含 Work 按钮源码改动。没有安装、提交或推送。
- 过程咨询要求核对打包成功、源码一致性、交付记录和清理，并保留实机验收边界；上述交付核对已完成。
- 打包脚本已清理 `C:\Users\Shy\AppData\Local\Temp\codey-windows-pack\app-20261008-185544947-4112f1d6fe1e4fd6bf33d86504021354`，主会话确认该路径不存在。确认相关进程结束后，临时 Go 目录 `C:\Users\Shy\AppData\Local\Temp\codey-work-tools-D49aUq`、验证目录 `/tmp/codey-work-actions-D49aUq` 和本轮 `dist-overlay` 均已清理并核对不存在。安装包、共享缓存和其他任务目录保留；必要证据已汇总于本文。

### Work 实机复验与修正

用户安装 `185544947` 包后报告仍只有菜单和置顶。实机只读确认新适配入口已加载，当前 20 条会话均没有新增按钮。原生动作、加载状态与禁用状态正常；菜单到 React 根节点实际有 312 层，操作组件在第 27 层、会话行在第 29 层（从零计数）。上一实现只向上寻找根节点 80 次，因此在检查当前分支前就退出。上一浏览器夹具只有浅层组件树，没有覆盖实机层级。

已将既有单元和真实 React 浏览器夹具调整为 312 层：旧产品代码下单元检查 3 项失败、19 项通过，浏览器在等待新增归档按钮时超时。随后用访问集合检测循环，移除根节点和动作搜索的固定层数上限；继续校验当前已提交分支，动作搜索仍在会话行处停止。侧栏与增量扫描检查 32 项通过，完整浏览器场景通过，覆盖确认、当前回调、模式切换、键盘与菜单访问、卸载重装。

实机对照在同一次只读求值中执行工作区的识别函数：旧版匹配 0/20 行，修正版匹配 20/20 行。没有调用归档回调或安装新脚本，原页面仍保留两个按钮。这项证据验证识别入口；新包安装后的可见效果仍须单独验收。

复验完整 JavaScript 检查为 532 项，其中 514 项通过、18 项 Windows 专属测试按环境跳过；`pnpm run check`、源码及构建后脚本语法检查、`git diff --check` 通过。312 层浏览器夹具对源码和构建后的注入脚本均通过。Windows 打包中的七个相关文件与最终工作区逐字节一致；源码 SHA-256 为 `38a702e755cc970c777c80ca3e1cbc512f6a668266b2d7611d25b97a49d2399c`，构建后注入脚本为 `4641988acc1bd3eb3ce2215c739bf86a75be8cf6a60ec30130f0c6c6b813eb74`。

修正版安装包为 `C:\Users\Shy\Downloads\Codey-1.2.1-local-20261008-191522493-windows-x64-setup.exe`，大小 28,366,137 字节，SHA-256 为 `c751b4330324184e69ab6072b027209695ce5ef3cb8223cc376060bf34c988fb`。使用唯一脚本与临时 Windows Go 1.26.8 构建，官方归档哈希及原生工具版本均已核对；两个既有 CSS 警告仍存在。产物生成后，七个相关文件的工作区哈希仍与打包时相同。

打包脚本输出 `NSIS_OK` 并以零退出。确认进程结束后，已核对本次 `app-20261008-191522493-fe64ba64772a48d8a7ebac1bc313932b` 编译副本不存在；临时 Go 目录 `C:\Users\Shy\AppData\Local\Temp\codey-work-tools-Kcl4jU`、验证目录 `/tmp/codey-work-live-Kcl4jU` 和 `dist-overlay` 也已清理并核对。保留安装包、共享缓存及其他任务目录。过程咨询的交付与清理建议已执行；没有安装、提交或推送。新包的实机可见效果等待用户验收。

## 侧栏整会话删除接口修复（2026-10-08）

用户确认四个按钮已经出现，但删除两个月前的会话时收到“Codex 尚未释放会话，未执行删除，请稍后重试”。实机调用既有能力发现入口（不调用删除或释放）复现 `codey_capability_unavailable`，当前页面没有可用会话控制器。错误发生在取得接口之前，不能归因于历史会话的年龄。

只读检查 `app-shared-40678a67f0e3.js`：旧 RPC 解析器无匹配，本地注册表解析器可取得 `local` 管理器，具有 `discardConversationFromCache`、`handleThreadDeletion` 和 `refreshRecentConversations`。已有实现只在 `deleteMessages` 功能启用注册表入口，导致侧栏整会话删除以及独立的刷新能力漏接。React 作用域查找在本次环境可成功，不需要再改遍历深度。

共用发现入口现优先使用已有本地注册表解析器，再保留旧 RPC 兼容；每种能力继续校验自身方法。删除之前的原生释放、切离活跃会话、确认标识、等待期间重新打开、卸载后丢弃响应等保护保持原约束。界面区分接口不可用、释放失败和释放超时，不再把接口发现失败报告为尚未释放。

`tests/fixtures/codex-session-discard.js` 中的 `discardConversationFromCache` 和 `vin` 与上述当前安装包函数逐字节一致。原生释放会查询缓存；未加载的持久会话仍通过 `thread/unsubscribe` 释放，成功之后才驱逐缓存。隔离夹具将 `getConversation` 设为 `null`，记录释放、缓存驱逐、持久化删除、删除通知和刷新顺序；释放拒绝与超时时不进入持久化删除。没有对用户真实会话调用释放或删除。

新增检查在修改产品前失败；修复后 145 项相关检查通过，全量 JavaScript 为 519 项通过、18 项 Windows 专属检查按环境跳过。`pnpm run check`、语法检查和 `git diff --check` 通过。新发现代码在实机隔离作用域只读执行，返回 `local` 管理器及三个完整方法，原页面接口没有被替换。

整会话删除需要独立只读复核。按编排技能派发 `review_session_delete`，请求 `ca_advisor_crux_m`、`gpt-6.1-sol`、`xhigh`，模板只读校验通过；前置路由校验却以 `Start message with task_name, a blank line, then Route:` 拒绝派发，未启动审查线程，实际模型及审查行为无从核实。没有绕过插件，独立验收仍未完成。继续执行用户已授权的本地打包，不能把主会话检查当成独立通过。打包及清理结果见下节。

补充核对：以空的局部控制器缓存独立发现 `refresh` 能力，在实机同样返回本地管理器，原页面接口未变化。错误提示补验区分原生拒绝和超时，侧栏检查共 27 项全部通过。产品源码 SHA-256 为 `0c11dfeb09125894cc04f91c76c3597b4bd3a728aeead455ea69b9b661bd71cb`。

Windows 构建副本的七个相关源码及资源与工作区逐字节一致。构建后会话注入脚本 SHA-256 为 `e1686e6a993d4a5a011b95edc801ca8c2c35426e241b3ba3296e502ab57018c4`，语法及隔离浏览器检查通过。原有 Fast 和 Work 按钮改动保留。验证没有调用用户真实会话的释放、删除或归档。

### 删除接口修复验证包

- 安装包：`C:\Users\Shy\Downloads\Codey-1.2.1-local-20261008-194506266-windows-x64-setup.exe`。
- 大小：28,376,273 字节。
- SHA-256：`6f7f81af80853de645331f746d8814f1a171bd30ae6dc0952258cd64a1dc0660`。
- 唯一打包脚本输出 `NSIS_OK`、退出码零；构建过程中仍有两个既有 CSS 警告。原生 Go 1.26.8 的版本和官方归档哈希均已核对。安装包生成后，七个相关源码和资源的哈希仍与构建副本一致。
- 过程咨询确认可以交付已授权的本地验证包，并保留真实历史删除及独立验收未完成的边界。没有代安装、提交或推送。
- 打包脚本已清理 `C:\Users\Shy\AppData\Local\Temp\codey-windows-pack\app-20261008-194506266-374612dc4d734df3b3b24493b4409922`，主会话核对路径不存在。临时 Go 目录 `C:\Users\Shy\AppData\Local\Temp\codey-delete-tools-fnsk15` 已通过路径和占用检查后清理。确认相关进程结束后，验证目录 `/tmp/codey-session-delete-fnsk15` 与本轮 `dist-overlay` 均已清理，四处路径已核对无残留。清理前再次核对七个源码和资源哈希一致，安装包大小及 SHA-256 与上述记录一致。保留安装包、共享缓存及其他任务目录；必要验证证据已汇总于本文。

## 用户验收与 1.2.2 发布收尾

2026-10-08，用户在取得删除接口修复包后确认“完美！”，并明确授权提交、版本号递增、推送及打标。结合此前对 Fast 生效和 Work 四按钮出现的确认，本次用户验收通过。没有补充真实请求链或上游档位的抓包证据，也没有把主会话检查视作独立复核；前述插件阻断记录仍有效。按用户明确授权继续发布。

本次发布版本为 `1.2.2`，标签为 `v1.2.2`。版本同步到 `package.json`、`Cargo.toml`、`Cargo.lock` 的三个工作区包及 `README.md`，外部依赖锁定内容保持不变。发布前远端 `master` 与本地基线 `047fa22` 一致，目标标签不存在，待提交范围仅包含本次修复、验证、文档及版本元数据。

发布检查通过：`pnpm install --frozen-lockfile`、`pnpm run check`、`pnpm run test:js`、`pnpm run vite:build`、`cargo fmt --all -- --check`、`cargo test --workspace --locked`、`cargo clippy --workspace --all-targets --locked -- -D warnings`。JavaScript 为 519 项通过、18 项 Windows 专属检查跳过；Rust 为 1,228 项通过、3 项忽略，忽略项为已有的两项性能基准及服务档位浏览器入口，后者复用前述隔离浏览器验证结果。前端构建仍有两个既有 CSS 警告。版本元数据和锁文件范围检查通过，已验收的会话注入源码哈希保持一致。

发布检查的 Rust 输出和编译目录均限定在 `/tmp/codey-release-1.2.2-pbfry1ik/target`。确认相关进程结束后，该目录和本轮 `dist-overlay` 已清理并核对无残留；检查摘要保存在本文。提交与远端发布结果另记录在本地任务记忆，安装包及共享依赖缓存保留。
