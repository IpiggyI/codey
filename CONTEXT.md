# Codey

Codex 桌面客户端的增强启动器。本分叉只做运行期增强，不接管请求去向：请求发往哪里，完全由用户自己写的 Codex 配置决定。

## 配置与所有权

**用户配置**：
用户自己编写的 `~/.codex/config.toml`，以及他并列保存的模板文件。Codey 只读，永不写入。
_Avoid_: Codex 配置、线路配置

**运行期覆盖**：
通过 `-c key=value` 传给单次 Codex 进程的配置值，随进程结束而消失，不落盘。
_Avoid_: 临时配置、注入配置

**运行期产物**：
Codey 为本次运行写入 Codex 目录、并在退出时恢复原状的文件。目前只有 `hooks.json`。
_Avoid_: 临时文件、运行时配置

## 请求去向

**provider**：
用户配置里 `[model_providers.*]` 的一项，一律用它的 id 称呼（`openai`、`official`、`gs`）。Codex 直接向它发请求。
_Avoid_: 线路、route、渠道

**官方账号**：
`~/.codex/auth.json` 里的 ChatGPT 登录态。它与任何 provider 的 `base_url` 无关——一个 id 叫 `official` 的 provider 不是官方账号，一个指向自建中转的 provider 也可能使用官方账号鉴权。
_Avoid_: 官方线路、openai provider

**内置路由**：
上游 v0.9.0 引入、本分叉已移除的本机代理。本词只用于描述历史行为和清理残留。
_Avoid_: 本地路由、网关、codey_router

## 模型

**模型清单**：
Codey 为某个 provider 记录的可用模型集合，保存在 Codey 自己的配置里，按 provider id 与 `base_url` 的指纹归属。
_Avoid_: 模型列表、模型池

**模型目录**：
交给 Codex 的 `model_catalog_json` 文件，决定模型选择器里的展示名与能力元数据。用户自己启用该键时，Codey 让位并另存只读派生副本。
_Avoid_: catalog、模型元数据文件

**思考强度**：
单个模型可选的推理档位，取值 `minimal`、`low`、`medium`、`high`、`xhigh`。
_Avoid_: 推理强度、effort

**服务档位**：
请求的速度与优先级档位。`priority` 对应模型选择器里的 Fast。
_Avoid_: 快速模式、tier

## 增强能力

**子代理角色**：
五类固定任务分工——快速定位、深度检索、视觉分析、代码实施、视觉实施，各自绑定模型与思考强度。
_Avoid_: agent、代理类型

**账号额度**：
本机 ChatGPT 登录账号在官方套餐窗口（5 小时、7 天）里还剩多少。它只跟 `auth.json` 里的登录态有关，跟当前 provider 是否官方无关。当 provider 是账号池型中转时，这个数字不代表实际消耗。
_Avoid_: 官方额度、quota、周额度

**对话用量**：
当前对话的 token 消耗、上下文占用和最近一轮缓存命中。它描述这次对话发生了什么，不是账号套餐还剩多少。
_Avoid_: 会话详细信息、会话用量

**FastCtx**：
随 Codey 分发的文件读取与搜索工具，以 MCP 服务形式提供给 Codex。
_Avoid_: 上下文工具、fast-context
