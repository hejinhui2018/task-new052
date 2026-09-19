import type { SimState } from '../sim/sim';

const PROV_CLASS: Record<string, string> = { A: 'a', B: 'b', S: 's' };

export function ServerPanel({ sim }: { sim: SimState }) {
  const s = sim.server;
  const conflicts = Object.entries(s.outcomes).filter(([, oc]) => oc.status !== 'applied');

  return (
    <section className="panel server">
      <header className="panel-head">
        <h2>服务端（权威）</h2>
        <span className="version-badge">v{s.version}</span>
        <span className="meta">已应用 {s.seenOpIds.length} 条操作</span>
      </header>

      <ul className="server-doc">
        {s.doc.map((b) => (
          <li key={b.id}>
            <span className={`prov-dot ${PROV_CLASS[b.updatedBy]}`} />
            <span className="bid">{b.id}</span>
            <span className="text">{b.text}</span>
            <span className="prov" title={`lamport ${b.updatedLamport}`}>
              来源 {b.updatedOpId}
            </span>
          </li>
        ))}
        {s.doc.length === 0 && <li className="empty">（文档为空）</li>}
      </ul>

      <h3>冲突与仲裁（{conflicts.length}）</h3>
      <ul className="conflict-list">
        {conflicts.length === 0 && <li className="empty">暂无冲突</li>}
        {conflicts.map(([id, oc]) => (
          <li key={id}>
            <code>{id}</code>{' '}
            {oc.status === 'superseded' && <span className="warn">被 {oc.by} 覆盖</span>}
            {oc.status === 'dropped' && <span className="err">已丢弃：{oc.reason}</span>}
            {oc.status === 'duplicate' && <span className="warn">重复（幂等忽略）</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
