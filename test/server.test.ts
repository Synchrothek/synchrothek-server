import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, type ClientOptions } from 'ws';
import { startServer, type ServerHooks, type ServerOptions, type SyncServer } from '../src/server.ts';
import { normalizeCode, sanitizeName, sanitizeUrl, generateCode } from '../src/rooms.ts';
import { loadConfig } from '../src/config.ts';
import { CODE_LENGTH, type ServerMessage, type RoomSnapshot } from '../src/protocol.ts';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

let server: SyncServer;
let clock: number;
const sockets: WebSocket[] = [];

async function start(options: ServerOptions = {}) {
  clock = 1_000_000;
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    heartbeatMs: 60_000,
    maintenanceMs: 60_000,
    emptyRoomTtlMs: 1000,
    reconnectGraceMs: 30_000,
    now: () => clock,
    ...options,
  });
}

beforeEach(() => start());

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.close();
});

interface TestClient {
  ws: WebSocket;
  queue: ServerMessage[];
  send(msg: object): void;
  next<T extends ServerMessage['type']>(type: T, timeout?: number): Promise<Msg<T>>;
  none(type: ServerMessage['type']): Promise<void>;
}

let installCounter = 0;

async function connect(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  sockets.push(ws);
  const queue: ServerMessage[] = [];
  const waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const client: TestClient = {
    ws,
    queue,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(type, timeout = 1000) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0] as never);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve: resolve as (m: ServerMessage) => void };
        waiters.push(waiter);
        setTimeout(() => {
          const j = waiters.indexOf(waiter);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`Timeout beim Warten auf "${type}"`));
          }
        }, timeout);
      });
    },
    async none(type) {
      await settle();
      assert.equal(queue.filter((m) => m.type === type).length, 0, `unerwartete Nachricht "${type}"`);
    },
  };
  await once(ws, 'open');
  await client.next('welcome');
  return client;
}

const identity = (name: string) => ({ name, installId: `install-${++installCounter}-xxxx` });
const settle = () => new Promise((r) => setTimeout(r, 50));

async function create(name = 'Anna') {
  const c = await connect();
  const id = identity(name);
  c.send({ type: 'create', url: 'https://www.ardmediathek.de/video/abc', ...id });
  const joined = await c.next('joined');
  return { c, joined, id, code: joined.room.code };
}

async function join(code: string, name = 'Ben', extra: object = {}) {
  const c = await connect();
  const id = identity(name);
  c.send({ type: 'join', code, ...id, ...extra });
  return { c, id, joined: await c.next('joined') };
}

async function roomWithTwo() {
  const host = await create('Anna');
  const guest = await join(host.code.toLowerCase(), 'Ben');
  await host.c.next('room');
  return { host, guest, code: host.code };
}

const memberNames = (room: RoomSnapshot) => room.members.map((m) => m.name).sort();

// ---------------------------------------------------------------------------

test('Begrüßung enthält Server-Infos und Grenzen', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  sockets.push(ws);
  const [data] = await once(ws, 'message');
  const welcome = JSON.parse(data.toString()) as Msg<'welcome'>;
  assert.equal(welcome.server.protocol, 2);
  assert.equal(welcome.server.limits.maxRoomMembers, 20);
  assert.equal(welcome.server.limits.idleTimeoutMinutes, 30);
  assert.deepEqual(welcome.server.features, []);
});

test('Raum erstellen: Ersteller ist Host', async () => {
  const { joined } = await create('Anna');
  assert.equal(joined.room.code.length, CODE_LENGTH);
  assert.equal(joined.room.hostId, joined.memberId);
  assert.deepEqual(memberNames(joined.room), ['Anna']);
  assert.equal(joined.room.memberLimit, 20);
  assert.equal(joined.room.playing, false);
  assert.equal(joined.room.url, 'https://www.ardmediathek.de/video/abc');
  assert.ok(joined.resumeToken.length >= 40);
});

test('Beitreten meldet allen die Mitgliederliste', async () => {
  const { guest, host } = await roomWithTwo();
  assert.deepEqual(memberNames(guest.joined.room), ['Anna', 'Ben']);
  assert.equal(guest.joined.room.hostId, host.joined.memberId);
});

test('Ungültige Identität wird abgelehnt', async () => {
  const c = await connect();
  c.send({ type: 'create', name: '   ', installId: 'install-ok-1' });
  assert.equal((await c.next('error')).code, 'bad_message');
  c.send({ type: 'create', name: 'Anna', installId: 'x' });
  assert.equal((await c.next('error')).code, 'bad_message');
});

