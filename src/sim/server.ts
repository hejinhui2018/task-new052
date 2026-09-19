// ---------------------------------------------------------------------------
// 服务端：唯一权威排序者。
//   - 按 opId 去重：重复重试/重复投递绝不二次推进版本（幂等）；
//   - 应用操作并记录仲裁结果（含"后来操作顶掉先前操作"的追溯）；
//   - 每次变化广播全量 sync（版本 + 文档 + 累计已见 opId + 累计仲裁结果）。
// ---------------------------------------------------------------------------

import { applyOp } from './doc';
import type { Block, LogTone, Op, OpOutcome, SyncMsg } from './types';
import { opLabel } from './types';

export interface ServerState {
  version: number;
  doc: Block[];
  seenOpIds: string[];
  outcomes: Record<string, OpOutcome>;
}

export function initServer(doc: Block[]): ServerState {
  return { version: 0, doc, seenOpIds: [], outcomes: {} };
}

export interface ServerRx {
  server: ServerState;
  sync: SyncMsg;
  events: Array<{ text: string; tone: LogTone }>;
}

function makeSync(s: ServerState, causeOpId: string | null): SyncMsg {
  return {
    kind: 'sync',
    version: s.version,
    doc: s.doc,
    seenOpIds: s.seenOpIds,
    outcomes: s.outcomes,
    causeOpId,
  };
}

export function serverReceive(srv: ServerState, op: Op): ServerRx {
  // 幂等闸门：迟到确认引发的重试、网络复制故障产生的副本，都在这里被拦下。
  if (srv.seenOpIds.includes(op.opId)) {
    return {
      server: srv,
      sync: makeSync(srv, op.opId), // 仍回执当前状态，让重试方收敛
      events: [
        {
          text: `重复操作 ${op.opId} 已忽略（幂等，版本保持 v${srv.version}）`,
          tone: 'warn',
        },
      ],
    };
  }

  const r = applyOp(srv.doc, op);
  const outcomes: Record<string, OpOutcome> = { ...srv.outcomes, [op.opId]: r.outcome };
  const events: Array<{ text: string; tone: LogTone }> = [];

  if (r.outcome.status === 'applied') {
    const causal =
      op.baseVersion < srv.version ? `；基于 v${op.baseVersion}，与已到的 v${srv.version} 并发` : '';
    events.push({
      text: `应用 ${op.opId}（${opLabel(op)}）→ v${srv.version + 1}${causal}`,
      tone: 'ok',
    });
    if (r.note) events.push({ text: `注意：${op.opId} ${r.note}`, tone: 'warn' });
  } else if (r.outcome.status === 'superseded') {
    events.push({
      text: `冲突：${op.opId}（${opLabel(op)}）被 ${r.outcome.by} 覆盖，未生效`,
      tone: 'warn',
    });
  } else if (r.outcome.status === 'dropped') {
    events.push({ text: `丢弃 ${op.opId}（${opLabel(op)}）：${r.outcome.reason}`, tone: 'warn' });
  }

  // 追溯：本次应用顶掉了某个已确认操作 → 更新它的仲裁结果（合并来源切换）。
  if (r.supersededOpId) {
    outcomes[r.supersededOpId] = { status: 'superseded', by: op.opId };
    events.push({
      text: `冲突：${r.supersededOpId} 的内容被 ${op.opId} 覆盖（合并来源变更）`,
      tone: 'warn',
    });
  }

  const next: ServerState = {
    version: srv.version + 1,
    doc: r.doc,
    seenOpIds: [...srv.seenOpIds, op.opId],
    outcomes,
  };
  return { server: next, sync: makeSync(next, op.opId), events };
}
