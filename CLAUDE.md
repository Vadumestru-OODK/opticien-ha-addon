# Home Assistant-add-on Opticien Sync

Deze repository is openbaar: Home Assistant haalt de add-on hier vandaan. Zet er nooit tokens,
wachtwoorden of klantgegevens in.

- `opticien_sync/sync-server.js` is een kopie. De bron staat in de repository `opticien-app`
  (`pc/sync-server.js`), samen met de tests. Wijzig hem daar, test daar, en kopieer hem dan hierheen.
- Na elke wijziging `version` in `opticien_sync/config.yaml` ophogen; dan ziet de gebruiker "Update" in Home Assistant.
- Nieuwe instelling: toevoegen in config.yaml (options en schema), run.sh, translations/nl.yaml en en.yaml, en DOCS.md.
- Schrijf Nederlands en gebruik geen liggend streepje (—) als leesteken.