test('Play wird an andere verteilt, nicht an den Absender', async () => {
  const { host, guest } = await roomWithTwo();
  host.c.send({ type: 'play', position: 10 });
  const msg = await guest.c.next('state');
  assert.deepEqual([msg.action, msg.playing, msg.position, msg.by], ['play', true, 10, host.joined.memberId]);
  await host.c.none('state');
});

test('Position wird bei laufender Wiedergabe hochgerechnet', async () => {
  const { host, code } = await roomWithTwo();
  host.c.send({ type: 'play', position: 10 });
  await settle();
  clock += 5000;
  const late = await join(code, 'Carla');
  assert.equal(late.joined.room.playing, true);
  assert.equal(late.joined.room.position, 15);
});

test('Pause und Seek', async () => {
  const { host, guest } = await roomWithTwo();
  host.c.send({ type: 'play', position: 0 });
  await guest.c.next('state');
  clock += 2000;
  guest.c.send({ type: 'pause', position: 2.1 });
  const paused = await host.c.next('state');
  assert.deepEqual([paused.playing, paused.position], [false, 2.1]);
  host.c.send({ type: 'seek', position: 120 });
  const seeked = await guest.c.next('state');
  assert.deepEqual([seeked.action, seeked.playing, seeked.position], ['seek', false, 120]);
});

test('Fehler: unbekannter Raum, nicht im Raum, ungültige Position', async () => {
  const c = await connect();
  c.send({ type: 'join', code: 'ZZZZZZ', ...identity('X') });
  assert.equal((await c.next('error')).code, 'room_not_found');
  c.send({ type: 'play', position: 1 });
  assert.equal((await c.next('error')).code, 'not_in_room');
  const { c: h } = await create();
  h.send({ type: 'seek', position: -1 });
  assert.equal((await h.next('error')).code, 'bad_position');
  h.send({ type: 'seek', position: 'abc' });
  assert.equal((await h.next('error')).code, 'bad_position');
});

test('Steuerungsmodus „nur Host“: Gäste werden zurückgesetzt', async () => {
  const { host, guest } = await roomWithTwo();
  host.c.send({ type: 'updateSettings', controlMode: 'host' });
  assert.equal((await guest.c.next('room')).room.settings.controlMode, 'host');
  await host.c.next('room');

  guest.c.send({ type: 'play', position: 50 });
  assert.equal((await guest.c.next('error')).code, 'not_allowed');
  const reset = await guest.c.next('state');
  assert.deepEqual([reset.playing, reset.position], [false, 0]);
  await host.c.none('state');

  host.c.send({ type: 'play', position: 5 });
  assert.equal((await guest.c.next('state')).position, 5);
});

test('Nur der Host darf Einstellungen ändern, kicken und übergeben', async () => {
  const { host, guest } = await roomWithTwo();
  guest.c.send({ type: 'updateSettings', controlMode: 'host' });
  assert.equal((await guest.c.next('error')).code, 'not_host');
  guest.c.send({ type: 'kick', memberId: host.joined.memberId });
  assert.equal((await guest.c.next('error')).code, 'not_host');
  guest.c.send({ type: 'transferHost', memberId: guest.joined.memberId });
  assert.equal((await guest.c.next('error')).code, 'not_host');
});

test('Kicken: Mitglied fliegt raus, darf aber wieder beitreten', async () => {
  const { host, guest, code } = await roomWithTwo();
  host.c.send({ type: 'kick', memberId: guest.joined.memberId });
  assert.equal((await guest.c.next('kicked')).banned, false);
  assert.deepEqual(memberNames((await host.c.next('room')).room), ['Anna']);
  guest.c.send({ type: 'play', position: 1 });
  assert.equal((await guest.c.next('error')).code, 'not_in_room');

  guest.c.send({ type: 'join', code, ...guest.id });
  assert.ok(await guest.c.next('joined'));
});

test('Bannen: dieselbe Installation kommt nicht wieder rein', async () => {
  const { host, guest, code } = await roomWithTwo();
  host.c.send({ type: 'kick', memberId: guest.joined.memberId, ban: true });
  assert.equal((await guest.c.next('kicked')).banned, true);
  guest.c.send({ type: 'join', code, ...guest.id });
  assert.equal((await guest.c.next('error')).code, 'banned');
  // auch nicht mit dem alten Wiederverbindungs-Token
  guest.c.send({ type: 'join', code, ...guest.id, resumeToken: guest.joined.resumeToken });
  assert.equal((await guest.c.next('error')).code, 'banned');
});

