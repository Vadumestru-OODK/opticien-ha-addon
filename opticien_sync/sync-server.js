// Sync-server voor de Opticien-app, versie 2 (met database).
//
// Wat hij doet:
//   - Klantkaarten staan in een SQLite-database (opticien.db), één regel per kaart.
//   - Elke wijziging wordt ook als versie bewaard, zodat je nooit iets kwijtraakt.
//   - Foto's en PDF's staan als gewone bestanden in de map 'media', per klant een map
//     met een herkenbare naam, bijv. 'Smit, Anna (12-03-1950)\Foto 1 - 22-10-2026 14.32.jpg'.
//     Verwijderde klanten gaan naar 'media\_verwijderd', verwijderde foto's naar een
//     submap 'Verwijderde foto's'. Er wordt nooit iets gewist.
//   - In elke klantmap een 'Klantgegevens.txt' (leesbaar met Kladblok), en bij de dagelijkse
//     backup een 'klanten-<datum>.txt' met alle klanten in één bestand.
//   - Elke dag een kopie van de database in de map 'backups'.
//   - De oude endpoints (GET/POST /sync, GET /backups) werken nog, voor de overgangsperiode.
//
// Geen extra installatie nodig: SQLite zit in Node.js 22.13 en hoger.
// Starten: node sync-server.js
//
// Instellen:
//   Zet hieronder bij TOKEN hetzelfde token als in je oude sync-server.js
//   (of gebruik de omgevingsvariabele SYNC_TOKEN, zoals voorheen).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// De melding 'SQLite is an experimental feature' is onschuldig; die tonen we niet
const origEmitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
    if (String(w && w.message || w).includes('SQLite')) return;
    return origEmitWarning.call(process, w, ...rest);
};

let DatabaseSync;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
    console.error('Deze Node.js-versie heeft geen ingebouwde SQLite. Installeer Node.js 22.13 of hoger (bij voorkeur de LTS-versie van nodejs.org).');
    process.exit(1);
}

const PORT = process.env.SYNC_PORT || 8091;
// Alle datums in de tekstbestanden en mapnamen in Nederlandse tijd, ook op een server die op UTC staat
process.env.TZ = process.env.TZ || 'Europe/Amsterdam';
const TOKEN = process.env.SYNC_TOKEN || 'VERANDER_DIT_TOKEN';
const DATA_DIR_BASE = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR_BASE, 'sync-data.json');      // oude sync (overgangsperiode)
const BACKUP_DIR = path.join(DATA_DIR_BASE, 'backups');
const DB_FILE = path.join(DATA_DIR_BASE, 'opticien.db');
const MEDIA_DIR = path.join(DATA_DIR_BASE, 'media');
const MAX_BACKUPS = parseInt(process.env.SYNC_MAX_BACKUPS, 10) || 60;
const MAX_DB_BACKUPS = 30;          // dagelijkse databasekopieën
const MAX_VERSIES_PER_KAART = 30;   // versiegeschiedenis per klantkaart
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
// Postbus: de telefoon (PD-meting) mag hier met een eigen, beperkt token alleen een foto in leggen.
// Ophalen en weggooien kan alleen met het gewone token. Niet opgehaald: na 24 uur weg.
const POSTBUS_TOKEN = (process.env.POSTBUS_TOKEN || '').trim();
const POSTBUS_AAN = POSTBUS_TOKEN.length >= 16 && POSTBUS_TOKEN !== TOKEN;
const POSTBUS_DIR = path.join(DATA_DIR_BASE, 'postbus');
const POSTBUS_MAX_BYTES = 5 * 1024 * 1024;
const POSTBUS_MAX_AANTAL = 50;
const POSTBUS_BEWAARTIJD = 24 * 60 * 60 * 1000;
// Gewone foto's van de telefoon krijgen een soort mee (?soort=...); die worden in een klein .json-bestand ernaast bewaard
const POSTBUS_SOORTEN = ['montuur', 'oog', 'recept', 'overig'];
// Mistral: de klantkaart laat hier een verslag uitwerken. De sleutel blijft op de server.
const MISTRAL_KEY = (process.env.MISTRAL_KEY || '').trim();
const MISTRAL_MODEL = (process.env.MISTRAL_MODEL || '').trim() || 'mistral-large-latest';
const MISTRAL_URL = process.env.MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions';
const AI_MAX_TEKENS = 30000;

// --- Database ---

