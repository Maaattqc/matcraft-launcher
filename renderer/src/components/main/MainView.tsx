import { useState, useEffect, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import { ExternalLink } from 'lucide-react'
import { useLaunchState } from '@/hooks/useLaunchState'
import { PlayButton } from './PlayButton'
import { ProgressPanel } from './ProgressPanel'
import { ConsolePanel } from './ConsolePanel'
import { NewsCard } from './NewsCard'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface MainViewProps {
  user: { username: string; uuid: string }
  maxRam: string
  onLogout: () => void
}

export function MainView({ user, maxRam, onLogout }: MainViewProps) {
  const [state, dispatch] = useLaunchState()
  const [consoleOpen, setConsoleOpen] = useState(false)

  useEffect(() => {
    const cleanups = [
      window.launcher.onProgress((progress, size, element) =>
        dispatch({ type: 'PROGRESS', progress, size, element })
      ),
      window.launcher.onSpeed((speed) => dispatch({ type: 'SPEED', speed })),
      window.launcher.onEstimated((seconds) => dispatch({ type: 'ESTIMATED', seconds })),
      window.launcher.onExtract((fileName) => dispatch({ type: 'EXTRACT', fileName })),
      window.launcher.onPatch((patchName) => dispatch({ type: 'PATCH', patchName })),
      window.launcher.onData((line) => dispatch({ type: 'DATA', line })),
      window.launcher.onClose(() => dispatch({ type: 'CLOSE' })),
      window.launcher.onError((err) => dispatch({ type: 'ERROR', error: err })),
      window.launcher.onSyncProgress((data) =>
        dispatch({ type: 'SYNC_PROGRESS', phase: data.phase, current: data.current, total: data.total, modName: data.modName })
      ),
    ]

    return () => cleanups.forEach(fn => fn?.())
  }, [dispatch])

  // Debounce: quand les logs s'arretent pendant 10s en loading_mods, le jeu est pret
  const modsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (state.phase !== 'loading_mods') {
      if (modsTimeoutRef.current) {
        clearTimeout(modsTimeoutRef.current)
        modsTimeoutRef.current = null
      }
      return
    }

    if (modsTimeoutRef.current) clearTimeout(modsTimeoutRef.current)
    modsTimeoutRef.current = setTimeout(() => {
      dispatch({ type: 'MODS_LOADED' })
    }, 5_000)

    return () => {
      if (modsTimeoutRef.current) clearTimeout(modsTimeoutRef.current)
    }
  }, [state.phase, state.consoleLogs, dispatch])

  const handlePlay = useCallback(async () => {
    if (state.phase === 'error') {
      dispatch({ type: 'RESET' })
      return
    }
    if (state.phase !== 'idle') return

    dispatch({ type: 'START' })

    const result = await window.launcher.launchGame({
      username: user.username,
      uuid: user.uuid,
      accessToken: '',
      minRam: '2G',
      maxRam,
    })

    if (!result.success) {
      dispatch({ type: 'ERROR', error: result.error || 'Erreur inconnue' })
    }
  }, [state.phase, user, maxRam, dispatch])

  const showProgress = state.phase === 'syncing_mods' || state.phase === 'downloading' || state.phase === 'extracting' || state.phase === 'patching'

  return (
    <motion.div
      key="main"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3 }}
      className="h-full flex flex-col justify-end"
    >
      {/* Bottom content area */}
      <div className="p-6 pb-4 flex items-end gap-6">
        {/* Left side - Server info + Launch */}
        <div className="flex-1 min-w-0">
          {/* Status badges */}
          <div className="flex items-center gap-3 mb-2">
            <div className="flex items-center gap-1.5 bg-black/50 backdrop-blur-sm rounded-full px-3 py-1">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-status-pulse" />
              <span className="text-xs text-blue-400 font-medium">En ligne</span>
            </div>
            <a
              href="https://matfaction.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-white hover:text-white/80 transition-colors"
            >
              Notes de mise a jour
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* Server title */}
          <img src="./logo.png" alt="MatCraft" className="h-14 mb-3" />

          {/* Version selector */}
          <div className="flex items-center gap-3 mb-3">
            <Select defaultValue="stable">
              <SelectTrigger className="w-[280px] h-9 text-sm bg-black/50 border-white/10 text-white backdrop-blur-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stable">Stable</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Launch button */}
          <PlayButton phase={state.phase} onClick={handlePlay} />

          {/* Progress */}
          <ProgressPanel
            visible={showProgress}
            progress={state.progress}
            speed={state.speed}
            eta={state.eta}
            statusText={state.statusText}
          />

          {/* Version */}
          <p className="text-[11px] text-white/30 mt-2">Version {__APP_VERSION__}</p>
        </div>

        {/* Right side - News card */}
        <div className="w-[260px] shrink-0">
          <NewsCard />
        </div>
      </div>

      {/* Console */}
      <ConsolePanel
        logs={state.consoleLogs}
        open={consoleOpen}
        onToggle={() => setConsoleOpen(prev => !prev)}
      />
    </motion.div>
  )
}
