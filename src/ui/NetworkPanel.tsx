import { store } from '../store/store';
import type { SimState } from '../sim/sim';
import type { ClientId, FaultKind } from '../sim/types';
import { FAULT_LABEL } from '../sim/network';
import { CLIENTS } from '../sim/types';

const FAULTS: FaultKind[] = ['drop', 'delay', 'duplicate', 'reorder'];
const FAULT_ICON: Record<FaultKind, string> = {
  drop: '丢',
  delay: '延',
  duplicate: '复',
  reorder: '序',
};

export function NetworkPanel({ sim }: { sim: SimState }) {
  const { net } = sim;
  const sorted = [...net.envelopes].sort((a, b) => a.deliverTick - b.deliverTick || a.num - b.num);

  return (
    <section className="panel network">
      <header className="panel-head">
        <h2>网络</h2>
        {net.queuedFaults.length > 0 && (
          <span className="queued-fault">已预排故障：{net.queuedFaults.map((f) => FAULT_LABEL[f]).join('、')}</span>
        )}
      </header>

      <div className="links">
        {CLIENTS.map((cid: ClientId) => (
          <button
            key={cid}
            className={`link-toggle ${net.links[cid] ? 'on' : 'off'}`}
            onClick={() => store.run({ type: 'toggleLink', client: cid })}
            title="切换链路"
          >
            {cid}⇄S {net.links[cid] ? '● 通' : '○ 断'}
          </button>
        ))}
      </div>

      <div className="fault-bar">
        <span>对下一条消息注入：</span>
        {FAULTS.map((f) => (
          <button key={f} className="fault" onClick={() => store.run({ type: 'injectNext', fault: f })}>
            {FAULT_LABEL[f]}
          </button>
        ))}
      </div>

      <div className="fault-bar">
        <span>手动干预：</span>
        {CLIENTS.map((cid) => (
          <button
            key={`retry-${cid}`}
            onClick={() => store.run({ type: 'retry', client: cid })}
            title="重发该客户端全部未确认操作（演示幂等）"
          >
            重试 {cid} 未确认
          </button>
        ))}
        {CLIENTS.map((cid) => (
          <button
            key={`clobber-${cid}`}
            className="danger"
            onClick={() => store.run({ type: 'clobber', client: cid })}
            title="故障：把旧快照回灌到该客户端（复现线上 bug）"
          >
            回灌旧快照→{cid}
          </button>
        ))}
      </div>

      <h3>在途消息（{net.envelopes.length}）</h3>
      <ul className="envelope-list">
        {sorted.length === 0 && <li className="empty">无</li>}
        {sorted.map((e) => (
          <li key={e.id} className={e.payload.kind}>
            <div className="env-main">
              <code>{e.id}</code>
              <span className="env-label">
                {e.label}
                {e.copyOf && <em>（{e.copyOf} 的副本）</em>}
              </span>
              <span className="env-route">
                {e.from}→{e.to} · 送达@t{e.deliverTick}
              </span>
            </div>
            <div className="env-faults">
              {FAULTS.map((f) => (
                <button
                  key={f}
                  title={`注入：${FAULT_LABEL[f]}`}
                  onClick={() => store.run({ type: 'injectOn', envId: e.id, fault: f })}
                >
                  {FAULT_ICON[f]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
