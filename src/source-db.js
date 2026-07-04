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
