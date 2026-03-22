import { useEffect, useRef, useState } from 'react'
import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import OpenClawLogo from '@/components/OpenClawLogo'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

const SPEAKING_THRESHOLD = 0.02

interface ConversationItem {
  id: string
  title: string
  time: string
}

interface TaskItem {
  id: string
  label: string
  done: boolean
}

export default function OpenClawPage() {
  const {
    status, localMicStream, agentAudioStream, audioContext, segments, connect, disconnect,
  } = useLiveKitSession()

  const { rmsRef: micRmsRef } = useAudioAnalyser(audioContext, localMicStream, true)
  const { rmsRef: agentRmsRef } = useAudioAnalyser(audioContext, agentAudioStream, false)
  const combinedRmsRef = useRef(0)
  const [auraMode, setAuraMode] = useState<AuraMode>('disconnected')

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'

  const [conversations] = useState<ConversationItem[]>([
    { id: '1', title: 'Getting started', time: 'Just now' },
  ])
  const [tasks] = useState<TaskItem[]>([
    { id: '1', label: 'Connect email skill', done: false },
    { id: '2', label: 'Connect calendar skill', done: false },
    { id: '3', label: 'Test voice commands', done: false },
  ])

  useEffect(() => {
    if (status !== 'connected') {
      setAuraMode('disconnected')
      combinedRmsRef.current = 0
      return
    }
    let frameId: number
    function update() {
      const micRms = micRmsRef.current ?? 0
      const agentRms = agentRmsRef.current ?? 0
      let mode: AuraMode
      let rms: number
      if (agentRms > SPEAKING_THRESHOLD && agentRms >= micRms) {
        mode = 'agent-speaking'; rms = agentRms
      } else if (micRms > SPEAKING_THRESHOLD) {
        mode = 'user-speaking'; rms = micRms
      } else {
        mode = 'idle'; rms = Math.max(micRms, agentRms)
      }
      combinedRmsRef.current = rms
      setAuraMode(mode)
      frameId = requestAnimationFrame(update)
    }
    frameId = requestAnimationFrame(update)
    return () => { cancelAnimationFrame(frameId) }
  }, [status, micRmsRef, agentRmsRef])

  const lastSegment = segments[segments.length - 1]
  const transcript = lastSegment?.text ?? ''

  const sideW = 280
  const gold = '#C4944F'
  const goldLight = '#D4A96A'

  return (
    <div style={{ display: 'flex', height: '100dvh', background: '#08080d', fontFamily: "'Inter',-apple-system,sans-serif", color: '#fff' }}>

      {/* ===== LEFT SIDEBAR ===== */}
      <aside style={{ width: sideW, minWidth: sideW, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', background: '#0a0a10' }}>

        {/* Logo header */}
        <div style={{ padding: '20px 20px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <OpenClawLogo size={28} />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.08em', color: goldLight }}>OPENCLAW</span>
        </div>

        {/* Conversations section */}
        <div style={{ padding: '16px 16px 8px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 10 }}>Conversations</div>
          {conversations.map(c => (
            <div key={c.id} style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', marginBottom: 4, cursor: 'pointer' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#ddd' }}>{c.title}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>{c.time}</div>
            </div>
          ))}
          <button style={{ width: '100%', padding: '8px 0', marginTop: 6, fontSize: 12, fontWeight: 500, color: gold, background: 'none', border: '1px dashed rgba(196,148,79,0.3)', borderRadius: 8, cursor: 'pointer' }}>+ New conversation</button>
        </div>

        {/* Tasks section */}
        <div style={{ padding: '12px 16px', flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 10 }}>Tasks</div>
          {tasks.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ width: 16, height: 16, borderRadius: 4, border: t.done ? 'none' : '1.5px solid rgba(255,255,255,0.2)', background: t.done ? gold : 'none', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: t.done ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)', textDecoration: t.done ? 'line-through' : 'none' }}>{t.label}</span>
            </div>
          ))}
        </div>

        {/* Sidebar footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 11, color: 'rgba(255,255,255,0.15)' }}>Powered by OpenClaw AI</div>
      </aside>

      {/* ===== MAIN CONTENT ===== */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>

        {/* Background glow */}
        {isConnected && (
          <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(196,148,79,0.06) 0%, transparent 70%)', top: '50%', left: '50%', transform: 'translate(-50%,-55%)', pointerEvents: 'none' }} />
        )}

        {/* Title area */}
        <h1 style={{ fontSize: 'clamp(24px,4vw,36px)', fontWeight: 700, color: '#fff', margin: '0 0 4px', letterSpacing: '-0.02em', textAlign: 'center' }}>OpenClaw Control Centre</h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', margin: '0 0 40px', textAlign: 'center' }}>Voice-powered AI assistant</p>

        {/* Orb */}
        <div style={{ width: 200, height: 200, marginBottom: 28, transition: 'transform 0.3s', transform: isConnected ? 'scale(1)' : 'scale(0.85)' }}>
          <AuraVisualizer auraMode={auraMode} rmsRef={combinedRmsRef} />
        </div>

        {/* Status */}
        <div style={{ fontSize: 12, fontWeight: 500, color: isConnected ? (auraMode === 'agent-speaking' ? goldLight : 'rgba(255,255,255,0.35)') : 'rgba(255,255,255,0.2)', marginBottom: 14, letterSpacing: '0.04em', minHeight: 18 }}>
          {isConnected ? (auraMode === 'agent-speaking' ? 'OpenClaw is speaking...' : 'Listening...') : isConnecting ? 'Connecting...' : 'Ready'}
        </div>

        {/* Transcript */}
        <div style={{ minHeight: 40, maxWidth: 380, width: '100%', textAlign: 'center', marginBottom: 32 }}>
          {transcript && <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', margin: 0, lineHeight: 1.5, fontStyle: 'italic' }}>'{transcript}'</p>}
        </div>

        {/* Button */}
        <button
          onClick={isConnected ? disconnect : connect}
          disabled={isConnecting}
          style={{
            padding: '14px 52px', fontSize: 14, fontWeight: 600, borderRadius: 100,
            cursor: isConnecting ? 'not-allowed' : 'pointer', transition: 'all 0.25s', outline: 'none',
            background: isConnected ? 'rgba(220,38,38,0.12)' : isConnecting ? 'rgba(255,255,255,0.04)' : `linear-gradient(135deg, ${gold}, ${goldLight})`,
            color: isConnected ? '#ef4444' : isConnecting ? '#444' : '#fff',
            border: isConnected ? '1px solid rgba(220,38,38,0.25)' : '1px solid rgba(255,255,255,0.06)',
            boxShadow: isConnected || isConnecting ? 'none' : `0 0 50px rgba(196,148,79,0.25), 0 4px 20px rgba(0,0,0,0.4)`,
            minWidth: 190, letterSpacing: '0.01em',
          }}
        >
          {isConnecting ? 'Connecting...' : isConnected ? 'End Session' : 'Start OpenClaw'}
        </button>
      </main>
    </div>
  )
}
