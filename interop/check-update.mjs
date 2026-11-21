// Reads Yjs updates written by the server (pycrdt) the way the browser does and checks them against the schema.
//
//   node check-update.mjs <update.bin> [<more.bin> ...]
//
// The updates are applied in order to one document. Prints {"title": ..., "doc": <ProseMirror JSON>, "format": ...}
// and exits with 0; exits with 1 when the body is not a valid document of the schema (or y-prosemirror had to drop a
// node it could not read, which loses its content in the browser).

import { readFileSync } from 'node:fs'
import { Node } from '@tiptap/pm/model'
import * as Y from 'yjs'
import * as yProsemirror from 'y-prosemirror'
import * as yTiptap from '@tiptap/y-tiptap'
import { noteSchema } from './schema.mjs'

const schema = noteSchema()
const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node check-update.mjs <update.bin> [...]')
  process.exit(2)
}

function countElements(fragment) {
  let count = 0
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) count += 1 + countElements(child)
  }
  return count
}

function countNodes(node) {
  let count = 0
  node.forEach((child) => {
    if (!child.isText) count += 1 + countNodes(child)
  })
  return count
}

try {
  const results = []
  for (const binding of [yProsemirror, yTiptap]) {
    const ydoc = new Y.Doc()
    for (const file of files) Y.applyUpdate(ydoc, readFileSync(file))
    const body = ydoc.getXmlFragment('body')
    const elements = countElements(body)
    const node = binding.yXmlFragmentToProseMirrorRootNode(body, schema)
    node.check()
    // Throws when the JSON is not a document of the schema either.
    Node.fromJSON(schema, node.toJSON()).check()
    if (countNodes(node) !== elements) {
      throw new Error(`the browser dropped ${elements - countNodes(node)} node(s) it could not read`)
    }
    results.push({
      title: ydoc.getText('title').toString(),
      format: ydoc.getMap('meta').get('format') ?? null,
      doc: node.toJSON(),
    })
  }
  if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) {
    throw new Error('y-prosemirror and y-tiptap read differently')
  }
  process.stdout.write(JSON.stringify(results[0]))
} catch (error) {
  console.error(String(error?.message ?? error))
  process.exit(1)
}
