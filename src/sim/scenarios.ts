// ---------------------------------------------------------------------------
// 预排演练脚本：每一步都是一个 SimAction，可单步、可自动播放、可撤销。
// 同一脚本跑多少次结果都一致（模拟内核无随机、无时钟）。
// ---------------------------------------------------------------------------

import type { SimAction } from './sim';

export interface ScenarioStep {
  label: string;
  action: SimAction;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  watch: string[];
  steps: ScenarioStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'ooo-acks',
    title: '乱序确认与迟到确认',
    description:
      '客户端 A 连续提交两条更新。服务端按序应用并回执，但 v1 的确认被故障延迟，A 先收到 v2 的确认（版本跳跃），迟到的 v1 随后到达 —— 必须被忽略，不能回退。',
    watch: [
      'A 的版本从 v0 直接跳到 v2（日志提示乱序到达）',
      '迟到的 sync v1 到达时被忽略，已确认内容不回退',
      '待确认队列靠累计 seenOpIds 清理，与确认到达顺序无关',
    ],
    steps: [
      {
        label: 'A 更新 b2（产生 A-1，立即发出）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b2', text: '新增：批量导入日程（含 CSV 模板）' } },
      },
      {
        label: 'A 更新 b3（产生 A-2，立即发出）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b3', text: '修复：离线草稿丢失（已回归验证）' } },
      },
      {
        label: '空转 1t：服务端依次应用 A-1→v1、A-2→v2 并广播回执',
        action: { type: 'tick' },
      },
      {
        label: '故障注入：延迟「sync v1 → A」3 个 tick',
        action: { type: 'injectMatch', match: { to: 'A', payloadKind: 'sync', version: 1 }, fault: 'delay' },
      },
      {
        label: '空转 1t：A 先收到 v2（版本跳跃 v0→v2），两条操作都被确认',
        action: { type: 'tick' },
      },
      {
        label: '空转 4t：迟到的 sync v1 到达，被忽略，不回退',
        action: { type: 'ticks', n: 4 },
      },
    ],
  },
  {
    id: 'dual-conflict',
    title: '双端离线冲突与合并来源',
    description:
      'A、B 同时断网各自编辑：双方改同一块 b3（并发冲突），A 改 b4 而 B 删掉 b4（删除优先），A 还插入新块。A 先恢复网络，B 后恢复。服务端按 (逻辑时钟, 客户端ID) 仲裁，每台客户端都能看到每个块的最终合并来源。',
    watch: [
      'b3 最终采用 B 的措辞（lamport 相同，B > A），A-1 被追溯标记为「被覆盖」',
      'b4 被 B 删除，A 对 b4 的更新随之失效（删除优先）',
      'A 插入的新块保留；收敛后 A、B、服务端三方文档完全一致',
    ],
    steps: [
      { label: '断开 A 的链路', action: { type: 'toggleLink', client: 'A' } },
      { label: '断开 B 的链路', action: { type: 'toggleLink', client: 'B' } },
      {
        label: 'A 离线更新 b3（A-1）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b3', text: '修复：离线草稿丢失（A 的措辞）' } },
      },
      {
        label: 'A 离线更新 b4（A-2）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b4', text: '已知问题：弱网同步延迟（A 已改善）' } },
      },
      {
        label: 'A 离线插入新块（A-3）',
        action: { type: 'edit', client: 'A', spec: { kind: 'insert', after: 'b1', text: '新增：现场演示模式（A 起草）' } },
      },
      {
        label: 'B 离线更新 b3（B-1，与 A-1 并发冲突）',
        action: { type: 'edit', client: 'B', spec: { kind: 'update', blockId: 'b3', text: '修复：离线草稿丢失（B 的措辞）' } },
      },
      {
        label: 'B 离线删除 b4（B-2，删除优先于 A-2）',
        action: { type: 'edit', client: 'B', spec: { kind: 'delete', blockId: 'b4' } },
      },
      { label: '恢复 A 的链路：A-1..A-3 立即冲刷出去', action: { type: 'toggleLink', client: 'A' } },
      { label: '空转 3t：A 的操作全部确认（v1..v3），B 的广播被滞留', action: { type: 'ticks', n: 3 } },
      { label: '恢复 B 的链路：B-1、B-2 与滞留的广播一起送达', action: { type: 'toggleLink', client: 'B' } },
      { label: '空转 6t：服务端仲裁并发冲突，双方收敛到同一文档', action: { type: 'ticks', n: 6 } },
    ],
  },
  {
    id: 'reconnect-retry',
    title: '重连冲刷与重复重试（幂等）',
    description:
      'A 断网期间连续编辑（更新、更新、移动），恢复网络后队列整体冲刷；随后手动重试，同一批操作被重复发送。服务端按 opId 去重：版本只推进一次，重复确认也被客户端忽略。',
    watch: [
      '队列按因果顺序（A-1 → A-2 → A-3）发出',
      '服务端日志出现 3 次「重复操作已忽略」，版本停在 v3 而非 v6',
      'A 收到重复回执时记录「重复确认已忽略」，待确认不二次推进',
    ],
    steps: [
      { label: '断开 A 的链路', action: { type: 'toggleLink', client: 'A' } },
      {
        label: 'A 离线更新 b1（A-1）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b1', text: '发布说明 v2.4 — 展会现场版（终稿）' } },
      },
      {
        label: 'A 离线更新 b2（A-2）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b2', text: '新增：批量导入日程（现场演示可用）' } },
      },
      {
        label: 'A 离线把 b4 移到 b1 之后（A-3）',
        action: { type: 'edit', client: 'A', spec: { kind: 'move', blockId: 'b4', after: 'b1' } },
      },
      { label: '恢复 A 的链路：队列整体冲刷', action: { type: 'toggleLink', client: 'A' } },
      { label: 'A 手动重试：同一批操作再发一遍（重复消息上路）', action: { type: 'retry', client: 'A' } },
      { label: '空转 4t：服务端幂等去重，版本只推进 3 次', action: { type: 'ticks', n: 4 } },
    ],
  },
  {
    id: 'stale-clobber',
    title: '故障复现：旧快照回灌（线上 bug）',
    description:
      '复现展会现场的事故：A 先确认了一版（v1），断网后继续急改两条；此时故障注入把一份旧快照（v0）回灌到 A 的视图 —— 待确认队列被吞，界面却显示「已同步」。对照其他演练可见：版本检查与待确认队列正是为了防住它。',
    watch: [
      '回灌瞬间：A 的视图回退到 v0，两条急改从界面上消失',
      '状态徽章显示「已同步（假象）」—— 这就是用户投诉的现象',
      '服务端与 B 仍持有正确数据：对比面板即可发现 A 丢了内容',
    ],
    steps: [
      {
        label: 'A 更新 b2 并等待确认（建立 v1 快照）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b2', text: '新增：批量导入日程（v1 确认稿）' } },
      },
      { label: '空转 2t：A-1 被确认，A 同步至 v1', action: { type: 'ticks', n: 2 } },
      { label: '断开 A 的链路', action: { type: 'toggleLink', client: 'A' } },
      {
        label: 'A 离线急改 b3（A-2，待确认）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b3', text: '修复：离线草稿丢失（现场急改）' } },
      },
      {
        label: 'A 离线急改 b4（A-3，待确认）',
        action: { type: 'edit', client: 'A', spec: { kind: 'update', blockId: 'b4', text: '已知问题：已定位，随 2.4.1 修复' } },
      },
      { label: '故障注入：把 v0 旧快照回灌到 A（待确认队列被吞）', action: { type: 'clobber', client: 'A' } },
      { label: '恢复 A 的链路：队列已空，急改再也到不了服务端', action: { type: 'toggleLink', client: 'A' } },
      { label: '空转 2t：对比三方状态，确认数据丢失范围', action: { type: 'ticks', n: 2 } },
    ],
  },
  {
    id: 'free',
    title: '自由演练',
    description:
      '无脚本。直接在任意客户端面板上编辑/插入/移动/删除，用网络面板断链、注入故障、重试，用控制条单步推进或自动播放。所有操作可撤销，刷新页面后自动恢复。',
    watch: ['试试：断网编辑 → 恢复 → 立即重试 → 对回执注入延迟'],
    steps: [],
  },
];

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[SCENARIOS.length - 1];
}
