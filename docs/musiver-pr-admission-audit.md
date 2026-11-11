# Musiver：审查衍生 PR 与改动准入复盘

## 范围与口径

2026-11-11 复盘 Forgejo `fjbobo/musiver` 的 #1–#127：创建时间为 11-07 16:47 至 11-11 17:57（UTC+8），其中 69 个创建于 11-10/11-11。分页读取全部 PR 正文、评论、review、行内意见与改动文件，重点核对 UI 历史 diff、已发布截图及关联 issue。PR 列表快照为 119 merged、3 closed-unmerged、5 open；状态会继续变化，以下判断绑定本次快照。

统计的是**有来源证据的下限**，不是把标题含 `fix` 或正文含“审查”的都算进去：

| 互斥分组 | 数量 | 含义 |
| --- | ---: | --- |
| 直接审查衍生 | 27 | 前一个 PR 的代码/视觉意见被另立 PR 处理；其中 #31/#87 的源为迁移前 PR，只能核对目标正文的来源自述 |
| 方向顾问/收敛审计衍生 | 5 | #30、#34、#63、#77、#99；不冒称都是云端审查评论触发 |
| 上述链路的进一步实施 | 6 | #89、#105、#120、#123、#124、#127；含跨端对齐与裁决时切出的独立缺陷 |
| 自动扫描遗留 | 1 | #17 来自 #10 的 OSV 扫描，另列，不算“审查者发现” |

最窄口径为 **27/127（21.3%）**；含顾问与后续链为 **38/127（29.9%）**。加上自动扫描则为 39。**这些都不是“错误 PR 率”**，必要性须逐项判断。

`fjbobo` 账号也被代理使用，不能把该账号的评论都当成人类批准；Fast Ship 的代理“共识”同理。PR 实时状态以 Forgejo 为准，Fast Ship 内嵌 PR 缓存存在滞后，例如 INT-1780 详情仍把已关闭的 #115 列为 open。

## 一、哪些 PR 是审查意见另立出来的

### 直接审查衍生：27 个

每行的来源链接给出发现或处置原文；“应修”不表示原作者的所有修法与验证声明都正确。

