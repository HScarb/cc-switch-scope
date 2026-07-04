'use strict';

const path = require('node:path');

const STORE_KEY = 'app_config_dir_override';
const IDENTIFIER = 'com.ccswitch.desktop';

/** 对齐 app_store.rs resolve_path：支持 ~、~/、~\ 前缀展开为主目录 */
function expandTilde(raw, homedir) {
  if (raw === '~') return homedir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(homedir, raw.slice(2));
  }
  return raw;
}

/** Tauri Store app_paths.json 的平台路径（identifier: com.ccswitch.desktop） */
function appPathsFile({ platform, env, homedir }) {
  if (platform === 'win32') {
    if (!env.APPDATA) return null;
    return path.join(env.APPDATA, IDENTIFIER, 'app_paths.json');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', IDENTIFIER, 'app_paths.json');
  }
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ''
      ? env.XDG_CONFIG_HOME
      : path.join(homedir, '.config');
  return path.join(base, IDENTIFIER, 'app_paths.json');
}

/**
 * 解析 cc-switch 数据目录（设计 §4）。
 * 优先级：CC_SWITCH_DIR 环境变量 → app_paths.json override → 默认（含 win32 HOME legacy 回退）。
 */
function resolveDataDir({ platform, env, homedir, existsSync, readFileSync }) {
  const warnings = [];

  const envDir = (env.CC_SWITCH_DIR || '').trim();
  if (envDir !== '') {
    return { dir: envDir, source: 'env', warnings };
  }

  const storeFile = appPathsFile({ platform, env, homedir });
  if (storeFile && existsSync(storeFile)) {
    try {
      const store = JSON.parse(readFileSync(storeFile, 'utf8'));
      const raw = store[STORE_KEY];
      if (typeof raw === 'string' && raw.trim() !== '') {
        const expanded = expandTilde(raw.trim(), homedir);
        if (existsSync(expanded)) {
          return { dir: expanded, source: 'override', warnings };
        }
        warnings.push(`app_paths.json 配置的数据目录不存在，已忽略: ${expanded}`);
      } else if (raw !== undefined && typeof raw !== 'string') {
        warnings.push(`app_paths.json 中 ${STORE_KEY} 应为字符串，已忽略`);
      }
    } catch (err) {
      warnings.push(`app_paths.json 读取失败，按无覆盖处理（${storeFile}）: ${err.message}`);
    }
  }

  const defaultDir = path.join(homedir, '.cc-switch');
  // 复刻 cc-switch config.rs get_app_config_dir 的 win32 HOME legacy 回退：
  // 默认目录没有 db、HOME 指向的 .cc-switch 下有 db → 用后者（v3.10.3 遗留数据仍在使用中）
  if (platform === 'win32' && !existsSync(path.join(defaultDir, 'cc-switch.db'))) {
    const homeEnv = (env.HOME || '').trim();
    if (homeEnv !== '') {
      const legacyDir = path.join(homeEnv, '.cc-switch');
      if (existsSync(path.join(legacyDir, 'cc-switch.db'))) {
        return { dir: legacyDir, source: 'home-legacy', warnings };
      }
    }
  }
  return { dir: defaultDir, source: 'default', warnings };
}

module.exports = { resolveDataDir, expandTilde, appPathsFile };
