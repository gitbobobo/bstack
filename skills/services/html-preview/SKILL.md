---
name: html-preview
description: 通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页，查询回收站与元数据。支持 API Key 认证，适用于 Agent 与自动化脚本集成。
---

# HTML Preview API

## 何时使用

当用户要求你：
- 上传 HTML 或 ZIP 静态页并生成可分享的公开预览链接
- 列出、查询、更新预览项的标题、备注或有效期
- 替换预览内容（保持同一公开 URL）
- 将预览移入回收站、恢复或彻底删除
- 通过程序化方式与 HTML Preview 交互（CI、Agent、curl）

## 认证配置

HTML Preview 使用 **API Key** 进行程序化认证。Key 格式为 `hp_` 开头的 URL-safe 随机串；创建时仅在 Web 设置页完整显示一次。

### 首次使用（配置持久化）

如果 `~/.config/html-preview/config.yaml` 不存在，**必须**向用户询问以下信息：

1. **Base URL**：服务地址，例如 `http://localhost:7849` 或 `https://preview.example.com`（默认端口 **7849**）
2. **API Key**：在 Web「设置 → API Key」中创建（`hp_` 开头）

然后将配置写入文件：

```yaml
# ~/.config/html-preview/config.yaml
base_url: "http://localhost:7849"
api_key: "hp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

> 注意：`~/.config` 目录在 macOS/Linux 上通常已存在；如果不存在，请先创建目录。

> **权限边界**：API Key **不能**创建、列出或吊销 API Key（`/api/keys*` 仅 Session Cookie）。Bearer 访问 Key 管理端点返回 `40300`。Key 的创建与吊销须在 **Web 管理界面**完成。

### 后续使用

直接读取 `~/.config/html-preview/config.yaml` 中的 `base_url` 和 `api_key`，**不再询问用户**。

### 请求头

JSON 请求：

```
Authorization: Bearer <api_key>
Content-Type: application/json; charset=utf-8
```

multipart 上传（`POST /api/items`、`PUT /api/items/:id/content`）：

```
Authorization: Bearer <api_key>
```

（由 curl `-F` 自动设置 `Content-Type: multipart/form-data`，勿手动覆盖为 JSON。）

## 网页管理入口

| 路径 | 说明 |
|---|---|
| `/` | 首页：搜索、网格、上传 |
| `/trash` | 回收站：恢复、彻底删除 |
| `/settings` | 改密、API Key、浏览器一键安装、数据路径 |
| `/setup` | 首次设密（未初始化时） |
| `/login` | 登录 |

默认监听 `0.0.0.0:7849`；本地管理页示例：`http://localhost:7849/`。

## 公开预览 URL

每个预览项有固定公开路径（**无需鉴权**）：

```
{base_url}/c/{id}/
```

示例：`http://localhost:7849/c/AbCdEfGhIjKlMnOp/`

- 仅 `active` 且未过期的项可访问；过期或已在回收站则不可用。
- 响应带 CSP sandbox 等安全头；管理端网格不嵌 iframe 预览。

Item 详情中的 `public_path` 字段为站内路径（如 `/c/{id}/`），完整 URL = `base_url` + `public_path`。

## 上传限制

| 类型 | 限制 |
|---|---|
| HTML 单文件 | ≤ 2 MB |
| ZIP 压缩包 | ≤ 20 MB |
| ZIP 解压后总大小 | ≤ 50 MB |
| ZIP 内文件数 | ≤ 200 |
| ZIP 根目录 | 必须包含 `index.html` |
| 安全 | 拒绝 `..`、绝对路径、怪异 symlink、**嵌套 zip** |

HTML 上传会归一保存为 `index.html`；ZIP 按相对路径解压到项目录。

## 有效期

上传或 PATCH 时可指定：

| `expires_in` | 含义 |
|---|---|
| `1d` | 1 天后过期 |
| `7d` | 7 天后 |
| `30d` | 30 天后 |
| `90d` | 90 天后 |
| `never` | 永久 |
| （不传） | 上传默认 `30d`；PATCH 不传过期字段则不修改 |

若同时传 `expires_at`（ISO 8601 / RFC3339）与 `expires_in`，以 **`expires_at` 为准**。永久必须显式传 `never`。

过期后后台自动移入回收站；回收站保留 30 天后硬删。

## 核心接口

所有成功响应：`{"code":0,"data":...}`；失败：`{"code":<int>,"message":"..."}`。

### 上传预览

```bash
curl -X POST "$BASE_URL/api/items" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@page.html" \
  -F "title=演示页" \
  -F "notes=可选备注" \
  -F "expires_in=7d"
```

字段：`file`（必填）、`title`、`notes`、`expires_in`、`expires_at`。

### 列表

