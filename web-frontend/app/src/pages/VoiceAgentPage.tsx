import { useEffect, useRef, useState } from 'react'
import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

const SPEAKING_THRESHOLD = 0.02

export default function StevePage() {
  const {
    status,
    localMicStream,
    agentAudioStream,
    audioContext,
    segments,
    connect,
    disconnect,
  } = useLiveKitSession()

  const { rmsRef: micRmsRef } = useAudioAnalyser(audioContext, localMicStream, true)
  const { rmsRef: agentRmsRef } = useAudioAnalyser(audioContext, agentAudioStream, false)
  const combinedRmsRef = useRef(0)
  const [auraMode, setAuraMode] = useState<AuraMode>('disconnected')

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
        mode = 'agent-speaking'
        rms = agentRms
      } else if (micRms > SPEAKING_THRESHOLD) {
        mode = 'user-speaking'
        rms = micRms
      } else {
        mode = 'idle'
        rms = Math.max(micRms, agentRms)
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

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#0a0a0f',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', -apple-system, sans-serif",
      gap: '0',
      padding: '24px',
      boxSizing: 'border-box',
    }}>

      {/* Name */}
      <div style={{
        fontSize: '13px',
        fontWeight: 600,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: '#555',
        marginBottom: '8px',
      }}>Gitwix</div>

      <h1 style={{
        fontSize: '42px',
        fontWeight: 700,
        color: '#fff',
        margin: '0 0 4px 0',
        letterSpacing: '-0.02em',
      }}>Steve</h1>

      <p style={{
        fontSize: '14px',
        color: '#444',
        margin: '0 0 48px 0',
      }}>Sales & Outreach</p>

      {/* Orb */}
      <div style={{ width: '220px', height: '220px', marginBottom: '48px' }}>
        <AuraVisualizer mode={auraMode} rmsRef={combinedRmsRef} />
      </div>

      {/* Transcript */}
      <div style={{
        minHeight: '48px',
        maxWidth: '340px',
        width: '100%',
        textAlign: 'center',
        marginBottom: '40px',
      }}>
        {transcript && (
          <p style={{
            fontSize: '15px',
            color: '#999',
            margin: 0,
            lineHeight: 1.5,
            fontStyle: 'italic',
          }}>'{transcript}'</p>
        )}
        {!transcript && isConnected && (
          <p style={{ fontSize: '14px', color: '#333', margin: 0 }}>
            {auraMode === 'agent-speaking' ? 'Steve is talking...' : 'Listening...'}
          </p>
        )}
      </div>

      {/* Single Button */}
      <button
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        style={{
          padding: '16px 48px',
          fontSize: '16px',
          fontWeight: 600,
          borderRadius: '100px',
          border: 'none',
          cursor: isConnecting ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s ease',
          outline: 'none',
          letterSpacing: '0.01em',
          background: isConnected
            ? 'rgba(220,38,38,0.15)'
            : isConnecting
            ? 'rgba(255,255,255,0.05)'
            : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: isConnected ? '#ef4444' : isConnecting ? '#555' : '#fff',
          border: isConnected ? '1px solid rgba(220,38,38,0.3)' : '1px solid transparent',
          boxShadow: isConnected ? 'none' : isConnecting ? 'none' : '0 0 40px rgba(99,102,241,0.4)',
        }}
      >
        {isConnecting ? 'Connecting...' : isConnected ? 'End Call' : 'Talk to Steve'}
      </button>

    </div>
  )
}
