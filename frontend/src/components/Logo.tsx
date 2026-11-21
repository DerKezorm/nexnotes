import { useId } from 'react'

import { useTheme } from '../lib/useTheme'

/** The two looks of the mark (design system "Logo und Name"): the tile, its fine border, the note's gradient and the
 * bolt, with the bolt's edge in the tile's color so that it cuts the note free. */
// eslint-disable-next-line react-refresh/only-export-components
export const LOGO_COLORS = {
  light: { tile: '#ffffff', border: '#d9a21b', borderOpacity: 0.4, gradient: ['#f5cf63', '#d9a21b', '#8a5a06'], bolt: '#b8740a' },
  dark: { tile: '#16120a', border: '#e0a51c', borderOpacity: 0.45, gradient: ['#fdedb5', '#e8b53a', '#b98310'], bolt: '#f5c445' },
} as const

const BOLT = 'M47.5 24.5 34 42.5h9.5L40 55.5 54 37h-9.5l3-12.5Z'

/**
 * The note with a bolt on its tile, in the look of the app (light or dark). Small (below 32 px) it keeps the outline of
 * the note in one tone and the bolt, without the two lines.
 */
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '')
  const theme = useTheme()
  const look = LOGO_COLORS[theme]
  const small = size < 32
  const stroke = small ? look.gradient[1] : `url(#nn-${id})`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="logo-mark"
      data-look={theme}
    >
      {!small && (
        <defs>
          <linearGradient id={`nn-${id}`} gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
            <stop offset="0" stopColor={look.gradient[0]} />
            <stop offset=".5" stopColor={look.gradient[1]} />
            <stop offset="1" stopColor={look.gradient[2]} />
          </linearGradient>
        </defs>
      )}
      <rect x="2" y="2" width="60" height="60" rx="16" fill={look.tile} data-part="tile" />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" stroke={look.border} strokeOpacity={look.borderOpacity} strokeWidth="1.5" />
      <rect x="11" y="12.5" width="29" height="38" rx="4" fill="none" stroke={stroke} strokeWidth="4.2" data-part="note" />
      {!small && <path d="M17.5 22.5h16M17.5 29.5h10" stroke={stroke} strokeWidth="3.2" strokeLinecap="round" strokeOpacity=".6" data-part="lines" />}
      <path d={BOLT} fill={look.bolt} stroke={look.tile} strokeWidth="2.4" strokeLinejoin="round" data-part="bolt" />
    </svg>
  )
}

/** The mark with the name, written as the family writes it: NEX in the text's color, NOTES in honey. */
export function Logo({ size = 32, withWordmark = false }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} title={withWordmark ? undefined : 'nexnotes'} />
      {withWordmark && <Wordmark />}
    </span>
  )
}

export function Wordmark({ className = 'text-lg' }: { className?: string }) {
  return (
    <span className={className + ' font-bold tracking-tight text-mist-100'} data-testid="wordmark" aria-label="nexnotes">
      <span aria-hidden>NEX</span>
      <span aria-hidden className="nn-wordmark-accent">
        NOTES
      </span>
    </span>
  )
}
