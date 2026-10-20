import { useId } from 'react';

const SIZES = { sm: 28, md: 40, lg: 64, hero: 104 } as const;
export type LogoSize = keyof typeof SIZES;

/**
 * UpCircuit brand mark: a glass tile with circuit traces feeding an ascending chart line that ends in an upward arrow
 * (electric blue #3B82F6 → emerald #10B981, soft glow filter). Pure inline SVG, no external assets.
 */
export function UpCircuitLogo({ size = 'md', showText = true, className = '' }: { size?: LogoSize; showText?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const px = SIZES[size];
  return (
    <span className={`inline-flex items-center gap-3 ${className}`} data-testid="upcircuit-logo">
      <svg width={px} height={px} viewBox="0 0 64 64" role="img" aria-label="UpCircuit logo" className="shrink-0">
        <defs>
          <linearGradient id={`${id}g`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#3B82F6" />
            <stop offset="1" stopColor="#10B981" />
          </linearGradient>
          <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0F172A" />
            <stop offset="1" stopColor="#020617" />
          </linearGradient>
          <filter id={`${id}f`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${id}t)`} stroke="#1E293B" strokeWidth="1.5" />
        <rect x="3" y="3" width="58" height="29" rx="14" fill="#ffffff" opacity="0.04" />
        {/* circuit traces */}
        <g stroke="#3B82F6" strokeOpacity="0.45" strokeWidth="1.2" fill="none" strokeLinecap="round">
          <path d="M8 46h10l5-6h8" />
          <path d="M8 38h6l4-4" />
          <path d="M56 50H44l-4-5" />
          <path d="M24 56v-6l4-4" />
        </g>
        <g fill="#0F172A" stroke="#3B82F6" strokeWidth="1.2">
          <circle cx="8" cy="46" r="1.8" /><circle cx="8" cy="38" r="1.8" /><circle cx="56" cy="50" r="1.8" /><circle cx="24" cy="56" r="1.8" />
        </g>
        {/* ascending chart line with a circuit-breaker pulse step */}
        <g filter={`url(#${id}f)`} fill="none" stroke={`url(#${id}g)`} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 44 L22 36 L29 40 L38 27 L43 27 L50 15" />
          <path d="M43 15h7v7" />
        </g>
        <circle cx="38" cy="27" r="2.4" fill="#10B981" filter={`url(#${id}f)`} />
      </svg>
      {showText && (
        <span className={`font-bold tracking-tight text-slate-100 ${size === 'hero' ? 'text-3xl' : size === 'lg' ? 'text-2xl' : size === 'md' ? 'text-lg' : 'text-base'}`}>
          Up<span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">Circuit</span>
        </span>
      )}
    </span>
  );
}
