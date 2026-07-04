# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

`cc-switch-scope`（bin 命令 `ccscope`）：会话级 Claude Code 启动器。从 CC-Switch 数据中读取 Claude 供应商列表，交互选择或模糊匹配后以该供应商配置启动 `claude`，实现每个终端会话独立绑定供应商。**优先读取新版 cc-switch 的 SQLite 数据库（`cc-switch.db`），不存在时回退老版 `config.json`（v2）**。

完整设计见 `docs/superpowers/specs/2026-07-04-cc-switch-scope-design.md`（架构、数据格式、合并语义、错误处理均以该文档为准）。

## 技术约束

- Node.js ≥ 22.13.0，**零 npm 运行时依赖**：SQLite 用内置 `node:sqlite`（只读打开；注意拦截其 ExperimentalWarning），交互菜单手写 readline，测试用 `node:test`
- 数据目录可被用户自定义：必须先经 `paths.js` 解析（`CC_SWITCH_DIR` 环境变量 → Tauri Store `app_paths.json` 的 `app_config_dir_override`（支持 `~` 前缀展开）→ 默认 `~/.cc-switch`，Windows 上默认目录无 db 时回退 `HOME/.cc-switch`），不可硬编码
- Windows 上 spawn `claude`（不带扩展名）且 `shell: true`（Node 18.20+ 强制 .cmd 走 shell；cmd.exe 按 PATHEXT 可同时覆盖 claude.cmd/claude.exe）；shell 模式下 Node 不做引号处理，settings 路径与透传参数须显式加双引号；settings 一律经临时文件传给 `--settings`，不传 JSON 字符串
- 深合并语义必须对齐 cc-switch 的 `json_deep_merge`：叶子冲突时通用配置获胜

## 参考仓库（`ref/`，只读，各自有独立 .git，不纳入本仓库版本管理）

- `ref/cc-switch-helper/` — 功能参照（读新版 SQLite 的 `ccs` 命令）。`src/launcher.js` 的合并+启动逻辑、`src/cli.js` 的参数解析可借鉴
- `ref/cc-switch/` — CC-Switch 源码（Tauri + Rust），配置格式的权威出处：
  - `src-tauri/src/app_config.rs` — `MultiAppConfig`（老版 config.json v2 结构）
  - `src-tauri/src/app_store.rs` — 自定义数据目录的存储（`app_paths.json`）
  - `src-tauri/src/config.rs` — 目录解析逻辑
  - `src-tauri/src/database/migration.rs` — 老字段 → 新表的映射对照
  - `src-tauri/src/services/provider/live.rs` — `json_deep_merge` 合并语义

## 老版 config.json（v2）格式要点

- 顶层：`{ "version": 2, "claude": { "providers": { "<id>": {...} }, "current": "<id>" }, ... }`（应用管理器经 serde flatten 平铺在顶层）
- 供应商字段是 **camelCase**（`settingsConfig`、`sortIndex`、`meta.commonConfigEnabled`），与新版 SQLite 列名（snake_case）不同
- 通用配置在 `common_config_snippets.claude`（值是 JSON **字符串**，需二次 parse），更老版本用顶层 `claude_common_config_snippet`，两者都要兼容
- v1 格式（顶层直接 `providers`+`current`、无 `apps`）不支持，检测到需明确报错
- 新版迁移后会把 `config.json` 改名为 `config.json.migrated`——"文件不存在但 .migrated 存在"是独立的错误场景

## 常用命令

- 运行：`node src/cli.js --list`（用 `CC_SWITCH_DIR=<fixture目录>` 隔离真实数据）
- 测试：`npm test`（即 `node --test "test/*.test.js"`；`node --test test/` 在 Windows Node 24 下不可用）
- 本地安装验证：`npm link` 后直接运行 `ccscope`
