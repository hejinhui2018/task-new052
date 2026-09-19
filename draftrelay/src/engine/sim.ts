// ---------------------------------------------------------------------------
// DraftRelay 模拟引擎：纯函数状态机
//   reduce(state, action) -> newState   （不修改入参，可快照、可撤销、可持久化）
// 时间只随 tick 推进；消息在 tick 的投递阶段到达；发送/重试在 tick 末尾发生。
// ---------------------------------------------------------------------------

import {
  CLIENTS,
  type Block,
  type ClientId,
  type ClientState,
  type Envelope,
  type EventActor,
  type EventKind,
  type FaultKind,
  type Message,
  type Op,
  type PendingOp,
  type ServerEntry,
  type SimAction,
  type SimState,
} from './types';
import { applyOpToBlocks, clientView, mulberry32, OP_KIND_LABEL, shortText } from './core';
import { SCENARIOS } from './scenarios';

export const LATENCY_TICKS = 1; // 基础网络延迟（tick）
export const RETRY_TICKS = 6; // 未收到确认后的重试间隔
export const DEFAULT_SEED = 42;
const MAX_EVENTS = 400;
const PRUNE_AGE_TICKS = 4; // 已完成消息在网络上保留展示的拍数

// ---------------------------------------------------------------- 初始状态

export function initialSim(seed: number): SimState {
  const blocks: Block[] = [
    { id: 'b1', text: '# v2.4.0 发布说明' },
    { id: 'b2', text: '- 新增：离线草稿自动保存' },
    { id: 'b3', text: '- 修复：同步状态误报' },
    { id: 'b4', text: '- 已知问题：弱网下重试风暴' },
  ];
  const blockMeta = Object.fromEntries(
    blocks.map((b) => [b.id, { by: 'server' as const, version: 0 }]),
  );
  const mkClient = (id: ClientId): ClientState => ({
    id,
    online: true,
    nextSeq: 1,
    serverVersion: 0,
    base: blocks.map((b) => ({ ...b })),
    pending: [],
    ignoredAcks: 0,
    droppedOps: 0,
  });
  const s: SimState = {
    time: 0,
    rng: seed >>> 0,
    server: {
      version: 0,
      blocks: blocks.map((b) => ({ ...b })),
      log: [],
      seenOpIds: [],
      lastSeq: { A: 0, B: 0 },
      held: { A: [], B: [] },
      blockMeta,
      duplicatesRejected: 0,
    },
    clients: { A: mkClient('A'), B: mkClient('B') },
    inFlight: [],
    events: [],
    faults: { dropNext: 0, duplicateNext: 0, delayNext: 0, reorderNext: false, chaos: false },
    nextEnvId: 1,
    nextEventId: 1,
    script: null,
    stats: { sent: 0, delivered: 0, dropped: 0, retries: 0, duplicated: 0 },
  };
  log(s, 'info', 'sys', `演练台初始化完成（种子 ${seed}），初始文档 ${blocks.length} 个块`);
  return s;
}

// ---------------------------------------------------------------- 归约器

export function reduce(state: SimState, action: SimAction): SimState {
  if (action.type === 'reset') return initialSim(DEFAULT_SEED);
  if (action.type === 'loadScript') return loadScript(action.name);
  const s = structuredClone(state);
  applyAction(s, action);
  return s;
}

function applyAction(s: SimState, action: SimAction): void {
  switch (action.type) {
    case 'tick':
      tick(s);
      break;
    case 'edit':
    case 'insert':
    case 'delete':
    case 'move':
      doLocalOp(s, action);
      break;
    case 'toggleNet':
      doToggleNet(s, action.client);
      break;
    case 'fault':
      doFault(s, action.fault);
      break;
    case 'loadScript':
    case 'reset':
      break; // 不可嵌套
  }
}

function loadScript(name: string): SimState {
  const fresh = initialSim(DEFAULT_SEED);
  const sc = SCENARIOS[name];
  if (sc) {
    fresh.script = { name, steps: sc.steps.map((st) => ({ ...st })) };
    log(fresh, 'info', 'sys', `已装载演练脚本「${sc.label}」：${sc.desc}（共 ${sc.steps.length} 个步骤）`);
  }
  return fresh;
}

// ---------------------------------------------------------------- 事件日志

function log(s: SimState, kind: EventKind, actor: EventActor, text: string): void {
  s.events.push({ id: s.nextEventId++, time: s.time, kind, actor, text });
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
}

// ---------------------------------------------------------------- 本地操作

