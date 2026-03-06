import { useEffect, useState, useCallback, useRef } from 'react';
import type { ServiceDef, SystemInfo } from '../types';
import { fetchServices, fetchSystem, logout } from '../api';
import { SystemBar } from './SystemBar';
import { ServiceCard } from './ServiceCard';
import { IconSun, IconMoon } from '../icons';

interface Props {
  onLogout: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export function Dashboard({ onLogout, theme, onToggleTheme }: Props) {
  const [services, setServices] = useState<ServiceDef[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [pulsing, setPulsing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const refresh = useCallback(async () => {
    setPulsing(true);
    setTimeout(() => setPulsing(false), 400);
    try {
      const [svcs, sys] = await Promise.all([fetchServices(), fetchSystem()]);
      if (Array.isArray(svcs)) setServices(svcs);
      if (sys?.uptime !== undefined) setSystem(sys);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 5000);
    return () => clearInterval(timerRef.current);
  }, [refresh]);

  async function handleLogout() {
    await logout();
    onLogout();
  }

  const web = services.filter(s => s.category === 'web');
  const infra = services.filter(s => s.category === 'infra');

  return (
    <div className="dashboard visible">
      <div className="topbar">
        <div className="topbar-left">
          <div className="topbar-logo">MF</div>
          <span className="topbar-title">Portail Mathieu Fournier</span>
        </div>
        <div className="topbar-right">
          <div className="topbar-status">
            <span className="topbar-dot" style={pulsing ? { background: 'var(--blue)' } : undefined} />
            <span>live</span>
          </div>
          <button className="theme-btn" onClick={onToggleTheme} title={theme === 'light' ? 'Mode sombre' : 'Mode clair'}>
            {theme === 'light' ? <IconMoon /> : <IconSun />}
          </button>
          <button className="logout-btn" onClick={handleLogout}>Deconnexion</button>
        </div>
      </div>

      <div className="main">
        <SystemBar system={system} services={services} />

        {web.length > 0 && (
          <div className="section">
            <div className="section-header">
              <span className="section-label">Projets</span>
              <div className="section-line" />
            </div>
            <div className="cards">
              {web.map(s => <ServiceCard key={s.id} service={s} onRefresh={refresh} />)}
            </div>
          </div>
        )}

        {infra.length > 0 && (
          <div className="section">
            <div className="section-header">
              <span className="section-label">Infrastructure</span>
              <div className="section-line" />
            </div>
            <div className="cards">
              {infra.map(s => <ServiceCard key={s.id} service={s} onRefresh={refresh} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
