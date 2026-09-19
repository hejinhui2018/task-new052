// ---------------------------------------------------------------------------
// DraftRelay 模拟内核 · 类型定义
// 全部状态均为可 JSON 序列化的纯数据（撤销/重做/刷新恢复依赖这一点）。
// ---------------------------------------------------------------------------

export type ClientId = 'A' | 'B';
export type ActorId = ClientId | 'S'; // S = 服务端
export type LogActor = ActorId | 'NET' | 'SYS';

/** 文档块：内容 + 合并来源（provenance）。 */
export interface Block {
  id: string;
  text: string;
  /** 内容最后写入者（合并来源） */
  updatedBy: ActorId;
  updatedLamport: number;
  updatedOpId: string;
  /** 位置来源：插入/移动时锚定在哪个块之后（null = 文档开头） */
  anchor: string | null;
  posLamport: number;
  posBy: ActorId;
}

export type OpKind = 'insert' | 'update' | 'delete' | 'move';

/** 一次编辑操作。opId 全局唯一，是幂等的钥匙。 */
export interface Op {
  opId: string; // `${client}-${seq}`
  client: ClientId;
  seq: number; // 客户端内单调序号
  lamport: number; // 客户端逻辑时钟
  baseVersion: number; // 因果上下文：产生该操作时客户端已确认的服务端版本
  kind: OpKind;
  blockId: string; // insert 时为新建块 id，其余为目标块 id
  text?: string; // insert / update
  after?: string | null; // insert / move 的锚点
}

export type EditSpec =
  | { kind: 'insert'; after: string | null; text: string }
  | { kind: 'update'; blockId: string; text: string }
  | { kind: 'delete'; blockId: string }
  | { kind: 'move'; blockId: string; after: string | null };

/** 操作在服务端的最终结局（合并来源 / 冲突仲裁记录）。 */
export type OpOutcome =
  | { status: 'applied' }
  | { status: 'superseded'; by: string } // 被后来的并发操作覆盖
  | { status: 'dropped'; reason: string } // 无法应用（如目标已删除）
  | { status: 'duplicate' }; // 重复重试，幂等忽略

/** 服务端 → 客户端的全量同步消息（确认 + 权威快照）。 */
export interface SyncMsg {
  kind: 'sync';
  version: number;
  doc: Block[];
  seenOpIds: string[]; // 累计已应用 opId（单调增长，乱序/迟到安全）
  outcomes: Record<string, OpOutcome>; // 累计仲裁结果
  causeOpId: string | null;
}

export interface OpMsg {
  kind: 'op';
  op: Op;
}

export type Payload = OpMsg | SyncMsg;

export type FaultKind = 'drop' | 'delay' | 'duplicate' | 'reorder';

/** 网络中在途的消息信封。 */
export interface Envelope {
  id: string;
  num: number; // 用于确定性排序
  from: ActorId;
  to: ActorId;
  payload: Payload;
  createdTick: number;
  deliverTick: number;
  label: string;
  copyOf?: string; // 复制故障产生的副本
}

export type LogTone = 'info' | 'ok' | 'warn' | 'err' | 'fault';

export interface LogEntry {
  seq: number;
  tick: number;
  actor: LogActor;
  text: string;
  tone: LogTone;
}

export const CLIENTS: ClientId[] = ['A', 'B'];

export function opLabel(op: Op): string {
  switch (op.kind) {
    case 'insert':
      return `插入「${op.blockId}」`;
    case 'update':
      return `更新「${op.blockId}」`;
    case 'delete':
      return `删除「${op.blockId}」`;
    case 'move':
      return `移动「${op.blockId}」`;
  }
}
