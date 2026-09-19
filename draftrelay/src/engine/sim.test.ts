// ---------------------------------------------------------------------------
// DraftRelay 引擎测试
//   1. 乱序确认：服务端按序号缓存重排，因果不乱
//   2. 双端冲突：离线并发编辑同一块，按到达顺序合并且来源可追溯
//   3. 重连：离线队列按因果顺序冲刷
//   4. 迟到/重复确认与重试：幂等，版本绝不推进两次
//   5. 重复演练：同种子同脚本结果逐字节一致
//   6. 刷新恢复：JSON 序列化往返后继续推进结果一致
//   7. 归约器纯净性：不修改入参（撤销/重做的前提）
//   8. 块操作语义：编辑/插入/删除/移动的边界行为
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { applyOpToBlocks, clientView, syncStatus } from './core';
import { DEFAULT_SEED, initialSim, reduce } from './sim';
import type { Block, Op, SimState } from './types';

const tick = (s: SimState, n = 1): SimState => {
  for (let i = 0; i < n; i++) s = reduce(s, { type: 'tick' });
  return s;
};

const scenario = (name: string, ticks: number): SimState =>
  tick(reduce(initialSim(DEFAULT_SEED), { type: 'loadScript', name }), ticks);

const blockText = (s: SimState, id: string): string =>
  s.server.blocks.find((b) => b.id === id)!.text;

describe('乱序确认', () => {
  it('同一客户端的操作乱序到达时，服务端缓存重排、按因果顺序应用', () => {
    const s = scenario('reorder', 10);

    // 两条操作都生效，且日志顺序保持因果序 A#1 → A#2
    expect(s.server.version).toBe(2);
    expect(s.server.log.map((e) => e.op.opId)).toEqual(['A#1', 'A#2']);

    // 后到的 A#2 曾被缓存等待前驱
    expect(s.events.some((e) => e.text.includes('缓存乱序操作 A#2'))).toBe(true);

    // 最终内容是“第二步”（因果上更晚的操作生效）
    expect(blockText(s, 'b2')).toContain('第二步');

    // 客户端收敛：队列清空、视图与服务端一致、状态诚实
    expect(s.clients.A.pending).toHaveLength(0);
    expect(clientView(s.clients.A)).toEqual(s.server.blocks);
    expect(syncStatus(s.clients.A, s.server).cls).toBe('synced');
  });
});

describe('双端冲突', () => {
  it('离线并发编辑同一块：按服务端到达顺序合并，来源与覆盖关系可见', () => {
    const s = scenario('conflict', 14);

    // A 在线改 1 次 + B 离线改 2 次 = 3 个版本
    expect(s.server.version).toBe(3);

    // B 的离线草稿后到，覆盖了 A 的并发修改（最后写入者胜出）
    expect(blockText(s, 'b2')).toContain('B 离线重写');
    expect(s.server.blockMeta['b2'].by).toBe('B');

    // 因果链上明确记录：v2 覆盖了 A 在 v1 的并发修改
    expect(s.server.log[1].concurrentWith).toEqual({ by: 'A', version: 1 });

    // 冲突事件对双方可见（B 重基时发现冲突 / A 看到被覆盖）
    expect(s.events.some((e) => e.kind === 'conflict' && e.actor === 'B')).toBe(true);
    expect(s.events.some((e) => e.kind === 'conflict' && e.actor === 'A')).toBe(true);

    // 双端最终收敛到同一份权威状态
    expect(clientView(s.clients.A)).toEqual(s.server.blocks);
    expect(clientView(s.clients.B)).toEqual(s.server.blocks);
    expect(s.clients.B.pending).toHaveLength(0);
    expect(syncStatus(s.clients.A, s.server).cls).toBe('synced');
    expect(syncStatus(s.clients.B, s.server).cls).toBe('synced');
  });
});

