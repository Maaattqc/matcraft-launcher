import { useReducer } from 'react'

export type LaunchPhase =
  | 'idle'
  | 'launching'
  | 'downloading'
  | 'extracting'
  | 'patching'
  | 'loading_mods'
  | 'running'
  | 'error'

export interface LaunchState {
  phase: LaunchPhase
  progress: number
  speed: string
  eta: number
  statusText: string
  consoleLogs: string[]
  error: string | null
}

type LaunchAction =
  | { type: 'START' }
  | { type: 'PROGRESS'; progress: number; size: number; element: string }
  | { type: 'SPEED'; speed: string }
  | { type: 'ESTIMATED'; seconds: number }
  | { type: 'EXTRACT'; fileName: string }
  | { type: 'PATCH'; patchName: string }
  | { type: 'DATA'; line: string }
  | { type: 'RUNNING' }
  | { type: 'MODS_LOADED' }
  | { type: 'CLOSE' }
  | { type: 'ERROR'; error: string }
  | { type: 'RESET' }

const MAX_CONSOLE_LINES = 500

const initialState: LaunchState = {
  phase: 'idle',
  progress: 0,
  speed: '',
  eta: 0,
  statusText: '',
  consoleLogs: [],
  error: null,
}

function reducer(state: LaunchState, action: LaunchAction): LaunchState {
  switch (action.type) {
    case 'START':
      return { ...initialState, phase: 'launching', statusText: 'Lancement en cours...' }

    case 'PROGRESS':
      return {
        ...state,
        phase: 'downloading',
        progress: action.progress,
        statusText: `Téléchargement : ${action.element} (${Math.round(action.progress)}%)`,
      }

    case 'SPEED':
      return { ...state, speed: action.speed }

    case 'ESTIMATED':
      return { ...state, eta: action.seconds }

    case 'EXTRACT':
      return {
        ...state,
        phase: 'extracting',
        statusText: `Extraction : ${action.fileName}`,
      }

    case 'PATCH':
      return {
        ...state,
        phase: 'patching',
        statusText: `Patch : ${action.patchName}`,
      }

    case 'DATA': {
      const logs = state.consoleLogs.length >= MAX_CONSOLE_LINES
        ? [...state.consoleLogs.slice(-MAX_CONSOLE_LINES + 1), action.line]
        : [...state.consoleLogs, action.line]
      const windowCreated = action.line.includes('Render thread')

      let nextPhase = state.phase
      let nextStatus = state.statusText
      let nextProgress = state.progress

      if (windowCreated && state.phase !== 'running' && state.phase !== 'loading_mods') {
        nextPhase = 'loading_mods'
        nextStatus = 'Chargement des mods...'
        nextProgress = 100
      }

      return {
        ...state,
        phase: nextPhase,
        statusText: nextStatus,
        progress: nextProgress,
        consoleLogs: logs,
      }
    }

    case 'RUNNING':
      return { ...state, phase: 'running', statusText: 'Jeu en cours...', progress: 100 }

    case 'MODS_LOADED':
      if (state.phase === 'loading_mods') {
        return { ...state, phase: 'running', statusText: 'Jeu en cours...', progress: 100 }
      }
      return state

    case 'CLOSE':
      return { ...initialState }

    case 'ERROR':
      return { ...state, phase: 'error', error: action.error, statusText: `Erreur : ${action.error}` }

    case 'RESET':
      return { ...initialState }

    default:
      return state
  }
}

export function useLaunchState() {
  return useReducer(reducer, initialState)
}
