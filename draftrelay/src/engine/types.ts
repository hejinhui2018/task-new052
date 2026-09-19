// ---------------------------------------------------------------------------
// DraftRelay 引擎类型定义
// 整个模拟是一个可 JSON 序列化的状态机：不依赖 Date.now / Math.random，
// 时间来自离散 tick，随机性来自注入的种子，因此演练可以精确复现。
// ---------------------------------------------------------------------------

export type ClientId = 'A' | 'B';
export const CLIENTS: ClientId[] = ['A', 'B'];

/** 文档被切分为若干“块”（段落），同步以块为粒度进行 */
export interface Block {
  id: string;
  text: string;
}

export type OpKind = 'edit' | 'insert' | 'delete' | 'move';

/** 一次本地编辑操作。baseVersion 记录它基于哪个服务端版本产生 —— 因果关系 */
export interface Op {
  opId: string; // 形如 `A#3`，全局唯一，幂等键
  clientId: ClientId;
  seq: number; // 客户端内单调序号，用于服务端乱序缓存
  baseVersion: number; // 产生该操作时客户端已知的服务端版本
  kind: OpKind;
  blockId: string; // 目标块（insert 时为新块的 id）
  after: string | null; // insert/move 的锚点块，null 表示文档开头
  text: string; // edit/insert 的内容
  createdAt: number; // 产生的 tick
}

/** 客户端待确认队列中的操作 */
export interface PendingOp extends Op {
  sendCount: number;
  lastSentAt: number | null; // null = 尚未发送
  conflictNote: string | null; // 重基时发现的并发冲突说明
}

/** 服务端日志条目：版本链 + 并发覆盖信息，构成可展示的因果关系 */
export interface ServerEntry {
  version: number;
  op: Op;
  /** 若该操作覆盖了其他客户端的并发修改，记录被覆盖者 */
  concurrentWith: { by: ClientId | 'server'; version: number } | null;
  note: string | null; // 例如“目标块已不存在，效果为空”
}

/** 每个块的最终合并来源 */
export interface BlockMeta {
  by: ClientId | 'server';
  version: number;
}

export interface ServerState {
  version: number;
  blocks: Block[];
  log: ServerEntry[];
  seenOpIds: string[]; // 幂等去重：已应用过的 opId
  lastSeq: Record<ClientId, number>; // 每个客户端已连续应用到哪个序号
  held: Record<ClientId, Op[]>; // 乱序到达的缓存，等待前驱补齐
  blockMeta: Record<string, BlockMeta>;
  duplicatesRejected: number; // 统计：被拒绝的重复操作数
}

export interface ClientState {
  id: ClientId;
  online: boolean;
  nextSeq: number;
  serverVersion: number; // 已并入本地的服务端版本
  base: Block[]; // 最近一次确认的服务端快照
  pending: PendingOp[]; // 待确认队列（本地乐观生效）
  ignoredAcks: number; // 统计：被忽略的迟到/重复确认
  droppedOps: number; // 统计：因目标被删而丢弃的本地操作
}

export type Message =
  | { type: 'op'; from: ClientId; to: 'server'; op: Op }
  | {
      type: 'state'; // 服务端下发的状态（ack 与广播共用，幂等靠版本号）
      from: 'server';
      to: ClientId;
      version: number;
      blocks: Block[];
      blockMeta: Record<string, BlockMeta>;
      entries: ServerEntry[]; // 自对方已知版本以来的新条目
      ackOpId: string | null; // 若这是对某操作的确认，记录其 opId
    }
  | { type: 'hello'; from: ClientId; to: 'server'; lastVersion: number };

export type FaultKind = 'dropped' | 'duplicated' | 'delayed' | 'reordered';

export interface Envelope {
  id: number;
  msg: Message;
  sentAt: number;
  deliverAt: number;
  fault: FaultKind | null;
  dropped: boolean;
  doneAt: number | null; // 送达或被丢弃的 tick（保留几拍用于 UI 展示）
}

/** 故障注入：武装后作用于其后创建的第一条消息 */
export interface FaultArm {
  dropNext: number;
  duplicateNext: number;
  delayNext: number;
  reorderNext: boolean;
  chaos: boolean; // 混沌模式：每条消息随机掷骰
}

export type EventActor = ClientId | 'server' | 'net' | 'sys';
export type EventKind =
  | 'op'
  | 'send'
  | 'deliver'
  | 'drop'
  | 'ack'
  | 'ignore'
  | 'conflict'
  | 'apply'
  | 'sync'
  | 'link'
  | 'fault'
  | 'info';

export interface SimEvent {
  id: number;
  time: number;
  kind: EventKind;
  actor: EventActor;
  text: string;
}

export interface ScriptStep {
  at: number;
  action: SimAction;
}

export interface SimStats {
  sent: number;
  delivered: number;
  dropped: number;
  retries: number;
  duplicated: number;
}

export interface SimState {
  time: number;
  rng: number; // mulberry32 状态
  server: ServerState;
  clients: Record<ClientId, ClientState>;
  inFlight: Envelope[];
  events: SimEvent[];
  faults: FaultArm;
  nextEnvId: number;
  nextEventId: number;
  script: { name: string; steps: ScriptStep[] } | null;
  stats: SimStats;
}

export type SimAction =
  | { type: 'tick' }
  | { type: 'edit'; client: ClientId; blockId: string; text: string }
  | { type: 'insert'; client: ClientId; after: string | null; text: string }
  | { type: 'delete'; client: ClientId; blockId: string }
  | { type: 'move'; client: ClientId; blockId: string; dir: -1 | 1 }
  | { type: 'toggleNet'; client: ClientId }
  | { type: 'fault'; fault: 'drop' | 'duplicate' | 'delay' | 'reorder' | 'chaos' }
  | { type: 'loadScript'; name: string }
  | { type: 'reset' };
