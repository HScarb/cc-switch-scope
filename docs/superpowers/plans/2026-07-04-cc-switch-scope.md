# cc-switch-scope 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `ccscope` —— 会话级 Claude Code 启动器：从 CC-Switch 数据（新版 SQLite 优先、老版 config.json 回退）读取 Claude 供应商，交互选择或模糊匹配后以该供应商配置启动 `claude`。

**Architecture:** 8 个小模块分层：`paths.js`（数据目录解析）→ `store.js`（数据源调度）→ `source-db.js`/`source-json.js`（两代数据源，输出统一领域模型）→ `merge.js`（对齐 cc-switch `json_deep_merge` 的纯合并）→ `menu.js`/`launcher.js`/`cli.js`（交互与进程编排）。纯逻辑模块全部 IO 注入，用 `node:test` 单测；menu/launcher 的终端行为手动验证。

**Tech Stack:** Node.js ≥ 22.13.0，CommonJS，零 npm 运行时依赖（SQLite 用内置 `node:sqlite`，菜单手写 readline，测试用内置 `node --test`）。

**权威规格：** `docs/superpowers/specs/2026-07-04-cc-switch-scope-design.md`（下称"设计 §N"）。参考源码在 `ref/`（只读）。

## Global Constraints

- Node `engines`: `>=22.13.0`；包名 `cc-switch-scope`，bin 命令 `ccscope`
- **零 npm 运行时依赖**，`package.json` 不得有 `dependencies`
- 每个 `src/` 文件 < 150 行；CommonJS（无 `"type": "module"`）
- 数据目录一律经 `paths.js` 解析，任何模块不得硬编码 `~/.cc-switch`
- SQLite 只读打开（`readOnly: true`）；不写入任何 cc-switch 数据
- 面向用户的报错为中文、给下一步指引、不裸抛堆栈（设计 §9）
- 深合并语义对齐 cc-switch `json_deep_merge`：叶子冲突时通用配置获胜（设计 §6）
- Windows spawn：命令 `claude`（不带扩展名）+ `shell: true`，含空白参数显式加双引号，透传参数含 `"` 直接报错（设计 §7）
- `node:sqlite` 的 ExperimentalWarning 须在 cli.js 加载任何触发它的模块前精确过滤（设计 §2）
- commit 格式 `<type>: <description>`（feat/fix/test/chore/docs），不加 attribution

---

## 统一领域模型（所有数据源模块的输出契约）

```js
{
  providers: [
    {
      name: string,                 // 供应商显示名
      config: object,               // 解析后的 settings 对象；解析失败回退 { env: {} }
      commonConfigEnabled: boolean, // meta.commonConfigEnabled === true；meta 缺失一律 false
      isCurrent: boolean,
      sortIndex: number|undefined,  // 仅排序用，undefined 视同 SQLite NULL 排最前
    },
  ],
  commonConfig: object,             // 解析后的通用配置；无/损坏则 {}
  warnings: string[],               // 降级处理时的警告文本，由 cli.js 统一输出到 stderr
}
```

排序规则（两个数据源必须一致，对齐 SQLite `ORDER BY is_current DESC, sort_index ASC, name ASC`）：isCurrent 在前 → sortIndex 升序且 **undefined/null 排最前** → name 按码位升序（`<`/`>` 比较，不用 localeCompare）。

---

### Task 1: 脚手架 + merge.js（深合并纯函数）

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/merge.js`
- Test: `test/merge.test.js`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `isPlainObject(value) → boolean`（非 null 对象且非数组）
  - `deepMerge(target, source) → any`（纯函数，返回新值，不改输入）
  - `buildEffectiveConfig(providerConfig, commonConfig, commonConfigEnabled) → object`

- [ ] **Step 1: 创建 package.json 与 .gitignore**

`package.json`：

```json
{
  "name": "cc-switch-scope",
  "version": "0.1.0",
  "description": "Session-scoped Claude Code launcher backed by CC-Switch data",
  "bin": { "ccscope": "src/cli.js" },
  "engines": { "node": ">=22.13.0" },
  "scripts": { "test": "node --test test/" },
  "license": "MIT"
}
```

`.gitignore`：

```
node_modules/
ref/
*.log
```

- [ ] **Step 2: 提交脚手架**

```bash
git add package.json .gitignore
git commit -m "chore: 初始化 npm 包脚手架（零依赖，bin ccscope）"
```

- [ ] **Step 3: 编写 merge.js 的失败测试**

`test/merge.test.js`（表驱动，覆盖设计 §10 列出的全部场景）：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deepMerge, buildEffectiveConfig, isPlainObject } = require('../src/merge');

test('isPlainObject 基本判定', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});

// 对齐 cc-switch json_deep_merge（live.rs）：对象递归、叶子/类型不匹配 source 覆盖
const mergeCases = [
  {
    name: '不相交的键合并',
    target: { a: 1 }, source: { b: 2 },
    expected: { a: 1, b: 2 },
  },
  {
    name: '嵌套对象逐键递归',
    target: { env: { A: '1', B: '2' } }, source: { env: { B: '3', C: '4' } },
    expected: { env: { A: '1', B: '3', C: '4' } },
  },
  {
    name: '叶子冲突时 source（通用配置）获胜',
    target: { model: 'a' }, source: { model: 'b' },
    expected: { model: 'b' },
  },
  {
    name: '类型不匹配时 source 整体覆盖',
    target: { permissions: { allow: [] } }, source: { permissions: 'deny' },
    expected: { permissions: 'deny' },
  },
  {
    name: '数组整体覆盖（不做元素级合并）',
    target: { hooks: [1, 2] }, source: { hooks: [3] },
    expected: { hooks: [3] },
  },
  {
    name: '空 source 不改变 target',
    target: { a: 1 }, source: {},
    expected: { a: 1 },
  },
];

for (const c of mergeCases) {
  test(`deepMerge: ${c.name}`, () => {
    assert.deepEqual(deepMerge(c.target, c.source), c.expected);
  });
}

test('deepMerge 不修改任何输入（不可变）', () => {
  const target = { env: { A: '1' } };
  const source = { env: { A: '2' } };
  deepMerge(target, source);
  assert.deepEqual(target, { env: { A: '1' } });
  assert.deepEqual(source, { env: { A: '2' } });
});

test('buildEffectiveConfig: 启用且通用配置非空时合并', () => {
  const result = buildEffectiveConfig({ env: { A: '1' } }, { env: { B: '2' } }, true);
  assert.deepEqual(result, { env: { A: '1', B: '2' } });
});

test('buildEffectiveConfig: commonConfigEnabled=false 时返回原配置拷贝', () => {
  const provider = { env: { A: '1' } };
  const result = buildEffectiveConfig(provider, { env: { B: '2' } }, false);
  assert.deepEqual(result, provider);
  assert.notEqual(result, provider); // 是拷贝而非同一引用
});

test('buildEffectiveConfig: 通用配置为空对象时跳过合并', () => {
  const result = buildEffectiveConfig({ env: { A: '1' } }, {}, true);
  assert.deepEqual(result, { env: { A: '1' } });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
node --test test/merge.test.js
```

预期：FAIL，`Cannot find module '../src/merge'`。

- [ ] **Step 5: 实现 src/merge.js**

