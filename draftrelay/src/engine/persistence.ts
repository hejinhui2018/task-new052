// ---------------------------------------------------------------------------
// 刷新恢复：整个模拟状态可 JSON 序列化，每次变更后持久化到 localStorage
// ---------------------------------------------------------------------------

import type { SimState } from './types';

const KEY = 'draftrelay:v1';

export function loadPersisted(): SimState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SimState;
    if (!s || typeof s.time !== 'number' || !s.server || !s.clients || !Array.isArray(s.inFlight)) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function persist(state: SimState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 存储满 / 隐私模式：静默失败，不影响演练
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
