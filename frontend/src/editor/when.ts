import { moment } from '../lib/time'

/** "heute, 09:12", "gerade eben", "gestern, 18:03", or the date. */
export function whenText(value: string, lang: string, t: (key: string, values?: Record<string, unknown>) => string, now = new Date()): string {
  const date = new Date(value)
  const seconds = (now.getTime() - date.getTime()) / 1000
  if (seconds < 60) return t('editor.meta.justNow')
  const time = date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= today) return t('editor.meta.today', { time })
  if (date.getTime() >= today - 86_400_000) return t('editor.meta.yesterday', { time })
  return moment(value, lang)
}
