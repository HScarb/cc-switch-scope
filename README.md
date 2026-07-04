# cc-switch-scope

**中文** | [English](README.en.md)

会话级 Claude Code 启动器（命令：`ccscope`）。从 [CC-Switch](https://github.com/farion1231/cc-switch) 数据中读取 Claude 供应商列表，交互选择或模糊匹配后，以该供应商的配置启动 `claude`——**每个终端会话独立绑定供应商**，互不影响，也不改动 CC-Switch 的全局切换状态。

## 为什么需要它

CC-Switch 切换供应商是全局的（改写 `~/.claude/settings.json`），同一时间所有终端只能用同一个供应商。`ccscope` 把供应商配置写入临时 settings 文件并通过 `claude --settings` 传入，因此：

- 多个终端可以同时使用不同供应商
- 完全只读 CC-Switch 数据，不写入、不干扰 GUI 的切换状态
- 通用配置（common config）合并语义与 CC-Switch 完全一致

## 环境要求

- Node.js ≥ 22.13.0（SQLite 读取使用内置 `node:sqlite`，零 npm 运行时依赖）
- 已安装 [CC-Switch](https://github.com/farion1231/cc-switch) 并配置至少一个 Claude 供应商
- 已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 命令可用）

## 安装

```bash
git clone https://github.com/HScarb/cc-switch-scope.git
cd cc-switch-scope
npm link   # 之后可在任意目录使用 ccscope
```

## 使用

```bash
ccscope                    # 交互菜单选择供应商（↑/↓ 移动，回车确认，Esc 取消）
ccscope deep               # 模糊匹配供应商名（大小写不敏感，多个匹配时优先 current）
ccscope deep -- -r         # -- 之后的参数原样透传给 claude
ccscope --list             # 仅列出供应商（标注 current 与数据目录），不启动
ccscope --no-skip          # 不追加 --dangerously-skip-permissions
ccscope --version          # 显示版本
ccscope --help             # 显示帮助
```

> **注意**：默认会给 `claude` 追加 `--dangerously-skip-permissions`（免权限确认）。如不需要，请加 `--no-skip`。

## 数据来源

按以下顺序探测 CC-Switch 数据（只读）：

1. **新版 SQLite**：`<数据目录>/cc-switch.db`（优先）
2. **老版 config.json（v2）**：`<数据目录>/config.json`（回退；v1 格式不支持，会明确报错）

数据目录解析优先级（与 CC-Switch 一致）：

1. `CC_SWITCH_DIR` 环境变量
2. CC-Switch 的自定义数据目录设置（Tauri Store `app_paths.json` 的 `app_config_dir_override`，支持 `~` 前缀）
3. 默认 `~/.cc-switch`（Windows 上若默认目录无数据库且 `HOME/.cc-switch` 有，则回退后者）

## 通用配置合并

供应商启用了「应用通用配置」（`meta.commonConfigEnabled`）时，启动前会将通用配置深合并进供应商配置，语义与 CC-Switch 的 `json_deep_merge` 完全一致：对象逐键递归、叶子冲突时**通用配置获胜**、数组整体覆盖。

## Windows 体验

- 启动前自动解析 `claude` 命令背后的真实目标（`claude.exe` 或 node 脚本）并直接 spawn，绕过 cmd.exe 批处理垫片——Ctrl+C 退出干净，不会出现「终止批处理操作吗(Y/N)?」
- 临时 settings 文件以 `0o600` 权限写入，退出后自动清理（含 Ctrl+C / 异常路径兜底）

## 开发

```bash
npm test                        # 全量测试（node:test，零依赖）
node src/cli.js --list          # 本地运行（用 CC_SWITCH_DIR=<目录> 隔离真实数据）
```

## License

MIT
