'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { reduceKey } = require('../src/menu');

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