```js
'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 对齐 cc-switch json_deep_merge（src-tauri/src/services/provider/live.rs:99）：
 * 对象↔对象逐键递归；叶子或类型不匹配时 source 覆盖。
 * 纯函数：不修改任何输入，返回新值。
 */
function deepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    const result = {};
    for (const [key, value] of Object.entries(target)) {
      result[key] = structuredClone(value);
    }
    for (const [key, sourceValue] of Object.entries(source)) {
      result[key] = Object.prototype.hasOwnProperty.call(result, key)
        ? deepMerge(result[key], sourceValue)
        : structuredClone(sourceValue);
    }
    return result;
  }
  return structuredClone(source);
}

/**
 * 设计 §6：commonConfigEnabled 且通用配置非空 → deepMerge(provider, common)，
 * 叶子冲突通用配置获胜；否则返回供应商配置的拷贝。
 */
function buildEffectiveConfig(providerConfig, commonConfig, commonConfigEnabled) {
  const commonIsEmpty =
    !isPlainObject(commonConfig) || Object.keys(commonConfig).length === 0;
  if (!commonConfigEnabled || commonIsEmpty) {
    return structuredClone(providerConfig);
  }
  return deepMerge(providerConfig, commonConfig);
}

module.exports = { deepMerge, buildEffectiveConfig, isPlainObject };
```

- [ ] **Step 6: 运行测试确认通过**

```bash
node --test test/merge.test.js
```

预期：全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/merge.js test/merge.test.js
git commit -m "feat: merge.js 深合并（对齐 cc-switch json_deep_merge 语义）"
```

---

### Task 2: paths.js（数据目录解析）

**Files:**
- Create: `src/paths.js`
- Test: `test/paths.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `resolveDataDir({ platform, env, homedir, existsSync, readFileSync }) → { dir: string, source: 'env'|'override'|'default'|'home-legacy', warnings: string[] }`
  - `expandTilde(raw, homedir) → string`（辅助，供单测）
  - IO 全部注入，模块本身只依赖 `node:path`

- [ ] **Step 1: 编写失败测试**

`test/paths.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveDataDir, expandTilde } = require('../src/paths');

const HOME = path.join(path.sep, 'home', 'alice');

/** 用 Set/Map 伪造 fs，键统一用 path.join 生成 */
function fakeFs({ existing = [], files = {} } = {}) {
  const existSet = new Set([...existing, ...Object.keys(files)]);
  return {
    existsSync: (p) => existSet.has(p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

function linuxStoreFile() {
  return path.join(HOME, '.config', 'com.ccswitch.desktop', 'app_paths.json');
}

test('expandTilde: ~ / ~/ / ~\\ 前缀展开，其余原样', () => {
  assert.equal(expandTilde('~', HOME), HOME);
  assert.equal(expandTilde('~/data', HOME), path.join(HOME, 'data'));
  assert.equal(expandTilde('~\\data', HOME), path.join(HOME, 'data'));
  assert.equal(expandTilde('/abs/dir', HOME), '/abs/dir');
});

test('CC_SWITCH_DIR 环境变量优先级最高', () => {
  const r = resolveDataDir({
    platform: 'linux', env: { CC_SWITCH_DIR: '/custom' }, homedir: HOME,
    ...fakeFs(),
  });
  assert.deepEqual(r, { dir: '/custom', source: 'env', warnings: [] });
});

test('override 有效：采纳 app_paths.json 且展开 ~', () => {
  const overrideDir = path.join(HOME, 'cc-data');
  const r = resolveDataDir({
    platform: 'linux', env: {}, homedir: HOME,
    ...fakeFs({
      existing: [overrideDir],
      files: { [linuxStoreFile()]: '{"app_config_dir_override":"~/cc-data"}' },
    }),
  });
  assert.equal(r.dir, overrideDir);
  assert.equal(r.source, 'override');
});

test('override 目录不存在：警告并回退默认', () => {
  const r = resolveDataDir({
    platform: 'linux', env: {}, homedir: HOME,
    ...fakeFs({
      files: { [linuxStoreFile()]: '{"app_config_dir_override":"/nowhere"}' },
    }),
  });
  assert.equal(r.dir, path.join(HOME, '.cc-switch'));
  assert.equal(r.source, 'default');
  assert.equal(r.warnings.length, 1);
});

test('app_paths.json 损坏：警告并按无覆盖处理', () => {
  const r = resolveDataDir({
    platform: 'linux', env: {}, homedir: HOME,
    ...fakeFs({ files: { [linuxStoreFile()]: '{oops' } }),
  });
  assert.equal(r.source, 'default');
  assert.equal(r.warnings.length, 1);
});

test('override 类型不对（非字符串）：警告并回退', () => {
  const r = resolveDataDir({
    platform: 'linux', env: {}, homedir: HOME,
    ...fakeFs({ files: { [linuxStoreFile()]: '{"app_config_dir_override":123}' } }),
  });
  assert.equal(r.source, 'default');
  assert.equal(r.warnings.length, 1);
});

test('win32 HOME legacy 回退：默认无 db 且 HOME/.cc-switch/cc-switch.db 存在', () => {
  const gitBashHome = path.join(path.sep, 'gitbash', 'home');
  const legacyDb = path.join(gitBashHome, '.cc-switch', 'cc-switch.db');
  const r = resolveDataDir({
    platform: 'win32', env: { HOME: gitBashHome }, homedir: HOME,
    ...fakeFs({ existing: [legacyDb] }),
  });
  assert.equal(r.dir, path.join(gitBashHome, '.cc-switch'));
  assert.equal(r.source, 'home-legacy');
});

test('win32 默认目录已有 db 时不走 legacy 回退', () => {
  const defaultDb = path.join(HOME, '.cc-switch', 'cc-switch.db');
  const gitBashHome = path.join(path.sep, 'gitbash', 'home');
  const legacyDb = path.join(gitBashHome, '.cc-switch', 'cc-switch.db');
  const r = resolveDataDir({
    platform: 'win32', env: { HOME: gitBashHome }, homedir: HOME,
    ...fakeFs({ existing: [defaultDb, legacyDb] }),
  });
  assert.equal(r.dir, path.join(HOME, '.cc-switch'));
  assert.equal(r.source, 'default');
});

test('非 win32 平台不做 HOME legacy 回退', () => {
  const gitBashHome = path.join(path.sep, 'gitbash', 'home');
  const legacyDb = path.join(gitBashHome, '.cc-switch', 'cc-switch.db');
  const r = resolveDataDir({
    platform: 'linux', env: { HOME: gitBashHome }, homedir: HOME,
    ...fakeFs({ existing: [legacyDb] }),
  });
  assert.equal(r.source, 'default');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/paths.test.js
```

预期：FAIL，`Cannot find module '../src/paths'`。

- [ ] **Step 3: 实现 src/paths.js**

