# Opticien Sync

De database voor de klantkaarten-app van Opticien op de Koffie (form.oodk.nl).
De app op je telefoon synchroniseert automatisch met deze add-on.

## Waar staan de gegevens?

Alles staat in de map **`share\opticien`** van Home Assistant. Met de
Samba-add-on open je die vanaf je pc via `\\homeassistant.local\share\opticien`.

| Wat | Waarvoor |
|---|---|
| `opticien.db` | De database met alle klantkaarten (plus `-wal` en `-shm`, die horen erbij) |
| `media\` | Per klant een map, bijv. `Smit, Anna (12-03-1950)`, met `Klantgegevens.txt`, foto's en PDF's |
| `media\_verwijderd\` | Verwijderde klanten, opzij gezet, niet gewist |
| `backups\` | Elke dag een kopie van de database en `klanten-<datum>.txt` (laatste 30 dagen) |

Het klantenboek uit OS Optiek en gedeelde instellingen, zoals je
meenemen-lijst, staan ook in `opticien.db`, zodat al je toestellen hetzelfde hebben.

Hernoem of verplaats de mappen niet zelf; dat doet de add-on.

## Instellingen

- **Token**: hetzelfde token als in de app bij "Sync-server instellen".
  Gebruik een lang, willekeurig token (minstens 16 tekens).

## Beveiliging

- Na 10 foute tokens binnen een kwartier wordt dat internetadres een uur
  geblokkeerd. Dat staat in het logboek, bijv.
  `adres 1.2.3.4 een uur geblokkeerd na 10 foute pogingen`.
- Per ongeluk jezelf geblokkeerd (bijv. na het wijzigen van het token)? Herstart
  de add-on, dan zijn alle blokkades opgeheven.
- Zet in Nginx Proxy Manager bij deze proxy host **Block Common Exploits** aan.

## Backups

De map `share` gaat mee in de backups van Home Assistant (Instellingen >
Systeem > Backups). Controleer dat bij automatische backups ook **Share** (of
"alle mappen") is aangevinkt. Bewaar je backups in Home Assistant Cloud, dan
staan ze versleuteld buiten je huis.

## Bijwerken

Zet een nieuwe `sync-server.js` in `\\homeassistant.local\addons\opticien_sync`
en verhoog het versienummer in `config.yaml`. Klik daarna in Home Assistant op
de add-on op **Bijwerken** (of **Opnieuw opbouwen**).