type LocalOpAction = Extract<SimAction, { type: 'edit' | 'insert' | 'delete' | 'move' }>;

function doLocalOp(s: SimState, action: LocalOpAction): void {
  const c = s.clients[action.client];

  // move 需要先根据当前视图解析锚点；无效移动不消耗序号（避免服务端乱序缓存空等）
  let moveAfter: string | null = null;
  if (action.type === 'move') {
    const computed = computeMoveAfter(clientView(c), action.blockId, action.dir);
    if (computed === undefined) {
      log(s, 'info', c.id, `${c.id} 的块 ${action.blockId} 已在边界，移动被忽略`);
      return;
    }
    moveAfter = computed;
  }

  const seq = c.nextSeq++;
  const base = {
    clientId: c.id,
    seq,
    baseVersion: c.serverVersion,
    createdAt: s.time,
    text: '',
    after: null as string | null,
    sendCount: 0,
    lastSentAt: null as number | null,
    conflictNote: null as string | null,
  };
  let op: PendingOp;
  switch (action.type) {
    case 'edit':
      op = { ...base, opId: `${c.id}#${seq}`, kind: 'edit', blockId: action.blockId, text: action.text };
      break;
    case 'insert':
      op = {
        ...base,
        opId: `${c.id}#${seq}`,
        kind: 'insert',
        blockId: `${c.id}-new${seq}`,
        after: action.after,
        text: action.text,
      };
      break;
    case 'delete':
      op = { ...base, opId: `${c.id}#${seq}`, kind: 'delete', blockId: action.blockId };
      break;
    case 'move':
      op = { ...base, opId: `${c.id}#${seq}`, kind: 'move', blockId: action.blockId, after: moveAfter };
      break;
  }
  c.pending.push(op);
  const detail = op.kind === 'edit' || op.kind === 'insert' ? `“${shortText(op.text)}”` : '';
  log(
    s,
    'op',
    c.id,
    `${c.id} 本地${OP_KIND_LABEL[op.kind]} ${op.blockId} ${detail}（基于 v${op.baseVersion}）→ 入队 ${op.opId}`,
  );
}

function computeMoveAfter(
  view: Block[],
  blockId: string,
  dir: -1 | 1,
): string | null | undefined {
  const i = view.findIndex((b) => b.id === blockId);
  if (i < 0) return undefined;
  if (dir === -1) {
    if (i === 0) return undefined;
    return i >= 2 ? view[i - 2].id : null;
  }
  if (i === view.length - 1) return undefined;
  return view[i + 1].id;
}

// ---------------------------------------------------------------- 网络开关

function doToggleNet(s: SimState, clientId: ClientId): void {
  const c = s.clients[clientId];
  c.online = !c.online;
  if (!c.online) {
    log(s, 'link', c.id, `${c.id} 网络断开 —— 之后的编辑将暂存本地队列`);
  } else {
    log(s, 'link', c.id, `${c.id} 网络恢复，发送握手请求追赶（本地已知 v${c.serverVersion}）`);
    sendEnvelope(s, { type: 'hello', from: c.id, to: 'server', lastVersion: c.serverVersion });
  }
}

// ---------------------------------------------------------------- 故障注入

function doFault(s: SimState, fault: 'drop' | 'duplicate' | 'delay' | 'reorder' | 'chaos'): void {
  switch (fault) {
    case 'drop':
      s.faults.dropNext++;
      log(s, 'fault', 'net', '故障注入：下一条消息将被【丢弃】');
      break;
    case 'duplicate':
      s.faults.duplicateNext++;
      log(s, 'fault', 'net', '故障注入：下一条消息将被【复制】');
      break;
    case 'delay':
      s.faults.delayNext++;
      log(s, 'fault', 'net', '故障注入：下一条消息将被【延迟 3 拍】');
      break;
    case 'reorder':
      s.faults.reorderNext = true;
      log(s, 'fault', 'net', '故障注入：下一条消息将被【乱序】（晚于其后一条到达）');
      break;
    case 'chaos':
      s.faults.chaos = !s.faults.chaos;
      log(
        s,
        'fault',
        'net',
        s.faults.chaos ? '混沌模式开启：每条消息随机丢弃/复制/延迟' : '混沌模式关闭',
      );
      break;
  }
}

// ---------------------------------------------------------------- tick 推进

