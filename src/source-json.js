'use strict';

const { isPlainObject } = require('./merge');

/**
 * 排序对齐 SQLite `ORDER BY is_current DESC, sort_index ASC, name ASC`：
 * sortIndex 为 undefined/null 时视同 NULL 排最前；name 按码位比较（非 locale）。
 */
function compareProviders(a, b) {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const ai = a.sortIndex ?? null;
  const bi = b.sortIndex ?? null;
  if (ai !== bi) {
    if (ai === null) return -1;
    if (bi === null) return 1;
    return ai - bi;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 解析老版 config.json（v2），输出统一领域模型（设计 §5.2） */
function parseConfigJson(content, filePath) {
  let root;
  try {
    root = JSON.parse(content);
  } catch (err) {
    throw new Error(`无法解析 ${filePath}: ${err.message}`);
  }
  if (!isPlainObject(root)) {
    throw new Error(`配置文件格式异常（顶层不是 JSON 对象）: ${filePath}`);
  }

  // v1 检测对齐 app_config.rs：providers 为对象 + current 为字符串 + 无 apps 键
  const isV1 =
    isPlainObject(root.providers) &&
    typeof root.current === 'string' &&
    !('apps' in root);
  if (isV1) {
    throw new Error(
      `检测到旧版 v1 配置格式（${filePath}），ccscope 不支持。\n` +
        '请安装 cc-switch v3.2.x 完成一次性自动迁移，或手动将顶层调整为 v2 结构。'
    );
  }

  const warnings = [];
  const claude = isPlainObject(root.claude) ? root.claude : {};
  const providersMap = isPlainObject(claude.providers) ? claude.providers : {};
  const current = typeof claude.current === 'string' ? claude.current : '';

  const providers = Object.entries(providersMap)
    .map(([id, p]) => {
      // 供应商条目非对象时（null、string 等）归一化为 {}
      if (!isPlainObject(p)) {
        p = {};
      }
      return {
        name: typeof p.name === 'string' && p.name !== '' ? p.name : id,
        config: isPlainObject(p.settingsConfig) ? p.settingsConfig : { env: {} },
        commonConfigEnabled: p.meta?.commonConfigEnabled === true,
        isCurrent: id === current,
        sortIndex: typeof p.sortIndex === 'number' ? p.sortIndex : undefined,
      };
    })
    .sort(compareProviders);

  // 通用配置：common_config_snippets.claude 优先，回退旧字段；值是 JSON 字符串需二次 parse
  let commonConfig = {};
  const snippet =
    root.common_config_snippets?.claude ?? root.claude_common_config_snippet;
  if (typeof snippet === 'string' && snippet.trim() !== '') {
    try {
      const parsed = JSON.parse(snippet);
      if (isPlainObject(parsed)) commonConfig = parsed;
    } catch (err) {
      warnings.push(`通用配置片段解析失败，按空处理（${filePath}）: ${err.message}`);
    }
  }

  return { providers, commonConfig, warnings };
}

module.exports = { parseConfigJson, compareProviders };
