// Portail MF - Personal service dashboard backend
// Provides service status, start/stop/restart via systemd, and static file serving.

import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = 3848;
const CONFIG_PATH = path.join(__dirname, 'config.json');

interface ServiceDef {
  id: string;
  name: string;
  category: 'web' | 'game' | 'infra';
  systemd: string;        // primary systemd service
  extraSystemd?: string[]; // additional services to check (e.g. nginx for website)
  url?: string;            // external URL to open
  description: string;
}

const SERVICES: ServiceDef[] = [
  {
    id: 'panel',
    name: 'Panel',
    category: 'web',
    systemd: 'matcraft-panel',
    url: 'https://panel.matcraft-mc.com',
    description: 'Staff management panel',
  },
  {
    id: 'sftp',
    name: 'SFTP',
    category: 'web',
    systemd: 'filebrowser',
    url: 'https://sftp.matcraft-mc.com',
    description: 'File browser for test server',
  },
  {
    id: 'website',
    name: 'Azuriom',
    category: 'web',
    systemd: 'php8.3-fpm',
    extraSystemd: ['nginx'],
    url: 'https://matfaction.com',
    description: 'Main website',
  },
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'infra',
    systemd: 'nginx',
    description: 'Reverse proxy',
  },
  {
    id: 'cloudflared',
    name: 'Cloudflared',
    category: 'infra',
    systemd: 'cloudflared',
    description: 'Cloudflare Tunnel',
  },
  {
    id: 'beauce-audit',
    name: 'Beauce Audit',
    category: 'web',
    systemd: 'beauce-audit',
    url: 'https://audit.mathieu-fournier.net',
    description: 'Beauce Web Audit - Hub de prospection',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(): { sessionSecret: string; passwordHash?: string } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    const cfg = { sessionSecret: secret };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    return cfg;
  }
}


// Cross-domain auth token for sub-services (audit, etc.)
const AUTH_COOKIE = 'mf_auth';
const AUTH_DOMAIN = '.mathieu-fournier.net';
const AUTH_MAX_AGE = 24 * 60 * 60 * 1000;

function signAuthToken(secret: string): string {
  const expiry = (Date.now() + AUTH_MAX_AGE).toString(16);
  const hmac = crypto.createHmac('sha256', secret).update(expiry).digest('hex');
  return expiry + '.' + hmac;
}

async function getServiceStatus(name: string): Promise<'active' | 'activating' | 'inactive' | 'failed' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', name], { timeout: 5000 });
    const s = stdout.trim();
    if (s === 'active' || s === 'activating' || s === 'inactive' || s === 'failed') return s;
    return 'unknown';
  } catch (err: any) {
    const out = err?.stdout?.trim?.() || '';
    if (out === 'inactive' || out === 'failed' || out === 'activating') return out;
    return 'inactive';
  }
}

async function getServiceUptime(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', name, '--property=ActiveEnterTimestamp'], { timeout: 5000 });
    const match = stdout.match(/ActiveEnterTimestamp=(.+)/);
    if (match && match[1].trim()) return match[1].trim();
    return null;
  } catch {
    return null;
  }
}

async function getMemoryUsage(name: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', name, '--property=MemoryCurrent'], { timeout: 5000 });
    const match = stdout.match(/MemoryCurrent=(\d+)/);
    if (match) {
      const bytes = parseInt(match[1], 10);
      if (bytes > 0 && bytes < 1e15) return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

async function serviceAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync('sudo', ['systemctl', action, name], { timeout: 30000 });
    return { ok: true };
  } catch (err: any) {
    console.error(`systemctl ${action} ${name}:`, err?.stderr || err.message);
    return { ok: false, error: 'Service action failed' };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const config = loadConfig();
const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 24 * 60 * 60 * 1000 },
}));

declare module 'express-session' {
  interface SessionData { authenticated: boolean; }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

app.post('/api/login', loginLimiter, async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password || !config.passwordHash) {
    console.warn(`Failed login from ${req.ip}: missing password or hash`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const valid = await bcrypt.compare(password, config.passwordHash);
  if (!valid) {
    console.warn(`Failed login from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.authenticated = true;
  res.cookie(AUTH_COOKIE, signAuthToken(config.sessionSecret), { domain: AUTH_DOMAIN, httpOnly: true, secure: true, sameSite: "lax", maxAge: AUTH_MAX_AGE });
  res.json({ ok: true });
});

app.post('/api/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.clearCookie(AUTH_COOKIE, { domain: AUTH_DOMAIN });
    res.json({ ok: true });
  });
});

app.get('/api/me', (req: Request, res: Response) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// ---------------------------------------------------------------------------
// Service routes
// ---------------------------------------------------------------------------

app.get('/api/services', requireAuth, async (_req: Request, res: Response) => {
  const results = await Promise.all(SERVICES.map(async (svc) => {
    const [status, uptime, memory] = await Promise.all([
      getServiceStatus(svc.systemd),
      getServiceUptime(svc.systemd),
      getMemoryUsage(svc.systemd),
    ]);

    // Check extra services
    let extraStatus: Record<string, string> | undefined;
    if (svc.extraSystemd) {
      const extras = await Promise.all(svc.extraSystemd.map(async (s) => ({
        name: s,
        status: await getServiceStatus(s),
      })));
      extraStatus = Object.fromEntries(extras.map(e => [e.name, e.status]));
    }

    return {
      ...svc,
      status,
      uptime,
      memory,
      extraStatus,
    };
  }));
  res.json(results);
});

app.post('/api/services/:id/:action', requireAuth, async (req: Request, res: Response) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const svc = SERVICES.find(s => s.id === id);
  if (!svc) return res.status(404).json({ error: 'Service not found' });

  const result = await serviceAction(svc.systemd, action as 'start' | 'stop' | 'restart');
  res.json(result);
});

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

app.get('/api/system', requireAuth, async (_req: Request, res: Response) => {
  try {
    const [uptimeOut, memOut, loadOut] = await Promise.all([
      execFileAsync('cat', ['/proc/uptime'], { timeout: 3000 }).then(r => r.stdout).catch(() => ''),
      execFileAsync('cat', ['/proc/meminfo'], { timeout: 3000 }).then(r => r.stdout).catch(() => ''),
      execFileAsync('cat', ['/proc/loadavg'], { timeout: 3000 }).then(r => r.stdout).catch(() => ''),
    ]);

    const uptimeSec = parseFloat(uptimeOut.split(' ')[0]) || 0;

    let memTotal = 0, memAvailable = 0;
    for (const line of memOut.split('\n')) {
      if (line.startsWith('MemTotal:')) memTotal = parseInt(line.split(/\s+/)[1]) * 1024;
      if (line.startsWith('MemAvailable:')) memAvailable = parseInt(line.split(/\s+/)[1]) * 1024;
    }

    const loadAvg = loadOut.split(' ').slice(0, 3).map(Number);

    res.json({ uptime: uptimeSec, memTotal, memAvailable, memUsed: memTotal - memAvailable, loadAvg });
  } catch {
    res.json({ uptime: 0, memTotal: 0, memAvailable: 0, memUsed: 0, loadAvg: [0, 0, 0] });
  }
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const STATIC_DIR = path.join(__dirname, 'client', 'dist');

app.use(express.static(STATIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, '127.0.0.1', () => {
  server.setTimeout(30000);
  console.log(`Portail MF listening on http://127.0.0.1:${PORT}`);
});
