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
