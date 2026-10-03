# AGENTS.md

## 文档约束

- `README.md` 只写面向使用者的功能描述和必要注意事项，不写技术细节。
- `README.md` 需要覆盖所有主要用户可见能力；不要因为去除技术细节而省略功能面。
- 更新 `README.md` 时，以 Codey 控制台和 Codex 页面内可见增强为核对清单，但不强制按控制台分区拆开书写。
- 不要在 `README.md` 中加入构建命令、发布流程、依赖版本、端口、协议、数据库结构、文件路径、内部模块名、注入/补丁策略或实现原理。
- 内部开发、构建、发布、配置路径、运行机制、性能策略和已知实现限制统一维护在 `INTERNAL_DEVELOPMENT.md`。
- 新增或调整功能时，如果用户能感知到行为变化，可以用非技术语言同步更新 `README.md`；涉及实现、测试、发布或维护细节时，只更新 `INTERNAL_DEVELOPMENT.md`。
- 修改文档前先判断目标读者：普通使用者读 `README.md`，维护者读 `INTERNAL_DEVELOPMENT.md`。

## 构建收尾

- 每次构建或验证结束后，无论成功或失败，都要清理本任务生成的中间产物，包括仓库内构建输出、仓库外的本仓库专属编译目录和临时源码副本。先保存必要验证证据，并确认相关进程已结束；保留交付文件、共享依赖缓存及其他任务的文件。
- 清理后核对残留；清理失败时报告完整路径和原因，不把未完成清理的任务报告为已完成。Windows 打包及中断残留按 `docs/agents/windows-pack.md` 的安全清理流程处理。

## Agent skills

### 上游差异

本分叉与上游的当前差异及原因维护在 `docs/agents/fork-upstream.md`。对照上游、cherry-pick、跳过或改写上游提交后，在同一次改动内更新该文件；差异若用户可感知，同步更新 `README.md`「与上游的差异」。原因已有 ADR 的只链接，不重述。逐次同步的摘要和计划仍放 `docs/upstream-sync/`。

### Issue tracker

Issues live in this repo's GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 onto tracker labels of the same name. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.

### Windows pack

To build a Windows installer for local testing, run only `scripts/build-windows.sh` (same as `pnpm run build:windows`). Do not compile from `\\wsl.localhost`, do not push a tag or dispatch Actions to package uncommitted work, and do not install the package. See `docs/agents/windows-pack.md`.
