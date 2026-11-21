/**
 * Dates, times and numbers in the format of the chosen language (NOTES-22 AC-4): 20.11.2026 and 2,4 MB in German,
 * Nov 20, 2026 and 2.4 MB in English. An added language gets its own format from the browser (Intl).
 */

/** A day: "20.11.2026" in German, "Nov 20, 2026" in English. */
export function day(value: string | number | Date, lang: string): string {
  const date = new Date(value)
  if (lang.startsWith('de')) return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return date.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A day with the time: "20.11.2026, 08:14" or "Nov 20, 2026, 8:14 AM". */
export function dayTime(value: string | number | Date, lang: string): string {
  const date = new Date(value)
  const time = date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  return `${day(date, lang)}, ${time}`
}

/** A number as the language writes it: 1.234,5 or 1,234.5. */
export function number(value: number, lang: string, digits = 0): string {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** A size: "2,4 MB" or "2.4 MB"; one decimal from MB on, none below. */
export function bytes(value: number, lang: string): string {
  let size = Math.max(0, value)
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit++
  }
  const digits = unit >= 2 && size < 100 ? 1 : 0
  return `${number(size, lang, digits)} ${UNITS[unit]}`
}
