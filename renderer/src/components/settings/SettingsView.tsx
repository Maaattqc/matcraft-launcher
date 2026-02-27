import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Settings,
  Info,
  LogOut,
  Shirt,
  Package,
  Sparkles,
  Camera,
  Terminal,
  AlertTriangle,
  Wrench,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const sections = [
  { id: 'general', label: 'Paramètres', icon: Settings },
  { id: 'skins', label: 'Skins', icon: Shirt },
  { id: 'resourcepacks', label: 'Packs de ressources', icon: Package },
  { id: 'shaderpacks', label: 'Packs de shaders', icon: Sparkles },
  { id: 'screenshots', label: "Captures d'écran", icon: Camera },
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'crashes', label: 'Rapports de crash', icon: AlertTriangle },
  { id: 'about', label: 'A propos', icon: Info },
] as const

type SectionId = typeof sections[number]['id']

const ramMinOptions = ['1G', '2G', '3G', '4G']
const ramMaxOptions = ['2G', '4G', '6G', '8G', '10G', '12G', '16G']

interface SettingsViewProps {
  maxRam: string
  setMaxRam: (value: string) => void
  onLogout: () => void
}

export function SettingsView({ maxRam, setMaxRam, onLogout }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('general')
  const [language, setLanguage] = useState('fr')
  const [minRam, setMinRam] = useState('2G')

  return (
    <motion.div
      key="settings"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3 }}
      className="h-full flex"
    >
      {/* Settings sidebar */}
      <div className="w-[220px] bg-black/40 backdrop-blur-sm border-r border-white/5 flex flex-col py-6 px-3">
        <h2 className="text-lg font-bold text-white px-3 mb-4">Paramètres</h2>

        <nav className="flex flex-col gap-1">
          {sections.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                activeSection === section.id
                  ? 'bg-white/10 text-white'
                  : 'text-white/50 hover:text-white hover:bg-white/5'
              }`}
            >
              <section.icon className="h-4 w-4" />
              {section.label}
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {/* Déconnexion */}
        <button
          onClick={onLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
          Déconnexion
        </button>
      </div>

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto p-8">
        {activeSection === 'general' && (
          <GeneralSettings
            language={language}
            setLanguage={setLanguage}
            minRam={minRam}
            setMinRam={setMinRam}
            maxRam={maxRam}
            setMaxRam={setMaxRam}
          />
        )}
        {activeSection === 'skins' && <PlaceholderSection title="Skins" />}
        {activeSection === 'resourcepacks' && <PlaceholderSection title="Packs de ressources" />}
        {activeSection === 'shaderpacks' && <PlaceholderSection title="Packs de shaders" />}
        {activeSection === 'screenshots' && <PlaceholderSection title="Captures d'écran" />}
        {activeSection === 'console' && <PlaceholderSection title="Console" />}
        {activeSection === 'crashes' && <PlaceholderSection title="Rapports de crash" />}
        {activeSection === 'about' && <AboutSettings />}
      </div>
    </motion.div>
  )
}

function GeneralSettings({
  language,
  setLanguage,
  minRam,
  setMinRam,
  maxRam,
  setMaxRam,
}: {
  language: string
  setLanguage: (v: string) => void
  minRam: string
  setMinRam: (v: string) => void
  maxRam: string
  setMaxRam: (v: string) => void
}) {
  return (
    <div>
      <h3 className="text-2xl font-bold text-white mb-6">Paramètres</h3>

      <div className="space-y-6">
        {/* Langue */}
        <div className="bg-black/60 rounded-xl border border-white/10 p-5">
          <h4 className="text-sm font-semibold text-white mb-1">Langue de l'application</h4>
          <p className="text-xs text-white/40 mb-4">Choisissez la langue d'affichage du launcher.</p>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="w-[200px] h-9 text-sm bg-black/50 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fr">Français</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* RAM */}
        <div className="bg-black/60 rounded-xl border border-white/10 p-5">
          <h4 className="text-sm font-semibold text-white mb-1">Mémoire RAM</h4>
          <p className="text-xs text-white/40 mb-4">Gérez la quantité de RAM que vous souhaitez attribuer à votre jeu.</p>
          <div className="flex items-center gap-4">
            <div className="space-y-1">
              <label className="text-xs text-white/50">RAM Minimum</label>
              <Select value={minRam} onValueChange={setMinRam}>
                <SelectTrigger className="w-[120px] h-9 text-sm bg-black/50 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ramMinOptions.map(v => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-white/50">RAM Maximum</label>
              <Select value={maxRam} onValueChange={setMaxRam}>
                <SelectTrigger className="w-[120px] h-9 text-sm bg-black/50 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ramMaxOptions.map(v => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Réparer l'installation */}
        <div className="bg-black/60 rounded-xl border border-white/10 p-5">
          <h4 className="text-sm font-semibold text-white mb-1">Réparer l'installation</h4>
          <p className="text-xs text-white/40 mb-4">Retélécharge les fichiers du jeu si vous rencontrez des problèmes.</p>
          <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white font-medium transition-colors cursor-pointer">
            <Wrench className="h-4 w-4" />
            Réparer
          </button>
        </div>
      </div>
    </div>
  )
}

function PlaceholderSection({ title }: { title: string }) {
  return (
    <div>
      <h3 className="text-2xl font-bold text-white mb-6">{title}</h3>
      <div className="bg-white/5 rounded-xl border border-white/10 p-8 flex flex-col items-center justify-center">
        <p className="text-sm text-white/40">Bientôt disponible</p>
      </div>
    </div>
  )
}

function AboutSettings() {
  return (
    <div>
      <h3 className="text-2xl font-bold text-white mb-6">A propos</h3>
      <div className="bg-black/60 rounded-xl border border-white/10 p-5 space-y-3">
        <div className="flex items-center gap-4">
          <img src="./logoIcon.png" alt="MatCraft" className="h-12 w-12 rounded-lg" />
          <div>
            <p className="text-base font-bold text-white">MatCraft Launcher</p>
            <p className="text-sm text-white/40">Version {__APP_VERSION__}</p>
          </div>
        </div>
        <p className="text-sm text-white/50">
          Launcher officiel du serveur MatCraft. Minecraft 1.21.1 avec Fabric.
        </p>
        <a
          href="https://matfaction.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 hover:text-blue-300 underline transition-colors"
        >
          matfaction.com
        </a>
      </div>
    </div>
  )
}
