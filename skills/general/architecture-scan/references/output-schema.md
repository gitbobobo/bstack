# 产出格式

扫描只输出一个 JSON 对象，不要夹带其它说明文字。若分析过程中有日志，应写到独立的 `.err.txt` 或日志文件；`.out.txt` 里供解析的是**最后一个完整 JSON**。

## Schema

```json
{
  "summary": "中文一段，概括本仓最值得深化的方向",
  "findings": [
    {
      "severity": "P0|P1|P2|Note",
      "file": "相对仓库根的路径，可空字符串",
      "line": 1,
      "title": "中文短标题",
      "body": "中文说明和证据",
      "suggestion": "中文建议",
      "candidate": {
        "name": "短名，点明深化对象",
        "files": ["路径"],
        "problem": "当前摩擦",
        "solution": "深化方案",
        "strength": "Strong|Worth exploring|Speculative",
        "wins": ["用 locality / leverage / 测试面等词描述的收益"]
      }
    }
  ]
}
```

- `line` 可为数字或 `null`。
- 每条 finding 必须带 `candidate`。缺少该字段的条目视为无效，不进入核实。
- `severity` 只允许 `P0`、`P1`、`P2`、`Note`。
- `strength` 只允许 `Strong`、`Worth exploring`、`Speculative`。
- `summary` 与各文本字段使用中文（专有名词、代码标识符、上表规定的架构词汇除外）。

可用脚本校验：

```bash
node <技能目录>/scripts/architecture-scan.mjs parse-out path/to/out.txt
node <技能目录>/scripts/architecture-scan.mjs validate-findings path/to/findings.json
```

`parse-out` 把最后一个完整 JSON 打到标准输出；`validate-findings` 在 schema 合法时以退出码 0 结束，并把对象打到标准输出。