```bash
curl -G "$BASE_URL/api/items" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "q=关键词" \
  --data-urlencode "status=active" \
  --data-urlencode "favorite=true" \
  --data-urlencode "page=1" \
  --data-urlencode "page_size=24"
```

| 参数 | 说明 |
|---|---|
| `q` | 标题/备注关键词 |
| `status` | `active`（默认）或 `trash` |
| `favorite` | 可选，仅接受字面 `true`（只返回收藏项，其他值返回 `40001`） |
| `page` | 页码，默认 1 |
| `page_size` | 每页数量，默认 24，最大 100 |

排序固定为 `updated_at` 倒序；`favorite` 可与 `q`、`status`、`page`、`page_size` 自由组合。

响应 `data`：`{items, page, page_size, total}`。

### 详情

```bash
curl "$BASE_URL/api/items/$ITEM_ID" \
  -H "Authorization: Bearer $API_KEY"
```

### 更新元数据 / 有效期

```bash
curl -X PATCH "$BASE_URL/api/items/$ITEM_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"title":"新标题","notes":"新备注","expires_in":"30d"}'
```

### 收藏 / 取消收藏

```bash
curl -X POST "$BASE_URL/api/items/$ITEM_ID/favorite" \
  -H "Authorization: Bearer $API_KEY"
```

```bash
curl -X DELETE "$BASE_URL/api/items/$ITEM_ID/favorite" \
  -H "Authorization: Bearer $API_KEY"
```

两者均返回更新后的 item；幂等，重复收藏/取消都成功（重复收藏保持首次的 `favorited_at`）。仅限 `active` 条目：回收站项返回 `40900`，不存在返回 `40400`。

- 收藏切换**不更新** `updated_at`，不影响列表排序。
- `favorite` 不能通过 `PATCH /api/items/{id}` 修改（未知字段被忽略），须用上述专用端点。
- 收藏为全局状态，所有 API Key 共享同一份收藏。

Item 字段：`favorite`（bool）、`favorited_at`（RFC3339 UTC 字符串或 `null`，收藏时间；取消后为 `null`）。

### 替换内容（ID 与公开 URL 不变，触发重新截图）

```bash
curl -X PUT "$BASE_URL/api/items/$ITEM_ID/content" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@updated.zip"
```

### 移入回收站

```bash
curl -X DELETE "$BASE_URL/api/items/$ITEM_ID" \
  -H "Authorization: Bearer $API_KEY"
```

### 从回收站恢复

```bash
curl -X POST "$BASE_URL/api/items/$ITEM_ID/restore" \
  -H "Authorization: Bearer $API_KEY"
```

### 彻底删除（不可恢复）

```bash
curl -X DELETE "$BASE_URL/api/items/$ITEM_ID/permanent" \
  -H "Authorization: Bearer $API_KEY"
```

### 缩略图（需鉴权）

```bash
curl "$BASE_URL/api/items/$ITEM_ID/thumb/desktop" \
  -H "Authorization: Bearer $API_KEY" -o thumb.webp
```

`variant`：`desktop` 或 `mobile`；无缩略图时 404。

## API Key 权限范围

| 资源 | Session（Cookie） | API Key（Bearer） |
|---|---|---|
| Items 读/写（上传、PATCH、替换、收藏、回收站、恢复、硬删） | ✅ | ✅ |
| 缩略图 | ✅ | ✅ |
| API Key CRUD（`/api/keys*`） | ✅ | ❌（40300） |
| 改密、浏览器安装（`/api/settings/*`） | ✅ | ❌（40300） |
| 公开页 `/c/{id}/` | 无需登录 | 无需登录 |

## 错误处理

| HTTP 状态 | Code | 含义 |
|---|---|---|
| 400 | 40001 | 参数/校验失败（无效过期、zip 不安全、缺 index.html 等） |
| 401 | 40100 | 未登录或 Key 无效/已吊销 |
| 403 | 40300 | 禁止（Key 访问 Key 管理、Session 专用接口等） |
| 404 | 40400 | 资源不存在 |
| 409 | 40900 | 状态冲突（如对已删除项的错误操作） |
| 413 | 41300 | 文件过大 |
| 500 | 50000 | 内部错误 |

收到 401 时检查：
1. `Authorization: Bearer hp_...` 是否正确
2. `base_url` 是否指向正确的实例与端口（默认 **7849**）
3. Key 是否已在 Web 设置页吊销

## 注意事项

- 更新、删除操作使用 Item 的 `id`（URL-safe 公开 id），不是文件名。
- 截图状态见 `screenshot_status`：`pending` / `ready` / `failed` / `no_browser`；无浏览器时上传仍成功。
- 所有时间字段为 ISO 8601（RFC3339）格式。
- JSON 请求建议 `--data-binary @body.json`，避免 shell 编码问题。
