/** Where a profile picture is (NOTES-2 AC-11), and the letter in its place. */
export function avatarUrl(accountId: number, stamp: string | null | undefined): string | null {
  return stamp ? `/api/avatars/${accountId}?v=${encodeURIComponent(stamp)}` : null
}

export function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase()
}