```js
'use strict';

const path = require('node:path');

const STORE_KEY = 'app_config_dir_override';
const IDENTIFIER = 'com.ccswitch.desktop';

/** 对齐 app_store.rs resolve_path：支持 ~、~/、~\ 前缀展开为主目录 */
function expandTilde(raw, homedir) {
  if (raw === '~') return homedir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(homedir, raw.slice(2));
  }
  return raw;
}

/** Tauri Store app_paths.json 的平台路径（identifier: com.ccswitch.desktop） */
function appPathsFile({ platform, env, homedir }) {
  if (platform === 'win32') {
    if (!env.APPDATA) return null;
    return path.join(env.APPDATA, IDENTIFIER, 'app_paths.json');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', IDENTIFIER, 'app_paths.json');
  }
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ''
      ? env.XDG_CONFIG_HOME
      : path.join(homedir, '.config');
  return path.join(base, IDENTIFIER, 'app_paths.json');
}

/**
 * 解析 cc-switch 数据目录（设计 §4）。
 * 优先级：CC_SWITCH_DIR 环境变量 → app_paths.json override → 默认（含 win32 HOME legacy 回退）。
 */
function resolveDataDir({ platform, env, homedir, existsSync, readFileSync }) {
  const warnings = [];

  const envDir = (env.CC_SWITCH_DIR || '').trim();
  if (envDir !== '') {
    return { dir: envDir, source: 'env', warnings };
  }

  const storeFile = appPathsFile({ platform, env, homedir });
  if (storeFile && existsSync(storeFile)) {
    try {
      const store = JSON.parse(readFileSync(storeFile, 'utf8'));
      const raw = store[STORE_KEY];
      if (typeof raw === 'string' && raw.trim() !== '') {
        const expanded = expandTilde(raw.trim(), homedir);
        if (existsSync(expanded)) {
          return { dir: expanded, source: 'override', warnings };
        }
        warnings.push(`app_paths.json 配置的数据目录不存在，已忽略: ${expanded}`);
      } else if (raw !== undefined && typeof raw !== 'string') {
        warnings.push(`app_paths.json 中 ${STORE_KEY} 应为字符串，已忽略`);
      }
    } catch (err) {
      warnings.push(`app_paths.json 读取失败，按无覆盖处理（${storeFile}）: ${err.message}`);
    }
  }

  const defaultDir = path.join(homedir, '.cc-switch');
  // 复刻 cc-switch config.rs get_app_config_dir 的 win32 HOME legacy 回退：
  // 默认目录没有 db、HOME 指向的 .cc-switch 下有 db → 用后者（v3.10.3 遗留数据仍在使用中）
  if (platform === 'win32' && !existsSync(path.join(defaultDir, 'cc-switch.db'))) {
    const homeEnv = (env.HOME || '').trim();
    if (homeEnv !== '') {
      const legacyDir = path.join(homeEnv, '.cc-switch');
      if (existsSync(path.join(legacyDir, 'cc-switch.db'))) {
        return { dir: legacyDir, source: 'home-legacy', warnings };
      }
    }
  }
  return { dir: defaultDir, source: 'default', warnings };
}

module.exports = { resolveDataDir, expandTilde, appPathsFile };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/paths.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: paths.js 数据目录解析（env/override/~展开/HOME legacy 回退）"
```

---

### Task 3: source-json.js（老版 config.json v2 数据源）

**Files:**
- Create: `src/source-json.js`
- Test: `test/source-json.test.js`

**Interfaces:**
- Consumes: `isPlainObject`（Task 1 的 `src/merge.js`）
- Produces:
  - `parseConfigJson(content: string, filePath: string) → 领域模型`（见开头契约；解析失败/v1 抛中文 Error）
  - `compareProviders(a, b) → number`（排序比较器，Task 4 复用同一语义故导出供参考）

- [ ] **Step 1: 编写失败测试**

`test/source-json.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseConfigJson } = require('../src/source-json');

/** 构造最小 v2 配置（字段 camelCase，对齐 provider.rs serde rename） */
function v2Config({ providers = {}, current = '', snippets, legacySnippet } = {}) {
  const root = { version: 2, claude: { providers, current } };
  if (snippets !== undefined) root.common_config_snippets = { claude: snippets };
  if (legacySnippet !== undefined) root.claude_common_config_snippet = legacySnippet;
  return JSON.stringify(root);
}

test('正常 v2：提取供应商与通用配置', () => {
  const content = v2Config({
    providers: {
      p1: { name: 'Alpha', settingsConfig: { env: { A: '1' } }, sortIndex: 1 },
      p2: {
        name: 'Beta', settingsConfig: { env: { B: '2' } }, sortIndex: 0,
        meta: { commonConfigEnabled: true },
      },
    },
    current: 'p1',
    snippets: '{"env":{"COMMON":"x"}}',
  });
  const r = parseConfigJson(content, '/x/config.json');
  assert.deepEqual(r.providers.map((p) => p.name), ['Alpha', 'Beta']); // current 在前
  assert.equal(r.providers[0].isCurrent, true);
  assert.equal(r.providers[0].commonConfigEnabled, false); // meta 缺失 → false
  assert.equal(r.providers[1].commonConfigEnabled, true);
  assert.deepEqual(r.commonConfig, { env: { COMMON: 'x' } });
  assert.deepEqual(r.warnings, []);
});

test('排序：sortIndex 缺失视同 NULL 排最前，再按 name 码位升序', () => {
  const content = v2Config({
    providers: {
      a: { name: 'Zeta', settingsConfig: {} },              // 无 sortIndex → 最前
      b: { name: 'Mid', settingsConfig: {}, sortIndex: 0 },
      c: { name: 'Last', settingsConfig: {}, sortIndex: 5 },
    },
  });
  const r = parseConfigJson(content, '/x/config.json');
  assert.deepEqual(r.providers.map((p) => p.name), ['Zeta', 'Mid', 'Last']);
});

test('v1 格式：明确报错不支持', () => {
  const v1 = JSON.stringify({ providers: { a: {} }, current: 'a' });
  assert.throws(() => parseConfigJson(v1, '/x/config.json'), /v1 配置格式/);
});

test('顶层 JSON 损坏：报文件路径 + 原始错误', () => {
  assert.throws(() => parseConfigJson('{broken', '/x/config.json'), /\/x\/config\.json/);
});

test('通用配置字符串损坏：按空对象处理并给出警告', () => {
  const content = v2Config({
    providers: { a: { name: 'A', settingsConfig: {} } },
    snippets: '{not json',
  });
  const r = parseConfigJson(content, '/x/config.json');
  assert.deepEqual(r.commonConfig, {});
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /\/x\/config\.json/);
});

test('旧字段 claude_common_config_snippet 回退兼容', () => {
  const content = v2Config({
    providers: { a: { name: 'A', settingsConfig: {} } },
    legacySnippet: '{"env":{"OLD":"1"}}',
  });
  const r = parseConfigJson(content, '/x/config.json');
  assert.deepEqual(r.commonConfig, { env: { OLD: '1' } });
});

test('common_config_snippets.claude 优先于旧字段', () => {
  const root = JSON.parse(v2Config({ providers: { a: { name: 'A', settingsConfig: {} } } }));
  root.common_config_snippets = { claude: '{"env":{"NEW":"1"}}' };
  root.claude_common_config_snippet = '{"env":{"OLD":"1"}}';
  const r = parseConfigJson(JSON.stringify(root), '/x/config.json');
  assert.deepEqual(r.commonConfig, { env: { NEW: '1' } });
});

test('字段缺失容错：settingsConfig 缺失回退 { env: {} }，name 缺失用 id', () => {
  const content = v2Config({ providers: { pid: {} } });
  const r = parseConfigJson(content, '/x/config.json');
  assert.equal(r.providers[0].name, 'pid');
  assert.deepEqual(r.providers[0].config, { env: {} });
});

test('claude 段缺失：返回空 providers 而非崩溃', () => {
  const r = parseConfigJson('{"version":2}', '/x/config.json');
  assert.deepEqual(r.providers, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/source-json.test.js
```

预期：FAIL，`Cannot find module '../src/source-json'`。

- [ ] **Step 3: 实现 src/source-json.js**

