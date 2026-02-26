import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ConsolePanelProps {
  logs: string[]
  open: boolean
  onToggle: () => void
}

export function ConsolePanel({ logs, open, onToggle }: ConsolePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs.length, open])

  return (
    <div className="border-t border-zinc-800/50">
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="w-full flex items-center justify-center gap-2 h-7 text-xs text-zinc-500 hover:text-zinc-300 rounded-none"
      >
        <Terminal className="h-3 w-3" />
        Console
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 160 }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ScrollArea className="h-[160px] bg-zinc-950/50 border-t border-zinc-800/30">
              <div className="p-2 font-mono text-[11px] leading-relaxed text-zinc-500 select-text">
                {logs.length === 0 ? (
                  <span className="text-zinc-600 italic">En attente de sortie...</span>
                ) : (
                  logs.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                  ))
                )}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
