import { TitleBar } from '@/components/layout/TitleBar'
import { Progress } from '@/components/ui/progress'

interface UpdateScreenProps {
  status: 'checking' | 'downloading' | 'downloaded'
  progress: number
}

export function UpdateScreen({ status, progress }: UpdateScreenProps) {
  const label =
    status === 'checking'
      ? 'Vérification des mises à jour...'
      : status === 'downloaded'
        ? 'Installation en cours...'
        : 'Mise à jour en cours...'

  return (
    <div className="h-screen w-screen overflow-hidden bg-black relative">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-30"
        style={{ backgroundImage: 'url(./bg.png)' }}
      />
      <div className="absolute inset-0 bg-black/60" />
      <TitleBar />

      <div className="relative h-full flex flex-col items-center justify-center gap-8 px-12">
        <img src="./logo.png" alt="MatCraft" className="h-24" />

        <div className="w-full max-w-xs flex flex-col items-center gap-4">
          <p className="text-white/70 text-sm">{label}</p>

          {status === 'downloading' && (
            <>
              <Progress value={progress} className="w-full h-2" />
              <p className="text-white/50 text-xs">{progress}%</p>
            </>
          )}

          {status === 'checking' && (
            <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/3 bg-primary rounded-full animate-pulse" />
            </div>
          )}

          {status === 'downloaded' && (
            <Progress value={100} className="w-full h-2" />
          )}
        </div>
      </div>
    </div>
  )
}
