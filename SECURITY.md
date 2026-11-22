# Sicherheit

*English: Please report vulnerabilities privately via GitHub's "Report a vulnerability" button or by e-mail to security@synchrothek.de – never as a public issue. Reports in English are welcome.*

## Sicherheitslücke melden

Bitte melde Sicherheitslücken **vertraulich** und **nicht als öffentliches Issue**, als Diskussion oder Pull Request:

- **Bevorzugt:** über GitHub, Reiter *Security* → *Report a vulnerability* ([direkt zum Formular](https://github.com/synchrothek/synchrothek-server/security/advisories/new))
- **Alternativ:** per E-Mail an [security@synchrothek.de](mailto:security@synchrothek.de)

Hilfreich sind:

- betroffene Version (Image-Tag oder Paketversion) und Betriebsart (Docker, Node.js, als Paket eingebettet)
- eine Beschreibung der Lücke und ihrer Auswirkungen
- Schritte oder ein kleines Beispiel zum Nachstellen

Bitte nutze nur eigene Server zum Testen und keine Instanzen anderer, und greife nicht auf Daten anderer Personen zu.

## Ablauf

- Eingangsbestätigung in der Regel innerhalb weniger Tage
- Wir prüfen die Meldung, halten dich über den Stand auf dem Laufenden und stimmen den Zeitpunkt der Veröffentlichung mit dir ab
- Nach dem Fix erscheint ein Security Advisory im Repository; auf Wunsch wirst du dort genannt

Synchrothek ist ein kleines Projekt ohne Bug-Bounty-Programm.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für die jeweils neueste veröffentlichte Version (npm-Paket `@synchrothek/server` und Image `ghcr.io/synchrothek/synchrothek-server:latest`). Bitte aktualisiere vor einer Meldung auf diese Version, falls möglich.

## Geltungsbereich

Dieses Repository umfasst nur den Sync-Server. Lücken in der Browser-Extension meldest du bitte im [Repository der Extension](https://github.com/synchrothek/synchrothek); bei Unsicherheit genügt eine E-Mail an security@synchrothek.de.

Hinweise zum sicheren Betrieb (Reverse Proxy, `TRUST_PROXY`, `ALLOWED_ORIGINS`) stehen im [README](README.md#sicherheit).
