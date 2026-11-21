/**
 * A kept recording in a note (NOTES-18, drawing "N18-Skizze-Aufnahme"): a player and its text to read along.
 *
 * - Playing shows "Anhalten", the position to drag, the time gone and the whole time (AC-7); speed 1×, 1,5×, 2×,
 *   chosen once for the device (AC-5).
 * - While it plays, the word being spoken is marked, its sentence stands out, what was heard is dimmer than what comes
 *   (AC-3); a click on a word jumps there (AC-4). Words written by hand after the recording have no time and are
 *   skipped (EC-1, `transcript.ts`).
 * - Space starts and stops, the arrow keys jump five seconds (EC-6); only one recording of the page plays (EC-4);
 *   nothing of it goes into the note, so everybody listens on their own (EC-7).
 * - The sound is asked for in pieces (`preload="metadata"`, Range): two hours start at once and the end is one jump
 *   away (EC-2). A format the browser cannot play is offered to download (EC-3).
 */
import { Download, Mic, Pause, Play, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { fileUrl } from '../attachments/api'
import type { BlockActions } from '../attachments/blocks'
import { loadNote, useAttachment } from '../attachments/info'
import { downloadFile } from '../attachments/open'
import { bytes } from '../lib/format'
import { claim, clock, RATES, release, setRate, useRate, type Rate } from './playback'
import { activeIndex, jumpTarget, loadTranscript, sentenceRange, timedIndexes, tokensOf, type Token } from './transcript'
import './sketches.css'

/** How far the arrow keys jump, in milliseconds. */
export const JUMP_MS = 5000

type TranscriptState = { tokens: Token[]; state: 'ready' } | { tokens: null; state: 'loading' | 'missing' | 'none' }

function useTranscript(id: string | null): TranscriptState {
  const [found, setFound] = useState<TranscriptState>(id ? { tokens: null, state: 'loading' } : { tokens: null, state: 'none' })
  useEffect(() => {
    if (!id) {
      setFound({ tokens: null, state: 'none' })
      return
    }
    let alive = true
    setFound({ tokens: null, state: 'loading' })
    void loadTranscript(id).then((transcript) => {
      if (alive) setFound(transcript ? { tokens: tokensOf(transcript), state: 'ready' } : { tokens: null, state: 'missing' })
    })
    return () => {
      alive = false
    }
  }, [id])
  return found
}

export function RecordingBlock({ noteId, id, name, duration, transcript, actions }: { noteId: string; id: string | null; name: string | null; duration: number | null; transcript: string | null; actions: BlockActions }) {
  const { t, i18n } = useTranslation()
  const { info, loaded } = useAttachment(noteId, id)
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [length, setLength] = useState<number | null>(null)
  const [broken, setBroken] = useState(false)
  // Nothing is marked in the text before the recording was started or moved.
  const [engaged, setEngaged] = useState(false)
  const rate = useRate()
  const words = useTranscript(transcript)
  const pending = useRef<number | null>(null)

  useEffect(() => {
    if (id && loaded && !info && noteId) void loadNote(noteId)
  }, [id, loaded, info, noteId])
  // A browser that says it cannot play the format at all is not even asked (EC-3).
  useEffect(() => {
    const media = audio.current
    if (media && info?.mime && typeof media.canPlayType === 'function' && media.canPlayType(info.mime) === '') setBroken(true)
  }, [info?.mime])
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate
  }, [rate, info])
  // While it plays, the position follows every frame (the browser's own event comes only four times a second).
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const follow = () => {
      if (audio.current) setAt(audio.current.currentTime * 1000)
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  // A player that leaves the page (the block removed, the note closed) stops; the element only exists once the
  // attachment is known.
  const shownId = info?.id
  useEffect(() => {
    const media = audio.current
    if (!media) return
    return () => {
      media.pause()
      release(media)
    }
  }, [shownId])

  const total = length ?? info?.duration_ms ?? duration ?? 0

  const seek = useCallback((ms: number) => {
    const media = audio.current
    const target = Math.max(0, total ? Math.min(ms, total) : ms)
    setAt(target)
    setEngaged(true)
    if (!media) return
    if (media.readyState >= 1) media.currentTime = target / 1000
    else pending.current = target
  }, [total])

  const toggle = useCallback(() => {
    const media = audio.current
    if (!media || broken) return
    if (media.paused) {
      claim(media)
      media.playbackRate = rate
      void media.play()?.catch?.(() => undefined)
    } else media.pause()
  }, [broken, rate])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const inSpeeds = Boolean(target.closest('[data-speeds]'))
    if (event.key === ' ' && target.tagName !== 'BUTTON') {
      event.preventDefault()
      toggle()
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !inSpeeds) {
      event.preventDefault()
      seek(at + (event.key === 'ArrowRight' ? JUMP_MS : -JUMP_MS))
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && inSpeeds) {
      event.preventDefault()
      const next = RATES[(RATES.indexOf(rate) + (event.key === 'ArrowRight' ? 1 : RATES.length - 1)) % RATES.length]
      setRate(next)
      ;(target.parentElement?.querySelector(`[data-rate="${next}"]`) as HTMLElement | null)?.focus()
    }
  }

  const remove = actions.editable && actions.onRemove ? (
    <button type="button" onClick={actions.onRemove} aria-label={t('attachments.remove')} title={t('attachments.remove')} data-testid="attachment-remove" className="nn-attachment-remove absolute top-2 right-2 z-10 grid h-7 w-7 place-items-center rounded-full bg-ink-900/85 text-mist-300 hover:text-mist-100">
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  ) : null

  if (!info) {
    return (
      <div className="nn-attachment relative flex items-center gap-3 rounded-[12px] border border-ink-700 bg-ink-850 p-3" data-attachment-id={id ?? ''} data-kind="missing" data-testid="recording-missing">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-mist-500">
          <Mic className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm text-mist-100">{name || t('sketches.recording.title')}</span>
          <span className="text-[12.5px] text-mist-500">{loaded ? t('attachments.missing') : t('attachments.loading')}</span>
        </span>
        {remove}
      </div>
    )
  }

  const shownName = info.name || name || t('sketches.recording.title')
  return (
    <div
      className="nn-attachment nn-recording relative flex flex-col gap-3 rounded-[14px] border border-ink-700 bg-ink-850 px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      role="group"
      aria-label={t('sketches.recording.label', { name: shownName })}
      aria-description={t('sketches.recording.keys')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-attachment-id={id ?? ''}
      data-kind="recording"
      data-playing={playing ? 'true' : 'false'}
      data-testid="recording"
    >
      <audio
        ref={audio}
        src={fileUrl(info.id)}
        preload="metadata"
        onPlay={(event) => {
          claim(event.currentTarget)
          setPlaying(true)
          setEngaged(true)
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setAt(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          const media = event.currentTarget
          if (Number.isFinite(media.duration) && media.duration > 0) setLength(media.duration * 1000)
          media.playbackRate = rate
          if (pending.current !== null) {
            media.currentTime = pending.current / 1000
            pending.current = null
          }
        }}
        onError={() => setBroken(true)}
        data-testid="recording-audio"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={broken}
          aria-label={playing ? t('sketches.recording.pause') : t('sketches.recording.play')}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-500 text-on-accent disabled:opacity-40"
          data-testid="recording-toggle"
        >
          {playing ? <Pause className="h-4 w-4" aria-hidden fill="currentColor" /> : <Play className="h-4 w-4" aria-hidden fill="currentColor" />}
        </button>
        <span className="flex min-w-[200px] flex-1 flex-col gap-1">
          <input
            type="range"
            min={0}
            max={Math.max(total, 1)}
            step={100}
            value={Math.min(at, Math.max(total, 1))}
            onChange={(event) => seek(Number(event.currentTarget.value))}
            disabled={broken}
            aria-label={t('sketches.recording.position')}
            aria-valuetext={t('sketches.recording.positionText', { at: clock(at), total: clock(total) })}
            className="w-full"
            data-testid="recording-position"
          />
          <span className="flex justify-between text-xs text-mist-500 tabular-nums">
            <span data-testid="recording-elapsed">{clock(at)}</span>
            <span data-testid="recording-total">{clock(total)}</span>
          </span>
        </span>
        <span role="radiogroup" aria-label={t('sketches.recording.speed')} data-speeds="" className="flex rounded-[9px] border border-ink-700 bg-ink-900 p-[3px] text-[12.5px]" data-testid="recording-speeds">
          {RATES.map((choice: Rate) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={choice === rate}
              tabIndex={choice === rate ? 0 : -1}
              data-rate={choice}
              onClick={() => setRate(choice)}
              className={'rounded-md px-2.5 py-1 ' + (choice === rate ? 'bg-accent-wash font-semibold text-accent-400' : 'text-mist-500 hover:text-mist-100')}
              data-testid={`recording-speed-${choice}`}
            >
              {t(`sketches.recording.rate.${String(choice).replace('.', '_')}`)}
            </button>
          ))}
        </span>
      </div>
      {words.state === 'ready' && words.tokens.length > 0 ? (
        <>
          <TranscriptText tokens={words.tokens} at={engaged ? at : -1} onJump={seek} />
          <span className="text-xs text-mist-500">{t('sketches.recording.hint')}</span>
        </>
      ) : words.state === 'loading' || words.state === 'missing' ? (
        <span className="text-[13px] text-mist-500" data-testid="recording-transcript-state">
          {words.state === 'loading' ? t('sketches.recording.transcriptLoading') : t('sketches.recording.transcriptMissing')}
        </span>
      ) : null}
      <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-mist-500">
        <span className="min-w-0 truncate" data-testid="recording-caption">
          {shownName} · {bytes(info.size, i18n.language)}
        </span>
        <span className="flex items-center gap-2">
          {broken && <span data-testid="recording-unplayable">{t('sketches.recording.cannotPlay')}</span>}
          <button type="button" className="inline-flex items-center gap-1 text-accent-400 hover:underline" onClick={() => downloadFile(fileUrl(info.id, true))} data-testid="recording-download">
            <Download className="h-3 w-3" aria-hidden />
            {t('attachments.download')}
          </button>
        </span>
      </span>
      {remove}
    </div>
  )
}

