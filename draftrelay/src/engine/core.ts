// ---------------------------------------------------------------------------
// 纯函数工具：确定性随机数、块操作应用、客户端视图推导
// ---------------------------------------------------------------------------

import type { Block, ClientState, Op, OpKind, ServerState } from './types';

/** mulberry32：输入状态，返回 [新状态, [0,1) 随机数)。纯函数、可复现。 */
export function mulberry32(state: number): [number, number] {
  let a = state >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [a, r];
}

export const OP_KIND_LABEL: Record<OpKind, string> = {
  edit: '编辑',
  insert: '插入',
  delete: '删除',
  move: '移动',
};

function insertAt(blocks: Block[], block: Block, after: string | null): Block[] {
  const next = blocks.slice();
  let at: number;
  if (after == null) {
    at = 0;
  } else {
    const i = next.findIndex((b) => b.id === after);
    at = i >= 0 ? i + 1 : next.length; // 锚点丢失 → 追加到末尾（兜底）
  }
  next.splice(at, 0, block);
  return next;
}

/**
 * 把一条操作应用到块列表上。服务端与客户端视图共用同一份实现，
 * 保证“乐观本地效果”和“服务端权威效果”语义一致。
 */
export function applyOpToBlocks(blocks: Block[], op: Op): Block[] {
  switch (op.kind) {
    case 'edit':
      return blocks.map((b) => (b.id === op.blockId ? { ...b, text: op.text } : b));
    case 'insert': {
      if (blocks.some((b) => b.id === op.blockId)) {
        // 同 id 已存在（重复操作）：退化为更新文本，保持幂等
        return blocks.map((b) => (b.id === op.blockId ? { ...b, text: op.text } : b));
      }
      return insertAt(blocks, { id: op.blockId, text: op.text }, op.after);
    }
    case 'delete':
      return blocks.filter((b) => b.id !== op.blockId);
    case 'move': {
      const blk = blocks.find((b) => b.id === op.blockId);
      if (!blk) return blocks;
      return insertAt(
        blocks.filter((b) => b.id !== op.blockId),
        blk,
        op.after,
      );
    }
  }
}

/** 客户端本地视图 = 已确认的服务端快照 + 依次重放的待确认队列 */
export function clientView(client: ClientState): Block[] {
  return client.pending.reduce((bs, p) => applyOpToBlocks(bs, p), client.base);
}

export interface SyncStatus {
  cls: 'synced' | 'pending' | 'offline' | 'stale';
  text: string;
}

/**
 * 诚实的同步状态：只有“队列为空 且 本地已并入服务端最新版本”才算已同步。
 * 这正是展会上那个 bug 的反面 —— 旧草稿还在路上时绝不显示“已同步”。
 */
export function syncStatus(client: ClientState, server: ServerState): SyncStatus {
  if (!client.online) {
    return { cls: 'offline', text: `离线 · ${client.pending.length} 条待同步` };
  }
  if (client.pending.length > 0) {
    return { cls: 'pending', text: `同步中 · ${client.pending.length} 条待确认` };
  }
  if (client.serverVersion < server.version) {
    return { cls: 'stale', text: `落后服务端 ${server.version - client.serverVersion} 个版本` };
  }
  return { cls: 'synced', text: '已同步 ✓' };
}

export function shortText(text: string, max = 14): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
