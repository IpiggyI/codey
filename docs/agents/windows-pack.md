# Windows 安装包

改了安装后用户会跑的应用，并要请人装包验收时，先打包，再把安装包路径交给人。不要推送标签来换本机验证包。

入口脚本支持 Windows Git Bash 和 WSL，分别经 `cygpath -w` 和 `wslpath -w` 调用 Windows PowerShell；源码拷到 `%TEMP%` 的 NTFS 再编译；成功输出 `NSIS_OK:`；产物写到 Downloads。

## 何时打包

要打包：桌面入口、注入脚本、控制台前端或安装图标有改动，且下一步是请人安装测试。

不打包：只改文档、测试、agent 说明、ADR。

## 唯一入口

在仓库根执行：

```bash
scripts/build-windows.sh
```

`pnpm run build:windows` 与上面相同。脚本先在当前环境重建页面资源，再调用 `scripts/build-windows.ps1`。Windows 本机从 Git Bash 执行入口，不需要 WSL。

Windows 上可直接跑该 `ps1`，但须先在源码树执行 `pnpm run vite:build`。

成功时标准输出含一行 `NSIS_OK: <绝对路径>`。把该路径交给人。产物名称含版本及毫秒时间戳，不覆盖旧包：

`%USERPROFILE%\Downloads\Codey-<版本>-<yyyyMMdd-HHmmssfff>-windows-x64-setup.exe`

安装包内 DisplayVersion 默认为 `<package.json 版本>-local`。覆盖时设置 `CODEY_WINDOWS_PACKAGE_VERSION`。

## 禁止

- 从 `\\wsl.localhost` 或 `\\wsl$` 跑 cargo / 链接
- 另写 Node 包装、把 `ps1` 拷到别的目录再编、把安装包拷到桌面当作交付
- 用推送 `v*` 标签或 `workflow_dispatch` 打未提交改动的验证包
- 代为安装、启动或结束已装的 Codey，改开机项

发布安装包仍走 GitHub `v*` 标签与 `.github/workflows/build-desktop.yml`，与本机验证包分开。

## 边界

打包只产出安装包。脚本把源码拷到 `%TEMP%\codey-windows-pack\app-<时间戳>-<随机标识>` 的独立 NTFS 副本上用本机 MSVC 编译。需要 Windows `stable-x86_64-pc-windows-msvc`、VS Build Tools，以及 `makensis.exe`（PATH、官方安装目录或 `%LOCALAPPDATA%\codey-tools\nsis\`）。

成功交付或构建失败后，脚本先退出工作目录，再清理本次源码副本及其 `target`。脚本不清理其他打包任务的目录。清理会拒绝根目录、相邻目录，以及工作目录或其祖先和后代中的重解析点；逐项删除不递归跟随链接。

正常收尾仅保留 `%TEMP%\codey-windows-pack\last-build.log`，摘要最多 4096 个字符。后一次收尾覆盖前一次摘要；并发打包也使用同一份摘要。详细编译输出仍写到终端。

清理失败时，脚本输出残留目录及失败原因，并返回退出码 1。原构建失败原因仍保留在 `NSIS_FAIL:` 中。已经交付到 Downloads 的安装包不会删除；此时输出其路径，但不输出 `NSIS_OK:`。

`-ComputerUseGo` 和 `-RunComputerUseTests` 保持原有用法。可选的 Computer Use 测试仍执行 `cargo test -p codey computer_use::tests --locked`。仅在这次测试期间设置 `CARGO_PROFILE_TEST_DEBUG=0` 和 `CARGO_PROFILE_TEST_INCREMENTAL=false`，测试结束后恢复原环境值，再编译发布版本。

## 处理中断残留

强制结束进程或断电可能使收尾代码无法执行。历史目录也不会自动扫描或删除。确认对应打包进程已结束后，在 Windows PowerShell 中加载辅助脚本，明确指定一个残留目录；旧的纯时间戳目录也可使用此入口：

```powershell
. .\scripts\windows-pack-workspace.ps1
Remove-WindowsPackDirectory -WorkRoot (Join-Path $env:TEMP 'codey-windows-pack') -AppCopy 'C:\完整路径\codey-windows-pack\app-时间戳'
```

将示例中的 `-AppCopy` 替换为实际完整路径。该入口执行同样的目录范围与重解析点检查，并拒绝可执行路径或命令行仍指向该目录的其他进程；进程查询失败也会停止清理。进程检查不能读取其他进程的当前工作目录，不能代替调用前确认对应打包进程已结束。该入口不结束进程。

## 清理回归验证

在 Windows 仓库根运行 `node --test tests/windows-pack-lifecycle.test.mjs`。测试替换编译工具和安装包大小门槛，使用独立临时目录与 KB 级文件，验证交付、失败收尾、并发隔离、路径保护和测试环境恢复；不执行真实编译或打包。可用 `CODEY_PACK_TEST_POWERSHELL` 指定 PowerShell 可执行文件，默认使用 Windows PowerShell 5.1 的 `powershell.exe`。

源码位于 UNC 路径时，测试还从该真实 UNC 当前目录启动夹具，分别验证成功和编译失败后的收尾。源码位于本机磁盘时，可用 `CODEY_PACK_TEST_UNC_CWD` 指定一个可访问的 UNC 目录；没有 UNC 目录时，这两项明确跳过。打包及清理要求当前目录属于文件系统提供程序，恢复目录和路径检查都使用其实际文件系统路径。
