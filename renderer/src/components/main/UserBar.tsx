import { LogOut, User } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface UserBarProps {
  username: string
  onLogout: () => void
}

export function UserBar({ username, onLogout }: UserBarProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-emerald-500" />
        <span className="text-sm text-zinc-300">
          Bienvenue, <span className="font-semibold text-zinc-100">{username}</span>
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={onLogout} className="text-zinc-400 hover:text-zinc-100">
        <LogOut className="h-3.5 w-3.5 mr-1.5" />
        Déconnexion
      </Button>
    </div>
  )
}
