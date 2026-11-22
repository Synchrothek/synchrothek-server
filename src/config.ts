/** Laufzeit-Konfiguration aus Umgebungsvariablen (siehe .env.example). */
export interface Config {
  port: number;
  host: string;
  trustProxy: boolean;
  allowedOrigins: string[];
  maxConnectionsPerIp: number; // 0 = unbegrenzt
  maxRoomMembers: number; // 0 = unbegrenzt
  maxRoomDurationMs: number; // 0 = unbegrenzt
  idleTimeoutMs: number; // 0 = aus
  emptyRoomTtlMs: number;
  reconnectGraceMs: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  return {
    port: integer(env, 'PORT', 8080),
    host: env.HOST || '0.0.0.0',
    trustProxy: boolean(env, 'TRUST_PROXY', false),
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    maxConnectionsPerIp: integer(env, 'MAX_CONNECTIONS_PER_IP', 20),
    maxRoomMembers: integer(env, 'MAX_ROOM_MEMBERS', 20),
    maxRoomDurationMs: integer(env, 'MAX_ROOM_DURATION_MINUTES', 0) * 60_000,
    idleTimeoutMs: integer(env, 'IDLE_ROOM_TIMEOUT_MINUTES', 30) * 60_000,
    emptyRoomTtlMs: integer(env, 'EMPTY_ROOM_TTL_SECONDS', 300) * 1000,
    reconnectGraceMs: integer(env, 'RECONNECT_GRACE_SECONDS', 30) * 1000,
  };
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} muss eine nicht-negative Ganzzahl sein (ist: "${raw}")`);
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} muss true oder false sein (ist: "${raw}")`);
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Prüft einen Origin gegen Muster wie `chrome-extension://abc…` oder `moz-extension://*`. */
export function isOriginAllowed(origin: string | undefined, patterns: string[]): boolean {
  if (!patterns.length) return true;
  if (!origin) return false;
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(origin);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
