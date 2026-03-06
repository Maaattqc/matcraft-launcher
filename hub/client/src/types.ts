export interface ServiceDef {
  id: string;
  name: string;
  category: 'web' | 'infra';
  systemd: string;
  extraSystemd?: string[];
  url?: string;
  description: string;
  status: 'active' | 'activating' | 'inactive' | 'failed' | 'unknown';
  uptime: string | null;
  memory: number | null;
  extraStatus?: Record<string, string>;
}

export interface SystemInfo {
  uptime: number;
  memTotal: number;
  memAvailable: number;
  memUsed: number;
  loadAvg: number[];
}
