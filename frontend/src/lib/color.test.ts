/** NOTES-4 AC-10: an own color reads on light and dark, and the check mark on it too. */
import { BACKGROUNDS, contrast, hexOf, inkOn, readableColor } from './color'

describe('NOTES-4 AC-10 own colors', () => {
  it('NOTES-4 AC-10 take exactly #rrggbb, in either case, nothing else', () => {
    expect(hexOf('#1E3A8A')).toBe('#1e3a8a')
    expect(hexOf('1e3a8a')).toBe('#1e3a8a')
    for (const wrong of ['#fff', 'red', '#12345g', '#1234567', '', 'rgb(1,2,3)']) expect(hexOf(wrong)).toBeNull()
  })

  it('NOTES-4 AC-10 are drawn to stand out 3:1 from every background, light and dark, keeping those that do', () => {
    for (const hex of ['#000000', '#0a0a40', '#1e3a8a', '#ffffff', '#fffbe0', '#e0ffe0', '#c81e1e', '#3a84d0']) {
      const shown = readableColor(hex)
      for (const background of BACKGROUNDS) expect(contrast(shown, background), `${hex} → ${shown} on ${background}`).toBeGreaterThanOrEqual(3)
    }
    // Already readable everywhere: left as it is.
    expect(readableColor('#c81e1e')).toBe('#c81e1e')
    // A very dark blue gets lighter, a pale yellow darker; both stay blue and yellow.
    const blue = readableColor('#0a0a40')
    expect(parseInt(blue.slice(5, 7), 16)).toBeGreaterThan(parseInt(blue.slice(1, 3), 16))
    const yellow = readableColor('#fffbe0')
    expect(parseInt(yellow.slice(5, 7), 16)).toBeLessThan(parseInt(yellow.slice(1, 3), 16))
  })

  it('NOTES-4 AC-10 the check mark on a color is black or white, whichever reads', () => {
    expect(inkOn('#ffffff')).toBe('#000000')
    expect(inkOn('#f2c14e')).toBe('#000000')
    expect(inkOn('#1e3a8a')).toBe('#ffffff')
    for (const hex of ['#f2c14e', '#1e3a8a', '#9a9aa8', '#4ade80']) expect(contrast(inkOn(hex), hex)).toBeGreaterThanOrEqual(4.5)
  })
})
