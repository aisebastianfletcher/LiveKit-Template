/**
 * VoiceAgentPage.tsx — GITWIX Agent v3 (fixed)
 *
 * All hooks/components use their ACTUAL interfaces:
 *   useLiveKitSession() → { status, agentStatusText, roomName, localMicStream,
 *                            agentAudioStream, audioContext, segments, connect, disconnect }
 *   useAudioAnalyser(audioContext, stream, isMic) → { rmsRef }
 *   AuraVisualizer props: { auraMode: AuraMode, rmsRef }
 *   AuraMode: 'disconnected' | 'idle' | 'user-speaking' | 'agent-speaking'
 *   OpenClawLogo: no style prop
 *
 * npm install @xyflow/react dagre @types/dagre
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
  type CSSProperties,
  type RefObject,
} from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Handle,
  Position,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'

import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import OpenClawLogo from '@/components/OpenClawLogo'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: Date
}

interface Task {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed'
  created_at: number
  updated_at: number
  source: string
  category: 'short_term' | 'long_term'
}

interface Agent {
  id: string
  name: string
  type: string
  status: 'active' | 'idle' | 'completed'
  created_at: number
}

interface Job {
  id: string
  name: string
  status: 'queued' | 'running' | 'done' | 'failed'
  schedule?: string
  created_at: number
}

interface MemoryFile {
  file: string
  path: string
  content: string
  preview: string
  updated_at: number
  size: number
}

interface CustomTreeNode {
  id: string
  parent_id?: string
  label: string
  status?: string
  type: string
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
}

interface TelegramStatus {
  bot_username: string
  status: 'online' | 'offline'
  message_count: number
}

interface OpenClawStatus {
  status: 'online' | 'offline'
  model: string
  gateway: boolean
}

// ─── Node size registry ───────────────────────────────────────────────────────

const SZ = {
  inputNode:       { w: 192, h: 84  },
  openClawNode:    { w: 268, h: 108 },
  branchNode:      { w: 212, h: 50  },
  memoryFileNode:  { w: 218, h: 96  },
  groupHeaderNode: { w: 180, h: 50  },
  taskNode:        { w: 208, h: 72  },
  agentNode:       { w: 208, h: 72  },
  jobNode:         { w: 208, h: 72  },
  customNode:      { w: 200, h: 72  },
} as const

// ─── Dagre layout ─────────────────────────────────────────────────────────────

function runDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 88, nodesep: 28, marginx: 60, marginy: 60 })

  nodes.forEach((n) => {
    const sz = SZ[n.type as keyof typeof SZ] ?? { w: 200, h: 72 }
    g.setNode(n.id, { width: sz.w, height: sz.h })
  })
  edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  })

  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    if (!pos) return n
    const sz = SZ[n.type as keyof typeof SZ] ?? { w: 200, h: 72 }
    return { ...n, position: { x: pos.x - sz.w / 2, y: pos.y - sz.h / 2 } }
  })
}

// ─── Edge factory ─────────────────────────────────────────────────────────────

type EdgeStyle = 'gold-animated' | 'amber' | 'dim' | 'faint' | 'custom'

function mkEdge(source: string, target: string, style: EdgeStyle = 'dim'): Edge {
  const styleMap: Record<EdgeStyle, CSSProperties> = {
    'gold-animated': { stroke: '#d97706', strokeWidth: 2 },
    amber:           { stroke: '#b45309', strokeWidth: 2 },
    dim:             { stroke: '#374151', strokeWidth: 1.5 },
    faint:           { stroke: '#27272a', strokeWidth: 1 },
    custom:          { stroke: '#6d28d9', strokeWidth: 1.5, strokeDasharray: '5 3' },
  }
  return {
    id:       `e-${source}-${target}`,
    source,
    target,
    type:     'smoothstep',
    animated: style === 'gold-animated',
    style:    styleMap[style],
  }
}

// ─── Graph builder ────────────────────────────────────────────────────────────

interface GraphData {
  tasks: Task[]
  agents: Agent[]
  jobs: Job[]
  memoryFiles: Record<string, MemoryFile>
  treeNodes: CustomTreeNode[]
  telegramStatus: TelegramStatus | null
  openClawStatus: OpenClawStatus | null
  voiceConnected: boolean
  chatMsgCount: number
}

function buildGraph(d: GraphData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  // Input layer
  nodes.push({
    id: 'in-telegram', type: 'inputNode', position: { x: 0, y: 0 },
    data: {
      icon:     '✈',
      label:    'Telegram',
      subtitle: d.telegramStatus?.bot_username ?? '@karensteve_bot',
      status:   d.telegramStatus?.status ?? 'offline',
      metric:   `${d.telegramStatus?.message_count ?? 0} msgs`,
    },
  })
  nodes.push({
    id: 'in-voice', type: 'inputNode', position: { x: 0, y: 0 },
    data: {
      icon:     '◎',
      label:    'Voice',
      subtitle: 'LiveKit',
      status:   d.voiceConnected ? 'online' : 'offline',
      metric:   d.voiceConnected ? 'Connected' : 'Idle',
    },
  })
  nodes.push({
    id: 'in-chat', type: 'inputNode', position: { x: 0, y: 0 },
    data: {
      icon:     '◈',
      label:    'Text Chat',
      subtitle: 'OpenClaw API',
      status:   'online',
      metric:   `${d.chatMsgCount} msgs`,
    },
  })

  edges.push(mkEdge('in-telegram', 'openclaw', 'gold-animated'))
  edges.push(mkEdge('in-voice',    'openclaw', 'gold-animated'))
  edges.push(mkEdge('in-chat',     'openclaw', 'gold-animated'))

  // OpenClaw
  nodes.push({
    id: 'openclaw', type: 'openClawNode', position: { x: 0, y: 0 },
    data: {
      status:  d.openClawStatus?.status  ?? 'offline',
      model:   d.openClawStatus?.model   ?? '—',
      gateway: d.openClawStatus?.gateway ?? false,
    },
  })

  edges.push(mkEdge('openclaw', 'br-memory',    'amber'))
  edges.push(mkEdge('openclaw', 'br-workspace', 'amber'))

  // Memory branch
  nodes.push({
    id: 'br-memory', type: 'branchNode', position: { x: 0, y: 0 },
    data: { label: 'GitHub Memory', icon: '⬡' },
  })

  const memFiles = ['profile', 'tasks', 'conversations', 'automations'] as const
  const memIcons: Record<string, string> = {
    profile: '👤', tasks: '📋', conversations: '💬', automations: '⚡',
  }
  memFiles.forEach((f) => {
    const mf = d.memoryFiles[f]
    nodes.push({
      id: `mem-${f}`, type: 'memoryFileNode', position: { x: 0, y: 0 },
      data: {
        file:      f,
        icon:      memIcons[f],
        preview:   mf?.preview    ?? '(no content)',
        updatedAt: mf?.updated_at ?? null,
        size:      mf?.size       ?? 0,
      },
    })
    edges.push(mkEdge('br-memory', `mem-${f}`, 'dim'))
  })

  // Workspace branch
  nodes.push({
    id: 'br-workspace', type: 'branchNode', position: { x: 0, y: 0 },
    data: { label: 'Workspace', icon: '◇' },
  })

  nodes.push({
    id: 'grp-tasks',  type: 'groupHeaderNode', position: { x: 0, y: 0 },
    data: { label: 'Tasks',  count: d.tasks.length,  color: '#22c55e' },
  })
  nodes.push({
    id: 'grp-agents', type: 'groupHeaderNode', position: { x: 0, y: 0 },
    data: { label: 'Agents', count: d.agents.length, color: '#3b82f6' },
  })
  nodes.push({
    id: 'grp-jobs',   type: 'groupHeaderNode', position: { x: 0, y: 0 },
    data: { label: 'Jobs',   count: d.jobs.length,   color: '#a855f7' },
  })

  edges.push(mkEdge('br-workspace', 'grp-tasks',  'dim'))
  edges.push(mkEdge('br-workspace', 'grp-agents', 'dim'))
  edges.push(mkEdge('br-workspace', 'grp-jobs',   'dim'))

  d.tasks.forEach((t) => {
    nodes.push({ id: `task-${t.id}`,  type: 'taskNode',  position: { x: 0, y: 0 }, data: t as unknown as Record<string, unknown> })
    edges.push(mkEdge('grp-tasks', `task-${t.id}`, 'faint'))
  })
  d.agents.forEach((a) => {
    nodes.push({ id: `agent-${a.id}`, type: 'agentNode', position: { x: 0, y: 0 }, data: a as unknown as Record<string, unknown> })
    edges.push(mkEdge('grp-agents', `agent-${a.id}`, 'faint'))
  })
  d.jobs.forEach((j) => {
    nodes.push({ id: `job-${j.id}`,   type: 'jobNode',   position: { x: 0, y: 0 }, data: j as unknown as Record<string, unknown> })
    edges.push(mkEdge('grp-jobs', `job-${j.id}`, 'faint'))
  })

  // Custom tree nodes
  const knownIds = new Set(nodes.map((n) => n.id))
  d.treeNodes.forEach((tn) => {
    const nid = `custom-${tn.id}`
    nodes.push({
      id: nid, type: 'customNode', position: { x: 0, y: 0 },
      data: tn as unknown as Record<string, unknown>,
    })
    let parentId = 'openclaw'
    if (tn.parent_id) {
      if      (knownIds.has(tn.parent_id))             parentId = tn.parent_id
      else if (knownIds.has(`custom-${tn.parent_id}`)) parentId = `custom-${tn.parent_id}`
    }
    edges.push(mkEdge(parentId, nid, 'custom'))
    knownIds.add(nid)
  })

  return { nodes: runDagre(nodes, edges), edges }
}

// ─── Status colour helper ─────────────────────────────────────────────────────

const SC: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  online:      { border: '#22c55e', bg: '#052e16', text: '#4ade80', dot: '#22c55e' },
  offline:     { border: '#52525b', bg: '#18181b', text: '#71717a', dot: '#52525b' },
  active:      { border: '#22c55e', bg: '#052e16', text: '#4ade80', dot: '#22c55e' },
  idle:        { border: '#374151', bg: '#18181b', text: '#6b7280', dot: '#4b5563' },
  completed:   { border: '#22c55e', bg: '#052e16', text: '#4ade80', dot: '#22c55e' },
  in_progress: { border: '#3b82f6', bg: '#0c1a3a', text: '#60a5fa', dot: '#3b82f6' },
  pending:     { border: '#374151', bg: '#18181b', text: '#6b7280', dot: '#4b5563' },
  queued:      { border: '#a855f7', bg: '#1a0a2e', text: '#c084fc', dot: '#a855f7' },
  running:     { border: '#3b82f6', bg: '#0c1a3a', text: '#60a5fa', dot: '#3b82f6' },
  done:        { border: '#22c55e', bg: '#052e16', text: '#4ade80', dot: '#22c55e' },
  failed:      { border: '#ef4444', bg: '#2d0a0a', text: '#f87171', dot: '#ef4444' },
  thinking:    { border: '#f59e0b', bg: '#1c1100', text: '#fbbf24', dot: '#f59e0b' },
  error:       { border: '#ef4444', bg: '#2d0a0a', text: '#f87171', dot: '#ef4444' },
}
const fallbackSC = SC.idle
function sc(s?: string): { border: string; bg: string; text: string; dot: string } {
  return SC[s ?? ''] ?? fallbackSC
}

// ─── Shared primitives ────────────────────────────────────────────────────────

const INV: CSSProperties = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1 }

function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: color, flexShrink: 0,
      animation: pulse ? 'gpulse 1.6s ease-in-out infinite' : 'none',
    }} />
  )
}

function fmtTime(epoch: number | null | undefined): string {
  if (!epoch) return '—'
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const nBase: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  border: '1px solid #374151', borderRadius: 8,
  padding: '12px 14px', background: '#111318', boxSizing: 'border-box',
}
const nTitle: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1.3 }
const nSub:   CSSProperties = { fontSize: 9, color: '#4b5563', letterSpacing: '0.08em' }
const bdg:    CSSProperties = {
  fontSize: 8, border: '1px solid', borderRadius: 4, padding: '1px 5px', letterSpacing: '0.08em',
}

// ─── Custom React Flow nodes ──────────────────────────────────────────────────

const InputNode = memo(({ data }: NodeProps) => {
  const c = sc(data.status as string)
  return (
    <div style={{ ...nBase, width: SZ.inputNode.w, height: SZ.inputNode.h, borderColor: c.border, background: c.bg, boxShadow: `0 0 16px ${c.border}28` }}>
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>{data.icon as string}</span>
        <div style={{ flex: 1 }}>
          <div style={{ ...nTitle, color: c.text }}>{data.label as string}</div>
          <div style={nSub}>{data.subtitle as string}</div>
        </div>
        <Dot color={c.dot} pulse={data.status === 'online'} />
      </div>
      <div style={{ marginTop: 10, fontSize: 9, letterSpacing: '0.1em', color: c.dot }}>
        {data.metric as string}
      </div>
    </div>
  )
})
InputNode.displayName = 'InputNode'

const OpenClawNode = memo(({ data }: NodeProps) => {
  const online = (data.status as string) === 'online'
  return (
    <div style={{
      ...nBase,
      width: SZ.openClawNode.w, height: SZ.openClawNode.h,
      background: 'linear-gradient(135deg,#1c1100 0%,#2a1800 60%,#1c1100 100%)',
      border: `2px solid ${online ? '#d97706' : '#52525b'}`,
      boxShadow: online ? '0 0 40px #d9770640,0 0 12px #d9770618,inset 0 1px 0 #d9770628' : 'none',
      position: 'relative', overflow: 'hidden',
    }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      {online && (
        <div style={{ position: 'absolute', inset: 0, borderRadius: 10, pointerEvents: 'none',
          background: 'radial-gradient(ellipse at 50% 0%,#d9770612 0%,transparent 70%)' }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
        <div style={{
          width: 38, height: 38, borderRadius: 8, flexShrink: 0,
          background: online ? '#d9770618' : '#27272a',
          border: `1px solid ${online ? '#d97706' : '#3f3f46'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}>⬡</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Oxanium',sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: '0.1em', color: online ? '#fbbf24' : '#71717a', lineHeight: 1 }}>
            OPENCLAW
          </div>
          <div style={{ ...nSub, marginTop: 3 }}>Brain · Router · Orchestrator</div>
        </div>
        <Dot color={online ? '#d97706' : '#52525b'} pulse={online} />
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 11, position: 'relative' }}>
        <span style={{ ...bdg, borderColor: online ? '#d97706' : '#3f3f46', color: online ? '#fbbf24' : '#52525b' }}>
          {online ? '● online' : '○ offline'}
        </span>
        {Boolean(data.model) && (
          <span style={{ ...bdg, borderColor: '#374151', color: '#6b7280', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.model as string}
          </span>
        )}
        {Boolean(data.gateway) && (
          <span style={{ ...bdg, borderColor: '#1d4ed8', color: '#60a5fa' }}>gateway</span>
        )}
      </div>
    </div>
  )
})
OpenClawNode.displayName = 'OpenClawNode'

const BranchNode = memo(({ data }: NodeProps) => (
  <div style={{ ...nBase, width: SZ.branchNode.w, height: SZ.branchNode.h, background: '#111318', border: '1px solid #2d3748', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
    <Handle type="target" position={Position.Top}    style={INV} />
    <Handle type="source" position={Position.Bottom} style={INV} />
    <span style={{ fontSize: 11, color: '#4b5563' }}>{data.icon as string}</span>
    <span style={{ fontFamily: "'Oxanium',sans-serif", fontWeight: 600, fontSize: 10, letterSpacing: '0.15em', color: '#94a3b8' }}>
      {data.label as string}
    </span>
  </div>
))
BranchNode.displayName = 'BranchNode'

const MemoryFileNode = memo(({ data }: NodeProps) => (
  <div style={{ ...nBase, width: SZ.memoryFileNode.w, height: SZ.memoryFileNode.h, background: '#0d1117', border: '1px solid #21262d' }}>
    <Handle type="target" position={Position.Top}    style={INV} />
    <Handle type="source" position={Position.Bottom} style={INV} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ fontSize: 12 }}>{data.icon as string}</span>
      <div style={{ ...nTitle, color: '#c9d1d9', fontSize: 10 }}>memory/{data.file as string}.md</div>
    </div>
    <div style={{ ...nSub, marginTop: 8, fontSize: 9, lineHeight: 1.5, color: '#484f58', maxHeight: 30, overflow: 'hidden' }}>
      {(data.preview as string) || '(empty)'}
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
      <span style={{ ...bdg, color: '#30363d', borderColor: '#21262d' }}>{data.size as number}b</span>
      <span style={{ ...bdg, color: '#30363d', borderColor: '#21262d' }}>↺ {fmtTime(data.updatedAt as number | null)}</span>
    </div>
  </div>
))
MemoryFileNode.displayName = 'MemoryFileNode'

const GroupHeaderNode = memo(({ data }: NodeProps) => (
  <div style={{ ...nBase, width: SZ.groupHeaderNode.w, height: SZ.groupHeaderNode.h, background: '#0e1117', border: `1px solid ${data.color as string}30`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px' }}>
    <Handle type="target" position={Position.Top}    style={INV} />
    <Handle type="source" position={Position.Bottom} style={INV} />
    <span style={{ fontFamily: "'Oxanium',sans-serif", fontWeight: 600, fontSize: 10, letterSpacing: '0.15em', color: data.color as string }}>
      {data.label as string}
    </span>
    <span style={{ fontFamily: "'Oxanium',sans-serif", fontWeight: 700, fontSize: 16, color: data.color as string }}>
      {data.count as number}
    </span>
  </div>
))
GroupHeaderNode.displayName = 'GroupHeaderNode'

const TaskNode = memo(({ data }: NodeProps) => {
  const t = data as unknown as Task
  const c = sc(t.status)
  return (
    <div style={{ ...nBase, width: SZ.taskNode.w, height: SZ.taskNode.h, background: c.bg, borderColor: c.border, boxShadow: `0 0 8px ${c.border}22` }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <Dot color={c.dot} pulse={t.status === 'in_progress'} />
        <span style={{ ...nTitle, color: c.text, flex: 1 }}>
          {t.title.length > 28 ? t.title.slice(0, 28) + '…' : t.title}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <span style={{ ...bdg, borderColor: c.border, color: c.text }}>{t.status}</span>
        <span style={{ ...bdg, color: '#4b5563', borderColor: '#374151' }}>
          {t.category === 'long_term' ? 'long-term' : 'short-term'}
        </span>
      </div>
    </div>
  )
})
TaskNode.displayName = 'TaskNode'

const AgentNode = memo(({ data }: NodeProps) => {
  const a = data as unknown as Agent
  const c = sc(a.status)
  return (
    <div style={{ ...nBase, width: SZ.agentNode.w, height: SZ.agentNode.h, background: c.bg, border: `1px dashed ${c.border}` }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <Dot color={c.dot} pulse={a.status === 'active'} />
        <span style={{ ...nTitle, color: c.text, flex: 1 }}>
          {a.name.length > 28 ? a.name.slice(0, 28) + '…' : a.name}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <span style={{ ...bdg, borderColor: c.border, color: c.text }}>agent</span>
        <span style={{ ...bdg, color: '#4b5563', borderColor: '#374151' }}>{a.type}</span>
      </div>
    </div>
  )
})
AgentNode.displayName = 'AgentNode'

const JobNode = memo(({ data }: NodeProps) => {
  const j = data as unknown as Job
  const c = sc(j.status)
  return (
    <div style={{ ...nBase, width: SZ.jobNode.w, height: SZ.jobNode.h, background: c.bg, borderColor: c.border }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <Dot color={c.dot} pulse={j.status === 'running'} />
        <span style={{ ...nTitle, color: c.text, flex: 1 }}>
          {j.name.length > 28 ? j.name.slice(0, 28) + '…' : j.name}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <span style={{ ...bdg, borderColor: c.border, color: c.text }}>{j.status}</span>
        {j.schedule && <span style={{ ...bdg, color: '#7c3aed', borderColor: '#4c1d95' }}>{j.schedule}</span>}
      </div>
    </div>
  )
})
JobNode.displayName = 'JobNode'

const CustomNode = memo(({ data }: NodeProps) => {
  const tn = data as unknown as CustomTreeNode
  const c = sc(tn.status)
  return (
    <div style={{ ...nBase, width: SZ.customNode.w, height: SZ.customNode.h, background: '#120d1f', border: `1px dashed ${c.border}` }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <Dot color={c.dot} pulse={tn.status === 'thinking' || tn.status === 'active'} />
        <span style={{ ...nTitle, color: '#c084fc', flex: 1 }}>
          {tn.label.length > 28 ? tn.label.slice(0, 28) + '…' : tn.label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <span style={{ ...bdg, borderColor: '#6d28d9', color: '#a855f7' }}>{tn.type}</span>
        {tn.status && <span style={{ ...bdg, borderColor: c.border, color: c.dot }}>{tn.status}</span>}
      </div>
    </div>
  )
})
CustomNode.displayName = 'CustomNode'

// ─── Node type registry (stable reference — defined outside component) ────────

const nodeTypes = {
  inputNode:       InputNode,
  openClawNode:    OpenClawNode,
  branchNode:      BranchNode,
  memoryFileNode:  MemoryFileNode,
  groupHeaderNode: GroupHeaderNode,
  taskNode:        TaskNode,
  agentNode:       AgentNode,
  jobNode:         JobNode,
  customNode:      CustomNode,
}

// ─── Small presentational helpers ────────────────────────────────────────────

function Divider() {
  return <div style={{ height: 1, background: '#161b22', margin: '0 14px' }} />
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.22em', color: '#30363d' }}>{children}</div>
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function VoiceAgentPage() {
  // ── LiveKit session ──────────────────────────────────────────────────────
  const {
    status,
    agentAudioStream,
    audioContext,
    connect,
    disconnect,
  } = useLiveKitSession()

  const isConnected = status === 'connected'

  // Derive AuraMode from connection status
  const auraMode: AuraMode = isConnected ? 'agent-speaking' : 'disconnected'

  // ── Audio analyser — pass all 3 required args ────────────────────────────
  // rmsRef is used directly by AuraVisualizer
  const { rmsRef } = useAudioAnalyser(
    audioContext ?? null,
    agentAudioStream ?? null,
    false  // isMic = false — we're analysing the agent stream
  )

  // ── Chat ──────────────────────────────────────────────────────────────────
  const [messages,  setMessages]  = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || isSending) return
    setMessages((p) => [...p, { role: 'user', text, timestamp: new Date() }])
    setInputText('')
    setIsSending(true)
    try {
      const res  = await fetch('/api/openclaw/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text }),
      })
      const data = await res.json()
      setMessages((p) => [
        ...p,
        { role: 'assistant', text: data.response ?? data.message ?? JSON.stringify(data), timestamp: new Date() },
      ])
    } catch {
      setMessages((p) => [...p, { role: 'assistant', text: '⚠ Connection error.', timestamp: new Date() }])
    } finally {
      setIsSending(false)
    }
  }, [inputText, isSending])

  // ── Polls ─────────────────────────────────────────────────────────────────
  const [tasks,       setTasks]       = useState<Task[]>([])
  const [agents,      setAgents]      = useState<Agent[]>([])
  const [jobs,        setJobs]        = useState<Job[]>([])
  const [treeNodes,   setTreeNodes]   = useState<CustomTreeNode[]>([])
  const [memoryFiles, setMemoryFiles] = useState<Record<string, MemoryFile>>({})
  const [telegramStatus,  setTelegramStatus]  = useState<TelegramStatus | null>(null)
  const [openClawStatus,  setOpenClawStatus]  = useState<OpenClawStatus | null>(null)

  useEffect(() => {
    const go = async () => { try { const r = await fetch('/api/tasks');      if (r.ok) setTasks(await r.json())      } catch {} }
    go(); const id = setInterval(go, 5000); return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const go = async () => { try { const r = await fetch('/api/agents');     if (r.ok) setAgents(await r.json())     } catch {} }
    go(); const id = setInterval(go, 5000); return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const go = async () => { try { const r = await fetch('/api/jobs/queue'); if (r.ok) setJobs(await r.json())       } catch {} }
    go(); const id = setInterval(go, 6000); return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const go = async () => { try { const r = await fetch('/api/tree/nodes'); if (r.ok) setTreeNodes(await r.json())  } catch {} }
    go(); const id = setInterval(go, 3000); return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const FILES = ['profile', 'tasks', 'conversations', 'automations']
    const go = async () => {
      const results = await Promise.allSettled(
        FILES.map((f) => fetch(`/api/memory/${f}`).then((r) => (r.ok ? r.json() : null)))
      )
      setMemoryFiles((prev) => {
        const next = { ...prev }
        results.forEach((res, i) => {
          if (res.status === 'fulfilled' && res.value != null) next[FILES[i]] = res.value as MemoryFile
        })
        return next
      })
    }
    go(); const id = setInterval(go, 10000); return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const go = async () => {
      try {
        const [intR, ocR] = await Promise.all([
          fetch('/api/integrations/status'),
          fetch('/api/openclaw/status'),
        ])
        if (intR.ok) {
          const d = await intR.json() as { telegram?: TelegramStatus }
          if (d.telegram) setTelegramStatus(d.telegram)
        }
        if (ocR.ok) setOpenClawStatus(await ocR.json() as OpenClawStatus)
      } catch {}
    }
    go(); const id = setInterval(go, 8000); return () => clearInterval(id)
  }, [])

  // ── React Flow ────────────────────────────────────────────────────────────
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  const onConnect = useCallback(
    (params: Connection) => setRfEdges((eds: Edge[]) => addEdge(params, eds)),
    [setRfEdges]
  )

  // Stable graph key — only rebuild when data actually changes
  const graphKey = JSON.stringify({
    t:  tasks.map((t)  => `${t.id}:${t.status}:${t.category}`),
    a:  agents.map((a) => `${a.id}:${a.status}`),
    j:  jobs.map((j)   => `${j.id}:${j.status}`),
    m:  Object.keys(memoryFiles).map((k) => `${k}:${memoryFiles[k]?.updated_at ?? 0}`),
    c:  treeNodes.map((n) => `${n.id}:${n.status}:${n.parent_id}`),
    tg: telegramStatus?.status,
    oc: `${openClawStatus?.status ?? ''}${openClawStatus?.model ?? ''}`,
    vc: isConnected,
    cm: messages.length,
  })

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const { nodes, edges } = buildGraph({
      tasks, agents, jobs, memoryFiles, treeNodes,
      telegramStatus,
      openClawStatus,
      voiceConnected: isConnected,
      chatMsgCount: messages.length,
    })
    setRfNodes(nodes)
    setRfEdges(edges)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey])

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    tasks:  tasks.length,
    done:   tasks.filter((t) => t.status === 'completed').length,
    agents: agents.filter((a) => a.status === 'active').length,
    jobs:   jobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    custom: treeNodes.length,
  }), [tasks, agents, jobs, treeNodes])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={css.root}>

        {/* ═══ SIDEBAR ══════════════════════════════════════════════════════ */}
        <aside style={css.sidebar}>

          {/* Header — OpenClawLogo takes no props */}
          <div style={css.sidebarHead}>
            <div style={{ position: 'relative', width: 30, height: 30, flexShrink: 0 }}>
              <OpenClawLogo />
              <span style={{ position: 'absolute', bottom: -3, right: -3, fontSize: 9, color: '#d97706' }}>⬡</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.appTitle}>GITWIX Agent</div>
              <div style={css.appSub}>katy · orchestrator</div>
            </div>
            <Dot
              color={(openClawStatus?.status === 'online') ? '#d97706' : '#52525b'}
              pulse={openClawStatus?.status === 'online'}
            />
          </div>

          <Divider />

          {/* Voice section */}
          <div style={css.section}>
            <SectionLabel>VOICE · LIVEKIT</SectionLabel>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0', height: 140 }}>
              {/* AuraVisualizer: auraMode + rmsRef (no style prop) */}
              <AuraVisualizer
                auraMode={auraMode}
                rmsRef={rmsRef as RefObject<number>}
              />
            </div>
            <button
              style={{ ...css.voiceBtn, ...(isConnected ? css.voiceBtnOn : {}) }}
              onClick={isConnected ? disconnect : connect}
            >
              {isConnected ? '⏹ Disconnect' : '⏵ Connect'}
            </button>
            {isConnected && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 9, color: '#22c55e', letterSpacing: '0.18em' }}>
                <Dot color="#22c55e" pulse /><span>Live</span>
              </div>
            )}
          </div>

          <Divider />

          {/* Chat section */}
          <div style={{ ...css.section, flex: 1, minHeight: 0 }}>
            <SectionLabel>CHAT · OPENCLAW</SectionLabel>
            <div style={css.chatScroll}>
              {messages.length === 0 && (
                <div style={{ fontSize: 10, color: '#30363d', textAlign: 'center', marginTop: 14, fontStyle: 'italic' }}>
                  Send a message to Katy…
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} style={{ ...css.bubble, ...(m.role === 'user' ? css.bubbleUser : css.bubbleBot) }}>
                  {m.text}
                </div>
              ))}
              {isSending && (
                <div style={{ ...css.bubble, ...css.bubbleBot }}>
                  <span style={{ letterSpacing: 4, animation: 'gtyping 1.3s infinite' }}>● ● ●</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                style={css.chatInput}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Message…"
                disabled={isSending}
              />
              <button
                style={{ ...css.sendBtn, opacity: (!inputText.trim() || isSending) ? 0.38 : 1 }}
                onClick={sendMessage}
                disabled={isSending || !inputText.trim()}
              >↑</button>
            </div>
          </div>

          {/* Stats bar */}
          <div style={css.statsBar}>
            {([ ['Tasks', stats.tasks, '#a1a1aa'], ['Done', stats.done, '#22c55e'],
                ['Agents', stats.agents, '#3b82f6'], ['Jobs', stats.jobs, '#a855f7'],
                ['Nodes', stats.custom, '#f59e0b'],
            ] as [string, number, string][]).map(([lbl, val, clr]) => (
              <div key={lbl} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span style={{ fontFamily: "'Oxanium',sans-serif", fontWeight: 700, fontSize: 14, color: clr, lineHeight: 1 }}>{val}</span>
                <span style={{ fontSize: 7, color: '#30363d', letterSpacing: '0.1em' }}>{lbl}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* ═══ CANVAS ═══════════════════════════════════════════════════════ */}
        <main style={css.canvas}>
          <div style={css.canvasBar}>
            <span style={css.canvasTitle}>Architecture</span>
            <div style={{ display: 'flex', gap: 14 }}>
              <span style={css.hint}>scroll · zoom</span>
              <span style={css.hint}>drag · pan</span>
              {treeNodes.length > 0 && (
                <span style={{ ...css.hint, color: '#7c3aed' }}>
                  {treeNodes.length} openclaw node{treeNodes.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, position: 'relative' }}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.1}
              maxZoom={2.5}
              proOptions={{ hideAttribution: true }}
              style={{ background: 'transparent' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#1a2030" />
              <Controls style={{ background: '#111318', border: '1px solid #1f2937', borderRadius: 8 }} />
              <MiniMap
                style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 8 }}
                nodeColor={(n: Node) => {
                  if (n.type === 'openClawNode')    return '#d97706'
                  if (n.type === 'branchNode')      return '#374151'
                  if (n.type === 'memoryFileNode')  return '#21262d'
                  if (n.type === 'groupHeaderNode') return (n.data?.color as string) ?? '#374151'
                  if (n.type === 'customNode')      return '#7c3aed'
                  return sc(n.data?.status as string | undefined).border
                }}
                maskColor="rgba(0,0,0,0.65)"
              />
            </ReactFlow>

            {tasks.length === 0 && agents.length === 0 && treeNodes.length === 0 && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none', zIndex: 1 }}>
                <div style={{ fontSize: 64, color: '#111827', lineHeight: 1 }}>⬡</div>
                <div style={{ fontSize: 10, color: '#1f2937', letterSpacing: '0.12em' }}>Waiting for OpenClaw activity…</div>
                <div style={{ fontSize: 9, color: '#111827', letterSpacing: '0.1em' }}>tree updates every 3–10 s</div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  )
}

// ─── Global CSS ───────────────────────────────────────────────────────────────

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Oxanium:wght@400;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080b0e; color: #e2e8f0; font-family: 'JetBrains Mono', monospace; overflow: hidden; }
  ::-webkit-scrollbar       { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 4px; }
  @keyframes gpulse  { 0%,100% { opacity:1; transform:scale(1); }    50% { opacity:0.4; transform:scale(1.35); } }
  @keyframes gtyping { 0%,100% { opacity:0.2; } 40% { opacity:1; } 80% { opacity:0.2; } }
  .react-flow__controls-button {
    background: #111318 !important; border-color: #1f2937 !important; color: #6b7280 !important;
    font-family: 'JetBrains Mono', monospace !important;
  }
  .react-flow__controls-button:hover { background: #1f2937 !important; color: #d1d5db !important; }
  .react-flow__edge-path { stroke-linecap: round; }
`

// ─── Page-level styles ────────────────────────────────────────────────────────

const css: Record<string, CSSProperties> = {
  root: {
    display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden',
    background: '#080b0e', fontFamily: "'JetBrains Mono', monospace",
  },
  sidebar: {
    width: 280, minWidth: 280, display: 'flex', flexDirection: 'column',
    background: '#0d1117', borderRight: '1px solid #161b22', zIndex: 20,
  },
  sidebarHead: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '16px 14px 13px',
  },
  appTitle: {
    fontFamily: "'Oxanium', sans-serif", fontWeight: 800, fontSize: 12,
    letterSpacing: '0.14em', color: '#f59e0b', lineHeight: 1,
  },
  appSub: { fontSize: 9, color: '#4b5563', letterSpacing: '0.18em', marginTop: 3 },
  section: { padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 9 },
  voiceBtn: {
    background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
    color: '#6b7280', fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
    padding: '7px 0', cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  },
  voiceBtnOn: { borderColor: '#22c55e', color: '#4ade80', background: '#052e16' },
  chatScroll: {
    flex: 1, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const,
    gap: 7, minHeight: 0, paddingRight: 2,
  },
  bubble: { borderRadius: 6, padding: '7px 10px', fontSize: 10, lineHeight: 1.6, wordBreak: 'break-word' as const },
  bubbleUser: {
    background: '#161b22', border: '1px solid #21262d', color: '#c9d1d9',
    alignSelf: 'flex-end' as const, maxWidth: '90%',
  },
  bubbleBot: {
    background: '#051a0a', border: '1px solid #14532d44', color: '#4ade80',
    alignSelf: 'flex-start' as const, maxWidth: '90%',
  },
  chatInput: {
    flex: 1, background: '#0d1117', border: '1px solid #21262d', borderRadius: 6,
    color: '#c9d1d9', fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
    padding: '7px 10px', outline: 'none',
  },
  sendBtn: {
    background: '#d97706', border: 'none', borderRadius: 6, color: '#000',
    fontWeight: 700, fontSize: 15, width: 34, cursor: 'pointer', transition: 'opacity 0.1s',
  },
  statsBar: { display: 'flex', borderTop: '1px solid #161b22', padding: '9px 8px', gap: 4 },
  canvas: {
    flex: 1, display: 'flex', flexDirection: 'column' as const, position: 'relative' as const,
    overflow: 'hidden', background: '#080b0e',
  },
  canvasBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 20px', borderBottom: '1px solid #111318', background: '#080b0e', zIndex: 5,
  },
  canvasTitle: {
    fontFamily: "'Oxanium', sans-serif", fontWeight: 700, fontSize: 11,
    letterSpacing: '0.16em', color: '#374151',
  },
  hint: { fontSize: 8, color: '#1f2937', letterSpacing: '0.1em' },
}
