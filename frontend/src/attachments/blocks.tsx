/**
 * How an attachment stands in a note (NOTES-10, drawing "N10-Notiz"), the same in the editor and in an old version:
 *
 * - a picture in its size (small, medium, full width), name and size under it, "Groß öffnen" (AC-2); HEIC through
 *   the WebP every browser shows (EC-3);
 * - a PDF as a card with the picture of its first page, name, pages and size, "Zum Blättern öffnen" (AC-3);
 * - a video that plays in the note, with its still, length, name and size; one the browser cannot play shows its
 *   still, name and "Herunterladen" (AC-8, EC-7);
 * - any other file with its symbol, name, size and "Herunterladen" (AC-4);
 * - the card of a link with picture, title, description and site, and "Als Link lassen" (AC-5);
 * - while it uploads: progress with a cancel button, "wartet", or in red that the connection broke, with "Erneut
 *   hochladen" (AC-10, EC-2, EC-6); an attachment not there yet (somebody else uploads it): "Der Anhang fehlt noch".
 *
 * Names are always text, never markup (EC-4). Opening and downloading never leave the page through a link inside the
 * editor: `openFile` and `downloadFile` go through a window or an anchor of their own.
 */
import { AlertCircle, Download, File as FileIcon, FileText, Image as ImageIcon, Link2, Play, Video, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../components/Menu'
import { bytes } from '../lib/format'
import './attachments.css'
import { fileUrl, thumbUrl, viewUrl, type AttachmentInfo, type LinkCard } from './api'
import { downloadFile, duration, hostOf, IMAGE_SIZES, openFile, openLink, WIDTH, type ImageSize } from './open'
import { useAttachment } from './info'
import { largeViewFor } from './large'
import { SEALED_BLOCK } from './sealed'
import { cancelUpload, retryUpload, useUpload, type Upload } from './uploads'

/** What a block can do with its attachment; nothing of it in an old version or a note one only reads. */
export type BlockActions = {
  editable: boolean
  onRemove?: () => void
  onSize?: (size: ImageSize) => void
  /** The link card back to a plain link. */
  onPlain?: () => void
}

const card = 'rounded-[12px] border border-ink-700 bg-ink-850'

function Remove({ onRemove }: { onRemove?: () => void }) {
  const { t } = useTranslation()
  if (!onRemove) return null
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t('attachments.remove')}
      title={t('attachments.remove')}
      data-testid="attachment-remove"
      className="nn-attachment-remove absolute top-2 right-2 z-10 grid h-7 w-7 place-items-center rounded-full bg-ink-900/85 text-mist-300 hover:text-mist-100"
    >
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/** A sketch or a recording of a locked note shows as its encrypted file does; every other as it is. */
export function SealedOr({ noteId, id, name, actions, children }: { noteId: string; id: string | null; name: string | null; actions: BlockActions; children: ReactNode }) {
  const { info } = useAttachment(noteId, id)
  if (info?.sealed && SEALED_BLOCK.render) return <>{SEALED_BLOCK.render({ noteId, id: info.id, name, actions })}</>
  return <>{children}</>
}

/** The block of an attachment in a note: what this tab uploads, what the server describes, or that it is missing. */
export function AttachmentBlock({ noteId, id, name, size, nodeType, actions }: { noteId: string; id: string | null; name: string | null; size?: ImageSize; nodeType: 'image' | 'attachment'; actions: BlockActions }) {
  const upload = useUpload(id)
  const { info, loaded } = useAttachment(noteId, upload ? null : id)
  const shownName = info?.name || name || ''
  let inner: ReactNode
  if (upload) inner = <UploadCard upload={upload} onRemove={actions.editable ? actions.onRemove : undefined} kind={nodeType} />
  else if (!info) inner = <MissingCard name={shownName} loaded={loaded} kind={nodeType} onRemove={actions.editable ? actions.onRemove : undefined} />
  else if (info.sealed && SEALED_BLOCK.render) inner = SEALED_BLOCK.render({ noteId, id: info.id, name, size, actions })
  else if (['image', 'scan', 'drawing', 'linkimage'].includes(info.kind)) inner = <PictureBlock info={info} noteId={noteId} size={size ?? 'medium'} actions={actions} />
  else if (info.kind === 'pdf') inner = <PdfCard info={info} noteId={noteId} actions={actions} />
  else if (info.kind === 'video') inner = <VideoBlock info={info} actions={actions} />
  else inner = <FileCard info={info} actions={actions} />
  return (
    <div className="nn-attachment relative" data-attachment-id={id ?? ''} data-kind={upload ? 'upload' : (info?.kind ?? 'missing')}>
      {inner}
    </div>
  )
}

function UploadCard({ upload, kind, onRemove }: { upload: Upload; kind: 'image' | 'attachment'; onRemove?: () => void }) {
  const { t, i18n } = useTranslation()
  const Icon = kind === 'image' ? ImageIcon : FileIcon
  const failed = upload.state === 'failed'
  const percent = Math.round(upload.progress * 100)
  const reason =
    upload.error === 'network'
      ? t('attachments.upload.broken')
      : upload.error === 'storage_limit_reached'
        ? t('attachments.upload.full')
        : upload.error === 'attachment_too_large'
          ? t('attachments.upload.tooLarge', { max: Number(upload.values?.max_mb ?? 0) })
          : t('attachments.upload.failed')
  return (
    <div
      className={'flex items-center gap-3 p-3 ' + card + (failed ? ' border-bad-500' : '')}
      data-testid="attachment-upload"
      data-state={upload.state}
      role={failed ? 'alert' : undefined}
    >
      <span className={'grid h-10 w-10 shrink-0 place-items-center rounded-[10px] ' + (failed ? 'bg-bad-500/12 text-bad-500' : 'bg-ink-800 text-mist-300')}>
        {failed ? <AlertCircle className="h-[18px] w-[18px]" aria-hidden /> : <Icon className="h-[18px] w-[18px]" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 justify-between gap-3 text-sm">
          <span className="truncate text-mist-100">{upload.name}</span>
          {!failed && (
            <span className="shrink-0 text-mist-500" data-testid="attachment-progress">
              {upload.state === 'waiting' ? t('attachments.upload.waiting') : t('attachments.upload.progress', { percent })}
            </span>
          )}
          {failed && <span className="shrink-0 text-mist-500">{bytes(upload.size, i18n.language)}</span>}
        </span>
        {failed ? (
          <span className="text-[12.5px] text-bad-500">{reason}</span>
        ) : (
          <span className="flex h-[5px] rounded-full bg-ink-800" aria-hidden>
            <span className="rounded-full bg-accent-500 transition-[width]" style={{ width: `${upload.state === 'waiting' ? 0 : percent}%` }} />
          </span>
        )}
      </span>
      {failed ? (
        <span className="flex shrink-0 gap-1">
          {upload.error === 'network' && (
            <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" onClick={() => retryUpload(upload.id)} data-testid="attachment-retry">
              {t('attachments.upload.retry')}
            </button>
          )}
          {onRemove && (
            <button type="button" className="nn-btn nn-btn-quiet h-9 px-3 text-[13px]" onClick={() => { cancelUpload(upload.id); onRemove() }} data-testid="attachment-dismiss">
              {t('attachments.upload.dismiss')}
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          aria-label={t('attachments.upload.cancel')}
          title={t('attachments.upload.cancel')}
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg text-mist-500 hover:bg-ink-800 hover:text-mist-100"
          data-testid="attachment-cancel"
          onClick={() => {
            cancelUpload(upload.id)
            onRemove?.()
          }}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

function MissingCard({ name, loaded, kind, onRemove }: { name: string; loaded: boolean; kind: 'image' | 'attachment'; onRemove?: () => void }) {
  const { t } = useTranslation()
  const Icon = kind === 'image' ? ImageIcon : FileIcon
  return (
    <div className={'relative flex items-center gap-3 p-3 ' + card} data-testid="attachment-missing">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-mist-500">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm text-mist-100">{name || t('attachments.unnamed')}</span>
        <span className="text-[12.5px] text-mist-500">{loaded ? t('attachments.missing') : t('attachments.loading')}</span>
      </span>
      <Remove onRemove={onRemove} />
    </div>
  )
}

function PictureBlock({ info, noteId, size, actions }: { info: AttachmentInfo; noteId: string; size: ImageSize; actions: BlockActions }) {
  const { t, i18n } = useTranslation()
  const [large, setLargeHere] = useState(false)
  // Another feature's large view (NOTES-11: the text beside the picture) when there is one.
  const setLarge = (open: boolean) => {
    const view = largeViewFor()
    if (open && view && info.kind !== 'linkimage') view(info, noteId)
    else setLargeHere(open)
  }
  const [sizeMenu, setSizeMenu] = useState(false)
  const sizeButton = useRef<HTMLButtonElement>(null)
  const source = info.view ? viewUrl(info.id) : fileUrl(info.id)
  return (
    <figure className="nn-picture relative m-0" style={{ width: WIDTH[size], minWidth: size === 'small' ? 140 : 220, maxWidth: '100%' }} data-size={size}>
      <button type="button" className="block w-full cursor-zoom-in overflow-hidden rounded-[10px] bg-ink-800" onClick={() => setLarge(true)} aria-label={t('attachments.openLarge', { name: info.name })}>
        <img src={source} alt={info.name} className="block h-auto w-full" loading="lazy" width={info.width ?? undefined} height={info.height ?? undefined} draggable={false} />
      </button>
      <figcaption className="flex flex-wrap justify-between gap-x-3 gap-y-1 pt-1.5 text-xs text-mist-500">
        <span className="min-w-0 truncate" data-testid="attachment-caption">
          {info.name} · {bytes(info.size, i18n.language)}
        </span>
        <span className="flex items-center gap-1">
          {actions.editable && actions.onSize ? (
            <button ref={sizeButton} type="button" className="nn-btn-quiet rounded px-0.5 hover:text-mist-100" aria-haspopup="menu" aria-expanded={sizeMenu} onClick={() => setSizeMenu(!sizeMenu)} data-testid="attachment-size">
              {t('attachments.size.label', { size: t(`attachments.size.${size}`) })}
            </button>
          ) : null}
          {actions.editable && actions.onSize ? <span aria-hidden>·</span> : null}
          <button type="button" className="rounded px-0.5 hover:text-mist-100" onClick={() => setLarge(true)} data-testid="attachment-open-large">
            {t('attachments.openLargeShort')}
          </button>
        </span>
      </figcaption>
      {sizeMenu && sizeButton.current && (
        <Menu anchor={sizeButton.current} onClose={() => setSizeMenu(false)} label={t('attachments.size.title')} align="end" testId="attachment-size-menu">
          {IMAGE_SIZES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={choice === size}
              className="nn-menu-item"
              data-testid={`attachment-size-${choice}`}
              onClick={() => {
                setSizeMenu(false)
                actions.onSize?.(choice)
              }}
            >
              <span aria-hidden className="w-4 text-accent-400">{choice === size ? '✓' : ''}</span>
              {t(`attachments.size.${choice}`)}
            </button>
          ))}
        </Menu>
      )}
      <Remove onRemove={actions.editable ? actions.onRemove : undefined} />
      {large && <Lightbox info={info} onClose={() => setLarge(false)} />}
    </figure>
  )
}

/** A picture over the whole page (AC-2 "groß öffnen"), with the way to the original. */
export function Lightbox({ info, onClose }: { info: AttachmentInfo; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={info.name} data-testid="attachment-lightbox" contentEditable={false}>
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-mist-200">
        <span className="min-w-0 flex-1 truncate">
          {info.name} · {bytes(info.size, i18n.language)}
        </span>
        <button type="button" className="nn-btn nn-btn-ghost h-9 px-3" onClick={() => downloadFile(fileUrl(info.id, true))}>
          <Download className="h-4 w-4" aria-hidden />
          {t('attachments.download')}
        </button>
        <button ref={close} type="button" className="nn-btn nn-btn-ghost h-9 w-9 px-0" onClick={onClose} aria-label={t('common.close')}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <button type="button" className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center p-4" onClick={onClose} aria-label={t('common.close')}>
        <img src={info.view ? viewUrl(info.id) : fileUrl(info.id)} alt={info.name} className="max-h-full max-w-full object-contain" />
      </button>
    </div>
  )
}

function PdfCard({ info, noteId, actions }: { info: AttachmentInfo; noteId: string; actions: BlockActions }) {
  const { t, i18n } = useTranslation()
  const view = largeViewFor()
  const details = [t('attachments.kind.pdf'), ...(info.pages ? [t('attachments.pages', { count: info.pages })] : []), bytes(info.size, i18n.language)].join(' · ')
  return (
    <div className={'relative flex gap-3 p-3 ' + card} data-testid="attachment-pdf">
      <button type="button" className="flex min-w-0 flex-1 gap-3 text-left" onClick={() => openFile(fileUrl(info.id))} aria-label={t('attachments.openPdf', { name: info.name })}>
        <span className="flex h-[84px] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
          {info.thumb ? <img src={thumbUrl(info.id)} alt="" className="h-full w-full object-cover object-top" loading="lazy" /> : <FileText className="h-6 w-6 text-ink-700" aria-hidden />}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold text-mist-100">{info.name}</span>
          <span className="text-[12.5px] text-mist-500">{details}</span>
          <span className="text-[12.5px] text-accent-400">{t('attachments.browse')}</span>
        </span>
      </button>
      {view && (
        <button type="button" className="nn-btn-quiet self-end rounded px-1 text-[12.5px] text-mist-400 hover:text-mist-100" onClick={() => view(info, noteId)} data-testid="attachment-pdf-large">
          {t('attachments.openLargeShort')}
        </button>
      )}
      <Remove onRemove={actions.editable ? actions.onRemove : undefined} />
    </div>
  )
}

function VideoBlock({ info, actions }: { info: AttachmentInfo; actions: BlockActions }) {
  const { t, i18n } = useTranslation()
  const [playing, setPlaying] = useState(false)
  const [broken, setBroken] = useState(false)
  const length = duration(info.duration_ms)
  const poster = info.thumb ? thumbUrl(info.id) : undefined
  const caption = `${info.name} · ${bytes(info.size, i18n.language)}`
  return (
    <div className={'relative flex flex-col overflow-hidden ' + card} data-testid="attachment-video" data-playable={broken || !info.inline ? 'false' : 'true'}>
      <span className="relative flex min-h-[120px] items-center justify-center bg-ink-900">
        {playing && !broken && info.inline ? (
          <video
            src={fileUrl(info.id)}
            poster={poster}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="block max-h-[70vh] w-full"
            onError={() => setBroken(true)}
            // Some browsers play the sound of a film whose picture they cannot read (HEVC): no picture is no play.
            onLoadedMetadata={(event) => {
              if ((event.target as HTMLVideoElement).videoWidth === 0) setBroken(true)
            }}
            data-testid="attachment-player"
          />
        ) : (
          <>
            {poster ? <img src={poster} alt="" className="block max-h-[320px] w-full object-cover" loading="lazy" /> : <Video className="m-8 h-8 w-8 text-mist-500" aria-hidden />}
            {!broken && info.inline && (
              <button type="button" aria-label={t('attachments.play', { name: info.name })} onClick={() => setPlaying(true)} className="absolute grid h-12 w-12 place-items-center rounded-full bg-accent-500/90 text-on-accent" data-testid="attachment-play">
                <Play className="h-[18px] w-[18px]" aria-hidden fill="currentColor" />
              </button>
            )}
            {length && <span className="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11.5px] text-mist-100">{length}</span>}
          </>
        )}
      </span>
      <span className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12.5px] text-mist-500">
        <span className="min-w-0 truncate">{caption}</span>
        {(broken || !info.inline) && (
          <span className="flex items-center gap-2">
            <span data-testid="attachment-unplayable">{t('attachments.cannotPlay')}</span>
            <button type="button" className="text-accent-400 hover:underline" onClick={() => downloadFile(fileUrl(info.id, true))} data-testid="attachment-download">
              {t('attachments.download')}
            </button>
          </span>
        )}
      </span>
      <Remove onRemove={actions.editable ? actions.onRemove : undefined} />
    </div>
  )
}

function FileCard({ info, actions }: { info: AttachmentInfo; actions: BlockActions }) {
  const { t, i18n } = useTranslation()
  return (
    <div className={'relative flex items-center gap-3 p-3 ' + card} data-testid="attachment-file">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-mist-300">
        <FileIcon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-mist-100">{info.name}</span>
        <span className="text-[12.5px] text-mist-500">
          {bytes(info.size, i18n.language)} ·{' '}
          <button type="button" className="text-accent-400 hover:underline" onClick={() => downloadFile(fileUrl(info.id, true))} data-testid="attachment-download">
            {t('attachments.download')}
          </button>
        </span>
        {info.preview_failed && (
          <span className="text-[12.5px] text-mist-500" data-testid="attachment-no-preview">
            {t('attachments.noPreview')}
          </span>
        )}
      </span>
      <Remove onRemove={actions.editable ? actions.onRemove : undefined} />
    </div>
  )
}

/** The card of a link (AC-5): what the page says of itself, opened in a tab without a way back. */
export function LinkCardBlock({ attrs, actions }: { attrs: LinkCard; actions: BlockActions }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  return (
    <div className={'nn-attachment relative flex flex-col overflow-hidden ' + card} data-testid="attachment-link" data-kind="link">
      <button type="button" className="flex flex-col text-left" onClick={() => openLink(attrs.href)} aria-label={t('attachments.openLink', { title: attrs.title || attrs.href })}>
        {attrs.image && !broken ? (
          <img src={thumbUrl(attrs.image)} alt="" className="block max-h-[180px] w-full bg-ink-800 object-cover" loading="lazy" onError={() => setBroken(true)} />
        ) : null}
        <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
          <span className="truncate text-sm font-semibold text-mist-100">{attrs.title || attrs.href}</span>
          {attrs.description && <span className="line-clamp-2 text-[12.5px] text-mist-400">{attrs.description}</span>}
          <span className="flex items-center gap-1 truncate text-xs text-mist-500">
            <Link2 className="h-3 w-3 shrink-0" aria-hidden />
            {attrs.site || hostOf(attrs.href)}
          </span>
        </span>
      </button>
      {actions.editable && actions.onPlain && (
        <span className="flex justify-end border-t border-ink-700 px-2 py-1">
          <button type="button" className="nn-btn nn-btn-quiet h-8 px-2 text-[12.5px]" onClick={actions.onPlain} data-testid="attachment-plain-link">
            {t('attachments.plainLink')}
          </button>
        </span>
      )}
      <Remove onRemove={actions.editable ? actions.onRemove : undefined} />
    </div>
  )
}
