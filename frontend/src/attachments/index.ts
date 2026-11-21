/** Attachments (NOTES-10). Importing this module docks them onto the frame (`register.tsx`). */
import './register'

export { attachmentsApi, fileUrl, thumbUrl, viewUrl } from './api'
export type { AttachmentInfo, Gallery, GalleryItem, Limits, LinkCard } from './api'