```js
'use strict';

const { isPlainObject } = require('./merge');

/**
 * 排序对齐 SQLite `ORDER BY is_current DESC, sort_index ASC, name ASC`：
 * sortIndex 为 undefined/null 时视同 NULL 排最前；name 按码位比较（非 locale）。
 */
function compareProviders(a, b) {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const ai = a.sortIndex ?? null;
  const bi = b.sortIndex ?? null;
  if (ai !== bi) {
    if (ai === null) return -1;
    if (bi === null) return 1;
    return ai - bi;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 解析老版 config.json（v2），输出统一领域模型（设计 §5.2） */
function parseConfigJson(content, filePath) {
  let root;
  try {
    root = JSON.parse(content);
  } catch (err) {
    throw new Error(`无法解析 ${filePath}: ${err.message}`);
  }
  if (!isPlainObject(root)) {
    throw new Error(`配置文件格式异常（顶层不是 JSON 对象）: ${filePath}`);
  }

  // v1 检测对齐 app_config.rs：providers 为对象 + current 为字符串 + 无 apps 键
  const isV1 =
    isPlainObject(root.providers) &&
    typeof root.current === 'string' &&
    !('apps' in root);
  if (isV1) {
    throw new Error(
      `检测到旧版 v1 配置格式（${filePath}），ccscope 不支持。\n` +
        '请安装 cc-switch v3.2.x 完成一次性自动迁移，或手动将顶层调整为 v2 结构。'
    );
  }

  const warnings = [];
  const claude = isPlainObject(root.claude) ? root.claude : {};
  const providersMap = isPlainObject(claude.providers) ? claude.providers : {};
  const current = typeof claude.current === 'string' ? claude.current : '';

  const providers = Object.entries(providersMap)
    .map(([id, p]) => ({
      name: typeof p.name === 'string' && p.name !== '' ? p.name : id,
      config: isPlainObject(p.settingsConfig) ? p.settingsConfig : { env: {} },
      commonConfigEnabled: p.meta?.commonConfigEnabled === true,
      isCurrent: id === current,
      sortIndex: typeof p.sortIndex === 'number' ? p.sortIndex : undefined,
    }))
    .sort(compareProviders);

  // 通用配置：common_config_snippets.claude 优先，回退旧字段；值是 JSON 字符串需二次 parse
  let commonConfig = {};
  const snippet =
    root.common_config_snippets?.claude ?? root.claude_common_config_snippet;
  if (typeof snippet === 'string' && snippet.trim() !== '') {
    try {
      const parsed = JSON.parse(snippet);
      if (isPlainObject(parsed)) commonConfig = parsed;
    } catch (err) {
      warnings.push(`通用配置片段解析失败，按空处理（${filePath}）: ${err.message}`);
    }
  }

  return { providers, commonConfig, warnings };
}

module.exports = { parseConfigJson, compareProviders };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/source-json.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/source-json.js test/source-json.test.js
git commit -m "feat: source-json.js 老版 config.json(v2) 数据源"
```

---

### Task 4: source-db.js（新版 SQLite 数据源）

**Files:**
- Create: `src/source-db.js`
- Test: `test/source-db.test.js`

**Interfaces:**
- Consumes: `isPlainObject`（`src/merge.js`）
- Produces:
  - `loadFromDb(dbPath: string) → 领域模型`（同步；打不开/查询失败抛中文 Error，SQLITE_BUSY 单独提示）
  - 内部**延迟** `require('node:sqlite')`（保证 cli.js 的警告过滤先安装）

- [ ] **Step 1: 编写失败测试**

`test/source-db.test.js`（测试内用 node:sqlite 现造临时数据库）：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadFromDb } = require('../src/source-db');

