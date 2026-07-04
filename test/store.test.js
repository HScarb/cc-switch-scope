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
