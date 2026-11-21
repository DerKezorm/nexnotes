/**
 * The transcript of a recording (NOTES-18, format "nexnotes-transcript 1", written by the iOS app and checked by the
 * server in `services/sketches.py`): the words as recognised with their times, and the text as it is to be read.
 *
 * The text may have been corrected by hand after the recording (EC-1). Its words are matched to the timed words in
 * the same order, compared without case, punctuation and accents; where they differ, the longest common run of the next
 * `WINDOW` words of both decides which belong together. A word of the text without a partner has no time:
 * it is skipped while reading along, and a click on it jumps to the next word that has one.
 */
import { fileUrl } from '../attachments/api'

export type TimedWord = { text: string; start: number; end: number }
export type Transcript = { format: 1; language: string | null; text: string | null; words: TimedWord[] }

/** A word of the text as the page shows it: its blanks after it, its time (or none), its sentence. */
export type Token = { text: string; space: string; start: number | null; end: number | null; sentence: number }

/** How far ahead a correction is looked past, in words. */
export const WINDOW = 20

/** A word compared: lower case, no accents, letters and digits only. */
export function normalize(word: string): string {
  return word
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

const SENTENCE_END = /[.!?…]["'»«“”’)\]]*$/

function split(text: string): { text: string; space: string }[] {
  return Array.from(text.matchAll(/(\S+)(\s*)/g), (match) => ({ text: match[1], space: match[2] ? (match[2].includes('\n') ? '\n' : ' ') : '' }))
}

/** The pairs of the longest common run of words of `keys[i..]` and `wordKeys[j..]`, each within `WINDOW` words. */
function localMatches(keys: string[], wordKeys: string[], i: number, j: number): [number, number][] {
  const n = Math.min(WINDOW, keys.length - i)
  const m = Math.min(WINDOW, wordKeys.length - j)
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let a = n - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) {
      table[a][b] = keys[i + a] && keys[i + a] === wordKeys[j + b] ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1])
    }
  }
  const pairs: [number, number][] = []
  let a = 0
  let b = 0
  while (a < n && b < m) {
    if (keys[i + a] && keys[i + a] === wordKeys[j + b] && table[a][b] === table[a + 1][b + 1] + 1) {
      pairs.push([i + a, j + b])
      a += 1
      b += 1
    } else if (table[a + 1][b] >= table[a][b + 1]) a += 1
    else b += 1
  }
  return pairs
}

/** The words of the transcript as the page shows them, each with its time where the text and the recognised words
 * agree. */
export function tokensOf(transcript: Pick<Transcript, 'text' | 'words'>): Token[] {
  const words = transcript.words ?? []
  const parts = transcript.text ? split(transcript.text) : words.map((word, index) => ({ text: word.text, space: index < words.length - 1 ? ' ' : '' }))
  const tokens: Token[] = []
  let sentence = 0
  for (const part of parts) {
    tokens.push({ text: part.text, space: part.space, start: null, end: null, sentence })
    if (SENTENCE_END.test(part.text) || part.space === '\n') sentence += 1
  }
  const keys = tokens.map((token) => normalize(token.text))
  const wordKeys = words.map((word) => normalize(word.text))
  let i = 0
  let j = 0
  while (i < tokens.length && j < words.length) {
    if (keys[i] && keys[i] === wordKeys[j]) {
      tokens[i].start = words[j].start
      tokens[i].end = words[j].end
      i += 1
      j += 1
      continue
    }
    if (!keys[i]) {
      // Only punctuation: never a word of its own.
      i += 1
      continue
    }
    // A correction: the longest common run of the next words decides which belong together. Only its first half
    // is taken; the rest is looked at again from there, with the words after it in view.
    const pairs = localMatches(keys, wordKeys, i, j)
    if (!pairs.length) {
      // Nothing matches near by: a word changed for another, without a time.
      i += 1
      j += 1
      continue
    }
    const taken = pairs.filter(([a]) => a < i + WINDOW / 2)
    for (const [a, b] of taken.length ? taken : pairs.slice(0, 1)) {
      tokens[a].start = words[b].start
      tokens[a].end = words[b].end
      i = a + 1
      j = b + 1
    }
  }
  return tokens
}

/** The positions of the words with a time, in the order of the text (and of their times). */
export function timedIndexes(tokens: Token[]): number[] {
  const found: number[] = []
  let last = -1
  for (let index = 0; index < tokens.length; index++) {
    const start = tokens[index].start
    // A time before the last one would make the reading jump back: such a word counts as without one.
    if (start !== null && start >= last) {
      found.push(index)
      last = start
    }
  }
  return found
}

/** The word spoken at `ms`: the last word with a time that began by then; -1 before the first. */
export function activeIndex(tokens: Token[], timed: number[], ms: number): number {
  let low = 0
  let high = timed.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((tokens[timed[middle]].start ?? 0) <= ms) {
      found = timed[middle]
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** Where a click on word `index` leads: its time, else the time of the next word with one, else of the last before. */
export function jumpTarget(tokens: Token[], index: number): number | null {
  for (let at = index; at < tokens.length; at++) if (tokens[at].start !== null) return tokens[at].start
  for (let at = index - 1; at >= 0; at--) if (tokens[at].start !== null) return tokens[at].start
  return null
}

/** The first and the last word of the sentence word `index` stands in. */
export function sentenceRange(tokens: Token[], index: number): [number, number] {
  const sentence = tokens[index]?.sentence
  let first = index
  let last = index
  while (first > 0 && tokens[first - 1].sentence === sentence) first -= 1
  while (last < tokens.length - 1 && tokens[last + 1].sentence === sentence) last += 1
  return [first, last]
}

// --- Loading ------------------------------------------------------------------------------------------------------------

/** Transcripts never change under their id. */
const loaded = new Map<string, Promise<Transcript | null>>()

export function loadTranscript(id: string): Promise<Transcript | null> {
  let found = loaded.get(id)
  if (!found) {
    found = fetch(fileUrl(id), { credentials: 'same-origin' })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(String(answer.status))
        const data = (await answer.json()) as Transcript
        return data && Array.isArray(data.words) ? data : null
      })
      .catch(() => {
        // Not there yet (still uploading) or gone: asked again next time.
        loaded.delete(id)
        return null
      })
    loaded.set(id, found)
  }
  return found
}

export function forgetTranscripts(): void {
  loaded.clear()
}