function tick(s: SimState): void {
  s.time++;

  // 1) 演练脚本到点步骤
  if (s.script) {
    for (const st of s.script.steps) {
      if (st.at === s.time && st.action.type !== 'tick') {
        log(s, 'info', 'sys', `脚本步骤 @t${st.at}`);
        applyAction(s, st.action);
      }
    }
  }

  // 2) 投递到期消息（按送达时间 + 创建顺序，保证确定性）
  const due = s.inFlight
    .filter((e) => !e.dropped && e.doneAt == null && e.deliverAt <= s.time)
    .sort((a, b) => a.deliverAt - b.deliverAt || a.id - b.id);
  for (const env of due) {
    const linkUp =
      env.msg.to === 'server' ? s.clients[env.msg.from].online : s.clients[env.msg.to].online;
    if (!linkUp) {
      env.dropped = true;
      env.doneAt = s.time;
      s.stats.dropped++;
      log(s, 'drop', 'net', `链路已断开，丢失 ${msgLabel(env.msg)}`);
      continue;
    }
    env.doneAt = s.time;
    s.stats.delivered++;
    deliver(s, env.msg);
  }

  // 3) 清理已完成的老消息
  s.inFlight = s.inFlight.filter((e) => e.doneAt == null || s.time - e.doneAt <= PRUNE_AGE_TICKS);

  // 4) 各客户端发送待确认操作 / 超时重试
  for (const id of CLIENTS) {
    const c = s.clients[id];
    if (!c.online) continue;
    for (const p of c.pending) {
      if (p.lastSentAt == null || s.time - p.lastSentAt >= RETRY_TICKS) {
        p.sendCount++;
        if (p.sendCount > 1) {
          s.stats.retries++;
          log(s, 'send', c.id, `${c.id} 重试 ${p.opId}（第 ${p.sendCount} 次发送，未收到确认）`);
        } else {
          log(
            s,
            'send',
            c.id,
            `${c.id} → 服务端：${p.opId} ${OP_KIND_LABEL[p.kind]} ${p.blockId}（基于 v${p.baseVersion}）`,
          );
        }
        p.lastSentAt = s.time;
        sendEnvelope(s, { type: 'op', from: c.id, to: 'server', op: stripPending(p) });
      }
    }
  }
}

function stripPending(p: PendingOp): Op {
  return {
    opId: p.opId,
    clientId: p.clientId,
    seq: p.seq,
    baseVersion: p.baseVersion,
    kind: p.kind,
    blockId: p.blockId,
    after: p.after,
    text: p.text,
    createdAt: p.createdAt,
  };
}

// ---------------------------------------------------------------- 消息收发

function msgLabel(msg: Message): string {
  switch (msg.type) {
    case 'op':
      return `${msg.from}→服务端 ${msg.op.opId}`;
    case 'hello':
      return `${msg.from}→服务端 握手`;
    case 'state':
      return `服务端→${msg.to} ${msg.ackOpId ? `确认 ${msg.ackOpId}` : '同步'} v${msg.version}`;
  }
}

const FAULT_LABEL: Record<FaultKind, string> = {
  dropped: '丢弃',
  duplicated: '复制',
  delayed: '延迟',
  reordered: '乱序',
};

function sendEnvelope(s: SimState, msg: Message): void {
  let deliverAt = s.time + LATENCY_TICKS;
  let fault: FaultKind | null = null;
  let drop = false;
  let dup = false;

  if (s.faults.dropNext > 0) {
    s.faults.dropNext--;
    drop = true;
    fault = 'dropped';
  } else if (s.faults.duplicateNext > 0) {
    s.faults.duplicateNext--;
    dup = true;
    fault = 'duplicated';
  } else if (s.faults.delayNext > 0) {
    s.faults.delayNext--;
    deliverAt += 3;
    fault = 'delayed';
  } else if (s.faults.reorderNext) {
    s.faults.reorderNext = false;
    deliverAt += 2;
    fault = 'reordered';
  } else if (s.faults.chaos) {
    const [next, r] = mulberry32(s.rng);
    s.rng = next;
    if (r < 0.15) {
      drop = true;
      fault = 'dropped';
    } else if (r < 0.25) {
      dup = true;
      fault = 'duplicated';
    } else if (r < 0.45) {
      deliverAt += 3;
      fault = 'delayed';
    }
  }

  const env: Envelope = {
    id: s.nextEnvId++,
    msg,
    sentAt: s.time,
    deliverAt,
    fault,
    dropped: drop,
    doneAt: drop ? s.time : null,
  };
  s.inFlight.push(env);
  s.stats.sent++;
  if (drop) {
    s.stats.dropped++;
    log(s, 'drop', 'net', `网络丢弃 ${msgLabel(msg)}（故障：${FAULT_LABEL[fault ?? 'dropped']}）`);
  }
  if (dup) {
    s.stats.duplicated++;
    s.inFlight.push({
      id: s.nextEnvId++,
      msg,
      sentAt: s.time,
      deliverAt,
      fault: 'duplicated',
      dropped: false,
      doneAt: null,
    });
    log(s, 'fault', 'net', `复制消息 ${msgLabel(msg)}（故障：复制）`);
  }
}

