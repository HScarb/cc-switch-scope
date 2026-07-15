# 会话级 Skill 隔离（skillset）— 设计文档

日期：2026-07-15
状态：与用户确认

## 1. 定位

在现有"每个终端会话独立绑定 Claude 供应商"能力之上，扩展为**每个会话可选择性地只暴露一组预定义的 skill/插件**，实现会话间的 Skill 隔离。不与 cc-switch 数据格式耦合，独立配置文件独立维护。

## 2. 技术背景：Claude Code 的 skill 管控机制

本节是整个设计的地基。设计中所有"为什么必须这样做"的答案都在这里。

### 2.1 skill 从哪里来（四个来源）

claude 启动时会从四个地方收集 skill，全部汇入同一个会话：

| 来源 | 位置 | 举例 |
|---|---|---|
| ① 用户级 skill | `~/.claude/skills/<名字>/SKILL.md`（目录名即 skill 名） | 自己装的 `commit`、`code-review` |
| ② 项目级 skill | 项目仓库里的 `.claude/skills/<名字>/SKILL.md`，从当前目录逐级向上找到仓库根 | 仓库自带的团队 skill |
| ③ 插件 skill | 通过 plugin marketplace 安装的插件附带，名字带命名空间前缀 | `commit-commands:commit`、`superpowers:brainstorming` |
| ④ 内置 skill | Claude Code 程序自身携带，不在磁盘上以目录形式存在 | `/init`、`/review`、`/security-review` |

补充两点：

- ①② 还各有一个 legacy 形态：`.claude/commands/<名字>.md`（老的"自定义斜杠命令"）。官方已把 commands 和 skills 统一为同一套机制——`commands/deploy.md` 和 `skills/deploy/SKILL.md` 都产生 `/deploy`，管控方式也相同。所以本设计中凡是说"skill"，都包含 legacy commands。
- ③ 的插件 skill 名字里一定带 `:`（如 `commit-commands:commit`），这是区分它和 ①②④ 的可靠特征。

### 2.2 每类 skill 的开关（三个 settings 键）

Claude Code 没有统一的"skill 白名单"配置，而是三个各管一摊的 settings 键：

**键 1：`skillOverrides`——管 ①②④（用户级、项目级、内置）**

```json
{ "skillOverrides": { "deploy": "off", "commit": "on" } }
```

按 skill 名逐个控制，值为 `"on"` / `"off"` / `"name-only"` / `"user-invocable-only"`。`"off"` 的效果是这个 skill 从会话中彻底消失（模型看不到它，不只是禁止调用）。

**关键陷阱：没写进 `skillOverrides` 的 skill 默认是 `"on"`。** 它天生是"黑名单"机制——只能点名关闭，不能表达"默认全关、只开这几个"。所以要实现白名单语义，唯一的办法是：**先扫描出环境里所有已安装的 skill，把不在白名单里的每一个都显式写 `"off"`**。这就是本设计需要 `skills-scan.js` 扫描模块的根本原因。

另外，`skillOverrides` 里写了不存在的 skill 名不会报错，会被静默忽略——所以白名单里的名字拼错了 claude 不会提醒，得由 ccscope 在启动时自己校验并告警（见 §7）。

**键 2：`enabledPlugins`——管 ③（插件）**

```json
{ "enabledPlugins": { "commit-commands": true, "codex": false } }
```

按**插件名**开关，`false` 或未安装即整个插件（连同它带的所有 skill）消失。

**关键限制：插件 skill 不受 `skillOverrides` 管**——官方文档明确排除。想只留插件里的某一个 skill、关掉同插件的其他 skill，做不到；粒度就是整个插件。这就是配置文件里 `skills` 与 `plugins` 必须分成两个字段、且 `skills` 里出现带 `:` 的名字要报错的原因。

**键 3：`disableBundledSkills`——管 ④（内置）**

```json
{ "disableBundledSkills": true }
```

一键关掉全部内置 skill。理论上 `skillOverrides` 也能逐个覆盖内置 skill，但内置列表不是稳定 API（随 Claude Code 版本增减），无法可靠枚举——所以对内置 skill 只提供整体开/关两档（配置字段 `bundledSkills`）。

