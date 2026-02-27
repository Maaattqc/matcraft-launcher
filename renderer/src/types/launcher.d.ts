export interface LauncherUser {
  username: string
  uuid: string
}

export interface LoginResult {
  success: boolean
  user?: LauncherUser
  error?: string
}

export interface LaunchResult {
  success: boolean
  error?: string
}

export interface LaunchConfig {
  username: string
  uuid: string
  accessToken: string
  minRam: string
  maxRam: string
}

export interface SyncProgressData {
  phase: 'checking' | 'downloading' | 'deleting' | 'done'
  current: number
  total: number
  modName: string | null
}

export interface LauncherAPI {
  login(email: string, password: string): Promise<LoginResult>
  launchGame(config: LaunchConfig): Promise<LaunchResult>
  repair(): Promise<{ success: boolean; error?: string }>

  onUpdaterChecking(cb: () => void): () => void
  onUpdaterUpdateAvailable(cb: (version: string) => void): () => void
  onUpdaterProgress(cb: (percent: number) => void): () => void
  onUpdaterDownloaded(cb: () => void): () => void
  onUpdaterNotAvailable(cb: () => void): () => void
  onUpdaterError(cb: (message: string) => void): () => void

  onProgress(cb: (progress: number, size: number, element: string) => void): () => void
  onSpeed(cb: (speed: string) => void): () => void
  onEstimated(cb: (seconds: number) => void): () => void
  onExtract(cb: (fileName: string) => void): () => void
  onPatch(cb: (patchName: string) => void): () => void
  onData(cb: (line: string) => void): () => void
  onClose(cb: () => void): () => void
  onError(cb: (err: string) => void): () => void
  onSyncProgress(cb: (data: SyncProgressData) => void): () => void

  minimize(): void
  maximize(): void
  close(): void
  resizeToLauncher(): void
}

declare global {
  interface Window {
    launcher: LauncherAPI
  }
}
