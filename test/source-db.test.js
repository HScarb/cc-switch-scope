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
