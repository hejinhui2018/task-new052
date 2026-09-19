import { useEffect, useRef, useState } from 'react';
import type { EventKind, SimEvent } from '../engine/types';

const FILTERS: { key: string; label: string; kinds: EventKind[] | null }[] = [
  { key: 'all', label: '全部', kinds: null },
  { key: 'ops', label: '操作与确认', kinds: ['op', 'send', 'apply', 'ack', 'sync'] },
  { key: 'net', label: '网络与故障', kinds: ['deliver', 'drop', 'link', 'fault'] },
  { key: 'conflict', label: '冲突与忽略', kinds: ['conflict', 'ignore'] },
];

const ACTOR_LABEL: Record<SimEvent['actor'], string> = {
  A: 'A',
  B: 'B',
  server: '服务端',
  net: '网络',
  sys: '系统',
};

export function Timeline({ events }: { events: SimEvent[] }) {
  const [filter, setFilter] = useState('all');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, filter]);

  const kinds = FILTERS.find((f) => f.key === filter)?.kinds ?? null;
  const shown = kinds ? events.filter((e) => kinds.includes(e.kind)) : events;

  return (
    <section className="panel timeline">
      <header className="panel-head">
        <h2>事件时间线</h2>
        <span className="panel-sub">每一次状态推进的因果记录</span>
        <div className="filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`btn tiny ${filter === f.key ? 'primary' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>
      <div className="timeline-body" ref={boxRef}>
        {shown.map((e) => (
          <div key={e.id} className={`ev ev-${e.actor} kind-${e.kind}`}>
            <span className="ev-time mono">t{e.time}</span>
            <span className={`ev-actor actor-${e.actor}`}>{ACTOR_LABEL[e.actor]}</span>
            <span className="ev-text">{e.text}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="empty">（暂无事件）</div>}
      </div>
    </section>
  );
}