test('Teilnehmerlimit', async () => {
  const { host, code } = await roomWithTwo();
  host.c.send({ type: 'updateSettings', maxMembers: 2 });
  await host.c.next('room');
  const c = await connect();
  c.send({ type: 'join', code, ...identity('Carla') });
  assert.equal((await c.next('error')).code, 'room_full');

  host.c.send({ type: 'updateSettings', maxMembers: 21 });
  assert.equal((await host.c.next('error')).code, 'bad_message', 'über Server-Limit');
  host.c.send({ type: 'updateSettings', maxMembers: 0 });
  assert.equal((await host.c.next('error')).code, 'bad_message', '0 = unbegrenzt nur ohne Server-Limit');
});

test('Host verlässt den Raum: Nächster wird Host', async () => {
  const { host, guest, code } = await roomWithTwo();
  const carla = await join(code, 'Carla');
  await guest.c.next('room');
  host.c.send({ type: 'leave' });
  await host.c.next('left');
  const update = await guest.c.next('room');
  assert.equal(update.room.hostId, guest.joined.memberId, 'am längsten anwesend');
  assert.deepEqual(memberNames(update.room), ['Ben', 'Carla']);
  assert.equal((await carla.c.next('room')).room.hostId, guest.joined.memberId);
});

test('Host-Rolle gezielt übergeben', async () => {
  const { host, guest } = await roomWithTwo();
  host.c.send({ type: 'transferHost', memberId: guest.joined.memberId });
  assert.equal((await guest.c.next('room')).room.hostId, guest.joined.memberId);
  host.c.send({ type: 'updateSettings', controlMode: 'host' });
  assert.equal((await host.c.next('error')).code, 'not_host');
});

test('Verbindungsabbruch: Wiederverbinden behält Host-Rolle, nach Frist wechselt sie', async () => {
  const { host, guest, code } = await roomWithTwo();
  host.c.ws.terminate();
  const offline = await guest.c.next('room');
  assert.equal(offline.room.hostId, host.joined.memberId, 'Host bleibt während der Frist');
  assert.equal(offline.room.members.find((m) => m.id === host.joined.memberId)?.connected, false);

  const back = await connect();
  back.send({ type: 'join', code, ...host.id, resumeToken: host.joined.resumeToken });
  const rejoined = await back.next('joined');
  assert.equal(rejoined.memberId, host.joined.memberId);
  assert.equal(rejoined.room.hostId, host.joined.memberId);
  assert.equal(rejoined.room.members.length, 2);
  await guest.c.next('room');

  back.ws.terminate();
  await guest.c.next('room');
  clock += 30_000;
  server.maintain();
  const after = await guest.c.next('room');
  assert.equal(after.room.hostId, guest.joined.memberId);
  assert.equal(after.room.members.length, 1);
});

test('Sync zum Host: Gast fragt, Host liefert Position, alle springen', async () => {
  const { host, guest, code } = await roomWithTwo();
  const carla = await join(code, 'Carla');
  await host.c.next('room');
  guest.c.send({ type: 'syncRequest' });
  await host.c.next('positionRequest');
  host.c.send({ type: 'hostPosition', position: 42.5, playing: true });
  for (const c of [guest.c, carla.c]) {
    const s = await c.next('state');
    assert.deepEqual([s.action, s.position, s.playing], ['sync', 42.5, true]);
  }
  // Nur der Host darf eine Position liefern
  guest.c.send({ type: 'hostPosition', position: 1, playing: false });
  assert.equal((await guest.c.next('error')).code, 'not_host');
});

test('Namensänderung wird verteilt', async () => {
  const { host, guest } = await roomWithTwo();
  guest.c.send({ type: 'setName', name: '  Benni\u0000‮  ' });
  const update = await host.c.next('room');
  assert.deepEqual(memberNames(update.room), ['Anna', 'Benni']);
});

test('Inaktive Räume werden geschlossen, laufende nicht', async () => {
  await server.close();
  await start({ idleTimeoutMs: 60_000 });
  const a = await roomWithTwo();
  const b = await roomWithTwo();
  b.host.c.send({ type: 'play', position: 0 });
  await b.guest.c.next('state');
  clock += 60_000;
  server.maintain();
  assert.equal((await a.guest.c.next('roomClosed')).reason, 'idle');
  assert.ok(!server.rooms.has(a.code));
  assert.ok(server.rooms.has(b.code), 'laufende Wiedergabe gilt als aktiv');
});

test('Maximale Raumdauer: Vorwarnung und Schließen', async () => {
  await server.close();
  await start({ maxRoomDurationMs: 60 * 60_000, idleTimeoutMs: 0 });
  const { host, guest, code } = await roomWithTwo();
  assert.equal(guest.joined.room.closesAt, 1_000_000 + 60 * 60_000);
  clock += 50 * 60_000;
  server.maintain();
  assert.equal((await guest.c.next('roomClosing')).reason, 'duration');
  clock += 10 * 60_000;
  server.maintain();
  assert.equal((await host.c.next('roomClosed')).reason, 'duration');
  assert.ok(!server.rooms.has(code));
});

