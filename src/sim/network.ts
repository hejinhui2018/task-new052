// ---------------------------------------------------------------------------
// 网络层：在途消息信封 + 链路开关 + 故障注入（丢弃/延迟/复制/乱序）。
// 全部确定性：没有随机数，延迟以 tick 计。
// ---------------------------------------------------------------------------

import type { ActorId, ClientId, Envelope, FaultKind, LogTone, Payload } from './types';

export interface NetworkState {
  envelopes: Envelope[];
  links: Record<ClientId, boolean>;
  nextEnvNum: number;
  /** 用户预排的"对下一条消息注入"故障队列 */
  queuedFaults: FaultKind[];
}

export function initNetwork(): NetworkState {
  return { envelopes: [], links: { A: true, B: true }, nextEnvNum: 1, queuedFaults: [] };
}

export interface NetEvent {
  text: string;
  tone: LogTone;
}

export const FAULT_LABEL: Record<FaultKind, string> = {
  drop: '丢弃',
  delay: '延迟',
  duplicate: '复制',
  reorder: '乱序',
};

export const DELAY_TICKS = 3;
export const REORDER_TICKS = 2;

function applyFaultTo(env: Envelope, fault: FaultKind, net: NetworkState): { net: NetworkState; events: NetEvent[] } {
  switch (fault) {
    case 'drop':
      return { net, events: [{ text: `故障·丢弃：${env.label}（${env.from}→${env.to}）不会到达`, tone: 'fault' }] };
    case 'delay':
      return {
        net: { ...net, envelopes: [...net.envelopes, { ...env, deliverTick: env.deliverTick + DELAY_TICKS }] },
        events: [{ text: `故障·延迟：${env.label}（${env.from}→${env.to}）+${DELAY_TICKS}t`, tone: 'fault' }],
      };
    case 'duplicate': {
      const copyNum = net.nextEnvNum;
      const copy: Envelope = {
        ...env,
        id: `env-${copyNum}`,
        num: copyNum,
        copyOf: env.id,
      };
      return {
        net: {
          ...net,
          nextEnvNum: copyNum + 1,
          envelopes: [...net.envelopes, env, copy],
        },
        events: [{ text: `故障·复制：${env.label} 将送达两次（副本 ${copy.id}）`, tone: 'fault' }],
      };
    }
    case 'reorder':
      return {
        net: { ...net, envelopes: [...net.envelopes, { ...env, deliverTick: env.deliverTick + REORDER_TICKS }] },
        events: [{ text: `故障·乱序：${env.label}（${env.from}→${env.to}）将晚于后续消息到达`, tone: 'fault' }],
      };
  }
}

/** 发送一条消息；若排有"下一条注入"故障则立即消费之。 */
export function sendEnvelope(
  net: NetworkState,
  from: ActorId,
  to: ActorId,
  payload: Payload,
  label: string,
  tick: number,
): { net: NetworkState; events: NetEvent[] } {
  const num = net.nextEnvNum;
  const env: Envelope = {
    id: `env-${num}`,
    num,
    from,
    to,
    payload,
    createdTick: tick,
    deliverTick: tick + 1,
    label,
  };
  let cur: NetworkState = { ...net, nextEnvNum: num + 1 };
  if (cur.queuedFaults.length > 0) {
    const [fault, ...rest] = cur.queuedFaults;
    cur = { ...cur, queuedFaults: rest };
    const r = applyFaultTo(env, fault, cur);
    return { net: r.net, events: r.events };
  }
  return { net: { ...cur, envelopes: [...cur.envelopes, env] }, events: [] };
}

/** 对指定在途消息注入故障（网络面板按钮 / 场景脚本）。 */
export function injectOn(net: NetworkState, envId: string, fault: FaultKind): { net: NetworkState; events: NetEvent[] } {
  const env = net.envelopes.find((e) => e.id === envId);
  if (!env) return { net, events: [{ text: `故障未注入：${envId} 不在在途消息中`, tone: 'info' }] };
  const rest = net.envelopes.filter((e) => e.id !== envId);
  return applyFaultTo(env, fault, { ...net, envelopes: rest });
}

export interface EnvelopeMatch {
  to?: ActorId;
  payloadKind?: 'op' | 'sync';
  version?: number;
}

/** 按特征找到第一条在途消息并注入故障（场景脚本用，免猜信封 id）。 */
export function injectMatch(
  net: NetworkState,
  match: EnvelopeMatch,
  fault: FaultKind,
): { net: NetworkState; events: NetEvent[] } {
  const sorted = [...net.envelopes].sort((a, b) => a.num - b.num);
  const env = sorted.find((e) => {
    if (match.to !== undefined && e.to !== match.to) return false;
    if (match.payloadKind !== undefined && e.payload.kind !== match.payloadKind) return false;
    if (match.version !== undefined) {
      if (e.payload.kind !== 'sync' || e.payload.version !== match.version) return false;
    }
    return true;
  });
  if (!env) return { net, events: [{ text: '故障未注入：没有匹配的在途消息', tone: 'info' }] };
  return injectOn(net, env.id, fault);
}

/** 取出本 tick 应送达的消息（发往离线客户端的消息滞留在网络中）。 */
export function deliverDue(
  net: NetworkState,
  tick: number,
): { net: NetworkState; due: Envelope[] } {
  const due: Envelope[] = [];
  const held: Envelope[] = [];
  for (const e of net.envelopes) {
    const reachable = e.to === 'S' || net.links[e.to as ClientId];
    if (e.deliverTick <= tick && reachable) due.push(e);
    else held.push(e);
  }
  due.sort((a, b) => a.deliverTick - b.deliverTick || a.num - b.num);
  return { net: { ...net, envelopes: held }, due };
}
