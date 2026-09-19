import { useState } from 'react';
import { store } from '../store/store';
import { deriveDraft, syncStatus } from '../sim/client';
import type { ClientState } from '../sim/client';
import type { SimState } from '../sim/sim';
import type { Block, ClientId, OpOutcome } from '../sim/types';

const PROV_CLASS: Record<string, string> = { A: 'a', B: 'b', S: 's' };

function outcomeText(oc: OpOutcome): { text: string; cls: string } {
  switch (oc.status) {
    case 'applied':
      return { text: '已应用', cls: 'ok' };
    case 'superseded':
      return { text: `被 ${oc.by} 覆盖`, cls: 'warn' };
    case 'dropped':
      return { text: `已丢弃：${oc.reason}`, cls: 'err' };
    case 'duplicate':
      return { text: '重复（已幂等忽略）', cls: 'warn' };
  }
}

/** 单个块：失焦/回车才提交更新操作，避免每次击键都产生一条操作。 */
function BlockRow({
  block,
  index,
  total,
  clientId,
  touched,
  anchorUp,
  anchorDown,
}: {
  block: Block;
  index: number;
  total: number;
  clientId: ClientId;
  touched: boolean;
  /** 上移一格后的新锚点（null = 移到开头） */
  anchorUp: string | null;
  /** 下移一格后的新锚点 */
  anchorDown: string | null;
}) {
  const [draft, setDraft] = useState(block.text);
  const commit = () => {
    if (draft !== block.text) {
      store.run({ type: 'edit', client: clientId, spec: { kind: 'update', blockId: block.id, text: draft } });
    }
  };
  return (
    <div className={`block-row ${touched ? 'touched' : ''}`}>
      <span className={`prov-dot ${PROV_CLASS[block.updatedBy]}`} title={`内容来源：${block.updatedOpId}`} />
      <span className="bid">{block.id}</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="prov" title={`合并来源：${block.updatedOpId}（lamport ${block.updatedLamport}）`}>
        {block.updatedOpId}
      </span>
      <span className="row-actions">
        <button
          disabled={index === 0}
          title="上移"
          onClick={() =>
            store.run({ type: 'edit', client: clientId, spec: { kind: 'move', blockId: block.id, after: anchorUp } })
          }
        >
          ↑
        </button>
        <button
          disabled={index === total - 1}
          title="下移"
          onClick={() =>
            store.run({ type: 'edit', client: clientId, spec: { kind: 'move', blockId: block.id, after: anchorDown } })
          }
        >
          ↓
        </button>
        <button
          title="删除"
          onClick={() => store.run({ type: 'edit', client: clientId, spec: { kind: 'delete', blockId: block.id } })}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

export function ClientPanel({ sim, clientId }: { sim: SimState; clientId: ClientId }) {
  const c: ClientState = sim.clients[clientId];
  const online = sim.net.links[clientId];
  const { doc, results } = deriveDraft(c);
  const status = syncStatus(c, online);
  const touchedIds = new Set(c.pending.map((p) => p.op.blockId));
  const ownOutcomes = Object.entries(c.knownOutcomes).filter(([id]) => id.startsWith(`${clientId}-`));

  return (
    <section className={`panel client ${online ? '' : 'offline'}`}>
      <header className="panel-head">
        <h2>客户端 {clientId}</h2>
        <span className={`link-badge ${online ? 'on' : 'off'}`}>{online ? '在线' : '离线'}</span>
        <span className={`sync-chip ${status.kind}`}>{status.label}</span>
      </header>

      <div className="meta">
        已确认 v{c.confirmedVersion} · 逻辑时钟 {c.lamport} · 已发操作 {c.seq}
      </div>

      <div className="blocks">
        {doc.map((b, i) => (
          <BlockRow
            key={`${b.id}:${b.text}`}
            block={b}
            index={i}
            total={doc.length}
            clientId={clientId}
            touched={touchedIds.has(b.id)}
            anchorUp={i >= 2 ? doc[i - 2].id : null}
            anchorDown={i + 1 < doc.length ? doc[i + 1].id : null}
          />
        ))}
        {doc.length === 0 && <div className="empty">（文档为空）</div>}
      </div>

      <div className="insert-row">
        <button
          onClick={() =>
            store.run({
              type: 'edit',
              client: clientId,
              spec: {
                kind: 'insert',
                after: doc.length > 0 ? doc[doc.length - 1].id : null,
                text: `新段落（客户端 ${clientId}）`,
              },
            })
          }
        >
          ＋ 在末尾插入块
        </button>
      </div>

      <h3>待确认队列（{c.pending.length}）</h3>
      <ul className="pending-list">
        {c.pending.length === 0 && <li className="empty">空 —— 全部已确认</li>}
        {c.pending.map((p, i) => {
          const rebased = results[i];
          const doom =
            rebased && rebased.outcome.status === 'dropped'
              ? `预演：将被丢弃（${rebased.outcome.reason}）`
              : rebased && rebased.outcome.status === 'superseded'
                ? `预演：将被 ${rebased.outcome.by} 覆盖`
                : null;
          return (
            <li key={p.op.opId}>
              <code>{p.op.opId}</code> {p.op.kind} {p.op.blockId}
              <span className={`send-state ${p.sent ? 'sent' : 'unsent'}`}>
                {p.sent ? `待确认 · 尝试×${p.attempts}` : '待发送'}
              </span>
              <span className="base">基于 v{p.op.baseVersion}</span>
              {doom && <span className="doom">{doom}</span>}
            </li>
          );
        })}
      </ul>

      <h3>本方操作结局</h3>
      <ul className="outcome-list">
        {ownOutcomes.length === 0 && <li className="empty">尚无已确认操作</li>}
        {ownOutcomes.map(([id, oc]) => {
          const o = outcomeText(oc);
          return (
            <li key={id}>
              <code>{id}</code> <span className={o.cls}>{o.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
