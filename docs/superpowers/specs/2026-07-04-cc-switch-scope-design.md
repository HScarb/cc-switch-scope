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
│   ├── isolate.js         # 会话隔离：屏蔽用户级 settings.json 泄漏的 env 键
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

   采纳条件与 cc-switch 一致：值为非空字符串（trim 后），支持 `~`、`~/`、`~\` 前缀展开为用户主目录（对齐 `app_store.rs` 的 `resolve_path`），且展开后目录实际存在；否则忽略并回退。文件缺失/损坏/无权限按"无覆盖"处理，损坏时打一行警告。
3. 默认 `os.homedir()/.cc-switch`；Windows 上复刻 cc-switch 的 HOME 回退（`config.rs` `get_app_config_dir`）：当默认目录下无 `cc-switch.db`、环境变量 `HOME` 非空且 `HOME/.cc-switch/cc-switch.db` 存在时，改用 `HOME/.cc-switch`

   HOME 回退是 cc-switch **当前的运行时行为**（每次启动都会检查），不是一次性迁移补丁：v3.10.3 曾在 Git Bash/MSYS 注入 `HOME` 的机器上把数据库建在 `HOME/.cc-switch`，这些用户的 GUI 数据至今仍在该位置。ccscope 若不回退，轻则报"找不到数据"，重则静默读到 `USERPROFILE/.cc-switch` 下残留的迁移前 `config.json`（陈旧供应商列表）——正是本项目要避免的问题。实现成本仅两次 `existsSync`。

返回值携带来源标记（`env` / `override` / `default` / `home-legacy`），供 `--list` 展示。

## 5. 数据源（store.js + source-db.js + source-json.js）

在解析出的数据目录内探测：

1. `cc-switch.db` 存在 → **source-db.js**：
   - `new DatabaseSync(dbPath, { readOnly: true })`。注意：数据库未开 WAL（cc-switch 只设 `foreign_keys`/`auto_vacuum`），GUI 写事务瞬间读端可能收到 SQLITE_BUSY，且 `node:sqlite` 无 busy_timeout 可配——捕获后单独提示"cc-switch 正在写入，请稍后重试"
   - 供应商：`SELECT name, settings_config, meta, is_current FROM providers WHERE app_type = 'claude' ORDER BY is_current DESC, sort_index ASC, name ASC`
   - 通用配置：`SELECT value FROM settings WHERE key = 'common_config_claude'`，`value` 即通用配置的 JSON 文本，`JSON.parse` 一次即可；行不存在或 `value` 为 NULL 按空对象（"二次 parse"只适用于下面的 config.json 路径）
2. 否则 `config.json` 存在 → **source-json.js**（老版 v2 格式）：
   - 检测 v1 格式（顶层 `providers` 为对象 + `current` 为字符串 + 无 `apps` 键，对齐 `app_config.rs` 的判定）→ 明确报错说明不支持
   - 供应商取 `claude.providers`（注意字段为 camelCase：`settingsConfig`、`sortIndex`、`meta.commonConfigEnabled`），排序同上（isCurrent > sortIndex > name）；`sortIndex` 缺失视同 SQLite 的 NULL **排最前**，保证两个数据源顺序一致
   - 通用配置：`common_config_snippets.claude` 优先，回退旧字段 `claude_common_config_snippet`；值为 JSON 字符串需二次 `JSON.parse`，解析失败按空对象处理，并打一行警告（含文件完整路径与原始错误）
3. 都不存在 → 报错。若存在 `config.json.migrated` 孤儿文件，提示数据库可能被误删且备份尚在；否则提示安装 cc-switch 并配置供应商

两个数据源输出统一领域模型：

```js
{
  providers: [{ name, config, commonConfigEnabled, isCurrent }],  // config 为解析后的 settings 对象
  commonConfig,   // 解析后的通用配置对象，无则 {}
}
```

`meta` 缺失或 `commonConfigEnabled` 缺失一律视为 `false`；`settings_config` 解析失败回退 `{ env: {} }`（与 ccs 行为一致）。

注：cc-switch 对缺失的 `commonConfigEnabled` 实际走启发式（`live.rs` `provider_uses_common_config`：仅当 settings 已**包含**通用配置子集时才视为启用），但该场景下再合并是幂等 no-op，按 `false` 处理的最终输出完全相同。这是刻意的安全简化——将来不要为"对齐源码"改回启发式。

## 6. 配置合并（merge.js）

对齐 cc-switch `json_deep_merge`（`src-tauri/src/services/provider/live.rs`）语义：

- 当 `commonConfigEnabled === true` 且通用配置非空：`deepMerge(providerConfig, commonConfig)`——对象↔对象逐键递归；叶子或类型不匹配时**通用配置获胜**（覆盖）
- 否则直接使用 `providerConfig` 原值
- 实现为纯函数，不修改输入（返回新对象）

### 会话隔离（isolate.js，v0.3.0）

claude 启动时按优先级**逐键**合并 `--settings`（命令行，最高）与用户级 `~/.claude/settings.json`（cc-switch 切换供应商时写入）。两边都有的键命令行获胜，但**只存在于用户级的 env 键会直接漏进会话**（如激活供应商专属的 `ANTHROPIC_MODEL`），且 env 的优先级高于 settings 的 `model` 字段——症状是 base URL 正确但模型跟随 cc-switch 的全局激活供应商。

对策（cli.js 在 buildEffectiveConfig 之后、launch 之前接线）：

- 读取用户级 settings.json（`CLAUDE_CONFIG_DIR` 优先，否则 `~/.claude`）；文件缺失属正常不告警，解析失败打警告并跳过屏蔽（不中断启动）
- 纯函数 `maskLeakedEnvKeys`：live env 有、effective env 没有的键，在 effective env 中显式置**空字符串**——逐键合并时以最高优先级压掉泄漏值，claude 视空串为未设置（实测 `ANTHROPIC_MODEL: ''` 回落到正常 model 解析）
- 已知残余限制：顶层 `model` 字段不屏蔽（通用配置通常已提供 model，实践中不受影响）

## 7. 启动（launcher.js）

1. 合并结果写入临时文件：`os.tmpdir()` 下随机文件名（`ccscope-<random>.json`）
2. 组装命令：`claude --settings <临时文件路径>`；默认追加 `--dangerously-skip-permissions`（`--no-skip` 时不加）；`--` 之后的用户参数原样透传
3. Windows 上命令为 `claude`（**不带扩展名**）且 `spawn(..., { shell: true })`：Node 18.20+ 强制 `.cmd`/`.bat` 走 shell；交给 cmd.exe 按 PATHEXT 解析可同时覆盖 npm 安装的 `claude.cmd` 与原生安装器的 `claude.exe`。注意 `shell: true` 下 Node **不做任何引号处理**，而临时目录路径可能含空格（如用户名带空格时的 `%TEMP%`）——settings 文件路径与 `--` 透传的每个参数都必须显式加双引号；透传参数本身含双引号时明确报错拒绝（cmd.exe 转义不可靠，宁可拒绝也不注入）。其他平台 `claude`、不走 shell、参数原样传递
4. `stdio: 'inherit'`，子进程退出后清理临时文件，透传退出码；spawn ENOENT 单独提示"未安装 Claude Code CLI"

启动前打印 `→ Launching [供应商名]`。

## 8. CLI 接口（cli.js）

与 ccs 对齐，降低迁移成本：

```
ccscope                    # 交互菜单选择供应商（current 项默认高亮）
ccscope <name>             # 模糊匹配（大小写不敏感 includes；多匹配优先 current，其次首个，并提示所有匹配项）
ccscope <name> -- <args>   # -- 之后的参数透传给 claude
ccscope [name] --resume [sessionId] / -r   # 恢复 Claude Code 会话（v0.4.0）
ccscope --list / -l        # 列出供应商（标注 current），顶部显示数据目录及其来源
ccscope --no-skip          # 不加 --dangerously-skip-permissions
ccscope --version / -V
ccscope --help / -h
```

交互菜单：上下方向键移动、回车确认、Esc/Ctrl-C 取消（退出码 0）。

### `--resume`（v0.4.0）

把 `claude --resume` 提升为一等参数：选定供应商后以其配置恢复会话（claude 恢复会话时不记忆原会话的 env/settings，完全用本次启动配置——天然支持换供应商续聊）。

- **会话选择器透传给 claude**：`--resume` 不带 sessionId 时由 claude 内置选择器挑会话。ccscope 不解析 `~/.claude/projects/` 下的会话 JSONL（官方明确该格式为内部实现细节），不自建会话菜单
- **贪婪消歧**：`--resume`/`-r` 后紧跟的非 `-` 开头参数一律视为 sessionId；供应商名放在其余位置参数处（推荐顺序 `ccscope [name] --resume [sessionId]`）。claude 对非 UUID 值按搜索词打开选择器，误传不致命
- **实现**：解析出的 resume 参数拼在 `--` 透传参数**之前**进入 `extraArgs`，用户显式透传同名参数时按 claude 的后者优先语义生效；launcher 无需改动（sessionId 无空白/双引号，Windows shell:true 路径安全）

## 9. 错误处理原则

- 所有面向用户的错误给出下一步指引（装什么、查哪个文件），不裸抛堆栈
- JSON/数据库解析失败时报文件完整路径 + 原始错误信息；可降级的解析失败（如通用配置字符串损坏，见 §5.2）降级后仍须打警告，不静默吞掉
- 数据库被 GUI 写锁定（SQLITE_BUSY）单独识别，提示稍后重试
- 区分三类"找不到数据"场景（见 §5.3），提示语各不相同
- `app_paths.json` 等辅助文件的故障降级处理，不阻断主流程

## 10. 测试策略

`node:test` + fixtures，重点覆盖纯逻辑层：

- **merge.js**：表驱动用例对齐 json_deep_merge 语义（嵌套对象、叶子冲突、类型不匹配、数组整体覆盖、空通用配置、commonConfigEnabled=false）
- **source-json.js**：fixture 文件——正常 v2 / v1 检测报错 / 字段缺失 / 新旧通用配置字段 / 通用配置字符串损坏
- **source-db.js**：测试内用 node:sqlite 现造临时数据库写入 fixture 数据
- **paths.js**：环境变量优先级 / override 文件存在与否 / `~` 前缀展开 / 目录不存在时的回退 / Windows HOME legacy 回退（默认目录无 db + `HOME/.cc-switch/cc-switch.db` 存在）
- menu.js / launcher.js 以手动验证为主（终端 raw mode 与子进程行为不适合单测）

## 11. 边界与非目标

- 仅支持 `app_type = 'claude'` 供应商（不做 codex/gemini）
- 不支持 v1 config.json（与新版 cc-switch 行为一致，报错并给出指引）
- 不写入任何 cc-switch 数据（数据库只读打开，config.json 只读）
- 不自动回退读 `config.json.migrated`（陈旧快照，静默读旧数据比报错更糟）
- 不做供应商管理功能（增删改在 cc-switch GUI 中完成）
