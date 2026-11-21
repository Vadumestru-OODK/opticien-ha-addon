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
- **Postbus-token (foto's van de telefoon)**: alleen nodig als je de foto van de PD-meting
  op je telefoon bij de klantkaart wilt bewaren. Vul een ander lang, willekeurig
  token in (minstens 16 tekens) en zet hetzelfde token in de PD-meting op je
  telefoon. Met dit token kan de telefoon alleen een foto in de postbus leggen;
  lezen kan hij niets. De klantkaart haalt de foto op en gooit hem daarna weg.
  Dit geldt voor de PD-foto en voor gewone foto's ("Foto's naar de klantkaart"). Gewone foto's
  die nog niet bij een klant zijn gezet, toont de klantkaart bij het openen van een kaart.
  Niet opgehaalde foto's worden na 24 uur gewist. De postbus staat in
  `share\opticien\postbus`.
- **Widget-token (bureaubladwidget)**: alleen nodig voor het widget op je pc
  (afspraken van vandaag en morgen, en wat nog in OS Optiek moet). Vul een ander lang,
  willekeurig token in (minstens 16 tekens) en gebruik hetzelfde token in het widget.
  Met dit token kun je alleen dat overzicht lezen: namen, tijden, soort afspraak en plaats.
  Geen telefoonnummers, adressen of metingen, en wijzigen kan niet. De widgetpagina staat
  op het adres van deze server met `/widget` erachter.
- **Mistral API-sleutel** en **Mistral-model**: alleen nodig voor de knop
  "Uitwerken met Mistral" op de klantkaart (brief aan de arts en verslag voor
  het dossier). De sleutel blijft op deze server; de klantkaart stuurt geen
  naam, adres, telefoon of geboortedatum mee. Gebruik een betaald account bij
  Mistral, zet het gebruik voor training uit en sluit hun verwerkersovereenkomst.

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
