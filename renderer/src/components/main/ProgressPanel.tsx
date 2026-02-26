import { motion, AnimatePresence } from 'framer-motion'
import { Progress } from '@/components/ui/progress'

interface ProgressPanelProps {
  visible: boolean
  progress: number
  speed: string
  eta: number
  statusText: string
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m > 0) return `${m}m ${s}s restantes`
  return `${s}s restantes`
}

export function ProgressPanel({ visible, progress, speed, eta, statusText }: ProgressPanelProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="space-y-2 pt-3">
            <Progress value={progress} className="h-2.5" />
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="truncate max-w-[60%]">{statusText}</span>
              <div className="flex items-center gap-3">
                {speed && <span>{speed}</span>}
                {eta > 0 && <span>{formatEta(eta)}</span>}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
