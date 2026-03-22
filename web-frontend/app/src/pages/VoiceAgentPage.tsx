import { useEffect, useRef, useState } from 'react'
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

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'

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
          messages: [{ role: 'user', content: userMsg }],
          stream: false,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const reply = data.choices?.[0]?.message?.content || 'No response'
        setChatMessages(prev => [...prev, { role: 'assistant', text: reply, timestamp: new Date() }])
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

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0a0a0a', color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: 320, borderRight: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', background: '#0d0d0d' }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', gap: 10 }}>
          <OpenClawLogo size={32} />
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>OPENCLAW</span>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1a1a1a', fontSize: 11 }}>
          <span style={{ color: isConnected ? '#4ade80' : '#666' }}>&#9679;</span>{' '}
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>

        {/* Voice Transcript */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a' }}>
            VOICE TRANSCRIPT
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
            {segments.length === 0 ? (
              <div style={{ color: '#444', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>
                Start a voice session to see transcript
              </div>
            ) : (
              segments.map((seg, i) => (
                <div key={i} style={{ marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: seg.speaker === 'user' ? '#60a5fa' : '#c8a64a', fontWeight: 600, fontSize: 10 }}>
                    {seg.speaker === 'user' ? 'You' : 'OpenClaw'}
                  </span>
                  <div style={{ color: '#ccc', marginTop: 2 }}>{seg.text}</div>
                </div>
              ))
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Text Chat */}
        <div style={{ borderTop: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', maxHeight: '40%' }}>
          <div style={{ padding: '12px 16px', fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 1, borderBottom: '1px solid #1a1a1a' }}>
            TEXT CHAT (OPENCLAW API)
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px', minHeight: 80 }}>
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