test('Hook bestimmt Raumgrenzen (für die offizielle Instanz)', async () => {
  await server.close();
  await start({ hooks: { roomLimits: (_req, defaults) => ({ ...defaults, maxDurationMs: 1000 }) } });
  const { joined } = await create();
  assert.equal(joined.room.closesAt, 1_000_000 + 1000);
});

test('Leere Räume verfallen nach der Schonfrist', async () => {
  const { c: host, code } = await create();
  host.send({ type: 'leave' });
  await host.next('left');
  server.maintain();
  assert.ok(server.rooms.has(code));
  clock += 1000;
  server.maintain();
  assert.ok(!server.rooms.has(code));
});

test('Beim Beenden erhalten alle „roomClosed“', async () => {
  const { guest } = await roomWithTwo();
  const closed = guest.c.next('roomClosed');
  await server.close();
  assert.equal((await closed).reason, 'shutdown');
  await start(); // für afterEach
});

// ---------------------------------------------------------------------------
// Accounts und Hooks (offizielle Instanz)
// ---------------------------------------------------------------------------

/** Test-Hook: "gut-<id>" ist gültig, alles andere nicht; optional verzögert wie eine echte JWT-Prüfung. */
function accountHooks(extra: ServerHooks = {}, delayMs = 0): ServerHooks {
  return {
    async authenticate(token) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const id = /^gut-(\w+)$/.exec(token)?.[1];
      return id ? { id, name: `Konto ${id}`, expiresAt: clock + 600_000 } : null;
    },
    roomLimits: (_req, defaults, account) => (account ? { maxMembers: 25, maxDurationMs: 0 } : defaults),
    ...extra,
  };
}

test('Ohne authenticate-Hook: keine Accounts, auth wird abgelehnt', async () => {
  const c = await connect();
  c.send({ type: 'auth', token: 'irgendwas' });
  assert.equal((await c.next('error')).code, 'auth_unsupported');
});

test('Anmeldung: Feature in der Begrüßung, gültiges Token, ungültiges Token', async () => {
  await server.close();
  await start({ hooks: accountHooks() });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  sockets.push(ws);
  const [data] = await once(ws, 'message');
  assert.deepEqual((JSON.parse(data.toString()) as Msg<'welcome'>).server.features, ['accounts']);

  const c = await connect();
  c.send({ type: 'auth', token: 'gut-olga' });
  const ok = await c.next('authenticated');
  assert.deepEqual(ok.account, { id: 'olga', name: 'Konto olga', expiresAt: clock + 600_000 });

  // Fehlgeschlagene Anmeldung meldet auch die bestehende ab
  c.send({ type: 'auth', token: 'schlecht' });
  assert.equal((await c.next('error')).code, 'auth_failed');
  c.send({ type: 'auth', token: 'x'.repeat(5000) });
  await c.none('authenticated');
});

test('Raum direkt nach auth erstellen: Grenzen des Accounts gelten (Nachrichten warten auf die Prüfung)', async () => {
  await server.close();
  await start({ maxRoomDurationMs: 3 * 3600_000, maxRoomMembers: 10, hooks: accountHooks({}, 30) });
  const c = await connect();
  c.send({ type: 'auth', token: 'gut-olga' });
  c.send({ type: 'create', url: null, ...identity('Olga') });
  await c.next('authenticated');
  const { room } = await c.next('joined');
  assert.equal(room.memberLimit, 25);
  assert.equal(room.closesAt, null);

  // Ohne Account: Standardgrenzen
  const { joined } = await create();
  assert.equal(joined.room.memberLimit, 10);
  assert.equal(joined.room.closesAt, clock + 3 * 3600_000);
});

test('Abgelaufene Anmeldung zählt nicht mehr', async () => {
  await server.close();
  await start({ hooks: accountHooks() });
  const c = await connect();
  c.send({ type: 'auth', token: 'gut-olga' });
  await c.next('authenticated');
  clock += 600_000;
  c.send({ type: 'create', ...identity('Olga') });
  assert.equal((await c.next('joined')).room.memberLimit, 20);
});

