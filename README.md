# Codey

本仓库是 [SuperGness/codey](https://github.com/SuperGness/codey) 的修改版，修改日期 2026-08-31。

Codey 是 Codex 桌面客户端的增强启动器。它会启动 Codex，并在 Codex 页面内提供统一控制台，用于查看当前 provider、管理模型清单、任务辅助能力、通知和诊断。请求发往哪里，完全由你自己写的用户配置决定；Codey 不接管请求去向。

## 主要功能

- 启动与状态：自动启动或重启 Codex；Windows 遇到暂时性启动错误时会自动重试一次。展示版本、应用位置、运行状态和功能生效情况，并按实际检测结果提示正常、待确认、需检查或异常。
- provider 与模型：控制台只读展示当前 Codex provider（标识、地址、接口格式、是否官方账号鉴权），不能在控制台里新增、编辑或删除 provider，也不会改写你的用户配置。模型清单按当前 provider 同步，换用另一套配置模板后不会把上一套地址的模型清单带到新地址。仍支持模型同步、手动维护和全局默认模型。空的模型目录不会交给 Codex。模型选择器在更多模型上仍提供 Fast 与思考强度。保存后这些选项会在之后打开模型选择器时更新；若仍未变化，按界面提示重启。用户配置无法解析时会明确报错并拒绝启动。逐模型上下文窗口、自动压缩阈值和输出预留可在当前 provider 的模型清单中配置，兼容原有 1M 设置。
- 账号额度：本机有可用 ChatGPT 登录（含旧版登录态）并开启额度显示时，在输入栏展示套餐窗口剩余百分比和重置时间，点开可查看 5 小时与 7 天窗口。额度跟随官方账号，不看当前所选模型或 provider。没有 ChatGPT 登录时不显示额度。若当前服务是多人共用账号池，数字不一定代表本人消耗。刷新失败时会继续使用本周上次成功获取的数据。只有指向 ChatGPT 官方 Codex 服务时，控制台才把该 provider 标为官方账号鉴权。
- 对话用量：当前对话有消耗后，输入栏会显示缓存命中、上下文占用和 Token 明细；这是这次对话发生了什么，不是账号套餐还剩多少。
- 会话增强：优化任务时间和运行状态展示，支持会话导入、导出、整段或指定轮次删除；启动时不会改写历史会话的归属。若有历史会话仍指向已移除的本机代理，控制台会提供迁移入口，确认后先备份再改写到你指定的 provider，过程中会暂时重启 Codex。页面状态异常时会尝试重新同步。
- 插件与页面增强：修复插件市场和本地插件展示，提供可离线恢复的精选插件内容，并改善常用会话操作和页面体验。电脑操作沿用 Codex 自带插件，不额外添加重复服务。
- 提示词优化：可使用官方账号、当前 provider 或独立填写的连接信息，一键优化输入框中的提示词；写回的是最终提示词，不含推理过程，结果仍可继续编辑。
- 子代理角色：提供快速定位、深度检索、视觉分析、代码实施和视觉实施五类角色，可分别选择模型与思考强度，并限制不安全的并发写入。默认只在宽范围、可并行或需要专门证据时才派发，不是强制分工。纯只读协作期间，主任务可继续查询文件、网页和数据库信息。打开子代理详情后，标题右侧显示该任务使用的模型与思考强度。角色绑定的模型不在当前清单时会明确标出待重选，不会悄悄换成别的模型。运行配置异常时会暂停新任务并提示恢复方法。
- FastCtx：可选启用内置 FastCtx，提升长任务中的文件读取、搜索、发现和批量替换体验；检测到已有 FastCtx 配置时不会重复加载。
- 消息通知：支持飞书、企业微信、Telegram 和微信 ClawBot。已配置渠道会同时接收任务完成、失败和等待介入提醒。
- 稳定性与存储保护：提供健康检查、会话恢复、诊断存储统计与清理，并可按平台启用 Trace、Crashpad、宠物精简、屏蔽完全访问安全提示，以及 Windows 上的 GPU 渲染模式。宠物设置应用失败时仍可继续启动。

## 使用方式

打开 Codey 后，它会自动启动 Codex。进入 Codex，点击顶部的 Codey 按钮即可打开控制台。保存设置后，可立即生效的功能会直接更新；需要重启的项目会在界面中提示。provider 能力不变时，保存模型增删会更新 Codex 模型清单；部分模型能力仍需重启时会单独提示。

## 注意事项

- Codey 只面向 Codex 桌面客户端，不覆盖命令行版本。
- 启动 Codey 时，如 Codex 已在运行，Codey 可能先关闭并重新启动它；正在运行的任务会被中断。
- 官方账号依赖 Codex 的 ChatGPT 登录状态；第三方 provider 的可用功能取决于对应服务和账号。
- 部分增强能力会随 Codex 版本和所选 provider 而变化，请以控制台提示为准。
- 自定义上下文预算修改后重启 Codex 生效；设置更大的数值不会扩大服务端容量。无法识别容量的模型使用保守预算，建议按服务商公布的限制调整。
- 远程压缩是否可用由当前 provider 与模型目录共同决定。已有压缩历史无法用于目标服务时，请先在原 provider 处理后再切换，避免缺失上下文。
- 数据库查询请使用只读账号；子代理协作限制不能替代数据库本身的权限设置。
- 本修改版不会检查、下载或安装客户端更新；安装包只通过 GitHub Release 提供。
- macOS 未签名安装包可能被系统拦截，可在确认来源后按系统提示允许打开。

## 第三方声明

    This product includes FastCtx
    (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
    used under the Apache License 2.0.

    FastCtx is redistributed and/or modified here by the maintainer of
    this distribution. Any such change is that maintainer's own work
    and their sole responsibility. It is not endorsed by, not
    supported by, and not attributable to the author of FastCtx, who
    accepts no liability of any kind arising from this distribution or
    from anything built on top of it.

## 联系方式

Codey 由 [SuperGness](https://github.com/SuperGness) 创建和维护。集成、再分发、合作或其他事宜，欢迎联系：kimzane9991@gmail.com。

## 致谢

感谢 [linuxdo](https://linux.do/) 社区的讨论、分享与反馈。
