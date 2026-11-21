/** The date of a list row: the time for today, the weekday within a week, the date before. */
export function listDate(value: string, lang: string, now = new Date()): string {
  const date = new Date(value)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= startOfToday) return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  if (date.getTime() >= startOfToday - 6 * 86_400_000) return date.toLocaleDateString(lang, { weekday: 'short' })
  return date.toLocaleDateString(lang, { day: 'numeric', month: 'numeric', year: 'numeric' })
}
