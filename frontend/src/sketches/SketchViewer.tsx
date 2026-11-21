/**
 * A sketch over the whole page (NOTES-18 AC-1, EC-5): the original picture on its paper, to zoom (wheel, buttons,
 * `+` `-` `0`) and to move (drag, arrow keys), with "Als Bild laden". Escape or the cross closes it.
 */
import { Download, Maximize2, Minus, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { fileUrl, viewUrl, type AttachmentInfo } from '../attachments/api'
import { downloadFile } from '../attachments/open'

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 8
const STEP = 1.25

export function SketchViewer({ info, onClose }: { info: AttachmentInfo; onClose: () => void }) {
  const { t } = useTranslation()
  const close = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null)

  const zoomBy = useCallback((factor: number) => setZoom((now) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now * factor))), [])
  const fit = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])
  const move = useCallback((x: number, y: number) => setOffset((now) => ({ x: now.x + x, y: now.y + y })), [])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (event: KeyboardEvent) => {
      const handled: Record<string, () => void> = {
        Escape: onClose,
        '+': () => zoomBy(STEP),
        '=': () => zoomBy(STEP),
        '-': () => zoomBy(1 / STEP),
        '0': fit,
        ArrowLeft: () => move(60, 0),
        ArrowRight: () => move(-60, 0),
        ArrowUp: () => move(0, 60),
        ArrowDown: () => move(0, -60),
      }
      const action = handled[event.key]
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [onClose, zoomBy, fit, move])

  const onWheel = (event: WheelEvent<HTMLDivElement>) => zoomBy(event.deltaY < 0 ? STEP : 1 / STEP)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = { x: event.clientX, y: event.clientY, from: offset }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = dragging.current
    if (!start) return
    setOffset({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y })
  }
  const onPointerUp = () => {
    dragging.current = null
  }

  // The original, as sharp as the app drew it; a format no browser shows through its view.
  const source = info.inline ? fileUrl(info.id) : viewUrl(info.id)
  const tool = 'nn-btn nn-btn-ghost h-9 w-9 px-0'
  // Over the page, outside the editor: the editor would take a drag inside its blocks for moving the block.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={t('sketches.drawing.viewer', { name: info.name })} data-testid="sketch-viewer" contentEditable={false}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-mist-200">
        <span className="min-w-0 flex-1 truncate">{info.name}</span>
        <button type="button" className={tool} onClick={() => zoomBy(1 / STEP)} aria-label={t('sketches.drawing.zoomOut')} data-testid="sketch-zoom-out">
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <span className="w-12 text-center tabular-nums" data-testid="sketch-zoom">
          {Math.round(zoom * 100)} %
        </span>
        <button type="button" className={tool} onClick={() => zoomBy(STEP)} aria-label={t('sketches.drawing.zoomIn')} data-testid="sketch-zoom-in">
          <Plus className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={tool} onClick={fit} aria-label={t('sketches.drawing.fit')} data-testid="sketch-fit">
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className="nn-btn nn-btn-ghost h-9 px-3" onClick={() => downloadFile(fileUrl(info.id, true))} data-testid="sketch-viewer-download">
          <Download className="h-4 w-4" aria-hidden />
          {t('sketches.drawing.download')}
        </button>
        <button ref={close} type="button" className={tool} onClick={onClose} aria-label={t('common.close')} data-testid="sketch-viewer-close">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="sketch-stage"
      >
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <img
            src={source}
            alt={info.name}
            draggable={false}
            className="nn-sketch-paper max-h-full max-w-full rounded-md object-contain select-none"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, transformOrigin: 'center' }}
            data-testid="sketch-viewer-image"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