/**
 * The words of the transcript, drawn once (two hours are some 20,000 words); while it plays only the words whose
 * state changes are touched.
 */
const TranscriptText = memo(function TranscriptText({ tokens, at, onJump }: { tokens: Token[]; at: number; onJump: (ms: number) => void }) {
  const box = useRef<HTMLParagraphElement>(null)
  const timed = useMemo(() => timedIndexes(tokens), [tokens])
  const active = activeIndex(tokens, timed, at)
  const before = useRef(-1)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const previous = before.current
    const range = (index: number): [number, number] => (index < 0 ? [0, -1] : sentenceRange(tokens, index))
    const [fromA, toA] = range(previous)
    const [fromB, toB] = range(active)
    const from = Math.min(previous < 0 ? 0 : fromA, active < 0 ? 0 : fromB)
    const to = Math.max(toA, toB)
    const sentence = active < 0 ? -1 : tokens[active].sentence
    const spans = element.children
    for (let index = from; index <= to && index < spans.length; index++) {
      const span = spans[index] as HTMLElement
      span.classList.toggle('nn-w-heard', active >= 0 && index < active && tokens[index].sentence !== sentence)
      span.classList.toggle('nn-w-sentence', active >= 0 && tokens[index].sentence === sentence && index !== active)
      span.classList.toggle('nn-w-now', index === active)
    }
    before.current = active
  }, [active, tokens])

  const click = (event: MouseEvent<HTMLParagraphElement>) => {
    const word = (event.target as HTMLElement).closest<HTMLElement>('[data-i]')
    if (!word) return
    const target = jumpTarget(tokens, Number(word.dataset.i))
    if (target !== null) onJump(target)
  }

  return (
    <p ref={box} className="nn-transcript m-0 text-[15px] leading-[1.75] whitespace-pre-wrap" onClick={click} data-testid="recording-transcript">
      {tokens.map((token, index) => (
        <span key={index} className="nn-w" data-i={index} data-timed={token.start === null ? 'false' : 'true'}>
          {token.text + token.space}
        </span>
      ))}
    </p>
  )
})
