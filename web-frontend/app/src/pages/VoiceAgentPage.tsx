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
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
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

// ─── Skills interfaces ────────────────────────────────────────────────────────

interface CredentialField {
  key: string
  label: string
  placeholder: string
  type: 'text' | 'password'
}

interface SkillDef {
  id: string
  name: string
  icon: string
  description: string
  category: string
  requiredCredentials: CredentialField[]
}

interface SkillConfig {
  configured: boolean
  credentials: Record<string, string>
}

interface Workflow {
  id: string
  name: string
  description: string
  skillNodes: Node[]
  skillEdges: Edge[]
  status: 'draft' | 'active' | 'paused'
  createdAt: number
}

// ─── Skills data ──────────────────────────────────────────────────────────────

const SKILLS_DATA: SkillDef[] = [
  // CRM & Leads
  {
    id: 'hubspot', name: 'HubSpot CRM', icon: '🔶', description: 'Sync contacts, deals & pipelines', category: 'CRM & Leads',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key', placeholder: 'pat-na1-...', type: 'password' }],
  },
  {
    id: 'salesforce', name: 'Salesforce', icon: '☁️', description: 'Enterprise CRM integration', category: 'CRM & Leads',
    requiredCredentials: [
      { key: 'clientId',     label: 'Client ID',       placeholder: '3MVG9...',       type: 'text'     },
      { key: 'clientSecret', label: 'Client Secret',   placeholder: 'secret...',       type: 'password' },
      { key: 'instanceUrl',  label: 'Instance URL',    placeholder: 'https://org.salesforce.com', type: 'text' },
    ],
  },
  {
    id: 'pipedrive', name: 'Pipedrive', icon: '🔵', description: 'Manage deals & contacts', category: 'CRM & Leads',
    requiredCredentials: [{ key: 'apiToken', label: 'API Token', placeholder: 'abc123...', type: 'password' }],
  },
  {
    id: 'lead-scorer', name: 'Lead Scorer', icon: '🎯', description: 'AI-powered lead scoring', category: 'CRM & Leads',
    requiredCredentials: [],
  },
  {
    id: 'contact-enrichment', name: 'Contact Enrichment', icon: '📊', description: 'Enrich leads with company data', category: 'CRM & Leads',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key (Clearbit/Apollo)', placeholder: 'sk-...', type: 'password' }],
  },
  // Email & Outreach
  {
    id: 'gmail', name: 'Gmail Integration', icon: '✉️', description: 'Send & read emails', category: 'Email & Outreach',
    requiredCredentials: [
      { key: 'clientId',     label: 'Client ID',     placeholder: '123...apps.googleusercontent.com', type: 'text'     },
      { key: 'clientSecret', label: 'Client Secret', placeholder: 'GOCSPX-...',                       type: 'password' },
    ],
  },
  {
    id: 'outlook', name: 'Outlook/O365', icon: '📧', description: 'Microsoft email integration', category: 'Email & Outreach',
    requiredCredentials: [
      { key: 'clientId',     label: 'Client ID',     placeholder: 'azure-app-id',   type: 'text'     },
      { key: 'clientSecret', label: 'Client Secret', placeholder: 'secret...',       type: 'password' },
      { key: 'tenantId',     label: 'Tenant ID',     placeholder: 'tenant-guid',    type: 'text'     },
    ],
  },
  {
    id: 'sendgrid', name: 'SendGrid', icon: '📨', description: 'Transactional & bulk email', category: 'Email & Outreach',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key', placeholder: 'SG.xxx', type: 'password' }],
  },
  {
    id: 'mailchimp', name: 'Mailchimp', icon: '🐒', description: 'Email marketing campaigns', category: 'Email & Outreach',
    requiredCredentials: [
      { key: 'apiKey',        label: 'API Key',       placeholder: 'abc123-us1', type: 'password' },
      { key: 'serverPrefix',  label: 'Server Prefix', placeholder: 'us1',        type: 'text'     },
    ],
  },
  {
    id: 'cold-email', name: 'Cold Email Sequencer', icon: '📬', description: 'Automated outreach sequences', category: 'Email & Outreach',
    requiredCredentials: [],
  },
  // Social Media
  {
    id: 'instagram', name: 'Instagram DM', icon: '📸', description: 'Auto-reply to comments & send DMs', category: 'Social Media',
    requiredCredentials: [
      { key: 'accessToken',    label: 'Access Token',       placeholder: 'EAAG...', type: 'password' },
      { key: 'igBusinessId',   label: 'IG Business ID',     placeholder: '1234567890', type: 'text'  },
    ],
  },
  {
    id: 'facebook', name: 'Facebook Pages', icon: '👤', description: 'Manage posts, comments & Messenger', category: 'Social Media',
    requiredCredentials: [
      { key: 'pageAccessToken', label: 'Page Access Token', placeholder: 'EAABsb...', type: 'password' },
      { key: 'pageId',          label: 'Page ID',           placeholder: '12345678',  type: 'text'     },
    ],
  },
  {
    id: 'linkedin', name: 'LinkedIn', icon: '💼', description: 'Post content & manage connections', category: 'Social Media',
    requiredCredentials: [
      { key: 'accessToken',     label: 'Access Token',     placeholder: 'AQV...', type: 'password' },
      { key: 'organizationId',  label: 'Organization ID',  placeholder: 'urn:li:organization:...', type: 'text' },
    ],
  },
  {
    id: 'twitter', name: 'Twitter/X', icon: '🐦', description: 'Post tweets & monitor mentions', category: 'Social Media',
    requiredCredentials: [
      { key: 'apiKey',             label: 'API Key',              placeholder: 'abc...', type: 'password' },
      { key: 'apiSecret',          label: 'API Secret',           placeholder: 'xyz...', type: 'password' },
      { key: 'accessToken',        label: 'Access Token',         placeholder: '123-...', type: 'password' },
      { key: 'accessTokenSecret',  label: 'Access Token Secret',  placeholder: 'sec...', type: 'password' },
    ],
  },
  {
    id: 'tiktok', name: 'TikTok', icon: '🎵', description: 'Post content & monitor comments', category: 'Social Media',
    requiredCredentials: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'act.xxx', type: 'password' },
      { key: 'openId',      label: 'Open ID',      placeholder: 'user_open_id', type: 'text' },
    ],
  },
  {
    id: 'youtube', name: 'YouTube', icon: '▶️', description: 'Manage channel & reply to comments', category: 'Social Media',
    requiredCredentials: [
      { key: 'apiKey',    label: 'API Key',    placeholder: 'AIzaSy...', type: 'password' },
      { key: 'channelId', label: 'Channel ID', placeholder: 'UC...',     type: 'text'     },
    ],
  },
  // Content & Branding
  {
    id: 'brand-voice', name: 'Brand Voice AI', icon: '🎨', description: 'Learn your brand tone & style', category: 'Content & Branding',
    requiredCredentials: [],
  },
  {
    id: 'content-gen', name: 'Content Generator', icon: '✍️', description: 'Generate posts, captions & copy', category: 'Content & Branding',
    requiredCredentials: [],
  },
  {
    id: 'image-gen', name: 'Image Generator', icon: '🖼️', description: 'Create branded visuals', category: 'Content & Branding',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key (DALL-E/Midjourney)', placeholder: 'sk-...', type: 'password' }],
  },
  {
    id: 'canva', name: 'Canva Integration', icon: '🖌️', description: 'Design graphics from templates', category: 'Content & Branding',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key', placeholder: 'canva-...', type: 'password' }],
  },
  // Documents & Data
  {
    id: 'gsheets', name: 'Google Sheets', icon: '📗', description: 'Read/write spreadsheet data', category: 'Documents & Data',
    requiredCredentials: [
      { key: 'clientId',     label: 'Client ID',     placeholder: '123...apps.googleusercontent.com', type: 'text'     },
      { key: 'clientSecret', label: 'Client Secret', placeholder: 'GOCSPX-...',                       type: 'password' },
    ],
  },
  {
    id: 'gdocs', name: 'Google Docs', icon: '📄', description: 'Create & edit documents', category: 'Documents & Data',
    requiredCredentials: [
      { key: 'clientId',     label: 'Client ID',     placeholder: '123...apps.googleusercontent.com', type: 'text'     },
      { key: 'clientSecret', label: 'Client Secret', placeholder: 'GOCSPX-...',                       type: 'password' },
    ],
  },
  {
    id: 'notion', name: 'Notion', icon: '📓', description: 'Manage databases & pages', category: 'Documents & Data',
    requiredCredentials: [{ key: 'integrationToken', label: 'Integration Token', placeholder: 'secret_...', type: 'password' }],
  },
  {
    id: 'airtable', name: 'Airtable', icon: '🗃️', description: 'Flexible database management', category: 'Documents & Data',
    requiredCredentials: [
      { key: 'apiKey',  label: 'API Key', placeholder: 'pat...', type: 'password' },
      { key: 'baseId',  label: 'Base ID', placeholder: 'app...', type: 'text'     },
    ],
  },
  // Automation & Analytics
  {
    id: 'webhook', name: 'Webhook Trigger', icon: '🔗', description: 'Custom webhook endpoints', category: 'Automation & Analytics',
    requiredCredentials: [],
  },
  {
    id: 'zapier', name: 'Zapier', icon: '⚡', description: 'Connect to 5000+ apps', category: 'Automation & Analytics',
    requiredCredentials: [{ key: 'apiKey', label: 'API Key', placeholder: 'sk-...', type: 'password' }],
  },
  {
    id: 'analytics', name: 'Analytics Dashboard', icon: '📈', description: 'Track leads, conversions & ROI', category: 'Automation & Analytics',
    requiredCredentials: [],
  },
  {
    id: 'calendar', name: 'Calendar Booking', icon: '📅', description: 'Schedule meetings automatically', category: 'Automation & Analytics',
    requiredCredentials: [{ key: 'calendarApiKey', label: 'Calendar API Key (Cal.com/Calendly)', placeholder: 'cal_...', type: 'password' }],
  },
]

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
  skillNode:       { w: 200, h: 72  },
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
      subtitle: d.telegramStatus?.bot_username ?? '@karenkaty_bot',
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
            KATY
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

