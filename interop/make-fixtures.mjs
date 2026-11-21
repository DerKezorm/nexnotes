// Writes the interop fixtures for the backend tests (backend/tests/notedoc/fixtures):
//
//   <case>.bin   the note as the browser writes it: a Yjs update with body (via y-prosemirror), title and meta
//   <case>.json  the ProseMirror JSON the browser reads back from it
//   schema.json  nodes and marks of the schema with the defaults of their attributes
//
// Every case is checked against the schema first, and written by y-prosemirror and by @tiptap/y-tiptap (the binding
// Tiptap's collaboration extension uses); both must read back the same document.
//
// Run: npm install && npm run fixtures

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Node } from '@tiptap/pm/model'
import * as Y from 'yjs'
import * as yProsemirror from 'y-prosemirror'
import * as yTiptap from '@tiptap/y-tiptap'
import { CASES, titleOf } from './cases.mjs'
import { noteSchema } from './schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'backend', 'tests', 'notedoc', 'fixtures')
mkdirSync(out, { recursive: true })

const schema = noteSchema()

function defaults(attrs) {
  return Object.fromEntries(Object.entries(attrs).map(([key, spec]) => [key, spec.hasDefault ? spec.default : null]))
}

const described = {
  nodes: Object.fromEntries(
    Object.entries(schema.nodes).map(([name, type]) => [
      name,
      { attrs: defaults(type.attrs), content: type.spec.content ?? '', group: type.spec.group ?? '' },
    ]),
  ),
  marks: Object.fromEntries(
    Object.entries(schema.marks).map(([name, type]) => [
      name,
      { attrs: defaults(type.attrs), excludes: type.spec.excludes ?? null, rank: type.rank },
    ]),
  ),
}
writeFileSync(join(out, 'schema.json'), JSON.stringify(described, null, 2) + '\n')

function build(binding, json, title) {
  const node = Node.fromJSON(schema, json)
  node.check()
  const ydoc = new Y.Doc()
  ydoc.clientID = 4242
  ydoc.transact(() => {
    ydoc.getMap('meta').set('format', 1)
    ydoc.getText('title').insert(0, title)
    binding.prosemirrorToYXmlFragment(node, ydoc.getXmlFragment('body'))
  })
  return ydoc
}

function readBack(binding, update) {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, update)
  const node = binding.yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('body'), schema)
  node.check()
  return node.toJSON()
}

for (const [name, json] of Object.entries(CASES)) {
  const title = titleOf(name)
  const update = Y.encodeStateAsUpdate(build(yProsemirror, json, title))
  const other = Y.encodeStateAsUpdate(build(yTiptap, json, title))
  const read = readBack(yProsemirror, update)
  const same = JSON.stringify(readBack(yTiptap, update)) === JSON.stringify(read)
    && JSON.stringify(readBack(yProsemirror, other)) === JSON.stringify(read)
  if (!same) throw new Error(`${name}: y-prosemirror and y-tiptap read differently`)
  writeFileSync(join(out, `${name}.bin`), update)
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ title, doc: read }, null, 2) + '\n')
  console.log(`${name}: ${update.length} bytes`)
}
