'use strict';

const readline = require('node:readline');

/** 纯状态机：不修改输入，返回新状态（供单测） */
function reduceKey(state, keyName) {
  const { index, count } = state;
  switch (keyName) {
    case 'up':
    case 'k':
      return { ...state, index: (index - 1 + count) % count };
    case 'down':
    case 'j':
      return { ...state, index: (index + 1) % count };
    case 'home':
      return { ...state, index: 0 };
    case 'end':
      return { ...state, index: count - 1 };
    case 'enter':
      return { ...state, done: true };
    case 'escape':
    case 'ctrl-c':
      return { ...state, cancelled: true };
    default: {
      // 数字键 1-9：直选对应项并确认；超出条目数则忽略
      if (/^[1-9]$/.test(keyName) && Number(keyName) <= count) {
        return { ...state, index: Number(keyName) - 1, done: true };
      }
      return state;
    }
  }
}

/** 滚动视口：调整 top 使 index 落在 [top, top+viewport) 内（纯函数，供单测） */
function computeTop(top, index, viewport, count) {
  const maxTop = Math.max(0, count - viewport);
  let next = top;
  if (index < next) next = index;
  if (index >= next + viewport) next = index - viewport + 1;
  return Math.min(Math.max(0, next), maxTop);
}

/**
 * 重绘固定 blockHeight 行：viewport 个条目行 + 滚动时 1 行位置提示。
 * 行数恒定保证 `\x1b[NA` 上移重绘不会错位。
 */
function render(output, providers, index, top, viewport, first) {
  const scrolled = providers.length > viewport;
  const blockHeight = viewport + (scrolled ? 1 : 0);
  if (!first) output.write(`\x1b[${blockHeight}A`); // 光标上移重绘
  for (let i = top; i < top + viewport; i++) {
    const p = providers[i];
    const num = i < 9 ? `${i + 1}.` : '  ';
    const line = `${num} ${p.name}${p.isCurrent ? ' (current)' : ''}`;
    output.write(
      i === index ? `\x1b[36m❯ ${line}\x1b[0m\x1b[K\n` : `  ${line}\x1b[K\n`
    );
  }
  if (scrolled) {
    output.write(`\x1b[2m  … ${index + 1}/${providers.length}\x1b[0m\x1b[K\n`);
  }
}

/**
 * 交互选择供应商：↑/↓/j/k 移动、数字 1-9 直选、Home/End 首尾、
 * 回车确认、Esc/Ctrl-C 取消（返回 null）。默认高亮 current 项（设计 §8）。
 * 条目超出终端高度时按视口滚动；退出时清除菜单并恢复光标。
 */
function selectProvider(providers, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const initial = Math.max(0, providers.findIndex((p) => p.isCurrent));
    let state = { index: initial, count: providers.length, done: false, cancelled: false };
    // 预留标题行 + 位置提示行 + 1 行余量，避免重绘上移越过屏幕顶端
    const maxVisible = Math.max(3, (output.rows || 24) - 3);
    const viewport = Math.min(providers.length, maxVisible);
    const scrolled = providers.length > viewport;
    const blockHeight = viewport + (scrolled ? 1 : 0);
    let top = computeTop(0, state.index, viewport, providers.length);

    output.write('\x1b[?25l'); // 选择期间隐藏光标
    output.write('选择供应商（↑/↓ 移动，数字直选，回车确认，Esc 取消）:\n');
    render(output, providers, state.index, top, viewport, true);

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    if (input.isTTY) input.setRawMode(true);

    // 兜底：菜单打开期间进程被外部信号终止时，恢复光标与终端模式
    const restoreTerminal = () => {
      if (input.isTTY) input.setRawMode(wasRaw);
      output.write('\x1b[?25h');
    };
    process.once('exit', restoreTerminal);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      process.removeListener('exit', restoreTerminal);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
      // 清除整个菜单块（含标题行）并恢复光标，避免残留干扰后续输出
      output.write(`\x1b[${blockHeight + 1}A\x1b[0J\x1b[?25h`);
    };

    const onKeypress = (str, key = {}) => {
      const name =
        key.ctrl && key.name === 'c' ? 'ctrl-c'
        : key.name === 'return' ? 'enter'
        : typeof str === 'string' && /^[1-9]$/.test(str) ? str
        : key.name; // 'up' | 'down' | 'home' | 'end' | 'escape' | 'j' | 'k' | 其他
      state = reduceKey(state, name);
      if (state.done || state.cancelled) {
        cleanup();
        resolve(state.cancelled ? null : providers[state.index]);
        return;
      }
      top = computeTop(top, state.index, viewport, providers.length);
      render(output, providers, state.index, top, viewport, false);
    };

    input.on('keypress', onKeypress);
  });
}

module.exports = { selectProvider, reduceKey, computeTop };
