import { useNavigate } from 'react-router-dom'

export default function LandingPage() {
  const navigate = useNavigate()

  return (
    <div className="flex items-center justify-center min-h-[100dvh] px-4 bg-black">
      <div className="max-w-[420px] w-full text-center">

        <div className="mb-10">
          <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-6">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </div>
          <h1 className="text-3xl font-semibold text-white tracking-tight mb-2">Steve</h1>
          <p className="text-sm text-white/40">Gitwix Sales &amp; Outreach</p>
        </div>

        <button
          onClick={() => navigate('/pipeline')}
          className="w-full py-4 px-6 bg-white text-black font-semibold rounded-2xl text-base hover:bg-white/90 active:scale-[0.98] transition-all"
        >
          Start Conversation
        </button>

      </div>
    </div>
  )
}
