import { describe, expect, it } from 'vitest'
import { keyLabel } from './shortcuts'

describe('keyLabel', () => {
  it('names the keys the ? sheet lists', () => {
    expect(keyLabel('a')).toEqual(['A'])
    expect(keyLabel('mod+k')).toEqual(['Ctrl', 'K'])
    expect(keyLabel('shift+n')).toEqual(['Shift', 'N'])
    expect(keyLabel('esc')).toEqual(['Esc'])
    expect(keyLabel('enter')).toEqual(['Enter'])
    expect(['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].map((k) => keyLabel(k)[0])).toEqual(['←', '→', '↑', '↓'])
  })
})