test('Hook-Fehler: authenticate wirft → auth_failed, roomLimits wirft → Standardgrenzen', async () => {
  await server.close();
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    await start({
      hooks: {
        authenticate: () => {
          throw new Error('JWKS nicht erreichbar');
        },
        roomLimits: () => {
          throw new Error('kaputt');
        },
        onRoomCreated: async () => {
          throw new Error('Statistik down');
        },
      },
    });
    const c = await connect();
    c.send({ type: 'auth', token: 'gut-olga' });
    assert.equal((await c.next('error')).code, 'auth_failed');
    const { joined } = await create();
    assert.equal(joined.room.memberLimit, 20);
    await settle();
    assert.equal(logged.length, 3);
  } finally {
    console.error = original;
  }
});

test('canCreateRoom lehnt ab: error mit Code, kein Raum, bisheriger Raum bleibt', async () => {
  await server.close();
  let mode: 'ok' | 'server_full' | 'maintenance' = 'ok';
  const seen: (string | null)[] = [];
  await start({
    hooks: accountHooks({
      canCreateRoom: (_req, account) => {
        seen.push(account?.id ?? null);
        return mode === 'ok' ? null : { code: mode, message: `abgelehnt: ${mode}` };
      },
    }),
  });
  const { c, code } = await create('Anna');
  mode = 'server_full';
  c.send({ type: 'create', ...identity('Anna') });
  const full = await c.next('error');
  assert.deepEqual([full.code, full.message], ['server_full', 'abgelehnt: server_full']);
  assert.deepEqual([...server.rooms.keys()], [code]);
  // Noch im alten Raum
  c.send({ type: 'play', position: 1 });
  await c.none('error');

  mode = 'maintenance';
  const o = await connect();
  o.send({ type: 'auth', token: 'gut-olga' });
  o.send({ type: 'create', ...identity('Olga') });
  await o.next('authenticated');
  assert.equal((await o.next('error')).code, 'maintenance');
  await o.none('joined');
  assert.equal(server.rooms.size, 1);
  assert.deepEqual(seen, [null, null, 'olga']);
});

test('Hook-Fehler: canCreateRoom wirft → protokolliert, Raum wird erstellt', async (t) => {
  await server.close();
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(args[0]));
  await start({
    hooks: {
      canCreateRoom: () => {
        throw new Error('kaputt');
      },
    },
  });
  const { code } = await create();
  assert.ok(server.rooms.has(code));
  assert.deepEqual(logged, ['Hook canCreateRoom fehlgeschlagen:']);
});

test('Ticket in create: ohne Hook ignoriert, ungültige Form → bad_message, bis 4096 Zeichen erlaubt', async () => {
  const c = await connect();
  c.send({ type: 'create', ticket: 42, ...identity('Anna') });
  assert.equal((await c.next('error')).code, 'bad_message');
  c.send({ type: 'create', ticket: '', ...identity('Anna') });
  assert.equal((await c.next('error')).code, 'bad_message');
  c.send({ type: 'create', ticket: 'x'.repeat(4097), ...identity('Anna') });
  assert.equal((await c.next('error')).code, 'bad_message');
  await c.none('joined');
  // Langes Ticket passt in eine Nachricht; ohne Hook entsteht ein Raum mit zufälligem Code.
  c.send({ type: 'create', ticket: 'x'.repeat(4096), url: null, ...identity('Anna') });
  assert.equal((await c.next('joined')).room.code.length, CODE_LENGTH);
  c.send({ type: 'create', ticket: null, ...identity('Anna') });
  await c.next('joined');
  assert.equal(server.rooms.size, 2);
});

test('canCreateRoom gibt den Raumcode vor: normalisiert, ungültig oder vergeben → ticket_invalid', async () => {
  await server.close();
  const seen: (string | null)[] = [];
  await start({
    hooks: {
      canCreateRoom: (_req, _account, { ticket }) => {
        seen.push(ticket);
        return ticket?.startsWith('code:') ? { roomCode: ticket.slice(5) } : null;
      },
    },
  });
  const c = await connect();
  c.send({ type: 'create', ticket: 'code: abcdef ', ...identity('Anna') });
  const { room } = await c.next('joined');
  assert.equal(room.code, 'ABCDEF');

  // Vergeben: Client bleibt im bisherigen Raum
  c.send({ type: 'create', ticket: 'code:ABCDEF', ...identity('Anna') });
  const taken = await c.next('error');
  assert.deepEqual(
    [taken.code, taken.message],
    ['ticket_invalid', 'Der Raum konnte nicht erstellt werden. Bitte versuch es noch einmal.'],
  );
  for (const bad of ['code:ABC', 'code:ABCDE0', 'code:ÄBCDEF']) {
    c.send({ type: 'create', ticket: bad, ...identity('Anna') });
    assert.equal((await c.next('error')).code, 'ticket_invalid');
  }
  c.send({ type: 'play', position: 1 });
  await c.none('error');
  assert.deepEqual([...server.rooms.keys()], ['ABCDEF']);

  // Ohne Ticket: zufälliger Code
  const { code } = await create();
  assert.notEqual(code, 'ABCDEF');
  assert.deepEqual(seen, ['code: abcdef ', 'code:ABCDEF', 'code:ABC', 'code:ABCDE0', 'code:ÄBCDEF', null]);
});

