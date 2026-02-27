import { describe, it, expect } from 'vitest'
import { formatEta } from '../ProgressPanel'

describe('formatEta()', () => {
  it('returns empty string for 0', () => {
    expect(formatEta(0)).toBe('')
  })

  it('returns empty string for negative values', () => {
    expect(formatEta(-5)).toBe('')
  })

  it('formats seconds only', () => {
    expect(formatEta(45)).toBe('45s restantes')
  })

  it('formats minutes and seconds', () => {
    expect(formatEta(125)).toBe('2m 5s restantes')
  })

  it('formats exactly 1 minute', () => {
    expect(formatEta(60)).toBe('1m 0s restantes')
  })
})
