// ---------------------------------------------------------------------------
// React 状态仓库：模拟状态 + 撤销/重做（时间旅行）+ 自动播放 + 持久化
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimAction, SimState } from './engine/types';
import { DEFAULT_SEED, initialSim, reduce } from './engine/sim';
import { clearPersisted, loadPersisted, persist } from './engine/persistence';

const HISTORY_CAP = 150;

export interface SimStore {
  state: SimState;
  dispatch: (action: SimAction) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speed: number;
  setSpeed: (ms: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: () => void;
}

export function useSimStore(): SimStore {
  const [state, setState] = useState<SimState>(() => loadPersisted() ?? initialSim(DEFAULT_SEED));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(500);
  // past/future 用 ref 存放（不需要触发渲染），histTick 仅用于让按钮禁用态刷新
  const past = useRef<SimState[]>([]);
  const future = useRef<SimState[]>([]);
  const [, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((n) => n + 1);

  const dispatch = useCallback((action: SimAction) => {
    setState((prev) => {
      const next = reduce(prev, action);
      past.current.push(prev);
      if (past.current.length > HISTORY_CAP) past.current.shift();
      future.current = [];
      return next;
    });
    bumpHist();
  }, []);

  const undo = useCallback(() => {
    setPlaying(false);
    setState((prev) => {
      const target = past.current.pop();
      if (!target) return prev;
      future.current.push(prev);
      return target;
    });
    bumpHist();
  }, []);

  const redo = useCallback(() => {
    setPlaying(false);
    setState((prev) => {
      const target = future.current.pop();
      if (!target) return prev;
      past.current.push(prev);
      return target;
    });
    bumpHist();
  }, []);

  const reset = useCallback(() => {
    setPlaying(false);
    past.current = [];
    future.current = [];
    clearPersisted();
    setState(initialSim(DEFAULT_SEED));
    bumpHist();
  }, []);

  // 刷新恢复：每次状态变化后落盘
  useEffect(() => {
    persist(state);
  }, [state]);

  // 自动播放
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => dispatch({ type: 'tick' }), speed);
    return () => clearInterval(id);
  }, [playing, speed, dispatch]);

  return {
    state,
    dispatch,
    playing,
    setPlaying,
    speed,
    setSpeed,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    reset,
  };
}