### 2.3 开关怎么送进会话：`--settings` 与逐键合并

ccscope 本来就是把供应商配置写进临时文件、以 `claude --settings <临时文件>` 启动的。上面三个键都是合法的 settings 键，直接写进这个临时文件即可生效，不需要任何新的传递通道。

但 claude 对多层配置（`--settings` > 用户级 `~/.claude/settings.json` > 项目级 …）的合并是**逐键合并，不是整体替换**：`--settings` 里写了的键赢，没写的键继续用低层的值。而且 `skillOverrides`、`enabledPlugins` 这类对象的合并深入到**每个 skill 名/插件名**：

> 用户 settings.json 里有 `enabledPlugins: {"a": true, "b": true}`，
> ccscope 的 `--settings` 只传 `{"a": false}`，
> 结果是 a 关了、**b 依然开着**（b 这个键没被覆盖，用户级的 true 存活）。

`skillOverrides` 同理。**推论：白名单要想不漏，`--settings` 里必须完整列举所有要关的 skill 和插件，漏写一个，那一个就从用户级配置漏进会话。** 这也是 §3.2 中 `applySkillset` 必须拿到"扫描全集"（scanned）和"用户已装插件全集"（livePlugins）两个输入的原因。

同一个逐键合并规则也决定了一个细节：白名单内的 skill 要显式写 `"on"`，而不是不写——万一用户自己的 settings.json 里已把它设成 `"off"`，不写就开不起来；skillset 的语义是"本次会话我说了算"，显式 `"on"` 才能压过去。

### 2.4 走不通的路线（为什么不用别的机制）

- **permissions 白名单**：`permissions.deny: ["Skill"]` 会把整个 Skill 工具从模型上下文移除，之后 `allow: ["Skill(foo)"]` 加不回来（deny 永远优先，工具都没了 allow 无处生效）。权限机制做不了"只允许这几个"。
- **`--disallowedTools` / `--disable-slash-commands` / `--safe-mode`**：都是全关型开关，没有选择性。
- **`CLAUDE_CONFIG_DIR` 整体搬家**（每个 scope 一个独立配置目录）：隔离最彻底，但 Windows/Linux 上要重新登录、`~/.claude.json`（OAuth/MCP 状态）不跟着搬、还有 `~/.claude/CLAUDE.md` 泄漏的已知 bug（anthropics/claude-code#25762），运维成本远高于收益，评估后弃用。

### 2.5 小结

| 机制 | 管控范围 | 粒度 | 能表达"默认关闭"？ | 本设计的用法 |
|---|---|---|---|---|
| `skillOverrides` | 用户级/项目级/内置 skill | 逐个 skill | ❌ 未列举 = on | 扫描全集后，白名单外全写 `"off"`，白名单内写 `"on"` |
| `enabledPlugins` | 插件（含其所有 skill） | 逐个插件 | ✅ false = off | 用户已装插件全集中，白名单外全写 `false` |
| `disableBundledSkills` | 内置 skill | 整体开关 | ✅ | `bundledSkills: false` 时注入 `true` |

## 3. 新模块结构

```
src/
├── skills-scan.js    # 扫描 skill/commands 目录 → 去重的 skill 名列表（纯函数 + IO 注入）
├── skillset.js       # 加载、校验、合成 skillset 配置（纯函数）
└── multi-select.js   # readline raw mode 多选复选框菜单组件
```

每个文件 <150 行。

### 3.1 skills-scan.js

扫描位置（与 claude 的 skill 发现规则一致）：

| 位置 | 路径 |
|---|---|
| 用户级 skill | `$CLAUDE_CONFIG_DIR/skills/*/SKILL.md`（复用 isolate.js 的目录解析） |
| 用户级 legacy 命令 | `$CLAUDE_CONFIG_DIR/commands/*.md` |
| 项目级 skill | `<CWD 及每级父目录直到 git 仓库根>/.claude/skills/*/SKILL.md` |
| 项目级 legacy 命令 | 同上 `.claude/commands/*.md` |

