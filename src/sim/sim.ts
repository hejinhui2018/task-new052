// ---------------------------------------------------------------------------
// 模拟世界：服务端 + 双客户端 + 网络 + 事件日志。
// applyAction 是唯一入口（UI 与测试共用），纯数据进、新数据出（内部深拷贝）。
// 全程无随机、无时钟，同一动作序列必然得到同一结果（重复演练可复现）。
// ---------------------------------------------------------------------------

import { clobber, deriveDraft, initClient, makeOp, receiveSync } from './client';
import type { ClientState } from './client';
import { initNetwork, deliverDue, injectMatch, injectOn, sendEnvelope, FAULT_LABEL } from './network';
import type { EnvelopeMatch, NetworkState } from './network';
import { initServer, serverReceive } from './server';
import type { ServerState } from './server';
import { CLIENTS, opLabel } from './types';
import type {
  Block,
  ClientId,
  EditSpec,
  FaultKind,
  LogActor,
  LogEntry,
  LogTone,
} from './types';

export interface SimState {
  tick: number;
  server: ServerState;
  clients: Record<ClientId, ClientState>;
  net: NetworkState;
  log: LogEntry[];
  logSeq: number;
  scenarioId: string;
  stepIndex: number;
}

export type SimAction =
  | { type: 'edit'; client: ClientId; spec: EditSpec }
  | { type: 'tick' }
  | { type: 'ticks'; n: number }
  | { type: 'toggleLink'; client: ClientId }
  | { type: 'retry'; client: ClientId }
  | { type: 'injectNext'; fault: FaultKind }
  | { type: 'injectOn'; envId: string; fault: FaultKind }
  | { type: 'injectMatch'; match: EnvelopeMatch; fault: FaultKind }
  | { type: 'clobber'; client: ClientId };

/** 初始发布说明文档（锚点成链，来源为服务端 S）。 */
export function initialDoc(): Block[] {
  const rows: Array<[string, string]> = [
    ['b1', '发布说明 v2.4 — 展会现场版'],
    ['b2', '新增：批量导入日程'],
    ['b3', '修复：离线时偶发草稿丢失'],
    ['b4', '已知问题：弱网下同步延迟'],
  ];
  let prev: string | null = null;
  return rows.map(([id, text]) => {
    const b: Block = {
      id,
      text,
      updatedBy: 'S',
      updatedLamport: 0,
      updatedOpId: 'init',
      anchor: prev,
      posLamport: 0,
      posBy: 'S',
    };
    prev = id;
    return b;
  });
}

export function createSim(scenarioId: string): SimState {
  const doc = initialDoc();
  const sim: SimState = {
    tick: 0,
    server: initServer(doc),
    clients: { A: initClient('A', doc), B: initClient('B', doc) },
    net: initNetwork(),
    log: [],
    logSeq: 0,
    scenarioId,
    stepIndex: 0,
  };
  pushLog(sim, 'SYS', '演练台就绪：双客户端在线，与服务端同处 v0', 'info');
  return sim;
}

function pushLog(sim: SimState, actor: LogActor, text: string, tone: LogTone): void {
  sim.logSeq += 1;
  sim.log.push({ seq: sim.logSeq, tick: sim.tick, actor, text, tone });
  if (sim.log.length > 400) sim.log.splice(0, sim.log.length - 400);
}

/** 把客户端未发送的待确认操作依次发出去（在队列顺序 = 因果顺序）。 */
function flushClient(sim: SimState, cid: ClientId): void {
  const c = sim.clients[cid];
  for (const p of c.pending) {
    if (p.sent) continue;
    const r = sendEnvelope(sim.net, cid, 'S', { kind: 'op', op: p.op }, `${p.op.opId} ${opLabel(p.op)}`, sim.tick);
    sim.net = r.net;
    r.events.forEach((e) => pushLog(sim, 'NET', e.text, e.tone));
    p.sent = true;
    p.attempts += 1;
  }
}

