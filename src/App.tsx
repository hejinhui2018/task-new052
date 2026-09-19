import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { store } from './store/store';
import { getScenario } from './sim/scenarios';
import { isDone } from './sim/sim';
import { TopBar } from './ui/TopBar';
import { ClientPanel } from './ui/ClientPanel';
import { ServerPanel } from './ui/ServerPanel';
import { NetworkPanel } from './ui/NetworkPanel';
import { Timeline } from './ui/Timeline';

const AUTOPLAY_MS = 750;

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { sim, autoPlay, past, future, restored } = state;
  const scenario = getScenario(sim.scenarioId);
  const done = isDone(sim, scenario.steps.length);

  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(() => store.step(), AUTOPLAY_MS);
    return () => clearInterval(id);
  }, [autoPlay]);

  return (
    <div className="app">
      <TopBar
        scenario={scenario}
        sim={sim}
        autoPlay={autoPlay}
        done={done}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        restored={restored}
      />

      <section className="scenario-brief">
        <div>
          <strong>演练目标：</strong>
          {scenario.description}
        </div>
        <ul>
          {scenario.watch.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      <main className="grid">
        <ClientPanel sim={sim} clientId="A" />
        <div className="center-col">
          <ServerPanel sim={sim} />
          <NetworkPanel sim={sim} />
        </div>
        <ClientPanel sim={sim} clientId="B" />
      </main>

      <Timeline log={sim.log} />

      <footer className="legend">
        <span><i className="dot a" /> 来源 A</span>
        <span><i className="dot b" /> 来源 B</span>
        <span><i className="dot s" /> 来源 服务端初始</span>
        <span className="sep" />
        <span>冲突规则：删除优先；更新/移动按 (逻辑时钟, 客户端ID) 较大者胜；锚点丢失则重定位到开头</span>
        <span className="sep" />
        <span>状态自动保存到本地，刷新页面可恢复</span>
      </footer>
    </div>
  );
}
