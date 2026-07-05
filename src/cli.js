#!/usr/bin/env node
'use strict';

// 必须最先安装（设计 §2）：Node 22/24 上 node:sqlite 会打 ExperimentalWarning，
// 仅精确过滤它，其余警告照常输出。source-db.js 延迟 require node:sqlite 配合此处。
const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredEmitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  const type = typeof rest[0] === 'string' ? rest[0]
    : rest[0] && typeof rest[0] === 'object' ? rest[0].type : warning && warning.name;
  if (type === 'ExperimentalWarning' && text.includes('SQLite')) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const fs = require('node:fs'); const os = require('node:os');
const { resolveDataDir } = require('./paths'); const { loadStore } = require('./store');
const { buildEffectiveConfig } = require('./merge'); const { selectProvider } = require('./menu');
const { launch } = require('./launcher'); const { version } = require('../package.json');

function parseArgs(argv) {
  const args = argv.slice(2); const sepIdx = args.indexOf('--');
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

/**
 * 模糊匹配：大小写不敏感 includes（设计 §8）。
 * 多匹配时的优先级：精确匹配 > 前缀匹配 > current > 首个——
 * 用户打全了名字就不该被 current 抢走（如 "kimi" 命中 kimi 而非 current 的 kimi-pro）。
 */
function fuzzyMatch(providers, query) {
  const q = query.toLowerCase();
  const matches = providers.filter((p) => p.name.toLowerCase().includes(q));
  if (matches.length === 0) return { selected: null, matches, exact: false };
  const exactPool = matches.filter((m) => m.name.toLowerCase() === q);
  const prefixPool = matches.filter((m) => m.name.toLowerCase().startsWith(q));
  const pool = exactPool.length > 0 ? exactPool : prefixPool.length > 0 ? prefixPool : matches;
  const selected = pool.find((m) => m.isCurrent) || pool[0];
  return { selected, matches, exact: exactPool.length > 0 };
}

/**
 * 查询解析：纯数字按 --list 序号直选；否则走 fuzzyMatch。
 * kind: 'index' | 'index-out-of-range' | 'match' | 'ambiguous' | 'no-match'
 */
function resolveQuery(providers, query) {
  if (/^\d+$/.test(query)) {
    const n = Number(query);
    if (n >= 1 && n <= providers.length) {
      return { kind: 'index', selected: providers[n - 1], matches: [providers[n - 1]] };
    }
    return { kind: 'index-out-of-range', selected: null, matches: [] };
  }
  const { selected, matches, exact } = fuzzyMatch(providers, query);
  if (!selected) return { kind: 'no-match', selected: null, matches };
  const ambiguous = matches.length > 1 && !exact;
  return { kind: ambiguous ? 'ambiguous' : 'match', selected, matches };
}

/** 供 --list 展示的供应商 base URL host（不含密钥）；无配置或非法 URL 时尽力降级 */
function providerHost(provider) {
  const raw = provider?.config?.env?.ANTHROPIC_BASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return new URL(raw.trim()).host;
  } catch {
    return raw.trim();
  }
}

function printHelp() {
  console.log(`ccscope — 会话级 Claude Code 启动器（读取 CC-Switch 供应商配置）

用法:
  ccscope                    交互菜单选择供应商（↑/↓/j/k 移动，数字直选，回车确认）
  ccscope <name>             模糊匹配供应商名后启动（精确 > 前缀 > current）
  ccscope <序号>             按 --list 中的序号直接启动
  ccscope <name> -- <args>   -- 之后的参数透传给 claude
  ccscope --list             列出供应商（标注 current、base URL 与数据目录）

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
    console.error(`未知参数: ${parsed.unknown.join(' ')}（--help 查看用法）`); return 1;
  }

  const resolved = resolveDataDir({
    platform: process.platform, env: process.env, homedir: os.homedir(),
    existsSync: fs.existsSync, readFileSync: fs.readFileSync,
  });
  for (const w of resolved.warnings) console.error(`警告: ${w}`);

  let store;
  try { store = loadStore(resolved.dir); } catch (err) { console.error(err.message); return 1; }
  for (const w of store.warnings) console.error(`警告: ${w}`);

  const { providers, commonConfig } = store;
  if (providers.length === 0) {
    console.error('cc-switch 中没有 Claude 供应商，请先在 CC-Switch GUI 中添加。');
    return 1;
  }

  if (parsed.list) {
    console.log(`数据目录: ${resolved.dir} (${resolved.source})\n`);
    const nameWidth = Math.max(...providers.map((p) => p.name.length));
    providers.forEach((p, i) => {
      const marker = p.isCurrent ? '  ● current' : '';
      const host = providerHost(p);
      console.log(
        `  ${String(i + 1).padStart(2)}  ${p.name.padEnd(nameWidth)}` +
        `${host ? `  ${host}` : ''}${marker}`
      );
    });
    return 0;
  }

  let selected;
  if (parsed.query) {
    const r = resolveQuery(providers, parsed.query);
    if (r.kind === 'index-out-of-range') {
      console.error(
        `序号超出范围: ${parsed.query}（有效范围 1-${providers.length}，ccscope --list 查看列表）`
      );
      return 1;
    }
    if (r.kind === 'no-match') {
      const names = providers.map((p) => p.name).join(' / ');
      console.error(`没有匹配 "${parsed.query}" 的供应商。可选: ${names}`);
      return 1;
    }
    if (r.kind === 'ambiguous' && process.stdin.isTTY) {
      // 多个匹配且可交互：让用户从匹配子集中确认，而不是替用户拍板
      console.log(`多个供应商匹配 "${parsed.query}":`);
      selected = await selectProvider(r.matches);
      if (!selected) return 0;
    } else {
      if (r.kind === 'ambiguous') {
        console.log(
          `多个匹配: ${r.matches.map((m) => m.name).join(', ')}` +
          `，使用: ${r.selected.name}${r.selected.isCurrent ? ' (current)' : ''}`
        );
      }
      selected = r.selected;
    }
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
  // buildSpawnSpec 的双引号校验等属预期用户错误：只打消息，不带堆栈、不走「内部错误」兜底
  try {
    return await launch(selected, effective, { noSkip: parsed.noSkip, extraArgs: parsed.claudeArgs });
  } catch (err) { console.error(err.message); return 1; }
}

module.exports = { parseArgs, fuzzyMatch, resolveQuery, providerHost };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`ccscope 内部错误: ${(err && err.stack) || err}`);
      process.exit(1);
    }
  );
}
