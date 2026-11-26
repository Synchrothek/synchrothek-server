<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Synchrothek/synchrothek-server/main/.github/assets/kopf-dunkel.svg">
    <img src="https://raw.githubusercontent.com/Synchrothek/synchrothek-server/main/.github/assets/kopf-hell.svg" alt="Synchrothek Server" height="56">
  </picture>
</h1>

[![CI](https://github.com/synchrothek/synchrothek-server/actions/workflows/ci.yml/badge.svg)](https://github.com/synchrothek/synchrothek-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@synchrothek/server)](https://www.npmjs.com/package/@synchrothek/server)
[![Lizenz: AGPL-3.0-only](https://img.shields.io/badge/Lizenz-AGPL--3.0--only-blue)](LICENSE)

> **English summary:** WebSocket server for [Synchrothek](https://github.com/synchrothek/synchrothek), a browser extension for watching German public broadcasters' media library content (Mediathek) together in sync. The server manages rooms and relays play, pause and position; video never passes through it, and nothing is stored on disk. Run your own with Docker (`ghcr.io/synchrothek/synchrothek-server`, automatic HTTPS via Caddy), with plain Node.js ≥ 24, or embed it into your own Node.js service with hooks (accounts, room limits, statistics) via `npm install @synchrothek/server`. Configuration is done through environment variables (see *Konfiguration*). Documentation is in German; issues and pull requests in English are welcome. License: AGPL-3.0-only. Report security issues privately, see [SECURITY.md](SECURITY.md).

WebSocket-Server für [Synchrothek](https://github.com/synchrothek/synchrothek), die Browser-Extension zum synchronen gemeinsamen Schauen von Mediathek-Inhalten.

Der Server verwaltet Räume und verteilt Play, Pause und Position an alle Teilnehmenden. Videos laufen nie über den Server. Er braucht kaum Ressourcen und speichert nichts dauerhaft: Räume liegen nur im Arbeitsspeicher und verschwinden einige Minuten nach dem Verlassen.

Die Extension verbindet sich standardmäßig mit dem öffentlichen Server des Projekts. Mit diesem Repository kannst du einen eigenen betreiben und ihn in der Extension unter *Einstellungen → Server* eintragen.

## Brauche ich eine Domain?

| Szenario | Adresse in der Extension | Domain nötig? |
|---|---|---|
| Heimnetz / LAN, Test | `ws://192.168.1.10:8080` | nein |
| Öffentlich im Internet | `wss://sync.example.org` | **empfohlen** |

Ohne Domain läuft die Verbindung unverschlüsselt (`ws://`). Im eigenen Netz ist das in Ordnung. Im Internet solltest du `wss://` mit TLS-Zertifikat nutzen, und das bekommst du praktisch nur mit einer Domain. Eine Subdomain einer vorhandenen Domain reicht, ebenso ein kostenloser DynDNS-Name.

## Schnellstart mit Docker Compose und automatischem HTTPS

Voraussetzungen: Linux-Host mit Docker, ein DNS-Eintrag (A/AAAA) für deine Domain auf diesen Host, Ports 80 und 443 frei.

```sh
git clone https://github.com/synchrothek/synchrothek-server.git
cd synchrothek-server
echo "DOMAIN=sync.example.org" > .env
docker compose -f compose.caddy.yaml up -d
```

Caddy holt das Zertifikat von Let's Encrypt automatisch. Danach in der Extension `wss://sync.example.org` eintragen. Prüfen: `curl https://sync.example.org/health`. Die Antwort ist nur `{"ok":true}`: Der öffentlich erreichbare Endpunkt verrät bewusst weder Version noch Raum- oder Verbindungszahlen.

## Mit Portainer

*Stacks → Add stack*, dann eine der beiden Varianten:

- **Repository:** URL dieses Repos, *Compose path* `compose.caddy.yaml` (oder `compose.yaml`)
- **Web editor:** Inhalt von [`compose.caddy.yaml`](compose.caddy.yaml) einfügen

Unter *Environment variables* `DOMAIN` setzen (und optional die Variablen aus [`.env.example`](.env.example)), dann *Deploy the stack*.

## Ohne Domain oder hinter einem vorhandenen Reverse Proxy

Nur den Server starten:

```sh
docker compose up -d        # lauscht auf Port 8080
```

- **Ohne Domain (LAN):** in der Extension `ws://<IP-des-Hosts>:8080` eintragen.
- **Hinter nginx/Apache/Caddy auf dem Host:** in `.env` `SYNCHROTHEK_BIND=127.0.0.1` und `TRUST_PROXY=true` setzen, dann eine der Beispielkonfigurationen verwenden:
  - [`examples/Caddyfile`](examples/Caddyfile)
  - [`examples/nginx.conf`](examples/nginx.conf)
  - [`examples/apache2.conf`](examples/apache2.conf)

- **Hinter einem Reverse Proxy im Docker-Container** (z. B. ein zentraler Caddy für mehrere Dienste): Der Server bekommt keinen Host-Port, sondern hängt im Docker-Netzwerk des Proxys. In `.env`:

  ```sh
  COMPOSE_FILE=compose.yaml:compose.proxy.yaml
  PROXY_NETWORK=proxy            # Name des Docker-Netzwerks, in dem der Proxy hängt
  ```

  Im Caddyfile des Proxys:

  ```
  sync.example.org {
  	reverse_proxy synchrothek:8080 {
  		stream_close_delay 5m   # WebSockets bei einem Caddy-Reload nicht sofort trennen
  	}
  }
  ```

Wichtig ist bei allen, dass WebSocket-Upgrades durchgereicht werden und die Verbindungen lange offen bleiben dürfen. Die Beispiele erledigen beides.

## Ohne Docker

Benötigt Node.js ≥ 24 (empfohlen: aktuelle LTS-Version). Node führt den TypeScript-Code direkt aus, ein Build-Schritt ist nicht nötig.

```sh
npm ci --omit=dev
npm start
```

Für den Dauerbetrieb liegt eine systemd-Unit unter [`examples/synchrothek.service`](examples/synchrothek.service).

## Konfiguration

Alle Einstellungen laufen über Umgebungsvariablen:

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8080` | Port im Container bzw. Prozess |
| `HOST` | `0.0.0.0` | Bind-Adresse |
| `TRUST_PROXY` | `false` | Client-IP aus `X-Forwarded-For` lesen. Nur aktivieren, wenn der Server ausschließlich über einen Reverse Proxy erreichbar ist. |
| `MAX_CONNECTIONS_PER_IP` | `20` | Gleichzeitige Verbindungen pro IP, `0` = unbegrenzt |
| `MAX_ROOM_MEMBERS` | `20` | Max. Teilnehmer pro Raum; Hosts können im Raum niedrigere Werte setzen. `0` = unbegrenzt |
| `MAX_ROOM_DURATION_MINUTES` | `0` | Max. Lebensdauer eines Raums, 10 Minuten vorher werden alle gewarnt. `0` = unbegrenzt |
| `IDLE_ROOM_TIMEOUT_MINUTES` | `30` | Pausierte Räume ohne jede Aktivität nach X Minuten schließen. Laufende Wiedergabe zählt als aktiv. `0` = nie |
| `EMPTY_ROOM_TTL_SECONDS` | `300` | Wie lange ein leerer Raum für Reconnects erhalten bleibt |
| `RECONNECT_GRACE_SECONDS` | `30` | Wie lange ein Mitglied nach einem Verbindungsabbruch seinen Platz und ggf. die Host-Rolle behält |
| `ALLOWED_ORIGINS` | *(leer = alle)* | Kommagetrennte Liste erlaubter Origins, `*` als Platzhalter, z. B. `chrome-extension://<id>,moz-extension://*` |

Nur für Docker Compose:

| Variable | Standard | Bedeutung |
|---|---|---|
| `DOMAIN` | – | Domain für `compose.caddy.yaml` |
| `PROXY_NETWORK` | – | Docker-Netzwerk des Reverse Proxys für `compose.proxy.yaml` |
| `SYNCHROTHEK_BIND` | `0.0.0.0` | Auf welcher Host-Adresse `compose.yaml` den Port veröffentlicht |
| `SYNCHROTHEK_PORT` | `8080` | Host-Port für `compose.yaml` |
| `SYNCHROTHEK_IMAGE` | `ghcr.io/synchrothek/synchrothek-server:latest` | Anderes Image verwenden, z. B. ein selbst gebautes |

`ALLOWED_ORIGINS` hält nur Browser anderer Webseiten fern. Programme außerhalb des Browsers können den Origin-Header frei setzen.

### Selbst bauen

```sh
docker build -t synchrothek-server:local .
SYNCHROTHEK_IMAGE=synchrothek-server:local docker compose up -d
```

## Updates

```sh
docker compose pull && docker compose up -d
```

Bei Portainer: *Stack → Pull and redeploy*.

## Entwicklung

```sh
npm install
npm run dev        # mit automatischem Neustart
npm run typecheck  # TypeScript-Prüfung
npm test
```

Beiträge sind willkommen, siehe [CONTRIBUTING.md](CONTRIBUTING.md).

Bei jedem Push auf `main` und jedem Tag `v*` baut die GitHub-Action das Image für `amd64` und `arm64` und veröffentlicht es unter `ghcr.io/synchrothek/synchrothek-server` (`:main` für den aktuellen Stand, `:latest` und `:<version>` für Releases). Zu jedem Tag `v*` erscheint außerdem das npm-Paket [`@synchrothek/server`](https://www.npmjs.com/package/@synchrothek/server), siehe [Releases](#releases).

### Protokoll

JSON-Nachrichten über WebSocket. Die verbindliche Definition aller Nachrichten und Typen steht in [`src/protocol.ts`](src/protocol.ts). Clients wie die Extension übernehmen diese Datei.

- **Räume:** `create {name, installId, url?, ticket?}`, `join` (mit `resumeToken` zum Wiederverbinden), `leave`, `setName`
- **Wiedergabe:** `play` / `pause` / `seek {position, url?}`. `position` ist in Sekunden angegeben und gilt zum Zeitpunkt `serverTime`. Bei laufender Wiedergabe rechnen die Clients selbst weiter.
- **Host:** `kick {memberId, ban?}`, `transferHost`, `updateSettings {maxMembers?, controlMode?}`
- **Sync zum Host:** `syncRequest` → Server schickt `positionRequest` an den Host → Host antwortet mit `hostPosition` → alle erhalten `state` mit `action: "sync"`
- **Server-Ereignisse:** `welcome` (mit Server-Infos, Grenzen und `features`), `joined`, `room` (Mitglieder, Host, Einstellungen), `state`, `kicked`, `roomClosing`, `roomClosed`, `authenticated`, `error`
- **Schließgründe** (`roomClosing`/`roomClosed`): `idle`, `duration`, `shutdown` und `admin` (vom Betreiber beendet, ab 0.5.0)
- **`create` abgelehnt** (ab 0.5.0, nur mit Hook `canCreateRoom`): `error` mit `server_full` (Grenze erreicht) oder `maintenance` (Wartung, keine neuen Räume). Es entsteht kein Raum; wer schon in einem Raum ist, bleibt dort. Ein selbst gehosteter Server ohne Hook sendet diese Codes nie.
- **Tickets** (ab 0.6.0): `create` darf ein `ticket` (String, 1–4096 Zeichen, sonst `bad_message`) mitschicken, etwa von einem vorgeschalteten Dienst, der Räume vergibt. Ein Server ohne Hook ignoriert es. Mit Hook `canCreateRoom` kann der Server das Ticket prüfen und den Raumcode vorgeben; Ticket fehlt, ist ungültig oder der Code ist schon vergeben → `error` mit `ticket_invalid` (kein Raum, ein bestehender Raum bleibt). Clients zeigen dafür am besten die mitgelieferte Meldung und bieten einen neuen Versuch an (neues Ticket holen).
- **Accounts (nur mit Hook `authenticate`):** `auth {token}` → `authenticated {account}` oder `error` mit `auth_failed`. Ein Server ohne diesen Hook (z. B. das Docker-Image) antwortet mit `auth_unsupported` und meldet in `welcome.server.features` kein `accounts`. Die Extension sendet Tokens ohnehin nur an die fest eingebaute offizielle Adresse.

Bannen erfolgt über eine zufällige Installations-ID der Extension. Wer die Extension neu installiert, umgeht den Bann. Ohne Accounts lässt sich das nicht zuverlässig verhindern; ist die gebannte Person angemeldet, gilt der Bann zusätzlich für ihren Account.

## Einbetten mit Hooks

Wer den Server um eigene Funktionen erweitern will (Anmeldung mit Accounts, Grenzen pro Account, Statistik, eigene Regeln für neue Räume), bindet ihn als npm-Paket in ein eigenes Node.js-Projekt ein, statt ihn zu forken:

```sh
npm install @synchrothek/server
```

Das Paket ist ein ES-Modul für Node.js ≥ 24 und liefert kompiliertes JavaScript mit TypeScript-Typen. Die Protokoll-Typen gibt es zusätzlich einzeln unter `@synchrothek/server/protocol`, etwa für eigene Clients. Jede Version wird von der GitHub-Action mit [Provenance-Nachweis](https://docs.npmjs.com/generating-provenance-statements) veröffentlicht; auf npmjs.com ist damit nachvollziehbar, aus welchem Commit sie gebaut wurde. Die Lizenz (AGPL-3.0) gilt auch für eingebettete Fassungen, siehe [Lizenz](#lizenz).

```ts
import { startServer, loadConfig } from '@synchrothek/server';

const server = await startServer({
  ...loadConfig(),
  hooks: {
    // Token aus { type: 'auth' } prüfen, z. B. JWT per JWKS. null = ungültig.
    async authenticate(token, req) {
      return { id: 'konto-id', name: 'anzeigename', expiresAt: Date.now() + 600_000 };
    },
    // Grenzen eines neuen Raums nach dem Account des Erstellers
    roomLimits: (req, defaults, account) => (account ? { maxMembers: 25, maxDurationMs: 0 } : defaults),
    // Neuen Raum ablehnen (ab 0.5.0): null = erlaubt, sonst error mit server_full, maintenance oder ticket_invalid.
    // Ab 0.6.0 mit Ticket aus `create` und optional asynchron; { roomCode } gibt den Code vor.
    async canCreateRoom(req, account, { ticket }) {
      if (server.rooms.size >= 500) return { code: 'server_full', message: 'Gerade sind alle Plätze belegt.' };
      const code = ticket ? await pruefeTicket(ticket) : null; // eigene Prüfung, wirft nie
      return code ? { roomCode: code } : { code: 'ticket_invalid', message: 'Der Raum konnte nicht erstellt werden.' };
    },
    // Statistik (asynchron erlaubt; Fehler werden nur protokolliert)
    onRoomCreated(e) {}, onRoomClosed(e) {}, onMemberJoined(e) {}, onMemberLeft(e) {}, onPlayback(e) {},
    // Verbindung abgebrochen, Mitglied bleibt während RECONNECT_GRACE_SECONDS im Raum (ab 0.4.0)
    onMemberDisconnected(e) {},
  },
});
```

Ablauf eines Mitglieds in den Statistik-Hooks: `onMemberJoined` (`resumed: false`) → beliebig oft `onMemberDisconnected` → `onMemberJoined` mit `resumed: true` (per `resumeToken` zurück) → … → `onMemberLeft` (`left`, `kicked`, `banned`, `timeout` = Frist abgelaufen) oder `onRoomClosed`. Einen eigenen Hook `onMemberReconnected` gibt es nicht: Die Rückkehr ist `onMemberJoined` mit `resumed: true`, das es schon vor 0.4.0 gab; ein zweiter Hook für dasselbe Ereignis würde nur doppelt zählen lassen. `resumed: true` kommt auch ohne vorherige Trennung vor (z. B. übernimmt ein neuer Tab das Mitglied), deshalb sollten Auswertungen es idempotent behandeln. Während der Frist zählt ein getrenntes Mitglied in `memberCount` mit. Beim Beenden des Servers kommt nur `onRoomClosed` (`shutdown`), kein `onMemberDisconnected`.

`canCreateRoom` und `roomLimits` laufen beim `create`, vor dem Verlassen des bisherigen Raums. Wirft einer der beiden, wird das protokolliert und der Raum mit den Standardgrenzen erstellt (bei `canCreateRoom` auch ein abgelehntes Promise). Wer Tickets verlangt, fängt deshalb eigene Fehler im Hook ab und lehnt mit `ticket_invalid` ab.

`canCreateRoom(req, account, ctx)` (ab 0.6.0): `ctx.ticket` ist das Ticket aus `create` (oder `null`). Rückgabe `null` = Raum mit zufälligem Code, `{ roomCode }` = Raum mit genau diesem Code (normalisiert wie beim Beitreten: trim, Großbuchstaben, 6 Zeichen aus dem Code-Alphabet; ungültig oder vergeben → `ticket_invalid` mit der Meldung „Der Raum konnte nicht erstellt werden. Bitte versuch es noch einmal.“), `{ code, message }` = Ablehnung. Der Hook darf ein Promise liefern (etwa für eine Signaturprüfung mit WebCrypto): Bis zur Entscheidung warten alle folgenden Nachrichten dieser Verbindung (wie bei `auth`), damit z. B. ein direkt folgendes `play` im neuen Raum ankommt. Bricht die Verbindung vorher ab, entsteht kein Raum. Ob der vorgegebene Code frei ist, prüft der Server erst nach der Entscheidung. `roomLimits` bleibt synchron. Hooks mit der Signatur von 0.5.0 (zwei Parameter, synchron) funktionieren unverändert. Zum Zählen eignet sich `server.rooms` (`Room` mit `ownerAccountId`, `members`, `createdAt`, `playing`). `server.closeRoom(code, reason = 'admin')` schließt einen Raum sofort; alle Mitglieder erhalten `roomClosed`, der Hook `onRoomClosed` meldet den Grund. Rückgabe `false`, wenn es den Raum nicht (mehr) gibt.

Ohne Hooks verhält sich der Server wie bisher. Nachrichten, die während einer laufenden Token-Prüfung eintreffen, warten darauf, damit ein direkt folgendes `create` schon die Grenzen des Accounts bekommt. Eine Anmeldung gilt bis `expiresAt`; danach (oder nach einem fehlgeschlagenen erneuten `auth`) zählt die Verbindung als nicht angemeldet. Die Grenzen eines Raums werden beim Erstellen festgelegt. Account-IDs gehen nie an andere Mitglieder.

## Releases

Änderungen stehen in [`CHANGELOG.md`](CHANGELOG.md). Für ein Release wird `version` in `package.json` erhöht, der Abschnitt im Changelog ergänzt und das Tag `v<version>` gepusht. Die GitHub-Action prüft, dass Tag und `package.json` übereinstimmen, und veröffentlicht dann das Image auf ghcr.io und das Paket auf npmjs.org (per Trusted Publishing, ohne hinterlegtes Token).

## Sicherheit

Sicherheitslücken bitte **nicht** als öffentliches Issue melden, sondern vertraulich über GitHub (*Security → Report a vulnerability*) oder per E-Mail an security@synchrothek.de. Details: [SECURITY.md](SECURITY.md).

Für den Betrieb eines öffentlichen Servers:

- Im Internet nur über `wss://` (TLS) anbieten, z. B. mit `compose.caddy.yaml` oder einem Reverse Proxy.
- `TRUST_PROXY=true` nur setzen, wenn der Server ausschließlich über den Reverse Proxy erreichbar ist, sonst können Clients ihre IP-Adresse fälschen und `MAX_CONNECTIONS_PER_IP` umgehen.
- `ALLOWED_ORIGINS` auf die Extension-Origins beschränken; das hält fremde Webseiten fern, aber keine Programme außerhalb des Browsers.
- Die Compose-Dateien starten den Container schreibgeschützt, ohne Capabilities und mit `no-new-privileges`. Das Image läuft als unprivilegierter Benutzer.
- Regelmäßig aktualisieren (siehe [Updates](#updates)).

## Datenschutz

Der Server hält im Arbeitsspeicher: Raumcode, Wiedergabezustand, die URL der gerade geschauten Sendung, Anzeigenamen, zufällige Installations-IDs (für Banns) und die Verbindungen. Er protokolliert keine Inhalte und speichert nichts auf der Festplatte. Wer einen öffentlichen Server betreibt, sollte trotzdem eine Datenschutzerklärung bereitstellen, denn IP-Adressen sind während der Verbindung zwangsläufig bekannt.

## Lizenz

Copyright (C) 2026 Tobias-Pascal Mildenberger

Dieses Programm ist freie Software: Du kannst es unter den Bedingungen der GNU Affero General Public License Version 3 (nur diese Version) weitergeben und verändern, siehe [LICENSE](LICENSE). Wer eine veränderte Fassung als Dienst im Netz anbietet, muss den Nutzerinnen und Nutzern den Quellcode dieser Fassung zugänglich machen (AGPL, Abschnitt 13). Der Name „Synchrothek“ ist von der Lizenz nicht umfasst.
