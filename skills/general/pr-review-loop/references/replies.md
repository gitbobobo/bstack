# 回复与宿主接口

回复、更新描述与 REST 写请求先执行 [PR 写入隔离](pr-writes.md)，再用下表接口提交并回读确认。宿主按 PR URL 判断：github.com 用 `gh`；其他实例（Forgejo/Gitea）用本机 `fj`，缺命令或未登录时退回同名 REST 端点（`/api/v1/...`，凭据取 `FORGEJO_TOKEN`、`~/.agents/env/forgejo.sh` 或本机 git credential helper）。

| 动作 | GitHub | Forgejo |
| --- | --- | --- |
| 回复行内意见 | `gh api repos/<repo>/pulls/<n>/comments -X POST -F in_reply_to=<线程第一条评论的 id> -F body=@<文件>` | 没有 `in_reply_to`：在对话区发顶层评论，开头引用原意见并附它的 `html_url`（`fj pr comment <PR> --body-file '<文件>'`）。必须落回同一段 diff 时用 `POST /api/v1/repos/<owner>/<repo>/pulls/<n>/reviews/<review id>/comments`，body 带 `path`、目标行的 `new_position`（或 `old_position`）和正文，review id 先 `GET /api/v1/repos/<owner>/<repo>/pulls/<n>/reviews` 取 |
| 顶层评论、审查总结、bot 结论 | `gh api repos/<repo>/issues/<n>/comments -X POST -F body=@<文件>`，正文开头引用被回复的意见或附上它的链接 | `fj pr comment <PR> --body-file '<文件>'`（标记写进文件末尾）；或 `POST /api/v1/repos/<owner>/<repo>/issues/<n>/comments` |
| 改 PR 描述（交付范围、截图链接） | `gh pr edit <n> --body-file '<文件>'` | 使用 UTF-8 JSON 文件调用 `PATCH /api/v1/repos/<owner>/<repo>/pulls/<n>` |
| 读评论与检查状态 | `gh pr view`、`gh pr checks`、`gh api … --paginate` | `fj pr view <PR> comments`、`fj pr review <PR> list -c`、`fj pr status <PR>` |

**自己发的每条评论末尾都要带 `<!-- pr-review-loop:reply -->` 标记**（HTML 注释，两个宿主渲染后都不可见）——回复、处置总结、更正都一样。下一轮按作者就能排除自己的评论，标记是同一账号被别的 agent 借用时的唯一判据，照发不要省。两种宿主都把标记写进正文文件末尾，再引用文件提交；REST 请求体用 UTF-8 无 BOM JSON 文件。

不要对任何评论执行 `PATCH` 或 `DELETE`，自己账号发的也不行——两边 API 有权限时都不会拦（Forgejo 的 `fj pr edit comment` 同样不用），改错了就会覆盖审查结论。回复发错了就再发一条更正，不要改原评论。修改 PR 描述不受这条限制，命令见上表。

