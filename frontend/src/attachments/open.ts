/** Small helpers of the attachments' blocks (NOTES-10): sizes of pictures, opening and downloading without leaving
 * the page, the length of a video, the host of a link. */

export type ImageSize = 'small' | 'medium' | 'full'
export const IMAGE_SIZES: ImageSize[] = ['small', 'medium', 'full']
/** How wide a picture stands, of the text's width. */
export const WIDTH: Record<ImageSize, string> = { small: '33%', medium: '62%', full: '100%' }

/** Opens a file of nexnotes in a tab of its own, without a way back into this page. */
export function openFile(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Opens the page of a link card in a tab of its own (only http and https), without a way back into this page. */
export function openLink(href: string): void {
  if (/^https?:\/\//i.test(href.trim())) window.open(href.trim(), '_blank', 'noopener,noreferrer')
}

/** Starts the download of a file (the server sends it as an attachment, so the page stays). */
export function downloadFile(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = ''
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function duration(ms: number | null | undefined): string {
  if (!ms) return ''
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return href
  }
}
