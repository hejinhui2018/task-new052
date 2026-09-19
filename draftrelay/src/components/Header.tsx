import { useState } from 'react';
import { SCENARIOS } from '../engine/scenarios';
import { syncStatus } from '../engine/core';
import type { SimStore } from '../store';

export function Header({ sim }: { sim: SimStore }) {
  const { state, dispatch, playing, setPlaying, speed, setSpeed, undo, redo, canUndo, canRedo, reset } = sim;
  const [scriptName, setScriptName] = useState('');

  const runScript = () => {
    if (!scriptName) return;
    dispatch({ type: 'loadScript', name: scriptName });
    setPlaying(true);
  };

  const a = syncStatus(state.clients.A, state.server);
  const b = syncStatus(state.clients.B, state.server);

  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          DraftRelay
          <span className="brand-sub">离线草稿同步演练台</span>
        </div>
        <div className="controls">
          <select
            className="select"
            value={scriptName}
            onChange={(e) => setScriptName(e.target.value)}
            title="选择预置演练脚本"
          >
            <option value="">选择演练脚本…</option>
            {Object.entries(SCENARIOS).map(([key, sc]) => (
              <option key={key} value={key}>
                {sc.label}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={runScript} disabled={!scriptName}>
            运行脚本
          </button>
          <span className="sep" />
          <button className="btn" onClick={undo} disabled={!canUndo} title="回退一拍（时间旅行）">
            ↩ 撤销
          </button>
          <button className="btn" onClick={redo} disabled={!canRedo}>
            重做 ↪
          </button>
          <span className="sep" />
          <button className="btn" onClick={() => dispatch({ type: 'tick' })} disabled={playing}>
            单步 ⏭
          </button>
          {playing ? (
            <button className="btn warn" onClick={() => setPlaying(false)}>
              ⏸ 暂停
            </button>
          ) : (
            <button className="btn primary" onClick={() => setPlaying(true)}>
              ▶ 自动播放
            </button>
          )}
          <select
            className="select narrow"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            title="播放速度"
          >
            <option value={200}>快 0.2s</option>
            <option value={500}>中 0.5s</option>
            <option value={1000}>慢 1.0s</option>
          </select>
          <span className="sep" />
          <button className="btn danger" onClick={reset} title="清空本地存储并回到初始状态">
            重置
          </button>
        </div>
      </div>
      <div className="topbar-row status-row">
        <span className="chip mono">t = {state.time}</span>
        <span className="chip mono">服务端 v{state.server.version}</span>
        <span className={`chip badge-${a.cls}`}>A：{a.text}</span>
        <span className={`chip badge-${b.cls}`}>B：{b.text}</span>
        {state.script && (
          <span className="chip chip-script">脚本：{SCENARIOS[state.script.name]?.label ?? state.script.name}</span>
        )}
        <span className="hint">状态已持久化到 localStorage，刷新页面可从断点恢复演练</span>
      </div>
    </header>
  );
}