describe('重连', () => {
  it('离线期间连续编辑/删除/移动/插入，重连后按因果顺序冲刷', () => {
    const s = scenario('offlineQueue', 16);

    // 四条操作按 B 的本地序号顺序应用
    expect(s.server.log.map((e) => e.op.opId)).toEqual(['B#1', 'B#2', 'B#3', 'B#4']);
    expect(s.server.version).toBe(4);

    // 编辑 b1、删除 b4、b2 下移、在 b1 后插入 —— 全部按序生效
    expect(s.server.blocks.map((b) => b.id)).toEqual(['b1', 'B-new4', 'b3', 'b2']);
    expect(s.server.blocks[0].text).toContain('修订版');

    // 重连走了握手追赶，双端收敛
    expect(s.events.some((e) => e.text.includes('握手'))).toBe(true);
    expect(clientView(s.clients.B)).toEqual(s.server.blocks);
    expect(clientView(s.clients.A)).toEqual(s.server.blocks);
  });

  it('断链期间的在途消息被丢弃，由重试补偿', () => {
    // B 离线 → A 编辑（广播给 B 的同步被丢）→ B 恢复后握手追赶
    let s = initialSim(DEFAULT_SEED);
    s = reduce(s, { type: 'toggleNet', client: 'B' });
    s = reduce(s, { type: 'edit', client: 'A', blockId: 'b1', text: '# 标题（A 修改）' });
    s = tick(s, 4); // A 的变更到达服务端，给 B 的广播因断链被丢弃
    expect(s.server.version).toBe(1);
    expect(s.clients.B.serverVersion).toBe(0);
    expect(s.stats.dropped).toBeGreaterThanOrEqual(1);

    s = reduce(s, { type: 'toggleNet', client: 'B' });
    s = tick(s, 4); // 握手 → 追赶同步
    expect(s.clients.B.serverVersion).toBe(1);
    expect(clientView(s.clients.B)).toEqual(s.server.blocks);
  });
});

describe('迟到确认与重复重试（幂等）', () => {
  it('重复确认被忽略，重试不会让版本推进两次', () => {
    const s = scenario('lateAck', 16);

    // 两条编辑各应用一次：版本恰好为 2
    expect(s.server.version).toBe(2);

    // 第一次确认被复制 → 客户端忽略了重复确认
    expect(s.clients.A.ignoredAcks).toBe(1);
    expect(s.events.some((e) => e.text.includes('忽略重复的确认 A#1'))).toBe(true);

    // 第二次确认被丢弃 → 客户端重试 → 服务端幂等拒绝重复操作
    expect(s.stats.retries).toBe(1);
    expect(s.server.duplicatesRejected).toBe(1);
    expect(s.events.some((e) => e.text.includes('忽略重复操作 A#2'))).toBe(true);

    // 内容只应用了一次，双端收敛
    expect(blockText(s, 'b3')).toContain('已验证');
    expect(blockText(s, 'b4')).toContain('演练复现');
    expect(s.clients.A.pending).toHaveLength(0);
    expect(clientView(s.clients.A)).toEqual(s.server.blocks);
  });

  it('过期的服务端状态不会回滚客户端', () => {
    // 手工构造：A 连续两笔编辑，第一笔的确认被延迟到第二笔之后到达
    let s = initialSim(DEFAULT_SEED);
    s = reduce(s, { type: 'edit', client: 'A', blockId: 'b1', text: '# 第一版' });
    s = tick(s, 1); // A#1 发出（t2 到达服务端）
    s = reduce(s, { type: 'fault', fault: 'delay' }); // 武装：延迟下一条消息 = A#1 的确认
    s = tick(s, 1); // t2：A#1 应用 → v1，确认被延迟到 t6
    s = reduce(s, { type: 'edit', client: 'A', blockId: 'b1', text: '# 第二版' });
    s = tick(s, 3); // t3 发出 A#2；t4 应用 → v2；t5 其确认正常到达
    expect(s.clients.A.serverVersion).toBe(2);

    s = tick(s, 4); // t6 迟到的 v1 确认到达；t7 重试 A#1；t8 服务端拒重；t9 兜底确认
    expect(s.clients.A.serverVersion).toBe(2); // 没有回滚
    expect(s.clients.A.ignoredAcks).toBeGreaterThanOrEqual(1);
    expect(s.events.some((e) => e.text.includes('忽略过期的服务端状态'))).toBe(true);
    expect(blockText(s, 'b1')).toBe('# 第二版');
    expect(s.clients.A.pending).toHaveLength(0);
  });
});

