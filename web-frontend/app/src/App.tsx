import { Routes, Route, Navigate } from 'react-router-dom'
import VoiceAgentPage from './pages/VoiceAgentPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<VoiceAgentPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
