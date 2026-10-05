BASEVAULT OFFLINE
=================
Öffne/importiere dieses Paket in deiner Offline-Paket-Funktion.

Die App ist eine lokale Web-App. Sie nutzt IndexedDB und Web Crypto (AES-GCM + PBKDF2).
Es gibt keinen Server und keine externe Bibliothek.

Hinweis: Der Browser/WebView muss IndexedDB, Web Crypto und Clipboard unterstützen.
Für echte Produktivnutzung sollte ein verschlüsseltes Backup/Export ergänzt werden.

Funktionen
----------
- Master-Passwort (PBKDF2-SHA-256, 250.000 Iterationen) + AES-256-GCM, alles lokal
- Profile mit Username, Passwort, 4based-URL, Notizen, Favoriten- und Aktiv-Status
- Einnahmen pro Account inkl. Monatsauswertung (She-X-Staffel 20 % / 25 %)
- Wiederherstellungsschlüssel, Master-Passwort ändern/zurücksetzen, verschlüsselter Export
- Automatische Sperre nach Inaktivität

Tests
-----
Der Smoke-Test prüft die App automatisiert (Tresor anlegen/entsperren/sperren, Profile,
Einnahmen, Statistiken, Abrechnung, Recovery-Workflow, Passwortwechsel, Auto-Sperre,
Export und große Datenmengen):

    npm install
    npm test            # Funktionstests
    npm run test:bench  # zusätzlich Performance-Messwerte

Die App selbst bleibt eine einzelne Datei ohne Build-Schritt und ohne externe Bibliotheken;
die Test-Abhängigkeiten (jsdom, fake-indexeddb) werden nur für die Entwicklung benötigt.
