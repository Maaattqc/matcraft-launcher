import '@testing-library/jest-dom/vitest'

// Mock window.launcher (exposed by preload.js via contextBridge)
Object.defineProperty(window, 'launcher', {
  value: {
    login: vi.fn().mockResolvedValue({ success: true, user: { username: 'Test', uuid: '1234' } }),
    launch: vi.fn().mockResolvedValue({ success: true }),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    resizeToLauncher: vi.fn(),
    onProgress: vi.fn(),
    onSpeed: vi.fn(),
    onEstimated: vi.fn(),
    onExtract: vi.fn(),
    onPatch: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onUpdaterChecking: vi.fn(),
    onUpdaterAvailable: vi.fn(),
    onUpdaterNotAvailable: vi.fn(),
    onUpdaterProgress: vi.fn(),
    onUpdaterDownloaded: vi.fn(),
    onUpdaterError: vi.fn(),
  },
  writable: true,
})
