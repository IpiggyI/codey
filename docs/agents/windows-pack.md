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

打包只产出安装包。脚本把源码拷到 `%TEMP%\codey-windows-pack\app-<时间戳>` 的独立 NTFS 副本上用本机 MSVC 编译，保留之前的打包目录。需要 Windows `stable-x86_64-pc-windows-msvc`、VS Build Tools，以及 `makensis.exe`（PATH、官方安装目录或 `%LOCALAPPDATA%\codey-tools\nsis\`）。
