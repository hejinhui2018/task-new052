// ---------------------------------------------------------------------------
// 文档操作应用层：服务端与客户端（rebase 草稿时）共用同一套确定性规则。
//
// 冲突规则（与 UI 图例一致）：
//   1. 删除优先：块一旦被删，后续的更新/移动一律丢弃；
//   2. 更新/移动按 (lamport, clientId) 较大者胜（LWW，与到达顺序无关）；
//   3. 插入锚点丢失时重定位到文档开头；
//   4. 同一锚点下的并发插入按 (posLamport, posBy) 排序，结果确定。
// ---------------------------------------------------------------------------

import type { ActorId, Block, Op, OpOutcome } from './types';

export interface ApplyResult {
  doc: Block[];
  outcome: OpOutcome;
  note?: string;
  /** 本次应用顶掉了哪个已确认操作（用于追溯合并来源） */
  supersededOpId?: string;
}

/** (lamport, actor) 字典序比较：后者是否胜过当前持有者 */
function wins(lamport: number, by: ActorId, curLamport: number, curBy: ActorId): boolean {
  if (lamport !== curLamport) return lamport > curLamport;
  return by > curBy;
}

export function findBlock(doc: Block[], id: string): number {
  return doc.findIndex((b) => b.id === id);
}

function replaceAt(doc: Block[], i: number, b: Block): Block[] {
  return [...doc.slice(0, i), b, ...doc.slice(i + 1)];
}

/**
 * 计算插入位置：锚点之后、所有"同锚点且键更小的新插入块"之后。
 * posLamport === 0 的块属于初始文档链，不参与并发插入排序，
 * 因此「在 b1 后插入」会紧跟 b1，而不是被挤到初始块之后。
 */
function insertIndex(
  doc: Block[],
  anchorIdx: number,
  anchor: string | null,
  lamport: number,
  by: ActorId,
): number {
  if (anchorIdx < 0) return 0;
  let i = anchorIdx + 1;
  while (
    i < doc.length &&
    doc[i].anchor === anchor &&
    doc[i].posLamport > 0 &&
    (doc[i].posLamport < lamport || (doc[i].posLamport === lamport && doc[i].posBy < by))
  ) {
    i++;
  }
  return i;
}

export function applyOp(doc: Block[], op: Op): ApplyResult {
  switch (op.kind) {
    case 'insert': {
      const anchor = op.after ?? null;
      const aIdx = anchor ? findBlock(doc, anchor) : -1;
      const anchorMissing = anchor !== null && aIdx < 0;
      const block: Block = {
        id: op.blockId,
        text: op.text ?? '',
        updatedBy: op.client,
        updatedLamport: op.lamport,
        updatedOpId: op.opId,
        anchor: anchorMissing ? null : anchor,
        posLamport: op.lamport,
        posBy: op.client,
      };
      const idx = anchorMissing ? 0 : insertIndex(doc, aIdx, anchor, op.lamport, op.client);
      return {
        doc: [...doc.slice(0, idx), block, ...doc.slice(idx)],
        outcome: { status: 'applied' },
        note: anchorMissing ? `锚点 ${anchor} 已丢失，改插到开头` : undefined,
      };
    }
    case 'update': {
      const i = findBlock(doc, op.blockId);
      if (i < 0) return { doc, outcome: { status: 'dropped', reason: '目标块已被删除' } };
      const b = doc[i];
      if (!wins(op.lamport, op.client, b.updatedLamport, b.updatedBy)) {
        return { doc, outcome: { status: 'superseded', by: b.updatedOpId } };
      }
      const nb: Block = {
        ...b,
        text: op.text ?? b.text,
        updatedBy: op.client,
        updatedLamport: op.lamport,
        updatedOpId: op.opId,
      };
      return {
        doc: replaceAt(doc, i, nb),
        outcome: { status: 'applied' },
        supersededOpId: b.updatedLamport > 0 && b.updatedOpId !== op.opId ? b.updatedOpId : undefined,
      };
    }
    case 'delete': {
      const i = findBlock(doc, op.blockId);
      if (i < 0) return { doc, outcome: { status: 'dropped', reason: '目标块已被删除' } };
      const victim = doc[i];
      return {
        doc: doc.filter((b) => b.id !== op.blockId),
        outcome: { status: 'applied' },
        supersededOpId: victim.updatedLamport > 0 ? victim.updatedOpId : undefined,
      };
    }
    case 'move': {
      const i = findBlock(doc, op.blockId);
      if (i < 0) return { doc, outcome: { status: 'dropped', reason: '目标块已被删除' } };
      const b = doc[i];
      if (!wins(op.lamport, op.client, b.posLamport, b.posBy)) {
        return { doc, outcome: { status: 'superseded', by: b.updatedOpId } };
      }
      const anchor = op.after ?? null;
      const without = doc.filter((x) => x.id !== op.blockId);
      const aIdx = anchor ? findBlock(without, anchor) : -1;
      const anchorMissing = anchor !== null && aIdx < 0;
      const nb: Block = {
        ...b,
        anchor: anchorMissing ? null : anchor,
        posLamport: op.lamport,
        posBy: op.client,
      };
      const idx = anchorMissing ? 0 : insertIndex(without, aIdx, anchor, op.lamport, op.client);
      return {
        doc: [...without.slice(0, idx), nb, ...without.slice(idx)],
        outcome: { status: 'applied' },
        note: anchorMissing ? `锚点 ${anchor} 已丢失，移动到开头` : undefined,
      };
    }
  }
}

export interface RebasedOp {
  op: Op;
  outcome: OpOutcome;
  note?: string;
}

/** 把一串待确认操作重放到新的已确认文档上（客户端草稿 = 已确认 + 待确认）。 */
export function rebase(doc: Block[], ops: Op[]): { doc: Block[]; results: RebasedOp[] } {
  let cur = doc;
  const results: RebasedOp[] = [];
  for (const op of ops) {
    const r = applyOp(cur, op);
    cur = r.doc;
    results.push({ op, outcome: r.outcome, note: r.note });
  }
  return { doc: cur, results };
}
