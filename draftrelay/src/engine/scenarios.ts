// ---------------------------------------------------------------------------
// 预置演练脚本：每个步骤在指定 tick 自动执行，配合单步/自动播放复现故障现场
// ---------------------------------------------------------------------------

import type { SimAction } from './types';

export interface ScenarioDef {
  label: string;
  desc: string;
  steps: { at: number; action: SimAction }[];
}

export const SCENARIOS: Record<string, ScenarioDef> = {
  conflict: {
    label: '双端冲突：展会断网',
    desc: 'B 离线期间与 A 编辑同一块，恢复网络后按服务端到达顺序合并，来源可追溯',
    steps: [
      { at: 1, action: { type: 'edit', client: 'A', blockId: 'b2', text: '- 新增：离线草稿自动保存（A 现场补充）' } },
      { at: 3, action: { type: 'toggleNet', client: 'B' } },
      { at: 4, action: { type: 'edit', client: 'B', blockId: 'b2', text: '- 新增：离线草稿自动保存（B 离线重写）' } },
      { at: 5, action: { type: 'edit', client: 'B', blockId: 'b3', text: '- 修复：同步状态误报（B 补充细节）' } },
      { at: 8, action: { type: 'toggleNet', client: 'B' } },
    ],
  },
  lateAck: {
    label: '迟到确认与重复重试',
    desc: '确认被复制、随后确认被丢弃引发重试：重复确认被忽略，重复操作不推进版本',
    steps: [
      { at: 1, action: { type: 'edit', client: 'A', blockId: 'b3', text: '- 修复：同步状态误报（已验证）' } },
      { at: 2, action: { type: 'fault', fault: 'duplicate' } },
      { at: 6, action: { type: 'edit', client: 'A', blockId: 'b4', text: '- 已知问题：弱网下重试风暴（演练复现）' } },
      { at: 7, action: { type: 'fault', fault: 'drop' } },
    ],
  },
  offlineQueue: {
    label: '离线队列：编辑·删除·移动·插入',
    desc: 'B 离线连续产生四类操作，重连后按因果顺序冲刷到服务端',
    steps: [
      { at: 1, action: { type: 'toggleNet', client: 'B' } },
      { at: 2, action: { type: 'edit', client: 'B', blockId: 'b1', text: '# v2.4.0 发布说明（修订版）' } },
      { at: 3, action: { type: 'delete', client: 'B', blockId: 'b4' } },
      { at: 4, action: { type: 'move', client: 'B', blockId: 'b2', dir: 1 } },
      { at: 5, action: { type: 'insert', client: 'B', after: 'b1', text: '- 变更：同步引擎全面升级' } },
      { at: 9, action: { type: 'toggleNet', client: 'B' } },
    ],
  },
  reorder: {
    label: '乱序确认：因果缓存',
    desc: '同一客户端的两条操作乱序到达，服务端按序号缓存重排，不乱因果',
    steps: [
      { at: 1, action: { type: 'fault', fault: 'reorder' } },
      { at: 1, action: { type: 'edit', client: 'A', blockId: 'b2', text: '- 新增：离线草稿自动保存（第一步）' } },
      { at: 2, action: { type: 'edit', client: 'A', blockId: 'b2', text: '- 新增：离线草稿自动保存（第二步，覆盖第一步）' } },
    ],
  },
};
