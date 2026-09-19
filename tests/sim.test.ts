// ---------------------------------------------------------------------------
// 演练台核心测试：乱序确认、双端冲突、重连重试、重复演练、撤销重做、刷新恢复。
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { applyOp, rebase } from '../src/sim/doc';
import { initClient, makeOp, receiveSync, syncStatus } from '../src/sim/client';
import { applyAction, createSim, initialDoc, isQuiescent } from '../src/sim/sim';
import type { SimState } from '../src/sim/sim';
import { getScenario, SCENARIOS } from '../src/sim/scenarios';
import { deserializeStore, serializeStore, Store } from '../src/store/store';
import type { Block, Op, SyncMsg } from '../src/sim/types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function settle(sim: SimState, guard = 120): SimState {
  let cur = sim;
  let n = 0;
  while (!isQuiescent(cur) && n < guard) {
    cur = applyAction(cur, { type: 'tick' });
    n++;
  }
  return cur;
}

function runScenario(id: string): SimState {
  const sc = getScenario(id);
  let sim = createSim(id);
  for (const step of sc.steps) {
    sim = applyAction(sim, step.action);
  }
  return settle(sim);
}

function texts(doc: Block[]): string[] {
  return doc.map((b) => b.text);
}

function logTexts(sim: SimState): string[] {
  return sim.log.map((e) => e.text);
}

// ---------------------------------------------------------------------------
// 文档规则（冲突仲裁的基本单元）
// ---------------------------------------------------------------------------

describe('文档操作规则', () => {
  const base = initialDoc();
  const mk = (over: Partial<Op>): Op => ({
    opId: 'A-1',
    client: 'A',
    seq: 1,
    lamport: 1,
    baseVersion: 0,
    kind: 'update',
    blockId: 'b1',
    ...over,
  });

  it('并发更新按 (lamport, clientId) 仲裁，与到达顺序无关', () => {
    const opA = mk({ opId: 'A-1', client: 'A', lamport: 1, text: 'A 的措辞' });
    const opB = mk({ opId: 'B-1', client: 'B', lamport: 1, text: 'B 的措辞' });
    const r1 = applyOp(applyOp(base, opA).doc, opB); // A 先到
    const r2 = applyOp(applyOp(base, opB).doc, opA); // B 先到
    expect(r1.doc[0].text).toBe('B 的措辞'); // 同 lamport，B > A
    expect(r2.doc[0].text).toBe('B 的措辞');
    expect(r2.outcome.status).toBe('superseded'); // 迟到的 A-1 被覆盖
  });

  it('删除优先：先删后改 → 更新被丢弃；先改后删 → 块消失', () => {
    const del = mk({ kind: 'delete', blockId: 'b2' });
    const upd = mk({ kind: 'update', blockId: 'b2', text: 'x' });
    const r1 = applyOp(applyOp(base, del).doc, upd);
    expect(r1.outcome.status).toBe('dropped');
    expect(r1.doc.find((b) => b.id === 'b2')).toBeUndefined();
    const r2 = applyOp(applyOp(base, upd).doc, del);
    expect(r2.doc.find((b) => b.id === 'b2')).toBeUndefined();
  });

  it('插入锚点丢失 → 重定位到开头并给出提示', () => {
    const ins = mk({ kind: 'insert', blockId: 'blk-x', after: 'ghost', text: '新块' });
    const r = applyOp(base, ins);
    expect(r.doc[0].id).toBe('blk-x');
    expect(r.note).toContain('锚点');
  });

  it('同锚点并发插入按 (lamport, client) 排序，与到达顺序无关', () => {
    const x = mk({ opId: 'A-1', kind: 'insert', blockId: 'blk-x', after: 'b1', lamport: 1, text: 'X' });
    const y = mk({ opId: 'B-1', client: 'B', kind: 'insert', blockId: 'blk-y', after: 'b1', lamport: 2, text: 'Y' });
    const r1 = applyOp(applyOp(base, x).doc, y);
    const r2 = applyOp(applyOp(base, y).doc, x);
    expect(r1.doc.map((b) => b.id)).toEqual(r2.doc.map((b) => b.id));
    expect(r1.doc.map((b) => b.id)).toEqual(['b1', 'blk-x', 'blk-y', 'b2', 'b3', 'b4']);
  });

  it('移动遵循同一 LWW：并发的第二次移动若键更小则被覆盖', () => {
    const m1 = mk({ opId: 'A-1', kind: 'move', blockId: 'b4', after: 'b1', lamport: 2 });
    const m2 = mk({ opId: 'A-2', kind: 'move', blockId: 'b4', after: null, lamport: 1 });
    const r = applyOp(applyOp(base, m1).doc, m2);
    expect(r.outcome.status).toBe('superseded');
    expect(r.doc.map((b) => b.id)).toEqual(['b1', 'b4', 'b2', 'b3']);
  });

  it('rebase：待确认队列在新基座上重放，死操作如实上报', () => {
    const ops: Op[] = [
      mk({ opId: 'A-1', kind: 'update', blockId: 'b2', text: '改 b2' }),
      mk({ opId: 'A-2', kind: 'update', blockId: 'ghost', text: '改空气', seq: 2, lamport: 2 }),
    ];
    const { doc, results } = rebase(base, ops);
    expect(doc.find((b) => b.id === 'b2')?.text).toBe('改 b2');
    expect(results[1].outcome.status).toBe('dropped');
  });
});

