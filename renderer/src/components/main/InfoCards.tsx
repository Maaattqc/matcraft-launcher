import { Newspaper, MessageCircle, Server } from 'lucide-react'
import { InfoCard } from './InfoCard'

const cards = [
  {
    title: 'Actualités',
    description: 'Dernières nouvelles du network',
    icon: Newspaper,
    color: 'bg-amber-500/20',
    href: 'https://matfaction.com',
  },
  {
    title: 'Discord',
    description: 'Rejoindre la communauté',
    icon: MessageCircle,
    color: 'bg-indigo-500/20',
    href: 'https://discord.gg/factioncore',
  },
  {
    title: 'Serveur',
    description: 'play.matfaction.com',
    icon: Server,
    color: 'bg-emerald-500/20',
  },
]

export function InfoCards() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((card, i) => (
        <InfoCard key={card.title} {...card} index={i} />
      ))}
    </div>
  )
}
