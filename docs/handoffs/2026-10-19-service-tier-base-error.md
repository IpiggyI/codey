# 系统优化“基础异常”的修复交接

## 状态与范围

2026 年 10 月 19 日完成 Windows 实际运行页面的只读诊断。原因已定位，尚未修复。用户要求将问题记录到 WSL 侧仓库，后续另行安排修复。

本次交接只新增本文，不修改产品代码、用户配置或安装文件，不提交、推送、构建、安装、重启或发送模型请求。本文是诊断和待验收事项的记录，不替代[内部开发文档](../../INTERNAL_DEVELOPMENT.md)或[领域说明](../../CONTEXT.md)。

## 问题与直接原因

Codey 控制台显示“系统优化：基础异常”，说明文字为“基础组件运行异常，已确认生效的功能仍列于下方”，下方仍列出六项已生效功能。

实际运行页面中唯一失败项是 `service-tier`，名称为“服务档位兼容”。该组件准备阶段仍按旧源码结构查找权限函数；当前 Codex 模块完全不含旧字段 `isServiceTierAllowed`，匹配数为零，因此抛出“服务档位权限形态不兼容”。当前服务档位选择代码使用 `serviceTierAccess`。

后端发现页面异常后，丢弃原始 `exceptionDetails`，只返回“服务档位页面检查失败：Runtime.evaluate”。加载器保存失败状态，状态探针将该项记为失败，前端将内部组件失败聚合成“基础异常”。六项功能由各自状态生成，与这个告警可以同时存在。

## 版本与工作区边界

| 对象 | 已核实的值与范围 |
| --- | --- |
| Windows 源码仓库 | `D:/Development/GitHub/codey`，诊断基线为 `26b3155`。 |
| WSL 交接仓库 | Ubuntu 中的本仓库，保存前提交为 `1fe5c57bfb0415ea9a0d20ba8bd77eca087819ee`，`package.json` 版本为 `1.3.0`。 |
| WSL 原有改动 | 保存前只有未跟踪的 `.scratch/`，本次未读取、修改或清理其内容。 |
| 两侧源码关系 | 下表五个生产文件在统一 CRLF 与 LF 后文本完全相同。WSL 中仍存在本次失败的匹配规则；这不等于已在 Linux 运行环境复现。 |
| 已安装 Codey | `<安装目录>/Codey.exe`，文件版本与产品版本均为 `1.3.0`。 |
| 实际 Codex 安装包 | `C:/Program Files/WindowsApps/OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0/app/ChatGPT.exe`。日志中的应用版本为 `26.1013.40934`，不等同于商店包版本。 |
| 实际主页面 | 调试端口为 `9229`，页面为 `app://-/index.html`，目标标识为 `36033A8DC3BF3E16DD08A7F5A08C91FB`。 |
| 实际模块 | `app://-/assets/app-initial-5851df3f6cb1.js`。 |

运行中的可执行文件包含与仓库 `backend/src/cdp/service_tier.js` 逐字相同的脚本。该脚本原始字节的 SHA-256 为 `1b2ee0e2c88063cf5834fb6350e1004cf89ef77da865c84bf0f9e6e89c74ef71`。两侧文本比对已统一换行；不能把不同换行导致的摘要差异当成功能差异。

版本、进程、端口、目标标识、资源名称及压缩函数名只适用于本次采集。接手时重新发现；若应用升级、源码变化或重启，则重新核对本结论。截图中的旧安装路径不能代替实际进程路径。

## 已验证的运行证据

1. 重复读取 `window.__codeyServiceTierStatus`，结果始终为 `status: "failed"`，错误为“服务档位页面检查失败：Runtime.evaluate”。`window.__codeyInjectionStatus` 中唯一失败项为 `service-tier`。
2. 只读执行实际准备脚本，未调用安装器、断点绑定或模块赋值，得到以下结果：

```json
{
  "prepare": "failed",
  "name": "Error",
  "message": "服务档位权限形态不兼容"
}
```

3. 原始堆栈依次指向 `unique`、`codeyServiceTierExpression` 与 `codeyPrepareServiceTier`。准备阶段即失败，未到达 `Session::bind`。
4. 用同一套函数提取和筛选规则检查实际模块：读取函数匹配数为 `1`，旧权限函数匹配数为 `0`，选择函数匹配数为 `1`。对模块全文搜索 `isServiceTierAllowed`，结果为零。
5. 当前选择函数 `_wo` 从 `Mxo` 取得 `serviceTierAccess`，并将访问状态传入 `Xi`。当前独立读取函数的实际源码如下：