fs.mkdirSync(DATA_DIR_BASE, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kaarten (
        id          TEXT PRIMARY KEY,
        klant       TEXT,
        data        TEXT NOT NULL,
        saved_at    TEXT NOT NULL,
        verwijderd  INTEGER NOT NULL DEFAULT 0,
        seq         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kaarten_seq ON kaarten(seq);
    CREATE TABLE IF NOT EXISTS kaart_versies (
        nr           INTEGER PRIMARY KEY AUTOINCREMENT,
        kaart_id     TEXT NOT NULL,
        data         TEXT NOT NULL,
        saved_at     TEXT NOT NULL,
        verwijderd   INTEGER NOT NULL DEFAULT 0,
        ontvangen_op TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS versies_kaart ON kaart_versies(kaart_id);
    CREATE TABLE IF NOT EXISTS kaart_map (
        kaart_id   TEXT PRIMARY KEY,
        map        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instellingen (
        sleutel    TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        saved_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
        id         TEXT PRIMARY KEY,
        kaart_id   TEXT,
        bestand    TEXT NOT NULL,
        type       TEXT,
        grootte    INTEGER,
        ontvangen  TEXT NOT NULL
    );
`);

const q = {
    getInstelling: db.prepare('SELECT * FROM instellingen WHERE sleutel = ?'),
    zetInstelling: db.prepare(`INSERT INTO instellingen (sleutel, data, saved_at) VALUES (?, ?, ?)
        ON CONFLICT(sleutel) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM kaarten'),
    getKaart: db.prepare('SELECT * FROM kaarten WHERE id = ?'),
    sinds: db.prepare('SELECT * FROM kaarten WHERE seq > ? ORDER BY seq'),
    upsert: db.prepare(`INSERT INTO kaarten (id, klant, data, saved_at, verwijderd, seq) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET klant = excluded.klant, data = excluded.data, saved_at = excluded.saved_at,
        verwijderd = excluded.verwijderd, seq = excluded.seq`),
    versie: db.prepare('INSERT INTO kaart_versies (kaart_id, data, saved_at, verwijderd, ontvangen_op) VALUES (?, ?, ?, ?, ?)'),
    snoeiVersies: db.prepare(`DELETE FROM kaart_versies WHERE kaart_id = ? AND nr NOT IN
        (SELECT nr FROM kaart_versies WHERE kaart_id = ? ORDER BY nr DESC LIMIT ${MAX_VERSIES_PER_KAART})`),
    getMedia: db.prepare('SELECT * FROM media WHERE id = ?'),
    mediaVanKaart: db.prepare('SELECT id, bestand FROM media WHERE kaart_id = ?'),
    zetMediaPad: db.prepare('UPDATE media SET bestand = ? WHERE id = ?'),
    putMedia: db.prepare(`INSERT INTO media (id, kaart_id, bestand, type, grootte, ontvangen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kaart_id = excluded.kaart_id, bestand = excluded.bestand, type = excluded.type,
        grootte = excluded.grootte, ontvangen = excluded.ontvangen`),
    getMap: db.prepare('SELECT map FROM kaart_map WHERE kaart_id = ?'),
    zetMap: db.prepare('INSERT INTO kaart_map (kaart_id, map) VALUES (?, ?) ON CONFLICT(kaart_id) DO UPDATE SET map = excluded.map'),
    mapInGebruik: db.prepare('SELECT kaart_id FROM kaart_map WHERE map = ? COLLATE NOCASE AND kaart_id <> ?'),
    alleKaarten: db.prepare('SELECT id, data, verwijderd FROM kaarten'),
    tellingen: db.prepare('SELECT (SELECT COUNT(*) FROM kaarten WHERE verwijderd = 0) AS kaarten, (SELECT COUNT(*) FROM media) AS media')
};

// Alleen veilige tekens in id's en mapnamen (voorkomt dat iemand buiten de mediamap schrijft)
function veiligId(s) {
    s = String(s || '');
    return /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.includes('..') ? s : null;
}

function verwerkKaarten(lijst) {
    const geaccepteerd = [];
    const afgewezen = [];
    const nu = new Date().toISOString();

    const teRegelen = [];
    db.exec('BEGIN');
    try {
        let seq = q.maxSeq.get().s;
        for (const k of lijst) {
            const id = veiligId(k && k.id);
            if (!id || !k.savedAt) continue;
            const bestaand = q.getKaart.get(id);
            // Nieuwere versie op de server: niet overschrijven, maar terugsturen
            if (bestaand && bestaand.saved_at > k.savedAt) {
                // De oudere versie toch in de geschiedenis bewaren, zodat er niets verloren gaat
                q.versie.run(id, JSON.stringify(k), k.savedAt, k.verwijderd ? 1 : 0, nu);
                q.snoeiVersies.run(id, id);
                afgewezen.push({ id, savedAt: bestaand.saved_at, verwijderd: !!bestaand.verwijderd, kaart: JSON.parse(bestaand.data) });
                continue;
            }
            // Precies dezelfde versie die er al staat: niets te doen
            if (bestaand && bestaand.saved_at === k.savedAt && !!bestaand.verwijderd === !!k.verwijderd) {
                geaccepteerd.push(id);
                continue;
            }
            seq++;
            const vorigeKaart = bestaand ? JSON.parse(bestaand.data) : null;
            const data = JSON.stringify(k);
            const verwijderd = k.verwijderd ? 1 : 0;
            q.upsert.run(id, String(k.klant || ''), data, k.savedAt, verwijderd, seq);
            q.versie.run(id, data, k.savedAt, verwijderd, nu);
            q.snoeiVersies.run(id, id);
            teRegelen.push([id, k, vorigeKaart]);
            geaccepteerd.push(id);
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    // Mappen en bestandsnamen pas regelen als de database het zeker heeft opgeslagen
    for (const [id, k, vorige] of teRegelen) {
        try { regelMediaVanKaart(id, k, vorige); } catch (e) { console.error('Mappen regelen mislukt:', e.message); }
    }
    return { seq: q.maxSeq.get().s, geaccepteerd, afgewezen };
}

// --- Herkenbare map- en bestandsnamen ---

// Tekens die Windows niet toestaat in een naam weghalen
function veiligeNaam(tekst, max) {
    let n = String(tekst || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    n = n.replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = '_' + n;
    return n.slice(0, max || 80).trim() || 'Onbekend';
}

function dagNL(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// 'Smit, Anna (12-03-1950)'
function klantMapnaam(kaart) {
    const d = (kaart && kaart.data) || {};
    const schoon = v => (v && v !== '-') ? String(v).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const achter = schoon(d.naam), voor = schoon(d.voornaam);
    let naam = achter && voor ? `${achter}, ${voor}` : (achter || voor || schoon(kaart && kaart.klant) || 'Naam onbekend');
    if (schoon(d.gebdatum)) naam += ` (${schoon(d.gebdatum)})`;
    return veiligeNaam(naam, 80);
}

// Eerste vrije naam: 'Smit, Anna', 'Smit, Anna (2)', ... (de eigen huidige map telt als vrij)
function vrijeMap(gewenst, kaartId) {
    const huidig = (q.getMap.get(kaartId)?.map || '').toLowerCase();
    for (let n = 1; ; n++) {
        const kandidaat = n === 1 ? gewenst : `${gewenst} (${n})`;
        if (kandidaat.toLowerCase() === huidig) return kandidaat;
        if (!q.mapInGebruik.get(kandidaat, kaartId) && !fs.existsSync(path.join(MEDIA_DIR, kandidaat))) return kandidaat;
    }
}

// Past bij de huidige map al de gewenste naam (eventueel met volgnummer)?
function mapPast(huidig, gewenst) {
    if (!huidig) return false;
    if (huidig === gewenst) return true;
    return huidig.startsWith(gewenst + ' (') && /^\(\d+\)$/.test(huidig.slice(gewenst.length + 1));
}

function verplaats(vanRelatief, naarRelatief) {
    const van = path.join(MEDIA_DIR, vanRelatief), naar = path.join(MEDIA_DIR, naarRelatief);
    if (!fs.existsSync(van)) return true;
    fs.mkdirSync(path.dirname(naar), { recursive: true });
    fs.renameSync(van, naar);
    return true;
}

// Zorgt dat de map van een kaart bestaat met de juiste naam; geeft de (relatieve) mapnaam terug
function zorgVoorMap(kaartId, kaart, vorigeKaart) {
    const huidig = q.getMap.get(kaartId)?.map || null;
    let gewenst;
    if (kaart && kaart.verwijderd) {
        if (huidig && huidig.startsWith('_verwijderd' + path.sep)) return huidig; // al opzij gezet
        const naam = vorigeKaart ? klantMapnaam(vorigeKaart) : (huidig ? path.basename(huidig) : kaartId);
        gewenst = path.join('_verwijderd', veiligeNaam(`${naam} (verwijderd ${dagNL(new Date())})`, 110));
        if (mapPast(huidig, gewenst)) return huidig;
    } else if (kaart && kaart.data) {
        gewenst = klantMapnaam(kaart);
        if (mapPast(huidig, gewenst)) return huidig;
    } else {
        // Foto komt binnen voordat de kaart er is: tijdelijk op id
        if (huidig) return huidig;
        gewenst = kaartId;
    }
    const nieuw = vrijeMap(gewenst, kaartId);
    try {
        if (huidig) verplaats(huidig, nieuw);
        q.zetMap.run(kaartId, nieuw);
        for (const m of q.mediaVanKaart.all(kaartId)) {
            if (huidig && (m.bestand === huidig || m.bestand.startsWith(huidig + path.sep))) {
                q.zetMediaPad.run(path.join(nieuw, path.relative(huidig, m.bestand)), m.id);
            }
        }
        return nieuw;
    } catch (e) {
        // Bijv. omdat de map net open staat in de Verkenner: volgende keer opnieuw proberen
        console.error(`Kon map "${huidig}" niet hernoemen naar "${nieuw}":`, e.message);
        if (!huidig) { q.zetMap.run(kaartId, kaartId); return kaartId; }
        return huidig;
    }
}

// Gewenste bestandsnaam per foto/PDF, volgens de verwijzingen op de kaart
function gewensteBestandsnamen(kaart) {
    const namen = {};
    const teller = {};
    (Array.isArray(kaart.photos) ? kaart.photos : []).forEach(f => {
        if (!f || !f.id) return;
        const groep = f.reparatie ? `rep${f.reparatie}` : 'gewoon';
        teller[groep] = (teller[groep] || 0) + 1;
        const tijd = f.tijdstip ? ' - ' + String(f.tijdstip).replace(/:/g, '.').replace(/,/g, '') : '';
        const basis = f.reparatie ? `Reparatie ${f.reparatie} - foto ${teller[groep]}` : `Foto ${teller[groep]}`;
        namen[f.id] = veiligeNaam(basis + tijd, 70);
    });
    (Array.isArray(kaart.bijlagen) ? kaart.bijlagen : []).forEach(b => {
        if (!b || !b.id) return;
        namen[b.id] = veiligeNaam(String(b.bestandsnaam || 'Bijlage').replace(/\.pdf$/i, ''), 80);
    });
    return namen;
}

// --- Klantgegevens als leesbare tekst ---

function datumNL(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}

function kaartAlsTekst(kaart) {
    const d = (kaart && kaart.data) || {};
    const w = (k) => (d[k] != null && String(d[k]).trim() !== '' && d[k] !== '-') ? String(d[k]).trim() : '';
    const regels = [];
    const regel = (label, waarde) => { if (waarde) regels.push(`${label}: ${waarde}`); };
    const kop = (t) => { regels.push(''); regels.push(t); regels.push('-'.repeat(t.length)); };
    const naam = [w('voornaam'), w('naam')].filter(Boolean).join(' ') || kaart.klant || 'Naam onbekend';

    regels.push(`KLANTGEGEVENS: ${naam}`);
    regels.push('='.repeat(50));
    regel('Naam', w('naam'));
    regel('Voornaam', w('voornaam'));
    regel('Geboortedatum', w('gebdatum'));
    regel('Adres', [w('adres'), [w('postcode'), w('plaats')].filter(Boolean).join(' ')].filter(Boolean).join(', '));
    regel('Telefoon', w('tel'));
    regel('E-mail', w('email'));
    regel('Contactpersoon', w('contact'));

    if (w('afspraak_datum') || w('afspraak_tijd')) {
        kop('AFSPRAAK');
        regel('Soort', w('soort_afspraak'));
        regel('Datum', datumNL(w('afspraak_datum')));
        regel('Tijd', w('afspraak_tijd') ? w('afspraak_tijd') + ' uur' : '');
        regel('Duur', w('duur') ? w('duur') + ' minuten' : '');
        if (d.andere_locatie) regel('Tijdelijk verblijfadres', [w('verblijf_adres'), [w('verblijf_postcode'), w('verblijf_plaats')].filter(Boolean).join(' ')].filter(Boolean).join(', '));
        regel('Opmerkingen', w('opmerkingen'));
    } else if (w('opmerkingen')) {
        kop('OPMERKINGEN');
        regels.push(w('opmerkingen'));
    }

    const aantalAfspraken = parseInt(d._aCount, 10) || 1;
    for (let n = 2; n <= aantalAfspraken; n++) {
        if (!w(`afs${n}_datum`) && !w(`afs${n}_tijd`) && !w(`afs${n}_opm`)) continue;
        kop(`AFSPRAAK ${n}`);
        regel('Soort', w(`afs${n}_soort`));
        regel('Datum', datumNL(w(`afs${n}_datum`)));
        regel('Tijd', w(`afs${n}_tijd`) ? w(`afs${n}_tijd`) + ' uur' : '');
        regel('Duur', w(`afs${n}_duur`) ? w(`afs${n}_duur`) + ' minuten' : '');
        regel('Opmerkingen', w(`afs${n}_opm`));
    }
    const aantalReparaties = parseInt(d._repCount, 10) || 0;
    for (let n = 1; n <= aantalReparaties; n++) {
        kop(`REPARATIE${aantalReparaties > 1 ? ' ' + n : ''}`);
        regel('Omschrijving', w(`rep${n}_omschrijving`));
        regel('Montuur', w(`rep${n}_montuur`));
        regels.push(`Kosten: ${w(`rep${n}_kosten`) ? '€ ' + w(`rep${n}_kosten`) : '-'} (${d[`rep${n}_betaald`] ? 'betaald' : 'nog niet betaald'})`);
        regel('Klaar op', [datumNL(w(`rep${n}_klaar`)), w(`rep${n}_tijd`) && `om ${w(`rep${n}_tijd`)} uur`].filter(Boolean).join(' '));
        regel('Afleveren of ophalen', w(`rep${n}_wijze`) === 'Ophalen' ? `Ophalen bij ${w(`rep${n}_plek`) || 'mijn adres'}` : (w(`rep${n}_wijze`) || (w(`rep${n}_klaar`) ? 'Afleveren' : '')));
    }

    const aantalKlachten = parseInt(d._klCount, 10) || 0;
    for (let n = 1; n <= aantalKlachten; n++) {
        kop(`KLACHT${aantalKlachten > 1 ? ' ' + n : ''}`);
        regel('Ontvangen op', datumNL(w(`kl${n}_datum`)));
        regel('Soort', w(`kl${n}_soort`));
        regel('Klacht', w(`kl${n}_omschrijving`));
        regel('Wens klant', w(`kl${n}_wens`));
        regel('Bevindingen onderzoek', w(`kl${n}_onderzoek`));
        // Brilcontrole: besteld en gemeten, plus de uitslag zoals de app die berekende
        const bcRij = (wie, o) => {
            const v = f => w(`kl${n}_${wie}${o}${f}`) || '-';
            return `  ${o === 'r' ? 'R' : 'L'} ${wie === 'bo' ? 'besteld' : 'gemeten'}: S ${v('s')}  C ${v('c')}  As ${v('a')}  Add ${v('d')}  PD ${v('pd')}  Hoogte ${v('h')}`;
        };
        const heeftBc = ['bo', 'bg'].some(wie => ['r', 'l'].some(o => ['s', 'c', 'a', 'd', 'pd', 'h'].some(f => w(`kl${n}_${wie}${o}${f}`))));
        if (heeftBc) {
            regels.push(`Brilcontrole (${w(`kl${n}_bctype`) || 'Enkelvoudig'}):`);
            ['r', 'l'].forEach(o => { regels.push(bcRij('bo', o)); regels.push(bcRij('bg', o)); });
            if (w(`kl${n}_bcuitslag`)) regels.push('  ' + w(`kl${n}_bcuitslag`));
            const ok = [['c1', 'montuur past'], ['c2', 'glazen onbeschadigd'], ['c3', 'glastype volgens bestelling'], ['c4', 'glazen niet verwisseld'], ['c5', 'bril afgesteld']]
                .filter(([f]) => d[`kl${n}_${f}`]).map(([, t]) => t);
            if (ok.length) regels.push(`  Gecontroleerd en in orde: ${ok.join(', ')}`);
        }
        regel('Oplossing / afspraak', w(`kl${n}_oplossing`));
        regel('Antwoord uiterlijk', datumNL(w(`kl${n}_streef`)));
        regel('Status', w(`kl${n}_status`) || 'Ontvangen');
        regel('Afgehandeld op', datumNL(w(`kl${n}_afgehandeld`)));
        const vink = (f, t) => `  [${d[`kl${n}_${f}`] ? 'x' : ' '}] ${t}`;
        regels.push('Klachtenprotocol:');
        regels.push(vink('p1', 'Ontvangstbevestiging gestuurd'));
        regels.push(vink('p2', 'Klacht onderzocht'));
        regels.push(vink('p3', 'Oplossing voorgesteld'));
        regels.push(vink('p4', 'Klant akkoord en afgerond'));
    }

    const oog = (p, e) => {
        const v = (f) => w(`${p}_${e}${f}`) || '-';
        return `  ${e === 'r' ? 'R' : 'L'}: S ${v('s')}  C ${v('c')}  As ${v('a')}  Add ${v('d')}  (V ${v('v')})`;
    };
    const blokHeeftData = (p) => ['rs','rc','ra','rd','rv','ls','lc','la','ld','lv','bv','pd','note'].some(f => w(`${p}_${f}`));
    const blok = (p, titel) => {
        regels.push(titel);
        regels.push(oog(p, 'r'));
        regels.push(oog(p, 'l'));
        const extra = [w(`${p}_bv`) && `Binoculaire visus: ${w(`${p}_bv`)}`, w(`${p}_pd`) && `PD: ${w(`${p}_pd`)}`, w(`${p}_note`) && `Opmerking: ${w(`${p}_note`)}`].filter(Boolean);
        if (extra.length) regels.push('  ' + extra.join('  |  '));
        regels.push('');
    };
    const bCount = Math.max(2, parseInt(d._bCount, 10) || 2), rCount = Math.max(1, parseInt(d._rCount, 10) || 1);
    const heeftMeting = ['subj','obj','iod_r','iod_l','eval','plan'].some(w)
        || [...Array(bCount)].some((_, i) => blokHeeftData(`b${i + 1}`)) || [...Array(rCount)].some((_, i) => blokHeeftData(`r${i + 1}`));
    if (heeftMeting) {
        kop(`METING${w('datum') ? ' ' + datumNL(w('datum')) : ''}`);
        if (w('subj') || w('obj')) {
            regels.push('Anamnese');
            regel('  S', w('subj'));
            regel('  O', w('obj'));
            regels.push('');
        }
        for (let i = 1; i <= bCount; i++) if (blokHeeftData(`b${i}`)) blok(`b${i}`, `Huidige bril ${i}`);
        if (w('iod_r') || w('iod_l')) {
            regels.push(`Oogdruk: OD ${w('iod_r') || '-'}  |  OS ${w('iod_l') || '-'}${w('iod_meth') ? '  |  ' + w('iod_meth') : ''}`);
            regels.push('');
        }
        for (let i = 1; i <= rCount; i++) if (blokHeeftData(`r${i}`)) blok(`r${i}`, `Eindrefractie ${i}${d[`r${i}_def`] ? ' (definitief)' : ''}`);
        if (w('eval') || w('plan')) {
            regels.push('Conclusie');
            regel('  E', w('eval'));
            regel('  P', w('plan'));
        }
    }

    const fotos = Array.isArray(kaart.photos) ? kaart.photos : [];
    const pdfs = Array.isArray(kaart.bijlagen) ? kaart.bijlagen : [];
    if (fotos.length || pdfs.length) {
        kop('BIJLAGEN IN DEZE MAP');
        const gewoon = fotos.filter(f => !f.reparatie).length, bijReparatie = fotos.length - gewoon;
        if (gewoon) regels.push(`${gewoon} foto${gewoon === 1 ? '' : "'s"}`);
        if (bijReparatie) regels.push(`${bijReparatie} foto${bijReparatie === 1 ? '' : "'s"} van de reparatie`);
        pdfs.forEach(b => regels.push(`PDF: ${b.bestandsnaam || 'bijlage'}`));
    }

    regels.push('');
    regels.push(`Laatst bijgewerkt: ${new Date(kaart.savedAt || Date.now()).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`);
    return regels.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n') + '\r\n';
}

// Schrijft alleen als de inhoud echt anders is (scheelt onnodig gerommel in de Verkenner)
function schrijfTekstAlsVeranderd(pad, tekst) {
    const inhoud = '﻿' + tekst; // BOM: Kladblok toont é, ë enz. altijd goed
    try { if (fs.readFileSync(pad, 'utf8') === inhoud) return; } catch (e) {}
    fs.mkdirSync(path.dirname(pad), { recursive: true });
    fs.writeFileSync(pad + '.tmp', inhoud, 'utf8');
    fs.renameSync(pad + '.tmp', pad);
}

// Map én bestanden van een kaart op de juiste plek en met de juiste naam zetten
function regelMediaVanKaart(kaartId, kaart, vorigeKaart) {
    const map = zorgVoorMap(kaartId, kaart, vorigeKaart);
    if (!kaart || kaart.verwijderd || !kaart.data) return;
    try {
        schrijfTekstAlsVeranderd(path.join(MEDIA_DIR, map, 'Klantgegevens.txt'), kaartAlsTekst(kaart));
    } catch (e) {
        console.error(`Kon Klantgegevens.txt in "${map}" niet schrijven:`, e.message);
    }
    const namen = gewensteBestandsnamen(kaart);
    const bezet = new Set();
    for (const m of q.mediaVanKaart.all(kaartId)) {
        const ext = path.extname(m.bestand) || '.bin';
        let doelMap = map, basis = namen[m.id];
        if (!basis) {
            // Niet meer op de kaart: opzij zetten in een submap, niet wissen
            doelMap = path.join(map, "Verwijderde foto's");
            basis = path.basename(m.bestand, ext);
        }
        let doel, n = 1;
        do {
            doel = path.join(doelMap, (n === 1 ? basis : `${basis} (${n})`) + ext);
            n++;
        } while (bezet.has(doel.toLowerCase()) || (doel !== m.bestand && fs.existsSync(path.join(MEDIA_DIR, doel))));
        bezet.add(doel.toLowerCase());
        if (doel === m.bestand) continue;
        try {
            verplaats(m.bestand, doel);
            q.zetMediaPad.run(doel, m.id);
        } catch (e) {
            console.error(`Kon "${m.bestand}" niet hernoemen:`, e.message);
        }
    }
}

// Verhuisd van Windows naar Linux (of andersom)? Dan de opgeslagen mappaden omzetten naar
// het scheidingsteken van dit systeem ('\\' op Windows, '/' op Linux).
function zetPadenOmVoorDitSysteem() {
    const ander = path.sep === '/' ? '\\' : '/';
    const zoek = ander === '\\' ? '%\\%' : '%/%';
    const m = db.prepare(`UPDATE media SET bestand = REPLACE(bestand, ?, ?) WHERE bestand LIKE ?`).run(ander, path.sep, zoek);
    const k = db.prepare(`UPDATE kaart_map SET map = REPLACE(map, ?, ?) WHERE map LIKE ?`).run(ander, path.sep, zoek);
    const aantal = Number(m.changes) + Number(k.changes);
    if (aantal) console.log(`${aantal} opgeslagen pad(en) omgezet voor ${path.sep === '/' ? 'Linux' : 'Windows'}.`);
}

// Bij het starten: bestaande mappen (bijv. nog met nummers als naam) een herkenbare naam geven
function regelAlleMappen() {
    let aantal = 0;
    for (const r of q.alleKaarten.all()) {
        const kaart = JSON.parse(r.data);
        const voor = q.getMap.get(r.id)?.map;
        if (!voor) {
            // Oude indeling (versie 70): map heette naar het kaartnummer
            const oudeMap = fs.existsSync(path.join(MEDIA_DIR, r.id)) ? r.id : null;
            if (oudeMap) q.zetMap.run(r.id, oudeMap);
            else {
                const m = q.mediaVanKaart.all(r.id)[0];
                if (m) q.zetMap.run(r.id, path.dirname(m.bestand));
            }
        }
        const vorige = r.verwijderd ? laatsteVersieMetNaam(r.id) : null;
        regelMediaVanKaart(r.id, kaart, vorige);
        if (q.getMap.get(r.id)?.map !== voor) aantal++;
    }
    if (aantal) console.log(`${aantal} map(pen) een herkenbare naam gegeven.`);
}

const qLaatsteVersie = db.prepare('SELECT data FROM kaart_versies WHERE kaart_id = ? AND verwijderd = 0 ORDER BY nr DESC LIMIT 1');
function laatsteVersieMetNaam(kaartId) {
    const r = qLaatsteVersie.get(kaartId);
    return r ? JSON.parse(r.data) : null;
}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// --- Dagelijkse databasekopie ---

function maakDatabaseBackup() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const dag = new Date().toISOString().slice(0, 10);
        const doel = path.join(BACKUP_DIR, `opticien-db-${dag}.db`);
        const tekstDoel = path.join(BACKUP_DIR, `klanten-${dag}.txt`);
        if (!fs.existsSync(doel)) {
            db.exec(`VACUUM INTO '${doel.replace(/'/g, "''")}'`);
            console.log('Databasekopie gemaakt:', path.basename(doel));
        }
        // Elk uur bijwerken, zodat het bestand van vandaag de laatste stand heeft
        const nieuw = !fs.existsSync(tekstDoel);
        schrijfTekstAlsVeranderd(tekstDoel, alleKlantenAlsTekst());
        if (nieuw) console.log('Klantenlijst als tekst gemaakt:', path.basename(tekstDoel));
        for (const patroon of [/^opticien-db-.*\.db$/, /^klanten-.*\.txt$/]) {
            const oud = fs.readdirSync(BACKUP_DIR).filter(f => patroon.test(f)).sort().reverse();
            oud.slice(MAX_DB_BACKUPS).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        }
    } catch (e) {
        console.error('Kon geen databasekopie maken:', e.message);
    }
}

function alleKlantenAlsTekst() {
    const kaarten = q.alleKaarten.all().filter(r => !r.verwijderd).map(r => JSON.parse(r.data))
        .sort((a, b) => klantMapnaam(a).localeCompare(klantMapnaam(b), 'nl'));
    const kop = `ALLE KLANTEN (${kaarten.length}), backup van ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}\r\n`;
    return kop + '\r\n' + kaarten.map(kaartAlsTekst).join('\r\n' + '#'.repeat(60) + '\r\n\r\n');
}

// --- Oude sync (overgangsperiode) ---

function maakBackupVanHuidigeData() {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stempel = new Date().toISOString().replace(/[:.]/g, '-');
    try {
        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `sync-backup-${stempel}.json`));
    } catch (e) {
        console.error('Kon geen backup maken:', e.message);
    }
    try {
        fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('sync-backup-') && f.endsWith('.json'))
            .map(f => ({ pad: path.join(BACKUP_DIR, f), tijd: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.tijd - a.tijd)
            .slice(MAX_BACKUPS).forEach(b => fs.unlinkSync(b.pad));
    } catch (e) {
        console.error('Kon oude backups niet opschonen:', e.message);
    }
}

// --- HTTP ---

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

function send(res, status, bodyObj) {
    const body = JSON.stringify(bodyObj);
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

// --- Slot op foute pogingen ---
// Na MAX_FOUT foute tokens binnen FOUT_VENSTER wordt dat adres BLOKKADE_DUUR geblokkeerd.
// Alleen in het geheugen: een herstart van de server heft alle blokkades op.
const MAX_FOUT = parseInt(process.env.SYNC_MAX_FOUT, 10) || 10;
const FOUT_VENSTER = 15 * 60 * 1000;
const BLOKKADE_DUUR = 60 * 60 * 1000;
const pogingen = new Map(); // adres -> { fouten: [tijdstippen], geblokkeerdTot }

function isPriveAdres(a) {
    a = String(a || '').replace(/^::ffff:/, '');
    return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd]/i.test(a) || /^fe80:/i.test(a);
}

// Het echte adres van de bezoeker. Komt het verzoek via Nginx Proxy Manager (een adres in het
// eigen netwerk), dan geldt het adres dat de proxy doorgeeft; anders het directe adres.
function bezoekerAdres(req) {
    const direct = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!isPriveAdres(direct)) return direct;
    const echt = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
    return String(echt || direct).trim().replace(/^::ffff:/, '');
}

function isGeblokkeerd(adres) {
    const p = pogingen.get(adres);
    return p && p.geblokkeerdTot > Date.now() ? p.geblokkeerdTot : 0;
}

function registreerFout(adres) {
    const nu = Date.now();
    const p = pogingen.get(adres) || { fouten: [], geblokkeerdTot: 0 };
    p.fouten = p.fouten.filter(t => nu - t < FOUT_VENSTER);
    p.fouten.push(nu);
    if (p.fouten.length >= MAX_FOUT) {
        p.geblokkeerdTot = nu + BLOKKADE_DUUR;
        p.fouten = [];
        console.warn(`${new Date().toLocaleString('nl-NL')}: adres ${adres} een uur geblokkeerd na ${MAX_FOUT} foute pogingen.`);
    }
    pogingen.set(adres, p);
}

// Oude registraties opruimen, zodat het geheugen niet volloopt
setInterval(() => {
    const nu = Date.now();
    for (const [a, p] of pogingen) {
        if (p.geblokkeerdTot < nu && !p.fouten.some(t => nu - t < FOUT_VENSTER)) pogingen.delete(a);
    }
}, 10 * 60 * 1000).unref();

function checkAuth(req) {
    const auth = Buffer.from(req.headers['authorization'] || '');
    const verwacht = Buffer.from(`Bearer ${TOKEN}`);
    return auth.length === verwacht.length && crypto.timingSafeEqual(auth, verwacht);
}

function tokenGelijk(req, token) {
    const auth = Buffer.from(req.headers['authorization'] || '');
    const verwacht = Buffer.from(`Bearer ${token}`);
    return auth.length === verwacht.length && crypto.timingSafeEqual(auth, verwacht);
}

function ruimPostbusOp() {
    try {
        if (!fs.existsSync(POSTBUS_DIR)) return;
        const nu = Date.now();
        for (const f of fs.readdirSync(POSTBUS_DIR)) {
            const pad = path.join(POSTBUS_DIR, f);
            if (nu - fs.statSync(pad).mtimeMs > POSTBUS_BEWAARTIJD) fs.unlinkSync(pad);
        }
    } catch (e) { console.error('Postbus opruimen mislukt:', e.message); }
}
setInterval(ruimPostbusOp, 60 * 60 * 1000).unref();

function leesBody(req, max) {
    return new Promise((resolve, reject) => {
        const delen = [];
        let lengte = 0;
        req.on('data', chunk => {
            lengte += chunk.length;
            if (lengte > max) { reject(new Error('te groot')); req.destroy(); return; }
            delen.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(delen)));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const adres = bezoekerAdres(req);
    const tot = isGeblokkeerd(adres);
    if (tot) {
        const minuten = Math.ceil((tot - Date.now()) / 60000);
        res.setHeader('Retry-After', String(minuten * 60));
        send(res, 429, { error: `Te veel foute pogingen. Probeer het over ${minuten} minuten opnieuw.` });
        return;
    }
    // Foto in de postbus leggen: met het postbus-token (of het gewone token)
    if (req.method === 'POST' && req.url.split('?')[0] === '/postbus') {
        if (!POSTBUS_AAN && !checkAuth(req)) { registreerFout(adres); send(res, 401, { error: 'Unauthorized: postbus staat uit of token klopt niet' }); return; }
        if (!checkAuth(req) && !tokenGelijk(req, POSTBUS_TOKEN)) { registreerFout(adres); send(res, 401, { error: 'Unauthorized: token klopt niet' }); return; }
        // Alleen het gewone token zet de teller van foute pogingen terug; het beperkte postbus-token niet
        if (checkAuth(req)) pogingen.delete(adres);
        try {
            const type = String(req.headers['content-type'] || '').split(';')[0].trim();
            if (type !== 'image/jpeg') { send(res, 415, { error: 'Alleen JPEG-foto\'s' }); return; }
            fs.mkdirSync(POSTBUS_DIR, { recursive: true });
            ruimPostbusOp();
            if (fs.readdirSync(POSTBUS_DIR).filter(f => f.endsWith('.jpg')).length >= POSTBUS_MAX_AANTAL) { send(res, 507, { error: 'Postbus is vol' }); return; }
            const inhoud = await leesBody(req, POSTBUS_MAX_BYTES);
            if (inhoud.length < 4 || inhoud[0] !== 0xFF || inhoud[1] !== 0xD8) { send(res, 400, { error: 'Geen JPEG-foto' }); return; }
            const id = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(path.join(POSTBUS_DIR, id + '.jpg'), inhoud);
            const soort = new URL(req.url, 'http://x').searchParams.get('soort');
            if (POSTBUS_SOORTEN.includes(soort)) fs.writeFileSync(path.join(POSTBUS_DIR, id + '.json'), JSON.stringify({ soort, tijd: Date.now() }));
            console.log(`${new Date().toLocaleString('nl-NL')}: foto in de postbus (${Math.round(inhoud.length / 1024)} kB)`);
            send(res, 200, { ok: true, id });
        } catch (e) {
            if (e.message === 'te groot') { send(res, 413, { error: 'Foto te groot' }); return; }
            send(res, 500, { error: 'Serverfout: ' + e.message });
        }
        return;
    }
    if (!checkAuth(req)) {
        registreerFout(adres);
        send(res, 401, { error: 'Unauthorized: token klopt niet' });
        return;
    }
    pogingen.delete(adres); // goed token: teller weer op nul

    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    try {
        // Status: om te testen of de server bereikbaar is
        if (req.method === 'GET' && p === '/status') {
            send(res, 200, { ok: true, versie: 2, postbus: POSTBUS_AAN, ai: !!MISTRAL_KEY, ...q.tellingen.get(), seq: q.maxSeq.get().s });
            return;
        }

        // Verslag laten uitwerken door Mistral (alleen met het gewone token)
        if (p === '/ai' && req.method === 'POST') {
            if (!MISTRAL_KEY) { send(res, 503, { error: 'Er is geen Mistral-sleutel ingesteld in de add-on' }); return; }
            let vraag;
            try { vraag = JSON.parse((await leesBody(req, 200 * 1024)).toString('utf8')); }
            catch (e) { send(res, 400, { error: 'Ongeldig verzoek' }); return; }
            const berichten = Array.isArray(vraag.berichten) ? vraag.berichten : [];
            const goed = berichten.length >= 1 && berichten.length <= 4 && berichten.every(b => b && ['system', 'user'].includes(b.rol) && typeof b.tekst === 'string');
            const lengte = berichten.reduce((n, b) => n + (b && typeof b.tekst === 'string' ? b.tekst.length : 0), 0);
            if (!goed || lengte > AI_MAX_TEKENS) { send(res, 400, { error: 'Ongeldig of te lang verzoek' }); return; }
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 90000);
                const r = await fetch(MISTRAL_URL, {
                    method: 'POST', signal: ctrl.signal,
                    headers: { 'Authorization': 'Bearer ' + MISTRAL_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ model: MISTRAL_MODEL, temperature: 0.2, max_tokens: 2000,
                        messages: berichten.map(b => ({ role: b.rol, content: b.tekst })) })
                }).finally(() => clearTimeout(t));
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    const reden = r.status === 401 ? 'Mistral-sleutel klopt niet' : r.status === 429 ? 'Mistral: te veel verzoeken of tegoed op' : 'Mistral gaf fout ' + r.status;
                    console.warn(`${new Date().toLocaleString('nl-NL')}: Mistral-fout ${r.status}`);
                    send(res, 502, { error: reden }); return;
                }
                const tekst = j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
                console.log(`${new Date().toLocaleString('nl-NL')}: verslag uitgewerkt door Mistral (${MISTRAL_MODEL})`);
                send(res, 200, { ok: true, tekst, model: j.model || MISTRAL_MODEL });
            } catch (e) {
                send(res, 504, { error: e.name === 'AbortError' ? 'Mistral reageert niet' : 'Mistral niet bereikbaar' });
            }
            return;
        }

        // Postbus: lijst van gewone foto's die nog niet bij een klant zijn gezet (alleen met het gewone token)
        if (req.method === 'GET' && p === '/postbus') {
            const lijst = [];
            try {
                if (fs.existsSync(POSTBUS_DIR)) for (const f of fs.readdirSync(POSTBUS_DIR)) {
                    const m = f.match(/^([a-f0-9]{32})\.json$/);
                    if (!m || !fs.existsSync(path.join(POSTBUS_DIR, m[1] + '.jpg'))) continue;
                    try { const j = JSON.parse(fs.readFileSync(path.join(POSTBUS_DIR, f), 'utf8')); if (POSTBUS_SOORTEN.includes(j.soort)) lijst.push({ id: m[1], soort: j.soort, tijd: j.tijd || 0 }); } catch (e) {}
                }
            } catch (e) {}
            lijst.sort((a, b) => a.tijd - b.tijd);
            send(res, 200, { fotos: lijst });
            return;
        }

        // Postbus: foto ophalen of weggooien (alleen met het gewone token)
        const pbMatch = p.match(/^\/postbus\/([a-f0-9]{32})$/);
        if (pbMatch && (req.method === 'GET' || req.method === 'DELETE')) {
            const pad = path.join(POSTBUS_DIR, pbMatch[1] + '.jpg');
            if (!fs.existsSync(pad)) { send(res, 404, { error: 'Foto niet (meer) in de postbus' }); return; }
            if (req.method === 'DELETE') { fs.unlinkSync(pad); try { fs.unlinkSync(path.join(POSTBUS_DIR, pbMatch[1] + '.json')); } catch (e) {} send(res, 200, { ok: true }); return; }
            const inhoud = fs.readFileSync(pad);
            res.writeHead(200, { ...CORS, 'Content-Type': 'image/jpeg', 'Content-Length': inhoud.length });
            res.end(inhoud);
            return;
        }

        // Alle kaarten die sinds een bepaald volgnummer zijn gewijzigd
        if (req.method === 'GET' && p === '/kaarten') {
            const sinds = parseInt(url.searchParams.get('sinds'), 10) || 0;
            const rijen = q.sinds.all(sinds);
            send(res, 200, {
                seq: q.maxSeq.get().s,
                kaarten: rijen.map(r => ({ id: r.id, savedAt: r.saved_at, verwijderd: !!r.verwijderd, kaart: JSON.parse(r.data) }))
            });
            return;
        }

        // Instellingen die op alle toestellen gelijk moeten zijn (bijv. de meenemen-lijst); nieuwste wint
        const instMatch = p.match(/^\/instelling\/([a-z0-9_-]{1,40})$/);
        if (instMatch && (req.method === 'GET' || req.method === 'PUT')) {
            const sleutel = 'inst:' + instMatch[1];
            const rij = q.getInstelling.get(sleutel);
            if (req.method === 'GET') {
                const na = url.searchParams.get('na') || '';
                if (!rij) { send(res, 200, { savedAt: null }); return; }
                if (na && rij.saved_at <= na) { send(res, 200, { savedAt: rij.saved_at }); return; }
                send(res, 200, { savedAt: rij.saved_at, waarde: JSON.parse(rij.data) });
                return;
            }
            const body = JSON.parse((await leesBody(req, MAX_JSON_BYTES)).toString('utf8'));
            if (!('waarde' in body)) { send(res, 400, { error: 'Verwacht { savedAt, waarde }' }); return; }
            const savedAt = typeof body.savedAt === 'string' && body.savedAt ? body.savedAt : new Date().toISOString();
            if (rij && rij.saved_at > savedAt) {
                send(res, 200, { ok: false, nieuwer: true, savedAt: rij.saved_at, waarde: JSON.parse(rij.data) });
                return;
            }
            q.zetInstelling.run(sleutel, JSON.stringify(body.waarde), savedAt);
            console.log(`instelling ${instMatch[1]} ontvangen`);
            send(res, 200, { ok: true, savedAt });
            return;
        }

        // Klantenboek uit OS Optiek, gedeeld tussen de toestellen
        if (p === '/klantenboek' && (req.method === 'GET' || req.method === 'PUT')) {
            const rij = q.getInstelling.get('klantenboek');
            if (req.method === 'GET') {
                const na = url.searchParams.get('na') || '';
                if (!rij) { send(res, 200, { savedAt: null }); return; }
                if (na && rij.saved_at <= na) { send(res, 200, { savedAt: rij.saved_at }); return; }
                send(res, 200, { savedAt: rij.saved_at, klanten: JSON.parse(rij.data) });
                return;
            }
            const body = JSON.parse((await leesBody(req, MAX_JSON_BYTES)).toString('utf8'));
            if (!Array.isArray(body.klanten)) { send(res, 400, { error: 'Verwacht { klanten: [...] }' }); return; }
            const savedAt = typeof body.savedAt === 'string' && body.savedAt ? body.savedAt : new Date().toISOString();
            if (rij && rij.saved_at > savedAt) {
                send(res, 200, { ok: false, nieuwer: true, savedAt: rij.saved_at, klanten: JSON.parse(rij.data) });
                return;
            }
            q.zetInstelling.run('klantenboek', JSON.stringify(body.klanten), savedAt);
            console.log(`klantenboek ontvangen: ${body.klanten.length} klanten`);
            send(res, 200, { ok: true, savedAt });
            return;
        }

        // Een of meer gewijzigde kaarten ontvangen
        if (req.method === 'POST' && p === '/kaarten') {
            const body = JSON.parse((await leesBody(req, MAX_JSON_BYTES)).toString('utf8'));
            if (!Array.isArray(body.kaarten)) { send(res, 400, { error: 'Verwacht { kaarten: [...] }' }); return; }
            send(res, 200, verwerkKaarten(body.kaarten));
            return;
        }

        // Foto of PDF ophalen / opslaan
        const mediaMatch = p.match(/^\/media\/([^/]+)$/);
        if (mediaMatch) {
            const id = veiligId(decodeURIComponent(mediaMatch[1]));
            if (!id) { send(res, 400, { error: 'Ongeldig id' }); return; }

            if (req.method === 'GET') {
                const rij = q.getMedia.get(id);
                const pad = rij && path.join(MEDIA_DIR, rij.bestand);
                if (!rij || !fs.existsSync(pad)) { send(res, 404, { error: 'Niet gevonden' }); return; }
                const inhoud = fs.readFileSync(pad);
                res.writeHead(200, { ...CORS, 'Content-Type': rij.type || 'application/octet-stream', 'Content-Length': inhoud.length });
                res.end(inhoud);
                return;
            }

            if (req.method === 'PUT') {
                const kaartId = veiligId(url.searchParams.get('kaart')) || '_los';
                const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
                const inhoud = await leesBody(req, MAX_MEDIA_BYTES);
                if (!inhoud.length) { send(res, 400, { error: 'Leeg bestand' }); return; }
                const rij = q.getKaart.get(kaartId);
                const kaart = rij ? JSON.parse(rij.data) : null;
                const map = zorgVoorMap(kaartId, kaart, null);
                fs.mkdirSync(path.join(MEDIA_DIR, map), { recursive: true });
                const bestaandMedia = q.getMedia.get(id);
                const bestand = bestaandMedia ? bestaandMedia.bestand : path.join(map, id + (EXT[type] || '.bin'));
                const tijdelijk = path.join(MEDIA_DIR, bestand + '.tmp');
                fs.mkdirSync(path.dirname(tijdelijk), { recursive: true });
                fs.writeFileSync(tijdelijk, inhoud);
                fs.renameSync(tijdelijk, path.join(MEDIA_DIR, bestand));
                q.putMedia.run(id, kaartId, bestand, type, inhoud.length, new Date().toISOString());
                // Staat deze foto al op de kaart? Dan meteen de herkenbare naam geven
                if (kaart && !kaart.verwijderd) regelMediaVanKaart(kaartId, kaart, null);
                send(res, 200, { ok: true });
                return;
            }
        }

        // --- Oude endpoints (overgangsperiode) ---
        if (req.method === 'GET' && p === '/sync') {
            fs.readFile(DATA_FILE, 'utf8', (err, raw) => {
                if (err) { send(res, 200, { savedAt: null, data: {} }); return; }
                try { send(res, 200, JSON.parse(raw)); } catch (e) { send(res, 200, { savedAt: null, data: {} }); }
            });
            return;
        }
        if (req.method === 'GET' && p === '/backups') {
            if (!fs.existsSync(BACKUP_DIR)) { send(res, 200, { backups: [] }); return; }
            const lijst = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('sync-backup-') && f.endsWith('.json'))
                .map(f => ({ naam: f, tijd: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
                .sort((a, b) => b.tijd - a.tijd);
            send(res, 200, { backups: lijst });
            return;
        }
        if (req.method === 'POST' && p === '/sync') {
            const parsed = JSON.parse((await leesBody(req, MAX_JSON_BYTES)).toString('utf8'));
            maakBackupVanHuidigeData();
            fs.writeFileSync(DATA_FILE, JSON.stringify(parsed));
            send(res, 200, { ok: true, savedAt: parsed.savedAt || null });
            return;
        }

        send(res, 404, { error: 'Onbekend endpoint' });
    } catch (e) {
        if (e.message === 'te groot') { send(res, 413, { error: 'Bestand of bericht te groot' }); return; }
        if (e instanceof SyntaxError) { send(res, 400, { error: 'Ongeldige JSON ontvangen' }); return; }
        console.error('Fout:', e);
        send(res, 500, { error: 'Serverfout: ' + e.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const t = q.tellingen.get();
    console.log(`Sync-server v2 draait op poort ${PORT}`);
    console.log(`Database: ${DB_FILE} (${t.kaarten} klantkaarten, ${t.media} foto's/PDF's)`);
    if (POSTBUS_AAN) console.log('Postbus voor foto\'s van de PD-meting staat aan.');
    else if (POSTBUS_TOKEN) console.warn('Postbus staat uit: het postbus-token moet minstens 16 tekens zijn en mag niet gelijk zijn aan het gewone token.');
    if (MISTRAL_KEY) console.log(`Uitwerken met Mistral staat aan (${MISTRAL_MODEL}).`);
    if (TOKEN === 'VERANDER_DIT_TOKEN') {
        console.warn('⚠️  Let op: je gebruikt nog het standaard-token! Zet bij TOKEN hetzelfde token als in je oude server.');
    }
    try { zetPadenOmVoorDitSysteem(); } catch (e) { console.error('Paden omzetten mislukt:', e.message); }
    try { regelAlleMappen(); } catch (e) { console.error('Mappen hernoemen bij het starten mislukt:', e.message); }
    maakDatabaseBackup();
    setInterval(maakDatabaseBackup, 60 * 60 * 1000); // elk uur: kopie van vandaag maken (als die er nog niet is) en klantenlijst bijwerken
});

// Netjes afsluiten, zodat de database niet half geschreven achterblijft
function afsluiten() {
    server.close();
    try { db.close(); } catch (e) {}
    process.exit(0);
}
process.on('SIGINT', afsluiten);
process.on('SIGTERM', afsluiten);
