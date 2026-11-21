/**
 * The areas of the settings, each with its own address (`/settings/<slug>`): "My account" for every account, "Server"
 * for the operator only. `/settings` is the profile; the addresses of the tabs before the areas lead to their area.
 */
import { HardDrive, KeyRound, Mail, Palette, Plug, ScanText, ScrollText, ShieldCheck, SlidersHorizontal, UserRound, Users, type LucideIcon } from 'lucide-react'

import type { Me } from '../../api/client'

type Role = Me['role']

export type AreaSlug = 'profile' | 'security' | 'appearance' | 'connections' | 'general' | 'sign-in' | 'mail' | 'storage' | 'ocr' | 'accounts' | 'log'
export type AreaGroup = 'account' | 'server'

export type Area = { slug: AreaSlug; group: AreaGroup; icon: LucideIcon; key: string }

/** In the order of the navigation; `key` names the texts `settings.areas.<key>.title` and `.text`. */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', icon: UserRound, key: 'profile' },
  { slug: 'security', group: 'account', icon: ShieldCheck, key: 'security' },
  { slug: 'appearance', group: 'account', icon: Palette, key: 'appearance' },
  { slug: 'connections', group: 'account', icon: Plug, key: 'connections' },
  { slug: 'general', group: 'server', icon: SlidersHorizontal, key: 'general' },
  { slug: 'sign-in', group: 'server', icon: KeyRound, key: 'signIn' },
  { slug: 'mail', group: 'server', icon: Mail, key: 'mail' },
  { slug: 'storage', group: 'server', icon: HardDrive, key: 'storage' },
  { slug: 'ocr', group: 'server', icon: ScanText, key: 'ocr' },
  { slug: 'accounts', group: 'server', icon: Users, key: 'accounts' },
  { slug: 'log', group: 'server', icon: ScrollText, key: 'log' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** The addresses of the tabs before the areas: a saved link still leads to the place it meant. */
const FORMER: Record<string, AreaSlug> = { account: 'profile', server: 'general' }

/** The areas an account may open: the operator all, a member those of its own account. */
export function areasFor(role: Role | undefined): Area[] {
  return role === 'operator' ? AREAS : AREAS.filter((area) => area.group === 'account')
}

export function areaPath(slug: AreaSlug): string {
  return `/settings/${slug}`
}

/**
 * Where an address of the settings leads: the area itself, or the address to go to instead (an address of before, an
 * area the account may not open, which goes to the profile). The answer of a provider after linking (`?linked=`,
 * `?error=`) comes to `/settings` and belongs to Security, where the providers are.
 */
export function resolveArea(asked: string | undefined, role: Role | undefined, search: string): { area: AreaSlug } | { redirect: string } {
  const allowed = areasFor(role)
  if (asked === undefined) {
    const params = new URLSearchParams(search)
    if (params.has('linked') || params.has('error')) return { redirect: areaPath('security') + search }
    return { area: 'profile' }
  }
  if (allowed.some((area) => area.slug === asked)) return { area: asked as AreaSlug }
  const former = FORMER[asked]
  if (former && allowed.some((area) => area.slug === former)) return { redirect: areaPath(former) + search }
  return { redirect: '/settings' }
}
