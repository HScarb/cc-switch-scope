# cc-switch-scope 设计文档

日期：2026-07-04
状态：已与用户确认

## 1. 项目定位

`cc-switch-scope`（bin 命令 `ccscope`）是一个会话级 Claude Code 启动器：从 CC-Switch 的数据中读取 Claude 供应商列表，用户交互选择或模糊匹配后，以该供应商的配置启动 `claude` 进程。每个终端会话独立绑定供应商，互不干扰，不修改全局配置。

与参考项目 cc-switch-helper（`ccs`）的差异：

- **兼容新老两代 cc-switch 数据格式**：优先读新版 SQLite 数据库，不存在时回退读老版 config.json（ccs 只支持新版 SQLite）
- **感知自定义数据目录**：cc-switch 允许用户修改数据目录，ccscope 通过读取 Tauri Store 文件感知该设置（ccs 硬编码 `~/.cc-switch`，用户改过目录后会静默读到陈旧数据）
- **零 npm 依赖**：SQLite 用 Node 内置 `node:sqlite`，交互菜单手写 readline（ccs 依赖 sql.js + prompts）
- **Windows spawn 修复**：settings 经临时文件传递，规避 Node 18.20+ spawn `.cmd` 需 `shell: true` 后的引号转义问题（ccs 直接传 JSON 字符串作为参数）

## 2. 技术栈

- Node.js ≥ 22.13.0（`node:sqlite` 免 flag 的最低版本；已在用户机器 v24.12.0 验证可读真实数据库）
- 零 npm 运行时依赖；测试用内置 `node:test`
- 分发与升级：npm（`npm i -g cc-switch-scope`，升级 `npm i -g cc-switch-scope@latest`）
- 包名 `cc-switch-scope`，bin 命令 `ccscope`

注意：Node 24 上 `node:sqlite` 会打 ExperimentalWarning，CLI 入口需在加载前拦截 `process.emitWarning`，仅精确过滤 SQLite 的 ExperimentalWarning，其他警告照常输出。

## 3. 模块结构

```
cc-switch-scope/
├── package.json           # bin: { "ccscope": "src/cli.js" }, engines >=22.13.0, 无 dependencies
├── src/
│   ├── cli.js             # 入口：参数解析、流程编排、警告过滤
│   ├── paths.js           # 数据目录解析（环境变量 / app_paths.json / 默认）
│   ├── store.js           # 数据源探测调度（db 优先 → json 回退 → 报错），唯一对外数据接口
│   ├── source-db.js       # 新版数据源：node:sqlite 只读 cc-switch.db
│   ├── source-json.js     # 老版数据源：解析 config.json (v2)
│   ├── merge.js           # JSON 深合并（对齐 cc-switch json_deep_merge 语义）
│   ├── menu.js            # readline raw mode 方向键选择菜单
│   └── launcher.js        # 临时 settings 文件 + spawn claude
└── test/                  # node:test 用例 + fixtures
```

每个文件 <150 行。`paths.js`、`store.js`、`merge.js`、`source-*.js` 为纯逻辑（IO 注入或集中在入口），便于单测。

## 4. 数据目录解析（paths.js）

按优先级：

1. 环境变量 `CC_SWITCH_DIR`（ccscope 自己的逃生舱，便于测试与手动指定）
2. Tauri Store 文件 `app_paths.json` 中的 `app_config_dir_override` 键（cc-switch 的自定义目录设置，见 `app_store.rs`）。文件位置按平台：
   - Windows: `%APPDATA%\com.ccswitch.desktop\app_paths.json`
   - macOS: `~/Library/Application Support/com.ccswitch.desktop/app_paths.json`
   - Linux: `$XDG_CONFIG_HOME`（默认 `~/.config`）`/com.ccswitch.desktop/app_paths.json`

   采纳条件与 cc-switch 一致：值为非空字符串且目录实际存在；否则忽略并回退。文件缺失/损坏/无权限按"无覆盖"处理，损坏时打一行警告。
3. 默认 `os.homedir()/.cc-switch`

不实现 cc-switch 针对 v3.10.3 的 `HOME` 环境变量回退补丁（Node `os.homedir()` 在 Windows 取 `USERPROFILE`，与 cc-switch 的真实用户目录语义一致）。

返回值携带来源标记（`env` / `override` / `default`），供 `--list` 展示。

## 5. 数据源（store.js + source-db.js + source-json.js）

在解析出的数据目录内探测：

1. `cc-switch.db` 存在 → **source-db.js**：
   - `new DatabaseSync(dbPath, { readOnly: true })`，与运行中的 cc-switch GUI 无锁冲突
   - 供应商：`SELECT name, settings_config, meta, is_current FROM providers WHERE app_type = 'claude' ORDER BY is_current DESC, sort_index ASC, name ASC`
   - 通用配置：`SELECT value FROM settings WHERE key = 'common_config_claude'`，值二次 `JSON.parse`
