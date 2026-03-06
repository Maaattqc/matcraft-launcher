import { useState, type FormEvent } from 'react';
import { login } from '../api';

interface Props {
  onSuccess: () => void;
}

export function Login({ onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const ok = await login(password);
      if (ok) {
        onSuccess();
      } else {
        setError('Mot de passe incorrect');
        setPassword('');
      }
    } catch (err) {
      setError(err instanceof Error && err.message === 'Too many requests'
        ? 'Trop de tentatives, réessaie plus tard'
        : 'Erreur de connexion');
      setPassword('');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <h1>Portail MF</h1>
        <p className="subtitle">Mathieu Fournier</p>
        <form onSubmit={handleSubmit} autoComplete="off">
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            disabled={loading}
          />
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Connexion...' : 'Connexion'}
          </button>
          <div className="login-error">{error}</div>
        </form>
      </div>
    </div>
  );
}