test('canCreateRoom asynchron: folgende Nachrichten warten, Reihenfolge bleibt', async () => {
  await server.close();
  const pending: { ticket: string | null; resolve: (r: { roomCode: string } | null) => void }[] = [];
  await start({
    hooks: accountHooks({
      canCreateRoom: (_req, _account, { ticket }) =>
        new Promise((resolve) => void pending.push({ ticket, resolve })),
    }),
  });
  const c = await connect();
  c.send({ type: 'create', ticket: 't1', url: null, ...identity('Anna') });
  c.send({ type: 'play', position: 5 });
  c.send({ type: 'create', ticket: 't2', url: null, ...identity('Anna') });
  await settle();
  // Zweites create wartet, bis das erste entschieden ist
  assert.deepEqual(pending.map((p) => p.ticket), ['t1']);
  await c.none('error');
  pending.shift()!.resolve({ roomCode: 'BBBBBB' });
  const first = await c.next('joined');
  assert.equal(first.room.code, 'BBBBBB');
  await settle();
  // play kam im neuen Raum an (kein not_in_room), dann wartet das zweite create
  await c.none('error');
  assert.equal(server.rooms.get('BBBBBB')!.playing, true);
  assert.deepEqual(pending.map((p) => p.ticket), ['t2']);
  pending.shift()!.resolve(null);
  const second = await c.next('joined');
  assert.notEqual(second.room.code, 'BBBBBB');
  // Raum BBBBBB verlassen (leer), neuer Raum mit zufälligem Code
  assert.equal(server.rooms.get('BBBBBB')!.members.size, 0);

  // auth während der Prüfung wartet ebenfalls
  const o = await connect();
  o.send({ type: 'create', ticket: 't3', ...identity('Olga') });
  o.send({ type: 'auth', token: 'gut-olga' });
  await settle();
  await o.none('authenticated');
  pending.shift()!.resolve({ roomCode: 'CCCCCC' });
  await o.next('joined');
  await o.next('authenticated');
});

test('canCreateRoom asynchron: Ablehnung, Fehler, Verbindungsabbruch während der Prüfung', async (t) => {
  await server.close();
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(args[0]));
  let release: () => void = () => {};
  await start({
    hooks: {
      canCreateRoom: async (_req, _account, { ticket }) => {
        if (ticket === 'abgelehnt') return { code: 'ticket_invalid', message: 'nein' };
        if (ticket === 'kaputt') throw new Error('kaputt');
        if (ticket === 'langsam') await new Promise<void>((r) => (release = r));
        return { roomCode: 'DDDDDD' };
      },
    },
  });
  const c = await connect();
  c.send({ type: 'create', ticket: 'abgelehnt', ...identity('Anna') });
  assert.deepEqual(await c.next('error'), { type: 'error', code: 'ticket_invalid', message: 'nein' });
  assert.equal(server.rooms.size, 0);

  // Fehler im Hook: protokolliert, Raum mit zufälligem Code
  c.send({ type: 'create', ticket: 'kaputt', ...identity('Anna') });
  const { room } = await c.next('joined');
  assert.ok(server.rooms.has(room.code));
  assert.deepEqual(logged, ['Hook canCreateRoom fehlgeschlagen:']);

  // Verbindung weg, bevor entschieden ist: kein Raum
  const d = await connect();
  d.send({ type: 'create', ticket: 'langsam', ...identity('Ben') });
  await settle();
  d.ws.close();
  await once(d.ws, 'close');
  await settle();
  release();
  await settle();
  assert.ok(!server.rooms.has('DDDDDD'));
  assert.equal(server.rooms.size, 1);
});

test('closeRoom: alle erhalten „roomClosed“ mit Grund admin, zweiter Aufruf false', async () => {
  await server.close();
  const closed: string[] = [];
  await start({ hooks: { onRoomClosed: (e) => void closed.push(`${e.code}:${e.reason}`) } });
  const { host, guest, code } = await roomWithTwo();
  assert.equal(server.closeRoom(code.toLowerCase()), true);
  assert.equal((await host.c.next('roomClosed')).reason, 'admin');
  assert.equal((await guest.c.next('roomClosed')).reason, 'admin');
  assert.ok(!server.rooms.has(code));
  assert.equal(server.closeRoom(code), false);
  assert.equal(server.closeRoom('kein-code'), false);
  guest.c.send({ type: 'play', position: 1 });
  assert.equal((await guest.c.next('error')).code, 'not_in_room');

  const other = await create();
  assert.equal(server.closeRoom(other.code, 'shutdown'), true);
  assert.equal((await other.c.next('roomClosed')).reason, 'shutdown');
  assert.deepEqual(closed, [`${code}:admin`, `${other.code}:shutdown`]);
});

