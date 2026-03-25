import { useEffect, useRef, useState, useCallback } from 'react'
import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import OpenClawLogo from '@/components/OpenClawLogo'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

const SPEAKING_THRESHOLD = 0.02

const SKILLS = [
  { id: 'email', label: 'Email', connected: false },
  { id: 'calendar', label: 'Calendar', connected: false },
  { id: 'web', label: 'Web Search', connected: false },
]

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

function statusIcon(status: string) {
  if (status === 'completed') return '\u2705'
  if (status === 'in_progress') return '\u26A1'
  return '\u23F3'
}

export default function OpenClawPage() {
  const { status, agentAudioStream, audioContext, connect, disconnect } = useLiveKitSession()
  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'
  const { rmsRef } = useAudioAnalyser(audioContext, agentAudioStream, false)
  const [auraMode, setAuraMode] = useState<AuraMode>('idle')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [newTaskText, setNewTaskText] = useState('')
  const handleAddTask = async () => {
    const text = newTaskText.trim()
    if (!text) return
    setNewTaskText('')
    try {
      await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: text, status: 'pending', source: 'user' }) })
      fetchTasksAndAgents()
    } catch (_e) { /* silent */ }
  }

  const fetchTasksAndAgents = useCallback(async () => {
    try {
      const [tasksRes, agentsRes] = await Promise.all([
        fetch('/api/tasks'),
        fetch('/api/agents'),
      ])
      if (tasksRes.ok) setTasks(await tasksRes.json())
      if (agentsRes.ok) setAgents(await agentsRes.json())
    } catch (_e) { /* silent */ }
  }, [])

  // Always poll tasks (regardless of LiveKit connection)
  useEffect(() => {
    fetchTasksAndAgents()
    pollRef.current = setInterval(fetchTasksAndAgents, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchTasksAndAgents])

  // Also refresh agents when LiveKit connects/disconnects
  useEffect(() => {
    if (!isConnected) setAgents([])
  }, [isConnected])

  useEffect(() => {
    if (!isConnected) { setAuraMode('idle'); return }
    let raf: number
    const loop = () => {
      const rms = rmsRef.current
      if (rms > SPEAKING_THRESHOLD) setAuraMode('agent-speaking')
      else setAuraMode('idle')
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isConnected, rmsRef])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const sendTextToOpenClaw = async () => {
    const text = chatInput.trim()
    if (!text || isSending) return
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', text, timestamp: new Date() }])
    setIsSending(true)
    try {
      const messages = [...chatMessages, { role: 'user' as const, text }].map(m => ({
        role: m.role, content: m.text
      }))
      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
      const data = await res.json()
      const reply = data.reply || data.error || 'No response'
      setChatMessages(prev => [...prev, { role: 'assistant', text: reply, timestamp: new Date() }])
    } catch (_e) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: 'Error: could not reach OpenClaw', timestamp: new Date() }])
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ width: 320, borderRight: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #1a1a1a' }}>
          <OpenClawLogo />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2 }}>OPENCLAW</span>
        </div>
        <div style={{ padding: '8px 16px' }}>
          <span style={{ color: isConnected ? '#4ade80' : '#666', fontSize: 12 }}>
            {"\u25CF"} {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div style={{ borderBottom: '1px solid #1a1a1a', maxHeight: '30%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a', display: 'flex', justifyContent: 'space-between' }}>
            <span>TASKS</span>
            <span style={{ color: '#555' }}>{tasks.length}</span>
              <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
                <input
                  value={newTaskText}
                  onChange={e => setNewTaskText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddTask()}
                  placeholder="Add task..."
                  style={{ flex: 1, background: '#111', border: '1px solid #222', borderRadius: 4, padding: '4px 8px', color: '#fff', fontSize: 11, outline: 'none' }}
                />
                <button onClick={handleAddTask} disabled={!newTaskText.trim()} style={{ background: '#c8a64a', color: '#000', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                  +
                </button>
              </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
            {tasks.length === 0 ? (
              <div style={{ color: '#444', fontSize: 11, padding: '12px 0', textAlign: 'center' }}>No tasks yet</div>
            ) : tasks.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 11, borderBottom: '1px solid #111' }}>
                <span>{statusIcon(t.status)}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: t.status === 'completed' ? '#666' : '#ccc', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>{t.title}</div>
                  <div style={{ fontSize: 9, color: '#444', marginTop: 2 }}>{t.source} {"\u00B7"} {t.status}</div>
                </div>
              <button
                onClick={async () => { try { await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' }); fetchTasksAndAgents() } catch (_e) {} }}
                style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
              >×</button>
              </div>
            ))}
          </div>
        </div>
        <div style={{ borderBottom: '1px solid #1a1a1a', maxHeight: '25%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a', display: 'flex', justifyContent: 'space-between' }}>
            <span>AGENTS</span>
            <span style={{ color: '#555' }}>{agents.filter(a => a.status === 'active').length} active</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
            {agents.length === 0 ? (
              <div style={{ color: '#444', fontSize: 11, padding: '12px 0', textAlign: 'center' }}>No agents spawned</div>
            ) : agents.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 11, borderBottom: '1px solid #111' }}>
                <span style={{ color: a.status === 'active' ? '#4ade80' : '#666' }}>{"\u25CF"}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: a.status === 'completed' ? '#666' : '#ccc' }}>{a.name}</div>
                  <div style={{ fontSize: 9, color: '#444', marginTop: 2 }}>{a.type} {"\u00B7"} {a.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ borderBottom: '1px solid #1a1a1a', padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1 }}>
          <span>TEXT CHAT (OPENCLAW API)</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {chatMessages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: m.role === 'user' ? '#c8a64a' : '#4ade80', marginBottom: 2 }}>
                {m.role === 'user' ? 'You' : 'OpenClaw'}
              </div>
              <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.4 }}>{m.text}</div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <div style={{ padding: '8px 16px', display: 'flex', gap: 8, borderTop: '1px solid #1a1a1a' }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendTextToOpenClaw()}
            placeholder="Message OpenClaw..."
            style={{ flex: 1, background: '#111', border: '1px solid #222', borderRadius: 6, padding: '8px 12px', color: '#fff', fontSize: 12, outline: 'none' }}
          />
          <button onClick={sendTextToOpenClaw} disabled={isSending || !chatInput.trim()} style={{ background: '#c8a64a', color: '#000', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {isSending ? '...' : 'Send'}
          </button>
        </div>
        <div style={{ borderTop: '1px solid #1a1a1a', padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, marginBottom: 8 }}>SKILLS</div>
          {SKILLS.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '4px 0' }}>
              <span style={{ color: s.connected ? '#4ade80' : '#c8a64a' }}>{s.label}</span>
              <span style={{ color: '#555', fontSize: 10 }}>{s.connected ? 'Connected' : 'Not connected'}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1a1a1a', textAlign: 'center' }}>
          <span style={{ fontSize: 10, color: '#333' }}>Powered by OpenClaw AI</span>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32, position: 'relative' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, fontWeight: 300, margin: 0, color: '#fff' }}>OpenClaw Control Centre</h1>
          <p style={{ fontSize: 14, color: '#666', margin: '8px 0 0' }}>Voice-powered AI assistant</p>
        </div>
        <div style={{ position: 'relative', width: 280, height: 280 }}>
          <AuraVisualizer auraMode={auraMode} rmsRef={rmsRef} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 16, minHeight: 18 }}>
            {isConnecting ? 'Connecting...' : isConnected ? (auraMode === 'agent-speaking' ? 'OpenClaw is speaking' : auraMode === 'user-speaking' ? 'Listening...' : 'Connected') : 'Ready'}
          </div>
          <button
            onClick={() => (isConnected ? disconnect() : connect())}
            disabled={isConnecting}
            style={{ padding: '14px 40px', borderRadius: 8, border: 'none', background: isConnected ? '#333' : '#c8a64a', color: isConnected ? '#fff' : '#000', fontSize: 16, fontWeight: 600, cursor: isConnecting ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
          >
            {isConnecting ? 'Connecting...' : isConnected ? 'Stop OpenClaw' : 'Start OpenClaw'}
          </button>
        </div>
      </div>
    </div>
  )
}
