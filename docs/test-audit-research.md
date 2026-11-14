# 问题测试调研与 test-audit 设计依据

本次调研为通用技能提供判例，不是三个项目的全量质量认证，也不直接修改目标仓库。先完成三个仓库的只读调研，主代理核对代表性源码与历史，再由 Droid/Opus 基于完整材料质询，最终由主代理裁决。早先过早发起的咨询已请求取消，不用作定稿依据。

## 基线与方法

三个调研子代理均为 Pi / `cliproxyapi/glm-5.3-flash`；完整证据顾问为 Factory Droid / `claude-opus-5-5`，没有更换模型。目标工作树均干净，主代理复核时 HEAD 未变：

- **musiver**：`4025e946dd4804107c50ffcc5790527961961331`。多端 Rust/TS/Kotlin/Swift/ArkTS，调研包含统一 runner、卫生基线、注册与设备证据机制。
- **tma**：`3becd7831bdb02ff6bd82377e4b14e9ae5836f77`。Rust/Web，调研包含分片门禁、等待纪律、真实服务契约与 Playwright 入口。
- **fast_ship**：`910380f7e370aecb04826cf88caae3b97255dd1f`。Go/Vitest；本地跟踪的 origin/main 领先 40 个提交，未 fetch/pull，不代表远端最新。主代理只读比较 DB、路由和耗时文档等主要样本与该跟踪分支无差异，结论仍只绑定本地 HEAD。

以配置/文件/词法统计作广度清点，代表性深读追踪生产代码与决策；没有逐一审阅所有测试。未运行目标项目构建或测试用例。tma 子代理另执行了 `bash scripts/check-test-sleeps.sh`（通过）及 `npx playwright test --list`（默认入口收集 93 用例）；前者是静态检查，后者是收集，不是业务用例执行证据。

原始报告和咨询工作材料在 `/tmp/test-audit-{musiver,tma,fast-ship}.md`、`/tmp/test-audit-synthesis.md` 与 `/tmp/test-audit-opus-final.md`。以下保留经裁决的可持久引用结论；临时文件不作为技能安装依赖。

## 代表性问题与处理边界

### 1. 执行失真：存在测试不代表按预期执行

- tma `apps/web/package.json:11` 的 `test:e2e` 没选 real/acceptance 配置；收集成功不能证明维护配置中的服务、隔离与状态设置生效。建议明确正式入口并核对收集集合。
- tma `crates/server/src/replaygain_batch_tests.rs:166-190` 缺 ffmpeg 时返回 None/打印 SKIP，调用者可提前成功返回。需明确必需/可选依赖及执行状态，不用静态 grep 推算运行时 skipped 数。
- Musiver `clients/ohos/entry/src/test/List.test.ets:353-360` 依赖先于 core 初始化运行。已有漏注册/哨兵机制不能证明顺序依赖已消除；先考虑自建前置状态，顺序门禁只在核实调度语义与平台限制后兜底。

### 2. 环境失真：测试的世界偏离被保护的世界

- Musiver `clients/desktop/src/test/setup.ts:26-59,127-128` 的宽兜底 Proxy 不只可能隐藏未知调用，还会响应协议属性 `then`；初始化路径 `src/platform/wasm/init.ts:245-249` 有 await。
- 主代理用 Node `v26.7.0` 从实际 setup 文件提取 storage 工厂，提供仅实现调用转发/函数身份的最小 `vi.fn` 替身，在项目外隔离运行：Promise 同化调用了 `then(resolve,reject)`，30ms 后仍未 settle；每次取未知属性得到不同函数。源码中的 asyncNoop 不调用 resolve/reject，解释了挂起机制。
- 这验证的是 **JS 机制与该工厂**，不是 Vitest 集成或受影响用例数；本地没有 desktop 的 Vitest 依赖，未安装。不能据此说所有现有测试都挂起或假绿。复现实验保存在 `/tmp/test-audit-proxy-proof.mjs`。
- Musiver 手写 wasm 分类替身是潜在语义漂移，已有真实路径对照缓解。风险应查替身/真身差异，不按 mock 密度判断。
- fast_ship `server/cmd/server/main.go:191`、`migrate_review_test.go:16` 与 `internal/service/service_test.go:63-68` 的 DSN/pragma 有差异。要逐测试判断哪些差异影响迁移契约；构造历史脏数据可能需要暂关 FK，内存库不必照搬 WAL。

### 3. 断言没有保护所称行为

- tma `apps/web/tests/folder-picker.spec.ts:30-46` 确有断言（根目录非空，且 beforeEach 也断言列表），并非原报告所称“零断言/恒绿”。缺口是条件展开可被绕过，展开后的子节点未验证。应补核心行为断言，通用 expect-expect lint 抓不到这个缺口。
- 负向时窗太短可能漏检。tma `int44-resume.spec.ts:249-255` 验证音乐曲目不写进度，真的发生写入就是应报警的产品行为；不能把报警称为误报，更不能改成首次满足“目前为空”就通过的轮询。