function deliver(s: SimState, msg: Message): void {
  switch (msg.type) {
    case 'op':
      serverOnOp(s, msg.from, msg.op);
      break;
    case 'hello':
      serverOnHello(s, msg.from, msg.lastVersion);
      break;
    case 'state':
      clientOnState(s, msg.to, msg);
      break;
  }
}

// ---------------------------------------------------------------- 服务端

function makeStateMsg(
  s: SimState,
  to: ClientId,
  entries: ServerEntry[],
  ackOpId: string | null,
): Message {
  const srv = s.server;
  return {
    type: 'state',
    from: 'server',
    to,
    version: srv.version,
    blocks: srv.blocks.map((b) => ({ ...b })),
    blockMeta: { ...srv.blockMeta },
    entries,
    ackOpId,
  };
}

function serverOnOp(s: SimState, from: ClientId, op: Op): void {
  const srv = s.server;
  log(s, 'deliver', 'server', `服务端收到 ${op.opId}`);

  // 幂等：同一 opId 永不应用两次 —— 重复重试不能推进版本
  if (srv.seenOpIds.includes(op.opId)) {
    srv.duplicatesRejected++;
    log(s, 'ignore', 'server', `服务端忽略重复操作 ${op.opId}（幂等，版本保持 v${srv.version}），仅重发确认`);
    sendEnvelope(s, makeStateMsg(s, from, [], op.opId));
    return;
  }

  // 因果顺序：同一客户端的操作必须按序号应用，乱序到达的先缓存
  if (op.seq > srv.lastSeq[from] + 1) {
    srv.held[from].push(op);
    srv.held[from].sort((a, b) => a.seq - b.seq);
    log(s, 'info', 'server', `服务端缓存乱序操作 ${op.opId}（等待 ${from}#${srv.lastSeq[from] + 1}）`);
    return;
  }

  applyServerOp(s, op);

  // 前驱补齐后，冲刷乱序缓存
  for (;;) {
    const want = srv.lastSeq[from] + 1;
    const i = srv.held[from].findIndex((o) => o.seq === want);
    if (i < 0) break;
    const [held] = srv.held[from].splice(i, 1);
    if (srv.seenOpIds.includes(held.opId)) {
      srv.duplicatesRejected++;
      continue;
    }
    log(s, 'info', 'server', `乱序缓存补齐，取出应用 ${held.opId}`);
    applyServerOp(s, held);
  }
}

function applyServerOp(s: SimState, op: Op): void {
  const srv = s.server;

  let note: string | null = null;
  const targetExists = srv.blocks.some((b) => b.id === op.blockId);
  if ((op.kind === 'edit' || op.kind === 'delete' || op.kind === 'move') && !targetExists) {
    note = '目标块已不存在，效果为空';
  }
  if (op.kind === 'insert' && op.after != null && !srv.blocks.some((b) => b.id === op.after)) {
    note = '锚点块已不存在，追加到末尾';
  }

  // 并发检测：该操作基于的版本之后，已有别人改动了同一块 → 覆盖发生
  const meta = srv.blockMeta[op.blockId];
  const concurrentWith =
    meta && meta.version > op.baseVersion && meta.by !== op.clientId
      ? { by: meta.by, version: meta.version }
      : null;

  srv.blocks = applyOpToBlocks(srv.blocks, op);
  srv.version++;
  srv.lastSeq[op.clientId] = op.seq;
  srv.seenOpIds.push(op.opId);
  const entry: ServerEntry = { version: srv.version, op, concurrentWith, note };
  srv.log.push(entry);
  srv.blockMeta[op.blockId] = { by: op.clientId, version: srv.version };

  const extra = concurrentWith
    ? `，覆盖 ${concurrentWith.by} 在 v${concurrentWith.version} 的并发修改`
    : '';
  log(
    s,
    'apply',
    'server',
    `服务端应用 ${op.opId} → v${srv.version}（基于 v${op.baseVersion}）${extra}${note ? `，${note}` : ''}`,
  );

  // 确认发给来源客户端，同步广播给其他客户端
  sendEnvelope(s, makeStateMsg(s, op.clientId, [entry], op.opId));
  for (const other of CLIENTS) {
    if (other !== op.clientId) sendEnvelope(s, makeStateMsg(s, other, [entry], null));
  }
}

