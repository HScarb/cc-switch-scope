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

test('供应商条目为 null 等非对象：按空对象容错处理', () => {
  const root = JSON.parse(v2Config({ providers: { p1: { name: 'Valid' }, p2: {} } }));
  root.claude.providers.p2 = null;
  root.claude.providers.p3 = 'string';
  root.claude.providers.p4 = 123;
  const r = parseConfigJson(JSON.stringify(root), '/x/config.json');
  assert.equal(r.providers.length, 4);
  // p1 正常
  assert.equal(r.providers[0].name, 'Valid');
  // p2、p3、p4 都降级为空对象，name 回退 id，config 回退 { env: {} }，commonConfigEnabled 为 false
  const nullEntries = r.providers.filter((p) => ['p2', 'p3', 'p4'].includes(p.name));
  assert.equal(nullEntries.length, 3);
  nullEntries.forEach((p) => {
    assert.deepEqual(p.config, { env: {} });
    assert.equal(p.commonConfigEnabled, false);
  });
});
