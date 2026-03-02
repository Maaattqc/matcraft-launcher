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

// RCON config cache — populated at startup, invalidated after server restart
const rconConfigCache = new Map<string, RconConfig | null>();

function readRconConfig(server: MCServer): RconConfig | null {
  if (server.type === 'Velocity') return null;
  if (rconConfigCache.has(server.name)) return rconConfigCache.get(server.name)!;
  return readRconConfigFromDisk(server);
}

function readRconConfigFromDisk(server: MCServer): RconConfig | null {
  if (server.type === 'Velocity') return null;
  try {
    const propsPath = path.join(server.dir, 'server.properties');
    if (!fs.existsSync(propsPath)) return null;
    const content = fs.readFileSync(propsPath, 'utf8');
    const enabled = /^enable-rcon\s*=\s*true/m.test(content);
    const portMatch = content.match(/^rcon\.port\s*=\s*(\d+)/m);
    const passMatch = content.match(/^rcon\.password\s*=\s*(.+)/m);
    if (!portMatch || !passMatch) return null;
    const config: RconConfig = {
      enabled,
      port: parseInt(portMatch[1], 10),
      password: passMatch[1].trim(),
    };
    rconConfigCache.set(server.name, config);
    return config;
  } catch {
    rconConfigCache.set(server.name, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionPermission = 'start' | 'stop' | 'restart' | 'console' | 'kick' | 'ban';

// Per-server permissions: keys = server names or "*" (wildcard for all), values = allowed actions
type UserPermissions = Record<string, ActionPermission[]>;

const ALL_ACTIONS: ActionPermission[] = ['start', 'stop', 'restart', 'console', 'kick', 'ban'];

interface PanelConfig {
  sessionSecret?: string;
  users?: Record<string, UserPermissions>;
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
  javaArgs: string;
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

if (!config.users) {
  config.users = {};
}

// Migrate old format { actions: [], servers: [] } → new per-server format
(function migratePermissions() {
  if (!config.users) return;
  let changed = false;
  for (const [name, perms] of Object.entries(config.users)) {
    if (perms && 'actions' in perms && 'servers' in perms && Array.isArray((perms as any).actions)) {
      const old = perms as any as { actions: ActionPermission[]; servers: string[] };
      const migrated: UserPermissions = {};
      if (old.servers.includes('*')) {
        migrated['*'] = old.actions;
      } else {
        for (const srv of old.servers) {
          migrated[srv] = [...old.actions];
        }
        if (old.servers.length === 0) {
          migrated['*'] = [];
        }
      }
      config.users[name] = migrated;
      changed = true;
      console.log(`[PERMS] Migrated permissions for ${name} to per-server format`);
    }
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
})();

function saveConfig(): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getUserPermissions(username: string): { perms: UserPermissions; isAdmin: boolean } {
  if (username === 'admin') {
    return { perms: { '*': [...ALL_ACTIONS] }, isAdmin: true };
  }
  const perms = config.users?.[username];
  if (!perms) {
    return { perms: { '*': [] }, isAdmin: false };
  }
  return { perms, isAdmin: false };
}

function canAccessServer(username: string, serverName: string): boolean {
  const { perms, isAdmin } = getUserPermissions(username);
  if (isAdmin) return true;
  if ('*' in perms) return true;
  return serverName in perms;
}

function canPerformAction(username: string, action: string, serverName: string): boolean {
  const { perms, isAdmin } = getUserPermissions(username);
  if (isAdmin) return true;
  // Specific server overrides wildcard
  const serverActions = perms[serverName] ?? perms['*'];
  if (!serverActions) return false;
  return serverActions.includes(action as ActionPermission);
}

function ensureUserTracked(username: string): void {
  if (username === 'admin') return;
  if (!config.users) config.users = {};
  if (!config.users[username]) {
    config.users[username] = { '*': [] };
    saveConfig();
    console.log(`[PERMS] New user tracked: ${username} (read-only)`);
  }
}

// ---------------------------------------------------------------------------
// Auth via FileBrowser API (shared credentials)
// ---------------------------------------------------------------------------

// Cache the admin's FileBrowser token to fetch user lists
let fbAdminToken: string | null = null;

async function authenticateViaFileBrowser(username: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${FILEBROWSER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return false;
    // Store admin token for user listing
    if (username === 'admin') {
      fbAdminToken = await res.text();
    }
    return true;
  } catch {
    return false;
  }
}

async function getFileBrowserUsers(): Promise<string[]> {
  if (!fbAdminToken) return [];
  try {
    const res = await fetch(`${FILEBROWSER_URL}/api/users`, {
      headers: { 'X-Auth': fbAdminToken },
    });
    if (!res.ok) {
      // Token expired — clear it
      if (res.status === 401 || res.status === 403) fbAdminToken = null;
      return [];
    }
    const users = await res.json() as { username: string }[];
    return users.map(u => u.username).filter(u => u !== 'admin');
  } catch {
    return [];
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
  const argsMatch = script.match(/JAVA_ARGS=["']([^"']+)["']/);

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
    javaArgs: argsMatch?.[1] ?? '',
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

// Batch: single `systemctl is-active svc1 svc2 ...` → one status per line
async function getBatchServiceStatuses(services: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (services.length === 0) return result;
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', ...services], {
      timeout: 10000,
    });
    const lines = stdout.trim().split('\n');
    services.forEach((svc, i) => result.set(svc, lines[i]?.trim() || 'inactive'));
  } catch (err: any) {
    // systemctl exits non-zero if any service is inactive, but stdout still has all statuses
    const stdout: string = err.stdout || '';
    const lines = stdout.trim().split('\n');
    services.forEach((svc, i) => result.set(svc, lines[i]?.trim() || 'inactive'));
  }
  return result;
}

// Batch: single `systemctl show svc1 svc2 ... --property=ActiveEnterTimestamp,MemoryCurrent`
// Returns blocks separated by blank lines, each block has the two properties.
async function getBatchServiceMetrics(services: string[]): Promise<Map<string, { uptime: string | null; memory: number | null }>> {
  const result = new Map<string, { uptime: string | null; memory: number | null }>();
  if (services.length === 0) return result;
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', ...services, '--property=ActiveEnterTimestamp,MemoryCurrent',
    ], { timeout: 10000 });
    // Blocks are separated by empty lines
    const blocks = stdout.split(/\n\n+/);
    services.forEach((svc, i) => {
      const block = blocks[i] || '';
      let uptime: string | null = null;
      let memory: number | null = null;
      const tsMatch = block.match(/ActiveEnterTimestamp=(.+)/);
      if (tsMatch && tsMatch[1].trim()) {
        try { uptime = new Date(tsMatch[1].trim()).toISOString(); } catch {}
      }
      const memMatch = block.match(/MemoryCurrent=(.+)/);
      if (memMatch) {
        const val = memMatch[1].trim();
        if (val && val !== '[not set]' && val !== 'infinity') {
          memory = parseInt(val, 10);
        }
      }
      result.set(svc, { uptime, memory });
    });
  } catch {
    services.forEach(svc => result.set(svc, { uptime: null, memory: null }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Service file sync — regenerate systemd .service from start.sh values
// ---------------------------------------------------------------------------

function parseMemoryMB(mem: string): number {
  const m = mem.match(/^(\d+)([GgMm]?)$/);
  if (!m) return 2048;
  const val = parseInt(m[1], 10);
  const unit = m[2]?.toUpperCase() || 'M';
  return unit === 'G' ? val * 1024 : val;
}

function formatMemory(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`;
}

async function writeServiceFile(srv: MCServer): Promise<void> {
  const maxMB = parseMemoryMB(srv.maxMemory);
  const memoryMax = formatMemory(maxMB + 1024); // +1G headroom for JVM overhead

  const javaArgsStr = srv.javaArgs ? ` ${srv.javaArgs}` : '';
  const content = `[Unit]
Description=MatCraft Server - ${srv.name}
After=network.target

[Service]
User=debian
Group=debian
WorkingDirectory=${srv.dir}
ExecStart=/usr/bin/java -Xms${srv.minMemory} -Xmx${srv.maxMemory}${javaArgsStr} -jar ${srv.jar} nogui
ExecStop=/bin/kill -SIGTERM $MAINPID
Restart=on-failure
RestartSec=10
SuccessExitStatus=0 130 143
MemoryMax=${memoryMax}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=minecraft-${srv.name}

[Install]
WantedBy=multi-user.target
`;

  const tmpPath = `/tmp/${srv.service}.service`;
  const destPath = `/etc/systemd/system/${srv.service}.service`;

  fs.writeFileSync(tmpPath, content, 'utf8');
  await execFileAsync('sudo', ['cp', tmpPath, destPath], { timeout: 5000 });
  console.log(`[SYNC] Wrote ${srv.service}.service`);
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
const ENRICH_CACHE_MS = 8000;

async function getEnrichedServers(): Promise<EnrichedServer[]> {
  const now = Date.now();
  if (now - lastEnrichTime < ENRICH_CACHE_MS && cachedEnriched.length > 0) {
    return cachedEnriched;
  }

  const services = serverList.map(s => s.service);

  // 2 batch systemctl calls + all pings in parallel (skip Velocity — no SLP response)
  const [statuses, metrics, ...pings] = await Promise.all([
    getBatchServiceStatuses(services),
    getBatchServiceMetrics(services),
    ...serverList.map(s =>
      s.type === 'Velocity'
        ? Promise.resolve(null)
        : pingMinecraft('127.0.0.1', s.port)
    ),
  ]);

  // Distribute results + optional RCON per server
  const enriched = await Promise.all(serverList.map(async (server, i) => {
    const status = statuses.get(server.service) || 'inactive';
    const met = metrics.get(server.service) || { uptime: null, memory: null };
    const players = pings[i] as { online: number; max: number } | null;

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

    return {
      ...server,
      status,
      uptime: met.uptime,
      memory: met.memory,
      players,
      playerList,
      rcon: rconConfig,
    } as EnrichedServer;
  }));

  cachedEnriched = enriched;
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
  // Populate RCON config cache at startup
  rconConfigCache.clear();
  for (const s of serverList) {
    readRconConfigFromDisk(s);
  }
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

// Security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user) {
    next();
    return;
  }
  console.log(`[AUTH] 401 on ${req.method} ${req.path} (no session user)`);
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user?.username === 'admin') {
    next();
    return;
  }
  res.status(403).json({ error: 'Admin access required' });
}

function requireAction(action: ActionPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const username = req.session?.user?.username;
    if (!username) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const serverName = req.params.name;
    if (!canPerformAction(username, action, serverName)) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }
    next();
  };
}

// --- Rate limiting ---

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // max attempts per window

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Cleanup stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

// --- Auth routes ---

app.post('/api/login', async (req: Request, res: Response) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    console.log(`[AUTH] Rate limited login attempt from ${clientIp}`);
    res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    return;
  }

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
    ensureUserTracked(username);
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
    const { username } = req.session.user;
    const { perms, isAdmin } = getUserPermissions(username);
    res.json({ username, isAdmin, permissions: perms });
    return;
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// --- Server routes ---

app.get('/api/servers', requireAuth, async (req: Request, res: Response) => {
  try {
    const username = req.session!.user!.username;
    const enriched = await getEnrichedServers();
    const filtered = enriched.filter(s => canAccessServer(username, s.name));
    // Strip sensitive fields (rcon passwords) before sending to client
    const safe = filtered.map(({ rcon, ...rest }) => ({
      ...rest,
      rcon: rcon ? { enabled: rcon.enabled, port: rcon.port } : null,
    }));
    res.json(safe);
  } catch (err) {
    console.error('[API] Failed to list servers:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PLAYER_NAME_REGEX = /^[a-zA-Z0-9_]{1,16}$/;
const REASON_REGEX = /^[a-zA-Z0-9À-ÿ\s.,!?'-]{0,150}$/;

// Commands that only admin can execute via console (dangerous server-level commands)
const ADMIN_ONLY_COMMANDS = new Set([
  'stop', 'op', 'deop', 'ban', 'ban-ip', 'pardon', 'pardon-ip',
  'whitelist', 'save-all', 'save-off', 'save-on', 'reload',
  'debug', 'publish', 'transfer', 'jvm', 'perf',
]);

app.get('/api/servers/:name/players', requireAuth, async (req: Request, res: Response) => {
  const username = req.session!.user!.username;
  if (!canAccessServer(username, req.params.name)) {
    res.status(403).json({ error: 'Permission denied' }); return;
  }
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

app.post('/api/servers/:name/kick', requireAuth, requireAction('kick'), async (req: Request, res: Response) => {
  const srv = getServerByName(req.params.name);
  if (!srv) { res.status(404).json({ error: 'Server not found' }); return; }

  const { player, reason } = req.body as { player?: string; reason?: string };
  if (!player || !PLAYER_NAME_REGEX.test(player)) {
    res.status(400).json({ error: 'Invalid player name' }); return;
  }
  if (reason && !REASON_REGEX.test(reason)) {
    res.status(400).json({ error: 'Invalid reason (alphanumeric + basic punctuation, max 150 chars)' }); return;
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

app.post('/api/servers/:name/ban', requireAuth, requireAction('ban'), async (req: Request, res: Response) => {
  const srv = getServerByName(req.params.name);
  if (!srv) { res.status(404).json({ error: 'Server not found' }); return; }

  const { player, reason } = req.body as { player?: string; reason?: string };
  if (!player || !PLAYER_NAME_REGEX.test(player)) {
    res.status(400).json({ error: 'Invalid player name' }); return;
  }
  if (reason && !REASON_REGEX.test(reason)) {
    res.status(400).json({ error: 'Invalid reason (alphanumeric + basic punctuation, max 150 chars)' }); return;
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

  const username = req.session?.user?.username || 'unknown';
  if (!canPerformAction(username, action, name)) {
    res.status(403).json({ error: 'Permission denied' });
    return;
  }

  const srv = getServerByName(name);
  if (!srv) {
    res.status(404).json({ error: `Server not found: ${name}` });
    return;
  }
  console.log(`[ACTION] ${username} ${action} ${srv.name}`);

  try {
    // Re-sync systemd service file from start.sh before starting/restarting
    if (action === 'start' || action === 'restart') {
      const startSh = path.join(srv.dir, 'start.sh');
      if (fs.existsSync(startSh)) {
        const script = fs.readFileSync(startSh, 'utf8');
        const freshSrv = parseStartScript(srv.name, srv.dir, script);
        if (freshSrv) {
          Object.assign(srv, freshSrv);
          await writeServiceFile(freshSrv);
          await execFileAsync('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });
        }
      }
    }

    await systemctl(action, srv.service);
    // Invalidate RCON cache after restart (config may have changed)
    if (action === 'restart' || action === 'start') {
      rconConfigCache.delete(srv.name);
      // Disconnect stale RCON connection so it reconnects with fresh config
      const oldRcon = rconPool.get(srv.name);
      if (oldRcon) { oldRcon.disconnect(); rconPool.delete(srv.name); }
      // Re-read config after a short delay (server needs time to start)
      setTimeout(() => readRconConfigFromDisk(srv), 3000);
    }
    await new Promise(r => setTimeout(r, 1000));
    const updated = await enrichServer(srv);
    res.json(updated);
  } catch (err) {
    console.error(`[ACTION] Failed: ${username} ${action} ${srv.name}:`, (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin API — user permission management
// ---------------------------------------------------------------------------

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  // Sync FileBrowser users into config — auto-add any missing ones
  const fbUsers = await getFileBrowserUsers();
  if (fbUsers.length > 0) {
    if (!config.users) config.users = {};
    let changed = false;
    for (const name of fbUsers) {
      if (!config.users[name]) {
        config.users[name] = { '*': [] };
        console.log(`[PERMS] Auto-synced FileBrowser user: ${name}`);
        changed = true;
      }
    }
    if (changed) saveConfig();
  }

  const serverNames = serverList.map(s => s.name);
  const users: Record<string, UserPermissions> = {};
  for (const [name, perms] of Object.entries(config.users || {})) {
    users[name] = perms;
  }
  res.json({ users, serverNames, allActions: ALL_ACTIONS });
});

app.put('/api/admin/users/:username', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { username } = req.params;
  if (username === 'admin') {
    res.status(400).json({ error: 'Cannot modify admin permissions' });
    return;
  }
  const permissions = req.body as Record<string, string[]>;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    res.status(400).json({ error: 'Body must be an object { serverName: [actions] }' });
    return;
  }
  // Validate
  const validServerNames = serverList.map(s => s.name);
  const validated: UserPermissions = {};
  for (const [srv, acts] of Object.entries(permissions)) {
    if (srv !== '*' && !validServerNames.includes(srv)) continue;
    if (!Array.isArray(acts)) continue;
    validated[srv] = acts.filter(a => ALL_ACTIONS.includes(a as ActionPermission)) as ActionPermission[];
  }

  if (!config.users) config.users = {};
  config.users[username] = validated;
  saveConfig();
  console.log(`[ADMIN] Updated permissions for ${username}:`, JSON.stringify(validated));
  res.json({ ok: true });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { username } = req.body as { username?: string };
  if (!username || typeof username !== 'string' || username.length > 100) {
    res.status(400).json({ error: 'Invalid username' });
    return;
  }
  const name = username.trim();
  if (!name || name === 'admin') {
    res.status(400).json({ error: 'Invalid username' });
    return;
  }
  if (!config.users) config.users = {};
  if (config.users[name]) {
    res.status(409).json({ error: 'User already exists' });
    return;
  }
  config.users[name] = { '*': [] };
  saveConfig();
  console.log(`[ADMIN] Manually added user: ${name} (read-only)`);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { username } = req.params;
  if (username === 'admin') {
    res.status(400).json({ error: 'Cannot delete admin' });
    return;
  }
  if (config.users) {
    delete config.users[username];
    saveConfig();
    console.log(`[ADMIN] Deleted user permissions for ${username}`);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket — push server status every 5s
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// Per-client console state
interface ClientState {
  username: string;
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
    const state = clientStates.get(ws);
    if (!state) return;

    if (!canPerformAction(state.username, 'console', serverName)) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Permission denied' }));
      return;
    }

    const srv = getServerByName(serverName);
    if (!srv) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Server not found' }));
      return;
    }

    // Cleanup previous subscription
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
    const cmdState = clientStates.get(ws);
    if (!cmdState || !canPerformAction(cmdState.username, 'console', serverName)) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Permission denied' }));
      return;
    }
    if (command.length > 1000) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: 'Command too long' }));
      return;
    }
    // Block dangerous commands for non-admin users
    const baseCmd = command.trim().split(/\s+/)[0].toLowerCase();
    const { isAdmin: isAdminUser } = getUserPermissions(cmdState.username);
    if (!isAdminUser && ADMIN_ONLY_COMMANDS.has(baseCmd)) {
      ws.send(JSON.stringify({ type: 'console:error', server: serverName, error: `Command "${baseCmd}" is restricted to admin only` }));
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
  // Minimal response mock for express-session (needs getHeader/setHeader/end)
  const dummyRes = {
    getHeader: () => undefined,
    setHeader: () => dummyRes,
    writeHead: () => dummyRes,
    end: () => {},
  } as any;
  sessionMiddleware(req as any, dummyRes, () => {
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

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const username = (req as any).session?.user?.username || 'unknown';
  clientStates.set(ws, { username, logProcess: null, subscribedServer: null });

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
    // Cache per-user filtered JSON to avoid re-serializing for same permission set
    const jsonCache = new Map<string, string>();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = clientStates.get(client as WebSocket);
      const uname = state?.username || 'unknown';
      let json = jsonCache.get(uname);
      if (!json) {
        const filtered = enriched.filter(s => canAccessServer(uname, s.name));
        // Strip sensitive fields (rcon passwords) before sending to client
        const safe = filtered.map(({ rcon, ...rest }) => ({
          ...rest,
          rcon: rcon ? { enabled: rcon.enabled, port: rcon.port } : null,
        }));
        json = JSON.stringify({ type: 'status', servers: safe });
        jsonCache.set(uname, json);
      }
      client.send(json);
    }
  } catch (err) {
    console.error('Broadcast error:', (err as Error).message);
  } finally {
    broadcastRunning = false;
  }
}

setInterval(broadcastStatus, 10000);

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