function serverOnHello(s: SimState, from: ClientId, lastVersion: number): void {
  const srv = s.server;
  const entries = srv.log.filter((e) => e.version > lastVersion);
  log(
    s,
    'deliver',
    'server',
    `服务端收到 ${from} 的握手（对方已知 v${lastVersion}），回传 v${lastVersion}→v${srv.version} 的 ${entries.length} 条变更`,
  );
  sendEnvelope(s, makeStateMsg(s, from, entries, null));
}

// ---------------------------------------------------------------- 客户端

function clientOnState(
  s: SimState,
  clientId: ClientId,
  msg: Extract<Message, { type: 'state' }>,
): void {
  const c = s.clients[clientId];

  // 迟到的旧状态：绝不回滚
  if (msg.version < c.serverVersion) {
    c.ignoredAcks++;
    log(s, 'ignore', c.id, `${c.id} 忽略过期的服务端状态 v${msg.version}（本地已至 v${c.serverVersion}）`);
    return;
  }
  if (msg.version === c.serverVersion) {
    // 同版本：只可能是确认（或握手空响应）
    if (msg.ackOpId) {
      const i = c.pending.findIndex((p) => p.opId === msg.ackOpId);
      if (i >= 0) {
        c.pending.splice(i, 1);
        log(s, 'ack', c.id, `${c.id} 确认 ${msg.ackOpId} @v${msg.version}`);
      } else {
        // 重复确认：幂等忽略，不重复推进
        c.ignoredAcks++;
        log(s, 'ignore', c.id, `${c.id} 忽略重复的确认 ${msg.ackOpId}（幂等，不重复推进）`);
      }
    }
    return;
  }

  // 接受更新的服务端状态
  const oldBase = c.base;
  c.serverVersion = msg.version;
  c.base = msg.blocks;

  // 已确认的操作出队（ack 或出现在新日志条目中的自有操作）
  const confirmed = new Set(msg.entries.map((e) => e.op.opId));
  if (msg.ackOpId) confirmed.add(msg.ackOpId);
  c.pending = c.pending.filter((p) => !confirmed.has(p.opId));
  if (msg.ackOpId) log(s, 'ack', c.id, `${c.id} 确认 ${msg.ackOpId} @v${msg.version}`);

  // 他人操作带来的影响：自己的并发修改被覆盖 / 块被删除
  for (const e of msg.entries) {
    if (e.op.clientId === c.id) continue;
    if (e.concurrentWith && e.concurrentWith.by === c.id) {
      log(
        s,
        'conflict',
        c.id,
        `${c.id} 在块 ${e.op.blockId} 的修改（v${e.concurrentWith.version}）被 ${e.op.clientId} 的并发操作覆盖（v${e.version}）`,
      );
    }
    if (e.op.kind === 'delete' && oldBase.some((b) => b.id === e.op.blockId)) {
      log(s, 'conflict', c.id, `${c.id} 看到块 ${e.op.blockId} 被 ${e.op.clientId} 删除（v${e.version}）`);
    }
  }

  // 待确认队列重基：标记并发冲突、丢弃目标已消失的操作
  const survivors: PendingOp[] = [];
  for (const p of c.pending) {
    const hit = msg.entries.find((e) => e.op.clientId !== c.id && e.op.blockId === p.blockId);
    if (hit) {
      p.conflictNote = `与 ${hit.op.clientId} 的并发${OP_KIND_LABEL[hit.op.kind]}冲突（服务端 v${hit.version}），已在最新服务端状态上重基`;
      log(s, 'conflict', c.id, `${c.id} 的待确认操作 ${p.opId}：${p.conflictNote}`);
    }
    if (p.kind !== 'insert' && !msg.blocks.some((b) => b.id === p.blockId)) {
      c.droppedOps++;
      log(s, 'conflict', c.id, `${c.id} 丢弃 ${p.opId}：目标块已被服务端删除`);
      continue;
    }
    survivors.push(p);
  }
  c.pending = survivors;

  log(
    s,
    'sync',
    c.id,
    `${c.id} 同步至 v${msg.version}${msg.entries.length ? `（${msg.entries.length} 条新变更）` : ''}`,
  );
}