// ---------------------------------------------------------------------------
// 确认处理：迟到 / 重复确认不推进、不回退
// ---------------------------------------------------------------------------

describe('确认处理', () => {
  function clientWithPending() {
    const doc = initialDoc();
    let c = initClient('A', doc);
    const op = makeOp(c, { kind: 'update', blockId: 'b1', text: 'x' });
    c = {
      ...c,
      seq: op.seq,
      lamport: op.lamport,
      confirmedVersion: 2,
      pending: [{ op, sent: true, attempts: 1 }],
    };
    return { c, op, doc };
  }

  const sync = (over: Partial<SyncMsg>): SyncMsg => ({
    kind: 'sync',
    version: 0,
    doc: initialDoc(),
    seenOpIds: [],
    outcomes: {},
    causeOpId: null,
    ...over,
  });

  it('迟到确认被忽略，已确认版本与文档不回退', () => {
    const { c } = clientWithPending();
    const r = receiveSync(c, sync({ version: 1 }));
    expect(r.client.confirmedVersion).toBe(2);
    expect(r.client.pending.length).toBe(1);
    expect(r.events[0].text).toContain('迟到确认已忽略');
  });

  it('重复确认被忽略，待确认队列不二次清理', () => {
    const { c } = clientWithPending();
    const r = receiveSync(c, sync({ version: 2 }));
    expect(r.client.confirmedVersion).toBe(2);
    expect(r.client.pending.length).toBe(1);
    expect(r.events[0].text).toContain('重复确认已忽略');
  });

  it('正常确认清理队列；同一条确认再来一次不会二次推进', () => {
    const { c, op } = clientWithPending();
    const ack = sync({ version: 3, seenOpIds: [op.opId], outcomes: { [op.opId]: { status: 'applied' } } });
    const r1 = receiveSync(c, ack);
    expect(r1.client.pending.length).toBe(0);
    expect(r1.client.confirmedVersion).toBe(3);
    const r2 = receiveSync(r1.client, ack);
    expect(r2.client.confirmedVersion).toBe(3);
    expect(r2.client.pending.length).toBe(0);
    expect(r2.events[0].text).toContain('重复确认已忽略');
  });

  it('同步状态徽章：有待确认时绝不显示「已同步」', () => {
    const { c } = clientWithPending();
    expect(syncStatus(c, true).kind).toBe('pending');
    const clean = { ...c, pending: [] };
    expect(syncStatus(clean, true).kind).toBe('synced');
    expect(syncStatus({ ...clean, fakeSynced: true }, true).kind).toBe('fake-synced');
  });
});

// ---------------------------------------------------------------------------
// 场景演练
// ---------------------------------------------------------------------------

