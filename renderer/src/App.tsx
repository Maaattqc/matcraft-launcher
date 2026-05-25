import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { TitleBar } from '@/components/layout/TitleBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { LoginView } from '@/components/login/LoginView'
import { MainView } from '@/components/main/MainView'
import { SettingsView } from '@/components/settings/SettingsView'

interface User {
  username: string
  uuid: string
}

type View = 'home' | 'settings'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [currentView, setCurrentView] = useState<View>('home')
  const [maxRam, setMaxRam] = useState('4G')

  // Auto-login in dev mode (--dev flag)
  useEffect(() => {
    const isBypass = (window as any).launcher?.isBypass === true
    if (isBypass) {
      window.launcher.resizeToLauncher?.()
      setUser({ username: 'DevPlayer', uuid: '00000000-0000-0000-0000-000000000001' })
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

  // ── Login page ──
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

  // ── Launcher view ──
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
