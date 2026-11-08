---
config: t3-patrol.json
version: 1
---

# t3-patrol 初始化

由 bstack-setup 调用，写 `environments.json` 与 `t3-patrol.json`，并创建或更新巡检定时任务。默认值见 [config.defaults.json](config.defaults.json)，键的含义见 SKILL.md 中引用它们的段落。

## 0. 前提

- 在打算长驻巡检的线程里运行：`schedule_task` 默认绑定当前线程，以后每轮巡检都发到这里。不是这样的线程就停下，请用户在巡检宿主上新开一个线程再运行本技能。
- 宿主设备要常开，并且能连到所有环境。向用户确认这台设备适合当宿主。
- 线程须跑在 ACP 类 harness（droid、devin 等）或 pi 上，快照脚本才拿得到 T3 MCP 会话；Codex 只能按 [snapshot.md](snapshot.md) 手工取证。

## 1. 认设备，写 `environments.json`

1. 调 `t3_environment_links`，按 SKILL.md 第 0 步的方法认出每个环境是哪台设备。
2. 给每个环境拟一个短别名（如 `pc`、`mac-mini`、`linux`、`mbp`），连同设备和依据列表给用户确认；用户可以改名。
3. 合并写入，保留文件里已有的其他条目：

   ```json
   {
     "version": 1,
     "environments": {
       "pc": { "environmentId": "<id>", "device": "Windows PC", "os": "windows" }
     }
   }
   ```

   `os` 取 `windows` / `macos` / `linux`。不可达的环境问用户是否保留；已不存在的条目经用户确认后删除。

## 2. 验证快照通道

```bash
node <t3-patrol 技能目录>/scripts/patrol-snapshot.mjs --self <当前线程 threadId> > /tmp/t3-patrol-snapshot.json
```

退出码为 0，且 `environmentsFile` 的 `unlisted`、`missing`、`errors` 都为空才算通过。写完容量池后重跑一次，核对各环境 `capacity.device` 已对上别名、`config.warnings` 为空、`freeByRepo` 里目标仓库的可建数符合用户预期。退出码 2 说明当前 harness 没有注入 T3 MCP 会话，告诉用户需要切换到 ACP 类 harness 或 pi，或接受手工取证。

## 3. 询问偏好

先展示默认值，再按组问，用户说「默认」就跳过该组：

- **模型阶梯** `modelLadder`：巡检代回话时依次尝试的 harness 与模型，最后一档标 `fallback`。用户的 harness 或模型不同才需要改，整组替换。
- **名额** `capacity`：每台设备默认的最大活跃线程数、占用窗口小时数、最低剩余磁盘、单线程默认磁盘占用 `defaultFootprintGB`、新线程按在建预留磁盘的小时数 `growthWindowHours`。
- **容量池** `capacity.devices`：按设备别名分仓库限额，整组替换。先列出各环境的项目 `canonicalKey`（`t3_project_list`），再逐台问：

  ```json
  { "device": "pc", "pools": [{ "repos": ["fj.frp.musiver.cn/fjbobo/musiver"], "max": 5, "footprintGB": 30 }, { "repos": "*", "max": 4 }] }
  ```

  `repos` 写完整 `canonicalKey` 最稳；只写仓库名会命中不同宿主上的同名仓库。线程只进第一个匹配的池，`"*"` 收其余仓库，审查线程不占池。设备总上限 `maxActiveThreads` 缺省为各池 `max` 之和，即各池可以同时用满；只有用户想再压低总数时才写。
  `footprintGB` 是该池一个线程的峰值磁盘占用（工作树加构建产物），巡检用它把剩余磁盘折算成可建数。构建产物大的仓库要问；用户不清楚时，在该设备已有的工作树上量一次（`du -sh ~/.t3/worktrees/*`，远程设备经资源探测线程去量）给个建议值。没写的池用 `defaultFootprintGB`。
- **阈值** `thresholds`：排队、沉默、审查等待、重发冷却等分钟数。多数用户沿用默认。
- **久审审计** `convergenceAudit`：PR 打开小时数、审查轮数。
- **频率** `schedule.everyMinutes`：巡检间隔，最少 1 分钟。

## 4. 写配置并试跑

1. 按 bstack-setup「写配置」规则写 `t3-patrol.json`，然后跑 `node <t3-patrol 技能目录>/scripts/patrol-config.mjs`：退出码 0，`warnings` 与 `environments.warnings` 为空。
2. 试跑：按 SKILL.md 第 1–3 步走一轮，只列每个候选拟采取的动作，不发送消息、不改线程，交给用户过目。用户对某类判定有异议时，回到第 3 步调整对应阈值。

## 5. 定时任务

1. 找已有任务：`schedule.scheduledTaskId` 有值时在宿主环境 `list_scheduled_tasks` 里按它找；没有时找提示词提到 t3-patrol 的任务。
2. 已有任务且绑定的就是当前线程：用 `schedule_task` 带 `scheduledTaskId` 更新，只传要变的字段（`schedule`、`prompt`），不重建。
3. 已有任务绑定在别的线程：告诉用户，经确认后在当前线程新建，再把旧任务 `enabled: false` 停用。
4. 没有任务：新建。

   ```
   schedule_task {
     title: "T3 巡检",
     prompt: "使用 t3-patrol 技能巡检。",
     schedule: { type: "interval", everyMs: <everyMinutes × 60000> },
     bindToCurrentThread: true
   }
   ```

   提示词只写这一句，规则都在技能里。已有任务的长提示词，问用户后改成这一句。
5. 把返回的 `scheduledTaskId`、`boundThreadId` 和宿主的 `environmentId`（`t3_environment_links` 返回的顶层 `environmentId`）写进 `t3-patrol.json` 的 `schedule`，向用户报告 `nextRunAt`。

**完成标准**：第 2 步通过；`patrol-config.mjs` 无警告；试跑结果已交用户过目；定时任务回读 `enabled: true`，绑定当前线程，间隔与配置一致，`scheduledTaskId` 已写入配置。
