# 审计准则

目标是提出 deepening opportunities，而不是罗列风格问题或理论重构。

## 词汇（必须使用这些英文术语，不要替换）

| 术语 | 含义 |
| --- | --- |
| **module** | 有 interface 与 implementation 的代码单元 |
| **interface** | 调用方看到 / 依赖的面（也是测试面） |
| **implementation** | 在 interface 后面的实现 |
| **depth** | Deep = 简单 interface + 丰富 implementation；Shallow = interface 几乎与 implementation 一样复杂 |
| **seam** | 可替换行为的位置（至少两个 adapter 才是真正的 seam） |
| **adapter** | seam 后的具体替换（例如生产走 HTTP，测试走内存） |
| **leverage** | 一个 interface 服务许多调用点 |
| **locality** | 相关行为与缺陷集中在一处 |

不要用 component / service / unit 代替 module；不要用 API / signature 代替 interface；不要用 boundary 代替 seam；不要在本应说 module 时改用 layer / wrapper。

原则：

- **Deletion test：** 删掉被怀疑为浅的 module，复杂度是集中了还是只被挪走？「集中」才是信号。
- Interface 就是测试面。
- 一个 adapter = 假想 seam；两个 adapter = 真正的 seam。
- 若项目有 `CONTEXT.md` 领域词表，领域概念用那些名字。若有 `docs/adr/`，不要轻易重新争论已有 ADR。与 ADR 冲突的候选，只有摩擦大到值得重开时才提出，并明确标出。

## 探索

先定范围。深化一个 module 的收益来自「以后改它更容易」，因此加重最近有变更的区域：

- 用户已指定方向（某个 module、子系统或痛点）就按该方向，不再自己推断热点。
- 否则先看一段近期提交历史（如 `git log --oneline`），从反复出现的文件和区域入手；变更分散时再扩大范围。
- 先读相关的 `CONTEXT.md` 和 ADR（若存在）。
- 有机探索并记录摩擦：理解一个概念是否要在许多小 module 之间跳转；哪些 module 是浅的；是否把纯函数抽出去只为了好测，而真正的缺陷在调用方式上（没有 locality）；紧耦合是否从 seam 泄漏；哪些部分未测或难以通过当前 interface 测试。
- 对疑似浅 module 做 deletion test。

查证用当前环境里的常规工具即可：读文件、搜索引用、git、以及项目已有的测试或静态检查（如语言自带 linter、`vet`、semgrep 等）。它们用来对照代码，不是定罪依据。需要核对依赖版本时查真实 registry，查不到标为未核验，不得编造。

## 边界

- 本轮只出审计报告；交互式 grilling 与动手重构留给用户另行发起。
- 纯风格、重命名偏好或「整体重写」不算通过核实的发现。
