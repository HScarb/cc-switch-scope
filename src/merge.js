'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 对齐 cc-switch json_deep_merge（src-tauri/src/services/provider/live.rs:99）：
 * 对象↔对象逐键递归；叶子或类型不匹配时 source 覆盖。
 * 纯函数：不修改任何输入，返回新值。
 */
function deepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    const result = {};
    for (const [key, value] of Object.entries(target)) {
      result[key] = structuredClone(value);
    }
    for (const [key, sourceValue] of Object.entries(source)) {
      result[key] = Object.prototype.hasOwnProperty.call(result, key)
        ? deepMerge(result[key], sourceValue)
        : structuredClone(sourceValue);
    }
    return result;
  }
  return structuredClone(source);
}

/**
 * 设计 §6：commonConfigEnabled 且通用配置非空 → deepMerge(provider, common)，
 * 叶子冲突通用配置获胜；否则返回供应商配置的拷贝。
 */
function buildEffectiveConfig(providerConfig, commonConfig, commonConfigEnabled) {
  const commonIsEmpty =
    !isPlainObject(commonConfig) || Object.keys(commonConfig).length === 0;
  if (!commonConfigEnabled || commonIsEmpty) {
    return structuredClone(providerConfig);
  }
  return deepMerge(providerConfig, commonConfig);
}

module.exports = { deepMerge, buildEffectiveConfig, isPlainObject };
