import { useEffect, useRef } from 'react';
import type { LogEntry } from '../sim/types';

const ACTOR_LABEL: Record<string, string> = {
  A: '客户端A',
  B: '客户端B',
  S: '服务端',
  NET: '网络',
  SYS: '系统',
};

export function Timeline({ log }: { log: LogEntry[] }) {
  const ref = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <section className="panel timeline">
      <header className="panel-head">
        <h2>事件时间线</h2>
        <span className="meta">{log.length} 条 · 因果关系按 tick 排序</span>
      </header>
      <ol ref={ref}>
        {log.map((e) => (
          <li key={e.seq} className={`tone-${e.tone}`}>
            <span className="t">t{e.tick}</span>
            <span className={`actor ${e.actor.toLowerCase()}`}>{ACTOR_LABEL[e.actor] ?? e.actor}</span>
            <span className="text">{e.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