const SkillNode = memo(({ data }: NodeProps) => {
  const c = sc(data.status as string | undefined)
  return (
    <div style={{ ...nBase, width: SZ.skillNode.w, height: SZ.skillNode.h, background: '#0d1a2e', border: `1px solid ${c.border}`, boxShadow: `0 0 8px ${c.border}22` }}>
      <Handle type="target" position={Position.Top}    style={INV} />
      <Handle type="source" position={Position.Bottom} style={INV} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>{data.icon as string}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...nTitle, color: '#60a5fa', fontSize: 10 }}>
            {(data.name as string).length > MAX_SKILL_NAME_LEN ? (data.name as string).slice(0, MAX_SKILL_NAME_LEN) + '…' : (data.name as string)}
          </div>
          <div style={{ ...nSub, marginTop: 2 }}>{data.category as string}</div>
        </div>
        <Dot color={c.dot} pulse={data.status === 'active'} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <span style={{ ...bdg, borderColor: '#1d4ed8', color: '#60a5fa' }}>skill</span>
        <span style={{ ...bdg, borderColor: c.border, color: c.dot }}>{data.status as string}</span>
      </div>
    </div>
  )
})
SkillNode.displayName = 'SkillNode'

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
  skillNode:       SkillNode,
}

// ─── Skills constants ──────────────────────────────────────────────────────────

