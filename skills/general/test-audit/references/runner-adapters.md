# Runner 适配六问

适配单元是 **执行器 + 实际入口 + 配置**。从项目版本、`--help`、配置和现有日志找答案，不用语言名推断隔离能力；无支持的执行器照同一表调查。先概览全仓 runner，本轮只对选中候选涉及的 runner 展开六问，其余保留待查位置。

## 本轮深查所涉及 runner 的六问

1. **发现**：哪些目录/命名/属性/手工注册被收集？入口是否显式选维护配置？列举命令会不会加载配置、spec 顶层、插件或初始化外部资源？先读后运行，列举结果与静态文件清单对照。
2. **跳过**：原生 skip/ignore、条件早退、focused 用例、重试分别如何影响汇总与退出码？必需与可选依赖缺失是否可见？日志里的 SKIP 文本不等于 runner 的 skipped 计数。
3. **隔离**：并行到进程、线程、文件还是用例？同一进程内共享哪些全局/模块/单例？worker 重用、套件失败重启、顺序与清理有何语义？多个工作树或 runner 会不会共享端口/库/服务？
4. **时间**：框架能控制哪些时钟/队列？真实线程、网络、子进程、浏览器与数据库时间是否仍独立推进？是否有正向完成等待及负向持续观察原语？
5. **生命周期**：fixture/setup/teardown/cleanup 的作用域与顺序，失败/取消路径是否仍回收？资源可能由 helper 或外层拥有，追到所有者再判泄漏。
6. **已有防线**：lint、注册/哨兵、泄漏守卫、预算门禁、存量基线、失败事实库保护哪些路径？哪些改动被本地/远端验证链要求执行？报告是否绑定源码和配置？

## 常见模型的核验重点（不是默认答案）

- **JS/TS 单测（Vitest/Jest/node:test）**：pool/worker、模块缓存与 mock reset/restore、setup 的全局替身；异步断言是否被 runner 等待。检查 fake timers 覆盖范围、微任务推进、未处理 rejection 和未关闭句柄；node:test 的并发与 mock 能力按当前版本核对。
- **Playwright/浏览器 E2E**：默认配置与显式 `-c` 是否等价；testDir/match、项目矩阵、storageState、baseURL、webServer/attach、worker 与重试。浏览器 context 隔离不了服务端全局状态。恢复状态要还原原值，不是写死默认值；审计不得写入非本任务所有的服务。检查列表命令的实际副作用，而非假定它不执行任何初始化。
- **Rust（libtest/cargo-nextest/自定义 harness）**：进程/线程粒度与 profile，内联/集成/doctest 是否都被入口覆盖。进程 env、静态值和 Tokio runtime 可能处于不同隔离边界；paused time 不推进真实 I/O。`return` 不会自动成为 skip；panic 前后后台任务是否终止？
- **Go testing**：按包进程边界、`TestMain`、`t.Parallel` 与子测试生命周期；`t.Cleanup`/defer 是否覆盖失败路径；缓存是否影响复跑证据；`-race` 的插桩、超时与环境开销单列。只看单文件没 Close 不足以证明泄漏，也不能据此推导其他包的成本。
- **Swift/XCTest/Swift Testing**：实际 suite/进程并行方式，序列化约束的作用域；共享单例与异步任务完成、持久化路径、主线程和真实时间。套件内 serialized 不代表全进程互斥。
- **JVM/Gradle/Android**：test task 是否含目标 source set、fork/worker/协程调度器边界、静态状态与 mock 清理、虚拟时间和设备真实时间；本地与 instrumented 分开记。
- **设备/自定义运行器**：手工注册、开始/结束哨兵、runId、安装产物新鲜度、日志截断、失败退出码。注册顺序不必等于实际执行顺序，先看调度器；资源不足或设备缺失列为未验证。
- **Python/其他生态**：追 pytest/unittest 或实际框架的 collection/hooks、fixture scope、参数化、worker、全局模块与事件循环生命周期；已有 lint 只在确认适用版本与目标后建议启用。

## 搜索方法

以仓库清单定位配置和测试，再按本 runner 实际 API 搜索：skip/only/早退、sleep/时钟、mock/源码读取、资源创建、共享状态写入。由 helper 反向查调用者，优先高扇出路径。搜索到资源写入后继续找读者、所有者与 cleanup，而非做关键字计分。

统计文件数、行数、命中数、最大文件和改动热点仅用于选样；不是坏测试阈值。发现多份配置认领同一文件时核实是否为有意矩阵，不强制“一文件一配置”。
