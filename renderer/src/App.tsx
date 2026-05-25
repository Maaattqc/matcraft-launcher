import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { TitleBar } from '@/components/layout/TitleBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { LoginView } from '@/components/login/LoginView'
import { MainView } from '@/components/main/MainView'
import { SettingsView } from '@/components/settings/SettingsView'
import { UpdateScreen } from '@/components/update/UpdateScreen'

interface User {
  username: string
  uuid: string
}

type View = 'home' | 'settings'
type UpdateStatus = 'checking' | 'downloading' | 'downloaded' | 'none' | 'error'

export default function App() {
  const isBypass = (window as any).launcher?.isBypass === true

  const [user, setUser] = useState<User | null>(
    isBypass ? { username: 'DevPlayer', uuid: '00000000-0000-0000-0000-000000000001' } : null
  )
  const [currentView, setCurrentView] = useState<View>('home')
  const [maxRam, setMaxRam] = useState('4G')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(isBypass ? 'none' : 'checking')
  const [updateProgress, setUpdateProgress] = useState(0)

  useEffect(() => {
    if (isBypass) return

    // In dev, the updater never fires — go straight to login
    if (!window.launcher.onUpdaterChecking) {
      setUpdateStatus('none')
      return
    }

    const cleanups = [
      window.launcher.onUpdaterChecking(() => {
        setUpdateStatus('checking')
      }),
      window.launcher.onUpdaterUpdateAvailable(() => {
        setUpdateStatus('downloading')
        setUpdateProgress(0)
      }),
      window.launcher.onUpdaterProgress((percent) => {
        setUpdateProgress(Math.round(percent))
      }),
      window.launcher.onUpdaterDownloaded(() => {
        setUpdateStatus('downloaded')
        setUpdateProgress(100)
      }),
      window.launcher.onUpdaterNotAvailable(() => {
        setUpdateStatus('none')
      }),
      window.launcher.onUpdaterError(() => {
        setUpdateStatus('none')
      }),
    ]

    // Timeout: if no updater event after 3s, skip update screen (dev/no update server)
    const timeout = setTimeout(() => {
      setUpdateStatus(prev => (prev === 'checking' || prev === 'downloading') ? 'none' : prev)
    }, 3000)

    return () => {
      clearTimeout(timeout)
      cleanups.forEach(fn => fn())
    }
  }, [])

  function handleLogin(loggedInUser: User) {
    const root = document.getElementById('root')!
    root.style.transition = 'opacity 150ms'
    root.style.opacity = '0'
    setTimeout(() => {
      window.launcher.resizeToLauncher()
      setUser(loggedInUser)
      setTimeout(() => { root.style.opacity = '1' }, 50)
    }, 150)
  }

  function handleLogout() {
    setCurrentView('home')
    setUser(null)
  }

  // ── Update screen (blocking, before login) ──
  if (updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'downloaded') {
    return <UpdateScreen status={updateStatus} progress={updateProgress} />
  }

  // ── Login page (separate full-screen view, no sidebar) ──
  if (!user) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-black relative">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-30"
          style={{ backgroundImage: 'url(./bg.png)' }}
        />
        <div className="absolute inset-0 bg-black/60" />
        <TitleBar />
        <div className="relative h-full">
          <LoginView onLogin={handleLogin} />
        </div>
      </div>
    )
  }

  // ── Launcher view (sidebar + background + main) ──
  return (
    <div className="h-screen w-screen overflow-hidden bg-black relative">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(./bg.png)' }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-black/10" />

      <TitleBar showMaximize />

      <div className="relative h-full flex">
        <Sidebar user={user} currentView={currentView} onNavigate={setCurrentView} />

        <main className="flex-1 relative overflow-hidden">
          <AnimatePresence mode="wait">
            {currentView === 'home' && (
              <MainView key="main" user={user} maxRam={maxRam} onLogout={handleLogout} />
            )}
            {currentView === 'settings' && (
              <SettingsView key="settings" maxRam={maxRam} setMaxRam={setMaxRam} onLogout={handleLogout} />
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
