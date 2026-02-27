import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { copyMod } from '../lib/copyMod.js'

function createMockFs() {
  return {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
    copyFileSync: vi.fn(),
  }
}

describe('copyMod()', () => {
  let mockFs

  beforeEach(() => {
    mockFs = createMockFs()
  })

  it('creates mods dir if missing', () => {
    mockFs.existsSync.mockImplementation((p) => {
      if (p === path.join('/game', 'mods')) return false
      if (p === '/source') return true
      return false
    })
    mockFs.readdirSync.mockReturnValue([])

    copyMod('/game', ['/source'], mockFs)

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.join('/game', 'mods'), { recursive: true })
  })

  it('copies .jar files from source to destination', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readdirSync.mockReturnValue(['mod-a.jar', 'mod-b.jar'])

    copyMod('/game', ['/source'], mockFs)

    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(2)
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      path.join('/source', 'mod-a.jar'),
      path.join('/game', 'mods', 'mod-a.jar')
    )
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      path.join('/source', 'mod-b.jar'),
      path.join('/game', 'mods', 'mod-b.jar')
    )
  })

  it('skips -sources.jar files', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readdirSync.mockReturnValue(['mod-a.jar', 'mod-a-sources.jar', 'readme.txt'])

    copyMod('/game', ['/source'], mockFs)

    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1)
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      path.join('/source', 'mod-a.jar'),
      path.join('/game', 'mods', 'mod-a.jar')
    )
  })

  it('skips symlinked jar files', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readdirSync.mockReturnValue(['mod-a.jar', 'mod-b.jar'])
    mockFs.lstatSync.mockImplementation((p) => ({
      isSymbolicLink: () => p === path.join('/source', 'mod-b.jar')
    }))

    copyMod('/game', ['/source'], mockFs)

    expect(mockFs.copyFileSync).toHaveBeenCalledTimes(1)
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      path.join('/source', 'mod-a.jar'),
      path.join('/game', 'mods', 'mod-a.jar')
    )
  })

  it('handles missing source directory gracefully', () => {
    mockFs.existsSync.mockImplementation((p) => {
      if (p === path.join('/game', 'mods')) return true
      return false
    })

    expect(() => copyMod('/game', ['/nonexistent'], mockFs)).not.toThrow()
    expect(mockFs.readdirSync).not.toHaveBeenCalled()
    expect(mockFs.copyFileSync).not.toHaveBeenCalled()
  })
})
