'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildSpawnSpec } = require('../src/launcher');

test('非 Windows：claude 不走 shell，参数原样', () => {
  const spec = buildSpawnSpec({
    platform: 'linux', settingsPath: '/tmp/x.json', extraArgs: ['-r', 'has space'],
  });
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.options.shell, undefined);
  assert.deepEqual(spec.args, [
    '--settings', '/tmp/x.json', '--dangerously-skip-permissions', '-r', 'has space',
  ]);
});

test('noSkip 时不加 --dangerously-skip-permissions', () => {
  const spec = buildSpawnSpec({ platform: 'linux', settingsPath: '/tmp/x.json', noSkip: true });
  assert.equal(spec.args.includes('--dangerously-skip-permissions'), false);
});

test('Windows：claude（不带扩展名）+ shell:true，含空白参数加双引号', () => {
  const spec = buildSpawnSpec({
    platform: 'win32',
    settingsPath: 'C:\\Users\\A B\\Temp\\x.json', // 用户名带空格
    extraArgs: ['-r', 'two words'],
  });
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.options.shell, true);
  assert.deepEqual(spec.args, [
    '--settings', '"C:\\Users\\A B\\Temp\\x.json"',
    '--dangerously-skip-permissions', '-r', '"two words"',
  ]);
});

test('Windows：透传参数含双引号时明确报错拒绝', () => {
  assert.throws(
    () => buildSpawnSpec({
      platform: 'win32', settingsPath: 'C:\\t\\x.json', extraArgs: ['say "hi"'],
    }),
    /双引号/
  );
});

test('stdio 一律 inherit', () => {
  assert.equal(buildSpawnSpec({ platform: 'linux', settingsPath: '/t/x.json' }).options.stdio, 'inherit');
  assert.equal(buildSpawnSpec({ platform: 'win32', settingsPath: 'C:\\t\\x.json' }).options.stdio, 'inherit');
});
