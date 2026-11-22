import http, { type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { isOriginAllowed } from './config.ts';
import {
  PROTOCOL_VERSION,
  TICKET_MAX_LENGTH,
  TOKEN_MAX_LENGTH,
  type CloseReason,
  type ErrorCode,
  type PlaybackAction,
  type ServerInfo,
  type ServerMessage,
} from './protocol.ts';
import {
  Room,
  generateCode,
  isControlMode,
  isValidInstallId,
  isValidPosition,
  normalizeCode,
  sanitizeName,
  sanitizeUrl,
  type Connection,
  type Member,
  type RoomLimits,
} from './rooms.ts';

const RATE_LIMIT_PER_SECOND = 30;
const SYNC_REQUEST_COOLDOWN_MS = 2000;
const CLOSING_WARNING_MS = 10 * 60_000;
const MAX_RESUME_TOKEN_LENGTH = 128;
const AUTH_ATTEMPTS_PER_MINUTE = 10;
const MAX_BACKLOG = 32; // Nachrichten, die während einer laufenden Prüfung (auth, create) warten
const MAX_PAYLOAD_BYTES = 8 * 1024; // reicht für `create` mit Ticket (bis TICKET_MAX_LENGTH Zeichen)
const TICKET_INVALID_MESSAGE = 'Der Raum konnte nicht erstellt werden. Bitte versuch es noch einmal.';

// Gilt für src/ (Type Stripping) und dist/ (Paket) gleichermaßen.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Ergebnis von `hooks.authenticate`: der geprüfte Account. */
export interface AccountContext {
  id: string;
  name?: string | null;
  expiresAt?: number | null; // ms; danach gilt die Verbindung wieder als nicht angemeldet
}

/** Gemeinsame Angaben aller Raum-Ereignisse (für Statistik-Hooks). */
export interface RoomEvent {
  at: number;
  code: string;
  url: string | null;
  createdAt: number;
  ownerAccountId: string | null; // Account des Erstellers, falls angemeldet
  memberCount: number;
}

export interface MemberEvent extends RoomEvent {
  memberId: string;
  accountId: string | null;
}

export type LeaveReason = 'left' | 'kicked' | 'banned' | 'timeout';

/** Ergebnis von `hooks.canCreateRoom`, wenn kein neuer Raum entstehen darf. */
export interface RoomRejection {
  code: Extract<ErrorCode, 'server_full' | 'maintenance' | 'ticket_invalid'>;
  message: string; // geht als `error.message` an den Client
}

/**
 * Ergebnis von `hooks.canCreateRoom`: Raum erlaubt, aber mit diesem Code (z. B. aus einem geprüften
 * Ticket). Der Code wird normalisiert (trim, Großbuchstaben) und geprüft; ungültig oder schon vergeben
 * → `error` mit `ticket_invalid`, kein Raum.
 */
export interface RoomGrant {
  roomCode: string;
}

/** null = erlaubt (Code zufällig), `RoomGrant` = erlaubt mit vorgegebenem Code, `RoomRejection` = abgelehnt. */
export type CreateRoomDecision = RoomRejection | RoomGrant | null;

/** Weitere Angaben aus der `create`-Nachricht für `hooks.canCreateRoom`. */
export interface CreateRoomContext {
  ticket: string | null; // Feld `ticket` der Nachricht, null = nicht mitgeschickt
}

/**
 * Erweiterungspunkte, z. B. für die offizielle Instanz. Ohne Hooks verhält sich der Server wie ein
 * selbst gehosteter ohne Accounts. Ereignis-Hooks dürfen asynchron sein; Fehler darin werden nur
 * protokolliert und beeinflussen den Raum nicht.
 */
export interface ServerHooks {
  /** Prüft das Token aus `{ type: 'auth' }`. Ohne diesen Hook lehnt der Server `auth` ab. */
  authenticate?(token: string, req: IncomingMessage): Promise<AccountContext | null> | AccountContext | null;
  /**
   * Darf ein neuer Raum entstehen? null = ja (zufälliger Code); `{ roomCode }` = ja, mit genau diesem
   * Code (ungültig oder vergeben → `ticket_invalid`); `RoomRejection` = nein, der Client bekommt `error`
   * mit diesem Code und bleibt in seinem bisherigen Raum. `ctx.ticket` ist das Ticket aus `create`.
   * Darf ein Promise liefern (z. B. Signaturprüfung mit WebCrypto); folgende Nachrichten des Clients
   * warten so lange. Fehler im Hook (auch ein abgelehntes Promise) werden protokolliert, der Raum wird
   * zugelassen – wer ein Ticket verlangt, fängt eigene Fehler ab und lehnt mit `ticket_invalid` ab.
   */
  canCreateRoom?(
    req: IncomingMessage,
    account: AccountContext | null,
    ctx: CreateRoomContext,
  ): CreateRoomDecision | Promise<CreateRoomDecision>;
  /** Grenzen für einen neuen Raum, etwa abhängig vom Account des Erstellers. */
  roomLimits?(req: IncomingMessage, defaults: RoomLimits, account: AccountContext | null): RoomLimits;
  onRoomCreated?(event: RoomEvent): unknown;
  onRoomClosed?(event: RoomEvent & { reason: CloseReason | 'empty' }): unknown;
  /**
   * Mitglied ist im Raum. `resumed: true` = per `resumeToken` zurückgekehrt (dasselbe Mitglied wie
   * zuvor); das ist auch die Rückkehr nach `onMemberDisconnected`, einen eigenen Reconnect-Hook gibt
   * es nicht. `resumed: true` kommt auch ohne vorherige Trennung vor (z. B. neuer Tab übernimmt das
   * Mitglied), Auswertungen sollten es daher idempotent behandeln.
   */
  onMemberJoined?(event: MemberEvent & { resumed: boolean }): unknown;
  /**
   * Verbindung eines Mitglieds abgebrochen; es bleibt während der Wiederverbindungs-Frist im Raum
   * (zählt in `memberCount` mit). Danach folgt genau eins: `onMemberJoined` mit `resumed: true`,
   * `onMemberLeft` (`timeout`, `kicked`, `banned`) oder `onRoomClosed`.
   */
  onMemberDisconnected?(event: MemberEvent): unknown;
  onMemberLeft?(event: MemberEvent & { reason: LeaveReason }): unknown;
  onPlayback?(event: MemberEvent & { action: PlaybackAction | 'sync'; position: number; playing: boolean }): unknown;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  trustProxy?: boolean; // X-Forwarded-For auswerten (nur hinter einem Reverse Proxy!)
  allowedOrigins?: string[]; // leer = alle erlaubt
  maxConnectionsPerIp?: number; // 0 = unbegrenzt
  maxRoomMembers?: number; // 0 = unbegrenzt
  maxRoomDurationMs?: number; // 0 = unbegrenzt
  idleTimeoutMs?: number; // 0 = aus
  emptyRoomTtlMs?: number;
  reconnectGraceMs?: number;
  heartbeatMs?: number;
  maintenanceMs?: number;
  now?: () => number;
  hooks?: ServerHooks;
}

export interface SyncServer {
  port: number;
  rooms: Map<string, Room>;
  /** Raumpflege: abgelaufene Verbindungen, inaktive/abgelaufene/leere Räume. */
  maintain(): void;
  /** Schließt einen Raum sofort (alle erhalten `roomClosed`). false = Raum gibt es nicht (mehr). */
  closeRoom(code: string, reason?: CloseReason): boolean;
  close(): Promise<void>;
}

interface Client {
  readonly ws: WebSocket;
  readonly req: IncomingMessage;
  readonly conn: Connection;
  room: Room | null;
  member: Member | null;
  isAlive: boolean;
  rate: { windowStart: number; count: number };
  account: AccountContext | null;
  authRate: { windowStart: number; count: number };
  backlog: Incoming[] | null; // gesetzt, solange eine Anmeldung oder ein `create` geprüft wird
}

type Incoming = Record<string, unknown> & { type: string };

const isPromiseLike = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

export async function startServer(options: ServerOptions = {}): Promise<SyncServer> {
  const {
    port = 8080,
    host,
    trustProxy = false,
    allowedOrigins = [],
    maxConnectionsPerIp = 0,
    maxRoomMembers = 20,
    maxRoomDurationMs = 0,
    idleTimeoutMs = 30 * 60_000,
    emptyRoomTtlMs = 5 * 60_000,
    reconnectGraceMs = 30_000,
    heartbeatMs = 30_000,
    maintenanceMs = 5_000,
    now = Date.now,
    hooks = {},
  } = options;

  const serverInfo: ServerInfo = {
    protocol: PROTOCOL_VERSION,
    version: pkg.version,
    limits: {
      maxRoomMembers,
      maxRoomDurationMinutes: Math.round(maxRoomDurationMs / 60_000),
      idleTimeoutMinutes: Math.round(idleTimeoutMs / 60_000),
    },
    features: hooks.authenticate ? ['accounts'] : [],
  };

  const rooms = new Map<string, Room>();
  const clients = new Map<WebSocket, Client>();
  const clientByConn = new WeakMap<Connection, Client>();
  const connectionsPerIp = new Map<string, number>();

  // -------------------------------------------------------------------------
  // HTTP + Upgrade
  // -------------------------------------------------------------------------

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Öffentlich erreichbar: bewusst keine Version, Raum- oder Verbindungszahlen
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Synchrothek-Server: WebSocket-Verbindung erwartet\n');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const clientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      // Letzter Eintrag = vom eigenen Proxy gesetzt; frühere Einträge kann der Client fälschen
      if (typeof forwarded === 'string' && forwarded) return forwarded.split(',').at(-1)!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) return reject(403, 'Forbidden');
    const ip = clientIp(req);
    if (maxConnectionsPerIp > 0 && (connectionsPerIp.get(ip) ?? 0) >= maxConnectionsPerIp) {
      return reject(429, 'Too Many Requests');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const n = (connectionsPerIp.get(ip) ?? 1) - 1;
        if (n > 0) connectionsPerIp.set(ip, n);
        else connectionsPerIp.delete(ip);
      });
      onConnection(ws, req);
    });
  });

  // -------------------------------------------------------------------------
  // Verbindungen
  // -------------------------------------------------------------------------

  function onConnection(ws: WebSocket, req: IncomingMessage) {
    const conn: Connection = {
      send(msg: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    const client: Client = {
      ws,
      req,
      conn,
      room: null,
      member: null,
      isAlive: true,
      rate: { windowStart: 0, count: 0 },
      account: null,
      authRate: { windowStart: 0, count: 0 },
      backlog: null,
    };
    clients.set(ws, client);
    clientByConn.set(conn, client);

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('message', (data, isBinary) => onMessage(client, data, isBinary));
    ws.on('close', () => {
      clients.delete(ws);
      onDisconnect(client);
    });
    ws.on('error', () => {});

    conn.send({ type: 'welcome', serverTime: now(), server: serverInfo });
  }

  function onMessage(client: Client, data: RawData, isBinary: boolean) {
    if (isBinary) return;
    const t = Date.now();
    if (t - client.rate.windowStart >= 1000) client.rate = { windowStart: t, count: 0 };
    if (++client.rate.count > RATE_LIMIT_PER_SECOND) return;

    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return error(client, 'bad_json', 'Ungültiges JSON');
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as Incoming).type !== 'string') {
      return error(client, 'bad_message', 'Ungültige Nachricht');
    }
    // Während eine Anmeldung oder ein asynchroner `canCreateRoom` geprüft wird, warten folgende
    // Nachrichten, damit z. B. ein direkt danach gesendetes `create` schon die Grenzen des Accounts
    // bekommt und ein `play` erst im neuen Raum ankommt.
    if (client.backlog) {
      if (client.backlog.length >= MAX_BACKLOG) return error(client, 'rate_limited', 'Zu viele Nachrichten');
      client.backlog.push(msg as Incoming);
      return;
    }
    handle(client, msg as Incoming);
  }

  const send = (client: Client, msg: ServerMessage) => client.conn.send(msg);
  const error = (client: Client, code: ErrorCode, message: string) => send(client, { type: 'error', code, message });

  function handle(client: Client, msg: Incoming) {
    switch (msg.type) {
      case 'ping':
        return send(client, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : undefined, serverTime: now() });
      case 'auth':
        return void onAuth(client, msg);
      case 'create':
        return onCreate(client, msg);
      case 'join':
        return onJoin(client, msg);
      case 'leave':
        leave(client);
        return send(client, { type: 'left' });
      case 'play':
      case 'pause':
      case 'seek':
        return onPlayback(client, msg.type, msg);
      case 'setName':
        return onSetName(client, msg);
      case 'kick':
        return onKick(client, msg);
      case 'transferHost':
        return onTransferHost(client, msg);
      case 'updateSettings':
        return onUpdateSettings(client, msg);
      case 'syncRequest':
        return onSyncRequest(client);
      case 'hostPosition':
        return onHostPosition(client, msg);
      default:
        return error(client, 'unknown_type', 'Unbekannter Nachrichtentyp');
    }
  }

  // -------------------------------------------------------------------------
  // Accounts und Hooks
  // -------------------------------------------------------------------------

  /** Ruft einen Hook auf, ohne dass ein Fehler darin den Server oder den Raum stört. */
  function safely(name: string, call: () => unknown) {
    try {
      Promise.resolve(call()).catch((err) => console.error(`Hook ${name} fehlgeschlagen:`, err));
    } catch (err) {
      console.error(`Hook ${name} fehlgeschlagen:`, err);
    }
  }

  const roomEvent = (room: Room): RoomEvent => ({
    at: now(),
    code: room.code,
    url: room.url,
    createdAt: room.createdAt,
    ownerAccountId: room.ownerAccountId,
    memberCount: room.members.size,
  });

  const memberEvent = (room: Room, member: Member): MemberEvent => ({
    ...roomEvent(room),
    memberId: member.id,
    accountId: member.accountId,
  });

  /** Account der Verbindung, solange die Anmeldung gilt. */
  function currentAccount(client: Client): AccountContext | null {
    const account = client.account;
    if (account?.expiresAt != null && account.expiresAt <= now()) client.account = null;
    return client.account;
  }

  async function onAuth(client: Client, msg: Incoming) {
    const authenticate = hooks.authenticate;
    if (!authenticate) return error(client, 'auth_unsupported', 'Dieser Server unterstützt keine Accounts');
    const t = Date.now();
    if (t - client.authRate.windowStart >= 60_000) client.authRate = { windowStart: t, count: 0 };
    if (++client.authRate.count > AUTH_ATTEMPTS_PER_MINUTE) {
      return error(client, 'rate_limited', 'Zu viele Anmeldeversuche');
    }
    const token = msg.token;
    let account: AccountContext | null = null;
    if (typeof token === 'string' && token.length > 0 && token.length <= TOKEN_MAX_LENGTH) {
      client.backlog = [];
      try {
        account = (await authenticate(token, client.req)) ?? null;
      } catch (err) {
        console.error('Hook authenticate fehlgeschlagen:', err);
      }
    }
    if (account && (typeof account.id !== 'string' || !account.id)) account = null;
    if (account?.expiresAt != null && account.expiresAt <= now()) account = null;

    // Eine fehlgeschlagene Anmeldung meldet auch eine bestehende ab (z. B. widerrufenes Token).
    client.account = account;
    if (client.member) client.member.accountId = account?.id ?? null;
    if (account) {
      send(client, {
        type: 'authenticated',
        account: { id: account.id, name: account.name ?? null, expiresAt: account.expiresAt ?? null },
      });
    } else {
      error(client, 'auth_failed', 'Anmeldung fehlgeschlagen');
    }

    drainBacklog(client);
  }

  /** Wartende Nachrichten nach einer Prüfung der Reihe nach verarbeiten. */
  function drainBacklog(client: Client) {
    const backlog = client.backlog ?? [];
    client.backlog = null;
    while (backlog.length) {
      if (client.backlog) {
        // Eine wartende Nachricht startet selbst eine Prüfung (`auth`, `create`): Rest wartet darauf.
        (client.backlog as Incoming[]).push(...backlog);
        break;
      }
      handle(client, backlog.shift()!);
    }
  }

  // -------------------------------------------------------------------------
  // Raum betreten / verlassen
  // -------------------------------------------------------------------------

  function identity(client: Client, msg: Incoming): { name: string; installId: string } | null {
    const name = sanitizeName(msg.name);
    if (!name || !isValidInstallId(msg.installId)) {
      error(client, 'bad_message', 'Name oder Installations-ID fehlt oder ist ungültig');
      return null;
    }
    return { name, installId: msg.installId };
  }

  function attach(client: Client, room: Room, member: Member, resumed = false) {
    client.room = room;
    client.member = member;
    const t = now();
    send(client, { type: 'joined', memberId: member.id, resumeToken: member.resumeToken, room: room.snapshot(t) });
    room.broadcast({ type: 'room', room: room.snapshot(t) }, member.id);
    safely('onMemberJoined', () => hooks.onMemberJoined?.({ ...memberEvent(room, member), resumed }));
  }

  function detach(client: Client | undefined) {
    if (!client) return;
    client.room = null;
    client.member = null;
  }

  function onCreate(client: Client, msg: Incoming) {
    const id = identity(client, msg);
    if (!id) return;
    let ticket: string | null = null;
    if (msg.ticket !== undefined && msg.ticket !== null) {
      if (typeof msg.ticket !== 'string' || !msg.ticket || msg.ticket.length > TICKET_MAX_LENGTH) {
        return error(client, 'bad_message', 'Ungültiges Ticket');
      }
      ticket = msg.ticket;
    }
    const account = currentAccount(client);
    // Vor `leave`: Bei Ablehnung bleibt der Client in seinem bisherigen Raum.
    let decision: CreateRoomDecision | Promise<CreateRoomDecision> = null;
    try {
      decision = hooks.canCreateRoom?.(client.req, account, { ticket }) ?? null;
    } catch (err) {
      console.error('Hook canCreateRoom fehlgeschlagen:', err);
    }
    if (!isPromiseLike(decision)) return createRoom(client, msg, id, account, decision);

    // Asynchron: folgende Nachrichten warten, bis entschieden ist.
    client.backlog ??= [];
    Promise.resolve(decision)
      .then(
        (result) => result ?? null,
        (err: unknown) => {
          console.error('Hook canCreateRoom fehlgeschlagen:', err);
          return null;
        },
      )
      .then((result) => {
        // Verbindung inzwischen weg: kein Raum (er hätte ein Mitglied ohne Verbindung, das nie verfällt).
        if (clients.get(client.ws) === client) createRoom(client, msg, id, account, result);
      })
      .catch((err: unknown) => console.error('Raum erstellen fehlgeschlagen:', err))
      .finally(() => {
        if (clients.get(client.ws) === client) drainBacklog(client);
      });
  }

  function createRoom(
    client: Client,
    msg: Incoming,
    id: { name: string; installId: string },
    account: AccountContext | null,
    decision: CreateRoomDecision,
  ) {
    let code: string | null = null;
    if (decision && 'roomCode' in decision) {
      code = normalizeCode(decision.roomCode);
      if (!code || rooms.has(code)) return error(client, 'ticket_invalid', TICKET_INVALID_MESSAGE);
    } else if (decision && 'code' in decision) {
      return error(client, decision.code, decision.message);
    }
    leave(client);
    const t = now();
    const defaults: RoomLimits = { maxMembers: maxRoomMembers, maxDurationMs: maxRoomDurationMs };
    let limits = defaults;
    try {
      limits = hooks.roomLimits?.(client.req, defaults, account) ?? defaults;
    } catch (err) {
      console.error('Hook roomLimits fehlgeschlagen:', err);
    }
    const room = new Room(code ?? generateCode((c) => rooms.has(c)), t, limits);
    room.url = sanitizeUrl(msg.url);
    room.ownerAccountId = account?.id ?? null;
    rooms.set(room.code, room);
    safely('onRoomCreated', () => hooks.onRoomCreated?.(roomEvent(room)));
    attach(client, room, room.addMember(id.name, id.installId, client.conn, t, account?.id ?? null));
  }

  function onJoin(client: Client, msg: Incoming) {
    const code = normalizeCode(msg.code);
    const room = code ? rooms.get(code) : undefined;
    if (!room) return error(client, 'room_not_found', 'Raum nicht gefunden');
    const id = identity(client, msg);
    if (!id) return;
    const account = currentAccount(client);

    // Wiederverbinden: dasselbe Mitglied (inkl. Host-Rolle) übernehmen
    const token = msg.resumeToken;
    const resumed =
      typeof token === 'string' && token.length <= MAX_RESUME_TOKEN_LENGTH ? room.findByResumeToken(token) : null;
    if (resumed) {
      if (client.member !== resumed) leave(client);
      if (resumed.conn && resumed.conn !== client.conn) detach(clientByConn.get(resumed.conn));
      resumed.conn = client.conn;
      resumed.disconnectedAt = null;
      resumed.name = id.name;
      if (account) resumed.accountId = account.id;
      return attach(client, room, resumed, true);
    }

    if (room.bans.has(id.installId) || (account && room.bans.has(accountBan(account.id)))) {
      return error(client, 'banned', 'Du wurdest aus diesem Raum verbannt');
    }
    if (room.isFull()) return error(client, 'room_full', 'Der Raum ist voll');
    leave(client);
    attach(client, room, room.addMember(id.name, id.installId, client.conn, now(), account?.id ?? null));
  }

  // Banns gelten für die Installation und, falls angemeldet, auch für den Account.
  // Installations-IDs enthalten keinen Doppelpunkt, daher keine Verwechslung.
  const accountBan = (accountId: string) => `account:${accountId}`;

  function leave(client: Client) {
    const { room, member } = client;
    if (!room || !member) return;
    detach(client);
    const t = now();
    room.removeMember(member.id, t);
    if (room.members.size) room.broadcastRoom(t);
    safely('onMemberLeft', () => hooks.onMemberLeft?.({ ...memberEvent(room, member), reason: 'left' }));
  }

  /** Verbindung weg: Mitglied bleibt für die Wiederverbindungs-Frist erhalten. */
  function onDisconnect(client: Client) {
    const { room, member } = client;
    if (!room || !member || member.conn !== client.conn) return;
    const t = now();
    member.conn = null;
    member.disconnectedAt = t;
    room.broadcastRoom(t);
    safely('onMemberDisconnected', () => hooks.onMemberDisconnected?.(memberEvent(room, member)));
  }

  // -------------------------------------------------------------------------
  // Wiedergabe
  // -------------------------------------------------------------------------

  function requireMember(client: Client): { room: Room; member: Member } | null {
    if (client.room && client.member) return { room: client.room, member: client.member };
    error(client, 'not_in_room', 'Nicht in einem Raum');
    return null;
  }

  function requireHost(client: Client): { room: Room; member: Member } | null {
    const ctx = requireMember(client);
    if (ctx && ctx.room.hostId !== ctx.member.id) {
      error(client, 'not_host', 'Nur der Host darf das');
      return null;
    }
    return ctx;
  }

  function onPlayback(client: Client, action: PlaybackAction, msg: Incoming) {
    const ctx = requireMember(client);
    if (!ctx) return;
    const { room, member } = ctx;
    if (!isValidPosition(msg.position)) return error(client, 'bad_position', 'Ungültige Position');
    const t = now();
    if (room.settings.controlMode === 'host' && member.id !== room.hostId) {
      error(client, 'not_allowed', 'In diesem Raum steuert nur der Host');
      // Aktuellen Stand zurückschicken, damit der Player zurückgesetzt wird
      return send(client, { type: 'state', action: 'sync', by: null, ...room.playbackSnapshot(t) });
    }
    room.applyPlayback(action, msg.position, t);
    const url = sanitizeUrl(msg.url);
    if (url) room.url = url;
    room.broadcast({ type: 'state', action, by: member.id, ...room.playbackSnapshot(t) }, member.id);
    emitPlayback(room, member, action);
  }

  function emitPlayback(room: Room, member: Member, action: PlaybackAction | 'sync') {
    safely('onPlayback', () =>
      hooks.onPlayback?.({ ...memberEvent(room, member), action, position: room.position, playing: room.playing }),
    );
  }

  function onSyncRequest(client: Client) {
    const ctx = requireMember(client);
    if (!ctx) return;
    const { room, member } = ctx;
    if (member.id === room.hostId) return;
    const t = now();
    if (t - room.lastSyncRequestAt < SYNC_REQUEST_COOLDOWN_MS) return; // Anfrage läuft bereits
    const host = room.host();
    if (!host?.conn) return error(client, 'host_unavailable', 'Der Host ist gerade nicht verbunden');
    room.lastSyncRequestAt = t;
    host.conn.send({ type: 'positionRequest' });
  }

  function onHostPosition(client: Client, msg: Incoming) {
    const ctx = requireHost(client);
    if (!ctx) return;
    if (!isValidPosition(msg.position) || typeof msg.playing !== 'boolean') {
      return error(client, 'bad_position', 'Ungültige Position');
    }
    const { room, member } = ctx;
    const t = now();
    room.applyPlayback(msg.playing ? 'play' : 'pause', msg.position, t);
    room.broadcast({ type: 'state', action: 'sync', by: member.id, ...room.playbackSnapshot(t) }, member.id);
    emitPlayback(room, member, 'sync');
  }

  // -------------------------------------------------------------------------
  // Mitglieder und Einstellungen
  // -------------------------------------------------------------------------

  function onSetName(client: Client, msg: Incoming) {
    const ctx = requireMember(client);
    if (!ctx) return;
    const name = sanitizeName(msg.name);
    if (!name) return error(client, 'bad_message', 'Ungültiger Name');
    ctx.member.name = name;
    ctx.room.broadcastRoom(now());
  }

  function targetMember(client: Client, room: Room, self: Member, memberId: unknown): Member | null {
    const target = typeof memberId === 'string' ? room.members.get(memberId) : undefined;
    if (!target || target === self) {
      error(client, 'bad_member', 'Unbekanntes Mitglied');
      return null;
    }
    return target;
  }

  function onKick(client: Client, msg: Incoming) {
    const ctx = requireHost(client);
    if (!ctx) return;
    const { room, member } = ctx;
    const target = targetMember(client, room, member, msg.memberId);
    if (!target) return;
    const banned = msg.ban === true;
    if (banned) {
      room.bans.add(target.installId);
      if (target.accountId) room.bans.add(accountBan(target.accountId));
    }
    target.conn?.send({ type: 'kicked', banned });
    if (target.conn) detach(clientByConn.get(target.conn));
    const t = now();
    room.removeMember(target.id, t);
    room.lastActivityAt = t;
    room.broadcastRoom(t);
    safely('onMemberLeft', () =>
      hooks.onMemberLeft?.({ ...memberEvent(room, target), reason: banned ? 'banned' : 'kicked' }),
    );
  }

  function onTransferHost(client: Client, msg: Incoming) {
    const ctx = requireHost(client);
    if (!ctx) return;
    const { room, member } = ctx;
    const target = targetMember(client, room, member, msg.memberId);
    if (!target) return;
    if (!target.conn) return error(client, 'bad_member', 'Dieses Mitglied ist gerade nicht verbunden');
    const t = now();
    room.hostId = target.id;
    room.lastActivityAt = t;
    room.broadcastRoom(t);
  }

  function onUpdateSettings(client: Client, msg: Incoming) {
    const ctx = requireHost(client);
    if (!ctx) return;
    const { room } = ctx;
    const next = { ...room.settings };

    if (msg.maxMembers !== undefined) {
      const value = msg.maxMembers;
      const serverMax = room.limits.maxMembers;
      const valid =
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (serverMax > 0 ? value >= 1 && value <= serverMax : value >= 0);
      if (!valid) {
        const range = serverMax > 0 ? `1 bis ${serverMax}` : '0 (unbegrenzt) oder mehr';
        return error(client, 'bad_message', `Teilnehmerlimit muss zwischen ${range} liegen`);
      }
      next.maxMembers = value;
    }
    if (msg.controlMode !== undefined) {
      if (!isControlMode(msg.controlMode)) return error(client, 'bad_message', 'Ungültiger Steuerungsmodus');
      next.controlMode = msg.controlMode;
    }

    const t = now();
    room.settings = next;
    room.lastActivityAt = t;
    room.broadcastRoom(t);
  }

  // -------------------------------------------------------------------------
  // Pflege
  // -------------------------------------------------------------------------

  function closeRoom(room: Room, reason: CloseReason) {
    room.broadcast({ type: 'roomClosed', reason });
    for (const member of room.members.values()) if (member.conn) detach(clientByConn.get(member.conn));
    rooms.delete(room.code);
    safely('onRoomClosed', () => hooks.onRoomClosed?.({ ...roomEvent(room), reason }));
  }

  function maintain() {
    const t = now();
    for (const [code, room] of rooms) {
      let changed = false;
      for (const member of [...room.members.values()]) {
        if (member.conn === null && member.disconnectedAt !== null && t - member.disconnectedAt >= reconnectGraceMs) {
          room.removeMember(member.id, t);
          changed = true;
          safely('onMemberLeft', () => hooks.onMemberLeft?.({ ...memberEvent(room, member), reason: 'timeout' }));
        }
      }

      if (room.members.size === 0) {
        if (room.emptySince !== null && t - room.emptySince >= emptyRoomTtlMs) {
          rooms.delete(code);
          safely('onRoomClosed', () => hooks.onRoomClosed?.({ ...roomEvent(room), reason: 'empty' }));
        }
        continue;
      }
      if (room.closesAt !== null) {
        if (t >= room.closesAt) {
          closeRoom(room, 'duration');
          continue;
        }
        if (!room.closingWarned && room.closesAt - t <= CLOSING_WARNING_MS) {
          room.closingWarned = true;
          room.broadcast({ type: 'roomClosing', reason: 'duration', closesAt: room.closesAt });
        }
      }
      if (idleTimeoutMs > 0 && !room.playing && t - room.lastActivityAt >= idleTimeoutMs) {
        closeRoom(room, 'idle');
        continue;
      }
      if (changed) room.broadcastRoom(t);
    }
  }

  function heartbeat() {
    for (const client of clients.values()) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }

  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  const maintenanceTimer = setInterval(maintain, maintenanceMs);
  heartbeatTimer.unref();
  maintenanceTimer.unref();

  httpServer.listen(port, host);
  await once(httpServer, 'listening');
  const address = httpServer.address();

  return {
    port: typeof address === 'object' && address ? address.port : port,
    rooms,
    maintain,
    closeRoom(code, reason = 'admin') {
      const room = rooms.get(normalizeCode(code) ?? '');
      if (!room) return false;
      closeRoom(room, reason);
      return true;
    },
    async close() {
      clearInterval(heartbeatTimer);
      clearInterval(maintenanceTimer);
      for (const room of [...rooms.values()]) closeRoom(room, 'shutdown');
      for (const client of clients.values()) client.ws.close(1001, 'Server wird beendet');
      await new Promise((resolve) => setTimeout(resolve, 50)); // Abschlussnachrichten zustellen
      for (const client of clients.values()) client.ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
