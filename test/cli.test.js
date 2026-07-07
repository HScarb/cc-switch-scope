'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, fuzzyMatch, resolveQuery, providerHost } = require('../src/cli');

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

test('parseArgs: --resume 单独出现 → resume 为 true，无 sessionId', () => {
  const p = parseArgs(argv('--resume'));
  assert.equal(p.resume, true);
  assert.equal(p.resumeId, null);
});

test('parseArgs: --resume 贪婪取值，紧跟的非横杠参数视为 sessionId', () => {
  const p = parseArgs(argv('--resume', 'abc123'));
  assert.equal(p.resume, true);
  assert.equal(p.resumeId, 'abc123');
  assert.equal(p.query, null); // sessionId 不落进供应商查询
});

test('parseArgs: 供应商名与 --resume sessionId 共存', () => {
  const p = parseArgs(argv('deep', '--resume', 'abc123'));
  assert.equal(p.query, 'deep');
  assert.equal(p.resumeId, 'abc123');
});

test('parseArgs: -r 与 --resume 等价', () => {
  const p = parseArgs(argv('-r', 'abc123'));
  assert.equal(p.resume, true);
  assert.equal(p.resumeId, 'abc123');
});

test('parseArgs: --resume 后跟标志时不吞值', () => {
  const p = parseArgs(argv('--resume', '--no-skip'));
  assert.equal(p.resume, true);
  assert.equal(p.resumeId, null);
  assert.equal(p.noSkip, true);
});

test('parseArgs: --resume 取值后剩余位置参数仍作供应商查询', () => {
  const p = parseArgs(argv('--resume', 'abc', 'deep'));
  assert.equal(p.resumeId, 'abc');
  assert.equal(p.query, 'deep');
});

test('parseArgs: --resume 与 -- 透传互不干扰', () => {
  const p = parseArgs(argv('deep', '--resume', '--', '--model', 'opus'));
  assert.equal(p.query, 'deep');
  assert.equal(p.resume, true);
  assert.equal(p.resumeId, null);
  assert.deepEqual(p.claudeArgs, ['--model', 'opus']);
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

test('fuzzyMatch: 精确匹配优先于 current', () => {
  const providers = [
    { name: 'kimi', isCurrent: false },
    { name: 'kimi-pro', isCurrent: true },
  ];
  const r = fuzzyMatch(providers, 'kimi');
  assert.equal(r.selected.name, 'kimi');
  assert.equal(r.exact, true);
  assert.equal(r.matches.length, 2);
});

test('fuzzyMatch: 前缀匹配优先于中缀匹配', () => {
  const providers = [
    { name: 'my-glm', isCurrent: true },
    { name: 'glm-air', isCurrent: false },
  ];
  const r = fuzzyMatch(providers, 'glm');
  assert.equal(r.selected.name, 'glm-air');
  assert.equal(r.exact, false);
});

test('fuzzyMatch: 精确匹配大小写不敏感', () => {
  const providers = [{ name: 'DeepSeek', isCurrent: false }];
  assert.equal(fuzzyMatch(providers, 'deepseek').exact, true);
});

const three = [
  { name: 'kimi', isCurrent: false },
  { name: 'deepseek', isCurrent: true },
  { name: 'glm', isCurrent: false },
];

test('resolveQuery: 纯数字按序号直选（1 起）', () => {
  assert.equal(resolveQuery(three, '1').selected.name, 'kimi');
  assert.equal(resolveQuery(three, '3').selected.name, 'glm');
  assert.equal(resolveQuery(three, '2').kind, 'index');
});

test('resolveQuery: 序号越界报 index-out-of-range', () => {
  assert.equal(resolveQuery(three, '0').kind, 'index-out-of-range');
  assert.equal(resolveQuery(three, '4').kind, 'index-out-of-range');
});

test('resolveQuery: 名字查询区分 match / ambiguous / no-match', () => {
  assert.equal(resolveQuery(three, 'deep').kind, 'match');
  assert.equal(resolveQuery(three, 'zzz').kind, 'no-match');
  const two = [
    { name: 'kimi-a', isCurrent: false },
    { name: 'kimi-b', isCurrent: false },
  ];
  assert.equal(resolveQuery(two, 'kimi').kind, 'ambiguous');
  assert.equal(resolveQuery(two, 'kimi-a').kind, 'match'); // 精确命中不算歧义
});

test('providerHost: 提取 base URL 的 host，缺省/非法时降级', () => {
  const p = (url) => ({ config: { env: { ANTHROPIC_BASE_URL: url } } });
  assert.equal(providerHost(p('https://api.example.com/v1')), 'api.example.com');
  assert.equal(providerHost(p('not a url')), 'not a url'); // 非法 URL 原样展示
  assert.equal(providerHost(p('')), null);
  assert.equal(providerHost({ config: { env: {} } }), null);
  assert.equal(providerHost({ config: {} }), null);
});
