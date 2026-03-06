import type { SystemInfo, ServiceDef } from '../types';

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(b: number): string {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' Go';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' Mo';
  return (b / 1024).toFixed(0) + ' Ko';
}

interface Props {
  system: SystemInfo | null;
  services: ServiceDef[];
}

export function SystemBar({ system, services }: Props) {
  const active = services.filter(s => s.status === 'active').length;
  const usedPct = system?.memTotal ? Math.round((system.memUsed / system.memTotal) * 100) : 0;

  const ramColor = usedPct > 85 ? 'var(--red)' : usedPct > 70 ? 'var(--amber)' : undefined;
  const svcColor = active === services.length ? 'var(--green)' : 'var(--amber)';

  return (
    <div className="sys-bar">
      <div className="sys-stat">
        <div className="sys-stat-label">Uptime</div>
        <div className="sys-stat-value">{system ? fmtUptime(system.uptime) : '--'}</div>
      </div>
      <div className="sys-stat">
        <div className="sys-stat-label">RAM</div>
        <div className="sys-stat-value" style={ramColor ? { color: ramColor } : undefined}>
          {system ? `${fmtBytes(system.memUsed)} / ${fmtBytes(system.memTotal)}` : '--'}
        </div>
      </div>
      <div className="sys-stat">
        <div className="sys-stat-label">Load</div>
        <div className="sys-stat-value">
          {system?.loadAvg ? system.loadAvg.map(l => l.toFixed(2)).join('  ') : '--'}
        </div>
      </div>
      <div className="sys-stat">
        <div className="sys-stat-label">Services</div>
        <div className="sys-stat-value" style={{ color: svcColor }}>
          {services.length > 0 ? `${active} / ${services.length}` : '--'}
        </div>
      </div>
    </div>
  );
}
