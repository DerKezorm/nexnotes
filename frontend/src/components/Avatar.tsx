/**
 * A person's profile picture (NOTES-2 AC-11), or the first letter of the name where there is none or the server does
 * not show it to this viewer. The address carries the time the picture was set, so a new one is a new address.
 */
import { useState } from 'react'

import { avatarUrl, initialOf } from '../lib/avatar'

export function Avatar({
  accountId,
  name,
  stamp,
  size = 28,
  className = 'bg-accent-500 text-on-accent',
  ring,
}: {
  accountId: number
  name: string
  stamp?: string | null
  size?: number
  /** The look of the letter's circle. */
  className?: string
  /** A border in a person's color (the others in a note). */
  ring?: string
}) {
  const url = avatarUrl(accountId, stamp)
  const [failed, setFailed] = useState<string | null>(null)
  const style = { width: size, height: size, ...(ring ? { borderColor: ring, borderWidth: 2, borderStyle: 'solid' } : {}) }
  if (url && failed !== url)
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        width={size}
        height={size}
        onError={() => setFailed(url)}
        className="shrink-0 rounded-full object-cover"
        style={style}
        data-testid="avatar-picture"
      />
    )
  return (
    <span aria-hidden className={'flex shrink-0 items-center justify-center rounded-full text-xs font-bold ' + className} style={style} data-testid="avatar-initial">
      {initialOf(name)}
    </span>
  )
}