```javascript
async function x$s(e,t,n,r){try{let i=await S$s(e,t);if(r!==void 0)return Xi(null,r,i);let a=e.get(lar,t);if(a.type!==`fromConfig`)return Xi(null,Cir(a,null),i);let{config:o}=await k_o(e,t,{includeLayers:!1,cwd:null},{priority:`critical`}),s=Eb(o);return s.service_tier==null?Xi(await C$s(e,t,n??s.model),s.service_tier,i):Xi(null,s.service_tier,i)}catch(e){return fn.error(`Failed to read service tier for request`,{safe:{},sensitive:{error:e}}),null}}
```

该片段用于辨认本次结构。`x$s`、`S$s`、`Xi`、`_wo`、`Mxo` 等名称均不能硬编码为跨版本接口。读取函数也已发生结构变化，不能将修复收敛为替换一个字段名；后续依赖匹配与补偿语义尚未逐项验证。

6. `%USERPROFILE%/.codex-session-delete/codey-errors.log` 在北京时间 `09:25:02` 记录 `service_tier_renderer` 检查失败；`09:55:21` 与 `11:02:47` 记录 `injection_script_failed`，失败项均为 `service-tier`，目标页面与实时读取一致。日志中另有 CLI 包装器握手超时，不能用该独立错误替代本次已验证的直接原因。

## 源码入口

以下五个文件均已与 Windows 诊断源码进行统一换行后的文本比对，结果相同。行号以交接基线为准；后续按符号重新定位。

| 文件 | 位置与作用 |
| --- | --- |
| [准备与补偿脚本](../../backend/src/cdp/service_tier.js) | `codeyPrepareServiceTier` 第 22 行调用源码规划器；`codeyServiceTierExpression` 第 58 行要求唯一匹配，第 64 行仍要求 `isServiceTierAllowed:`。第 67 至 94 行继续提取和替换旧依赖，不能默认仍兼容。 |
| [服务档位安装器](../../backend/src/cdp/service_tier.rs) | `Session::command` 第 61 行丢弃原始异常详情；`Session::apply` 第 83 行执行准备脚本，第 97 行才进入绑定。加载器第 23 行捕获失败并保存状态。 |
| [脚本状态采集](../../backend/src/cdp.rs) | 第 239 行注册 `service-tier` 并设为内部组件；第 245 行在失败状态下抛错。`injection_status_snapshot_script` 与 `record_failed_injection_statuses` 采集并记录状态。 |
| [状态汇总](../../src/runtimeStatusPresentation.ts) | `summarizeInjectionScripts` 第 139 行将内部组件的 `failed` 或 `unknown` 汇总为 `internalInjectionError`。 |
| [控制台展示](../../src/OperationsPanel.tsx) | 第 301 行显示基础组件异常说明，第 320 行显示“基础异常”标签。 |

## 只读复现方式

