'use strict';

const readline = require('node:readline');

/** 纯状态机：不修改输入，返回新状态（供单测） */
function reduceKey(state, keyName) {
  const { index, count } = state;
  switch (keyName) {
    case 'up':
      return { ...state, index: (index - 1 + count) % count };
    case 'down':
      return { ...state, index: (index + 1) % count };
    case 'enter':
      return { ...state, done: true };
    case 'escape':
    case 'ctrl-c':
      return { ...state, cancelled: true };
    default:
      return state;
  }
}

function render(output, providers, index, first) {
  if (!first) output.write(`\x1b[${providers.length}A`); // 光标上移重绘
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const line = `${p.name}${p.isCurrent ? ' (current)' : ''}`;
    output.write(
      i === index ? `\x1b[36m❯ ${line}\x1b[0m\x1b[K\n` : `  ${line}\x1b[K\n`
    );
  }
}

/**
 * 交互选择供应商：↑/↓ 移动、回车确认、Esc/Ctrl-C 取消（返回 null）。
 * 默认高亮 current 项（设计 §8）。
 */
function selectProvider(providers, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const initial = Math.max(0, providers.findIndex((p) => p.isCurrent));
    let state = { index: initial, count: providers.length, done: false, cancelled: false };

    output.write('选择供应商（↑/↓ 移动，回车确认，Esc 取消）:\n');
    render(output, providers, state.index, true);

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    if (input.isTTY) input.setRawMode(true);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const onKeypress = (_str, key = {}) => {
      const name =
        key.ctrl && key.name === 'c' ? 'ctrl-c'
        : key.name === 'return' ? 'enter'
        : key.name; // 'up' | 'down' | 'escape' | 其他
      state = reduceKey(state, name);
      if (state.done || state.cancelled) {
        cleanup();
        resolve(state.cancelled ? null : providers[state.index]);
        return;
      }
      render(output, providers, state.index, false);
    };

    input.on('keypress', onKeypress);
  });
}

module.exports = { selectProvider, reduceKey };
