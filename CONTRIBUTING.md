# Mitmachen

*English: Contributions are welcome – issues and pull requests may be written in English. By submitting a contribution you agree to the contributor agreement below (non-exclusive, perpetual, transferable licence to the project owner, including the right to relicense) and sign off your commits (DCO). Tests and type checks must pass.*

Beiträge sind willkommen: Fehlermeldungen, Verbesserungsvorschläge, Dokumentation und Code.

- **Fehler und Wünsche:** als [Issue](https://github.com/synchrothek/synchrothek-server/issues/new/choose)
- **Sicherheitslücken:** bitte **nie** als Issue, sondern vertraulich, siehe [SECURITY.md](SECURITY.md)
- **Größere Änderungen**, vor allem am Protokoll (`src/protocol.ts`): bitte vorher in einem Issue besprechen. Das Protokoll teilen sich Server und Extension, Änderungen müssen zu beiden passen.

## Entwicklung

Benötigt Node.js ≥ 24. Node führt den TypeScript-Code direkt aus (Type Stripping).

```sh
npm ci
npm run dev        # Server mit automatischem Neustart
npm run typecheck  # TypeScript-Prüfung
npm test           # Tests
npm run build      # Paket nach dist/ bauen (nur für die npm-Veröffentlichung nötig)
```

## Pull Requests

- **Tests und Typprüfung sind Pflicht:** `npm test` und `npm run typecheck` müssen grün sein, die CI prüft beides. Neues Verhalten bekommt Tests in `test/`.
- Kleine, in sich geschlossene Änderungen mit einer kurzen Beschreibung, was und warum.
- Stil wie im Bestand: TypeScript ohne Build-Schritt, keine neuen Abhängigkeiten ohne guten Grund, Kommentare und Doku auf Deutsch (englische Beiträge sind trotzdem willkommen).
- Änderungen, die Nutzerinnen und Nutzer oder einbettende Projekte betreffen, bitte im [CHANGELOG](CHANGELOG.md) unter einem neuen Abschnitt ergänzen. Version und Release übernimmt der Projektinhaber.
- Jeder Commit braucht ein Sign-off (siehe unten).

## Sign-off (Developer Certificate of Origin)

Mit dem Sign-off bestätigst du das [Developer Certificate of Origin 1.1](https://developercertificate.org/), also vor allem, dass du den Beitrag selbst erstellt hast oder ihn unter den hier genannten Bedingungen einreichen darfst. Dazu genügt `git commit -s`, das folgende Zeile an die Commit-Nachricht anhängt:

```
Signed-off-by: Vorname Nachname <mail@example.org>
```

Name und E-Mail-Adresse müssen echt sein (keine anonymen Beiträge). Vergessen? `git commit --amend -s` bzw. `git rebase --signoff main`.

## Beitragsvereinbarung

Synchrothek wird unter der GNU Affero General Public License 3.0 (nur diese Version) veröffentlicht. Damit das Projekt auch künftig über seine Lizenzierung entscheiden kann (etwa für eine Lizenz­anpassung oder den Einsatz in eigenen, nicht öffentlichen Diensten), gilt für alle Beiträge Folgendes:

1. **Einräumung von Nutzungsrechten.** Mit dem Einreichen eines Beitrags (z. B. Pull Request, Patch, Code oder Text in einem Issue) räumst du Tobias-Pascal Mildenberger als Projektinhaber (im Folgenden „Projektinhaber“) ein **einfaches** (nicht ausschließliches), **räumlich und zeitlich unbeschränktes**, **unwiderrufliches**, **unentgeltliches**, **übertragbares** und **unterlizenzierbares** Recht ein, den Beitrag in allen bekannten Nutzungsarten zu nutzen, insbesondere zu vervielfältigen, zu verbreiten, öffentlich zugänglich zu machen, zu bearbeiten und mit anderen Werken zu verbinden.
2. **Relizenzierung.** Das Recht umfasst ausdrücklich, den Beitrag – allein oder als Teil des Projekts – **unter anderen Lizenzbedingungen** als der AGPL-3.0 zu nutzen und weiterzugeben, auch unter proprietären Bedingungen.
3. **Deine Rechte bleiben.** Du behältst dein Urheberrecht und darfst deinen Beitrag weiterhin beliebig selbst nutzen. Im öffentlichen Repository bleibt dein Beitrag unter der AGPL-3.0 verfügbar.
4. **Zusicherung.** Du sicherst zu, dass du berechtigt bist, diese Rechte einzuräumen (der Beitrag ist deine eigene Arbeit oder du hast die nötigen Rechte, z. B. deines Arbeitgebers), und dass dir keine Rechte Dritter bekannt sind, die dem entgegenstehen.
5. **Nennung.** Ein Anspruch auf Aufnahme des Beitrags besteht nicht. Du wirst in der Git-Historie als Autorin bzw. Autor genannt.

Wer mit dieser Vereinbarung nicht einverstanden ist, kann leider keine Beiträge einreichen; Issues mit Fehlerbeschreibungen und Ideen sind trotzdem willkommen.

## Verhalten

Bitte bleib freundlich und sachlich. Beleidigende oder diskriminierende Beiträge werden entfernt.