/** 建最小 schema（对齐 schema.rs 的 providers/settings 相关列）并插入 fixture */
function makeDb({ providers = [], commonConfig } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccscope-dbtest-'));
  const dbPath = path.join(dir, 'cc-switch.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, sort_index INTEGER,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type)
  )`);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare(
    'INSERT INTO providers (id, app_type, name, settings_config, sort_index, meta, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const p of providers) {
    insert.run(p.id, p.appType ?? 'claude', p.name, p.settingsConfig ?? '{}',
      p.sortIndex ?? null, p.meta ?? '{}', p.isCurrent ? 1 : 0);
  }
  if (commonConfig !== undefined) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('common_config_claude', ?)")
      .run(commonConfig);
  }
  db.close();
  return dbPath;
}

test('正常读取：字段映射与排序（current 优先、NULL sort_index 最前）', () => {
  const dbPath = makeDb({
    providers: [
      { id: 'a', name: 'NoIndex', settingsConfig: '{"env":{"A":"1"}}' },        // sort_index NULL
      { id: 'b', name: 'Zero', settingsConfig: '{}', sortIndex: 0 },
      { id: 'c', name: 'Cur', settingsConfig: '{}', sortIndex: 9, isCurrent: true,
        meta: '{"commonConfigEnabled":true}' },
    ],
    commonConfig: '{"env":{"COMMON":"x"}}',
  });
  const r = loadFromDb(dbPath);
  assert.deepEqual(r.providers.map((p) => p.name), ['Cur', 'NoIndex', 'Zero']);
  assert.equal(r.providers[0].isCurrent, true);
  assert.equal(r.providers[0].commonConfigEnabled, true);
  assert.equal(r.providers[1].commonConfigEnabled, false);
  assert.deepEqual(r.providers[1].config, { env: { A: '1' } });
  assert.deepEqual(r.commonConfig, { env: { COMMON: 'x' } });
});

test('只取 app_type=claude 的供应商', () => {
  const dbPath = makeDb({
    providers: [
      { id: 'a', name: 'Claude', appType: 'claude' },
      { id: 'a', name: 'Codex', appType: 'codex' },
    ],
  });
  const r = loadFromDb(dbPath);
  assert.deepEqual(r.providers.map((p) => p.name), ['Claude']);
});

test('settings_config 损坏：回退 { env: {} }（与 ccs 一致）', () => {
  const dbPath = makeDb({ providers: [{ id: 'a', name: 'Bad', settingsConfig: '{oops' }] });
  const r = loadFromDb(dbPath);
  assert.deepEqual(r.providers[0].config, { env: {} });
});

test('meta 损坏或缺 key：commonConfigEnabled 一律 false', () => {
  const dbPath = makeDb({
    providers: [
      { id: 'a', name: 'BadMeta', meta: '{oops' },
      { id: 'b', name: 'EmptyMeta', meta: '{}' },
    ],
  });
  const r = loadFromDb(dbPath);
  assert.equal(r.providers.every((p) => p.commonConfigEnabled === false), true);
});

test('通用配置行缺失 → {}；损坏 → {} + 警告', () => {
  const missing = loadFromDb(makeDb({ providers: [{ id: 'a', name: 'A' }] }));
  assert.deepEqual(missing.commonConfig, {});
  assert.deepEqual(missing.warnings, []);

  const broken = loadFromDb(
    makeDb({ providers: [{ id: 'a', name: 'A' }], commonConfig: '{oops' })
  );
  assert.deepEqual(broken.commonConfig, {});
  assert.equal(broken.warnings.length, 1);
});

test('数据库不可读：报中文错误且含路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccscope-dbtest-'));
  const notDb = path.join(dir, 'cc-switch.db');
  fs.writeFileSync(notDb, 'not a sqlite file at all, definitely not.');
  assert.throws(() => loadFromDb(notDb), (err) => err.message.includes(notDb));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/source-db.test.js
```

预期：FAIL，`Cannot find module '../src/source-db'`。

- [ ] **Step 3: 实现 src/source-db.js**

```js
'use strict';

const { isPlainObject } = require('./merge');

const PROVIDERS_SQL = `
  SELECT name, settings_config, meta, is_current
  FROM providers
  WHERE app_type = 'claude'
  ORDER BY is_current DESC, sort_index ASC, name ASC
`;
const COMMON_CONFIG_SQL =
  "SELECT value FROM settings WHERE key = 'common_config_claude'";

/** SQLITE_BUSY（errcode 5 / database is locked）单独提示（设计 §5.1、§9） */
function decorateDbError(err, dbPath) {
  const msg = String((err && err.message) || err);
  if ((err && err.errcode === 5) || msg.includes('database is locked')) {
    return new Error(`数据库正被 cc-switch 写入（${dbPath}），请稍后重试。`);
  }
  return new Error(`读取数据库失败（${dbPath}）: ${msg}`);
}

/** 读取新版 cc-switch.db，输出统一领域模型（设计 §5.1）。只读打开，不写入。 */
function loadFromDb(dbPath) {
  // 延迟 require：node:sqlite 的 ExperimentalWarning 须等 cli.js 装好过滤器后再触发
  const { DatabaseSync } = require('node:sqlite');
  const warnings = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw decorateDbError(err, dbPath);
  }
  try {
    const rows = db.prepare(PROVIDERS_SQL).all();
    const providers = rows.map((row) => {
      let config;
      try {
        config = JSON.parse(row.settings_config);
      } catch {
        config = { env: {} };
      }
      if (!isPlainObject(config)) config = { env: {} };

      let commonConfigEnabled = false;
      try {
        commonConfigEnabled = JSON.parse(row.meta).commonConfigEnabled === true;
      } catch {
        /* meta 损坏一律 false */
      }
      return {
        name: row.name,
        config,
        commonConfigEnabled,
        isCurrent: Boolean(row.is_current),
      };
    });

    let commonConfig = {};
    const configRow = db.prepare(COMMON_CONFIG_SQL).get();
    if (configRow && typeof configRow.value === 'string') {
      // value 即通用配置 JSON 文本，parse 一次即可（二次 parse 只适用于老版 config.json）
      try {
        const parsed = JSON.parse(configRow.value);
        if (isPlainObject(parsed)) commonConfig = parsed;
      } catch (err) {
        warnings.push(`通用配置解析失败，按空处理（${dbPath}）: ${err.message}`);
      }
    }
    return { providers, commonConfig, warnings };
  } catch (err) {
    throw decorateDbError(err, dbPath);
  } finally {
    db.close();
  }
}

module.exports = { loadFromDb };
```

注意 `finally` 中 `db.close()`：若 `db` 打开失败已 throw，不会走到这里；若查询抛错，close 后再抛装饰过的错误。**实现时确认 close 不会覆盖原始异常**（close 自身失败无需处理）。

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/source-db.test.js
```

预期：全部 PASS（Node ≥ 22.13 无需 flag；stderr 可能出现一次 ExperimentalWarning，属正常——过滤在 cli.js 层做）。

- [ ] **Step 5: 提交**

```bash
git add src/source-db.js test/source-db.test.js
git commit -m "feat: source-db.js 新版 SQLite 数据源（node:sqlite 只读）"
```

---

### Task 5: store.js（数据源探测调度）

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `loadFromDb(dbPath)`（Task 4）、`parseConfigJson(content, filePath)`（Task 3）
- Produces:
  - `loadStore(dataDir: string, deps?: { existsSync, readFileSync, loadFromDb }) → 领域模型`
  - 三类"找不到数据"抛不同的中文 Error（设计 §5.3）

- [ ] **Step 1: 编写失败测试**

`test/store.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadStore } = require('../src/store');

function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccscope-store-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('db 存在时优先走 source-db（即使 config.json 也在）', () => {
  const dir = tempDir({ 'cc-switch.db': 'x', 'config.json': '{}' });
  let calledWith = null;
  const fakeModel = { providers: [], commonConfig: {}, warnings: [] };
  const r = loadStore(dir, { loadFromDb: (p) => { calledWith = p; return fakeModel; } });
  assert.equal(calledWith, path.join(dir, 'cc-switch.db'));
  assert.equal(r, fakeModel);
});

test('db 不存在但 config.json 存在时走 source-json', () => {
  const dir = tempDir({
    'config.json': JSON.stringify({
      version: 2,
      claude: { providers: { a: { name: 'A', settingsConfig: {} } }, current: 'a' },
    }),
  });
  const r = loadStore(dir);
  assert.equal(r.providers[0].name, 'A');
});

test('都不存在但有 config.json.migrated：提示备份尚在', () => {
  const dir = tempDir({ 'config.json.migrated': '{}' });
  assert.throws(() => loadStore(dir), /config\.json\.migrated/);
});

test('什么都没有：提示安装 cc-switch', () => {
  const dir = tempDir();
  assert.throws(() => loadStore(dir), /安装 CC-Switch/);
});

