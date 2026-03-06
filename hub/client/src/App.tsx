import { useEffect, useState } from 'react';
import { checkAuth } from './api';
import { useTheme } from './hooks/useTheme';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { ToastContainer } from './components/Toast';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  if (authed === null) return null;

  return (
    <>
      {authed ? (
        <Dashboard onLogout={() => setAuthed(false)} theme={theme} onToggleTheme={toggle} />
      ) : (
        <Login onSuccess={() => setAuthed(true)} />
      )}
      <ToastContainer />
    </>
  );
}
