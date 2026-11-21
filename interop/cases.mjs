// One small note per node type of format "nexnotes-doc 1", as ProseMirror JSON. make-fixtures.mjs turns each into a
// Yjs update for the backend tests.

const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks } : { type: 'text', text })
const p = (...content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })
const doc = (...content) => ({ type: 'doc', content })
const item = (checked, ...content) => ({ type: 'taskItem', attrs: { checked }, content })

export const CASES = {
  paragraph: doc(p(t('Hello, nexnotes. Grüße 😀 مرحبا'))),
  empty: doc(p()),
  heading: doc(
    { type: 'heading', attrs: { level: 1 }, content: [t('One')] },
    { type: 'heading', attrs: { level: 2, collapsed: true }, content: [t('Two, folded')] },
    p(t('under two')),
    { type: 'heading', attrs: { level: 3 }, content: [t('Three')] },
  ),
  marks: doc(
    p(
      t('bold', { type: 'bold' }),
      t(' '),
      t('italic', { type: 'italic' }),
      t(' '),
      t('under', { type: 'underline' }),
      t(' '),
      t('strike', { type: 'strike' }),
      t(' '),
      t('code', { type: 'code' }),
      t(' '),
      t('both', { type: 'bold' }, { type: 'italic' }),
      t(' '),
      t('link', { type: 'link', attrs: { href: 'https://example.com/a?b=c' } }),
      t(' '),
      t('mail', { type: 'link', attrs: { href: 'mailto:someone@example.com' } }),
    ),
  ),
  highlight: doc(
    p(
      t('default', { type: 'highlight' }),
      t(' '),
      t('green', { type: 'highlight', attrs: { color: 'green' } }),
      t(' '),
      t('rose', { type: 'highlight', attrs: { color: 'rose' } }),
    ),
  ),
  hardBreak: doc(p(t('line one'), { type: 'hardBreak' }, t('line two'))),
  bulletList: doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [p(t('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a1'))] }] }] },
      { type: 'listItem', content: [p(t('b'))] },
    ],
  }),
  orderedList: doc({
    type: 'orderedList',
    attrs: { start: 4 },
    content: [{ type: 'listItem', content: [p(t('four'))] }, { type: 'listItem', content: [p(t('five'))] }],
  }),
  taskList: doc({
    type: 'taskList',
    attrs: { doneToBottom: true },
    content: [
      item(true, p(t('milk'))),
      item(false, p(t('eggs')), { type: 'taskList', content: [item(false, p(t('brown')))] }),
      item(false, p(t('bread'))),
    ],
  }),
  table: doc({
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Name'))] }, { type: 'tableHeader', content: [p(t('Qty'))] }] },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [p(t('Apples'))] },
          { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [120], align: 'right' }, content: [p(t('3'))] },
        ],
      },
    ],
  }),
  blockquote: doc({ type: 'blockquote', content: [p(t('quoted')), p(t('twice'))] }),
  codeBlock: doc({ type: 'codeBlock', attrs: { language: 'python' }, content: [t("print('hi')\nx = 1")] }),
  horizontalRule: doc(p(t('above')), { type: 'horizontalRule' }, p(t('below'))),
  // Attachments (NOTES-10): blocks without content that name the attachment by its id.
  image: doc(
    p(t('Foto vom Platz:')),
    { type: 'image', attrs: { id: 'Zx3_aB9-cD4eF5gH6iJ7kL', size: 'small', name: 'Wohnzimmer.heic' } },
    { type: 'image', attrs: { id: 'Mn0pQ1rS2tU3vW4xY5zA6b' } },
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [p(t('im Punkt')), { type: 'image', attrs: { id: 'Cc7dD8eE9fF0gG1hH2iI3j', size: 'full', name: 'Plan.png' } }] }],
    },
  ),
  attachment: doc(
    { type: 'attachment', attrs: { id: 'Pp4qQ5rR6sS7tT8uU9vV0w', name: 'Datenblatt Sofa.pdf' } },
    p(t('dazwischen')),
    { type: 'attachment', attrs: { id: 'Xx1yY2zZ3aA4bB5cC6dD7e', name: 'Grundriss.dwg' } },
  ),
  linkPreview: doc(
    {
      type: 'linkPreview',
      attrs: {
        href: 'https://moebel-beispiel.example.com/ecksofa?farbe=grau',
        title: 'Ecksofa Beispiel, 3-Sitzer',
        description: 'Maße, Bezüge und Lieferzeit im Überblick',
        site: 'moebel-beispiel.example.com',
        image: 'Ee8fF9gG0hH1iI2jJ3kK4l',
      },
    },
    { type: 'linkPreview', attrs: { href: 'https://example.org/' } },
  ),
  // Sketches and recordings (NOTES-18): blocks without content that name their attachments.
  drawing: doc(
    p(t('Ablauf:')),
    { type: 'drawing', attrs: { id: 'Sk3tchP1ctur3_0000000a', data: 'Sk3tchD4t4_00000000000a', name: 'Skizze.png' } },
    { type: 'drawing', attrs: { id: 'Sk3tchP1ctur3_0000000b' } },
  ),
  recording: doc(
    { type: 'recording', attrs: { id: 'R3c0rd1ngS0und_000000a', name: 'Besprechung Montag.m4a', duration: 3130000, transcript: 'R3c0rd1ngT3xt_0000000a' } },
    p(t('danach')),
    { type: 'recording', attrs: { id: 'R3c0rd1ngS0und_000000b' } },
  ),
}

export const TITLES = {
  paragraph: 'Grüße 😀',
  empty: '',
}

export function titleOf(name) {
  return TITLES[name] ?? `Case ${name}`
}
