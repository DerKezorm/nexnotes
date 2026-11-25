/**
 * A person's profile picture (NOTES-2 AC-11), or the first letter of the name where there is none or the server does
 * not show it to this viewer. The address carries the time the picture was set, so a new one is a new address. The
 * letter stands on the hue of the name as the account module draws it everywhere (server, iPhone, the operator's
 * list); saturation, lightness and the letter's colour come from the kit's variables.
 */
import { useState } from 'react'

import { avatarUrl } from '../lib/avatar'
import { avatarPlaceholder } from '../vendor/nexkonten/konten'

export function Avatar({
  accountId,
  name,
  stamp,
  size = 28,
  ring,
}: {
  accountId: number
  name: string
  stamp?: string | null
  size?: number
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
  const { letter, hue } = avatarPlaceholder(name)
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full text-xs font-bold"
      style={{ ...style, background: `hsl(${hue} var(--nexui-avatar-saturation) var(--nexui-avatar-lightness))`, color: 'var(--nexui-avatar-text)' }}
      data-testid="avatar-initial"
    >
      {letter}
    </span>
  )
}