向上查找终点：含 `.git` 的目录（含该级）；找不到 `.git` 时只扫 CWD 一级。
只读目录名/文件名，不读 SKILL.md 内容。目录不存在/无权限静默跳过。
不扫嵌套子目录（CWD 之下的 `.claude/skills/`，claude 按需发现，启动时扫不全）、不扫 `--add-dir`。

### 3.2 skillset.js

三个纯函数：

```
loadSkillsets(dir)
  → { skillsets: { name → SkillsetDef }, providerDefaults, warnings }
  • 读 ccscope-skills.json
  • 校验结构合法性（顶层、skills/plugins 为字符串数组、无 `:` 混入）
  • providerDefaults 引用不存在 skillset → warnings，不阻断

resolveSkillset(parsed, provider, cfg)
  → SkillsetDef | null（null = 不隔离）
  • 优先级：--skillset > providerDefaults > null
  • --skillset none → 豁免 providerDefaults
  • 逗号分隔支持多个（union 语义）

applySkillset(effectiveConfig, skillset, scanned, livePlugins)
  → 新配置（不修改输入）
  • skillOverrides: scanned 差集 → "off", allowlist → "on"
  • enabledPlugins: livePlugins 中不在 allowlist → false, 在 → true
  • disableBundledSkills: 仅 skillset.bundledSkills === false 时注入 true
```

`applySkillset` 在 cli.js 的接线位置：

```
buildEffectiveConfig → maskLeakedEnvKeys → applySkillset → launch
```

### 3.3 multi-select.js

现有 menu.js 的扩展组件：

- `createMultiSelect(items, options) → Promise<string[] | null>`
- 上下方向键/j/k 移动
- **空格键**切换选中状态
- 回车确认；Esc/Ctrl-C 返回 null
- 底部显示 `(已选 N 个)`

### 3.4 cli.js 参数解析变更

新参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `--skillset <name>` / `-s` | 字符串 | 技能集名，逗号分隔多值；与 `none` 互斥 |
| `--list-skillsets` | 标志 | 列表可用 skillset 及其描述 |
| `--create-skillset [name]` | 可选值 | 交互式创建/编辑 skillset |
| `--edit-skillset <name>` | 必选值 | 等价于 `--create-skillset <name>`（已存在路由） |

## 4. 配置文件格式

### 文件路径

`<resolved-data-dir>/ccscope-skills.json`（同 `paths.js` 输出的数据目录）。可被 `CC_SCOPE_SKILLS` 环境变量覆盖为绝对路径。

### 格式

```json
{
  "skillsets": {
    "dev": {
      "description": "日常开发",
      "skills": ["commit", "code-review", "verify"],
      "plugins": ["commit-commands"],
      "bundledSkills": true
    },
    "minimal": {
      "skills": [],
      "plugins": [],
      "bundledSkills": false
    }
  },
  "providerDefaults": {
    "kimi-pro": "dev"
  }
}
```

字段语义：

- **`skills`**：允许的用户级/项目级 skill 名（含 legacy `.claude/commands/` 命令名）。**不含**插件 skill——含 `:` 的名字校验报错
- **`plugins`**：允许的插件名。整插件粒度的"允许 / 不允许"（claude 约束，见 §2）
- **`bundledSkills`**：缺省 `true`。`false` 时注入 `disableBundledSkills: true`
- **`providerDefaults`**：可选。供应商名 → skillset 名或名称数组

### 多 skillset 并集（union）

`--skillset dev,web` 时，`skills` 和 `plugins` 分别求并集，`bundledSkills` 任一为 true 则 true。

### 创建/编辑命令

`ccscope --create-skillset [name]`：

1. 若 name 为空 → 交互输入名字
2. name 不存在 → 创建新 skillset
3. name 已存在 → 编辑模式（现有值预填）
4. Step ②：multi-select 选 skill（来源取自 `skills-scan.js` 枚举结果）
5. Step ③：multi-select 选 plugin（来源取自用户 settings.json 的 `enabledPlugins` 键）
6. Step ④：bundledSkills 开关（Y/n）
7. Step ⑤：确认摘要，写入文件

## 5. CLI 接口

