import { describe, it, expect } from 'vitest'
import { reducer, initialState } from '../useLaunchState'

describe('useLaunchState reducer', () => {
  it('START → phase=launching, statusText set', () => {
    const state = reducer(initialState, { type: 'START' })
    expect(state.phase).toBe('launching')
    expect(state.statusText).toBe('Lancement en cours...')
  })

  it('PROGRESS → phase=downloading, progress/statusText updated', () => {
    const state = reducer(initialState, {
      type: 'PROGRESS',
      progress: 42,
      size: 100,
      element: 'fabric.jar',
    })
    expect(state.phase).toBe('downloading')
    expect(state.progress).toBe(42)
    expect(state.statusText).toContain('fabric.jar')
    expect(state.statusText).toContain('42%')
  })

  it('SPEED → speed updated, other state unchanged', () => {
    const prev = { ...initialState, phase: 'downloading' as const }
    const state = reducer(prev, { type: 'SPEED', speed: '2.5 MB/s' })
    expect(state.speed).toBe('2.5 MB/s')
    expect(state.phase).toBe('downloading')
  })

  it('ESTIMATED → eta updated', () => {
    const state = reducer(initialState, { type: 'ESTIMATED', seconds: 30 })
    expect(state.eta).toBe(30)
  })

  it('EXTRACT → phase=extracting, statusText shows fileName', () => {
    const state = reducer(initialState, { type: 'EXTRACT', fileName: 'natives.jar' })
    expect(state.phase).toBe('extracting')
    expect(state.statusText).toContain('natives.jar')
  })

  it('PATCH → phase=patching, statusText shows patchName', () => {
    const state = reducer(initialState, { type: 'PATCH', patchName: 'fix-1' })
    expect(state.phase).toBe('patching')
    expect(state.statusText).toContain('fix-1')
  })

  it('DATA → appends to consoleLogs', () => {
    const state = reducer(initialState, { type: 'DATA', line: 'hello' })
    expect(state.consoleLogs).toContain('hello')
  })

  it('DATA → caps at 500 lines', () => {
    const prev = {
      ...initialState,
      consoleLogs: Array.from({ length: 500 }, (_, i) => `line-${i}`),
    }
    const state = reducer(prev, { type: 'DATA', line: 'new-line' })
    expect(state.consoleLogs).toHaveLength(500)
    expect(state.consoleLogs[state.consoleLogs.length - 1]).toBe('new-line')
    expect(state.consoleLogs).not.toContain('line-0')
  })

  it('DATA with "Render thread" → transitions to loading_mods phase', () => {
    const prev = { ...initialState, phase: 'downloading' as const }
    const state = reducer(prev, { type: 'DATA', line: '[Render thread] Window created' })
    expect(state.phase).toBe('loading_mods')
    expect(state.statusText).toBe('Chargement des mods...')
    expect(state.progress).toBe(100)
  })

  it('DATA with "Render thread" when already running → no phase change', () => {
    const prev = { ...initialState, phase: 'running' as const, statusText: 'Jeu en cours...' }
    const state = reducer(prev, { type: 'DATA', line: '[Render thread] some log' })
    expect(state.phase).toBe('running')
  })

  it('RUNNING → phase=running, progress=100', () => {
    const state = reducer(initialState, { type: 'RUNNING' })
    expect(state.phase).toBe('running')
    expect(state.progress).toBe(100)
    expect(state.statusText).toBe('Jeu en cours...')
  })

  it('MODS_LOADED when loading_mods → transitions to running', () => {
    const prev = { ...initialState, phase: 'loading_mods' as const }
    const state = reducer(prev, { type: 'MODS_LOADED' })
    expect(state.phase).toBe('running')
  })

  it('MODS_LOADED when NOT loading_mods → no change', () => {
    const prev = { ...initialState, phase: 'downloading' as const }
    const state = reducer(prev, { type: 'MODS_LOADED' })
    expect(state.phase).toBe('downloading')
  })

  it('CLOSE → resets to initialState', () => {
    const prev = { ...initialState, phase: 'running' as const, progress: 100 }
    const state = reducer(prev, { type: 'CLOSE' })
    expect(state).toEqual(initialState)
  })

  it('ERROR → phase=error, error message set', () => {
    const state = reducer(initialState, { type: 'ERROR', error: 'crash' })
    expect(state.phase).toBe('error')
    expect(state.error).toBe('crash')
    expect(state.statusText).toContain('crash')
  })

  it('RESET → resets to initialState', () => {
    const prev = { ...initialState, phase: 'error' as const, error: 'oops' }
    const state = reducer(prev, { type: 'RESET' })
    expect(state).toEqual(initialState)
  })
})
