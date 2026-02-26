import type { ReactNode } from 'react'
import { TitleBar } from './TitleBar'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-zinc-950">
      {/* Faint blue radial glow */}
      <div className="fixed inset-0 pointer-events-none"
           style={{
             background: 'radial-gradient(ellipse at 50% 50%, rgba(59, 130, 246, 0.04) 0%, transparent 70%)',
           }} />

      <TitleBar />
      <main className="flex-1 relative overflow-hidden">
        {children}
      </main>
    </div>
  )
}
