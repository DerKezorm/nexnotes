/**
 * The note schema of the editor is `interop/schema.mjs`, taken over unchanged: the server and the iOS app read what the
 * interop test checks against exactly this file. The editor adds only views and helpers on top.
 */
import { getSchema } from '@tiptap/core'

import { schemaExtensions } from './extensions'
import { noteSchema } from './schema.mjs'

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

describe('the note schema', () => {
  it('NOTES-12 is interop/schema.mjs, byte for byte', () => {
    const mine = files.readFileSync('src/editor/schema.mjs', 'utf-8').replace(/\r\n/g, '\n')
    const shared = files.readFileSync('../interop/schema.mjs', 'utf-8').replace(/\r\n/g, '\n')
    expect(mine).toBe(shared)
  })

  it('NOTES-12 the editor adds nothing to it: the same nodes, marks and attributes', () => {
    const plain = noteSchema()
    const editor = getSchema(schemaExtensions())
    const shape = (schema: typeof plain) => ({
      nodes: Object.fromEntries(Object.entries(schema.nodes).map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()])),
      marks: Object.fromEntries(Object.entries(schema.marks).map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()])),
    })
    expect(shape(editor)).toEqual(shape(plain))
  })
})