### 4. 实现耦合：先保留契约，再替换检测方式

- Musiver `core/crates/musiver-ohos/tests/search_pagination_mapping_test.rs:45-55,173-190` 锚定字段顺序和函数体写法，但主机不能直接引用 NAPI 是其动机。建议核查 ABI/绑定契约与替代可执行保障，再清理实现快照，而非直接删除。
- fast_ship `server/internal/router/bot_contract_test.go:10-30` 按格式切 router.go，可能漏掉其他文件注册的禁用路由。保留“不开放管理路由”的决策契约，优先改真实路由清单断言。
- Musiver `provider_boundary_guardrail_test.rs:24-46` 是依赖边界政策；tma SQL 渲染形状、生成物再生成比对也可能是正当结构契约。文本断言的正/负方向都不能代替有效性核验。

### 5. 非确定性与资源隔离

- tma `settings-routing.spec.ts:184-205` 两用例分别关闭/打开共享服务注册开关，没有恢复原值；单独运行或失败等路径可能污染 attach 目标。应独占实例或还原读取到的原值，不写死 true。
- tma fpk-control 改 env 的测试还需追同进程读者，不能仅看 set_var 数。Rust 2024 下只约束写者的 Mutex 不能为任意读者建立安全保证，优先参数化纯解析；本次未运行并发重现。
- fast_ship `server/internal/repository/bot_usage_test.go:16-44` 可追到开 DB 无 cleanup 的样本。原报告“40 文件无 Close”是候选统计，须逐条追 helper/所有权；不能一律升级成已复现泄漏，更不能据此推导其他包的耗时。

### 6. 成本错配与证据不足的因果判断

- Musiver full-app-init 基线是迁移低层测试的入口，但全装配冒烟仍有独有价值；数量不等于实测慢。
- fast_ship `docs/internal/testing.md` 记载 service 包 race 五轮 504–763s，涉及不同修复阶段与负载噪声，并明确插桩开销。拒绝原报告“126 处 sleep 焊死该耗时”的因果说法，成本需分解实测。
- `aae43d9f` 实际改的是 `web/src/components/bots/bot-markdown.test.tsx`，非原报告写的 incremental 文件。历史记录单跑约 0.4s、全量争用偶发越过 5s，改为 60s 超时但未改正确性断言。放宽运行保险丝不必然掩盖产品错误；缩减样本或拆分也要保留等价性保护并验证现实成本。

### 7. 冗余与失效：证据不足时不推荐删

三个仓库未提供足够证据支持批量删除测试。跨端 parity、不同层接线、历史回归不能按重复输入判冗余；测试/生产行数比、大文件和弱断言数量只作选样入口。陈旧测试报告应标历史基线或移除，不把它算作已证实的无效测试用例。

## 与顾问讨论后的裁决

- **采用**：跨语言统一语义，按 runner 配置适配；七类检查；环境差异表；一根因一条发现；执行证据分声明/收集/执行/强制；默认只读、有限预算、未覆盖显式化。
- **采用**：五种动作，删除要有契约退休或逐条替代覆盖；重写须说明错误实现如何变红；有限样本未失败不能证明无 flaky。
- **采用**：共享 setup/helper 优先；正向等待与负向观察分别处理；lint 要有可靠判定、合理豁免与正确替代写法。
- **不机械采用**：“每测试文件恰好归属一个 runner 配置”会误伤项目矩阵；改成每文件的归属及重叠可解释。“基线总数只减不增”可能一删一增掩盖新增；改按条目标识/规则核对，是否增量门禁由项目决定。
- **不采用**：按语言建重复技能、预设阈值打分、跨语言正则定罪、自动删测、统一增设 CI。三个项目已选择本地验证，缺口要按执行链判断。

## 技能交付与验证边界

技能位于 `skills/general/test-audit/`：五步主流程，判据、runner 六问、lint 三份按分支读取的参考。按 writing-for-agents 组织完成标准，不依赖本调研或其他技能，项目专有路径与阈值仅保留在此设计记录。

设计回放覆盖了几个对抗样本：有 expect 但未保护核心行为、负向窗口、Proxy 协议、迁移 fixture 例外、无远端 CI、合法架构护栏和多配置矩阵，预期分别得到定向加固/有界证据/机制补证/显式差异/执行链核验/保留/解释重叠，而非统一删除。未用该技能重跑三个项目全量测试或宣称检出率。

本技能交付的本地验证：

- `node scripts/check.mjs`：通过，19 个技能的一致性检查及 22 个既有测试文件全绿。
- 单独使用 spec reporter 执行同一测试集合：160 项通过，约 150.5 秒。首次统一检查的 120 秒观察预算不足；进度输出显示 GC 夹具测试占据主要时长，未据此修改既有测试。随后将命令观察预算设为 240 秒，统一检查正常结束。
- 六份改动文档的 29 个相对链接/锚点、五步流程及主技能无本机路径检查通过；`git diff --check` 通过。没有新增扫描器或 lint 规则实现，lint 部分是按项目核验并接入的建议流程。
