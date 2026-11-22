# Änderungen

## 0.6.1

Nur Metadaten, Dokumentation und CI; Code und Protokoll unverändert.

- Veröffentlichung auf GitHub (`github.com/synchrothek/synchrothek-server`) und npmjs.org: `package.json` mit `repository`, `homepage`, `bugs` und `publishConfig` für npmjs (öffentlich, mit Provenance).
- GitHub Actions: Actions auf Commit-SHAs gepinnt, Standardrechte `contents: read`, Paketinhalt und `npm audit` in der CI geprüft, neuer Job veröffentlicht das Paket bei Tag `v*` per Trusted Publishing (OIDC). Image unter `ghcr.io/synchrothek/synchrothek-server`. Dependabot für npm, GitHub Actions und Docker.
- README mit englischer Zusammenfassung, Installation per `npm install @synchrothek/server`, Abschnitten „Einbetten mit Hooks“, „Releases“ und „Sicherheit“. Neu: `SECURITY.md`, `CONTRIBUTING.md`, Issue-Vorlagen.

## 0.6.0

- `create` nimmt ein optionales `ticket` an (String, 1–4096 Zeichen, sonst `bad_message`). Ohne Hook wird es ignoriert. Höchstgröße einer Nachricht dafür von 4 KiB auf 8 KiB angehoben.
- Hook `canCreateRoom(req, account, ctx)` erweitert: `ctx.ticket` (Ticket aus `create` oder `null`); Rückgabe `{ roomCode }` gibt den Code des neuen Raums vor (normalisiert und geprüft; ungültig oder vergeben → `ticket_invalid`); als Ablehnung zusätzlich `ticket_invalid` erlaubt. Der Hook darf ein Promise liefern; folgende Nachrichten der Verbindung warten bis zur Entscheidung (wie bei `auth`), bricht die Verbindung vorher ab, entsteht kein Raum. Ein abgelehntes Promise wird wie ein Fehler behandelt (protokolliert, Raum zugelassen).
- `ErrorCode` um `ticket_invalid` erweitert, `TICKET_MAX_LENGTH` im Protokoll; Typen `RoomGrant`, `CreateRoomDecision`, `CreateRoomContext` werden exportiert.
- Ohne Hooks unverändert; Hooks von 0.5.0 funktionieren ohne Anpassung. `PROTOCOL_VERSION` bleibt 2.

## 0.5.0

- Neuer Hook `canCreateRoom(req, account)`: lehnt neue Räume ab (`{ code: 'server_full' | 'maintenance', message }`, sonst `null`). Läuft vor dem Verlassen des bisherigen Raums, bei Ablehnung bleibt der Client dort. Fehler im Hook werden protokolliert, der Raum wird zugelassen.
- `ErrorCode` um `server_full` und `maintenance` erweitert, `CloseReason` um `admin`.
- `SyncServer.closeRoom(code, reason = 'admin')`: schließt einen Raum sofort, `false`, wenn es ihn nicht gibt.
- Typ `Room` und `RoomRejection` werden aus dem Paket exportiert.
- Ohne Hooks unverändert; `PROTOCOL_VERSION` bleibt 2 (Clients sollten unbekannte Fehlercodes und Schließgründe mit der mitgelieferten Meldung bzw. allgemein anzeigen).

Ältere Versionen: siehe Git-Historie.
