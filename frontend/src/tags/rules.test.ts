/**
 * NOTES-5: the rule of a tag in the browser reads the same cases as the server's (`backend/tests/test_notes5.py`), so
 * that the editor paints exactly what the server lists.
 */
import cases from './cases.json'
import { cleanName, findTags, keyOf, tagHref, typedTag } from './rules'

describe('the rule of a tag', () => {
  it.each(cases.cases.map((one) => [one.id, one] as const))('NOTES-5 AC-1 EC-1 EC-2 EC-3 reads the shared case "%s" like the server', (_id, one) => {
    expect(findTags(one.text).map((tag) => tag.label)).toEqual(one.tags)
  })

  it('NOTES-5 AC-1 gives the places in the text as the editor counts them', () => {
    const text = 'Ä 🏖 #bad und #küche.'
    const found = findTags(text)
    expect(found.map((tag) => text.slice(tag.start, tag.end))).toEqual(['#bad', '#küche'])
  })

  it('NOTES-5 EC-2 one tag whatever the case', () => {
    expect(keyOf('Einkauf')).toBe(keyOf('EINKAUF'))
    expect(keyOf('Einkauf')).toBe('einkauf')
    expect(keyOf('Käse')).toBe(keyOf('käse'))
  })

  it('NOTES-5 AC-4 a new name is a tag, with or without #', () => {
    expect(cleanName('#einkaufen')).toBe('einkaufen')
    expect(cleanName(' Gemüse-Garten ')).toBe('Gemüse-Garten')
    for (const bad of ['', '#', 'two words', '123', 'bad.', 'a'.repeat(65)]) expect(cleanName(bad)).toBe('')
    expect(tagHref('küche')).toBe('/tags/k%C3%BCche')
  })

  it('NOTES-5 AC-1 knows the tag being typed before the caret', () => {
    expect(typedTag('Milk #ein')).toEqual({ start: 5, prefix: 'ein' })
    expect(typedTag('Milk #')).toEqual({ start: 5, prefix: '' })
    expect(typedTag('Milk #ein kauf')).toBeNull()
    expect(typedTag('example.com/#ein')).toBeNull()
    expect(typedTag('no tag')).toBeNull()
  })
})
