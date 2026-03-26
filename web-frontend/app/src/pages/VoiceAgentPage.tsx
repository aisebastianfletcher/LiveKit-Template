/**
 * VoiceAgentPage.tsx — GITWIX Agent
 * UI-only redesign. All logic (polling, chat, LiveKit) is preserved unchanged.
 * New: React Flow workflow tree (centre) + sidebar (logo, voice, chat).
 *
 * npm install @xyflow/react dagre @types/dagre
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
}

interface Agent {
  id: string
  name: string
  type: string
  status: 'active' | 'idle' | 'completed'
  created_at: number
}

// ─── Constants & helpers ──────────────────────────────────────────────────────

const NODE_W = 200
const NODE_H = 72

const STATUS_COLORS = {
  // Task statuses
  completed: { bg: '#0d2e1a', border: '#22c55e', text: '#4ade80', dot: '#22c55e' },
  in_progress: { bg: '#0d1f3c', border: '#3b82f6', text: '#60a5fa', dot: '#3b82f6' },
  pending: { bg: '#1a1a1f', border: '#52525b', text: '#a1a1aa', dot: '#71717a' },
  // Agent statuses
  active: { bg: '#0d2e1a', border: '#22c55e', text: '#4ade80', dot: '#22c55e' },
  idle: { bg: '#1a1a1f', border: '#52525b', text: '#a1a1aa', dot: '#71717a' },
} as const

function getNodeColors(status: string) {
  return (
    STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.pending
  )
}

// ─── Dagre auto-layout ────────────────────────────────────────────────────────

function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40, marginx: 40, marginy: 40 })

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => g.setEdge(e.source, e.target))

  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 } }
  })
}

// ─── Custom React Flow nodes ──────────────────────────────────────────────────

/** Root "Steve" node */
function SteveNode({ data }: NodeProps) {
  return (
    <div style={styles.steveNode}>
      <Handle type="source" position={Position.Bottom} style={styles.handleInvis} />
      <div style={styles.steveName}>⬡ {data.label as string}</div>
      <div style={styles.steveSubtitle}>Orchestrator</div>
    </div>
  )
}

/** Category branch node (Short-term / Long-term) */
function CategoryNode({ data }: NodeProps) {
  return (
    <div style={styles.categoryNode}>
      <Handle type="target" position={Position.Top} style={styles.handleInvis} />
      <Handle type="source" position={Position.Bottom} style={styles.handleInvis} />
      <span style={styles.categoryLabel}>{data.label as string}</span>
    </div>
  )
}

/** Task node */
function TaskNode({ data }: NodeProps) {
  const c = getNodeColors(data.status as string)
  return (
    <div
      style={{
        ...styles.taskNode,
        background: c.bg,
        borderColor: c.border,
        boxShadow: `0 0 12px ${c.border}33`,
      }}
    >
      <Handle type="target" position={Position.Top} style={styles.handleInvis} />
      <Handle type="source" position={Position.Bottom} style={styles.handleInvis} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...styles.statusDot, background: c.dot }} />
        <span style={{ ...styles.taskTitle, color: c.text }}>
          {(data.label as string).length > 26
            ? (data.label as string).slice(0, 26) + '…'
            : (data.label as string)}
        </span>
      </div>
      <div style={styles.taskMeta}>
        <span style={styles.taskBadge}>{data.status as string}</span>
        {data.source && (
          <span style={styles.taskSource}>{data.source as string}</span>
        )}
      </div>
    </div>
  )
}

