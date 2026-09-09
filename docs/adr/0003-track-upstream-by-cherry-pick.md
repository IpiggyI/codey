# 以 cherry-pick 跟踪上游，vendor 目录保持原样

本分叉想要上游的运行期优化，不要它的路由。整体 merge 会在 `codex_config.rs`、`launcher.rs`、`commands.rs`、`config.rs` 上持续冲突——这几个文件同时是路由的骨架和优化的载体。因此改为按提交挑选，并把删除按功能垂直切片提交，让将来的上游冲突落在单个功能上，而不是散在每一层。

`vendor/CodeyRuntime` 是上游整目录替换的 vendored crate。其中的 `routes.rs`、`relay_config.rs`、`provider_sync.rs` 只停止调用，不做删除：改动 vendor 会让每次同步必然冲突，而代价仅仅是二进制里保留一批未调用的代码。

2026-09-09 接到上游 `v0.10.7` 时冲突面大，实际采用分段 rebase；vendor 仍整目录替换。

## 后果

自动更新必须关闭。默认更新源硬编码指向上游的发布清单，一次"更新"就会把上游正式版装回来，覆盖本分叉。