test('Zu viele Anmeldeversuche werden gebremst', async () => {
  await server.close();
  await start({ hooks: accountHooks() });
  const c = await connect();
  for (let i = 0; i < 11; i++) c.send({ type: 'auth', token: 'schlecht' });
  await settle();
  const codes = c.queue.filter((m) => m.type === 'error').map((m) => (m as Msg<'error'>).code);
  assert.equal(codes.filter((x) => x === 'auth_failed').length, 10);
  assert.equal(codes.filter((x) => x === 'rate_limited').length, 1);
});

test('Bann trifft auch den Account auf einer anderen Installation', async () => {
  await server.close();
  await start({ hooks: accountHooks() });
  const host = await create('Anna');
  const guest = await connect();
  guest.send({ type: 'auth', token: 'gut-ben' });
  await guest.next('authenticated');
  guest.send({ type: 'join', code: host.code, ...identity('Ben') });
  const joined = await guest.next('joined');
  host.c.send({ type: 'kick', memberId: joined.memberId, ban: true });
  await guest.next('kicked');

  const other = await connect();
  other.send({ type: 'auth', token: 'gut-ben' });
  await other.next('authenticated');
  other.send({ type: 'join', code: host.code, ...identity('Ben') });
  assert.equal((await other.next('error')).code, 'banned');
});

test('Account-IDs gehen nie an andere Mitglieder', async () => {
  await server.close();
  await start({ hooks: accountHooks() });
  const c = await connect();
  c.send({ type: 'auth', token: 'gut-olga' });
  await c.next('authenticated');
  c.send({ type: 'create', ...identity('Olga') });
  const { room } = await c.next('joined');
  const guest = await join(room.code);
  assert.ok(!JSON.stringify(guest.joined).includes('olga'));
});

test('Statistik-Hooks: Raum, Mitglieder, Wiedergabe, Schließen', async () => {
  await server.close();
  const events: string[] = [];
  await start({
    hooks: accountHooks({
      onRoomCreated: (e) => void events.push(`created:${e.ownerAccountId}`),
      onMemberJoined: (e) => void events.push(`joined:${e.accountId}:${e.resumed}:${e.memberCount}`),
      onMemberLeft: (e) => void events.push(`left:${e.reason}`),
      onPlayback: (e) => void events.push(`${e.action}:${e.position}:${e.playing}:${e.url}`),
      onRoomClosed: (e) => void events.push(`closed:${e.reason}`),
    }),
  });
  const c = await connect();
  c.send({ type: 'auth', token: 'gut-olga' });
  await c.next('authenticated');
  c.send({ type: 'create', url: 'https://www.ardmediathek.de/video/abc', ...identity('Olga') });
  const { room } = await c.next('joined');
  const guest = await join(room.code);
  await c.next('room');
  c.send({ type: 'play', position: 12 });
  await guest.c.next('state');
  c.send({ type: 'kick', memberId: guest.joined.memberId });
  await guest.c.next('kicked');
  c.send({ type: 'leave' });
  await c.next('left');
  clock += 1000;
  server.maintain();
  assert.deepEqual(events, [
    'created:olga',
    'joined:olga:false:1',
    'joined:null:false:2',
    'play:12:true:https://www.ardmediathek.de/video/abc',
    'left:kicked',
    'left:left',
    'closed:empty',
  ]);
});

test('Statistik-Hooks: Verbindungsabbruch, Rückkehr per resumeToken, Ablauf der Frist', async () => {
  await server.close();
  const events: string[] = [];
  await start({
    hooks: {
      onMemberJoined: (e) => void events.push(`joined:${e.memberId}:${e.resumed}:${e.memberCount}`),
      onMemberDisconnected: (e) => void events.push(`disconnected:${e.memberId}:${e.memberCount}`),
      onMemberLeft: (e) => void events.push(`left:${e.memberId}:${e.reason}`),
    },
  });
  const { host, guest, code } = await roomWithTwo();
  const g = guest.joined.memberId;
  events.length = 0;

  guest.c.ws.terminate();
  await host.c.next('room');
  const back = await connect();
  back.send({ type: 'join', code, ...guest.id, resumeToken: guest.joined.resumeToken });
  await back.next('joined');
  await host.c.next('room');

  back.ws.terminate();
  await host.c.next('room');
  clock += 30_000;
  server.maintain();
  await host.c.next('room');

  // Beenden trennt alle, meldet aber kein onMemberDisconnected (der Raum schließt)
  await server.close();
  assert.deepEqual(events, [
    `disconnected:${g}:2`,
    `joined:${g}:true:2`,
    `disconnected:${g}:2`,
    `left:${g}:timeout`,
  ]);
  await start(); // für afterEach
});

