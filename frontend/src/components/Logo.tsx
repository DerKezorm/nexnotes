import { useId } from 'react'

/**
 * The note: a sheet with a dog-ear and three lines, the last one shorter, on a white tile, everywhere (design system
 * "Logo und Name"). Small (below 32 px) it keeps one tone, the outline and one line.
 */
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '')
  const small = size < 32
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={`nn-${id}`} gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" stopColor="#f7cf62" />
          <stop offset=".5" stopColor="#e0a51c" />
          <stop offset="1" stopColor="#8a5a00" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#ffffff" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill="none" stroke="#e0a51c" strokeOpacity=".35" strokeWidth="2.5" />
      {small ? (
        <>
          <path d="M21 14h17l9 9v26a4 4 0 0 1-4 4H21a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z" fill="none" stroke="#c48a0e" strokeWidth="5" strokeLinejoin="round" />
          <path d="M23.5 38h16" fill="none" stroke="#c48a0e" strokeWidth="5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M21 14h17l9 9v26a4 4 0 0 1-4 4H21a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z" fill="none" stroke={`url(#nn-${id})`} strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M38 14v9h9" fill="none" stroke={`url(#nn-${id})`} strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M23.5 31h16M23.5 38h16M23.5 45h9" fill="none" stroke="#c48a0e" strokeWidth="3.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

/** The mark with the name, written small as the family writes it. */
export function Logo({ size = 32, withWordmark = false }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} title={withWordmark ? undefined : 'nexnotes'} />
      {withWordmark && <span className="text-[17px] font-bold tracking-tight text-mist-100">nexnotes</span>}
    </span>
  )
}
