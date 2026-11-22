/**
 * Synchrothek-Protokoll (JSON über WebSocket).
 *
 * Diese Datei ist die Referenz für alle Komponenten, die das Protokoll sprechen
 * (Server, Extension, offizielle Instanz). Änderungen hier immer abwärtskompatibel
 * halten oder PROTOCOL_VERSION erhöhen.
 */

export const PROTOCOL_VERSION = 2;

export const CODE_LENGTH = 6;
export const NAME_MAX_LENGTH = 32;

export type PlaybackAction = 'play' | 'pause' | 'seek';
export type ControlMode = 'all' | 'host'; // wer Play/Pause/Seek auslösen darf
export type CloseReason = 'idle' | 'duration' | 'shutdown' | 'admin'; // admin = vom Betreiber beendet

export type ErrorCode =
  | 'bad_json'
  | 'bad_message'
  | 'unknown_type'
  | 'rate_limited'
  | 'room_not_found'
  | 'room_full'
  | 'banned'
  | 'not_in_room'
  | 'not_host'
  | 'not_allowed'
  | 'bad_position'
  | 'bad_member'
  | 'host_unavailable'
  | 'auth_unsupported' // Server ohne Accounts (selbst gehostet)
  | 'auth_failed' // Token ungültig oder abgelaufen
  | 'server_full' // Server nimmt gerade keine weiteren Räume an (Grenze erreicht)
  | 'maintenance' // Wartung: keine neuen Räume, laufende bleiben
  | 'ticket_invalid'; // `create`: Ticket fehlt, ist ungültig oder der vorgegebene Raumcode ist nicht frei

/**
 * Features, die ein Server anbietet. Nur zur Anzeige in der Extension, nie zur Rechteprüfung:
 * Ob ein Server offiziell ist, entscheidet allein seine Adresse.
 */
export type ServerFeature = 'accounts';

export const TOKEN_MAX_LENGTH = 2048;
export const TICKET_MAX_LENGTH = 4096;

/** Fähigkeiten und Grenzen des Servers – wird beim Verbindungsaufbau mitgeteilt. */
export interface ServerInfo {
  protocol: number;
  version: string;
  limits: {
    maxRoomMembers: number; // 0 = unbegrenzt
    maxRoomDurationMinutes: number; // 0 = unbegrenzt
    idleTimeoutMinutes: number; // 0 = aus
  };
  features: ServerFeature[];
}

/** Öffentliche Angaben zum angemeldeten Account – geht nur an den eigenen Client, nie an andere Mitglieder. */
export interface AccountInfo {
  id: string;
  name: string | null;
  expiresAt: number | null; // Ablauf der Anmeldung (ms); vorher mit frischem Token erneut `auth` senden
}

export interface MemberInfo {
  id: string;
  name: string;
  connected: boolean;
}

export interface RoomSettings {
  maxMembers: number; // 0 = unbegrenzt
  controlMode: ControlMode;
}

/** Wiedergabezustand. `position` (Sekunden) gilt zum Zeitpunkt `serverTime`. */
export interface PlaybackSnapshot {
  playing: boolean;
  position: number;
  serverTime: number;
  url: string | null;
}

export interface RoomSnapshot extends PlaybackSnapshot {
  code: string;
  hostId: string | null;
  members: MemberInfo[];
  settings: RoomSettings;
  memberLimit: number; // höchstes Teilnehmerlimit, das der Host setzen darf (0 = unbegrenzt)
  closesAt: number | null; // Zeitpunkt, an dem der Raum wegen seiner Maximaldauer schließt
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'ping'; t?: number }
  // Nur an offizielle Adressen senden. Darf jederzeit wiederholt werden (Token erneuert); gilt ab sofort
  // für alle folgenden Nachrichten. Ein Raum übernimmt die Grenzen des Accounts, der ihn erstellt.
  | { type: 'auth'; token: string }
  // `ticket`: nur für Server, die eines verlangen (z. B. vom Vermittler der offiziellen Instanz);
  // ein Server ohne Ticket-Prüfung ignoriert es.
  | { type: 'create'; name: string; installId: string; url?: string | null; ticket?: string }
  | { type: 'join'; code: string; name: string; installId: string; resumeToken?: string }
  | { type: 'leave' }
  | { type: PlaybackAction; position: number; url?: string }
  | { type: 'setName'; name: string }
  | { type: 'kick'; memberId: string; ban?: boolean }
  | { type: 'transferHost'; memberId: string }
  | { type: 'updateSettings'; maxMembers?: number; controlMode?: ControlMode }
  | { type: 'syncRequest' }
  | { type: 'hostPosition'; position: number; playing: boolean };

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type StateMessage = {
  type: 'state';
  action: PlaybackAction | 'sync';
  by: string | null;
} & PlaybackSnapshot;

export type ServerMessage =
  | { type: 'welcome'; serverTime: number; server: ServerInfo }
  | { type: 'authenticated'; account: AccountInfo }
  | { type: 'joined'; memberId: string; resumeToken: string; room: RoomSnapshot }
  | { type: 'room'; room: RoomSnapshot }
  | StateMessage
  | { type: 'positionRequest' }
  | { type: 'kicked'; banned: boolean }
  | { type: 'roomClosing'; reason: CloseReason; closesAt: number }
  | { type: 'roomClosed'; reason: CloseReason }
  | { type: 'left' }
  | { type: 'pong'; t?: number; serverTime: number }
  | { type: 'error'; code: ErrorCode; message: string };
