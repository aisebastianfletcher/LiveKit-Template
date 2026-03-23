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

const SYSTEM_PROMPT = `You are OpenClaw, a voice-powered AI assistant with a task management dashboard. When you are working on something or need to track work, you MUST use these markers in your response:

To create a task: [TASK:task description here]
To spawn an agent/sub-agent: [AGENT:agent_name:agent_type:description]
To mark a task done: [TASK_DONE:task description]
To mark an agent completed: [AGENT_DONE:agent_name]

For example:
- If asked to check emails: "I'll check your emails now. [TASK:Check inbox for new emails] [AGENT:email_scanner:email:Scanning inbox for unread messages]"
- When done: "Found 3 new emails. [TASK_DONE:Check inbox for new emails] [AGENT_DONE:email_scanner]"

Always use these markers so the user can see tasks and agents on the dashboard. Keep responses concise.`

export default function OpenClawPage() {
  const {
    status, localMicStream, agentAudioStream, audioContext, segments, connect, disconnect,
  } = useLiveKitSession()

  const { rmsRef: micRmsRef } = useAudioAnalyser(audioContext, localMicStream, true)
  const { rmsRef: agentRmsRef } = useAudioAnalyser(audioContext, agentAudioStream, false)
  const combinedRmsRef = useRef(0)
  const [auraMode, setAuraMode] = useState<AuraMode>('disconnected')
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [textInput, setTextInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'

  // Fetch tasks on mount
  useEffect(() => {
    fetch('/api/tasks').then(r => r.json()).then(setTasks).catch(() => {})
  }, [])

  const parseAndCreateItems = useCallback(async (text: string) => {
    // Parse [TASK:...] markers
    const taskMatches = text.matchAll(/\[TASK:([^\]]+)\]/g)
    for (const m of taskMatches) {
      const title = m[1].trim()
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, status: 'in_progress', source: 'openclaw' }),
        })
        if (res.ok) {
          const task = await res.json()
          setTasks(prev => [...prev, task])
        }
      } catch {}
    }
    // Parse [TASK_DONE:...] markers
    const doneMatches = text.matchAll(/\[TASK_DONE:([^\]]+)\]/g)
    for (const m of doneMatches) {
      const title = m[1].trim()
      setTasks(prev => prev.map(t =>
        t.title.toLowerCase() === title.toLowerCase() ? { ...t, status: 'completed' as const, updated_at: Date.now() / 1000 } : t
      ))
    }
    // Parse [AGENT:name:type:desc] markers
    const agentMatches = text.matchAll(/\[AGENT:([^:]+):([^:]+):([^\]]+)\]/g)
    for (const m of agentMatches) {
      const agent: Agent = {
        id: Math.random().toString(36).slice(2, 10),
        name: m[1].trim(),
        type: m[2].trim(),
        status: 'active',
        created_at: Date.now() / 1000,
      }
      setAgents(prev => [...prev, agent])
    }
    // Parse [AGENT_DONE:name] markers
    const agentDoneMatches = text.matchAll(/\[AGENT_DONE:([^\]]+)\]/g)
    for (const m of agentDoneMatches) {
      const name = m[1].trim()
      setAgents(prev => prev.map(a =>
        a.name.toLowerCase() === name.toLowerCase() ? { ...a, status: 'completed' as const } : a
      ))
    }
  }, [])

  // Strip markers from displayed text
  const cleanText = (text: string) =>
    text.replace(/\[TASK:[^\]]+\]/g, '').replace(/\[TASK_DONE:[^\]]+\]/g, '').replace(/\[AGENT:[^\]]+\]/g, '').replace(/\[AGENT_DONE:[^\]]+\]/g, '').trim()

  useEffect(() => {
    if (status !== 'connected') {
      setAuraMode('disconnected')
      combinedRmsRef.current = 0
      return
    }
    let animId: number
    const loop = () => {
      const mic = micRmsRef.current
      const agent = agentRmsRef.current
      combinedRmsRef.current = Math.max(mic, agent)
      if (agent > SPEAKING_THRESHOLD) setAuraMode('agent-speaking')
      else if (mic > SPEAKING_THRESHOLD) setAuraMode('user-speaking')
      else setAuraMode('idle')
      animId = requestAnimationFrame(loop)
    }
    animId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animId)
  }, [status])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const sendTextToOpenClaw = async () => {
    if (!textInput.trim() || isSending) return
    const userMsg = textInput.trim()
    setTextInput('')
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg, timestamp: new Date() }])
    setIsSending(true)
    try {
      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          stream: false,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const reply = data.choices?.[0]?.message?.content || 'No response'
        await parseAndCreateItems(reply)
        setChatMessages(prev => [...prev, { role: 'assistant', text: cleanText(reply), timestamp: new Date() }])
      } else {
        const errText = await res.text()
        setChatMessages(prev => [...prev, { role: 'assistant', text: `Error ${res.status}: ${errText}`, timestamp: new Date() }])
      }
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: `Connection error: ${err.message}`, timestamp: new Date() }])
    }
    setIsSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendTextToOpenClaw()
    }
  }

  const statusIcon = (s: string) => s === 'completed' ? '\u2705' : s === 'in_progress' || s === 'active' ? '\u26A1' : '\u23F3'

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0a0a0a', color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: 320, borderRight: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', background: '#0d0d0d' }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', gap: 10 }}>
          <OpenClawLogo size={32} />
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>OPENCLAW</span>
        </div>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1a1a1a', fontSize: 11 }}>
          <span style={{ color: isConnected ? '#4ade80' : '#666' }}>{"\u25CF"}</span>{' '}
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>

        {/* Tasks */}
        <div style={{ borderBottom: '1px solid #1a1a1a', maxHeight: '30%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a', display: 'flex', justifyContent: 'space-between' }}>
            <span>TASKS</span>
            <span style={{ color: '#555' }}>{tasks.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
            {tasks.length === 0 ? (
              <div style={{ color: '#444', fontSize: 11, padding: '12px 0', textAlign: 'center' }}>No tasks yet</div>
            ) : (
              tasks.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 11, borderBottom: '1px solid #111' }}>
                  <span>{statusIcon(t.status)}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: t.status === 'completed' ? '#666' : '#ccc', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>{t.title}</div>
                    <div style={{ fontSize: 9, color: '#444', marginTop: 2 }}>{t.source} {"\u00B7"} {t.status}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Agents */}
        <div style={{ borderBottom: '1px solid #1a1a1a', maxHeight: '25%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a', display: 'flex', justifyContent: 'space-between' }}>
            <span>AGENTS</span>
            <span style={{ color: '#555' }}>{agents.filter(a => a.status === 'active').length} active</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>
            {agents.length === 0 ? (
              <div style={{ color: '#444', fontSize: 11, padding: '12px 0', textAlign: 'center' }}>No agents spawned</div>
            ) : (
              agents.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 11, borderBottom: '1px solid #111' }}>
                  <span style={{ color: a.status === 'active' ? '#4ade80' : '#666' }}>{"\u25CF"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: a.status === 'completed' ? '#666' : '#ccc' }}>{a.name}</div>
                    <div style={{ fontSize: 9, color: '#444', marginTop: 2 }}>{a.type} {"\u00B7"} {a.status}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Text Chat */}
        <div style={{ borderTop: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a' }}>
            TEXT CHAT (OPENCLAW API)
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px', minHeight: 60 }}>
            {chatMessages.length === 0 ? (
              <div style={{ color: '#444', fontSize: 12, padding: '12px 0', textAlign: 'center' }}>
                Type a message to test OpenClaw
              </div>
            ) : (
              chatMessages.map((msg, i) => (
                <div key={i} style={{ marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: msg.role === 'user' ? '#60a5fa' : '#c8a64a', fontWeight: 600, fontSize: 10 }}>
                    {msg.role === 'user' ? 'You' : 'OpenClaw'}
                  </span>
                  <div style={{ color: '#ccc', marginTop: 2 }}>{msg.text}</div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '8px 16px', borderTop: '1px solid #1a1a1a' }}>
            <input
              type="text"
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message OpenClaw..."
              disabled={isSending}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 6,
                border: '1px solid #333', background: '#111', color: '#e0e0e0',
                fontSize: 12, outline: 'none',
              }}
            />
            <button
              onClick={sendTextToOpenClaw}
              disabled={isSending || !textInput.trim()}
              style={{
                padding: '8px 14px', borderRadius: 6, border: 'none',
                background: '#c8a64a', color: '#000', fontWeight: 600,
                fontSize: 12, cursor: 'pointer', opacity: isSending ? 0.5 : 1,
              }}
            >
              {isSending ? '...' : 'Send'}
            </button>
          </div>
        </div>

        {/* Skills */}
        <div style={{ borderTop: '1px solid #1a1a1a', padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, marginBottom: 8 }}>SKILLS</div>
          {SKILLS.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '4px 0', color: '#888' }}>
              <span>{s.label}</span>
              <span style={{ color: s.connected ? '#4ade80' : '#555' }}>
                {s.connected ? 'Active' : 'Not connected'}
              </span>
            </div>
          ))}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1a1a1a', fontSize: 10, color: '#333', textAlign: 'center' }}>
          Powered by OpenClaw AI
        </div>
      </div>

      {/* Main Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32, position: 'relative' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, fontWeight: 300, margin: 0, color: '#fff' }}>OpenClaw Control Centre</h1>
          <p style={{ fontSize: 14, color: '#666', margin: '8px 0 0' }}>Voice-powered AI assistant</p>
        </div>
        <div style={{ position: 'relative', width: 280, height: 280 }}>
          <AuraVisualizer auraMode={auraMode} rmsRef={combinedRmsRef} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 16, minHeight: 18 }}>
            {isConnecting
              ? 'Connecting...'
              : isConnected
              ? (auraMode === 'agent-speaking' ? 'OpenClaw is speaking' : auraMode === 'user-speaking' ? 'Listening...' : 'Connected')
              : 'Ready'}
          </div>
          <button
            onClick={() => (isConnected ? disconnect() : connect())}
            disabled={isConnecting}
            style={{
              padding: '14px 40px', borderRadius: 8, border: 'none',
              background: isConnected ? '#333' : '#c8a64a', color: isConnected ? '#fff' : '#000',
              fontSize: 16, fontWeight: 600, cursor: isConnecting ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {isConnecting ? 'Connecting...' : isConnected ? 'Stop OpenClaw' : 'Start OpenClaw'}
          </button>
        </div>
      </div>
    </div>
  )
}
