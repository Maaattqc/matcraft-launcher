import { useState } from 'react';
import type { ServiceDef } from '../types';
import { serviceAction } from '../api';
import { toast } from './Toast';
import { SERVICE_ICONS, IconGlobe, IconPlay, IconStop, IconRefresh, IconOpen, IconClock, IconMemory } from '../icons';

function fmtSince(ts: string | null): string | null {
  if (!ts) return null;
  const d = Date.now() - new Date(ts).getTime();
  if (d < 0) return null;
  const sec = d / 1000;
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}j ${Math.floor((sec % 86400) / 3600)}h`;
}

function fmtBytes(b: number): string {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' Go';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' Mo';
  return (b / 1024).toFixed(0) + ' Ko';
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactif',
  activating: 'Demarrage',
  failed: 'Erreur',
  unknown: 'Inconnu',
};

const BADGE_CLASSES: Record<string, string> = {
  active: 'badge-active',
  inactive: 'badge-inactive',
  activating: 'badge-activating',
  failed: 'badge-failed',
};

interface Props {
  service: ServiceDef;
  onRefresh: () => void;
}

export function ServiceCard({ service, onRefresh }: Props) {
  const [loading, setLoading] = useState(false);

  const Icon = SERVICE_ICONS[service.id] || IconGlobe;
  const isActive = service.status === 'active' || service.status === 'activating';
  const upStr = fmtSince(service.uptime);
  const memStr = service.memory ? fmtBytes(service.memory) : null;
  const badgeCls = BADGE_CLASSES[service.status] || 'badge-unknown';

  async function handleAction(action: 'start' | 'stop' | 'restart') {
    setLoading(true);
    const r = await serviceAction(service.id, action);
    if (r.ok) {
      toast(`${service.name}: ${action} OK`);
    } else {
      toast(`${service.name}: ${r.error || 'erreur'}`, 'err');
    }
    setTimeout(() => {
      onRefresh();
      setLoading(false);
    }, 1500);
  }

  return (
    <div className={`card status-${service.status}`}>
      <div className="card-top">
        <div className="card-info">
          <div className="card-icon"><Icon /></div>
          <div>
            <div className="card-name">{service.name}</div>
            <div className="card-desc">{service.description}</div>
          </div>
        </div>
        <div className={`card-badge ${badgeCls}`}>
          <span className="dot" />
          {STATUS_LABELS[service.status] || service.status}
        </div>
      </div>

      {(upStr || memStr) && (
        <div className="card-meta">
          {upStr && <span><IconClock />{upStr}</span>}
          {memStr && <span><IconMemory />{memStr}</span>}
        </div>
      )}

      <div className="card-actions">
        {isActive ? (
          <>
            <button className="act-btn act-stop" disabled={loading} onClick={() => handleAction('stop')}>
              <IconStop />Stop
            </button>
            <button className="act-btn act-restart" disabled={loading} onClick={() => handleAction('restart')}>
              <IconRefresh />Restart
            </button>
          </>
        ) : (
          <button className="act-btn act-start" disabled={loading} onClick={() => handleAction('start')}>
            <IconPlay />Start
          </button>
        )}
        {service.url && (
          <a className="card-link" href={service.url} target="_blank" rel="noopener noreferrer">
            <IconOpen />Ouvrir
          </a>
        )}
      </div>
    </div>
  );
}