describe('场景：乱序确认与迟到确认', () => {
  it('A 先收到 v2（版本跳跃），迟到的 v1 被忽略，三方收敛', () => {
    const sim = runScenario('ooo-acks');
    expect(sim.server.version).toBe(2);
    expect(sim.clients.A.confirmedVersion).toBe(2);
    expect(sim.clients.B.confirmedVersion).toBe(2);
    expect(sim.clients.A.pending.length).toBe(0);
    const logs = logTexts(sim);
    expect(logs.some((t) => t.includes('版本跳跃'))).toBe(true);
    expect(logs.some((t) => t.includes('迟到确认已忽略'))).toBe(true);
    expect(JSON.stringify(sim.clients.A.confirmedDoc)).toBe(JSON.stringify(sim.server.doc));
    expect(JSON.stringify(sim.clients.B.confirmedDoc)).toBe(JSON.stringify(sim.server.doc));
  });
});

describe('场景：双端离线冲突与合并来源', () => {
  it('b3 归 B、b4 被删、A 的插入保留，仲裁结果可追溯', () => {
    const sim = runScenario('dual-conflict');
    expect(sim.server.version).toBe(5);
    const doc = sim.server.doc;
    expect(doc.find((b) => b.id === 'b3')?.text).toContain('B 的措辞');
    expect(doc.find((b) => b.id === 'b4')).toBeUndefined();
    expect(doc.some((b) => b.id === 'blk-a-3')).toBe(true);
    // 合并来源
    expect(doc.find((b) => b.id === 'b3')?.updatedOpId).toBe('B-1');
    // 仲裁追溯
    expect(sim.server.outcomes['A-1']).toEqual({ status: 'superseded', by: 'B-1' });
    expect(sim.server.outcomes['A-2']).toEqual({ status: 'superseded', by: 'B-2' });
    // A 也通过后续 sync 学到了自己被覆盖的结局
    expect(sim.clients.A.knownOutcomes['A-1']).toEqual({ status: 'superseded', by: 'B-1' });
    // 三方收敛
    expect(JSON.stringify(sim.clients.A.confirmedDoc)).toBe(JSON.stringify(doc));
    expect(JSON.stringify(sim.clients.B.confirmedDoc)).toBe(JSON.stringify(doc));
    expect(sim.clients.A.pending.length).toBe(0);
    expect(sim.clients.B.pending.length).toBe(0);
  });
});

describe('场景：重连冲刷与重复重试（幂等）', () => {
  it('队列按因果序应用；重复重试不推进版本；重复确认被忽略', () => {
    const sim = runScenario('reconnect-retry');
    expect(sim.server.version).toBe(3); // 不是 6
    expect(sim.server.seenOpIds).toEqual(['A-1', 'A-2', 'A-3']);
    const logs = logTexts(sim);
    expect(logs.filter((t) => t.includes('重复操作') && t.includes('幂等')).length).toBe(3);
    expect(logs.some((t) => t.includes('重复确认已忽略'))).toBe(true);
    // 因果顺序：应用日志按 A-1 → A-2 → A-3 出现
    const applied = logs.filter((t) => t.startsWith('应用 A-'));
    expect(applied.map((t) => t.slice(3, 6))).toEqual(['A-1', 'A-2', 'A-3']);
    // 移动生效：b4 在 b1 之后
    expect(sim.server.doc.map((b) => b.id)).toEqual(['b1', 'b4', 'b2', 'b3']);
    expect(JSON.stringify(sim.clients.A.confirmedDoc)).toBe(JSON.stringify(sim.server.doc));
  });
});

