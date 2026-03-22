import { useEffect, useRef, useState } from 'react'
import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import OpenClawLogo from '@/components/OpenClawLogo'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

const SPEAKING_THRESHOLD = 0.02

const OPENCLAW_API = 'https://openclaw-production-058c.up.railway.app'

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
      if (agent > SPEAKING_THRESHOLD) setAuraMode('speaking')
      else if (mic > SPEAKING_THRESHOLD) setAuraMode('listening')
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
      const res = await fetch(`${OPENCLAW_API}/v1/chat/completions`, {
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
    <div style={{ display: 'flex', height: '100vh', background: '#0a0a0a', color: '#e0e0e0', fontFamily: "'Inter', sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: 280, borderRight: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', background: '#0d0d0d' }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', gap: 10 }}>
          <OpenClawLogo size={28} />
          <span style={{ fontWeight: 700, fontSize: 15, color: '#c9a84c', letterSpacing: 1 }}>OPENCLAW</span>
        </div>

        <div style={{ padding: '12px 16px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: isConnected ? '#4ade80' : '#666' }} />
          <span style={{ color: isConnected ? '#4ade80' : '#888' }}>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>

        {/* Voice Transcript */}
        <div style={{ padding: '8px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#666', letterSpacing: 1, marginBottom: 8 }}>VOICE TRANSCRIPT</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12 }}>
            {segments.length === 0 ? (
              <div style={{ color: '#444', fontStyle: 'italic' }}>Start a voice session to see transcript</div>
            ) : (
              segments.map((seg, i) => (
                <div key={i} style={{ marginBottom: 6, padding: '4px 8px', borderRadius: 4, background: seg.speaker === 'user' ? '#1a1a2e' : '#1a2e1a' }}>
                  <span style={{ fontSize: 10, color: seg.speaker === 'user' ? '#6b7bff' : '#4ade80', fontWeight: 600 }}>
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
        <div style={{ flex: 1, padding: '8px 16px', display: 'flex', flexDirection: 'column', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#666', letterSpacing: 1, marginBottom: 8 }}>TEXT CHAT (OPENCLAW API)</div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, maxHeight: 250, marginBottom: 8 }}>
            {chatMessages.length === 0 ? (
              <div style={{ color: '#444', fontStyle: 'italic', fontSize: 12 }}>Type a message to test OpenClaw</div>
            ) : (
              chatMessages.map((msg, i) => (
                <div key={i} style={{ marginBottom: 6, padding: '6px 8px', borderRadius: 4, background: msg.role === 'user' ? '#1a1a2e' : '#1a2e1a' }}>
                  <span style={{ fontSize: 10, color: msg.role === 'user' ? '#6b7bff' : '#4ade80', fontWeight: 600 }}>
                    {msg.role === 'user' ? 'You' : 'OpenClaw'}
                  </span>
                  <div style={{ color: '#ccc', marginTop: 2, fontSize: 12, whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message OpenClaw..."
              disabled={isSending}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #333', background: '#111',
                color: '#e0e0e0', fontSize: 12, outline: 'none',
              }}
            />
            <button
              onClick={sendTextToOpenClaw}
              disabled={isSending || !textInput.trim()}
              style={{
                padding: '8px 14px', borderRadius: 6, border: 'none', background: '#c9a84c', color: '#000',
                fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: isSending || !textInput.trim() ? 0.5 : 1,
              }}
            >
              {isSending ? '...' : 'Send'}
            </button>
          </div>
        </div>

        {/* Skills */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1a1a1a' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#666', letterSpacing: 1, marginBottom: 8 }}>SKILLS</div>
          {SKILLS.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
              <span style={{ color: '#999' }}>{s.label}</span>
              <span style={{ fontSize: 10, color: s.connected ? '#4ade80' : '#666', background: s.connected ? '#1a2e1a' : '#1a1a1a', padding: '2px 8px', borderRadius: 10 }}>
                {s.connected ? 'Active' : 'Not connected'}
              </span>
            </div>
          ))}
        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid #1a1a1a', fontSize: 10, color: '#444' }}>
          Powered by OpenClaw AI
        </div>
      </div>

      {/* Main Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <h1 style={{ fontSize: 36, fontWeight: 700, marginBottom: 4 }}>OpenClaw Control Centre</h1>
        <p style={{ color: '#888', marginBottom: 40 }}>Voice-powered AI assistant</p>

        <div style={{ position: 'relative', width: 280, height: 280 }}>
          <AuraVisualizer mode={auraMode} rmsRef={combinedRmsRef} />
        </div>

        <div style={{ marginTop: 16, fontSize: 14, color: '#888' }}>
          {isConnecting ? 'Connecting...' : isConnected ? (auraMode === 'speaking' ? 'OpenClaw is speaking' : auraMode === 'listening' ? 'Listening...' : 'Connected') : 'Ready'}
        </div>

        <button
          onClick={isConnected ? disconnect : connect}
          disabled={isConnecting}
          style={{
            marginTop: 32, padding: '14px 48px', borderRadius: 32, border: 'none', fontSize: 16, fontWeight: 600,
            cursor: isConnecting ? 'not-allowed' : 'pointer',
            background: isConnected ? '#333' : 'linear-gradient(135deg, #c9a84c, #b8943f)',
            color: isConnected ? '#e0e0e0' : '#000',
          }}
        >
          {isConnecting ? 'Connecting...' : isConnected ? 'Stop OpenClaw' : 'Start OpenClaw'}
        </button>
      </div>
    </div>
  )
}
