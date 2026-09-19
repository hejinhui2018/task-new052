// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// UI 冒烟测试：应用真实挂载、单步推进、撤销可用。
// ---------------------------------------------------------------------------

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('应用冒烟', () => {
  it('渲染主要面板，单步与撤销生效', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(<App />);
    });

    // 主要面板就位
    for (const text of ['DraftRelay', '客户端 A', '客户端 B', '服务端（权威）', '网络', '事件时间线', '待确认队列']) {
      expect(el.textContent).toContain(text);
    }
    expect(el.textContent).toContain('步骤 0/6');

    // 单步：执行场景第一步（A 更新 b2）
    const stepBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('单步'))!;
    await act(async () => click(stepBtn));
    expect(el.textContent).toContain('步骤 1/6');
    expect(el.textContent).toContain('A-1');
    expect(el.textContent).toContain('待确认');

    // 撤销：回到步骤 0
    const undoBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('撤销'))!;
    await act(async () => click(undoBtn));
    expect(el.textContent).toContain('步骤 0/6');

    // 切换网络：A 离线徽章出现
    const linkBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('A⇄S'))!;
    await act(async () => click(linkBtn));
    expect(el.textContent).toContain('离线');
  });
});
