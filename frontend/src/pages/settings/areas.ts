/**
 * The areas of the settings, each with its own address (`/settings/<slug>`, plan "Einstellungen"): "Mein Konto" for
 * every account (Profile, Security, Appearance, Connections; nexnotes sends no notifications), "Server" for the
 * operator only (General, Sign-in, Mail, Storage and backups, then nexnotes' own Text recognition, Accounts, Log), and
 * "Über nexnotes" (`/settings/about`) for everyone, set apart at the end. Titles and lines of the shared areas come from
 * the ui kit (`areaText`); Text recognition keeps its own. `/settings` alone is the list on a phone and the profile
 * beside it on a wider page; the addresses of the tabs before the areas lead to their area.
 */
import type { IconLike } from '../../vendor/nexui'
import type { Me } from '../../api/client'

type Role = Me['role']

export type AreaSlug = 'profile' | 'security' | 'appearance' | 'connections' | 'general' | 'sign-in' | 'mail' | 'storage' | 'ocr' | 'accounts' | 'log' | 'about'
export type AreaGroup = 'account' | 'server'

/** `own`: an area of nexnotes alone, its title and line under `settings.areas.<slug>` of nexnotes' words. */
export type Area = { slug: AreaSlug; group: AreaGroup; icon: IconLike; own?: boolean }

/** In the order of the navigation (plan "Einstellungen", "Reihenfolge Mein Konto" and "Reihenfolge Server"). */
export const AREAS: Area[] = [
  { slug: 'profile', group: 'account', icon: 'UserRound' },
  { slug: 'security', group: 'account', icon: 'ShieldCheck' },
  { slug: 'appearance', group: 'account', icon: 'Palette' },
  { slug: 'connections', group: 'account', icon: 'Plug' },
  { slug: 'general', group: 'server', icon: 'SlidersHorizontal' },
  { slug: 'sign-in', group: 'server', icon: 'KeyRound' },
  { slug: 'mail', group: 'server', icon: 'Mail' },
  { slug: 'storage', group: 'server', icon: 'HardDrive' },
  { slug: 'ocr', group: 'server', icon: 'ScanText', own: true },
  { slug: 'accounts', group: 'server', icon: 'Users' },
  { slug: 'log', group: 'server', icon: 'ScrollText' },
]

export const GROUPS: AreaGroup[] = ['account', 'server']

/** "Über nexnotes": an area of every account, below the groups (its `group` only says who may open it). */
export const ABOUT_AREA: Area = { slug: 'about', group: 'account', icon: 'Info' }

/** The area of an address, the groups' and "Über nexnotes". */
export function findArea(slug: AreaSlug): Area | undefined {
  return slug === ABOUT_AREA.slug ? ABOUT_AREA : AREAS.find((area) => area.slug === slug)
}

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
 * area the account may not open, which goes to the settings' start). `/settings` alone shows the profile (and on a
 * phone the list). The answer of a provider after linking (`?linked=`, `?error=`) comes to `/settings` and belongs to
 * Security, where the providers are.
 */
export function resolveArea(asked: string | undefined, role: Role | undefined, search: string): { area: AreaSlug } | { redirect: string } {
  const allowed = areasFor(role)
  if (asked === undefined) {
    const params = new URLSearchParams(search)
    if (params.has('linked') || params.has('error')) return { redirect: areaPath('security') + search }
    return { area: 'profile' }
  }
  if (asked === ABOUT_AREA.slug || allowed.some((area) => area.slug === asked)) return { area: asked as AreaSlug }
  const former = FORMER[asked]
  if (former && allowed.some((area) => area.slug === former)) return { redirect: areaPath(former) + search }
  return { redirect: '/settings' }
}