/** Agent node */
function AgentNode({ data }: NodeProps) {
  const c = getNodeColors(data.status as string)
  return (
    <div
      style={{
        ...styles.agentNode,
        background: c.bg,
        borderColor: c.border,
        boxShadow: `0 0 12px ${c.border}22`,
      }}
    >
      <Handle type="target" position={Position.Top} style={styles.handleInvis} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            ...styles.statusDot,
            background: c.dot,
            animation: data.status === 'active' ? 'pulse 1.4s infinite' : 'none',
          }}
        />
        <span style={{ ...styles.taskTitle, color: c.text }}>
          {(data.label as string).length > 26
            ? (data.label as string).slice(0, 26) + '…'
            : (data.label as string)}
        </span>
      </div>
      <div style={styles.taskMeta}>
        <span style={{ ...styles.taskBadge, borderColor: c.border, color: c.dot }}>
          agent
        </span>
        {data.agentType && (
          <span style={styles.taskSource}>{data.agentType as string}</span>
        )}
      </div>
    </div>
  )
}

const nodeTypes = {
  steveNode: SteveNode,
  categoryNode: CategoryNode,
  taskNode: TaskNode,
  agentNode: AgentNode,
}

// ─── Build graph from tasks + agents ─────────────────────────────────────────

function buildGraph(
  tasks: Task[],
  agents: Agent[]
): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = []
  const rawEdges: Edge[] = []

  // Root
  rawNodes.push({
    id: 'steve',
    type: 'steveNode',
    position: { x: 0, y: 0 },
    data: { label: 'steve' },
  })

  // Category branches
  const shortTermId = 'cat-short'
  const longTermId = 'cat-long'

  rawNodes.push({
    id: shortTermId,
    type: 'categoryNode',
    position: { x: 0, y: 0 },
    data: { label: 'Short-term' },
  })
  rawNodes.push({
    id: longTermId,
    type: 'categoryNode',
    position: { x: 0, y: 0 },
    data: { label: 'Long-term / Automation' },
  })

  rawEdges.push({
    id: 'e-steve-short',
    source: 'steve',
    target: shortTermId,
    type: 'smoothstep',
    style: { stroke: '#d97706', strokeWidth: 2, opacity: 0.7 },
  })
  rawEdges.push({
    id: 'e-steve-long',
    source: 'steve',
    target: longTermId,
    type: 'smoothstep',
    style: { stroke: '#d97706', strokeWidth: 2, opacity: 0.7 },
  })

  // Tasks — split by source heuristic (automation → long-term, else short-term)
  tasks.forEach((t) => {
    const isLong =
      t.source?.toLowerCase().includes('auto') ||
      t.source?.toLowerCase().includes('cron') ||
      t.source?.toLowerCase().includes('schedule')
    const parent = isLong ? longTermId : shortTermId
    const nodeId = `task-${t.id}`

    rawNodes.push({
      id: nodeId,
      type: 'taskNode',
      position: { x: 0, y: 0 },
      data: {
        label: t.title,
        status: t.status,
        source: t.source,
      },
    })
    rawEdges.push({
      id: `e-${parent}-${nodeId}`,
      source: parent,
      target: nodeId,
      type: 'smoothstep',
      style: { stroke: '#374151', strokeWidth: 1.5 },
    })
  })

  // Agents — always hang off long-term
  agents.forEach((a) => {
    const nodeId = `agent-${a.id}`
    rawNodes.push({
      id: nodeId,
      type: 'agentNode',
      position: { x: 0, y: 0 },
      data: {
        label: a.name,
        status: a.status,
        agentType: a.type,
      },
    })
    rawEdges.push({
      id: `e-long-${nodeId}`,
      source: longTermId,
      target: nodeId,
      type: 'smoothstep',
      style: { stroke: '#374151', strokeWidth: 1.5 },
    })
  })

  // Apply dagre layout
  const laidOut = applyDagreLayout(rawNodes, rawEdges)
  return { nodes: laidOut, edges: rawEdges }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function VoiceAgentPage() {
  // ── Voice / LiveKit ──────────────────────────────────────────────────────
  const { isConnected, connect, disconnect, room } = useLiveKitSession()
  const { analyserNode } = useAudioAnalyser(room)

  const auraMode: AuraMode = isConnected ? 'listening' : 'idle'

  // ── Chat state ───────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || isSending) return

    const userMsg: ChatMessage = { role: 'user', text, timestamp: new Date() }
    setMessages((prev) => [...prev, userMsg])
    setInputText('')
    setIsSending(true)

    try {
      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        text: data.response ?? data.message ?? JSON.stringify(data),
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: '⚠ Connection error.', timestamp: new Date() },
      ])
    } finally {
      setIsSending(false)
    }
  }, [inputText, isSending])

  // ── Tasks polling ─────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/tasks')
        if (res.ok) setTasks(await res.json())
      } catch {}
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  // ── Agents polling ────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<Agent[]>([])

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/agents')
        if (res.ok) setAgents(await res.json())
      } catch {}
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  // ── React Flow graph ──────────────────────────────────────────────────────
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  const onConnect = useCallback(
    (params: Connection) => setRfEdges((eds) => addEdge(params, eds)),
    [setRfEdges]
  )

  useEffect(() => {
    const { nodes, edges } = buildGraph(tasks, agents)
    setRfNodes(nodes)
    setRfEdges(edges)
  }, [tasks, agents])

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(
    () => ({
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'completed').length,
      active: tasks.filter((t) => t.status === 'in_progress').length,
      agents: agents.filter((a) => a.status === 'active').length,
    }),
    [tasks, agents]
  )

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{globalCss}</style>
      <div style={styles.root}>
        {/* ── LEFT SIDEBAR ───────────────────────────────────────────── */}
        <aside style={styles.sidebar}>
          {/* Header */}
          <div style={styles.sidebarHeader}>
            <OpenClawLogo style={{ width: 32, height: 32 }} />
            <div>
              <div style={styles.appTitle}>GITWIX Agent</div>
              <div style={styles.appSub}>steve</div>
            </div>
          </div>

          <div style={styles.divider} />

          {/* Voice section */}
          <div style={styles.sidebarSection}>
            <span style={styles.sectionLabel}>VOICE</span>
            <div style={styles.auraWrap}>
              <AuraVisualizer
                mode={auraMode}
                analyserNode={analyserNode ?? undefined}
                style={{ width: 80, height: 80 }}
              />
            </div>
            <button
              style={{
                ...styles.voiceBtn,
                ...(isConnected ? styles.voiceBtnActive : {}),
              }}
              onClick={isConnected ? disconnect : connect}
            >
              {isConnected ? '⏹ Disconnect' : '⏵ Connect'}
            </button>
            {isConnected && (
              <div style={styles.liveIndicator}>
                <span style={styles.liveDot} />
                Live
              </div>
            )}
          </div>

          <div style={styles.divider} />

          {/* Chat section */}
          <div style={{ ...styles.sidebarSection, flex: 1, minHeight: 0 }}>
            <span style={styles.sectionLabel}>CHAT</span>
            <div style={styles.chatMessages}>
              {messages.length === 0 && (
                <div style={styles.chatEmpty}>Ask Steve anything…</div>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    ...styles.chatBubble,
                    ...(m.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleBot),
                  }}
                >
                  {m.text}
                </div>
              ))}
              {isSending && (
                <div style={{ ...styles.chatBubble, ...styles.chatBubbleBot }}>
                  <span style={styles.typing}>●●●</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div style={styles.chatInputRow}>
              <input
                style={styles.chatInput}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Message…"
                disabled={isSending}
              />
              <button
                style={styles.chatSend}
                onClick={sendMessage}
                disabled={isSending || !inputText.trim()}
              >
                ↑
              </button>
            </div>
          </div>

          {/* Stats footer */}
          <div style={styles.statsRow}>
            <div style={styles.statBox}>
              <span style={styles.statNum}>{stats.total}</span>
              <span style={styles.statLbl}>Tasks</span>
            </div>
            <div style={styles.statBox}>
              <span style={{ ...styles.statNum, color: '#22c55e' }}>{stats.done}</span>
              <span style={styles.statLbl}>Done</span>
            </div>
            <div style={styles.statBox}>
              <span style={{ ...styles.statNum, color: '#60a5fa' }}>{stats.active}</span>
              <span style={styles.statLbl}>Active</span>
            </div>
            <div style={styles.statBox}>
              <span style={{ ...styles.statNum, color: '#f59e0b' }}>{stats.agents}</span>
              <span style={styles.statLbl}>Agents</span>
            </div>
          </div>
        </aside>

        {/* ── CENTRE: React Flow Canvas ──────────────────────────────── */}
        <main style={styles.canvas}>
          {/* Canvas header */}
          <div style={styles.canvasHeader}>
            <span style={styles.canvasTitle}>Workflow</span>
            <div style={styles.canvasHints}>
              <span style={styles.hint}>scroll to zoom</span>
              <span style={styles.hint}>drag to pan</span>
            </div>
          </div>

          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            style={{ background: 'transparent' }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="#27272a"
            />
            <Controls
              style={{
                background: '#18181b',
                border: '1px solid #3f3f46',
                borderRadius: 8,
              }}
            />
            <MiniMap
              style={{
                background: '#18181b',
                border: '1px solid #3f3f46',
                borderRadius: 8,
              }}
              nodeColor={(n) => {
                if (n.type === 'steveNode') return '#d97706'
                if (n.type === 'categoryNode') return '#4f4f58'
                const s = (n.data?.status as string) ?? 'pending'
                return getNodeColors(s).border
              }}
              maskColor="rgba(0,0,0,0.6)"
            />
          </ReactFlow>

          {tasks.length === 0 && agents.length === 0 && (
            <div style={styles.emptyCanvas}>
              <div style={styles.emptyIcon}>⬡</div>
              <div style={styles.emptyText}>Waiting for tasks from OpenClaw…</div>
            </div>
          )}
        </main>
      </div>
    </>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@400;600;700;800&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0c0c0e;
    color: #e4e4e7;
    font-family: 'IBM Plex Mono', monospace;
  }

  /* React Flow overrides */
  .react-flow__controls-button {
    background: #27272a !important;
    border-color: #3f3f46 !important;
    color: #a1a1aa !important;
  }
  .react-flow__controls-button:hover {
    background: #3f3f46 !important;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.3); }
  }

  @keyframes blink {
    0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
  }

  @keyframes typingDots {
    0% { opacity: 0.2; } 40% { opacity: 1; } 80%, 100% { opacity: 0.2; }
  }
`

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    background: '#0c0c0e',
    fontFamily: "'IBM Plex Mono', monospace",
  },

  // ── Sidebar ──────────────────────────────────────────────────────────────
  sidebar: {
    width: 280,
    minWidth: 280,
    display: 'flex',
    flexDirection: 'column',
    background: '#111113',
    borderRight: '1px solid #27272a',
    zIndex: 10,
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '18px 16px 14px',
  },
  appTitle: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 800,
    fontSize: 13,
    letterSpacing: '0.15em',
    color: '#f59e0b',
    lineHeight: 1,
  },
  appSub: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 10,
    color: '#71717a',
    letterSpacing: '0.2em',
    marginTop: 2,
  },
  divider: {
    height: 1,
    background: '#27272a',
    margin: '0 16px',
  },
  sidebarSection: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionLabel: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.2em',
    color: '#52525b',
  },
  auraWrap: {
    display: 'flex',
    justifyContent: 'center',
    padding: '4px 0',
  },
  voiceBtn: {
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 6,
    color: '#a1a1aa',
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    padding: '7px 0',
    cursor: 'pointer',
    transition: 'all 0.2s',
    letterSpacing: '0.05em',
  },
  voiceBtnActive: {
    borderColor: '#22c55e',
    color: '#4ade80',
    background: '#0d2e1a',
  },
  liveIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    fontSize: 10,
    color: '#22c55e',
    letterSpacing: '0.15em',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#22c55e',
    animation: 'pulse 1.4s infinite',
    display: 'inline-block',
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  chatMessages: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0,
    paddingRight: 2,
    scrollbarWidth: 'thin',
  } as React.CSSProperties,
  chatEmpty: {
    fontSize: 11,
    color: '#52525b',
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },
  chatBubble: {
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 11,
    lineHeight: 1.5,
    wordBreak: 'break-word',
  },
  chatBubbleUser: {
    background: '#1c1c20',
    border: '1px solid #3f3f46',
    color: '#e4e4e7',
    alignSelf: 'flex-end',
    maxWidth: '90%',
  },
  chatBubbleBot: {
    background: '#0d1a0d',
    border: '1px solid #14532d44',
    color: '#86efac',
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  typing: {
    letterSpacing: 3,
    animation: 'typingDots 1.2s infinite',
  },
  chatInputRow: {
    display: 'flex',
    gap: 6,
    marginTop: 4,
  },
  chatInput: {
    flex: 1,
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: 6,
    color: '#e4e4e7',
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    padding: '7px 10px',
    outline: 'none',
  },
  chatSend: {
    background: '#d97706',
    border: 'none',
    borderRadius: 6,
    color: '#000',
    fontWeight: 700,
    fontSize: 14,
    width: 34,
    cursor: 'pointer',
    transition: 'background 0.15s',
  },

  // ── Stats footer ──────────────────────────────────────────────────────────
  statsRow: {
    display: 'flex',
    borderTop: '1px solid #27272a',
    padding: '10px 8px',
    gap: 4,
  },
  statBox: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  statNum: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 16,
    color: '#e4e4e7',
    lineHeight: 1,
  },
  statLbl: {
    fontSize: 8,
    color: '#52525b',
    letterSpacing: '0.1em',
  },

  // ── Canvas ────────────────────────────────────────────────────────────────
  canvas: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
    background: '#0c0c0e',
  },
  canvasHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid #1c1c1f',
    zIndex: 5,
    background: '#0c0c0e',
  },
  canvasTitle: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: '0.12em',
    color: '#71717a',
  },
  canvasHints: {
    display: 'flex',
    gap: 12,
  },
  hint: {
    fontSize: 9,
    color: '#3f3f46',
    letterSpacing: '0.1em',
  },
  emptyCanvas: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    gap: 12,
  },
  emptyIcon: {
    fontSize: 48,
    color: '#27272a',
    lineHeight: 1,
  },
  emptyText: {
    fontSize: 11,
    color: '#3f3f46',
    letterSpacing: '0.1em',
  },

  // ── Node styles ───────────────────────────────────────────────────────────
  steveNode: {
    width: NODE_W,
    height: NODE_H,
    background: 'linear-gradient(135deg, #1c1100 0%, #2d1a00 100%)',
    border: '2px solid #d97706',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    boxShadow: '0 0 28px #d9770655, 0 0 8px #d9770622',
  },
  steveName: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 800,
    fontSize: 16,
    color: '#f59e0b',
    letterSpacing: '0.1em',
  },
  steveSubtitle: {
    fontSize: 9,
    color: '#92400e',
    letterSpacing: '0.2em',
  },
  categoryNode: {
    width: NODE_W,
    height: 44,
    background: '#18181b',
    border: '1px solid #52525b',
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: '#a1a1aa',
    letterSpacing: '0.12em',
  },
  taskNode: {
    width: NODE_W,
    height: NODE_H,
    border: '1px solid',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  agentNode: {
    width: NODE_W,
    height: NODE_H,
    border: '1px dashed',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  },
  taskTitle: {
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.3,
    flex: 1,
  },
  taskMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  taskBadge: {
    fontSize: 8,
    border: '1px solid #52525b',
    color: '#71717a',
    borderRadius: 4,
    padding: '1px 5px',
    letterSpacing: '0.1em',
  },
  taskSource: {
    fontSize: 8,
    color: '#52525b',
    letterSpacing: '0.05em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 100,
  },
  handleInvis: {
    opacity: 0,
    width: 1,
    height: 1,
  },
}
