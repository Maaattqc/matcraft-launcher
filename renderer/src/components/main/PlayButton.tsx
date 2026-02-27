import { Loader2, RotateCcw } from 'lucide-react'
import type { LaunchPhase } from '@/hooks/useLaunchState'
import { cn } from '@/lib/utils'

interface PlayButtonProps {
  phase: LaunchPhase
  onClick: () => void
}

const phaseConfig: Record<LaunchPhase, { label: string; icon: React.ReactNode; disabled: boolean }> = {
  idle: { label: 'Lancer', icon: null, disabled: false },
  launching: { label: 'Lancement...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  syncing_mods: { label: 'Vérification des mods...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  downloading: { label: 'Téléchargement...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  extracting: { label: 'Extraction...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  patching: { label: 'Patch...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  loading_mods: { label: 'Chargement des mods...', icon: <Loader2 className="h-5 w-5 animate-spin" />, disabled: true },
  running: { label: 'En jeu', icon: null, disabled: true },
  error: { label: 'Réessayer', icon: <RotateCcw className="h-5 w-5" />, disabled: false },
}

export function PlayButton({ phase, onClick }: PlayButtonProps) {
  const config = phaseConfig[phase]

  return (
    <button
      onClick={onClick}
      disabled={config.disabled}
      className={cn(
        "w-[280px] h-14 rounded-xl font-bold text-lg tracking-wide flex items-center justify-center gap-2.5 transition-all",
        "disabled:cursor-not-allowed cursor-pointer",
        phase === 'running'
          ? "btn-aurora text-white animate-running-pulse"
          : phase === 'error'
            ? "bg-red-500 hover:bg-red-400 text-white"
            : "btn-aurora text-white",
        phase === 'idle' && 'shadow-[0_0_25px_rgba(59,130,246,0.3)]',
        phase !== 'running' && config.disabled && 'opacity-50',
      )}
    >
      {phase === 'running' && <div className="w-2.5 h-2.5 rounded-full bg-green-400 animate-status-pulse" />}
      {config.icon}
      {config.label}
    </button>
  )
}
