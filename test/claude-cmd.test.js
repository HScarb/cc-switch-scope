'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path').win32;
const { resolveClaudeCommand, parseCmdShim } = require('../src/claude-cmd');

const BIN = 'C:\\nodejs\\bin';
const NPM_EXE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
  ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');
// npm cmd-shim 对 js 入口的真实模板：IF EXIST "%dp0%\node.exe" 检查行在调用行之前
const NPM_JS_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
  ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

function fakeIo({ existing = [], files = {} } = {}) {
  const existSet = new Set([...existing, ...Object.keys(files)]);
  return {
    existsSync: (p) => existSet.has(p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

test('parseCmdShim: npm 垫片指向 exe', () => {
  const r = parseCmdShim(NPM_EXE_SHIM, BIN);
  assert.deepEqual(r, {
    kind: 'exe',
    path: path.join(BIN, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  });
});

test('parseCmdShim: js 垫片取真正调用行的 cli.js，不被前置 IF EXIST node.exe 检查行误导', () => {
  const r = parseCmdShim(NPM_JS_SHIM, BIN);
  assert.equal(r.kind, 'node-script');
  assert.equal(r.path, path.join(BIN, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
});

test('parseCmdShim: 无 %dp0% 目标时返回 null', () => {
  assert.equal(parseCmdShim('@ECHO off\r\nclaude-real %*', BIN), null);
});

test('resolveClaudeCommand: PATH 目录中 claude.exe 直接命中', () => {
  const exe = path.join(BIN, 'claude.exe');
  const r = resolveClaudeCommand({
    env: { PATH: `C:\\other${path.delimiter}${BIN}` },
    ...fakeIo({ existing: [exe] }),
  });
  assert.deepEqual(r, { kind: 'exe', path: exe });
});

test('resolveClaudeCommand: claude.cmd 垫片解析出真实 exe 且存在', () => {
  const cmd = path.join(BIN, 'claude.cmd');
  const target = path.join(BIN, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const r = resolveClaudeCommand({
    env: { PATH: BIN },
    ...fakeIo({ existing: [target], files: { [cmd]: NPM_EXE_SHIM } }),
  });
  assert.deepEqual(r, { kind: 'exe', path: target });
});

test('resolveClaudeCommand: 垫片目标文件不存在 → null（回退 shell）', () => {
  const cmd = path.join(BIN, 'claude.cmd');
  const r = resolveClaudeCommand({
    env: { PATH: BIN },
    ...fakeIo({ files: { [cmd]: NPM_EXE_SHIM } }),
  });
  assert.equal(r, null);
});

test('resolveClaudeCommand: 垫片解析不出 → null；PATH 无 claude → null', () => {
  const cmd = path.join(BIN, 'claude.cmd');
  const unparseable = resolveClaudeCommand({
    env: { PATH: BIN },
    ...fakeIo({ files: { [cmd]: '@ECHO off\r\nsomething-else %*' } }),
  });
  assert.equal(unparseable, null);
  assert.equal(resolveClaudeCommand({ env: { PATH: BIN }, ...fakeIo() }), null);
});

test('resolveClaudeCommand: 首个含 claude 的 PATH 目录即定论，不再扫描后续目录', () => {
  const firstCmd = path.join(BIN, 'claude.cmd');
  const laterExe = path.join('C:\\later', 'claude.exe');
  const r = resolveClaudeCommand({
    env: { PATH: `${BIN}${path.delimiter}C:\\later` },
    ...fakeIo({ existing: [laterExe], files: { [firstCmd]: '@ECHO off\r\nsomething-else %*' } }),
  });
  assert.equal(r, null); // 首目录 cmd 解析失败 → 定论回退 shell，与 Windows 解析顺序一致
});

test('resolveClaudeCommand: 同目录 exe 优先于 cmd；env.Path 大小写兼容', () => {
  const exe = path.join(BIN, 'claude.exe');
  const cmd = path.join(BIN, 'claude.cmd');
  const r = resolveClaudeCommand({
    env: { Path: BIN },
    ...fakeIo({ existing: [exe], files: { [cmd]: NPM_EXE_SHIM } }),
  });
  assert.deepEqual(r, { kind: 'exe', path: exe });
});
