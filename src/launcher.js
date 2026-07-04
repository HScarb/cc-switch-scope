'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 组装 spawn 规格（纯函数，设计 §7）。
 * Windows：spawn 'claude'（不带扩展名）+ shell:true —— Node 18.20+ 强制 .cmd 走 shell，
 * cmd.exe 按 PATHEXT 同时覆盖 npm 的 claude.cmd 与原生安装器的 claude.exe。
 * shell:true 下 Node 不做引号处理：含空白的参数显式加双引号；
 * 透传参数含双引号直接报错（cmd.exe 转义不可靠，宁可拒绝也不注入）。
 */
function buildSpawnSpec({ platform, settingsPath, noSkip = false, extraArgs = [] }) {
  const baseArgs = ['--settings', settingsPath];
  if (!noSkip) baseArgs.push('--dangerously-skip-permissions');
  baseArgs.push(...extraArgs);

  if (platform !== 'win32') {
    return { cmd: 'claude', args: baseArgs, options: { stdio: 'inherit' } };
  }

  for (const arg of extraArgs) {
    if (arg.includes('"')) {
      throw new Error(`Windows 下透传给 claude 的参数不能包含双引号: ${arg}`);
    }
  }
  const quoted = baseArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return { cmd: 'claude', args: quoted, options: { stdio: 'inherit', shell: true } };
}

/**
 * 合并结果写入临时文件 → spawn claude → 退出后清理临时文件并透传退出码。
 * ENOENT 单独提示未安装 Claude Code CLI。
 */
function launch(provider, effectiveConfig, { noSkip = false, extraArgs = [] } = {}) {
  const settingsPath = path.join(
    os.tmpdir(),
    `ccscope-${crypto.randomBytes(6).toString('hex')}.json`
  );
  // 先组装（win32 参数校验可能 throw），再落盘，避免残留孤儿临时文件
  const spec = buildSpawnSpec({
    platform: process.platform, settingsPath, noSkip, extraArgs,
  });
  fs.writeFileSync(settingsPath, JSON.stringify(effectiveConfig));

  console.log(`→ Launching [${provider.name}]`);

  return new Promise((resolve) => {
    // shell:true 时 Node 会把 args 拼进命令行交给 cmd.exe，但传 args 数组会触发 DEP0190；
    // 自己拼成单条命令字符串（buildSpawnSpec 已保证引号），绕开该告警，行为不变
    const child = spec.options.shell
      ? spawn([spec.cmd, ...spec.args].join(' '), spec.options)
      : spawn(spec.cmd, spec.args, spec.options);
    const finish = (code) => {
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* 清理尽力而为 */
      }
      resolve(code);
    };
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(
          '未找到 claude 命令。请先安装 Claude Code CLI：npm i -g @anthropic-ai/claude-code'
        );
      } else {
        console.error(`启动 claude 失败: ${err.message}`);
      }
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 0));
  });
}

module.exports = { launch, buildSpawnSpec };
