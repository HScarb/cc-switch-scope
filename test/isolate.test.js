'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  maskLeakedEnvKeys,
  userSettingsPath,
  readUserSettings,
} = require('../src/isolate');

// ---- maskLeakedEnvKeys ----

test('maskLeakedEnvKeys: live 有、effective 没有的 env 键被屏蔽为空字符串', () => {
  const effective = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-target', ANTHROPIC_BASE_URL: 'https://t/' } };
  const live = {
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-live',
      ANTHROPIC_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
    },
  };
  const out = maskLeakedEnvKeys(effective, live);
  assert.equal(out.env.ANTHROPIC_MODEL, '');
  assert.equal(out.env.ANTHROPIC_DEFAULT_SONNET_MODEL, '');
});

test('maskLeakedEnvKeys: effective 已有的键保持自身值不被覆盖', () => {
  const effective = { env: { ANTHROPIC_BASE_URL: 'https://t/' } };
  const live = { env: { ANTHROPIC_BASE_URL: 'https://live/' } };
  const out = maskLeakedEnvKeys(effective, live);
  assert.equal(out.env.ANTHROPIC_BASE_URL, 'https://t/');
});

test('maskLeakedEnvKeys: live 为 null/无 env/env 非对象 → 原样拷贝', () => {
  const effective = { env: { A: '1' }, model: 'opus' };
  for (const live of [null, undefined, {}, { env: 'oops' }, { env: [1] }]) {
    const out = maskLeakedEnvKeys(effective, live);
    assert.deepEqual(out, effective);
  }
});

test('maskLeakedEnvKeys: effective 没有 env 对象时按需创建', () => {
  const effective = { model: 'opus' };
  const live = { env: { ANTHROPIC_MODEL: 'glm-5.2' } };
  const out = maskLeakedEnvKeys(effective, live);
  assert.deepEqual(out.env, { ANTHROPIC_MODEL: '' });
  assert.equal(out.model, 'opus');
});

test('maskLeakedEnvKeys: 不修改任何输入（不可变）', () => {
  const effective = { env: { A: '1' } };
  const live = { env: { B: '2' } };
  const effectiveSnapshot = structuredClone(effective);
  const liveSnapshot = structuredClone(live);
  maskLeakedEnvKeys(effective, live);
  assert.deepEqual(effective, effectiveSnapshot);
  assert.deepEqual(live, liveSnapshot);
});

// ---- userSettingsPath ----

test('userSettingsPath: 默认 homedir/.claude/settings.json', () => {
  const p = userSettingsPath({ env: {}, homedir: '/home/u' });
  assert.equal(p, path.join('/home/u', '.claude', 'settings.json'));
});

test('userSettingsPath: CLAUDE_CONFIG_DIR 覆盖目录', () => {
  const p = userSettingsPath({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, homedir: '/home/u' });
  assert.equal(p, path.join('/cfg', 'settings.json'));
});

test('userSettingsPath: CLAUDE_CONFIG_DIR 空白字符串视为未设置', () => {
  const p = userSettingsPath({ env: { CLAUDE_CONFIG_DIR: '  ' }, homedir: '/home/u' });
  assert.equal(p, path.join('/home/u', '.claude', 'settings.json'));
});

// ---- readUserSettings ----

test('readUserSettings: 文件不存在 → settings 为 null 且无警告', () => {
  const r = readUserSettings({
    env: {}, homedir: '/home/u',
    existsSync: () => false,
    readFileSync: () => { throw new Error('不应被调用'); },
  });
  assert.equal(r.settings, null);
  assert.equal(r.warning, null);
});

test('readUserSettings: 合法 JSON → 解析结果', () => {
  const r = readUserSettings({
    env: {}, homedir: '/home/u',
    existsSync: () => true,
    readFileSync: () => '{"env":{"ANTHROPIC_MODEL":"glm-5.2"}}',
  });
  assert.deepEqual(r.settings, { env: { ANTHROPIC_MODEL: 'glm-5.2' } });
  assert.equal(r.warning, null);
});

test('readUserSettings: JSON 解析失败 → settings null + 警告', () => {
  const r = readUserSettings({
    env: {}, homedir: '/home/u',
    existsSync: () => true,
    readFileSync: () => '{oops',
  });
  assert.equal(r.settings, null);
  assert.match(r.warning, /settings\.json/);
});

test('readUserSettings: 顶层不是对象 → settings null + 警告', () => {
  const r = readUserSettings({
    env: {}, homedir: '/home/u',
    existsSync: () => true,
    readFileSync: () => '[1,2]',
  });
  assert.equal(r.settings, null);
  assert.match(r.warning, /settings\.json/);
});