test('config.json 读取失败：报路径', () => {
  const dir = tempDir({ 'config.json': '{}' });
  assert.throws(
    () => loadStore(dir, { readFileSync: () => { throw new Error('EACCES'); } }),
    (err) => err.message.includes(path.join(dir, 'config.json'))
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/store.test.js
```

预期：FAIL，`Cannot find module '../src/store'`。

- [ ] **Step 3: 实现 src/store.js**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sourceDb = require('./source-db');
const { parseConfigJson } = require('./source-json');

/**
 * 数据源探测调度（设计 §5）：cc-switch.db 优先 → config.json 回退 → 三类报错。
 * deps 仅供测试注入。
 */
function loadStore(dataDir, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const loadFromDb = deps.loadFromDb || sourceDb.loadFromDb;

  const dbPath = path.join(dataDir, 'cc-switch.db');
  if (existsSync(dbPath)) {
    return loadFromDb(dbPath);
  }

  const jsonPath = path.join(dataDir, 'config.json');
  if (existsSync(jsonPath)) {
    let content;
    try {
      content = readFileSync(jsonPath, 'utf8');
    } catch (err) {
      throw new Error(`读取 ${jsonPath} 失败: ${err.message}`);
    }
    return parseConfigJson(content, jsonPath);
  }

  const migratedPath = path.join(dataDir, 'config.json.migrated');
  if (existsSync(migratedPath)) {
    throw new Error(
      `未找到 cc-switch.db，但存在迁移备份 ${migratedPath}。\n` +
        '数据库可能被误删。可打开 cc-switch GUI 重新初始化，' +
        '或将备份文件改名回 config.json 后由 GUI 重新迁移。'
    );
  }
  throw new Error(
    `在 ${dataDir} 未找到 cc-switch 数据（cc-switch.db 或 config.json）。\n` +
      '请先安装 CC-Switch 并配置至少一个 Claude 供应商。'
  );
}

module.exports = { loadStore };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/store.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: store.js 数据源探测调度（db 优先/json 回退/三类报错）"
```

---

### Task 6: menu.js（方向键选择菜单）

**Files:**
- Create: `src/menu.js`
- Test: `test/menu.test.js`（仅测纯状态机；终端渲染按设计 §10 手动验证）

**Interfaces:**
- Consumes: 领域模型中的 `providers` 数组（用 `name`、`isCurrent` 字段）
- Produces:
  - `reduceKey(state, keyName) → state`，state = `{ index, count, done, cancelled }`，keyName ∈ `'up'|'down'|'enter'|'escape'|'ctrl-c'`
  - `selectProvider(providers, { input?, output? }) → Promise<provider|null>`（null = 用户取消）

- [ ] **Step 1: 编写失败测试**

`test/menu.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { reduceKey } = require('../src/menu');

const s = (index, count = 3) => ({ index, count, done: false, cancelled: false });

test('up/down 移动并环绕', () => {
  assert.equal(reduceKey(s(1), 'up').index, 0);
  assert.equal(reduceKey(s(0), 'up').index, 2);      // 顶部环绕到底部
  assert.equal(reduceKey(s(1), 'down').index, 2);
  assert.equal(reduceKey(s(2), 'down').index, 0);    // 底部环绕到顶部
});

test('enter 结束选择', () => {
  const next = reduceKey(s(1), 'enter');
  assert.equal(next.done, true);
  assert.equal(next.index, 1);
});

test('escape / ctrl-c 取消', () => {
  assert.equal(reduceKey(s(0), 'escape').cancelled, true);
  assert.equal(reduceKey(s(0), 'ctrl-c').cancelled, true);
});

test('未知按键不改变状态', () => {
  assert.deepEqual(reduceKey(s(1), 'x'), s(1));
});

test('reduceKey 不修改输入状态（不可变）', () => {
  const state = s(1);
  reduceKey(state, 'down');
  assert.deepEqual(state, s(1));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/menu.test.js
```

预期：FAIL，`Cannot find module '../src/menu'`。

- [ ] **Step 3: 实现 src/menu.js**

```js
'use strict';

const readline = require('node:readline');

/** 纯状态机：不修改输入，返回新状态（供单测） */
function reduceKey(state, keyName) {
  const { index, count } = state;
  switch (keyName) {
    case 'up':
      return { ...state, index: (index - 1 + count) % count };
    case 'down':
      return { ...state, index: (index + 1) % count };
    case 'enter':
      return { ...state, done: true };
    case 'escape':
    case 'ctrl-c':
      return { ...state, cancelled: true };
    default:
      return state;
  }
}

function render(output, providers, index, first) {
  if (!first) output.write(`\x1b[${providers.length}A`); // 光标上移重绘
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const line = `${p.name}${p.isCurrent ? ' (current)' : ''}`;
    output.write(
      i === index ? `\x1b[36m❯ ${line}\x1b[0m\x1b[K\n` : `  ${line}\x1b[K\n`
    );
  }
}

/**
 * 交互选择供应商：↑/↓ 移动、回车确认、Esc/Ctrl-C 取消（返回 null）。
 * 默认高亮 current 项（设计 §8）。
 */
function selectProvider(providers, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const initial = Math.max(0, providers.findIndex((p) => p.isCurrent));
    let state = { index: initial, count: providers.length, done: false, cancelled: false };

    output.write('选择供应商（↑/↓ 移动，回车确认，Esc 取消）:\n');
    render(output, providers, state.index, true);

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    if (input.isTTY) input.setRawMode(true);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const onKeypress = (_str, key = {}) => {
      const name =
        key.ctrl && key.name === 'c' ? 'ctrl-c'
        : key.name === 'return' ? 'enter'
        : key.name; // 'up' | 'down' | 'escape' | 其他
      state = reduceKey(state, name);
      if (state.done || state.cancelled) {
        cleanup();
        resolve(state.cancelled ? null : providers[state.index]);
        return;
      }
      render(output, providers, state.index, false);
    };

    input.on('keypress', onKeypress);
  });
}

module.exports = { selectProvider, reduceKey };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/menu.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/menu.js test/menu.test.js
git commit -m "feat: menu.js 方向键选择菜单（纯状态机 + readline raw mode）"
```

---

### Task 7: launcher.js（临时 settings 文件 + spawn claude）

**Files:**
- Create: `src/launcher.js`
- Test: `test/launcher.test.js`（仅测 `buildSpawnSpec` 纯函数；spawn 行为手动验证）

**Interfaces:**
- Consumes: `buildEffectiveConfig` 的输出（合并后的 settings 对象）；provider 的 `name`
- Produces:
  - `buildSpawnSpec({ platform, settingsPath, noSkip?, extraArgs? }) → { cmd, args, options }`（win32 参数含 `"` 时 throw）
  - `launch(provider, effectiveConfig, { noSkip?, extraArgs? }) → Promise<number>`（退出码）

- [ ] **Step 1: 编写失败测试**

`test/launcher.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildSpawnSpec } = require('../src/launcher');

test('非 Windows：claude 不走 shell，参数原样', () => {
  const spec = buildSpawnSpec({
    platform: 'linux', settingsPath: '/tmp/x.json', extraArgs: ['-r', 'has space'],
  });
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.options.shell, undefined);
  assert.deepEqual(spec.args, [
    '--settings', '/tmp/x.json', '--dangerously-skip-permissions', '-r', 'has space',
  ]);
});

test('noSkip 时不加 --dangerously-skip-permissions', () => {
  const spec = buildSpawnSpec({ platform: 'linux', settingsPath: '/tmp/x.json', noSkip: true });
  assert.equal(spec.args.includes('--dangerously-skip-permissions'), false);
});

test('Windows：claude（不带扩展名）+ shell:true，含空白参数加双引号', () => {
  const spec = buildSpawnSpec({
    platform: 'win32',
    settingsPath: 'C:\\Users\\A B\\Temp\\x.json', // 用户名带空格
    extraArgs: ['-r', 'two words'],
  });
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.options.shell, true);
  assert.deepEqual(spec.args, [
    '--settings', '"C:\\Users\\A B\\Temp\\x.json"',
    '--dangerously-skip-permissions', '-r', '"two words"',
  ]);
});

test('Windows：透传参数含双引号时明确报错拒绝', () => {
  assert.throws(
    () => buildSpawnSpec({
      platform: 'win32', settingsPath: 'C:\\t\\x.json', extraArgs: ['say "hi"'],
    }),
    /双引号/
  );
});

test('stdio 一律 inherit', () => {
  assert.equal(buildSpawnSpec({ platform: 'linux', settingsPath: '/t/x.json' }).options.stdio, 'inherit');
  assert.equal(buildSpawnSpec({ platform: 'win32', settingsPath: 'C:\\t\\x.json' }).options.stdio, 'inherit');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/launcher.test.js
```

预期：FAIL，`Cannot find module '../src/launcher'`。

- [ ] **Step 3: 实现 src/launcher.js**

```js
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 组装 spawn 规格（纯函数，设计 §7）。
 * Windows：spawn 'claude'（不带扩展名）+ shell:true —— Node 18.20+ 强制 .cmd 走 shell，
 * cmd.exe 按 PATHEXT 同时覆盖 npm 的 claude.cmd 与原生安装器的 claude.exe。
 * shell:true 下 Node 不做引号处理：含空白的参数显式加双引号；
 * 透传参数含双引号直接报错（cmd.exe 转义不可靠，宁可拒绝也不注入）。
 */
function buildSpawnSpec({ platform, settingsPath, noSkip = false, extraArgs = [] }) {
  const baseArgs = ['--settings', settingsPath];
  if (!noSkip) baseArgs.push('--dangerously-skip-permissions');
  baseArgs.push(...extraArgs);

  if (platform !== 'win32') {
    return { cmd: 'claude', args: baseArgs, options: { stdio: 'inherit' } };
  }

  for (const arg of extraArgs) {
    if (arg.includes('"')) {
      throw new Error(`Windows 下透传给 claude 的参数不能包含双引号: ${arg}`);
    }
  }
  const quoted = baseArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return { cmd: 'claude', args: quoted, options: { stdio: 'inherit', shell: true } };
}

/**
 * 合并结果写入临时文件 → spawn claude → 退出后清理临时文件并透传退出码。
 * ENOENT 单独提示未安装 Claude Code CLI。
 */
function launch(provider, effectiveConfig, { noSkip = false, extraArgs = [] } = {}) {
  const settingsPath = path.join(
    os.tmpdir(),
    `ccscope-${crypto.randomBytes(6).toString('hex')}.json`
  );
  // 先组装（win32 参数校验可能 throw），再落盘，避免残留孤儿临时文件
  const spec = buildSpawnSpec({
    platform: process.platform, settingsPath, noSkip, extraArgs,
  });
  fs.writeFileSync(settingsPath, JSON.stringify(effectiveConfig));

  console.log(`→ Launching [${provider.name}]`);

  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, spec.options);
    const finish = (code) => {
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* 清理尽力而为 */
      }
      resolve(code);
    };
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(
          '未找到 claude 命令。请先安装 Claude Code CLI：npm i -g @anthropic-ai/claude-code'
        );
      } else {
        console.error(`启动 claude 失败: ${err.message}`);
      }
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 0));
  });
}

module.exports = { launch, buildSpawnSpec };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/launcher.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/launcher.js test/launcher.test.js
git commit -m "feat: launcher.js 临时 settings 文件 + spawn claude（win32 引号安全）"
```

---

### Task 8: cli.js（入口：参数解析、警告过滤、流程编排）

**Files:**
- Create: `src/cli.js`
- Test: `test/cli.test.js`（测 `parseArgs`、`fuzzyMatch` 纯函数）

**Interfaces:**
- Consumes:
  - `resolveDataDir`（Task 2）、`loadStore`（Task 5）、`buildEffectiveConfig`（Task 1）、`selectProvider`（Task 6）、`launch`（Task 7）
- Produces:
  - bin 入口（`require.main === module` 时才运行 main）
  - `parseArgs(argv) → { help, version, list, noSkip, query, claudeArgs, unknown }`
  - `fuzzyMatch(providers, query) → { selected: provider|null, matches: provider[] }`

- [ ] **Step 1: 编写失败测试**

`test/cli.test.js`：

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, fuzzyMatch } = require('../src/cli');

const argv = (...args) => ['node', 'cli.js', ...args];

test('parseArgs: 无参数 → 交互模式（query 为 null）', () => {
  const p = parseArgs(argv());
  assert.equal(p.query, null);
  assert.deepEqual(p.claudeArgs, []);
});

test('parseArgs: 各标志', () => {
  assert.equal(parseArgs(argv('--help')).help, true);
  assert.equal(parseArgs(argv('-h')).help, true);
  assert.equal(parseArgs(argv('--version')).version, true);
  assert.equal(parseArgs(argv('-V')).version, true);
  assert.equal(parseArgs(argv('--list')).list, true);
  assert.equal(parseArgs(argv('-l')).list, true);
  assert.equal(parseArgs(argv('--no-skip')).noSkip, true);
});

test('parseArgs: -- 之后原样透传（包括横杠开头的）', () => {
  const p = parseArgs(argv('deep', '--no-skip', '--', '-r', '--model', 'opus'));
  assert.equal(p.query, 'deep');
  assert.equal(p.noSkip, true);
  assert.deepEqual(p.claudeArgs, ['-r', '--model', 'opus']);
});

test('parseArgs: 未知标志收集到 unknown', () => {
  assert.deepEqual(parseArgs(argv('--bogus')).unknown, ['--bogus']);
});

test('fuzzyMatch: 大小写不敏感 includes', () => {
  const providers = [{ name: 'DeepSeek', isCurrent: false }];
  assert.equal(fuzzyMatch(providers, 'deep').selected.name, 'DeepSeek');
});

test('fuzzyMatch: 多匹配优先 current，其次首个', () => {
  const providers = [
    { name: 'kimi-a', isCurrent: false },
    { name: 'kimi-b', isCurrent: true },
  ];
  const r = fuzzyMatch(providers, 'kimi');
  assert.equal(r.selected.name, 'kimi-b');
  assert.equal(r.matches.length, 2);

  const noneCurrent = providers.map((p) => ({ ...p, isCurrent: false }));
  assert.equal(fuzzyMatch(noneCurrent, 'kimi').selected.name, 'kimi-a');
});

test('fuzzyMatch: 无匹配返回 null', () => {
  assert.equal(fuzzyMatch([{ name: 'A', isCurrent: false }], 'zzz').selected, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/cli.test.js
```

预期：FAIL，`Cannot find module '../src/cli'`。

- [ ] **Step 3: 实现 src/cli.js**

```js
#!/usr/bin/env node
'use strict';

// 必须最先安装（设计 §2）：Node 22/24 上 node:sqlite 会打 ExperimentalWarning，
// 仅精确过滤它，其余警告照常输出。source-db.js 延迟 require node:sqlite 配合此处。
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredEmitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  const type =
    typeof rest[0] === 'string' ? rest[0]
    : rest[0] && typeof rest[0] === 'object' ? rest[0].type
    : warning && warning.name;
  if (type === 'ExperimentalWarning' && text.includes('SQLite')) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const fs = require('node:fs');
const os = require('node:os');
const { resolveDataDir } = require('./paths');
const { loadStore } = require('./store');
const { buildEffectiveConfig } = require('./merge');
const { selectProvider } = require('./menu');
const { launch } = require('./launcher');
const { version } = require('../package.json');

function parseArgs(argv) {
  const args = argv.slice(2);
  const sepIdx = args.indexOf('--');
  const own = sepIdx >= 0 ? args.slice(0, sepIdx) : args;
  const claudeArgs = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

  const parsed = {
    help: false, version: false, list: false, noSkip: false,
    query: null, claudeArgs, unknown: [],
  };
  for (const arg of own) {
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '-V' || arg === '--version') parsed.version = true;
    else if (arg === '-l' || arg === '--list') parsed.list = true;
    else if (arg === '--no-skip') parsed.noSkip = true;
    else if (arg.startsWith('-')) parsed.unknown.push(arg);
    else if (parsed.query === null) parsed.query = arg;
  }
  return parsed;
}

/** 模糊匹配：大小写不敏感 includes；多匹配优先 current，其次首个（设计 §8） */
function fuzzyMatch(providers, query) {
  const q = query.toLowerCase();
  const matches = providers.filter((p) => p.name.toLowerCase().includes(q));
  if (matches.length === 0) return { selected: null, matches };
  const selected = matches.find((m) => m.isCurrent) || matches[0];
  return { selected, matches };
}

function printHelp() {
  console.log(`ccscope — 会话级 Claude Code 启动器（读取 CC-Switch 供应商配置）

用法:
  ccscope                    交互菜单选择供应商
  ccscope <name>             模糊匹配供应商名后启动
  ccscope <name> -- <args>   -- 之后的参数透传给 claude
  ccscope --list             列出供应商（标注 current 与数据目录）

选项:
  -l, --list      仅列出供应商，不启动
  --no-skip       不追加 --dangerously-skip-permissions
  -V, --version   显示版本
  -h, --help      显示帮助`);
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.version) { console.log(`ccscope ${version}`); return 0; }
  if (parsed.help) { printHelp(); return 0; }
  if (parsed.unknown.length > 0) {
    console.error(`未知参数: ${parsed.unknown.join(' ')}（--help 查看用法）`);
    return 1;
  }

  const resolved = resolveDataDir({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
  });
  for (const w of resolved.warnings) console.error(`警告: ${w}`);

  let store;
  try {
    store = loadStore(resolved.dir);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  for (const w of store.warnings) console.error(`警告: ${w}`);

  const { providers, commonConfig } = store;
  if (providers.length === 0) {
    console.error('cc-switch 中没有 Claude 供应商，请先在 CC-Switch GUI 中添加。');
    return 1;
  }

  if (parsed.list) {
    console.log(`数据目录: ${resolved.dir} (${resolved.source})\n`);
    providers.forEach((p, i) => {
      const marker = p.isCurrent ? '  ● current' : '';
      console.log(`  ${String(i + 1).padStart(2)}  ${p.name}${marker}`);
    });
    return 0;
  }

  let selected;
  if (parsed.query) {
    const { selected: match, matches } = fuzzyMatch(providers, parsed.query);
    if (!match) {
      const names = providers.map((p) => p.name).join(' / ');
      console.error(`没有匹配 "${parsed.query}" 的供应商。可选: ${names}`);
      return 1;
    }
    if (matches.length > 1) {
      console.log(
        `多个匹配: ${matches.map((m) => m.name).join(', ')}` +
        `，使用: ${match.name}${match.isCurrent ? ' (current)' : ''}`
      );
    }
    selected = match;
  } else {
    if (!process.stdin.isTTY) {
      console.error('非交互终端下请直接指定供应商名: ccscope <name>');
      return 1;
    }
    selected = await selectProvider(providers);
    if (!selected) return 0; // Esc/Ctrl-C 取消（设计 §8：退出码 0）
  }

  const effective = buildEffectiveConfig(
    selected.config, commonConfig, selected.commonConfigEnabled
  );
  return launch(selected, effective, {
    noSkip: parsed.noSkip, extraArgs: parsed.claudeArgs,
  });
}

module.exports = { parseArgs, fuzzyMatch };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`ccscope 内部错误: ${(err && err.stack) || err}`);
      process.exit(1);
    }
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/cli.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 跑全量测试**

```bash
node --test test/
```

预期：全部 PASS，无失败用例。

- [ ] **Step 6: 提交**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: cli.js 入口（参数解析/警告过滤/流程编排）"
```

---

### Task 9: 端到端手动验证 + 文档收尾

**Files:**
- Modify: `CLAUDE.md`（"常用命令"一节）
- 无新代码；本任务是发布前验证闸门

**Interfaces:**
- Consumes: 全部前序任务的成果
- Produces: 可交付的工具 + 更新后的项目文档

- [ ] **Step 1: 构造 fixture 数据目录做 E2E（不碰真实数据）**

```bash
mkdir -p /tmp/ccscope-e2e
cat > /tmp/ccscope-e2e/config.json <<'EOF'
{
  "version": 2,
  "claude": {
    "providers": {
      "p1": { "name": "TestAlpha", "settingsConfig": { "env": { "X": "1" } }, "sortIndex": 0 },
      "p2": { "name": "TestBeta", "settingsConfig": { "env": { "Y": "2" } }, "sortIndex": 1,
              "meta": { "commonConfigEnabled": true } }
    },
    "current": "p2"
  },
  "common_config_snippets": { "claude": "{\"env\":{\"COMMON\":\"c\"}}" }
}
EOF
CC_SWITCH_DIR=/tmp/ccscope-e2e node src/cli.js --list
```

预期输出：首行 `数据目录: /tmp/ccscope-e2e (env)`；TestBeta 在前且带 `● current`。

- [ ] **Step 2: 验证模糊匹配 + 启动（需本机装有 claude）**

```bash
CC_SWITCH_DIR=/tmp/ccscope-e2e node src/cli.js beta -- --version
```

预期：打印 `→ Launching [TestBeta]` 后执行 `claude --version` 并正常退出；`ls $TMPDIR/ccscope-*.json` 无残留临时文件。若本机未装 claude，预期看到"未找到 claude 命令"提示、退出码 1——同样算验证通过。

- [ ] **Step 3: 验证交互菜单（手动）**

```bash
CC_SWITCH_DIR=/tmp/ccscope-e2e node src/cli.js
```

逐项确认：默认高亮 TestBeta（current）；↑/↓ 环绕移动；Esc 退出且 `echo $?` 为 0；回车后进入启动流程。

- [ ] **Step 4: 验证真实数据读取（只读，安全）**

```bash
node src/cli.js --list
```

预期：显示本机真实 cc-switch 数据目录与供应商列表；stderr 无 ExperimentalWarning（警告过滤生效）。

- [ ] **Step 5: 验证错误场景**

```bash
mkdir -p /tmp/ccscope-empty && CC_SWITCH_DIR=/tmp/ccscope-empty node src/cli.js --list; echo "exit=$?"
touch /tmp/ccscope-empty/config.json.migrated
CC_SWITCH_DIR=/tmp/ccscope-empty node src/cli.js --list; echo "exit=$?"
```

预期：第一次提示"安装 CC-Switch"，第二次提示"迁移备份…可能被误删"，两次退出码均为 1。

- [ ] **Step 6: 更新 CLAUDE.md 常用命令**

将 CLAUDE.md 末尾"## 常用命令"一节替换为：

```markdown
## 常用命令

- 运行：`node src/cli.js --list`（用 `CC_SWITCH_DIR=<fixture目录>` 隔离真实数据）
- 测试：`node --test test/`（等价 `npm test`）
- 本地安装验证：`npm link` 后直接运行 `ccscope`
```

- [ ] **Step 7: 全量回归 + 提交**

```bash
node --test test/
git add CLAUDE.md
git commit -m "docs: 补充常用命令（运行/测试/本地安装）"
```

预期：测试全部 PASS，工作区干净。

---

## Self-Review 记录

- **规格覆盖**：设计 §2（警告过滤→Task 8）、§3（模块结构→Task 1-8 一一对应）、§4（含 `~` 展开与 home-legacy→Task 2）、§5（三类报错→Task 5；SQLITE_BUSY→Task 4；NULL 排序→Task 3/4）、§6（→Task 1）、§7（含 win32 引号/claude 不带扩展名→Task 7）、§8（CLI 接口→Task 8）、§9（中文报错+指引，散布各任务）、§10（测试策略→各任务 + menu/launcher 手动验证在 Task 9）、§11（非目标：未实现任何写入/管理功能）。无缺口。
- **占位符扫描**：所有代码步骤均为完整可用代码，无 TBD/TODO/"类似 Task N"。
- **类型一致性**：领域模型字段（`name/config/commonConfigEnabled/isCurrent/sortIndex/warnings`）在 Task 3/4/5/8 间一致；`buildEffectiveConfig(providerConfig, commonConfig, commonConfigEnabled)` 签名在 Task 1 定义、Task 8 调用一致；`buildSpawnSpec`/`launch`/`selectProvider`/`reduceKey`/`parseArgs`/`fuzzyMatch` 的签名在定义与消费处一致。
