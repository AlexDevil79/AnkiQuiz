'use strict';
/* Lecture des fichiers .apkg (anciens formats anki2/anki21 et récent anki21b zstd) */
const library = []; // {file, name, key, cards:[{front, answer, src, key}]}
let SQLm;

/* ---- protobuf minimal ---- */
function pbParse(u8) {
  const out = [];
  let i = 0;
  const rv = () => { let r = 0, s = 0, b; do { b = u8[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80 && i <= u8.length); return r; };
  while (i < u8.length) {
    const tag = rv(), f = Math.floor(tag / 8), w = tag & 7;
    let v;
    if (w === 0) v = rv();
    else if (w === 2) { const l = rv(); v = u8.subarray(i, i + l); i += l; }
    else if (w === 1) { v = u8.subarray(i, i + 8); i += 8; }
    else if (w === 5) { v = u8.subarray(i, i + 4); i += 4; }
    else break;
    out.push([f, v]);
  }
  return out;
}
const pbStr = (u8, f) => { const e = u8 && pbParse(u8).find((x) => x[0] === f); return e ? new TextDecoder().decode(e[1]) : ''; };
const pbInt = (u8, f) => { const e = u8 && pbParse(u8).find((x) => x[0] === f); return e ? e[1] : 0; };

const isZstd = (b) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
const unzstd = (b) => {
  if (!isZstd(b)) return b;
  if (!window.fzstd) throw new Error('zstd indisponible');
  return fzstd.decompress(b);
};
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---- modèles de cartes ---- */
function renderTpl(tpl, fields, ord, frontSide, isQuestion) {
  for (let i = 0; i < 5; i++) {
    const next = tpl.replace(/\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (m, k, name, inner) => {
      const has = strip(fields[name.trim()] || '').trim() !== '';
      return (k === '#') === has ? inner : '';
    });
    if (next === tpl) break;
    tpl = next;
  }
  return tpl.replace(/\{\{([^}]+)\}\}/g, (m, raw) => {
    const name = raw.trim();
    if (name === 'FrontSide') return frontSide;
    const parts = name.split(':');
    const filters = parts.slice(0, -1);
    const val = fields[parts[parts.length - 1]] || '';
    if (filters.includes('type') || filters.includes('hint')) return '';
    if (filters.includes('cloze')) return cloze(val, ord + 1, isQuestion);
    if (filters.includes('text')) return strip(val);
    return val;
  });
}

function cloze(text, n, isQuestion) {
  return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, c, t, hint) => {
    if (+c !== n) return t;
    return isQuestion ? `<b>[${hint || '...'}]</b>` : `<b>${t}</b>`;
  });
}

/* ---- lecture de la base ---- */
function readLegacy(db) {
  let models = {}, decks = {};
  try {
    const col = db.exec('SELECT models, decks FROM col')[0].values[0];
    const m = JSON.parse(col[0] || '{}'), d = JSON.parse(col[1] || '{}');
    for (const id in m) models[id] = { type: m[id].type, flds: m[id].flds, tmpls: m[id].tmpls };
    for (const id in d) decks[id] = d[id].name;
  } catch {}
  return { models, decks };
}

function readModern(db) {
  const q = (sql) => { try { return db.exec(sql)[0]?.values || []; } catch { return []; } };
  const models = {}, decks = {};
  for (const [id, cfg] of q('SELECT id, config FROM notetypes')) models[id] = { type: pbInt(cfg, 1) === 1 ? 1 : 0, flds: [], tmpls: [] };
  for (const [ntid, , name] of q('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')) if (models[ntid]) models[ntid].flds.push({ name });
  for (const [ntid, , cfg] of q('SELECT ntid, ord, config FROM templates ORDER BY ntid, ord')) if (models[ntid]) models[ntid].tmpls.push({ qfmt: pbStr(cfg, 1), afmt: pbStr(cfg, 2) });
  for (const [id, name] of q('SELECT id, name FROM decks')) decks[id] = String(name).replace(/\x1f/g, '::');
  return { models, decks };
}

async function loadApkg(file, fname) {
  fname = fname || file.name;
  const zip = await JSZip.loadAsync(file);
  const dbName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => zip.file(n));
  if (!dbName) throw new Error('Fichier .apkg invalide');
  const modern = dbName === 'collection.anki21b';
  SQLm = SQLm || (await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` }));
  let bytes = await zip.file(dbName).async('uint8array');
  if (modern) bytes = unzstd(bytes);
  const db = new SQLm.Database(bytes);

  const media = {};
  try {
    const m = zip.file('media');
    if (m) {
      if (modern) {
        pbParse(unzstd(await m.async('uint8array'))).filter((e) => e[0] === 1).forEach((e, i) => { media[pbStr(e[1], 1)] = String(i); });
      } else {
        const inv = JSON.parse(await m.async('string'));
        for (const k in inv) media[inv[k]] = k;
      }
    }
  } catch {}

  const { models, decks } = modern ? readModern(db) : readLegacy(db);
  const rows = db.exec('SELECT c.did, c.ord, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id')[0]?.values || [];
  db.close();

  const src = { zip, media };
  const byDeck = new Map();
  for (const [did, ord, mid, flds] of rows) {
    const vals = flds.split('\x1f');
    const model = models[mid];
    let front, answer;
    if (model && model.tmpls.length) {
      const fields = {};
      model.flds.forEach((f, i) => (fields[f.name] = vals[i] || ''));
      const tpl = model.tmpls[model.type === 1 ? 0 : Math.min(ord, model.tmpls.length - 1)];
      front = renderTpl(tpl.qfmt, fields, ord, '', true);
      answer = renderTpl(tpl.afmt, fields, ord, front, false).split(/<hr id=["']?answer["']?\s*\/?>/i).pop();
    } else { front = vals[0] || ''; answer = vals[1] || ''; }
    if (!strip(front).trim() && !/<img/i.test(front)) continue;
    const name = decks[did] || fname.replace(/\.apkg$/i, '');
    if (!byDeck.has(name)) byDeck.set(name, []);
    byDeck.get(name).push({ front, answer, src });
  }
  removeFile(fname);
  for (const [name, cards] of byDeck) {
    const key = `${fname}|${name}`;
    cards.forEach((c, i) => (c.key = `${key}|${i}`));
    library.push({ file: fname, name, key, cards });
  }
}

function removeFile(fname) {
  for (let i = library.length - 1; i >= 0; i--) if (library[i].file === fname) library.splice(i, 1);
}

async function inlineMedia(html, src) {
  const re = /(<img[^>]*?\ssrc=)(["'])([^"']+)\2/gi;
  let out = html;
  for (const m of [...html.matchAll(re)]) {
    let name = m[3];
    try { name = decodeURIComponent(name); } catch {}
    const key = src.media[name] ?? src.media[m[3]];
    const entry = key !== undefined && src.zip.file(key);
    if (!entry) continue;
    try {
      const data = unzstd(await entry.async('uint8array'));
      const ext = name.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'image/jpeg';
      out = out.replace(m[0], `${m[1]}"data:${mime};base64,${u8ToB64(data)}"`);
    } catch {}
  }
  return out.replace(/\[sound:[^\]]*\]/g, '');
}
