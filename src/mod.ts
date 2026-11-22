/**
 * Paket-Einstieg für Erweiterungen (z. B. die offizielle Instanz): Server mit Hooks starten,
 * Konfiguration laden, Protokoll-Typen. Der eigenständige Server startet über src/index.ts.
 */
export {
  startServer,
  type AccountContext,
  type CreateRoomContext,
  type CreateRoomDecision,
  type LeaveReason,
  type MemberEvent,
  type RoomEvent,
  type RoomGrant,
  type RoomRejection,
  type ServerHooks,
  type ServerOptions,
  type SyncServer,
} from './server.ts';
export { loadConfig, isOriginAllowed, type Config } from './config.ts';
export type { Room, RoomLimits } from './rooms.ts';
export * from './protocol.ts';