describe('重复演练', () => {
  it('相同种子与脚本重复运行，最终状态逐字节一致', () => {
    const run1 = scenario('conflict', 14);
    const run2 = scenario('conflict', 14);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('重置后重跑同一脚本，结果一致', () => {
    let s = scenario('offlineQueue', 16);
    const first = JSON.stringify(s.server);
    s = reduce(s, { type: 'reset' });
    s = reduce(s, { type: 'loadScript', name: 'offlineQueue' });
    s = tick(s, 16);
    expect(JSON.stringify(s.server)).toBe(first);
  });
});

describe('刷新恢复', () => {
  it('序列化/反序列化后继续推进，与不中断运行结果一致', () => {
    const interrupted = scenario('conflict', 5);
    const restored = JSON.parse(JSON.stringify(interrupted)) as SimState;
    const continued = tick(restored, 9);
    const reference = scenario('conflict', 14);
    expect(continued).toEqual(reference);
  });
});

describe('归约器纯净性', () => {
  it('reduce 不修改入参（撤销/重做依赖此性质）', () => {
    const s0 = scenario('conflict', 3);
    const snapshot = JSON.stringify(s0);
    reduce(s0, { type: 'tick' });
    reduce(s0, { type: 'edit', client: 'A', blockId: 'b1', text: 'x' });
    reduce(s0, { type: 'toggleNet', client: 'B' });
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe('块操作语义', () => {
  const mkOp = (partial: Partial<Op>): Op => ({
    opId: 'T#1',
    clientId: 'A',
    seq: 1,
    baseVersion: 0,
    kind: 'edit',
    blockId: 'x',
    after: null,
    text: '',
    createdAt: 0,
    ...partial,
  });

  const doc: Block[] = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ];

  it('编辑缺失的块是空操作', () => {
    expect(applyOpToBlocks(doc, mkOp({ kind: 'edit', blockId: 'zzz', text: '?' }))).toEqual(doc);
  });

  it('插入到已删除锚点之后 → 兜底追加到末尾', () => {
    const out = applyOpToBlocks(doc, mkOp({ kind: 'insert', blockId: 'n', after: 'zzz', text: 'N' }));
    expect(out.map((b) => b.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('移动到开头 / 末尾', () => {
    const front = applyOpToBlocks(doc, mkOp({ kind: 'move', blockId: 'c', after: null }));
    expect(front.map((b) => b.id)).toEqual(['c', 'a', 'b']);
    const end = applyOpToBlocks(doc, mkOp({ kind: 'move', blockId: 'a', after: 'c' }));
    expect(end.map((b) => b.id)).toEqual(['b', 'c', 'a']);
  });

  it('重复插入同 id 块退化为更新（幂等）', () => {
    const once = applyOpToBlocks(doc, mkOp({ kind: 'insert', blockId: 'n', after: 'a', text: 'N1' }));
    const twice = applyOpToBlocks(once, mkOp({ kind: 'insert', blockId: 'n', after: 'a', text: 'N2' }));
    expect(twice.filter((b) => b.id === 'n')).toHaveLength(1);
    expect(twice.find((b) => b.id === 'n')!.text).toBe('N2');
  });

  it('删除缺失的块是空操作', () => {
    expect(applyOpToBlocks(doc, mkOp({ kind: 'delete', blockId: 'zzz' }))).toEqual(doc);
  });
});
