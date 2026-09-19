import { useEffect, useState } from 'react';
import { clientView, OP_KIND_LABEL, syncStatus } from '../engine/core';
import type { ClientState, PendingOp, ServerState, SimAction } from '../engine/types';

interface Props {
  client: ClientState;
  server: ServerState;
  dispatch: (a: SimAction) => void;
}

export function ClientPanel({ client, server, dispatch }: Props) {
  const view = clientView(client);
  const status = syncStatus(client, server);
  const lastId = view.length ? view[view.length - 1].id : null;

  return (
    <section className={`panel client client-${client.id.toLowerCase()}`}>
      <header className="panel-head">
        <h2>
          客户端 {client.id}
          <span className={`dot ${client.online ? 'on' : 'off'}`} />
        </h2>
        <span className={`badge badge-${status.cls}`}>{status.text}</span>
        <button
          className={`btn small ${client.online ? 'warn' : 'primary'}`}
          onClick={() => dispatch({ type: 'toggleNet', client: client.id })}
        >
          {client.online ? '断开网络' : '恢复网络'}
        </button>
      </header>

      <div className="client-meta mono">
        已知服务端 v{client.serverVersion} · 下一序号 #{client.nextSeq} · 忽略重复确认{' '}
        {client.ignoredAcks} · 丢弃失效 {client.droppedOps}
      </div>

      <div className="blocks">
        {view.map((b, i) => (
          <BlockRow
            key={b.id}
            clientId={client.id}
            blockId={b.id}
            text={b.text}
            index={i}
            count={view.length}
            pending={client.pending.find((p) => p.blockId === b.id) ?? null}
            metaBy={server.blockMeta[b.id]?.by ?? null}
            metaVersion={server.blockMeta[b.id]?.version ?? null}
            dispatch={dispatch}
          />
        ))}
        {view.length === 0 && <div className="empty">（文档为空）</div>}
      </div>

      <button
        className="btn small ghost add-block"
        onClick={() =>
          dispatch({ type: 'insert', client: client.id, after: lastId, text: '- 新条目（点击编辑）' })
        }
      >
        ＋ 添加块
      </button>

      <div className="pending">
        <div className="pending-title">
          待确认队列 <span className="mono">{client.pending.length}</span>
        </div>
        {client.pending.length === 0 && <div className="empty">空 —— 本地与已确认状态一致</div>}
        {client.pending.map((p) => (
          <div key={p.opId} className={`pend ${p.conflictNote ? 'conflict' : ''}`}>
            <div className="pend-line">
              <code>{p.opId}</code>
              <span>
                {OP_KIND_LABEL[p.kind]} <code>{p.blockId}</code>
              </span>
              <span className="pend-state">
                {p.lastSentAt == null ? '待发送' : `已发送×${p.sendCount} · 等待确认`}
              </span>
            </div>
            {p.conflictNote && <div className="pend-note">⚠ {p.conflictNote}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  clientId: 'A' | 'B';
  blockId: string;
  text: string;
  index: number;
  count: number;
  pending: PendingOp | null;
  metaBy: 'A' | 'B' | 'server' | null;
  metaVersion: number | null;
  dispatch: (a: SimAction) => void;
}

function BlockRow({ clientId, blockId, text, index, count, pending, metaBy, metaVersion, dispatch }: RowProps) {
  const [draft, setDraft] = useState(text);
  // 外部（服务端广播/撤销/重置）导致文本变化时，刷新输入框
  useEffect(() => setDraft(text), [text]);

  const commit = () => {
    if (draft !== text) dispatch({ type: 'edit', client: clientId, blockId, text: draft });
  };

  return (
    <div className={`block ${pending ? 'has-pending' : ''}`}>
      <div className="block-head mono">
        <span className="block-id">{blockId}</span>
        {pending && (
          <span className="tag tag-pending" title={pending.conflictNote ?? '本地已生效，等待服务端确认'}>
            {pending.conflictNote ? '⚠ 冲突重基' : '⏳ 待确认'}
          </span>
        )}
        {metaBy && (
          <span className={`tag tag-src tag-src-${metaBy}`}>
            来源 {metaBy === 'server' ? '初始' : metaBy}
            {metaVersion != null && metaVersion > 0 ? `·v${metaVersion}` : ''}
          </span>
        )}
      </div>
      <input
        className="block-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="block-ops">
        <button
          className="icon-btn"
          title="上移"
          disabled={index === 0}
          onClick={() => dispatch({ type: 'move', client: clientId, blockId, dir: -1 })}
        >
          ↑
        </button>
        <button
          className="icon-btn"
          title="下移"
          disabled={index === count - 1}
          onClick={() => dispatch({ type: 'move', client: clientId, blockId, dir: 1 })}
        >
          ↓
        </button>
        <button
          className="icon-btn"
          title="在下方插入块"
          onClick={() =>
            dispatch({ type: 'insert', client: clientId, after: blockId, text: '- 新条目（点击编辑）' })
          }
        >
          ＋
        </button>
        <button
          className="icon-btn danger"
          title="删除块"
          onClick={() => dispatch({ type: 'delete', client: clientId, blockId })}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
