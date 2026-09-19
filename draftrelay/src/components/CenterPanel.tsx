import { OP_KIND_LABEL, shortText } from '../engine/core';
import type { ClientId, SimAction, SimState } from '../engine/types';

interface Props {
  state: SimState;
  dispatch: (a: SimAction) => void;
}

export function CenterPanel({ state, dispatch }: Props) {
  return (
    <div className="center">
      <NetworkPanel state={state} dispatch={dispatch} />
      <ServerPanel state={state} />
    </div>
  );
}

// ------------------------------------------------------------------ 网络层

function NetworkPanel({ state, dispatch }: Props) {
  const { inFlight, faults, stats, clients, server } = state;

  const linkRow = (id: ClientId) => {
    const online = clients[id].online;
    return (
      <div className="link-row" key={id}>
        <span className={`dot ${online ? 'on' : 'off'}`} />
        <span className="mono">
          {id} ⇄ 服务端
        </span>
        <span className={online ? 'link-ok' : 'link-down'}>{online ? '已连接' : '已断开'}</span>
        <button
          className="btn tiny"
          onClick={() => dispatch({ type: 'toggleNet', client: id })}
        >
          {online ? '断开' : '恢复'}
        </button>
      </div>
    );
  };

  return (
    <section className="panel net">
      <header className="panel-head">
        <h2>网络</h2>
        <span className="panel-sub">消息按 tick 投递 · 断链即丢包</span>
      </header>

      <div className="links">{(['A', 'B'] as ClientId[]).map(linkRow)}</div>

      <div className="inflight">
        <div className="sub-title">在途消息</div>
        {inFlight.length === 0 && <div className="empty">（空闲）</div>}
        {inFlight.map((e) => {
          const done = e.doneAt != null;
          const cls = e.dropped ? 'env dropped' : done ? 'env done' : 'env flying';
          return (
            <div key={e.id} className={cls}>
              <span className="mono">{envLabel(e.msg)}</span>
              <span className="env-state">
                {e.dropped ? '✕ 已丢弃' : done ? '✓ 已送达' : `… t${e.deliverAt} 到达`}
              </span>
              {e.fault && <span className="tag tag-fault">{e.fault}</span>}
            </div>
          );
        })}
      </div>

      <div className="faults">
        <div className="sub-title">故障注入（作用于下一条消息）</div>
        <div className="fault-btns">
          <button className="btn small" onClick={() => dispatch({ type: 'fault', fault: 'drop' })}>
            丢弃{faults.dropNext > 0 && <em>×{faults.dropNext}</em>}
          </button>
          <button className="btn small" onClick={() => dispatch({ type: 'fault', fault: 'duplicate' })}>
            复制{faults.duplicateNext > 0 && <em>×{faults.duplicateNext}</em>}
          </button>
          <button className="btn small" onClick={() => dispatch({ type: 'fault', fault: 'delay' })}>
            延迟{faults.delayNext > 0 && <em>×{faults.delayNext}</em>}
          </button>
          <button className="btn small" onClick={() => dispatch({ type: 'fault', fault: 'reorder' })}>
            乱序{faults.reorderNext && <em>✓</em>}
          </button>
          <button
            className={`btn small ${faults.chaos ? 'warn' : ''}`}
            onClick={() => dispatch({ type: 'fault', fault: 'chaos' })}
          >
            混沌{faults.chaos ? '：开' : '：关'}
          </button>
        </div>
      </div>

      <div className="stats mono">
        发送 {stats.sent} · 送达 {stats.delivered} · 丢弃 {stats.dropped} · 重试 {stats.retries} · 复制{' '}
        {stats.duplicated} · 服务端拒重 {server.duplicatesRejected}
      </div>
    </section>
  );
}

function envLabel(msg: SimState['inFlight'][number]['msg']): string {
  switch (msg.type) {
    case 'op':
      return `${msg.from}→服务端 ${msg.op.opId}`;
    case 'hello':
      return `${msg.from}→服务端 握手`;
    case 'state':
      return `服务端→${msg.to} ${msg.ackOpId ? `确认 ${msg.ackOpId}` : '同步'} v${msg.version}`;
  }
}

// ------------------------------------------------------------------ 服务端

function ServerPanel({ state }: { state: SimState }) {
  const { server } = state;
  const heldCount = server.held.A.length + server.held.B.length;
  const recentLog = server.log.slice(-9).reverse();

  return (
    <section className="panel server">
      <header className="panel-head">
        <h2>服务端（权威状态）</h2>
        <span className="chip mono big">v{server.version}</span>
      </header>

      <div className="client-meta mono">
        已应用操作 {server.seenOpIds.length} · 拒绝重复 {server.duplicatesRejected}
        {heldCount > 0 && ` · 乱序缓存 ${heldCount}`}
      </div>

      {heldCount > 0 && (
        <div className="held">
          {(['A', 'B'] as ClientId[]).flatMap((id) =>
            server.held[id].map((op) => (
              <div key={op.opId} className="pend conflict">
                缓存乱序 <code>{op.opId}</code>（等待 {id}#{server.lastSeq[id] + 1}）
              </div>
            )),
          )}
        </div>
      )}

      <div className="server-blocks">
        {server.blocks.map((b) => {
          const meta = server.blockMeta[b.id];
          return (
            <div key={b.id} className="server-block">
              <span className="mono block-id">{b.id}</span>
              <span className="server-text" title={b.text}>
                {shortText(b.text, 30)}
              </span>
              {meta && (
                <span className={`tag tag-src tag-src-${meta.by}`}>
                  {meta.by === 'server' ? '初始' : `${meta.by}·v${meta.version}`}
                </span>
              )}
            </div>
          );
        })}
        {server.blocks.length === 0 && <div className="empty">（文档为空）</div>}
      </div>

      <div className="server-log">
        <div className="sub-title">版本日志（因果链：每条基于哪个版本）</div>
        {recentLog.length === 0 && <div className="empty">尚无变更</div>}
        {recentLog.map((e) => (
          <div key={e.version} className={`log-entry ${e.concurrentWith ? 'concurrent' : ''}`}>
            <span className="mono ver">v{e.version}</span>
            <span className="mono">
              {e.op.opId} {OP_KIND_LABEL[e.op.kind]} {e.op.blockId}
            </span>
            <span className="log-based">基于 v{e.op.baseVersion}</span>
            {e.concurrentWith && (
              <span className="tag tag-conflict" title="该操作产生时未看到对方的并发修改，按到达顺序覆盖">
                ⚠ 覆盖 {e.concurrentWith.by}@v{e.concurrentWith.version}
              </span>
            )}
            {e.note && <span className="log-note">{e.note}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
