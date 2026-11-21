/** A tapped notification (NOTES-14 AC-5): what the service worker (`public/sw.js`) sends a window, and the check of
 * the address it carries. */

/** The message's type: the address inside nexnotes is in `url`. */
export const OPEN_MESSAGE = 'nexnotes-open'

/** Only an address inside nexnotes: a path, never another site. */
export function insidePath(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null
  return url
}
