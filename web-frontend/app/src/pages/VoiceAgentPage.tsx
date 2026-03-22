import { useEffect, useRef, useState } from 'react'
import AuraVisualizer from '@/components/AuraVisualizer'
import type { AuraMode } from '@/components/AuraVisualizer'
import useLiveKitSession from '@/hooks/useLiveKitSession'
import useAudioAnalyser from '@/hooks/useAudioAnalyser'

const SPEAKING_THRESHOLD = 0.02

export default function OpenClawPage() {
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

  const statusLabel = isConnected
    ? auraMode === 'agent-speaking' ? 'OpenClaw is speaking...' : 'Listening...'
    : isConnecting
    ? 'Connecting...'
    : 'Ready'

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'linear-gradient(180deg, #06060a 0%, #0d0d14 50%, #06060a 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: '32px 24px',
      boxSizing: 'border-box',
      position: 'relative',
      overflow: 'hidden',
    }}>

      {/* Subtle background glow */}
      {isConnected && (
        <div style={{
          position: 'absolute',
          width: '600px',
          height: '600px',
          borderRadius: '50%',
          background: auraMode === 'agent-speaking'
            ? 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)'
            : 'radial-gradient(circle, rgba(99,102,241,0.04) 0%, transparent 70%)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -55%)',
          pointerEvents: 'none',
          transition: 'all 1s ease',
        }} />
      )}

      {/* Brand */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '8px',
      }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 800,
          color: '#fff',
          letterSpacing: '-0.02em',
        }}>OC</div>
        <span style={{
          fontSize: '13px',
          fontWeight: 600,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.3)',
        }}>OpenClaw</span>
      </div>

      {/* Title */}
      <h1 style={{
        fontSize: 'clamp(28px, 5vw, 42px)',
        fontWeight: 700,
        color: '#fff',
        margin: '0 0 4px 0',
        letterSpacing: '-0.03em',
        textAlign: 'center',
      }}>Your AI Assistant</h1>

      <p style={{
        fontSize: '14px',
        color: 'rgba(255,255,255,0.25)',
        margin: '0 0 48px 0',
        textAlign: 'center',
      }}>Voice-powered productivity</p>

      {/* Orb */}
      <div style={{
        width: 'min(220px, 50vw)',
        height: 'min(220px, 50vw)',
        marginBottom: '32px',
        transition: 'transform 0.3s ease',
        transform: isConnected ? 'scale(1)' : 'scale(0.9)',
      }}>
        <AuraVisualizer mode={auraMode} rmsRef={combinedRmsRef} />
      </div>

      {/* Status */}
      <div style={{
        fontSize: '13px',
        fontWeight: 500,
        color: isConnected
          ? auraMode === 'agent-speaking' ? 'rgba(139,92,246,0.8)' : 'rgba(255,255,255,0.35)'
          : 'rgba(255,255,255,0.2)',
        marginBottom: '16px',
        letterSpacing: '0.05em',
        transition: 'color 0.3s ease',
        minHeight: '20px',
      }}>{statusLabel}</div>

      {/* Transcript */}
      <div style={{
        minHeight: '48px',
        maxWidth: '400px',
        width: '100%',
        textAlign: 'center',
        marginBottom: '40px',
      }}>
        {transcript && (
          <p style={{
            fontSize: '15px',
            color: 'rgba(255,255,255,0.55)',
            margin: 0,
            lineHeight: 1.6,
            fontStyle: 'italic',
          }}>'{transcript}'</p>
        )}
      </div>

      {/* Single Action Button */}
      <button
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        style={{
          padding: '16px 56px',
          fontSize: '15px',
          fontWeight: 600,
          borderRadius: '100px',
          border: 'none',
          cursor: isConnecting ? 'not-allowed' : 'pointer',
          transition: 'all 0.25s ease',
          outline: 'none',
          letterSpacing: '0.02em',
          background: isConnected
            ? 'rgba(220,38,38,0.12)'
            : isConnecting
            ? 'rgba(255,255,255,0.04)'
            : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: isConnected ? '#ef4444' : isConnecting ? '#444' : '#fff',
          border: isConnected ? '1px solid rgba(220,38,38,0.25)' : '1px solid rgba(255,255,255,0.06)',
          boxShadow: isConnected
            ? 'none'
            : isConnecting
            ? 'none'
            : '0 0 60px rgba(99,102,241,0.3), 0 4px 20px rgba(0,0,0,0.4)',
          minWidth: '200px',
        }}
      >
        {isConnecting ? 'Connecting...' : isConnected ? 'End Session' : 'Start OpenClaw'}
      </button>

      {/* Footer */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        fontSize: '11px',
        color: 'rgba(255,255,255,0.12)',
        letterSpacing: '0.05em',
      }}>Powered by OpenClaw AI</div>
    </div>
  )
}
