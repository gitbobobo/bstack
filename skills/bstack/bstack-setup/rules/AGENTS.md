# 全局代理规则

适用于所有仓库；项目内的 AGENTS.md 优先于本文件。

回复始终用用户最近一条消息的语言。

## 执行命令

- 重命令（构建、生成、全仓库检查、E2E）遵守本机配置的调度入口与资源限额，排队时检查日志、进程和锁持有者后再判断是否卡住。
- 同一功能任务始终只有一个最终验证负责人；已有检查证据须核对最终源码、工具链和覆盖，变化或缺口由该负责人补跑。

- 需要靠退出码判断成败的命令（构建、测试、部署、写请求），不要 `| tail` / `| head` 截断——管道返回的是末段命令的退出码，会掩盖真实失败。输出大就重定向到文件再截尾：

  ```bash
  cmd > /tmp/x.log 2>&1; s=$?; tail -30 /tmp/x.log; echo "exit=$s"
  ```

- 向外部服务发非 ASCII 内容（中文评论、JSON 体）：先写 UTF-8 无 BOM 文件再引用——`gh --body-file`、`gh api --input`、`curl --data-binary @file`；不内联、不经 stdin 管道。

## macOS 环境

- 没有 `setsid`、`timeout`；命令超时会连同整个进程组被杀——`nohup`、`disown` 都不脱离进程组，救不了。要存活过本轮的进程用终端工具自带的 detached/后台模式。
- exec 报 "terminal failed to create" / 目录不存在：会话 cwd（典型是被删除的 git worktree）失效后不可恢复——终端在命令运行前就失败，`cd` 救不回来。不要重试；结束本轮并向用户说明哪些收尾步骤没做（Fast Ship 状态、PR sync、分支清理、工作树回收），等用户在有效目录里开新会话接手。

## Windows 环境

- exec 的 shell 依 harness 而定：devin 等 ACP 系是 cmd.exe，claude/codex/pi 是 Git Bash。报 `'xxx' 不是内部或外部命令` / `not recognized` 就是方言错了，立即按所在 shell 换写法，不要逐种试。
- 路径以 `/mnt/<盘符>/` 开头或 `uname` 显示 Linux，说明落进了 WSL bash（pi 没配 `shellPath` 时会这样）：WSL 里的 `git` 读不了 Windows 工作树，也没有 `node`。改用 `git.exe`/`gh.exe`/`node.exe`，并提醒用户跑 `$bstack-setup` 体检。
- 超时（`timeout` 或 harness 自带的超时）只杀直接子进程，经 `powershell.exe`/`cmd.exe` 拉起的 cargo、node 等 Windows 子进程会继续跑，抢锁、写坏构建产物。长命令用 `Start-Process` 后台运行加日志轮询；命令超时后先按 PID 查有没有残留进程，再重跑。
- cmd 方言：命令用 `&&`/`&` 连接（`;` 不是分隔符）；工具只有 `dir`/`type`/`findstr`/`rg`，没有 `ls`/`pwd`/`head`/`tail`/`wc`/`sed`/`awk`/`grep`/heredoc/PowerShell cmdlet；`more +N` 输入不足 N 行时输出为空，不能当跳行工具用。参数里的 `&`、`|`、`>`、括号会按 cmd 语义展开（URL、JSON 首当其冲），一律双引号包裹或写文件引用。
- 多行或含引号的脚本写临时 `.mjs`/`.py` 文件再执行，不内联 `node -e`/`python -c`/`powershell -Command`——cmd 转义会吞内容。
- 不用 PowerShell `Set-Content`/`Add-Content`/`Out-File`/`>` 写仓库文件（PS 5.1 默认写成 GBK/UTF-16 并加 BOM）；改文件走编辑工具或脚本。批量修改未跟踪文件前先 `git add -N` 或复制备份——没有快照就没有恢复路径。
- `git rebase`/`merge` 连续操作前先 `set GIT_EDITOR=true`，防 vim 挂起。

- 删除目录只允许两种写法：`git worktree remove --force '<绝对路径>'`，或 `Remove-Item -LiteralPath '\\?\<盘符>:\<完整路径>' -Recurse -Force`。`\\?\` 前缀不能省（Windows PowerShell 5.1 不带它删不掉超过 260 字符的深层路径），前缀后只用反斜杠，不能有 `..`。
- 路径必须是写死的完整绝对路径，不要用变量拼接——变量为空时目标退化成当前目录或根目录。
- 禁止 `cmd /c rmdir /s`、`rd /s`、`del /s`、`rm -rf` 删除目录，从 WSL 访问的 `/mnt/<盘符>/` 路径同样适用；PowerShell 里不嵌套 cmd，转义符是反引号不是 `\"`。
- 删除失败（文件被占用、权限不足、路径过长）就停下，列出没删掉的内容交给用户处理；不换更强硬的命令重试，也不为解锁去结束不是自己启动的进程。
