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

test('Windows：resolved exe 时直接 spawn，不走 shell、参数原样', () => {
  const spec = buildSpawnSpec({
    platform: 'win32',
    settingsPath: 'C:\\Users\\A B\\Temp\\x.json',
    extraArgs: ['-r', 'two words'],
    resolved: { kind: 'exe', path: 'C:\\bin\\claude.exe' },
  });
  assert.equal(spec.cmd, 'C:\\bin\\claude.exe');
  assert.equal(spec.options.shell, undefined);
  assert.deepEqual(spec.args, [
    '--settings', 'C:\\Users\\A B\\Temp\\x.json',
    '--dangerously-skip-permissions', '-r', 'two words',
  ]);
});

test('Windows：resolved node-script 时以 node 执行脚本', () => {
  const spec = buildSpawnSpec({
    platform: 'win32', settingsPath: 'C:\\t\\x.json',
    resolved: { kind: 'node-script', path: 'C:\\bin\\cli.js' },
  });
  assert.equal(spec.cmd, process.execPath);
  assert.deepEqual(spec.args, ['C:\\bin\\cli.js', '--settings', 'C:\\t\\x.json', '--dangerously-skip-permissions']);
  assert.equal(spec.options.shell, undefined);
});

test('Windows：resolved 直接 spawn 时透传参数允许含双引号（无 cmd.exe 解析）', () => {
  const spec = buildSpawnSpec({
    platform: 'win32', settingsPath: 'C:\\t\\x.json', extraArgs: ['say "hi"'],
    resolved: { kind: 'exe', path: 'C:\\bin\\claude.exe' },
  });
  assert.deepEqual(spec.args.at(-1), 'say "hi"');
});

test('stdio 一律 inherit', () => {
  assert.equal(buildSpawnSpec({ platform: 'linux', settingsPath: '/t/x.json' }).options.stdio, 'inherit');
  assert.equal(buildSpawnSpec({ platform: 'win32', settingsPath: 'C:\\t\\x.json' }).options.stdio, 'inherit');
});
