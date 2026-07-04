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
