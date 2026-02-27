import { Newspaper } from 'lucide-react'

export function NewsCard() {
  return (
    <div className="rounded-xl overflow-hidden bg-black/40 backdrop-blur-sm border border-white/10 cursor-pointer group hover:border-white/20 transition-all">
      {/* Thumbnail */}
      <div className="h-[110px] bg-gradient-to-br from-blue-900/40 to-zinc-900/40 flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <Newspaper className="h-8 w-8 text-white/20" />
      </div>
      {/* Info */}
      <div className="p-3">
        <p className="text-xs font-bold text-white uppercase tracking-wider">Bienvenue sur MatCraft</p>
        <p className="text-[11px] text-white/40 mt-0.5">Survie & Mini-jeux</p>
      </div>
    </div>
  )
}
