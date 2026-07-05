'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { reduceKey, computeTop } = require('../src/menu');

const s = (index, count = 3) => ({ index, count, done: false, cancelled: false });

test('up/down 移动并环绕', () => {
  assert.equal(reduceKey(s(1), 'up').index, 0);
  assert.equal(reduceKey(s(0), 'up').index, 2);      // 顶部环绕到底部
  assert.equal(reduceKey(s(1), 'down').index, 2);
  assert.equal(reduceKey(s(2), 'down').index, 0);    // 底部环绕到顶部
});

test('enter 结束选择', () => {
  const next = reduceKey(s(1), 'enter');
  assert.equal(next.done, true);
  assert.equal(next.index, 1);
});

test('escape / ctrl-c 取消', () => {
  assert.equal(reduceKey(s(0), 'escape').cancelled, true);
  assert.equal(reduceKey(s(0), 'ctrl-c').cancelled, true);
});

test('未知按键不改变状态', () => {
  assert.deepEqual(reduceKey(s(1), 'x'), s(1));
});

test('reduceKey 不修改输入状态（不可变）', () => {
  const state = s(1);
  reduceKey(state, 'down');
  assert.deepEqual(state, s(1));
});

test('j/k 等同 down/up（含环绕）', () => {
  assert.equal(reduceKey(s(1), 'j').index, 2);
  assert.equal(reduceKey(s(2), 'j').index, 0);
  assert.equal(reduceKey(s(1), 'k').index, 0);
  assert.equal(reduceKey(s(0), 'k').index, 2);
});

test('home/end 跳到首尾', () => {
  assert.equal(reduceKey(s(2), 'home').index, 0);
  assert.equal(reduceKey(s(0), 'end').index, 2);
});

test('数字键直选并确认，超出条目数则忽略', () => {
  const next = reduceKey(s(0), '3');
  assert.equal(next.index, 2);
  assert.equal(next.done, true);
  assert.deepEqual(reduceKey(s(0), '4'), s(0)); // count=3，'4' 无效
  assert.deepEqual(reduceKey(s(0, 12), '9'), { ...s(0, 12), index: 8, done: true });
});

test('computeTop: index 始终落在视口内且不越界', () => {
  // count=10, viewport=4
  assert.equal(computeTop(0, 0, 4, 10), 0);
  assert.equal(computeTop(0, 3, 4, 10), 0);   // 视口内不动
  assert.equal(computeTop(0, 4, 4, 10), 1);   // 向下越界推进 top
  assert.equal(computeTop(3, 2, 4, 10), 2);   // 向上越界回退 top
  assert.equal(computeTop(0, 9, 4, 10), 6);   // 跳到末尾（环绕）
  assert.equal(computeTop(6, 0, 4, 10), 0);   // 跳回开头（环绕）
  assert.equal(computeTop(9, 9, 4, 10), 6);   // top 钳制在 count-viewport
  assert.equal(computeTop(0, 2, 5, 3), 0);    // viewport ≥ count 时恒为 0
});
