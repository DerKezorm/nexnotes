/** Where a captured note came from, in words (AC-7): "Shared from Safari", "Dictation", "Via MCP from …". */
export function originText(origin: string, t: (key: string, values?: Record<string, unknown>) => string): string {
  const [kind, ...rest] = origin.split(':')
  const source = rest.join(':').trim()
  if (!origin) return t('folders.inbox.origin.here')
  if (kind === 'share') return source ? t('folders.inbox.origin.share', { source }) : t('folders.inbox.origin.shareAny')
  if (kind === 'dictation') return t('folders.inbox.origin.dictation')
  if (kind === 'mcp') return source ? t('folders.inbox.origin.mcp', { source }) : t('folders.inbox.origin.mcpAny')
  return t('folders.inbox.origin.other')
}