test('Hook-Fehler in onMemberDisconnected werden nur protokolliert', async (t) => {
  await server.close();
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(args[0]));
  await start({
    hooks: {
      onMemberDisconnected: () => {
        throw new Error('kaputt');
      },
    },
  });
  const { host, guest, code } = await roomWithTwo();
  guest.c.ws.terminate();
  const offline = await host.c.next('room');
  assert.equal(offline.room.members.find((m) => m.id === guest.joined.memberId)?.connected, false);
  const back = await connect();
  back.send({ type: 'join', code, ...guest.id, resumeToken: guest.joined.resumeToken });
  assert.equal((await back.next('joined')).memberId, guest.joined.memberId);
  assert.deepEqual(logged, ['Hook onMemberDisconnected fehlgeschlagen:']);
});

// ---------------------------------------------------------------------------
// Verbindungsebene
// ---------------------------------------------------------------------------

function tryConnect(port: number, options?: ClientOptions) {
  return new Promise<{ ok: boolean; ws?: WebSocket; status?: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    sockets.push(ws);
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
}

test('Origin-Filter und Verbindungslimit pro IP', async () => {
  await server.close();
  await start({ allowedOrigins: ['chrome-extension://abc', 'moz-extension://*'], maxConnectionsPerIp: 2 });
  assert.equal((await tryConnect(server.port, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await tryConnect(server.port)).status, 403, 'ohne Origin abgelehnt');
  const a = await tryConnect(server.port, { origin: 'chrome-extension://abc' });
  const b = await tryConnect(server.port, { origin: 'moz-extension://1234-5678' });
  assert.ok(a.ok && b.ok);
  assert.equal((await tryConnect(server.port, { origin: 'chrome-extension://abc' })).status, 429);
  a.ws!.close();
  await settle();
  assert.ok((await tryConnect(server.port, { origin: 'chrome-extension://abc' })).ok, 'nach Schließen wieder Platz');
});

test('/health verrät keine internen Daten', async () => {
  await roomWithTwo();
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
});

test('Hinter einem Proxy zählt der letzte X-Forwarded-For-Eintrag', async () => {
  await server.close();
  await start({ trustProxy: true, maxConnectionsPerIp: 1 });
  const xff = (value: string) => ({ headers: { 'x-forwarded-for': value } });
  assert.ok((await tryConnect(server.port, xff('6.6.6.6, 1.1.1.1'))).ok);
  assert.ok((await tryConnect(server.port, xff('2.2.2.2'))).ok);
  assert.equal((await tryConnect(server.port, xff('7.7.7.7, 1.1.1.1'))).status, 429, 'gefälschter erster Eintrag hilft nicht');
});

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

test('Konfiguration aus Umgebungsvariablen', () => {
  const c = loadConfig({});
  assert.deepEqual(
    [c.port, c.maxConnectionsPerIp, c.maxRoomMembers, c.maxRoomDurationMs, c.idleTimeoutMs, c.reconnectGraceMs],
    [8080, 20, 20, 0, 30 * 60_000, 30_000],
  );
  const d = loadConfig({ PORT: '9000', TRUST_PROXY: 'true', ALLOWED_ORIGINS: ' a , b ', MAX_ROOM_DURATION_MINUTES: '120' });
  assert.deepEqual([d.port, d.trustProxy, d.allowedOrigins, d.maxRoomDurationMs], [9000, true, ['a', 'b'], 7_200_000]);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'vielleicht' }), /TRUST_PROXY/);
});

test('Validierung', () => {
  assert.equal(normalizeCode(' abcdef '), 'ABCDEF');
  assert.equal(normalizeCode('ABCDE0'), null);
  assert.equal(normalizeCode(42), null);
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl('http://example.org'), null);
  assert.equal(sanitizeUrl('https://www.zdf.de/a'), 'https://www.zdf.de/a');
  assert.equal(sanitizeName('  a\n\tb  '), 'a b');
  assert.equal(sanitizeName('x'.repeat(100))?.length, 32);
  assert.equal(sanitizeName('​​'), null);
  assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});
