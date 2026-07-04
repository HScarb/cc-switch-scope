'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deepMerge, buildEffectiveConfig, isPlainObject } = require('../src/merge');

test('isPlainObject 基本判定', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});

// 对齐 cc-switch json_deep_merge（live.rs）：对象递归、叶子/类型不匹配 source 覆盖
const mergeCases = [
  {
    name: '不相交的键合并',
    target: { a: 1 }, source: { b: 2 },
    expected: { a: 1, b: 2 },
  },
  {
    name: '嵌套对象逐键递归',
    target: { env: { A: '1', B: '2' } }, source: { env: { B: '3', C: '4' } },
    expected: { env: { A: '1', B: '3', C: '4' } },
  },
  {
    name: '叶子冲突时 source（通用配置）获胜',
    target: { model: 'a' }, source: { model: 'b' },
    expected: { model: 'b' },
  },
  {
    name: '类型不匹配时 source 整体覆盖',
    target: { permissions: { allow: [] } }, source: { permissions: 'deny' },
    expected: { permissions: 'deny' },
  },
  {
    name: '数组整体覆盖（不做元素级合并）',
    target: { hooks: [1, 2] }, source: { hooks: [3] },
    expected: { hooks: [3] },
  },
  {
    name: '空 source 不改变 target',
    target: { a: 1 }, source: {},
    expected: { a: 1 },
  },
];

for (const c of mergeCases) {
  test(`deepMerge: ${c.name}`, () => {
    assert.deepEqual(deepMerge(c.target, c.source), c.expected);
  });
}

test('deepMerge 不修改任何输入（不可变）', () => {
  const target = { env: { A: '1' } };
  const source = { env: { A: '2' } };
  deepMerge(target, source);
  assert.deepEqual(target, { env: { A: '1' } });
  assert.deepEqual(source, { env: { A: '2' } });
});

test('buildEffectiveConfig: 启用且通用配置非空时合并', () => {
  const result = buildEffectiveConfig({ env: { A: '1' } }, { env: { B: '2' } }, true);
  assert.deepEqual(result, { env: { A: '1', B: '2' } });
});

test('buildEffectiveConfig: commonConfigEnabled=false 时返回原配置拷贝', () => {
  const provider = { env: { A: '1' } };
  const result = buildEffectiveConfig(provider, { env: { B: '2' } }, false);
  assert.deepEqual(result, provider);
  assert.notEqual(result, provider); // 是拷贝而非同一引用
});

test('buildEffectiveConfig: 通用配置为空对象时跳过合并', () => {
  const result = buildEffectiveConfig({ env: { A: '1' } }, {}, true);
  assert.deepEqual(result, { env: { A: '1' } });
});
