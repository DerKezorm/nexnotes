/**
 * NOTES-12 in the browser's live connection: the room's sync answered at once, changes waiting while the connection
 * is away and confirmed once stored (AC-8), offline changes sent on the way back without loss or doubles (EC-3, AC-4),
 * and what the room's closing codes do (EC-2, EC-5, EC-7). The room is played by a small stand-in that holds its own
 * Yjs document and answers like the server's room.
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

import { SIGNED_IN_AGAIN_EVENT } from '../state/auth'
import { CLOSE_FORBIDDEN, CLOSE_GONE, CLOSE_RESTART, CLOSE_RIGHTS, MESSAGE_SYNC, NoteProvider } from './provider'

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: Uint8Array[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  receive(data: Uint8Array) {
    this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } as MessageEvent)
  }
  serverClose(code: number) {
    this.readyState = 3
    this.onclose?.({ code } as CloseEvent)
  }
}

/** The room: applies what comes, answers a step 1 with step 2 (after the browser's own step 2, like the server). */
class Room {
  doc = new Y.Doc()
  serve(socket: FakeSocket) {
    const pending = [...socket.sent]
    socket.sent.length = 0
    for (const message of pending) this.handle(socket, message)
  }
  handle(socket: FakeSocket, message: Uint8Array) {
    const decoder = decoding.createDecoder(message)
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'room')
    if (encoding.length(encoder) > 1) socket.receive(encoding.toUint8Array(encoder))
  }
  /** The room's own step 1 at the start of a connection. */
  greet(socket: FakeSocket) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    socket.receive(encoding.toUint8Array(encoder))
  }
}

function make(room: Room) {
  const provider = new NoteProvider('note', new Y.Doc(), { socket: (url) => new FakeSocket(url) as never, confirmDelay: 10, answerTimeout: 60_000 })
  provider.connect()
  const socket = () => FakeSocket.all[FakeSocket.all.length - 1]
  const connect = () => {
    socket().open()
    room.greet(socket())
    room.serve(socket())
  }
  return { provider, socket, connect }
}

const text = (doc: Y.Doc) => doc.getXmlFragment('body').toString()

function typeInto(doc: Y.Doc, words: string) {
  const body = doc.getXmlFragment('body')
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(words)])
  body.insert(body.length, [paragraph])
}

beforeEach(() => {
  FakeSocket.all = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the live connection of a note', () => {
  it('NOTES-12 AC-8 changes wait while the connection is away, are counted, and are saved once it is back', async () => {
    const room = new Room()
    const { provider, socket, connect } = make(room)
    connect()
    expect(provider.status).toBe('online')
    expect(provider.pending).toBe(0)

    // Online: a change is sent and confirmed by the room's answer to the next step 1.
    typeInto(provider.doc, 'online')
    expect(provider.pending).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    room.serve(socket())
    expect(provider.pending).toBe(0)
    expect(text(room.doc)).toContain('online')

    // The connection breaks: the bar's state, changes counted as waiting.
    socket().serverClose(1006)
    expect(provider.status).toBe('offline')
    typeInto(provider.doc, 'tunnel one')
    typeInto(provider.doc, 'tunnel two')
    expect(provider.pending).toBe(2)
    expect(text(room.doc)).not.toContain('tunnel')

    // Back: everything arrives once, the count goes to nought.
    await vi.advanceTimersByTimeAsync(400)
    connect()
    expect(provider.status).toBe('online')
    expect(provider.pending).toBe(0)
    expect(text(room.doc).match(/tunnel one/g)).toHaveLength(1)
    expect(text(room.doc).match(/tunnel two/g)).toHaveLength(1)
    provider.destroy()
  })

  it('NOTES-12 EC-3 a connection that breaks again and again loses nothing and doubles nothing', async () => {
    const room = new Room()
    const { provider, socket, connect } = make(room)
    connect()
    for (let round = 0; round < 6; round++) {
      typeInto(provider.doc, `word${round}`)
      if (round % 2) socket().serverClose(1006)
      await vi.advanceTimersByTimeAsync(6000)
      if (socket().readyState !== 1) connect()
      else room.serve(socket())
    }
    await vi.advanceTimersByTimeAsync(50)
    room.serve(socket())
    for (let round = 0; round < 6; round++) expect(text(room.doc).match(new RegExp(`word${round}<`, 'g'))).toHaveLength(1)
    expect(text(room.doc)).toBe(text(provider.doc))
    expect(provider.pending).toBe(0)
    provider.destroy()
  })

  it('NOTES-12 EC-7 a restarting server and a changed right reconnect by themselves', async () => {
    const room = new Room()
    const { provider, socket, connect } = make(room)
    connect()
    const before = FakeSocket.all.length
    socket().serverClose(CLOSE_RIGHTS)
    // Write became read or back: at once, without waiting.
    expect(FakeSocket.all.length).toBe(before + 1)
    connect()
    socket().serverClose(CLOSE_RESTART)
    expect(provider.status).toBe('offline')
    await vi.advanceTimersByTimeAsync(400)
    expect(FakeSocket.all.length).toBe(before + 2)
    connect()
    expect(provider.status).toBe('online')
    provider.destroy()
  })

  it('NOTES-12 EC-2 EC-5 a deleted note or a right taken stops, and says so; signing in again tries once more', async () => {
    const room = new Room()
    const { provider, socket, connect } = make(room)
    connect()
    socket().serverClose(CLOSE_GONE)
    expect(provider.status).toBe('gone')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(1)
    provider.retryNow()
    connect()
    socket().serverClose(CLOSE_FORBIDDEN)
    expect(provider.status).toBe('forbidden')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.all).toHaveLength(2)
    window.dispatchEvent(new Event(SIGNED_IN_AGAIN_EVENT))
    expect(FakeSocket.all).toHaveLength(3)
    provider.destroy()
  })

  it('NOTES-12 AC-8 the browser saying it is online again reconnects at once', async () => {
    const room = new Room()
    const { provider, socket, connect } = make(room)
    connect()
    window.dispatchEvent(new Event('offline'))
    expect(provider.status).toBe('offline')
    const count = FakeSocket.all.length
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.all.length).toBe(count + 1)
    connect()
    expect(socket().url).toMatch(/\/api\/notes\/note\/live$/)
    expect(provider.status).toBe('online')
    provider.destroy()
  })

  it('NOTES-12 AC-8 a connection that never answers counts as broken', async () => {
    const room = new Room()
    const provider = new NoteProvider('note', new Y.Doc(), { socket: (url) => new FakeSocket(url) as never, confirmDelay: 10, answerTimeout: 500 })
    provider.connect()
    const socket = FakeSocket.all[0]
    socket.open()
    room.greet(socket)
    room.serve(socket)
    typeInto(provider.doc, 'lost')
    await vi.advanceTimersByTimeAsync(20)
    // The room never answers this step 1 (a sleeping laptop).
    await vi.advanceTimersByTimeAsync(600)
    expect(provider.status).toBe('offline')
    expect(provider.pending).toBe(1)
    provider.destroy()
  })
})
