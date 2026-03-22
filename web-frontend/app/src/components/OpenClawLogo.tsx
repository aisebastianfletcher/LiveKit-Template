interface Props {
  size?: number
}

export default function OpenClawLogo({ size = 32 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gold-outer" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#D4A96A" />
          <stop offset="50%" stopColor="#C4944F" />
          <stop offset="100%" stopColor="#A87D3E" />
        </linearGradient>
        <linearGradient id="gold-inner" x1="20" y1="20" x2="80" y2="80" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E8CFA0" />
          <stop offset="50%" stopColor="#D4A96A" />
          <stop offset="100%" stopColor="#C4944F" />
        </linearGradient>
      </defs>
      {/* Outer hexagon */}
      <path d="M50 5 L88 27.5 L88 72.5 L50 95 L12 72.5 L12 27.5 Z" stroke="url(#gold-outer)" strokeWidth="8" fill="none" strokeLinejoin="round" />
      {/* Inner hexagon */}
      <path d="M50 28 L69 39 L69 61 L50 72 L31 61 L31 39 Z" stroke="url(#gold-inner)" strokeWidth="6" fill="none" strokeLinejoin="round" />
      {/* Connecting bar left */}
      <path d="M12 27.5 L12 72.5" stroke="url(#gold-inner)" strokeWidth="8" strokeLinecap="round" opacity="0.6" />
    </svg>
  )
}
