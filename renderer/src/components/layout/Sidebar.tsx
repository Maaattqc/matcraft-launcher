import { Home, MessageCircle, Volume2, Settings, User } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarProps {
  user: { username: string; uuid: string } | null
  currentView: 'home' | 'settings'
  onNavigate: (view: 'home' | 'settings') => void
}

export function Sidebar({ user, currentView, onNavigate }: SidebarProps) {
  return (
    <div className="relative z-40 w-[90px] flex flex-col items-center py-5 gap-3 bg-black/60 backdrop-blur-sm border-r border-white/5">
      {/* Logo */}
      <div className="w-14 h-14 rounded-lg flex items-center justify-center mb-5 shrink-0 overflow-hidden">
        <img src="./logoIcon.png" alt="MatCraft" className="w-full h-full object-contain" />
      </div>

      {/* Nav icons */}
      <SidebarIcon icon={Home} label="Accueil" active={currentView === 'home'} onClick={() => onNavigate('home')} />
      <SidebarIcon icon={MessageCircle} label="Discord" href="https://discord.gg/factioncore" />
      <SidebarIcon icon={Volume2} label="Son" />

      <div className="flex-1" />

      {/* User section */}
      {user && (
        <SidebarIcon icon={User} label={user.username} color="text-amber-400" />
      )}
      <SidebarIcon icon={Settings} label="Parametres" active={currentView === 'settings'} onClick={() => onNavigate('settings')} />
    </div>
  )
}

function SidebarIcon({ icon: Icon, label, active, color, href, onClick }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  color?: string
  href?: string
  onClick?: () => void
}) {
  const classes = cn(
    "w-14 h-14 rounded-xl flex items-center justify-center transition-all cursor-pointer group relative",
    active ? "bg-white/15 text-white" : "text-white/40 hover:text-white hover:bg-blue-500/10"
  )

  const inner = (
    <>
      <Icon className={cn("h-6 w-6", color)} />
      {/* Tooltip */}
      <div className="absolute left-full ml-2 px-2 py-1 bg-black/90 rounded text-[11px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
        {label}
      </div>
    </>
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
        {inner}
      </a>
    )
  }

  return (
    <button className={classes} onClick={onClick}>
      {inner}
    </button>
  )
}
