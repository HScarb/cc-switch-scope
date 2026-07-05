'use strict';

const path = require('node:path');
const { isPlainObject } = require('./merge');

/**
 * 会话隔离：屏蔽从用户级 ~/.claude/settings.json 泄漏的 env 键。
 *
 * 背景：claude 启动时按优先级逐键合并 --settings（命令行）与用户级
 * settings.json（cc-switch 切换供应商时写入）。两边都有的键命令行获胜，
 * 但只存在于用户级的键（如激活供应商专属的 ANTHROPIC_MODEL）会直接漏进
 * 会话，且 env 优先级高于 settings 的 model 字段。
 *
 * 对策：live env 有、effective env 没有的键，在 effective env 中显式写入
 * 空字符串——逐键合并时以最高优先级压掉泄漏值，claude 将空串视同未设置
 * （实测：ANTHROPIC_MODEL 为 '' 时回落到 model 字段/默认模型解析）。
 */

/** 用户级 settings.json 路径：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude */
function userSettingsPath({ env, homedir }) {
  const configDir = (env.CLAUDE_CONFIG_DIR || '').trim();
  const dir = configDir !== '' ? configDir : path.join(homedir, '.claude');
  return path.join(dir, 'settings.json');
}

/**
 * 读取用户级 settings.json。文件不存在属正常（全新机器）不告警；
 * 解析失败或顶层不是对象 → settings 为 null 并返回警告（claude 面对
 * 同样的破损文件会自行处理，ccscope 不因此中断启动）。
 */
function readUserSettings({ env, homedir, existsSync, readFileSync }) {
  const file = userSettingsPath({ env, homedir });
  if (!existsSync(file)) return { settings: null, warning: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { settings: null, warning: `用户级 settings.json 顶层不是对象，跳过泄漏屏蔽（${file}）` };
    }
    return { settings: parsed, warning: null };
  } catch (err) {
    return { settings: null, warning: `用户级 settings.json 读取失败，跳过泄漏屏蔽（${file}）: ${err.message}` };
  }
}

/**
 * 纯函数：返回新配置，liveSettings.env 中存在而 effectiveConfig.env 中
 * 缺失的键全部置为 ''。live 无合法 env 时返回原配置拷贝。
 */
function maskLeakedEnvKeys(effectiveConfig, liveSettings) {
  const result = structuredClone(effectiveConfig);
  const liveEnv = liveSettings && liveSettings.env;
  if (!isPlainObject(liveEnv)) return result;

  const leaked = Object.keys(liveEnv).filter(
    (key) => !isPlainObject(result.env) || !Object.prototype.hasOwnProperty.call(result.env, key)
  );
  if (leaked.length === 0) return result;

  const maskedEnv = { ...(isPlainObject(result.env) ? result.env : {}) };
  for (const key of leaked) maskedEnv[key] = '';
  return { ...result, env: maskedEnv };
}

module.exports = { maskLeakedEnvKeys, userSettingsPath, readUserSettings };
