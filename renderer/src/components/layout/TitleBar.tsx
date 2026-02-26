import { Minus, Square, X } from 'lucide-react'

interface TitleBarProps {
  showMaximize?: boolean
}

export function TitleBar({ showMaximize = false }: TitleBarProps) {
  return (
    <div
      className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end z-50 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          className="h-9 w-11 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          onClick={() => window.launcher.minimize()}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        {showMaximize && (
          <button
            className="h-9 w-11 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            onClick={() => window.launcher.maximize()}
          >
            <Square className="h-3 w-3" />
          </button>
        )}
        <button
          className="h-9 w-11 flex items-center justify-center text-white/50 hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer"
          onClick={() => window.launcher.close()}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