function tickOnce(sim: SimState): void {
  sim.tick += 1;
  const { net, due } = deliverDue(sim.net, sim.tick);
  sim.net = net;

  for (const env of due) {
    if (env.payload.kind === 'op') {
      const rx = serverReceive(sim.server, env.payload.op);
      sim.server = rx.server;
      rx.events.forEach((e) => pushLog(sim, 'S', e.text, e.tone));
      // 广播全量 sync 给两台客户端
      for (const cid of CLIENTS) {
        const r = sendEnvelope(
          sim.net,
          'S',
          cid,
          rx.sync,
          `sync v${rx.sync.version}（确认 ${rx.sync.causeOpId ?? '—'}）`,
          sim.tick,
        );
        sim.net = r.net;
        r.events.forEach((e) => pushLog(sim, 'NET', e.text, e.tone));
      }
    } else {
      const cid = env.to as ClientId;
      const rx = receiveSync(sim.clients[cid], env.payload);
      sim.clients[cid] = rx.client;
      rx.events.forEach((e) => pushLog(sim, cid, e.text, e.tone));
    }
  }

  // 在线客户端自动补发未发送的队列（重连冲刷也靠这一步）
  for (const cid of CLIENTS) {
    if (sim.net.links[cid]) flushClient(sim, cid);
  }
}

export function applyAction(state: SimState, action: SimAction): SimState {
  const sim = structuredClone(state);

  switch (action.type) {
    case 'edit': {
      const c = sim.clients[action.client];
      const op = makeOp(c, action.spec);
      c.seq = op.seq;
      c.lamport = op.lamport;
      c.pending.push({ op, sent: false, attempts: 0 });
      c.fakeSynced = false;
      const where = sim.net.links[action.client] ? '' : '（离线，已入队）';
      pushLog(sim, action.client, `本地${opLabel(op)} → ${op.opId}（基于 v${op.baseVersion}）${where}`, 'info');
      if (sim.net.links[action.client]) flushClient(sim, action.client);
      break;
    }
    case 'tick':
      tickOnce(sim);
      break;
    case 'ticks':
      for (let i = 0; i < action.n; i++) tickOnce(sim);
      break;
    case 'toggleLink': {
      const cid = action.client;
      sim.net.links[cid] = !sim.net.links[cid];
      const on = sim.net.links[cid];
      pushLog(sim, 'NET', `链路 ${cid}⇄S ${on ? '恢复' : '断开'}`, on ? 'ok' : 'err');
      if (on) flushClient(sim, cid);
      break;
    }
    case 'retry': {
      const cid = action.client;
      const c = sim.clients[cid];
      if (!sim.net.links[cid]) {
        pushLog(sim, cid, `离线中，无法重试（${c.pending.length} 条仍在队列）`, 'warn');
        break;
      }
      if (c.pending.length === 0) {
        pushLog(sim, cid, '没有待确认操作，无需重试', 'info');
        break;
      }
      for (const p of c.pending) {
        const r = sendEnvelope(sim.net, cid, 'S', { kind: 'op', op: p.op }, `${p.op.opId} ${opLabel(p.op)}（重试）`, sim.tick);
        sim.net = r.net;
        r.events.forEach((e) => pushLog(sim, 'NET', e.text, e.tone));
        p.sent = true;
        p.attempts += 1;
      }
      pushLog(sim, cid, `重试 ${c.pending.length} 条未确认操作（可能产生重复消息）`, 'warn');
      break;
    }
    case 'injectNext':
      sim.net.queuedFaults.push(action.fault);
      pushLog(sim, 'NET', `已预排故障「${FAULT_LABEL[action.fault]}」：将作用于下一条发出的消息`, 'fault');
      break;
    case 'injectOn': {
      const r = injectOn(sim.net, action.envId, action.fault);
      sim.net = r.net;
      r.events.forEach((e) => pushLog(sim, 'NET', e.text, e.tone));
      break;
    }
    case 'injectMatch': {
      const r = injectMatch(sim.net, action.match, action.fault);
      sim.net = r.net;
      r.events.forEach((e) => pushLog(sim, 'NET', e.text, e.tone));
      break;
    }
    case 'clobber': {
      const cid = action.client;
      const rx = clobber(sim.clients[cid]);
      sim.clients[cid] = rx.client;
      rx.events.forEach((e) => pushLog(sim, cid, e.text, e.tone));
      break;
    }
  }
  return sim;
}

/** 是否归于平静：没有在途消息，也没有"在线却未发送"的操作。 */
export function isQuiescent(sim: SimState): boolean {
  if (sim.net.envelopes.length > 0) return false;
  return !CLIENTS.some(
    (cid) => sim.net.links[cid] && sim.clients[cid].pending.some((p) => !p.sent),
  );
}

/** 场景脚本跑完且网络平静 → 演练结束。 */
export function isDone(sim: SimState, scenarioStepCount: number): boolean {
  return sim.stepIndex >= scenarioStepCount && isQuiescent(sim);
}

export { deriveDraft };
export type { EnvelopeMatch };
