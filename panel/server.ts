// MatCraft Staff Panel - Backend
// Auto-discovers Minecraft servers from start.sh files,
// exposes REST API + WebSocket for server management via systemd.

import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// RCON Client (Source RCON protocol over TCP)
// ---------------------------------------------------------------------------

class RconClient {
  private socket: net.Socket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private host: string;
  private port: number;
  private password: string;
  private connected = false;

  constructor(host: string, port: number, password: string) {
    this.host = host;
    this.port = port;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error('RCON connection timeout'));
      }, 5000);

      this.socket = net.createConnection({ host: this.host, port: this.port }, async () => {
        clearTimeout(timeout);
        try {
          await this.authenticate();
          this.connected = true;
          resolve();
        } catch (e) {
          this.socket?.destroy();
          reject(e);
        }
      });

      this.socket.on('data', (data) => this.onData(data));
      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        reject(err);
      });
      this.socket.on('close', () => {
        this.connected = false;
        for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
        this.pending.clear();
      });
    });
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.subarray(12, 4 + length - 2).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);

      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (type === -1) {
          p.reject(new Error('RCON auth failed'));
        } else {
          p.resolve(body);
        }
      }
    }
  }

  private buildPacket(id: number, type: number, body: string): Buffer {
    const bodyBuf = Buffer.from(body, 'utf8');
    const length = 4 + 4 + bodyBuf.length + 1 + 1; // id + type + body + null + pad
    const packet = Buffer.alloc(4 + length);
    packet.writeInt32LE(length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    packet[12 + bodyBuf.length] = 0;
    packet[12 + bodyBuf.length + 1] = 0;
    return packet;
  }

  private sendRaw(type: number, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON response timeout'));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.socket.write(this.buildPacket(id, type, body));
    });
  }

  private async authenticate(): Promise<void> {
    const resp = await this.sendRaw(3, this.password); // type 3 = AUTH
    void resp;
  }

  async send(command: string): Promise<string> {
    if (!this.connected) await this.connect();
    return this.sendRaw(2, command); // type 2 = COMMAND
  }

  disconnect(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// RCON connection pool — lazy connect per server
const rconPool = new Map<string, RconClient>();

async function getRcon(server: MCServer): Promise<RconClient | null> {
  if (server.type === 'Velocity') return null;
  const rconConfig = readRconConfig(server);
  if (!rconConfig || !rconConfig.enabled) return null;

  let client = rconPool.get(server.name);
  if (client?.isConnected()) return client;

  client = new RconClient('127.0.0.1', rconConfig.port, rconConfig.password);
  try {
    await client.connect();
    rconPool.set(server.name, client);
    return client;
  } catch (err) {
    console.error(`[RCON] Failed to connect to ${server.name}:`, (err as Error).message);
    return null;
  }
}

function readRconConfig(server: MCServer): RconConfig | null {
  if (server.type === 'Velocity') return null;
  try {
    const propsPath = path.join(server.dir, 'server.properties');
    if (!fs.existsSync(propsPath)) return null;
    const content = fs.readFileSync(propsPath, 'utf8');
    const enabled = /^enable-rcon\s*=\s*true/m.test(content);
    const portMatch = content.match(/^rcon\.port\s*=\s*(\d+)/m);
    const passMatch = content.match(/^rcon\.password\s*=\s*(.+)/m);
    if (!portMatch || !passMatch) return null;
    return {
      enabled,
      port: parseInt(portMatch[1], 10),
      password: passMatch[1].trim(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PanelConfig {
  sessionSecret?: string;
}

type ServerType = 'Fabric' | 'Purpur' | 'Velocity' | 'Paper' | 'Spigot' | 'Vanilla';

interface MCServer {
  name: string;
  dir: string;
  jar: string;
  type: ServerType;
  port: number;
  screen: string;
  minMemory: string;
  maxMemory: string;
  service: string;
}

interface RconConfig {
  port: number;
  password: string;
  enabled: boolean;
}

interface EnrichedServer extends MCServer {
  status: string;
  uptime: string | null;
  memory: number | null;
  players: { online: number; max: number } | null;
  playerList: string[] | null;
  rcon: RconConfig | null;
}

type SystemctlAction = 'start' | 'stop' | 'restart';

declare module 'express-session' {
  interface SessionData {
    user?: { username: string };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = 3847;
const MC_BASE = '/home/debian/minecraft';
const FILEBROWSER_URL = 'http://127.0.0.1:8081';
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config: PanelConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Persistent cryptographic session secret — generate once, persist in config.json
if (!config.sessionSecret) {
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('Generated new session secret and saved to config.json');
}

// ---------------------------------------------------------------------------
// Auth via FileBrowser API (shared credentials)
// ---------------------------------------------------------------------------

async function authenticateViaFileBrowser(username: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${FILEBROWSER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.ok; // 200 = valid credentials, 403 = invalid
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Server discovery
// ---------------------------------------------------------------------------

function discoverServers(): MCServer[] {
  const servers: MCServer[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(MC_BASE, { withFileTypes: true });
  } catch {
    return servers;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('--')) continue;

    const dir = path.join(MC_BASE, entry.name);
    const startSh = path.join(dir, 'start.sh');
    if (!fs.existsSync(startSh)) continue;

    const script = fs.readFileSync(startSh, 'utf8');
    const server = parseStartScript(entry.name, dir, script);
    if (server) servers.push(server);
  }

  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

function parseStartScript(name: string, dir: string, script: string): MCServer | null {
  const jarMatch = script.match(/SERVER_JAR=["']?([^\s"']+)/);
  const screenMatch = script.match(/SCREEN_NAME=["']?([^\s"']+)/);
  const minMemMatch = script.match(/MIN_MEMORY=["']?([^\s"']+)/);
  const maxMemMatch = script.match(/MAX_MEMORY=["']?([^\s"']+)/);

  const jar = jarMatch?.[1] ?? null;
  if (!jar) return null;

  const type = detectType(jar);
  const port = readPort(dir, type);

  return {
    name,
    dir,
    jar,
    type,
    port,
    screen: screenMatch?.[1] ?? name,
    minMemory: minMemMatch?.[1] ?? '1G',
    maxMemory: maxMemMatch?.[1] ?? '2G',
    service: `minecraft-${name}`,
  };
}

function detectType(jar: string): ServerType {
  const lower = jar.toLowerCase();
  if (lower.includes('fabric')) return 'Fabric';
  if (lower.includes('purpur')) return 'Purpur';
  if (lower.includes('velocity')) return 'Velocity';
  if (lower.includes('paper')) return 'Paper';
  if (lower.includes('spigot')) return 'Spigot';
  return 'Vanilla';
}

function readPort(dir: string, type: ServerType): number {
  if (type === 'Velocity') {
    const toml = path.join(dir, 'velocity.toml');
    if (fs.existsSync(toml)) {
      const content = fs.readFileSync(toml, 'utf8');
      const m = content.match(/bind\s*=\s*["']0\.0\.0\.0:(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return 25577;
  }

  const props = path.join(dir, 'server.properties');
  if (fs.existsSync(props)) {
    const content = fs.readFileSync(props, 'utf8');
    const m = content.match(/^server-port\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  }
  return 25565;
}

// ---------------------------------------------------------------------------
// systemd helpers
// ---------------------------------------------------------------------------

const VALID_ACTIONS: readonly SystemctlAction[] = ['start', 'stop', 'restart'] as const;

function isValidAction(action: string): action is SystemctlAction {
  return (VALID_ACTIONS as readonly string[]).includes(action);
}

async function systemctl(action: SystemctlAction, service: string): Promise<string> {
  const { stdout } = await execFileAsync('sudo', ['systemctl', action, service], {
    timeout: 30000,
  });
  return stdout.trim();
}

async function getServiceStatus(service: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', service], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return 'inactive';
  }
}

async function getServiceUptime(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', service, '--property=ActiveEnterTimestamp',
    ], { timeout: 5000 });
    const ts = stdout.replace('ActiveEnterTimestamp=', '').trim();
    if (!ts) return null;
    return new Date(ts).toISOString();
  } catch {
    return null;
  }
}

async function getServiceMemory(service: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', service, '--property=MemoryCurrent',
    ], { timeout: 5000 });
    const val = stdout.replace('MemoryCurrent=', '').trim();
    if (!val || val === '[not set]' || val === 'infinity') return null;
    return parseInt(val, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minecraft Server List Ping (MC protocol)
// ---------------------------------------------------------------------------

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  while (true) {
    if ((value & ~0x7F) === 0) {
      bytes.push(value);
      break;
    }
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): { value: number; length: number } {
  let value = 0;
  let length = 0;
  let currentByte: number;
  do {
    currentByte = buf[offset + length];
    value |= (currentByte & 0x7F) << (length * 7);
    length++;
    if (length > 5) throw new Error('VarInt too big');
  } while ((currentByte & 0x80) !== 0);
  return { value, length };
}

async function pingMinecraft(host: string, port: number): Promise<{ online: number; max: number } | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 2000);

    const socket = net.createConnection({ host, port }, () => {
      // Build Handshake packet (ID=0x00)
      const hostBuf = Buffer.from(host, 'utf8');
      const handshakeData = Buffer.concat([
        writeVarInt(0x00),              // Packet ID
        writeVarInt(47),                // Protocol version (1.8+, works universally)
        writeVarInt(hostBuf.length),    // Host string length
        hostBuf,                        // Host
        Buffer.from([port >> 8, port & 0xFF]), // Port (unsigned short, big-endian)
        writeVarInt(1),                 // Next state: Status
      ]);
      const handshakePacket = Buffer.concat([writeVarInt(handshakeData.length), handshakeData]);

      // Build Status Request packet (ID=0x00, empty)
      const statusData = writeVarInt(0x00);
      const statusPacket = Buffer.concat([writeVarInt(statusData.length), statusData]);

      socket.write(Buffer.concat([handshakePacket, statusPacket]));
    });

    let responseBuf = Buffer.alloc(0);

    socket.on('data', (data) => {
      responseBuf = Buffer.concat([responseBuf, data]);

      try {
        let offset = 0;

        // Read packet length
        const packetLength = readVarInt(responseBuf, offset);
        offset += packetLength.length;

        // Check if we have the full packet
        if (responseBuf.length < offset + packetLength.value) return; // Wait for more data

        // Read packet ID
        const packetId = readVarInt(responseBuf, offset);
        offset += packetId.length;

        if (packetId.value !== 0x00) { resolve(null); socket.destroy(); clearTimeout(timeout); return; }

        // Read JSON string length
        const jsonLength = readVarInt(responseBuf, offset);
        offset += jsonLength.length;

        // Read JSON string
        const jsonStr = responseBuf.subarray(offset, offset + jsonLength.value).toString('utf8');
        const json = JSON.parse(jsonStr);

        clearTimeout(timeout);
        socket.destroy();
        resolve({
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
        });
      } catch {
        // Incomplete data, wait for more
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

function parsePlayerList(response: string): string[] {
  // Parses "There are X of a max of Y players online: Name1, Name2"
  // Also handles "There are X/Y players online:" (Velocity/Paper)
  const match = response.match(/:\s*(.*)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(n => n.trim()).filter(n => n.length > 0);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function enrichServer(server: MCServer): Promise<EnrichedServer> {
  const enrichOne = async (): Promise<EnrichedServer> => {
    const [status, uptime, memory, players] = await Promise.all([
      getServiceStatus(server.service),
      getServiceUptime(server.service),
      getServiceMemory(server.service),
      pingMinecraft('127.0.0.1', server.port),
    ]);

    let playerList: string[] | null = null;
    const rconConfig = readRconConfig(server);
    if (status === 'active' && players && players.online > 0) {
      try {
        const rcon = await getRcon(server);
        if (rcon) {
          const resp = await rcon.send('list');
          playerList = parsePlayerList(resp);
        }
      } catch { /* RCON not available */ }
    }

    return { ...server, status, uptime, memory, players, playerList, rcon: rconConfig };
  };

  // Hard timeout per server — never block longer than 5s
  return withTimeout(enrichOne(), 5000, {
    ...server, status: 'unknown', uptime: null, memory: null,
    players: null, playerList: null, rcon: null,
  });
}

// Cache enriched servers to avoid concurrent expensive calls
let cachedEnriched: EnrichedServer[] = [];
let lastEnrichTime = 0;
const ENRICH_CACHE_MS = 3000;

async function getEnrichedServers(): Promise<EnrichedServer[]> {
  const now = Date.now();
  if (now - lastEnrichTime < ENRICH_CACHE_MS && cachedEnriched.length > 0) {
    return cachedEnriched;
  }
  cachedEnriched = await Promise.all(serverList.map(enrichServer));
  lastEnrichTime = Date.now();
  return cachedEnriched;
}

// ---------------------------------------------------------------------------
// RCON auto-setup
// ---------------------------------------------------------------------------

function ensureRconEnabled(server: MCServer, index: number): void {
  if (server.type === 'Velocity') return; // Velocity has no RCON
  const propsPath = path.join(server.dir, 'server.properties');
  if (!fs.existsSync(propsPath)) return;

  try {
    let content = fs.readFileSync(propsPath, 'utf8');
    const alreadyEnabled = /^enable-rcon\s*=\s*true/m.test(content);
    if (alreadyEnabled) return;

    const rconPort = 25575 + index;
    const rconPassword = crypto.randomBytes(16).toString('hex');

    // Update or add each RCON property
    const props: Record<string, string> = {
      'enable-rcon': 'true',
      'rcon.port': String(rconPort),
      'rcon.password': rconPassword,
    };

    for (const [key, value] of Object.entries(props)) {
      const regex = new RegExp(`^${key.replace('.', '\\.')}\\s*=.*`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
    }

    fs.writeFileSync(propsPath, content);
    console.log(`[RCON] Auto-configured RCON for ${server.name} (port ${rconPort}) — restart server to activate`);
  } catch (err) {
    console.warn(`[RCON] Could not auto-configure RCON for ${server.name}: ${(err as Error).message}`);
  }
}

// Cached server list
let serverList: MCServer[] = [];

function refreshServerList(): void {
  serverList = discoverServers();
  serverList.forEach((s, i) => ensureRconEnabled(s, i));
}

function getServerByName(name: string): MCServer | undefined {
  return serverList.find(s => s.name === name);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
const httpServer = http.createServer(app);

// Trust nginx/Cloudflare proxy — required for secure cookies behind reverse proxy
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const sessionMiddleware = session({
  secret: config.sessionSecret!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24h
  },
});
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user) {
    next();
    return;
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// --- Auth routes ---

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };

  // Input validation — prevent DoS with massive payloads
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  if (username.length > 100 || password.length > 500) {
    res.status(400).json({ error: 'Input too long' });
    return;
  }

  const valid = await authenticateViaFileBrowser(username, password);
  if (!valid) {
    console.log(`[AUTH] Failed login attempt for user: ${username}`);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Session regeneration to prevent session fixation
  req.session.regenerate((err) => {
    if (err) {
      console.error('[AUTH] Session regeneration failed:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    req.session.user = { username };
    console.log(`[AUTH] User logged in: ${username}`);
    res.json({ ok: true, username });
  });
});

app.post('/api/logout', (req: Request, res: Response) => {
  const username = req.session?.user?.username || 'unknown';
  req.session.destroy((err) => {
    if (err) {
      console.error('[AUTH] Session destroy failed:', err);
    }
    res.clearCookie('connect.sid');
    console.log(`[AUTH] User logged out: ${username}`);
    res.json({ ok: true });
  });
});

app.get('/api/me', (req: Request, res: Response) => {
  if (req.session?.user) {
    res.json(req.session.user);
    return;
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// --- Server routes ---

app.get('/api/servers', requireAuth, async (_req: Request, res: Response) => {
  try {
    const enriched = await getEnrichedServers();
    res.json(enriched);
  } catch (err) {
    console.error('[API] Failed to list servers:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PLAYER_NAME_REGEX = /^[a-zA-Z0-9_]{1,16}$/;

app.get('/api/servers/:name/players', requireAuth, async (req: Request, res: Response) => {
  const srv = getServerByName(req.params.name);
  if (!srv) { res.status(404).json({ error: 'Server not found' }); return; }

  try {
    const rcon = await getRcon(srv);
    if (!rcon) { res.json({ players: [] }); return; }
    const resp = await rcon.send('list');
    res.json({ players: parsePlayerList(resp) });
  } catch (err) {
    res.status(500).json({ error: 'RCON error: ' + (err as Error).message });
  }
});

app.post('/api/servers/:name/kick', requireAuth, async (req: Request, res: Response) => {
  const srv = getServerByName(req.params.name);
  if (!srv) { res.status(404).json({ error: 'Server not found' }); return; }

  const { player, reason } = req.body as { player?: string; reason?: string };
  if (!player || !PLAYER_NAME_REGEX.test(player)) {
    res.status(400).json({ error: 'Invalid player name' }); return;
  }

  try {
    const rcon = await getRcon(srv);
    if (!rcon) { res.status(400).json({ error: 'RCON not available' }); return; }
    const cmd = reason ? `kick ${player} ${reason}` : `kick ${player}`;
    const resp = await rcon.send(cmd);
    const username = req.session?.user?.username || 'unknown';
    console.log(`[ACTION] ${username} kicked ${player} from ${srv.name}`);
    res.json({ ok: true, response: resp });
  } catch (err) {
    res.status(500).json({ error: 'RCON error: ' + (err as Error).message });
  }
});

app.post('/api/servers/:name/ban', requireAuth, async (req: Request, res: Response) => {
  const srv = getServerByName(req.params.name);
  if (!srv) { res.status(404).json({ error: 'Server not found' }); return; }

  const { player, reason } = req.body as { player?: string; reason?: string };
  if (!player || !PLAYER_NAME_REGEX.test(player)) {
    res.status(400).json({ error: 'Invalid player name' }); return;
  }

  try {
    const rcon = await getRcon(srv);
    if (!rcon) { res.status(400).json({ error: 'RCON not available' }); return; }
    const cmd = reason ? `ban ${player} ${reason}` : `ban ${player}`;
    const resp = await rcon.send(cmd);
    const username = req.session?.user?.username || 'unknown';
    console.log(`[ACTION] ${username} banned ${player} from ${srv.name}`);
    res.json({ ok: true, response: resp });
  } catch (err) {
    res.status(500).json({ error: 'RCON error: ' + (err as Error).message });
  }
});

app.post('/api/servers/:name/:action', requireAuth, async (req: Request, res: Response) => {
  const { name, action } = req.params;

  if (!isValidAction(action)) {
    res.status(400).json({ error: `Invalid action: ${action}` });
    return;
  }

  const srv = getServerByName(name);
  if (!srv) {
    res.status(404).json({ error: `Server not found: ${name}` });
    return;
  }

  const username = req.session?.user?.username || 'unknown';
  console.log(`[ACTION] ${username} ${action} ${srv.name}`);

  try {
    await systemctl(action, srv.service);
    await new Promise(r => setTimeout(r, 1000));
    const updated = await enrichServer(srv);
    res.json(updated);
  } catch (err) {
    console.error(`[ACTION] Failed: ${username} ${action} ${srv.name}:`, (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// WebSocket — push server status every 5s
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// Per-client console state
interface ClientState {
  logProcess: ChildProcess | null;
  subscribedServer: string | null;
}
const clientStates = new Map<WebSocket, ClientState>();

function cleanupClient(ws: WebSocket): void {
  const state = clientStates.get(ws);
  if (state?.logProcess) {
    state.logProcess.kill();
    state.logProcess = null;
  }
  clientStates.delete(ws);
}

function handleConsoleMessage(ws: WebSocket, msg: any): void {
  if (msg.type === 'console:subscribe') {
    const serverName = msg.server;
    const srv = getServerByName(serverName);
    if (!srv) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Server not found' }));
      return;
    }

    // Cleanup previous subscription
    const state = clientStates.get(ws) || { logProcess: null, subscribedServer: null };
    if (state.logProcess) {
      state.logProcess.kill();
      state.logProcess = null;
    }

    state.subscribedServer = serverName;

    // Spawn journalctl -f for live logs
    const proc = spawn('journalctl', ['-u', srv.service, '-f', '-n', '200', '--no-pager', '-o', 'short-iso'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.logProcess = proc;
    clientStates.set(ws, state);

    let initialLines: string[] = [];
    let sentHistory = false;

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split('\n').filter(l => l.length > 0);
      if (!sentHistory) {
        initialLines.push(...lines);
        // journalctl outputs all initial lines quickly, then streams
        // Use a small delay to batch the initial history
        clearTimeout((proc as any)._historyTimeout);
        (proc as any)._historyTimeout = setTimeout(() => {
          sentHistory = true;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'console:history', server: serverName, lines: initialLines }));
          }
          initialLines = [];
        }, 100);
      } else {
        for (const line of lines) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'console:log', server: serverName, line }));
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: data.toString('utf8').trim() }));
      }
    });

    proc.on('close', () => {
      if (state.logProcess === proc) {
        state.logProcess = null;
      }
    });

  } else if (msg.type === 'console:unsubscribe') {
    const state = clientStates.get(ws);
    if (state?.logProcess) {
      state.logProcess.kill();
      state.logProcess = null;
    }
    if (state) state.subscribedServer = null;

  } else if (msg.type === 'console:command') {
    const serverName = msg.server;
    const command = msg.command;
    if (!serverName || !command || typeof command !== 'string') return;
    if (command.length > 1000) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Command too long' }));
      return;
    }
    const srv = getServerByName(serverName);
    if (!srv) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Server not found' }));
      return;
    }
    getRcon(srv).then(rcon => {
      if (!rcon) {
        ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'RCON not available — restart server after auto-setup' }));
        return;
      }
      return rcon.send(command).then(response => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'console:response', server: serverName, response }));
        }
      });
    }).catch(err => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: (err as Error).message }));
      }
    });
  }
}

httpServer.on('upgrade', (req: http.IncomingMessage, socket, head) => {
  sessionMiddleware(req as any, {} as any, () => {
    if (!(req as any).session?.user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

wss.on('connection', (ws: WebSocket) => {
  clientStates.set(ws, { logProcess: null, subscribedServer: null });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type?.startsWith('console:')) {
        handleConsoleMessage(ws, msg);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => cleanupClient(ws));
  ws.on('error', () => cleanupClient(ws));
});

let broadcastRunning = false;

async function broadcastStatus(): Promise<void> {
  if (wss.clients.size === 0) return;
  if (broadcastRunning) return; // prevent piling up
  broadcastRunning = true;
  try {
    const enriched = await getEnrichedServers();
    const data = JSON.stringify({ type: 'status', servers: enriched });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  } catch (err) {
    console.error('Broadcast error:', (err as Error).message);
  } finally {
    broadcastRunning = false;
  }
}

setInterval(broadcastStatus, 5000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

refreshServerList();
console.log(`Discovered ${serverList.length} servers:`);
for (const s of serverList) {
  console.log(`  - ${s.name} (${s.type}, port ${s.port}, ${s.minMemory}-${s.maxMemory})`);
}

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`MatCraft Panel listening on http://127.0.0.1:${PORT}`);
});
