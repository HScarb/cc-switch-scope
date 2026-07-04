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
