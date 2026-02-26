import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface LoginFormProps {
  onSuccess: (user: { username: string; uuid: string }) => void
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const result = await window.launcher.login(email, password)
      if (result.success && result.user) {
        onSuccess(result.user)
      } else {
        setError(result.error || 'Identifiants incorrects.')
      }
    } catch {
      setError('Impossible de contacter le serveur.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Adresse e-mail</Label>
        <Input
          id="email"
          type="email"
          placeholder="email@exemple.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Mot de passe</Label>
        <Input
          id="password"
          type="password"
          placeholder="••••••••"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {loading ? 'Connexion...' : 'Se connecter'}
      </Button>
    </form>
  )
}