describe('场景：旧快照回灌（线上 bug 复现）', () => {
  it('回灌后 A 回退到 v0、待确认丢失、显示假「已同步」，服务端不受影响', () => {
    const sim = runScenario('stale-clobber');
    expect(sim.server.version).toBe(1);
    const a = sim.clients.A;
    expect(a.confirmedVersion).toBe(0);
    expect(a.pending.length).toBe(0);
    expect(a.fakeSynced).toBe(true);
    expect(syncStatus(a, true).label).toContain('假象');
    // 服务端与 B 持有 v1 的正确数据，A 的急改丢失
    expect(sim.server.doc.find((b) => b.id === 'b2')?.text).toContain('v1 确认稿');
    expect(sim.clients.B.confirmedVersion).toBe(1);
    const logs = logTexts(sim);
    expect(logs.some((t) => t.includes('旧快照回灌'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 重复演练：同一脚本跑两遍，结果逐字节一致
// ---------------------------------------------------------------------------

describe('重复演练（确定性）', () => {
  it.each(SCENARIOS.filter((s) => s.steps.length > 0).map((s) => s.id))(
    '场景 %s 连跑两遍结果一致',
    (id) => {
      const first = JSON.stringify(runScenario(id));
      const second = JSON.stringify(runScenario(id));
      expect(second).toBe(first);
    },
  );

  it('通过 store 重置后再演练，结果一致', () => {
    const st = new Store();
    st.loadScenario('ooo-acks');
    const total = getScenario('ooo-acks').steps.length;
    for (let i = 0; i < total; i++) st.step();
    const first = JSON.stringify(st.getState().sim);
    st.reset();
    for (let i = 0; i < total; i++) st.step();
    expect(JSON.stringify(st.getState().sim)).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 撤销 / 重做
// ---------------------------------------------------------------------------

describe('撤销与重做', () => {
  it('撤销回到初始，重做精确还原', () => {
    const st = new Store();
    st.loadScenario('free');
    const initial = JSON.stringify(st.getState().sim);
    st.run({ type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b1', text: '改过的标题' } });
    st.run({ type: 'tick' });
    st.run({ type: 'tick' });
    const after = JSON.stringify(st.getState().sim);
    expect(after).not.toBe(initial);
    st.undo();
    st.undo();
    st.undo();
    expect(JSON.stringify(st.getState().sim)).toBe(initial);
    expect(st.getState().past.length).toBe(0);
    st.redo();
    st.redo();
    st.redo();
    expect(JSON.stringify(st.getState().sim)).toBe(after);
  });

  it('新操作清空重做栈', () => {
    const st = new Store();
    st.loadScenario('free');
    st.run({ type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b1', text: 'v1' } });
    st.undo();
    st.run({ type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b1', text: 'v2' } });
    expect(st.getState().future.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 刷新恢复：序列化往返
// ---------------------------------------------------------------------------

describe('刷新恢复（持久化）', () => {
  it('serialize → deserialize 往返后状态一致', () => {
    const st = new Store();
    st.loadScenario('free');
    st.run({ type: 'edit', client: 'B', spec: { kind: 'insert', after: 'b1', text: '新段落' } });
    st.run({ type: 'toggleLink', client: 'A' });
    st.run({ type: 'tick' });
    const json = serializeStore(st.getState());
    const shape = deserializeStore(json);
    expect(shape).not.toBeNull();
    expect(JSON.stringify(shape!.sim)).toBe(JSON.stringify(st.getState().sim));
    expect(JSON.stringify(shape!.past)).toBe(JSON.stringify(st.getState().past.slice(-80)));
  });

  it('损坏的存档安全降级为 null', () => {
    expect(deserializeStore('not json')).toBeNull();
    expect(deserializeStore('{"sim":{}}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 自由操作组合：断网编辑 → 恢复 → 立即重试 → 回执延迟（端到端）
// ---------------------------------------------------------------------------

describe('端到端自由组合', () => {
  it('断网连续编辑后恢复并立即重试，最终恰好收敛一次', () => {
    let sim = createSim('free');
    sim = applyAction(sim, { type: 'toggleLink', client: 'A' });
    sim = applyAction(sim, { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b1', text: '终稿' } });
    sim = applyAction(sim, { type: 'edit', client: 'A', spec: { kind: 'delete', blockId: 'b4' } });
    sim = applyAction(sim, { type: 'toggleLink', client: 'A' });
    sim = applyAction(sim, { type: 'retry', client: 'A' });
    sim = applyAction(sim, { type: 'injectMatch', match: { to: 'A', payloadKind: 'sync', version: 1 }, fault: 'delay' });
    sim = settle(sim);
    expect(sim.server.version).toBe(2);
    expect(sim.server.doc.find((b) => b.id === 'b4')).toBeUndefined();
    expect(texts(sim.server.doc)[0]).toBe('终稿');
    expect(sim.clients.A.pending.length).toBe(0);
    expect(JSON.stringify(sim.clients.A.confirmedDoc)).toBe(JSON.stringify(sim.server.doc));
    const logs = logTexts(sim);
    expect(logs.some((t) => t.includes('重复操作') && t.includes('幂等'))).toBe(true);
  });
});