2. 否则 `config.json` 存在 → **source-json.js**（老版 v2 格式）：
   - 检测 v1 格式（顶层含 `providers`+`current` 且无 `apps`）→ 明确报错说明不支持
   - 供应商取 `claude.providers`（注意字段为 camelCase：`settingsConfig`、`sortIndex`、`meta.commonConfigEnabled`），排序同上（isCurrent > sortIndex > name）
   - 通用配置：`common_config_snippets.claude` 优先，回退旧字段 `claude_common_config_snippet`；值为 JSON 字符串需二次 `JSON.parse`，解析失败按空对象处理
3. 都不存在 → 报错。若存在 `config.json.migrated` 孤儿文件，提示数据库可能被误删且备份尚在；否则提示安装 cc-switch 并配置供应商

两个数据源输出统一领域模型：

```js
{
  providers: [{ name, config, commonConfigEnabled, isCurrent }],  // config 为解析后的 settings 对象
  commonConfig,   // 解析后的通用配置对象，无则 {}
}
```

`meta` 缺失或 `commonConfigEnabled` 缺失一律视为 `false`；`settings_config` 解析失败回退 `{ env: {} }`（与 ccs 行为一致）。

## 6. 配置合并（merge.js）

对齐 cc-switch `json_deep_merge`（`src-tauri/src/services/provider/live.rs`）语义：

- 当 `commonConfigEnabled === true` 且通用配置非空：`deepMerge(providerConfig, commonConfig)`——对象↔对象逐键递归；叶子或类型不匹配时**通用配置获胜**（覆盖）
- 否则直接使用 `providerConfig` 原值
- 实现为纯函数，不修改输入（返回新对象）

## 7. 启动（launcher.js）

1. 合并结果写入临时文件：`os.tmpdir()` 下随机文件名（`ccscope-<random>.json`）
2. 组装命令：`claude --settings <临时文件路径>`；默认追加 `--dangerously-skip-permissions`（`--no-skip` 时不加）；`--` 之后的用户参数原样透传
3. Windows 上命令为 `claude.cmd` 且 `spawn(..., { shell: true })`（Node 18.20+ 强制要求）；参数中只有文件路径，无引号转义风险。其他平台 `claude`、不走 shell
4. `stdio: 'inherit'`，子进程退出后清理临时文件，透传退出码；spawn ENOENT 单独提示"未安装 Claude Code CLI"

启动前打印 `→ Launching [供应商名]`。

## 8. CLI 接口（cli.js）

与 ccs 对齐，降低迁移成本：

```
ccscope                    # 交互菜单选择供应商（current 项默认高亮）
ccscope <name>             # 模糊匹配（大小写不敏感 includes；多匹配优先 current，其次首个，并提示所有匹配项）
ccscope <name> -- <args>   # -- 之后的参数透传给 claude
ccscope --list / -l        # 列出供应商（标注 current），顶部显示数据目录及其来源
ccscope --no-skip          # 不加 --dangerously-skip-permissions
ccscope --version / -V
ccscope --help / -h
```

交互菜单：上下方向键移动、回车确认、Esc/Ctrl-C 取消（退出码 0）。

## 9. 错误处理原则

- 所有面向用户的错误给出下一步指引（装什么、查哪个文件），不裸抛堆栈
- JSON/数据库解析失败时报文件完整路径 + 原始错误信息
- 区分三类"找不到数据"场景（见 §5.3），提示语各不相同
- `app_paths.json` 等辅助文件的故障降级处理，不阻断主流程

## 10. 测试策略

`node:test` + fixtures，重点覆盖纯逻辑层：

- **merge.js**：表驱动用例对齐 json_deep_merge 语义（嵌套对象、叶子冲突、类型不匹配、数组整体覆盖、空通用配置、commonConfigEnabled=false）
- **source-json.js**：fixture 文件——正常 v2 / v1 检测报错 / 字段缺失 / 新旧通用配置字段 / 通用配置字符串损坏
- **source-db.js**：测试内用 node:sqlite 现造临时数据库写入 fixture 数据
- **paths.js**：环境变量优先级 / override 文件存在与否 / 目录不存在时的回退
- menu.js / launcher.js 以手动验证为主（终端 raw mode 与子进程行为不适合单测）

## 11. 边界与非目标

- 仅支持 `app_type = 'claude'` 供应商（不做 codex/gemini）
- 不支持 v1 config.json（与新版 cc-switch 行为一致，报错并给出指引）
- 不写入任何 cc-switch 数据（数据库只读打开，config.json 只读）
- 不自动回退读 `config.json.migrated`（陈旧快照，静默读旧数据比报错更糟）
- 不做供应商管理功能（增删改在 cc-switch GUI 中完成）
