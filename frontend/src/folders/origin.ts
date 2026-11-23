/** Where a captured note came from, in words (AC-7): "Shared from Safari", "Dictation", "Via MCP from …", "Via the
 * API from …" (NOTES-25). */
export function originText(origin: string, t: (key: string, values?: Record<string, unknown>) => string): string {
  const [kind, ...rest] = origin.split(':')
  const source = rest.join(':').trim()
  if (!origin) return t('folders.inbox.origin.here')
  if (kind === 'share') return source ? t('folders.inbox.origin.share', { source }) : t('folders.inbox.origin.shareAny')
  if (kind === 'dictation') return t('folders.inbox.origin.dictation')
  if (kind === 'mcp') return source ? t('folders.inbox.origin.mcp', { source }) : t('folders.inbox.origin.mcpAny')
  if (kind === 'api') return source ? t('folders.inbox.origin.api', { name: source }) : t('folders.inbox.origin.apiAny')
  if (kind === 'shortcut') return t('folders.inbox.origin.shortcut')
  if (kind === 'nexdeck') return t('folders.inbox.origin.nexdeck')
  if (kind === 'guide') return t('folders.inbox.origin.guide')
  // The iOS app's quick ways (NOTESIOS-23): the Home Screen widget, the Lock Screen, Control Center or the Action button.
  if (kind === 'widget') return t('folders.inbox.origin.widget')
  if (kind === 'lockscreen') return t('folders.inbox.origin.lockscreen')
  if (kind === 'control') return t('folders.inbox.origin.control')
  return t('folders.inbox.origin.other')
}
