# 生态与查询

本节说明如何发现清单、区分声明与锁定版本，以及如何只读查询 registry。这些是查证方法，不是必须安装的固定工具，也不是扫描运行器。当前环境里没有某个命令时，改用读文件和公开 HTTP 查询即可。

## 发现清单

在证据 SHA 上找出实际存在的清单和锁文件，不要根据仓库名去假定有哪些生态。常见线索（不限于）：

| 生态 | 清单（声明） | 锁或解析结果 |
| --- | --- | --- |
| npm / pnpm / yarn / bun | `package.json`（含 workspaces） | `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`bun.lock` |
| pip / PyPI | `requirements*.txt`、`pyproject.toml`、`Pipfile`、`setup.cfg` | `poetry.lock`、`uv.lock`、`Pipfile.lock`、`requirements*.lock`；另见 `constraints.txt` |
| Gradle | `build.gradle` / `.kts`、`settings.gradle` / `.kts`、`gradle/libs.versions.toml` | `*.lockfile`、Gradle 解析结果；包装器在 `gradle/wrapper/` |
| Cargo | `Cargo.toml`（含 workspace） | `Cargo.lock` |
| Go | `go.mod`、`go.work` | `go.sum`；注意 `// indirect`、`replace`、`exclude`、`retract` |
| SwiftPM | `Package.swift`、Xcode 工程里的 package 引用 | `Package.resolved` |
| ohpm | `oh-package.json5` | `oh-package-lock.json5` |

若还存在 Maven、Pub、NuGet、Bundler、Composer、GitHub Actions 的 action 钉扎、容器基础镜像或其它清单，按同样原则纳入，并在报告里点名。没找到的不要列为已覆盖。

monorepo / workspaces：每个子包的清单单独清点，再与根工作区汇总；内部工作区包不要当成第三方 registry 包去查 latest。

## 声明范围与锁版本

- **声明范围**来自清单：例如 `^1.2.3`、`~4.0`、Gradle 的版本目录别名、Go 的 `require` 行、BOM 或 `platform` 约束。
- **锁版本**来自锁文件或等价的解析结果，是当前仓库实际用的版本。分档、漏洞受影响区间都对这个版本判断。
- 只有声明、没有锁：写明「无锁」，最新稳定版仍可查询，但不要把声明范围或自己推算的「可能会解析到」写成锁版本。
- 版本目录、BOM、`constraints.txt`、`replace` / `override` / 强制决议，用来解释解析为何停在某版，不要和直接依赖行混写为两个无关的包。

## 只读查询

必须向对应 registry 做**本轮真实查询**，不要沿用记忆或过期报告中的「最新版」。在线来源注明抓取日期（含时区）和 URL，或所用命令与其输出依据。

查询时优先使用已有工具的只读子命令，或公开 registry / 公告 API，例如包的 registry 元数据、OSV、GHSA。预发布版、yanked / retracted 要和稳定版区分。

**禁止**安装、升级、添加或移除包，禁止改清单或 lockfile，禁止提交被扫仓库。避开会隐式写入的命令，例如各类 `install` / `update` / `add` / `get` / `tidy` / `resolve` 中会重写锁文件或工作区的用法。若某条命令可能改文件，就不要用，改用纯查询。需要锁定依赖解析策略时，优先只读模式（例如 Go 的 `-mod=readonly`），仍以「会不会写文件」为准。

私有源或需要认证的 registry：未获授权就标未核验。不要把凭证写进命令行、报告或本技能文件，不要设法绕过授权，也不要为了查询去改用户的登录态。

## 约束

给出建议版本前，核对本仓库真实存在的约束，例如：

- 语言或工具最低版本（MSRV、语言 edition、Go / Node 版本）
- SDK 与运行时（JDK、Android SDK、HarmonyOS API、Swift 工具链）
- 平台与 CPU / OS
- 许可证是否可接受
- peer 依赖、插件与宿主版本、BOM 或 version catalog 的上限
- 被 `replace`、yanked、retract 或上游停维影响的路径

约束使「latest stable」不可用时，建议改到约束内的可行目标，并把该约束写进报告。不要为了凑升级建议而忽略这些限制。

## 升级验证建议

对「立即升级」和值得排期的「可以升级」，写清建议怎么验证，而不是只给一个版本号。例如：在隔离工作区按建议版本升级后跑该包相关的测试或构建、核对 changelog 中的破坏性变更、确认漏洞锁版本已离开受影响区间。不要在本轮审计里真的执行升级。
