/** Hooks of an open note for its attachments (NOTES-10): files dragged over it, the way from the gallery. */
import { useEffect, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'

/** Whether files are being dragged over `area` right now (the browser says "Files" before the drop). */
export function useFileDrag(area: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const element = area.current
    if (!element || !enabled) return
    let depth = 0
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault()
    }
    const end = () => {
      depth = 0
      setDragging(false)
    }
    element.addEventListener('dragenter', enter)
    element.addEventListener('dragleave', leave)
    element.addEventListener('dragover', over)
    element.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      element.removeEventListener('dragenter', enter)
      element.removeEventListener('dragleave', leave)
      element.removeEventListener('dragover', over)
      element.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [area, enabled])
  return dragging
}

/** The way from the gallery: the attachment of `?attachment=` is scrolled into view and marked for a moment. */
export function useJumpToAttachment(ready: boolean): void {
  const [params] = useSearchParams()
  const wanted = params.get('attachment')
  useEffect(() => {
    if (!ready || !wanted) return
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      const element = document.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(wanted)}"]`)
      if (element || tries > 40) clearInterval(timer)
      if (!element) return
      element.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      element.classList.add('nn-attachment-found')
      setTimeout(() => element.classList.remove('nn-attachment-found'), 4000)
    }, 200)
    return () => clearInterval(timer)
  }, [ready, wanted])
}
