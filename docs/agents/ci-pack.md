# 云端打包

改了安装后用户会跑的应用，并要请人装包验收时，默认用 GitHub Actions 打验证包。何时需要打包，见 `docs/agents/windows-pack.md` 的「何时打包」。GitHub 不可用或需要离线出包时，改用该文件里的本机打包。

## 流程

1. 在功能分支上开发。`master` 上不打验证包，脚本会拒绝。
2. 提交改动。构建只用已推送的提交，未提交或未推送的改动不会进包。
3. 推送和触发构建是对外操作。每一轮都要用户在当次请求里授权，例如「推送并构建」。
4. 推送：`git push -u origin <分支>`。
5. 在仓库根执行 `scripts/ci-pack.sh <产物名>`。只请人测 Windows 时传 `codey-windows-x64-installer`；要 macOS 包时加 `codey-macos-arm64-unsigned`；不传时下载全部产物。成功时每个文件输出一行 `CI_PACK_OK: <路径>`，把路径交给人。失败时输出 `CI_PACK_FAIL:` 和失败日志的最后 200 行。
6. 人安装测试。不通过时修复、提交，回到第 3 步。
7. 测试通过后，经用户授权执行 `gh pr create --base master`。PR 会触发 `.github/workflows/ci.yml` 的检查。合并方式用 Squash merge，由用户决定。

同一提交已有构建时，脚本复用它，不重复触发。构建因偶发原因失败时，用 `scripts/ci-pack.sh --new <产物名>` 重新触发；代码导致的失败，修复后推送新提交。

## 构建内容

手动触发 `.github/workflows/build-desktop.yml` 时，并行打 macOS arm64 未签名包、Windows x64 NSIS 安装包，并跑 macOS 检查。Windows 打包任务不跑测试，测试在 PR 触发的 `ci.yml` 里。包内版本号是 `<package.json 版本>-<运行序号>`。

仓库公开，产物任何登录 GitHub 的用户都能下载。

产物下载到 `%USERPROFILE%\Downloads\codey-ci-<运行编号>\<产物名>\`。下载目录是交付物，脚本不删除；用户验收后自行删除。

## 边界

打包只产出安装包。不代为安装、启动或结束已装的 Codey，不改开机项。发布安装包仍走 `v*` 标签，不用标签换验证包。
