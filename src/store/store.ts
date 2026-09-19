// ---------------------------------------------------------------------------
// Store：模拟状态 + 撤销/重做历史 + localStorage 持久化（刷新恢复）。
// 与 React 通过 useSyncExternalStore 绑定；逻辑全部可单测。
// ---------------------------------------------------------------------------

import { applyAction, createSim, isDone } from '../sim/sim';
import type { SimAction, SimState } from '../sim/sim';
import { getScenario } from '../sim/scenarios';

export interface StoreState {
  sim: SimState;
  past: SimState[];
  future: SimState[];
  autoPlay: boolean;
  /** 本次会话是否从 localStorage 恢复而来（刷新恢复提示） */
  restored: boolean;
}

const STORAGE_KEY = 'draftrelay:v1';
const HISTORY_CAP = 300;
const PERSIST_TAIL = 80;

// ---------------------------------------------------------------------------
// 序列化（导出供测试做往返校验）
// ---------------------------------------------------------------------------

export interface PersistedShape {
  sim: SimState;
  past: SimState[];
  future: SimState[];
}

export function serializeStore(s: StoreState): string {
  const shape: PersistedShape = {
    sim: s.sim,
    past: s.past.slice(-PERSIST_TAIL),
    future: s.future.slice(0, PERSIST_TAIL),
  };
  return JSON.stringify(shape);
}

export function deserializeStore(json: string): PersistedShape | null {
  try {
    const data = JSON.parse(json) as PersistedShape;
    if (!data || typeof data !== 'object') return null;
    const sim = data.sim as SimState;
    if (!sim || !sim.server || !sim.clients || !sim.net || !Array.isArray(sim.log)) return null;
    return {
      sim,
      past: Array.isArray(data.past) ? data.past : [],
      future: Array.isArray(data.future) ? data.future : [],
    };
  } catch {
    return null;
  }
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store 本体
// ---------------------------------------------------------------------------

type Listener = () => void;

export class Store {
  private state: StoreState;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const restored = this.load();
    this.state = restored ?? {
      sim: createSim('ooo-acks'),
      past: [],
      future: [],
      autoPlay: false,
      restored: false,
    };
  }

  private load(): StoreState | null {
    if (!storageAvailable()) return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const shape = deserializeStore(raw);
    if (!shape) return null;
    return { ...shape, autoPlay: false, restored: true };
  }

  private persist(): void {
    if (!storageAvailable()) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeStore(this.state));
      } catch {
        // 存储满/隐私模式：静默降级，演练不受影响
      }
    }, 200);
  }

  getState = (): StoreState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.persist();
    for (const fn of this.listeners) fn();
  }

  private commit(next: SimState): void {
    const past = [...this.state.past, this.state.sim];
    if (past.length > HISTORY_CAP) past.shift();
    this.state = { ...this.state, sim: next, past, future: [] };
    this.emit();
  }

  /** 自由操作（编辑/断网/故障/重试…） */
  run = (action: SimAction): void => {
    this.commit(applyAction(this.state.sim, action));
  };

  /** 单步：场景脚本未走完 → 执行下一步；否则空转网络 1t。 */
  step = (): void => {
    const sim = this.state.sim;
    const scenario = getScenario(sim.scenarioId);
    if (sim.stepIndex < scenario.steps.length) {
      const { action } = scenario.steps[sim.stepIndex];
      const next = applyAction(sim, action);
      next.stepIndex = sim.stepIndex + 1;
      this.commit(next);
    } else {
      this.commit(applyAction(sim, { type: 'tick' }));
    }
    const after = this.state.sim;
    if (isDone(after, getScenario(after.scenarioId).steps.length) && this.state.autoPlay) {
      this.state = { ...this.state, autoPlay: false };
      this.emit();
    }
  };

  setAutoPlay = (on: boolean): void => {
    this.state = { ...this.state, autoPlay: on };
    this.emit();
  };

  undo = (): void => {
    const { past, future, sim } = this.state;
    if (past.length === 0) return;
    this.state = {
      ...this.state,
      sim: past[past.length - 1],
      past: past.slice(0, -1),
      future: [sim, ...future],
      autoPlay: false,
    };
    this.emit();
  };

  redo = (): void => {
    const { past, future, sim } = this.state;
    if (future.length === 0) return;
    this.state = {
      ...this.state,
      sim: future[0],
      past: [...past, sim],
      future: future.slice(1),
      autoPlay: false,
    };
    this.emit();
  };

  /** 重置当前场景（清空历史与存档） */
  reset = (): void => {
    this.state = {
      sim: createSim(this.state.sim.scenarioId),
      past: [],
      future: [],
      autoPlay: false,
      restored: false,
    };
    if (storageAvailable()) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  };

  loadScenario = (id: string): void => {
    this.state = {
      sim: createSim(id),
      past: [],
      future: [],
      autoPlay: false,
      restored: false,
    };
    this.emit();
  };
}

export const store = new Store();
