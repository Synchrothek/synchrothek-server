import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CODE_LENGTH,
  NAME_MAX_LENGTH,
  type ControlMode,
  type MemberInfo,
  type PlaybackAction,
  type PlaybackSnapshot,
  type RoomSettings,
  type RoomSnapshot,
  type ServerMessage,
} from './protocol.ts';

// Ohne leicht verwechselbare Zeichen (0/O, 1/I)
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_POSITION = 24 * 60 * 60; // Sekunden
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Validierung von Client-Eingaben
// ---------------------------------------------------------------------------

export function generateCode(exists: (code: string) => boolean = () => false): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
  throw new Error('Kein freier Raumcode gefunden');
}

export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

export function isValidPosition(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= MAX_POSITION;
}

export function sanitizeUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Anzeigename: Steuer- und Formatzeichen entfernen, Leerraum zusammenfassen, Länge begrenzen. */
export function sanitizeName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input
    .replace(/\s+/g, ' ') // Zeilenumbrüche, Tabs usw. zuerst zu Leerzeichen
    .replace(/[\p{Cc}\p{Cf}]/gu, '') // dann unsichtbare Steuer- und Formatzeichen entfernen
    .trim();
  if (!name) return null;
  return [...name].slice(0, NAME_MAX_LENGTH).join('');
}

/** Zufällige Installations-ID der Extension (für Banns ohne Account). */
export function isValidInstallId(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input);
}

export function isControlMode(input: unknown): input is ControlMode {
  return input === 'all' || input === 'host';
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Räume
// ---------------------------------------------------------------------------

/** Verbindung eines Mitglieds – entkoppelt den Raum vom WebSocket. */
export interface Connection {
  send(msg: ServerMessage): void;
}

export interface Member {
  readonly id: string;
  name: string;
  readonly installId: string;
  accountId: string | null; // nur serverseitig (Banns, Statistik-Hooks), nie an andere Mitglieder
  readonly resumeToken: string; // Geheimnis, um nach einem Verbindungsabbruch dasselbe Mitglied zu bleiben
  conn: Connection | null;
  readonly joinedAt: number;
  disconnectedAt: number | null;
}

export interface RoomLimits {
  maxMembers: number; // 0 = unbegrenzt
  maxDurationMs: number; // 0 = unbegrenzt
}

/**
 * Autoritativer Zustand eines Raums: Wiedergabe, Mitglieder, Host, Einstellungen.
 * `position` gilt zum Zeitpunkt `updatedAt`; bei laufender Wiedergabe wird hochgerechnet.
 */
export class Room {
  readonly code: string;
  readonly createdAt: number;
  readonly limits: RoomLimits;
  readonly members = new Map<string, Member>();
  readonly bans = new Set<string>(); // installIds
  hostId: string | null = null;
  ownerAccountId: string | null = null; // Account des Erstellers; bestimmt über roomLimits die Grenzen
  settings: RoomSettings;
  closesAt: number | null;
  closingWarned = false;

  playing = false;
  position = 0;
  updatedAt: number;
  url: string | null = null;

  lastActivityAt: number;
  emptySince: number | null;
  lastSyncRequestAt = 0;

  constructor(code: string, now: number, limits: RoomLimits) {
    this.code = code;
    this.createdAt = now;
    this.limits = limits;
    this.settings = { maxMembers: limits.maxMembers, controlMode: 'all' };
    this.closesAt = limits.maxDurationMs > 0 ? now + limits.maxDurationMs : null;
    this.updatedAt = now;
    this.lastActivityAt = now;
    this.emptySince = now;
  }

  // --- Wiedergabe ----------------------------------------------------------

  positionAt(now: number): number {
    return this.playing ? this.position + (now - this.updatedAt) / 1000 : this.position;
  }

  applyPlayback(action: PlaybackAction, position: number, now: number): void {
    if (action === 'play') this.playing = true;
    else if (action === 'pause') this.playing = false;
    this.position = position;
    this.updatedAt = now;
    this.lastActivityAt = now;
  }

  playbackSnapshot(now: number): PlaybackSnapshot {
    return { playing: this.playing, position: this.positionAt(now), serverTime: now, url: this.url };
  }

  snapshot(now: number): RoomSnapshot {
    const members: MemberInfo[] = [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      connected: m.conn !== null,
    }));
    return {
      code: this.code,
      hostId: this.hostId,
      members,
      settings: { ...this.settings },
      memberLimit: this.limits.maxMembers,
      closesAt: this.closesAt,
      ...this.playbackSnapshot(now),
    };
  }

  // --- Mitglieder ----------------------------------------------------------

  isFull(): boolean {
    return this.settings.maxMembers > 0 && this.members.size >= this.settings.maxMembers;
  }

  addMember(name: string, installId: string, conn: Connection, now: number, accountId: string | null = null): Member {
    const member: Member = {
      id: randomUUID(),
      name,
      installId,
      accountId,
      resumeToken: randomBytes(32).toString('base64url'),
      conn,
      joinedAt: now,
      disconnectedAt: null,
    };
    this.members.set(member.id, member);
    this.hostId ??= member.id;
    this.emptySince = null;
    this.lastActivityAt = now;
    return member;
  }

  findByResumeToken(token: string): Member | null {
    for (const member of this.members.values()) {
      if (tokensEqual(member.resumeToken, token)) return member;
    }
    return null;
  }

  /** Entfernt ein Mitglied; gibt zurück, ob dadurch der Host gewechselt hat. */
  removeMember(id: string, now: number): boolean {
    if (!this.members.delete(id)) return false;
    if (this.members.size === 0) {
      this.emptySince = now;
      this.hostId = null;
      return false;
    }
    if (this.hostId !== id) return false;
    this.hostId = this.nextHost()?.id ?? null;
    return true;
  }

  /** Nachfolger: am längsten anwesendes verbundenes Mitglied, sonst das am längsten anwesende. */
  nextHost(): Member | null {
    const byAge = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    return byAge.find((m) => m.conn !== null) ?? byAge[0] ?? null;
  }

  host(): Member | null {
    return this.hostId ? (this.members.get(this.hostId) ?? null) : null;
  }

  // --- Nachrichten ---------------------------------------------------------

  broadcast(msg: ServerMessage, exceptMemberId?: string): void {
    for (const member of this.members.values()) {
      if (member.id !== exceptMemberId) member.conn?.send(msg);
    }
  }

  broadcastRoom(now: number): void {
    this.broadcast({ type: 'room', room: this.snapshot(now) });
  }
}
