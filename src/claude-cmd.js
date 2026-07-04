'use strict';

// 本模块只处理 Windows 路径语义，显式用 win32 使测试结果与宿主 OS 无关
const path = require('node:path').win32;

/**
 * 从 npm 的 .cmd 垫片文本中提取 %dp0% 相对的真实目标（.exe 或 .js）。
 * 取最后一次匹配：js 垫片模板的前置 `IF EXIST "%dp0%\node.exe"` 检查行
 * 也符合模式，但真正被执行的调用行总在最后。解析不出返回 null。
 */
function parseCmdShim(content, cmdDir) {
  const matches = [...content.matchAll(/"%dp0%\\?([^"]+?\.(exe|js))"/gi)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return {
    kind: m[2].toLowerCase() === 'exe' ? 'exe' : 'node-script',
    path: path.join(cmdDir, m[1]),
  };
}

/**
 * 在 PATH 中解析 claude 的真实可执行目标（仅 win32 使用，IO 注入）。
 * 动机：npm 装的 claude 是 .cmd 批处理垫片，经 cmd.exe 运行时 Ctrl+C 会弹
 * 「终止批处理操作吗(Y/N)?」。直接 spawn 垫片背后的 .exe（或 node+cli.js）
 * 可绕过 cmd.exe，退出体验干净。解析失败返回 null，调用方回退 shell 模式。
 */
function resolveClaudeCommand({ env, existsSync, readFileSync }) {
  const dirs = (env.PATH || env.Path || env.path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return { kind: 'exe', path: exe };
    const cmd = path.join(dir, 'claude.cmd');
    if (existsSync(cmd)) {
      // 命中首个含 claude 的 PATH 目录后即定论（对齐 Windows 命令解析顺序）
      try {
        const resolved = parseCmdShim(readFileSync(cmd, 'utf8'), dir);
        if (resolved && existsSync(resolved.path)) return resolved;
      } catch {
        /* 垫片读取失败按未解析处理 */
      }
      return null;
    }
  }
  return null;
}

module.exports = { resolveClaudeCommand, parseCmdShim };