const MAX_SKILL_NAME_LEN = 22

const skillCardNameStyle: CSSProperties = {
  fontSize: 8, fontWeight: 600, color: '#c9d1d9', textAlign: 'center',
  letterSpacing: '0.03em', lineHeight: 1.3, wordBreak: 'break-word',
  width: '100%', overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
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
  return (
    <ReactFlowProvider>
      <VoiceAgentPageInner />
    </ReactFlowProvider>
  )
}

function VoiceAgentPageInner() {
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

  // ── Skills ────────────────────────────────────────────────────────────────
  const [skillConfigs,      setSkillConfigs]      = useState<Record<string, SkillConfig>>({})
  const [skillMenuOpen,     setSkillMenuOpen]      = useState(false)
  const [skillSearch,       setSkillSearch]        = useState('')
  const [activeSkillModal,  setActiveSkillModal]   = useState<SkillDef | null>(null)
  const [modalInputs,       setModalInputs]        = useState<Record<string, string>>({})
  const rfInstance = useReactFlow()

  // ── React Flow ────────────────────────────────────────────────────────────
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  // ── Workflow & canvas skill state ─────────────────────────────────────────
  const [canvasSkillNodes, setCanvasSkillNodes] = useState<Node[]>([])
  const [canvasSkillEdges, setCanvasSkillEdges] = useState<Edge[]>([])
  const [workflows,        setWorkflows]        = useState<Workflow[]>([])
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null)
  const [workflowsPanelOpen, setWorkflowsPanelOpen] = useState(true)

  // ── Save workflow modal ────────────────────────────────────────────────────
  const [saveModalOpen,   setSaveModalOpen]   = useState(false)
  const [wfName,          setWfName]          = useState('')
  const [wfDescription,   setWfDescription]  = useState('')

  // ── Context menu ──────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)

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

  // ── Skills handlers ───────────────────────────────────────────────────────
  const openSkillModal = useCallback((skill: SkillDef) => {
    setActiveSkillModal(skill)
    const existing = skillConfigs[skill.id]?.credentials ?? {}
    const init: Record<string, string> = {}
    skill.requiredCredentials.forEach((f) => { init[f.key] = existing[f.key] ?? '' })
    setModalInputs(init)
  }, [skillConfigs])

  const closeSkillModal = useCallback(() => {
    setActiveSkillModal(null)
    setModalInputs({})
  }, [])

  const connectSkill = useCallback(() => {
    if (!activeSkillModal) return
    setSkillConfigs((prev) => ({
      ...prev,
      [activeSkillModal.id]: { configured: true, credentials: { ...modalInputs } },
    }))
    closeSkillModal()
  }, [activeSkillModal, modalInputs, closeSkillModal])

  const onSkillDragStart = useCallback((e: React.DragEvent, skill: SkillDef) => {
    e.dataTransfer.setData('application/skill-id', skill.id)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const skillId = e.dataTransfer.getData('application/skill-id')
    if (!skillId) return
    const skill = SKILLS_DATA.find((s) => s.id === skillId)
    if (!skill) return
    const position = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const newNodeId = `skill-${skill.id}-${Date.now()}`
    const newNode: Node = {
      id:       newNodeId,
      type:     'skillNode',
      position,
      data: {
        icon:     skill.icon,
        name:     skill.name,
        category: skill.category,
        skillId:  skill.id,
        status:   'active',
      },
    }
    setCanvasSkillNodes((prev) => [...prev, newNode])
    // Notify OpenClaw about the new skill
    void fetch('/api/openclaw/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `[SKILL ADDED] I've added ${skill.name} to my workflow canvas. It's ready to be connected.` }),
    }).then((r) => r.json()).then((d) => {
      setMessages((p) => [...p, { role: 'assistant', text: d.response ?? d.message ?? '✅ Skill added.', timestamp: new Date() }])
    }).catch(() => {})
  }, [rfInstance, setCanvasSkillNodes, setMessages])

  const filteredSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase()
    if (!q) return SKILLS_DATA
    return SKILLS_DATA.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)
    )
  }, [skillSearch])

  // ── Workflow handlers ─────────────────────────────────────────────────────
  const saveWorkflow = useCallback(() => {
    if (!wfName.trim()) return
    const wf: Workflow = {
      id: `wf-${Date.now()}`,
      name: wfName.trim(),
      description: wfDescription.trim(),
      skillNodes: canvasSkillNodes,
      skillEdges: canvasSkillEdges,
      status: 'draft',
      createdAt: Date.now(),
    }
    setWorkflows((prev) => [...prev, wf])
    setSaveModalOpen(false)
    setWfName('')
    setWfDescription('')
  }, [wfName, wfDescription, canvasSkillNodes, canvasSkillEdges])

  const loadWorkflow = useCallback((wf: Workflow) => {
    setCanvasSkillNodes(wf.skillNodes)
    setCanvasSkillEdges(wf.skillEdges)
    setActiveWorkflowId(wf.id)
  }, [])

  const activateWorkflow = useCallback(async (wf: Workflow) => {
    const skillNames = wf.skillNodes.map((n) => n.data.name as string).join(' -> ')
    const msg = `[WORKFLOW ACTIVATED] Workflow '${wf.name}': Skills chain: ${skillNames}. Description: ${wf.description}. Please acknowledge and begin monitoring these integrations.`
    setWorkflows((prev) => prev.map((w) => w.id === wf.id ? { ...w, status: w.status === 'active' ? 'paused' : 'active' } : w))
    try {
      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      })
      const d = await res.json()
      setMessages((p) => [...p, { role: 'assistant', text: d.response ?? d.message ?? '✅ Workflow activated.', timestamp: new Date() }])
    } catch {}
  }, [setMessages])

  const clearCanvas = useCallback(() => {
    setCanvasSkillNodes([])
    setCanvasSkillEdges([])
    setActiveWorkflowId(null)
  }, [])

  const onNodeContextMenu = useCallback((e: { preventDefault: () => void; clientX: number; clientY: number }, node: Node) => {
    if (node.type !== 'skillNode') return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
  }, [])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const ctxRemoveNode = useCallback(() => {
    if (!ctxMenu) return
    setCanvasSkillNodes((prev) => prev.filter((n) => n.id !== ctxMenu.nodeId))
    setCanvasSkillEdges((prev) => prev.filter((e) => e.source !== ctxMenu.nodeId && e.target !== ctxMenu.nodeId))
    closeCtxMenu()
  }, [ctxMenu, closeCtxMenu])

  const ctxDisconnect = useCallback(() => {
    if (!ctxMenu) return
    setCanvasSkillEdges((prev) => prev.filter((e) => e.source !== ctxMenu.nodeId && e.target !== ctxMenu.nodeId))
    closeCtxMenu()
  }, [ctxMenu, closeCtxMenu])

  const ctxConfigure = useCallback(() => {
    if (!ctxMenu) return
    const node = canvasSkillNodes.find((n) => n.id === ctxMenu.nodeId)
    if (node) {
      const skillId = node.data.skillId as string | undefined
      const skill = skillId ? SKILLS_DATA.find((s) => s.id === skillId) : null
      if (skill) openSkillModal(skill)
    }
    closeCtxMenu()
  }, [ctxMenu, canvasSkillNodes, openSkillModal, closeCtxMenu])

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

  const onConnect = useCallback(
    (params: Connection) => {
      // Check if both endpoints are skill nodes
      const srcIsSkill = rfNodes.some((n) => n.id === params.source && n.type === 'skillNode')
      const tgtIsSkill = rfNodes.some((n) => n.id === params.target && n.type === 'skillNode')
      if (srcIsSkill || tgtIsSkill) {
        const baseEdge = addEdge(params, [])
        if (baseEdge.length > 0) {
          const newEdge: Edge = Object.assign({}, baseEdge[0], {
            type: 'smoothstep',
            style: { stroke: '#6d28d9', strokeWidth: 1.5, strokeDasharray: '5 3' },
            label: (srcIsSkill && tgtIsSkill) ? 'data' : undefined,
          })
          setCanvasSkillEdges((eds) => [...eds, newEdge])
        }
      } else {
        setRfEdges((eds) => addEdge(params, eds))
      }
    },
    [rfNodes, setRfEdges, setCanvasSkillEdges]
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
    // Preserve positions the user has dragged to; only use built positions for new nodes
    // Merge with user-placed skill nodes so they are never overwritten
    setRfNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]))
      const baseNodes = nodes.map((n) => posMap.has(n.id) ? { ...n, position: posMap.get(n.id)! } : n)
      // Skill nodes that are already in base (from buildGraph) should not be duplicated
      const baseIds = new Set(baseNodes.map((n) => n.id))
      const extraSkillNodes = canvasSkillNodes.filter((n) => !baseIds.has(n.id))
      return [...baseNodes, ...extraSkillNodes]
    })
    setRfEdges([...edges, ...canvasSkillEdges])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, canvasSkillNodes, canvasSkillEdges])

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    tasks:  tasks.length,
    done:   tasks.filter((t) => t.status === 'completed').length,
    agents: agents.filter((a) => a.status === 'active').length,
    jobs:   jobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    custom: treeNodes.length,
  }), [tasks, agents, jobs, treeNodes])

  const connectedSkillCount = useMemo(
    () => Object.values(skillConfigs).filter((c) => c.configured).length,
    [skillConfigs]
  )

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
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0', height: 140, width: '100%' }}>
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
          <div style={{ ...css.section, flex: skillMenuOpen ? '0 0 160px' : 1, minHeight: 0, overflow: 'hidden' }}>
            <SectionLabel>CHAT · KATY</SectionLabel>
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

          <Divider />

          {/* Workflows section */}
          <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto', minHeight: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px 8px' }}>
              <SectionLabel>WORKFLOWS</SectionLabel>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                {canvasSkillNodes.length > 0 && (
                  <button
                    onClick={() => setSaveModalOpen(true)}
                    style={{ background: '#1c1100', border: '1px solid #d97706', borderRadius: 4, color: '#fbbf24', cursor: 'pointer', padding: '3px 7px', fontSize: 9, lineHeight: 1, letterSpacing: '0.08em' }}
                  >+ Save</button>
                )}
                <button
                  onClick={() => setWorkflowsPanelOpen((v) => !v)}
                  style={{ background: 'none', border: '1px solid #2a2a4a', borderRadius: 4, color: workflowsPanelOpen ? '#fbbf24' : '#4b5563', cursor: 'pointer', padding: '3px 6px', fontSize: 11, lineHeight: 1, transition: 'all 0.15s' }}
                >
                  {workflowsPanelOpen ? '▾' : '▸'}
                </button>
              </div>
            </div>
            {workflowsPanelOpen && (
              <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {workflows.length === 0 && (
                  <div style={{ fontSize: 9, color: '#2a2a4a', textAlign: 'center', padding: '8px 0', fontStyle: 'italic' }}>
                    No workflows yet. Drop skills on canvas, then save.
                  </div>
                )}
                {workflows.map((wf) => (
                  <div
                    key={wf.id}
                    onClick={() => loadWorkflow(wf)}
                    style={{ background: wf.id === activeWorkflowId ? '#0d1a2e' : '#0d0d1a', border: `1px solid ${wf.status === 'active' ? '#22c55e44' : '#2a2a4a'}`, borderRadius: 6, padding: '7px 9px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 9, color: '#c9d1d9', fontWeight: 600, letterSpacing: '0.04em' }}>{wf.name}</span>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {wf.status === 'active' && <Dot color="#22c55e" pulse />}
                        <span style={{ fontSize: 8, color: wf.status === 'active' ? '#22c55e' : '#4b5563', border: `1px solid ${wf.status === 'active' ? '#22c55e44' : '#2a2a4a'}`, borderRadius: 3, padding: '1px 4px', letterSpacing: '0.06em' }}>
                          {wf.status}
                        </span>
                        <button
                          onClick={(ev) => { ev.stopPropagation(); void activateWorkflow(wf) }}
                          style={{ background: wf.status === 'active' ? '#052e16' : '#1c1100', border: `1px solid ${wf.status === 'active' ? '#22c55e' : '#d97706'}`, borderRadius: 3, color: wf.status === 'active' ? '#4ade80' : '#fbbf24', cursor: 'pointer', padding: '2px 5px', fontSize: 8, lineHeight: 1 }}
                        >
                          {wf.status === 'active' ? '⏸' : '▶'}
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 8, color: '#4b5563', letterSpacing: '0.04em' }}>
                      {wf.skillNodes.length} skill{wf.skillNodes.length !== 1 ? 's' : ''}
                      {wf.description && ` · ${wf.description.slice(0, 30)}${wf.description.length > 30 ? '…' : ''}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Divider />

          {/* Skills section */}
          <div style={{ display: 'flex', flexDirection: 'column', flex: skillMenuOpen ? 1 : '0 0 auto', minHeight: 0, overflow: 'hidden' }}>
            {/* Skills header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px 8px' }}>
              <SectionLabel>SKILLS</SectionLabel>
              <button
                onClick={() => setSkillMenuOpen((v) => !v)}
                style={{ background: 'none', border: '1px solid #2a2a4a', borderRadius: 4, color: skillMenuOpen ? '#fbbf24' : '#4b5563', cursor: 'pointer', padding: '3px 6px', fontSize: 11, lineHeight: 1, transition: 'all 0.15s' }}
                title={skillMenuOpen ? 'Collapse skills' : 'Expand skills'}
              >
                {skillMenuOpen ? '▾' : '⊞'}
              </button>
            </div>

            {/* Skills panel (collapsible) */}
            {skillMenuOpen && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 14px 10px', gap: 8, overflow: 'hidden' }}>
                {/* Search */}
                <input
                  style={{ ...css.chatInput, width: '100%' }}
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="Search skills…"
                />
                {/* Card grid */}
                <div style={{ overflowY: 'auto', flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, paddingRight: 2 }}>
                  {filteredSkills.map((skill) => {
                    const configured = skillConfigs[skill.id]?.configured ?? false
                    const draggable  = configured
                    return (
                      <div
                        key={skill.id}
                        draggable={draggable}
                        onDragStart={draggable ? (e) => onSkillDragStart(e, skill) : undefined}
                        onClick={() => openSkillModal(skill)}
                        title={`${skill.name} — ${skill.description}`}
                        style={{
                          background: '#0d0d1a',
                          border: `1px solid ${configured ? '#22c55e44' : '#2a2a4a'}`,
                          borderRadius: 6,
                          padding: '7px 5px 6px',
                          cursor: draggable ? 'grab' : 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 3,
                          minHeight: 70,
                          position: 'relative',
                          transition: 'border-color 0.15s, background 0.15s',
                          userSelect: 'none',
                        }}
                      >
                        {configured && (
                          <span style={{ position: 'absolute', top: 4, right: 5, width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                        )}
                        <span style={{ fontSize: 16, lineHeight: 1.2 }}>{skill.icon}</span>
                        <span style={skillCardNameStyle}>
                          {skill.name}
                        </span>
                      </div>
                    )
                  })}
                  {filteredSkills.length === 0 && (
                    <div style={{ gridColumn: '1/-1', fontSize: 9, color: '#30363d', textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>
                      No skills match "{skillSearch}"
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 8, color: '#2a2a4a', textAlign: 'center', letterSpacing: '0.1em' }}>
                  {connectedSkillCount} / {SKILLS_DATA.length} connected · drag to canvas
                </div>
              </div>
            )}
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
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {canvasSkillNodes.length > 0 && (
                <>
                  <button
                    onClick={() => setSaveModalOpen(true)}
                    style={{ background: '#1c1100', border: '1px solid #d97706', borderRadius: 5, color: '#fbbf24', cursor: 'pointer', padding: '4px 10px', fontSize: 9, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}
                  >💾 Save Workflow</button>
                  <button
                    onClick={clearCanvas}
                    style={{ background: '#111318', border: '1px solid #374151', borderRadius: 5, color: '#6b7280', cursor: 'pointer', padding: '4px 10px', fontSize: 9, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}
                  >✕ Clear Canvas</button>
                </>
              )}
              <span style={css.hint}>scroll · zoom</span>
              <span style={css.hint}>drag · pan</span>
              {treeNodes.length > 0 && (
                <span style={{ ...css.hint, color: '#7c3aed' }}>
                  {treeNodes.length} openclaw node{treeNodes.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          <div style={{ flex: 1, position: 'relative' }} onDrop={onCanvasDrop} onDragOver={onCanvasDragOver}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeContextMenu={onNodeContextMenu}
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
                  if (n.type === 'skillNode')       return '#1d4ed8'
                  return sc(n.data?.status as string | undefined).border
                }}
                maskColor="rgba(0,0,0,0.65)"
              />
            </ReactFlow>


          </div>
        </main>
      </div>

      {/* ═══ CREDENTIAL MODAL ═══════════════════════════════════════════════ */}
      {activeSkillModal && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget) closeSkillModal() }}
        >
          <div style={{ background: '#0d1117', border: '1px solid #2a2a4a', borderRadius: 10, padding: '24px 22px', width: 360, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 0 60px #000a' }}>
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 26, lineHeight: 1 }}>{activeSkillModal.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "'Oxanium', sans-serif", fontWeight: 700, fontSize: 14, color: '#fbbf24', letterSpacing: '0.08em' }}>
                  {activeSkillModal.name}
                </div>
                <div style={{ fontSize: 9, color: '#4b5563', marginTop: 2, letterSpacing: '0.06em' }}>{activeSkillModal.category}</div>
              </div>
              <button onClick={closeSkillModal} style={{ background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>✕</button>
            </div>
            <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.6, borderTop: '1px solid #161b22', paddingTop: 12 }}>
              {activeSkillModal.description}
            </div>

            {/* Credential fields or built-in message */}
            {activeSkillModal.requiredCredentials.length === 0 ? (
              <div style={{ background: '#052e16', border: '1px solid #14532d44', borderRadius: 6, padding: '12px 14px', fontSize: 10, color: '#4ade80', lineHeight: 1.6 }}>
                ✅ This skill is built-in and ready to use. No credentials needed.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeSkillModal.requiredCredentials.map((field) => (
                  <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 9, color: '#9ca3af', letterSpacing: '0.08em', fontWeight: 600, textTransform: 'uppercase' }}>
                      {field.label}
                    </label>
                    <input
                      type={field.type}
                      placeholder={field.placeholder}
                      value={modalInputs[field.key] ?? ''}
                      onChange={(e) => setModalInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      style={{ ...css.chatInput, width: '100%', fontSize: 11 }}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                onClick={connectSkill}
                style={{ flex: 1, background: '#15803d', border: '1px solid #22c55e', borderRadius: 6, color: '#fff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, padding: '9px 0', cursor: 'pointer', letterSpacing: '0.06em', transition: 'background 0.15s' }}
              >
                {activeSkillModal.requiredCredentials.length === 0 ? 'Activate' : 'Connect'}
              </button>
              <button
                onClick={closeSkillModal}
                style={{ background: '#111318', border: '1px solid #2a2a4a', borderRadius: 6, color: '#6b7280', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", padding: '9px 16px', cursor: 'pointer', letterSpacing: '0.06em' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ SAVE WORKFLOW MODAL ════════════════════════════════════════════ */}
      {saveModalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget) { setSaveModalOpen(false) } }}
        >
          <div style={{ background: '#0d1117', border: '1px solid #2a2a4a', borderRadius: 10, padding: '24px 22px', width: 360, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 0 60px #000a' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontFamily: "'Oxanium', sans-serif", fontWeight: 700, fontSize: 13, color: '#fbbf24', letterSpacing: '0.08em' }}>Save Workflow</div>
              <button onClick={() => setSaveModalOpen(false)} style={{ background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}>✕</button>
            </div>
            <div style={{ fontSize: 9, color: '#4b5563' }}>{canvasSkillNodes.length} skill node{canvasSkillNodes.length !== 1 ? 's' : ''} · {canvasSkillEdges.length} connection{canvasSkillEdges.length !== 1 ? 's' : ''}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 9, color: '#9ca3af', letterSpacing: '0.08em', fontWeight: 600, textTransform: 'uppercase' as const }}>Workflow Name</label>
              <input
                style={{ ...css.chatInput, width: '100%', fontSize: 11 }}
                value={wfName}
                onChange={(e) => setWfName(e.target.value)}
                placeholder="e.g. Instagram Lead Funnel"
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 9, color: '#9ca3af', letterSpacing: '0.08em', fontWeight: 600, textTransform: 'uppercase' as const }}>Description (optional)</label>
              <textarea
                style={{ ...css.chatInput, width: '100%', fontSize: 10, resize: 'vertical', minHeight: 60 } as CSSProperties}
                value={wfDescription}
                onChange={(e) => setWfDescription(e.target.value)}
                placeholder="What does this workflow do?"
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={saveWorkflow}
                disabled={!wfName.trim()}
                style={{ flex: 1, background: '#15803d', border: '1px solid #22c55e', borderRadius: 6, color: '#fff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, padding: '9px 0', cursor: wfName.trim() ? 'pointer' : 'not-allowed', opacity: wfName.trim() ? 1 : 0.4, letterSpacing: '0.06em' }}
              >Save</button>
              <button
                onClick={() => setSaveModalOpen(false)}
                style={{ background: '#111318', border: '1px solid #2a2a4a', borderRadius: 6, color: '#6b7280', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", padding: '9px 16px', cursor: 'pointer', letterSpacing: '0.06em' }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ CONTEXT MENU ═══════════════════════════════════════════════════ */}
      {ctxMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1002 }}
          onClick={closeCtxMenu}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            style={{ position: 'absolute', top: ctxMenu.y, left: ctxMenu.x, background: '#111318', border: '1px solid #2a2a4a', borderRadius: 8, padding: '6px 0', minWidth: 170, boxShadow: '0 8px 32px #000a', zIndex: 1003 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={ctxConfigure} style={{ display: 'block', width: '100%', background: 'none', border: 'none', color: '#c9d1d9', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '8px 14px', textAlign: 'left', cursor: 'pointer', letterSpacing: '0.04em' }}>
              ⚙ Configure
            </button>
            <button onClick={ctxDisconnect} style={{ display: 'block', width: '100%', background: 'none', border: 'none', color: '#6b7280', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '8px 14px', textAlign: 'left', cursor: 'pointer', letterSpacing: '0.04em' }}>
              ✂ Disconnect all
            </button>
            <div style={{ height: 1, background: '#1f2937', margin: '4px 0' }} />
            <button onClick={ctxRemoveNode} style={{ display: 'block', width: '100%', background: 'none', border: 'none', color: '#ef4444', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '8px 14px', textAlign: 'left', cursor: 'pointer', letterSpacing: '0.04em' }}>
              ✕ Remove from canvas
            </button>
          </div>
        </div>
      )}
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
