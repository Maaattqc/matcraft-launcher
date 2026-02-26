import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

interface LoginViewProps {
  onLogin: (user: { username: string; uuid: string }) => void
}

export function LoginView({ onLogin }: LoginViewProps) {
  const [email, setEmail] = useState('Mat_022')
  const [password, setPassword] = useState('superadminsuperadmin123$$')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!email.trim()) {
      setError('Veuillez entrer votre adresse e-mail ou nom d\'utilisateur.')
      return
    }
    if (!password) {
      setError('Veuillez entrer votre mot de passe.')
      return
    }

    setLoading(true)

    try {
      const result = await window.launcher.login(email, password)
      if (result.success && result.user) {
        onLogin(result.user)
      } else {
        setError(result.error || 'Adresse e-mail ou mot de passe incorrect.')
      }
    } catch {
      setError('Impossible de contacter le serveur. Verifiez votre connexion.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-10 pt-9">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-8">
        <img src="./logo.png" alt="MatCraft" className="h-24" />
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} noValidate className="w-full space-y-6">
        <div className="space-y-2">
          <label className="text-base font-medium text-white/70">Adresse E-mail ou Nom d'utilisateur</label>
          <input
            type="text"
            placeholder="E-mail ou nom d'utilisateur"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoFocus
            className="w-full h-12 rounded-lg bg-white/5 backdrop-blur border border-white/10 px-4 text-base text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          />
        </div>

        <div className="space-y-2">
          <label className="text-base font-medium text-white/70">Mot de passe</label>
          <input
            type="password"
            placeholder="Entrez votre mot de passe"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full h-12 rounded-lg bg-white/5 backdrop-blur border border-white/10 px-4 text-base text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          />
          <div className="flex justify-between items-center pt-1">
            <span className="text-sm text-white/30">Mot de passe oublie ?</span>
            <a
              href="https://matfaction.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-white/50 underline hover:text-white/70 transition-colors"
            >
              Reinitialiser le mot de passe.
            </a>
          </div>
        </div>

        {error && (
          <p className="text-base text-red-400 text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full h-12 rounded-lg btn-aurora text-white font-semibold text-base transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(59,130,246,0.2)]"
        >
          {loading && <Loader2 className="h-5 w-5 animate-spin" />}
          {loading ? 'Connexion...' : 'Connexion'}
        </button>
      </form>

      {/* Footer */}
      <p className="mt-6 text-sm text-white/30">
        Vous n'avez pas de compte ?{' '}
        <a
          href="https://matfaction.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/50 underline hover:text-white/70 transition-colors"
        >
          Creer un compte.
        </a>
      </p>
    </div>
  )
}
