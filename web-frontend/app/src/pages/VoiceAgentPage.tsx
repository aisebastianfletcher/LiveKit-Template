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

export default function OpenClawPage() {
  const {
    status, localMicStream, agentAudioStream, audioContext, segments, connect, disconnect,
  } = useLiveKitSession()

  const { rmsRef: micRmsRef } = useAudioAnalyser(audioContext, localMicStream, true)
  const { rmsRef: agentRmsRef } = useAudioAnalyser(audioContext, agentAudioStream, false)
  const combinedRmsRef = useRef(0)
  const [auraMode, setAuraMode] = useState<AuraMode>('disconnected')
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'

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

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments])

  const gold = '#C4944F'
  const goldLight = '#D4A96A'
  const lastSegment = segments[segments.length - 1]
  const transcript = lastSegment?.text ?? ''

  return (
    <div style={{ display: 'flex', height: '100dvh', background: '#08080d', fontFamily: "'Inter',-apple-system,sans-serif", color: '#fff' }}>

      {/* ===== LEFT SIDEBAR ===== */}
      <aside style={{ width: 280, minWidth: 280, borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', background: '#0a0a10' }}>

        {/* Logo */}
        <div style={{ padding: '20px 20px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <OpenClawLogo size={28} />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.08em', color: goldLight }}>OPENCLAW</span>
        </div>

        {/* Connection status */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: isConnected ? '#22c55e' : '#555' }} />
            <span style={{ fontSize: 12, color: isConnected ? '#22c55e' : 'rgba(255,255,255,0.3)' }}>
              {isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Disconnected'}
            </span>
          </div>
        </div>

        {/* Live transcript */}
        <div style={{ padding: '12px 16px 8px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 10 }}>Conversation</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
          {!isConnected && segments.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.15)', padding: '8px 0', fontStyle: 'italic' }}>Start a session to see the conversation here</div>
          )}
          {segments.map((seg, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize: 11, color: gold, marginBottom: 2 }}>{seg.source === 'user' ? 'You' : 'OpenClaw'}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>{seg.text}</div>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>

        {/* Skills status */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '12px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 8 }}>Skills</div>
          {SKILLS.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0' }}>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{s.label}</span>
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 100, background: s.connected ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)', color: s.connected ? '#22c55e' : 'rgba(255,255,255,0.25)', fontWeight: 500 }}>
                {s.connected ? 'Active' : 'Not connected'}
              </span>
            </div>
          ))}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 10, color: 'rgba(255,255,255,0.12)' }}>Powered by OpenClaw AI</div>
      </aside>

      {/* ===== MAIN CONTENT ===== */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>

        {isConnected && (
          <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(196,148,79,0.06) 0%, transparent 70%)', top: '50%', left: '50%', transform: 'translate(-50%,-55%)', pointerEvents: 'none' }} />
        )}

        <h1 style={{ fontSize: 'clamp(24px,4vw,36px)', fontWeight: 700, color: '#fff', margin: '0 0 4px', letterSpacing: '-0.02em', textAlign: 'center' }}>OpenClaw Control Centre</h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)', margin: '0 0 40px', textAlign: 'center' }}>Voice-powered AI assistant</p>

        <div style={{ width: 200, height: 200, marginBottom: 28, transition: 'transform 0.3s', transform: isConnected ? 'scale(1)' : 'scale(0.85)' }}>
          <AuraVisualizer auraMode={auraMode} rmsRef={combinedRmsRef} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 500, color: isConnected ? (auraMode === 'agent-speaking' ? goldLight : 'rgba(255,255,255,0.35)') : 'rgba(255,255,255,0.2)', marginBottom: 14, minHeight: 18 }}>
          {isConnected ? (auraMode === 'agent-speaking' ? 'OpenClaw is speaking...' : 'Listening...') : isConnecting ? 'Connecting...' : 'Ready'}
        </div>

        <div style={{ minHeight: 40, maxWidth: 380, width: '100%', textAlign: 'center', marginBottom: 32 }}>
          {transcript && <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', margin: 0, lineHeight: 1.5, fontStyle: 'italic' }}>'{transcript}'</p>}
        </div>

        <button
          onClick={isConnected ? disconnect : connect}
          disabled={isConnecting}
          style={{
            padding: '14px 52px', fontSize: 14, fontWeight: 600, borderRadius: 100,
            cursor: isConnecting ? 'not-allowed' : 'pointer', transition: 'all 0.25s', outline: 'none',
            background: isConnected ? 'rgba(220,38,38,0.12)' : isConnecting ? 'rgba(255,255,255,0.04)' : `linear-gradient(135deg, ${gold}, ${goldLight})`,
            color: isConnected ? '#ef4444' : isConnecting ? '#444' : '#fff',
            border: isConnected ? '1px solid rgba(220,38,38,0.25)' : '1px solid rgba(255,255,255,0.06)',
            boxShadow: isConnected || isConnecting ? 'none' : '0 0 50px rgba(196,148,79,0.25), 0 4px 20px rgba(0,0,0,0.4)',
            minWidth: 190,
          }}
        >
          {isConnecting ? 'Connecting...' : isConnected ? 'End Session' : 'Start OpenClaw'}
        </button>
      </main>
    </div>
  )
}
