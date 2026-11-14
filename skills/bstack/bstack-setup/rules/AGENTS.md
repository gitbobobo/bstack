# 全局代理规则

始终用中文回复。

## Windows 的 Shell 环境

**会话内首次执行命令前需要确定所在 shell 的类型（cmd.exe/git bash/powershell.exe），避免用错方言造成不可挽回的损失**。

- cmd 方言：命令用 `&&`/`&` 连接（`;` 不是分隔符）；工具只有 `dir`/`type`/`findstr`/`rg`，没有 `ls`/`pwd`/`head`/`tail`/`wc`/`sed`/`awk`/`grep`/heredoc/PowerShell cmdlet；`more +N` 输入不足 N 行时输出为空，不能当跳行工具用。参数里的 `&`、`|`、`>`、括号会按 cmd 语义展开（URL、JSON 首当其冲），一律双引号包裹或写文件引用。
- 多行或含引号的脚本写临时 `.mjs`/`.py` 文件再执行，不内联 `node -e`/`python -c`/`powershell -Command`——cmd 转义会吞内容。
- 不用 PowerShell `Set-Content`/`Add-Content`/`Out-File`/`>` 写仓库文件（PS 5.1 默认写成 GBK/UTF-16 并加 BOM）；改文件走编辑工具或脚本。批量修改未跟踪文件前先 `git add -N` 或复制备份——没有快照就没有恢复路径。
- `git rebase`/`merge` 连续操作前先 `set GIT_EDITOR=true`，防 vim 挂起。
- 禁止 `cmd /c rmdir /s`、`rd /s`、`del /s`、`rm -rf` 删除目录，从 WSL 访问的 `/mnt/<盘符>/` 路径同样适用；PowerShell 里不嵌套 cmd，转义符是反引号不是 `\"`。