在可访问当前 Windows 调试入口的 Windows 仓库根目录，以 Node 执行下面的命令。本次已执行等价探针并重复得到相同错误。不要假设 WSL 的 `127.0.0.1` 必然指向 Windows 调试入口；先确认网络入口与目标页面。运行前重新核对脚本版本。

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
const pages = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const page = pages.find(p => p.type === 'page' && p.url === 'app://-/index.html');
if (!page) throw new Error('未找到 Codex 主页面');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const source = fs.readFileSync('backend/src/cdp/service_tier.js', 'utf8');
try {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('检查超时')), 18000);
    ws.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.id === 1) { clearTimeout(timer); resolve(value); }
    };
    ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
      expression: '(async()=>{' + source + ';try{const h=await codeyPrepareServiceTier();'
        + 'return {prepare:"ok",ready:h.ready===true}}catch(e){'
        + 'return {prepare:"failed",name:e.name,message:e.message,stack:e.stack}}})()',
      awaitPromise: true, returnByValue: true
    }}));
  });
  console.log(JSON.stringify(response, null, 2));
} finally { ws.close(); }
NODE
```

## 修复约束与验收计划

1. 修复者先核对当前 Codex 资源、导出结构及服务档位访问状态的语义。优先复用现有原生能力，再确定最小兼容修改；不要伪造成功状态或隐藏告警。
2. 在现有[脚本测试](../../tests/service-tier-patch.test.mjs)中补充当前真实结构，并先确认旧实现因权限匹配失败而失败。现有测试使用旧版[函数夹具](../../tests/fixtures/codex-service-tier.js)，已有测试通过不能证明覆盖本次结构。
3. 同时核对准备、依赖提取、模块绑定、独立读取和选择逻辑，保留用户显式选择与模型支持校验。遵守[用户配置只读决策](../adr/0002-user-config-is-read-only.md)，不自动修改 `config.toml`、`auth.json` 或官方模型缓存，不强制所有请求使用快速档位。
4. 调试命令错误应保留必要的原始页面异常，便于识别“函数匹配失败”和“调试连接失败”；记录时不得携带令牌、消息内容或其他隐私数据。

| 检查 | 执行者与检查点 | 通过条件 |
| --- | --- | --- |
| 当前结构回归 | 修复者在修改前后执行 `node --test tests/service-tier-patch.test.mjs`。 | 新用例在旧实现上因本次原因失败；修复后通过，并覆盖支持快速档位、不支持快速档位、默认选择及未知结构。 |
| 真实安装路径隔离验证 | 修复者完成实现后按现有环境运行 `node tests/service-tier-browser.mjs`，复用其 Rust 安装器检查。 | 夹具覆盖当前结构，准备与绑定成功，失败及清理路径仍有效；不能只执行默认忽略浏览器入口的 Rust 测试。 |
| 错误详情检查 | 修复者在调整 `Session::command` 后执行相应测试。 | 页面原始异常能保留必要信息，连接错误与源码不兼容可以区分；不伪造成功。 |
| 静态与差异检查 | 修复者在实现完成后执行 `pnpm run check`、适用的 Rust 检查与 `git diff --check`。 | 相关检查通过，修改范围与权威文档一致。 |
| Windows 实际运行 | Windows 验证者在获准构建、安装和重启后重新采集状态。 | `service-tier` 生效；若其他内部组件正常，控制台不再因本项显示“基础异常”；六项功能不受回归影响。 |
| 真实请求档位 | Windows 验证者在获准发送请求后覆盖新建、继续、恢复聊天和模型切换。 | 选定档位与最终请求一致；默认档位和不支持快速档位的模型不携带残留选择。请求字段与上游实际处理分别验收。 |

本次没有运行上述修复验收，没有发送真实请求，也没有逐项重做六项功能的操作验收。已确认的是兼容增强未完成安装，尚不能据此断言当前 Fast 最终生效或失效。后续需要 Windows 验证包时遵守[打包约定](../agents/windows-pack.md)，不从 WSL 共享路径编译，不将构建成功当作实机验收。

## 相关记录与交付检查

- [旧版 Fast 服务档位交接](2026-10-08-fast-service-tier.md)记录更早桌面包的故障和后续处理。其验收不能覆盖本次新结构；本文不改写旧记录的结论。
- Windows 原始诊断保存在 `D:/Development/GitHub/codey/output/diagnostics/2026-10-19-system-optimization-base-error.md`。本文已包含后续接手所需的原因、证据、入口和复现方式，不依赖访问该路径。
- 本次交接只检查文档编码、换行、相对链接、源码位置及 Git 差异范围，不执行产品构建或业务测试。没有生成编译目录、临时源码或后台进程。

接手修复的第一步是在重新核对的当前真实模块上建立会因旧权限函数匹配规则而失败的回归用例。

## 修复进展

2026 年 10 月 19 日在 WSL 仓库完成源码修复和本地验收。本次没有构建、安装、重启或在 Windows 上运行，也没有发送模型请求。

### 当前结构与修复方式

修复前从 Windows 安装包 `OpenAI.Codex_26.1013.4894.0` 的 `app.asar` 只读提取 `app-initial-5851df3f6cb1.js` 与 `app-shared-bbfeca5e5737.js`。资源名称与实时诊断一致。

当前权限函数 `Mxo` 返回访问对象 `serviceTierAccess`，不再返回布尔值。该对象由 `app-shared` 中的 `Uat` 按账号需求生成，形如 `{fast, ultrafast}`。`Wat` 按档位类别读取该对象，`Xat` 用它筛选档位。旧补偿把权限替换为 `!0`。这个值在新结构中读取 `true.fast` 得到 `undefined`，档位仍会被清空，因此只放宽匹配规则不能修复问题。

修复后的 [准备与补偿脚本](../../backend/src/cdp/service_tier.js) 按 `serviceTierAccess:` 定位权限函数。脚本调用原生 `Tr({})` 生成一个不含账号需求的访问对象，读取函数和权限函数共用这个对象。权限函数在内存缓存之后替换返回值，已挂载的组件重新渲染时也能取得新对象。选择函数继续用原生 `Lee` 按当前模型校验档位，并移除需求查询挂起对加载状态的影响。模型选择器、设置页和公告页都通过同一个导出绑定 `zBt` 读取 `Mxo`，所以替换 `Mxo` 后这些页面同时生效。脚本只支持当前访问对象形态。旧布尔形态按不兼容处理，不会生成部分补偿。

[服务档位安装器](../../backend/src/cdp/service_tier.rs) 的 `Session::command` 在错误中保留页面异常或协议错误的首行，最长 160 个字符，不保留堆栈。修复后同类失败显示为“服务档位页面检查失败：Runtime.evaluate：Error: 服务档位权限形态不兼容”。

### 已执行的检查

| 检查 | 结果 |
| --- | --- |
| 真实模块规划 | 用 `HEAD` 规划器处理提取的真实 `app-initial`，抛出“服务档位权限形态不兼容”，与实时诊断一致。修复后读取、权限和选择各匹配一次，四处替换各命中一次，生成的表达式可以解析。 |
| `node --test tests/service-tier-patch.test.mjs` | 夹具从真实资源逐字复制。修改前的规划器失败，错误为“服务档位权限形态不兼容”；修复后通过。以下四种变异都会让测试失败：只在内存缓存内替换权限、读取函数仍用 `!0`、去掉模型校验、保留需求挂起加载。 |
| `node tests/service-tier-browser.mjs` | 在 WSL 中用临时安装的 `playwright-core` 和缓存中的 Chromium 运行。共享辅助函数作为独立模块导入。修复后通过；修改前的规划器以安装失败结束。 |
| Rust 检查 | `cargo test -p codey --lib cdp::` 结果为 26 项通过、1 项按设计忽略。新测试 `failures_keep_the_first_line_of_page_and_protocol_errors` 在旧 `Session::command` 上失败。`cargo clippy -p codey --lib --tests` 与 `cargo fmt --check` 通过。 |
| 静态与全量 JS | `pnpm run check`、`pnpm run test:js` 与 `git diff --check` 通过，JS 测试 541 项通过、0 项失败。 |

### 尚未验收与已知限制

- Windows 实际运行已验收。验证包由 GitHub Actions 运行 `39231792901` 基于分支 `fix/service-tier-access` 构建，安装后由用户启动。只读读取主页面状态，`service-tier` 为 `effective`，`__codeyServiceTierStatus.status` 为 `ready`，其余内置功能为 `effective`，提示词优化因关闭而为 `inactive`。控制台不再显示“基础异常”。
- 控制台显示的“1 个功能尚待确认”来自用户配置中的 `user-script-1`。用户脚本没有生效自检，状态只会是 `executed`。该脚本用于保留 `GPT-` 前缀，内置模型白名单注入已先设置 `window.__codeyKeepGptPrefix`，所以它会直接返回。这项提示与本次修复无关。
- 用户报告安装后 Fast 模式正常触发。新建、继续、恢复聊天和模型切换几种情况没有逐项记录，请求字段与上游实际处理也没有分别采集。
- 本地检查无法证明当前页面的 `codeyServiceTierScope` 能找到读取作用域。实时诊断在规划阶段已经失败，没有执行到作用域检查之后。
- 启动资源补丁 `backend/src/renderer_asset_patch.js` 仍按 `isServiceTierAllowed` 匹配。本次已验证它不改动当前结构的夹具。页面注入 `public/model-whitelist-inject.js` 的 `repairNativeFastControls` 也按该字段匹配。根据当前模块中该字段的匹配数为零，推断它在当前结构上不起作用，但没有实际运行验证。本次没有修改这两处。
- 当前 `app-initial` 的请求构建路径还有 `xin` 和 `zin` 两处检查，它们用 `configRequirements/read` 的结果调用 `Tr` 再次筛选档位。这两处不检查认证方式，只在账号需求明确写有 `fast_mode=false` 时清空档位。本次没有修改这项原生策略。2026-10-08 的交接记录说明当时的旧版本没有返回该限制；当前版本的返回值尚未核实。
- 已挂载组件取得新访问对象的路径只在模拟的内存缓存中测试过。补偿本身不会触发重新渲染。Windows 验收需要确认：安装后不重载页面，已打开的模型选择器也能显示 Fast 选项。