```
ccscope <provider> [--skillset <name[,name...]>]
ccscope --list-skillsets
ccscope --create-skillset [name]
ccscope --edit-skillset <name>
```

输出示例：

```
$ ccscope kimi --skillset dev
→ Skillset [dev]: 4 skills allowed, 8 hidden, 1 plugin on, 3 off
→ Launching [kimi-pro]

$ ccscope --list-skillsets
skillset 配置: ~/.cc-switch/ccscope-skills.json

  dev      日常开发         skills: 4  plugins: 2  bundled: on
  minimal                   skills: 1  plugins: 0  bundled: off

providerDefaults:
  kimi-pro → dev
```

## 6. 启动流程（完整）

```
1. parseArgs → 检出 --skillset / --list-skillsets / --create-skillset
2. resolveDataDir → 数据目录
3. loadStore → providers + commonConfig
4. 若 --skillset:
   a. loadSkillsets(dir) → 校验/读取
   b. resolveSkillset(parsed, provider) → skillset 对象
   c. skills-scan(dir) → 枚举 skill 名列表
5. buildEffectiveConfig → merged
6. maskLeakedEnvKeys → 屏蔽 env 泄漏
7. 若 skillset 非 null:
   a. readUserSettings → 获取 enabledPlugins
   b. applySkillset(effective, skillset, scanned, livePlugins) → 注入 override
8. launch(claude --settings tmpFile)
```

## 7. 错误处理

| 场景 | 行为 | 退出码 |
|---|---|---|
| 配置文件不存在 + `--skillset` | 报错"请先用 --create-skillset 创建" | 1 |
| 配置文件不存在 + `--list-skillsets` | 提示"无 skillset 配置"，展示示例路径 | 0 |
| 配置文件解析失败 | 报错文件路径 + 错误原文 | 1 |
| `--skillset <name>` 不存在 | 报错并列出可用名 | 1 |
| `--skillset none,dev` | 报错"none 不可组合" | 1 |
| `--skillset` 缺值 | 报错"需要一个名字" | 1 |
| `--create-skillset` 非 TTY | 报错"请在交互终端中运行" | 1 |
| `--edit-skillset <name>` 不存在 | 报错"skillset X 不存在" | 1 |
| `skills` 中含 `:` | 配置文件校验报错，提示改用 plugins | 1 |
| `providerDefaults` 引用不存在的 skillset | 启动警告，不走隔离 | 0 |
| allowlist 含枚举不到的 skill | 启动警告，不影响启动 | 0 |

## 8. 测试策略

`node:test` + fixtures：

- **skills-scan.js**：fixture 目录结构（多级 .git 仓库、空目录、legacy commands、无权限模拟）
- **skillset.js**：表驱动——多 skillset union、providerDefaults、none 保留字、skillOverrides 优先级、enabledPlugins 合并
- **cli.js**：参数解析注入——`--skillset` 各种合法/非法输入、`--list-skillsets`、`--create-skillset`
- **multi-select.js**：手动验证（raw mode 不适合单测）

新 fixture 目录：
```
test/fixtures/skills/
├── user-skills/        # 模拟 ~/.claude/skills/
│   ├── code-review/SKILL.md
│   └── commit/SKILL.md
├── user-commands/      # 模拟 ~/.claude/commands/
│   └── deploy.md
├── project/            # 带 .git 的项目（模拟项目级 skill）
│   ├── .git/
│   └── .claude/skills/
│       └── test/SKILL.md
└── ccscope-skills/     # skillset 配置文件用例
    ├── valid.json
    ├── invalid-syntax.json
    └── phantom-provider-defaults.json
```

## 9. 已知边界与残余限制

- 嵌套子目录 `.claude/skills/`（CWD 之下按需发现）不扫描，属已知泄漏面
- `--add-dir` 引入的 skill 不感知
- 插件 skill 只能整插件开关（Claude Code 约束），不可按单个插件 skill 做白名单
- 内置 skill 不可逐个屏蔽（`skillOverrides` 理论上可用，但内置 skill 名列表非稳定 API，版本间可能变动——所以整体关/开）
- 不实现配置级 `extends`/继承，CLI 逗号并集已覆盖组合需求
