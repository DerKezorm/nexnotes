/** Where a profile picture is (NOTES-2 AC-11). */
export function avatarUrl(accountId: number, stamp: string | null | undefined): string | null {
  return stamp ? `/api/avatars/${accountId}?v=${encodeURIComponent(stamp)}` : null
}
