import { store } from '../store/store';
import { SCENARIOS } from '../sim/scenarios';
import type { Scenario } from '../sim/scenarios';
import type { SimState } from '../sim/sim';

interface Props {
  scenario: Scenario;
  sim: SimState;
  autoPlay: boolean;
  done: boolean;
  canUndo: boolean;
  canRedo: boolean;
  restored: boolean;
}

export function TopBar({ scenario, sim, autoPlay, done, canUndo, canRedo, restored }: Props) {
  const total = scenario.steps.length;
  const nextLabel = sim.stepIndex < total ? scenario.steps[sim.stepIndex].label : null;

  return (
    <header className="topbar">
      <div className="brand">
        <h1>DraftRelay</h1>
        <span className="subtitle">离线草稿同步演练台</span>
      </div>

      <label className="scenario-picker">
        演练场景
        <select value={sim.scenarioId} onChange={(e) => store.loadScenario(e.target.value)}>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>

      <div className="controls">
        <button onClick={() => store.undo()} disabled={!canUndo} title="撤销上一步">
          ↩ 撤销
        </button>
        <button onClick={() => store.redo()} disabled={!canRedo} title="重做">
          ↪ 重做
        </button>
        <span className="sep" />
        <button className="primary" onClick={() => store.step()} disabled={autoPlay}>
          单步 ▶
        </button>
        {autoPlay ? (
          <button onClick={() => store.setAutoPlay(false)}>暂停 ⏸</button>
        ) : (
          <button onClick={() => store.setAutoPlay(true)} disabled={done}>
            自动播放 ⏵
          </button>
        )}
        <button onClick={() => store.reset()} title="重置当前场景并清空存档">
          重置 ⟲
        </button>
      </div>

      <div className="status-cluster">
        <span className="tick" title="模拟时钟">
          t={sim.tick}
        </span>
        {total > 0 && (
          <span className={`step-badge ${done ? 'done' : ''}`}>
            步骤 {Math.min(sim.stepIndex, total)}/{total}
            {done ? ' · 已完成' : ''}
          </span>
        )}
        {restored && <span className="restored" title="状态已从 localStorage 恢复">已从本地恢复</span>}
      </div>

      {nextLabel && <div className="next-step">下一步：{nextLabel}</div>}
    </header>
  );
}
