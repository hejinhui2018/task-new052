// ---------------------------------------------------------------------------
// 客户端：乐观本地编辑 + 待确认队列 + 确认处理。
//
// 关键性质：
//   - 草稿 = 已确认文档 + 待确认队列重放（rebase），旧快照永远盖不住新编辑；
//   - 迟到确认（version 更小）与重复确认（无新回执）一律忽略，不推进、不回退；
//   - 「已同步」只在待确认队列为空时成立（故障注入的假象除外，见 clobber）。
// ---------------------------------------------------------------------------

import { rebase } from './doc';
import type { RebasedOp } from './doc';
import type {
  Block,
  ClientId,
  EditSpec,
  LogTone,
  Op,
  OpOutcome,
  SyncMsg,
} from './types';
import { opLabel } from './types';

export interface PendingOp {
  op: Op;
  sent: boolean;
  attempts: number;
}

export interface ClientState {
  id: ClientId;
  lamport: number;
  seq: number;
  confirmedVersion: number;
  confirmedDoc: Block[];
  /** 最近若干份已确认快照（供"旧快照回灌"故障复现使用） */
  confirmedHistory: Array<{ version: number; doc: Block[] }>;
  pending: PendingOp[];
  knownOutcomes: Record<string, OpOutcome>;
  /** 故障注入：假象的"已同步"（复现线上 bug：旧草稿覆盖新内容却显示已同步） */
  fakeSynced: boolean;
}

export function initClient(id: ClientId, doc: Block[]): ClientState {
  return {
    id,
    lamport: 0,
    seq: 0,
    confirmedVersion: 0,
    confirmedDoc: doc,
    confirmedHistory: [{ version: 0, doc }],
    pending: [],
    knownOutcomes: {},
    fakeSynced: false,
  };
}

export function makeOp(c: ClientState, spec: EditSpec): Op {
  const seq = c.seq + 1;
  const lamport = c.lamport + 1;
  const base = { client: c.id, seq, lamport, baseVersion: c.confirmedVersion };
  switch (spec.kind) {
    case 'insert':
      return {
        ...base,
        opId: `${c.id}-${seq}`,
        kind: 'insert',
        blockId: `blk-${c.id.toLowerCase()}-${seq}`,
        text: spec.text,
        after: spec.after,
      };
    case 'update':
      return { ...base, opId: `${c.id}-${seq}`, kind: 'update', blockId: spec.blockId, text: spec.text };
    case 'delete':
      return { ...base, opId: `${c.id}-${seq}`, kind: 'delete', blockId: spec.blockId };
    case 'move':
      return { ...base, opId: `${c.id}-${seq}`, kind: 'move', blockId: spec.blockId, after: spec.after };
  }
}

export interface ClientRx {
  client: ClientState;
  events: Array<{ text: string; tone: LogTone }>;
}

export function receiveSync(c: ClientState, sync: SyncMsg): ClientRx {
  const newlyAcked = c.pending.filter((p) => sync.seenOpIds.includes(p.op.opId));

  // 迟到确认：版本落后于已确认版本 → 忽略，绝不回退。
  if (sync.version < c.confirmedVersion) {
    return {
      client: c,
      events: [
        {
          text: `迟到确认已忽略：sync v${sync.version}（当前已确认 v${c.confirmedVersion}，不回退）`,
          tone: 'warn',
        },
      ],
    };
  }
  // 重复确认：同版本且无新回执 → 忽略，不二次推进。
  if (sync.version === c.confirmedVersion && newlyAcked.length === 0) {
    return {
      client: c,
      events: [{ text: `重复确认已忽略：sync v${sync.version}（无新回执）`, tone: 'info' }],
    };
  }

  const events: Array<{ text: string; tone: LogTone }> = [];
  if (sync.version > c.confirmedVersion + 1) {
    events.push({
      text: `版本跳跃 v${c.confirmedVersion} → v${sync.version}（确认乱序到达，直接采用最新快照）`,
      tone: 'warn',
    });
  }

  const before = c.pending.length;
  const remaining = c.pending.filter((p) => !sync.seenOpIds.includes(p.op.opId));
  for (const p of newlyAcked) {
    const oc = sync.outcomes[p.op.opId] ?? ({ status: 'applied' } as OpOutcome);
    if (oc.status === 'applied') {
      events.push({ text: `确认 ${p.op.opId}（${opLabel(p.op)}），待确认 ${before} → ${remaining.length}`, tone: 'ok' });
    } else if (oc.status === 'superseded') {
      events.push({ text: `确认 ${p.op.opId}，但内容已被 ${oc.by} 覆盖`, tone: 'warn' });
    } else if (oc.status === 'dropped') {
      events.push({ text: `确认 ${p.op.opId}，但已被丢弃：${oc.reason}`, tone: 'warn' });
    }
  }
  events.push({ text: `同步至 v${sync.version}`, tone: 'info' });

  const confirmedHistory =
    sync.version > c.confirmedVersion
      ? [...c.confirmedHistory, { version: sync.version, doc: sync.doc }].slice(-8)
      : c.confirmedHistory;

  return {
    client: {
      ...c,
      confirmedVersion: sync.version,
      confirmedDoc: sync.doc,
      confirmedHistory,
      pending: remaining,
      knownOutcomes: { ...c.knownOutcomes, ...sync.outcomes },
      fakeSynced: false,
    },
    events,
  };
}

/** 故障注入：旧快照回灌 —— 复现"旧草稿覆盖新内容，界面仍显示已同步"。 */
export function clobber(c: ClientState): ClientRx {
  const older = [...c.confirmedHistory].reverse().find((h) => h.version < c.confirmedVersion);
  if (!older) {
    return {
      client: c,
      events: [{ text: '故障未生效：没有更旧的快照可回灌', tone: 'info' }],
    };
  }
  const lost = c.pending.length;
  return {
    client: {
      ...c,
      confirmedVersion: older.version,
      confirmedDoc: older.doc,
      pending: [],
      fakeSynced: true,
    },
    events: [
      {
        text: `故障·旧快照回灌：视图回退 v${c.confirmedVersion} → v${older.version}，${lost} 条待确认操作丢失`,
        tone: 'fault',
      },
      { text: `界面显示「已同步」——这是故障注入的假象（线上 bug 复现）`, tone: 'fault' },
    ],
  };
}

export interface DraftView {
  doc: Block[];
  results: RebasedOp[];
}

/** 草稿视图 = 已确认文档 + 待确认队列重放；results 供 UI 展示每条待确认操作的预演结局。 */
export function deriveDraft(c: ClientState): DraftView {
  const { doc, results } = rebase(c.confirmedDoc, c.pending.map((p) => p.op));
  return { doc, results };
}

export type SyncStatus =
  | { kind: 'fake-synced'; label: string }
  | { kind: 'pending'; label: string }
  | { kind: 'offline'; label: string }
  | { kind: 'synced'; label: string };

export function syncStatus(c: ClientState, online: boolean): SyncStatus {
  if (c.fakeSynced) return { kind: 'fake-synced', label: '已同步（假象·故障注入）' };
  if (c.pending.length > 0) {
    const unsent = c.pending.filter((p) => !p.sent).length;
    return {
      kind: 'pending',
      label: unsent > 0 ? `待确认 ×${c.pending.length}（${unsent} 条待发送）` : `待确认 ×${c.pending.length}`,
    };
  }
  if (!online) return { kind: 'offline', label: '离线 · 无未发送变更' };
  return { kind: 'synced', label: '已同步' };
}
