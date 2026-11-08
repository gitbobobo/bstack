---
name: uiv
description: 把截图、录屏等图片和视频上传到 UIV，拿到公开链接和可直接粘贴的 Markdown。用于在 PR 描述、评论、issue 中展示端到端验证成果。
---

# UIV：上传图片和视频，拿到公开链接

UIV 是一个自托管的图片/视频服务。上传后返回公开链接，任何人（包括 GitHub）都能直接访问。

## 前提

需要两个环境变量：

- `UIV_URL`：UIV 的**公网**地址，例如 `https://uiv.example.com` 或 `http://1.2.3.4:7000`。必须是 GitHub 能访问到的地址，局域网或 Tailscale 地址生成的链接在 PR 里会显示为裂图。
- `UIV_TOKEN`：上传用的 token。

当前 shell 里没有这两个变量时，先加载 `~/.agents/env/uiv.sh`（`source ~/.agents/env/uiv.sh`），不要到处搜索配置文件。加载后仍缺少任意一个，或文件不存在，就停下来请用户提供，不要猜测。

## 截最终状态

截图呈现的是目标状态到位后的画面。点击、跳转、提交之后，界面要经过一段过渡才稳定：加载中退场、数据渲染完、动画播完。在此之前按下截图，得到的就是过渡途中的废图。

- 等目标状态的哨兵出现再截：挑一个只在该状态存在的元素或文字（成功提示、目标数据、新页面标题），等它出现，不要用固定 sleep 猜时间。
- 过渡动画（弹窗、展开、淡入）在哨兵出现后还会播一段，多等几百毫秒收尾再截。
- 每张图上传前自己看一遍：还带着加载中、半渲染或动画半途的，重截。

## 上传

一次上传一个文件，字段名固定为 `file`：

```bash
curl -fsS -H "Authorization: Bearer $UIV_TOKEN" -F "file=@screenshot.png" "$UIV_URL/api/files"
```

Windows PowerShell 里 `curl` 是别名，要写 `curl.exe`：

```powershell
curl.exe -fsS -H "Authorization: Bearer $env:UIV_TOKEN" -F "file=@screenshot.png" "$env:UIV_URL/api/files"
```

成功返回 HTTP 201 和 JSON：

```json
{
  "id": "k3J9xQ2mPa",
  "url": "https://uiv.example.com/f/k3J9xQ2mPa.png",
  "markdown": "![screenshot.png](https://uiv.example.com/f/k3J9xQ2mPa.png)",
  "name": "screenshot.png",
  "size": 48213,
  "type": "image/png",
  "created_at": "2026-10-03T15:44:18.486Z"
}
```

把 `markdown` 字段原样贴进 PR 描述或评论即可。图片会生成 `![..](..)` 形式，直接显示；视频会生成 `[..](..)` 形式，显示为链接。

## 选择格式

- 截图：PNG，或 WebP（体积更小）。
- 演示操作流程：优先录成 GIF 或动画 WebP。GitHub 只会内嵌播放上传到 GitHub 自己的视频，外链 MP4 只显示为链接，点开后才能播放。
- 较长的演示：MP4（H.264）或 WebM，贴链接即可。
- 只接受图片和视频（PNG、JPEG、GIF、WebP、AVIF、HEIC、BMP、SVG、MP4、WebM、MOV、AVI），按文件内容判断，和扩展名无关。默认单文件上限 200MB。

## 演示动图

本节针对能用几张状态图讲清的短演示；较长的演示不拼 GIF，按「选择格式」直接上传 MP4 链接。

- 默认按状态截图再拼成 GIF，不录连续视频。操作中每个有意义的状态截一张，单独设停留时间：中间状态 1 秒以内，最终状态至少 3 秒。
- 每帧都按「截最终状态」到位再截；第一帧必须是加载完成后的页面，不能出现「加载中」。
- 关键 UI 要占画面主体。视口用 900 宽左右，或只裁操作区域，保证贴进 PR 表格后文字还能看清。
- 只有改动本身是动画或过渡效果时才录连续视频。这时上传 MP4 作为链接，同时贴几张关键状态截图。
- 上传前自检：最长的一帧必须是最终状态，而且不少于 3 秒；第一帧不是加载中；整段完整看过一遍。

按状态截图拼 GIF，每帧单独设停留时长：

```python
from PIL import Image
frames = [("board.png", 1000), ("hover.png", 700), ("dialog.png", 3600)]
imgs = [Image.open(f) for f, _ in frames]
imgs[0].save("demo.gif", save_all=True, append_images=imgs[1:],
             duration=[d for _, d in frames], loop=0, optimize=True)
```

上传前自检，打印尺寸、帧数、每帧时长和总时长：

```python
from PIL import Image, ImageSequence
im = Image.open("demo.gif")
d = [f.info.get("duration", 0) for f in ImageSequence.Iterator(im)]
print(im.size, len(d), d, sum(d))
```

## 注意

- 链接是公开的，没有 token 也能访问。不要上传含密钥、个人信息或内部数据的截图；必要时先裁剪或打码。
- 链接永久有效，除非有人在 UIV 管理后台手动删除。
- 同一个文件上传两次会得到两个不同链接，重新上传前先确认确实需要。

## 错误处理

失败时返回 JSON `{"error": "..."}`：

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 401 | token 缺失或错误 | 检查 `UIV_TOKEN`，不要反复重试 |
| 413 | 文件超过大小上限 | 压缩、裁剪、降低分辨率或缩短视频 |
| 415 | 不是允许的图片/视频类型 | 转换成上面列出的格式 |
| 400 | 请求格式不对 | 确认用的是 `-F "file=@路径"` |

检查服务是否可用：`curl -fsS "$UIV_URL/api/health"`，返回 `{"version":"..."}`。
