import { motion } from 'framer-motion'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface InfoCardProps {
  title: string
  description: string
  icon: LucideIcon
  color: string
  href?: string
  index: number
}

export function InfoCard({ title, description, icon: Icon, color, href, index }: InfoCardProps) {
  const content = (
    <Card className={cn(
      "group cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg border-zinc-800/50",
      "bg-zinc-900/80 hover:bg-zinc-900"
    )}>
      <CardContent className="p-4 flex items-start gap-3">
        <div className={cn("rounded-lg p-2 shrink-0", color)}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-100">{title}</p>
          <p className="text-xs text-zinc-400 mt-0.5 truncate">{description}</p>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05 }}
    >
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="block">
          {content}
        </a>
      ) : (
        content
      )}
    </motion.div>
  )
}