| 后续 PR | 源 PR / 证据 | 内容与判断 |
| --- | --- | --- |
| [#12](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/12) | [#8 复审 P1](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/8#issuecomment-17948) | 阻塞 FFI 从 Main 移到 IO，有 ANR 路径，应修 |
| [#28](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/28) | [#20 Note 与后续清单](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/20#issuecomment-18160) | 来源准备取消/等退出及兼容入口收口；不是单纯格式建议，需按取消契约判断 |
| [#31](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/31) | 正文引用旧 #737 bot Note | 已有定向测试接入自动门禁，有实际覆盖价值；未回读旧仓原意见 |
| [#37](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/37) | [#23 menuIndex nit](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/23#issuecomment-18199) | 重载后菜单落到另一行，稳定行键修复有行为价值 |
| [#66](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/66) | [#21 视觉 minor → INT-1740](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/21#issuecomment-18685) | 歌词透明度下限；实际无效，不该照原样交付 |
| [#68](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/68) | [#59 第 2 轮视觉意见](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/59#issuecomment-19141)；INT-1747 正文确认来源 | 末卡不可完整到达、箭头压封面；应修真实缺陷，同时保留出血设计 |
| [#71](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/71) | [#62 四条复审处置](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/62#issuecomment-19317) | 门禁 baseline 漂移、排除域与豁免错误，存在实际失败，应修 |
| [#72](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/72) | [#61 第 6 轮 P1](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/61#issuecomment-19191) | 注释触发现有 lint，非“仅美化注释”；恢复门禁有必要 |
| [#75](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/75) | [#61 nit/P3，原定随下次实质推送处理](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/61#issuecomment-19233) | 注释精度、等价 dirname 改写等；不值得因收尾义务单独开 PR |
| [#76](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/76) | [#66 承认无效后决定另开](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/66#issuecomment-19372) | 为让下限生效而改变歌词渲染设计；方向不成立，已关闭 |
| [#87](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/87) | 正文引用旧 #774 复审 P2 | 孤儿 sidecar 纳入 repair；有具体资源回收缺口，不按 P2 字样直接否定 |
| [#88](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/88) | [#60 视觉遗留](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/60#issuecomment-19165) | 错误页把文件存储说成钥匙串、缺可操作恢复入口等；包含真实误导，不能把整单当纯审美 |
| [#90](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/90) | [#80 P2 跟进](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/80#issuecomment-19694) | 升级后输入指纹漏刷，恢复 license 检查；应修，最好原交付就带齐 |
| [#91](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/91) | [#80 确定性互等 P1](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/80#issuecomment-19701) | 问题真实，后来 main 已等价修复，分支 diff 为空后关闭正确 |
| [#92](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/92) | [#21 minor → INT-1739](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/21#issuecomment-18685) | 浮窗文字/省略号贴边，局部 padding 修复有效，不应误杀 |
| [#93](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/93) | [#68 Note-2 的后续统一项](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/68#issuecomment-19282) | 非 bleed 箭头仍压内容，统一安全槽有可用性收益；不等于所有后续视觉打磨都必做 |
| [#94](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/94) | [#79 P2：客户端回写归属缺口](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/79#issuecomment-19512) | 旧服收藏补丁串入新会话，真实状态错误，应修 |
| [#100](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/100) | [#30 第 3 轮 nit](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/30#issuecomment-18418) | 当前宿主码均为大写，无真实小写输入；不值得为未来假设单独开 PR |
| [#103](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/103) | [#97 第 2 轮 nit](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/97#issuecomment-19848) | 测试干扰负载与诊断体积；可作测试维护候选，须以实际失败成本证明独立价值 |
| [#106](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/106) | [#93 minor 后续](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/93#issuecomment-19835)；INT-1776 确认来源 | 对齐、禁用圆钮与补证；效果真实，但不应仅因 nit 已登记就自动立项 |
| [#108](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/108) | INT-1755 原文明确引用 #77 云审第 1 轮 P2 | 切会话后刷新按钮仍被旧请求锁住；有可达 UI 状态错误，应修 |
| [#109](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/109) | [#94 第 1 轮 P2](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/94#issuecomment-19761)；INT-1771 确认来源 | restore 中新令牌配旧曲目 ID；真实跨会话写入窗口，应修且须核多出口复位 |
| [#111](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/111) | [#101 Note，原定随下次相关改动补](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/101#issuecomment-19893) | 补脆弱播放时序守卫测试，有可执行反例价值；是否立即独立做需权衡，不是必做收尾 |
| [#112](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/112) | [#67 R2 留下的双 renew 窗口](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/67#issuecomment-19395) | 下载迁移直连绕过屏障，正确性修复，不因窗口窄就忽略 |
| [#114](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/114) | [#107 Note](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/107#issuecomment-20014) | 同构安装失败仍误报成功，当前调用方可达，值得修 |
| [#115](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/115) | [#92 第 5 轮 minor 登记](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/92#issuecomment-19985) | 透明浮窗新增深色渐变；应先确认产品取舍，不能仅因底图透出就自动改视觉方向 |
| [#116](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/116) | [#110 视觉意见 → INT-1785](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/110#issuecomment-20115) | 最初“错封面”归因被修正为 failed 槽位粘滞；重新取证后才落修法，是正面案例 |

关联 issue 取证：[INT-1747](https://ship.frp.musiver.cn/projects/5a359b46-d8f7-496d-83b8-26d3cd371317/issues/47528e6e-d438-43f0-9cd3-b26d4aa88703)、[INT-1776](https://ship.frp.musiver.cn/projects/5a359b46-d8f7-496d-83b8-26d3cd371317/issues/8b6e0d03-0fd1-47aa-9475-04a5bbb3af3f)、[INT-1755](https://ship.frp.musiver.cn/projects/5a359b46-d8f7-496d-83b8-26d3cd371317/issues/7d9caa18-4926-45a6-8dc2-d6488310bd19)、[INT-1771](https://ship.frp.musiver.cn/projects/5a359b46-d8f7-496d-83b8-26d3cd371317/issues/9d29bd36-4d4a-48d3-91e3-ab97976f8db4)。

### 顾问/收敛审计：5 个

- [#30](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/30) ← #10：方向顾问核消费链后，把诊断与用户呈现分离为结构化原因码专项；不是凭“统一”就可判无用。
- [#34](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/34)、[#63](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/63)、[#99](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/99) ← 旧 #774 / INT-1574：分别处理根身份启发式不收敛、校验路径与操作路径不一致、目标范围删除被整树判定过度阻断。源审计未回读，来源依据为当前正文。
- [#77](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/77) ← [#27 顾问 W-D](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/27#issuecomment-18511)：随机专辑迟到响应串入新会话，已用撤修复即失败的用例取证，独立修复合理。

### 链式实施：6 个

- [#89](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/89) ← #77：桌面端同型失败提示归属。
- [#105](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/105) ← #94，[#120](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/120) ← #105：收藏补丁归属的 Desktop/Web、Swift 段。
- [#123](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/123) ← #112：方向裁决中切出的“对账复活已取消下载”独立缺陷，并非同一条 review 原文。
- [#124](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/124) ← #108：刷新请求迟到收尾的 Android 段。
- [#127](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/127) ← #109：切换写入禁止态的 Swift 段。

另列 [#17](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/17) ← #10 的 OSV 扫描遗留。未把 #18/#73 的测试失败、#69 的合并交互、#58/#65/#78/#74/#79 的验收文档段，以及 #125 既有需求混入直接审查计数。来源不足的 #113 等保持未知。

## 二、哪些不该创建，哪些只是不能照原样合并

### 1. #76：不该为了挽救上一个无效修复而改变设计

证据最强的反例是 [关闭说明](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/76#issuecomment-19471)：

> “非活跃行绘制已唱层”改变了既定设计（只有当前行需要绘制已唱层，iOS 同口径 head=-1），不继续推进。

审查正确发现 #66 下限不生效，**不代表“让非当前行也绘制已唱层”就是正确修法**。#76 还引入了未开始行首词亮边、叠层后实际 alpha 偏离声明等问题。应回到原可读性场景定位，必要时删掉无效改动，而不是强行让既有常量发挥作用。#76 未合并，不能说它已经破坏线上功能。

### 2. #66：当前内容不该作为已解决问题的 PR 交付

这是“错误实现/验证”，不等同于“可读性问题根本不值得调查”。作者在 [19372](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/66#issuecomment-19372) 承认其为无像素变化的死代码：非当前行不画已唱层，当前行 alpha 恒为 1，0.45 下限没有生效入口。

本次另用 Pillow 实际比较其公开浅色前后图（T0QOpGeLJa / 0vNRqhLpjk）：1080×2400，全部差异仅在状态栏 bbox `(95,14,967,47)`；排除顶部 80px 后，**歌词和其余界面差异像素为 0**。这是复核历史截图，不是本次重跑应用。

更危险的是 INT-1740 的代理共识仍宣布 Android 已修好，并要求其他端照搬 0.45。源修法未被证明就跨端传播，会把一次无效修改放大成多端任务。应先更正源事实，再决定是否存在各端同型缺陷。

### 3. #100、#75：我认为不值得独立创建

- **#100** 原 PR 回复与后续正文都明确：当前 Rust 宿主码是编译期全大写，**不存在小写到达的真实路径**。针对未来假想输入的加固，可随真正修改该契约时处理，不值得现在单独开 PR。其后又因为这个 PR 的范围冒出 snapshot 通道统一等要求。不是证明该补丁有害，而是没有足够独立收益。
- **#75** 明说“无新需求”“nit/P3 集中收尾”“零行为变化”，原处置是随下一次实质推送修正。严重误导的操作文档可以独立修，但此单没有证明为何这些精度调整与等价改写需要即时独立交付。默认留在原记录，相关工具下一次有实质改动再处理更合适。

成本线索：快照中 #75 最新代码审查已到第 10 轮，#100 到第 8 轮；末轮均含纯整合复核。不是每轮都在修该 nit，也不能当作精确工时，但足以说明“小补丁”并不等于“小工作流成本”。

### 4. #106、#115：不应仅凭 minor 自动创建，先做产品/收益判断

- **#106** 的对齐与禁用按钮可见性确实改善；没有证据说明它破坏功能。但源 #93 已定性纯视觉 nit、无功能影响。我的判断是：可作为相关区域设计打磨候选，未明确排期或证明重要可用性收益时，不该因“后续已登记”就立刻独立做。独立 UI 核对记录显示其代码/视觉分别走到 8/4 轮；这是收益与流程投入失衡的样本，不是代码错误的证据。
- **#115** 的字形混读能从截图看到，不能称纯粹幻觉；但歌词浮窗本来透明、可拖动，是否用深色渐变遮住桌面是产品取舍。更早 [#21 的回复](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/21#issuecomment-18476) 已把同型重叠解释为启动器小组件与浮窗的叠加事实，选择保留。#92 又把它立单，#115 直接实施背板，没有先核清旧裁决和新授权。我的默认处置会是暂存/确认，而非自动开实现 PR。

#115 新图仍能读出日期，且前后是不同歌词/单行双行状态，不能证明目标完整达成；第二轮审查也指出单行多出空黑块等问题。它已关闭未合并，公开记录没有关闭理由，**不能臆测是用户讨厌背板，也不能说已损坏主线**。INT-1780 已关闭而 workflow 仍为 in_progress，说明派活还必须核真实状态和处置，而不只看工作流字段。

### 5. #91：后来应关闭，不足以证明最初不该创建

[关闭回复](https://fj.frp.musiver.cn/fjbobo/musiver/pulls/91#issuecomment-20036) 明确：main 已用更优等价方案修好，整合后 diff 为空。因此应停止并去重；原来的 60s 互等是真问题，不能倒推当初发现是无价值的。

### 不能误杀的 UI 修复

#68 的“滚动末端仍看不全”和静止 peek 被裁是两回事；最终保留了出血效果，修了末端可达与箭头压卡。#92 的 padding 是局部可读性改进。#125 虽非本次审查衍生，跨断点键盘焦点丢失是实际功能问题；视觉 bot 将顺序动作胶囊误认作播放按钮，已用 `activeTestid` 行为证据澄清。**结论不是“UI 审查都别信”，而是用状态与行为裁决，别按观感词或 P 级照单全收。**

## 三、错误立项的共同机制

1. **建议变需求**：review 的 minor/Note 被写成独立 issue，再被派活当作已授权需求；没有经过“是否值得做”的第二次判断。
2. **问题与修法混为一谈**：#66 无效的诊断成立，却被理解为必须实施 #76 的渲染扩张。
3. **忽略反证与旧决定**：像素零变化被解释成取景限制；早先保留透明/纵深的决定在后续 issue 中丢失。
4. **用完成形式代替效果**：新增常量、单测过、截图存在，被当成问题已修；没有核对实际消费链和可见结果。
5. **共识与跨端传播洗掉来源**：代理先写“已拍板/已修”，后续线程只读共识照搬，未复核源实现有效性和平台语义。
6. **预算只约束一个 PR**：当前 PR 不修 nit，收尾却要求另建单/交接，等于把停止条件换个容器继续执行。
7. **只比代码成本，不比工作流成本**：几行改动仍引发新工作树、编译、截图、生成物、审查和反复整合。

## 四、采用的标准与技能落点

准入规则唯一真源：[pr-review-loop/references/change-admission.md](../skills/general/pr-review-loop/references/change-admission.md)。判断顺序是：**需求锚点 → 当前证据 → 保留原行为的净收益 → 去重与去向**。明确用户新需求无需伪造“先有 bug”；安全、数据和并发高后果疑点优先调查，不能借低频/nit 忽略。

四种有效结果：本次修复、独立交付、暂存候选、不采纳。后两种留在现有记录即可；nit 不是承诺，issue 和提示词也不自动成为授权。

| 修改入口 | 行为变化 |
| --- | --- |
| pr-review-loop | 描述增加准入触发；开 PR/采纳意见先裁决，UI 按需读分支，分级不再默认制造后续任务 |
| pr-finish | 遗留先分流，只有已准入必交后续段才交接；纯验收可回写原 PR/issue |
| t3-dispatch | 准入先于优先级；来源不明、驳回或产品决定未定的项跳过，空位可留空 |
| t3-orchestrator | 派实现前沿用准入；顾问赞同不等于需求授权 |
| t3-patrol | M6/M13 不再强迫每条遗留建单/建线程；候选有去向即可收尾 |
| t3-patrol M15 | 可选产品改进未定时保留原行为、暂存或不采纳，继续无人值守收尾；原任务必需决定才交用户，技术实现仍自主决策 |
| 方向审计/交接引用 | 范围扩张优先撤回；拆 PR、跨端对齐和现有队列都须保留准入判断 |

项目案例仅保存在本复盘，未把 Musiver 的歌词数值、设备分工或 UI 设计写入通用技能。没有新增独立技能或配置项，避免增加日常调用负担。

## 验证边界

- 本次独立执行了公开截图像素比较；其余应用运行证据为历史 PR 报告与源码复核，没有重建或运行 Musiver。
- 两位只读研究者分别核来源和 UI，主代理回读关键原评论、补查 issue、修正漏项并统一裁决；没有将“研究者建议”当产品授权。
- `node scripts/check.mjs` 已通过：20 个技能、16 个测试文件全绿（exit 0）；`git diff --check` 通过。另核对 11 个改动 Markdown 文件的 62 个本地链接、无 U+FFFD、报告 27 行直接衍生 PR 与统计分组一致。不把这些文档/脚本检查宣称为模型实际行为测试。
- 本轮只改本仓库文件，未关闭/回滚任何 Musiver PR，未修改其 issue/共识，也未自动重新派活；安装副本与远程设备需按安装流程更新。
