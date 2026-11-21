'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; };

function sanitize(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,iframe,object,embed,link,meta,audio,video,form').forEach((n) => n.remove());
  d.body.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase();
      if (k.startsWith('on') || (['href', 'src'].includes(k) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
  });
  return d.body.innerHTML;
}

/* ================= Anki (.apkg) ================= */
const library = []; // {name, cards:[{front, answer, src}]}
let SQLm;

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

async function loadApkg(file) {
  const zip = await JSZip.loadAsync(file);
  const dbName = ['collection.anki21', 'collection.anki2'].find((n) => zip.file(n));
  if (!dbName) {
    if (zip.file('collection.anki21b')) throw new Error("Format récent non supporté : ré-exporte le deck dans Anki en cochant « Compatible avec les anciennes versions d'Anki ».");
    throw new Error('Fichier .apkg invalide');
  }
  SQLm = SQLm || (await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` }));
  const db = new SQLm.Database(await zip.file(dbName).async('uint8array'));
  const media = {};
  try {
    const m = zip.file('media');
    if (m) { const inv = JSON.parse(await m.async('string')); for (const k in inv) media[inv[k]] = k; }
  } catch {}
  let models = {}, decks = {};
  try { const col = db.exec('SELECT models, decks FROM col')[0].values[0]; models = JSON.parse(col[0] || '{}'); decks = JSON.parse(col[1] || '{}'); } catch {}
  const rows = db.exec('SELECT c.did, c.ord, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid')[0]?.values || [];
  db.close();
  const src = { zip, media };
  const byDeck = new Map();
  for (const [did, ord, mid, flds] of rows) {
    const vals = flds.split('\x1f');
    const model = models[mid];
    let front, answer;
    if (model) {
      const fields = {};
      model.flds.forEach((f, i) => (fields[f.name] = vals[i] || ''));
      const tpl = model.tmpls[model.type === 1 ? 0 : Math.min(ord, model.tmpls.length - 1)];
      front = renderTpl(tpl.qfmt, fields, ord, '', true);
      answer = renderTpl(tpl.afmt, fields, ord, front, false).split(/<hr id=["']?answer["']?\s*\/?>/i).pop();
    } else { front = vals[0] || ''; answer = vals[1] || ''; }
    if (!strip(front).trim() && !/<img/i.test(front)) continue;
    const name = decks[did]?.name || file.name.replace(/\.apkg$/i, '');
    if (!byDeck.has(name)) byDeck.set(name, []);
    byDeck.get(name).push({ front, answer, src });
  }
  for (const [name, cards] of byDeck) library.push({ name, cards });
}

async function inlineMedia(html, src) {
  const re = /(<img[^>]*?\ssrc=)(["'])([^"']+)\2/gi;
  const found = [...html.matchAll(re)];
  let out = html;
  for (const m of found) {
    const key = src.media[decodeURIComponent(m[3])] ?? src.media[m[3]];
    const entry = key !== undefined && src.zip.file(key);
    if (!entry) continue;
    const ext = m[3].split('.').pop().toLowerCase();
    const mime = { png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'image/jpeg';
    out = out.replace(m[0], `${m[1]}"data:${mime};base64,${await entry.async('base64')}"`);
  }
  return out.replace(/\[sound:[^\]]*\]/g, '');
}

/* ================= Etat global ================= */
let role = null; // 'host' | 'player'
let peer = null;
let myName = '';
let S = null; // état public reçu (joueur) ou calculé (maître)
let timerEnd = 0, lastSeq = -1, showAns = false;

// côté maître
let G = null;
const conns = new Map(); // pseudo -> connexion
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id));
}

/* ================= MAÎTRE ================= */
function newGame() {
  return { code: '', phase: 'lobby', players: {}, queue: [], idx: 0, locked: new Set(), buzzer: null, seq: 0, current: null, result: null, settings: { secs: 10, nb: 20, auto: false }, timer: null };
}

function startHost() {
  role = 'host';
  G = G || newGame();
  const code = genCode();
  peer = new Peer('qanki-' + code);
  peer.on('error', (e) => { if (e.type === 'unavailable-id') { peer.destroy(); startHost(); } else alert('Erreur réseau : ' + e.type); });
  peer.on('open', () => {
    G.code = code;
    $('#roomCode').textContent = code;
    $('#roomTag').textContent = 'Room ' + code;
    show('setup');
  });
  peer.on('connection', (c) => {
    c.on('data', (d) => onHostMsg(c, d));
    c.on('close', () => onLeave(c));
  });
}

const connected = () => Object.values(G.players).filter((p) => p.connected);

function publicState(forHost) {
  const s = {
    code: G.code, phase: G.phase, idx: G.idx, total: G.queue.length, seq: G.seq,
    secs: G.settings.secs, buzzer: G.buzzer, lastBuzzer: G.lastBuzzer || null, locked: [...G.locked], result: G.result,
    front: G.current?.front || '',
    answer: forHost || G.phase === 'reveal' ? G.current?.answer || '' : '',
    players: Object.values(G.players).map(({ name, ready, score, connected }) => ({ name, ready, score, connected })),
  };
  return s;
}

function broadcast() {
  const msg = { t: 'state', s: publicState(false) };
  for (const c of conns.values()) if (c.open) c.send(msg);
  S = publicState(true);
  render();
  if (G.phase === 'lobby') updateSetup();
}

function onHostMsg(c, d) {
  if (d.t === 'join') {
    const name = String(d.name || '').trim().slice(0, 20);
    if (!name) return c.send({ t: 'error', msg: 'Pseudo invalide' });
    const ex = G.players[name];
    if (ex && ex.connected) return c.send({ t: 'error', msg: 'Pseudo déjà pris' });
    G.players[name] = ex ? Object.assign(ex, { connected: true }) : { name, ready: false, score: 0, connected: true };
    c.pname = name;
    conns.set(name, c);
    broadcast();
    checkAuto();
    return;
  }
  const name = c.pname;
  const p = G.players[name];
  if (!p) return;
  if (d.t === 'ready' && G.phase === 'lobby') { p.ready = !!d.v; broadcast(); checkAuto(); }
  if (d.t === 'buzz' && G.phase === 'question' && !G.locked.has(name)) {
    G.phase = 'answering'; G.buzzer = name; G.lastBuzzer = name; G.seq++;
    clearTimeout(G.timer);
    G.timer = setTimeout(refuse, G.settings.secs * 1000);
    broadcast();
  }
}

function onLeave(c) {
  const name = c.pname;
  if (!name || conns.get(name) !== c) return;
  conns.delete(name);
  if (G.phase === 'lobby') delete G.players[name];
  else G.players[name].connected = false;
  if (G.phase === 'answering' && G.buzzer === name) return refuse();
  if (G.phase === 'question') checkAllLocked();
  broadcast();
}

function checkAuto() {
  const c = connected();
  if (G.phase === 'lobby' && G.settings.auto && c.length && c.every((p) => p.ready)) startGame();
}

async function startGame() {
  const sel = [...document.querySelectorAll('.deckSel:checked')].flatMap((i) => library[+i.value].cards);
  if (!sel.length) return alert('Sélectionne au moins un deck.');
  G.settings = { secs: Math.max(2, +$('#secs').value || 10), nb: Math.max(1, +$('#nbQ').value || 20), auto: $('#auto').checked };
  for (let i = sel.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sel[i], sel[j]] = [sel[j], sel[i]]; }
  G.queue = sel.slice(0, G.settings.nb);
  G.idx = 0;
  Object.values(G.players).forEach((p) => (p.score = 0));
  await loadQuestion();
}

async function loadQuestion() {
  const card = G.queue[G.idx];
  G.current = { front: await inlineMedia(card.front, card.src), answer: await inlineMedia(card.answer, card.src) };
  G.locked = new Set(); G.buzzer = null; G.lastBuzzer = null; showAns = false; G.result = null; G.phase = 'question';
  broadcast();
}

function checkAllLocked() {
  if (connected().every((p) => G.locked.has(p.name))) { G.phase = 'reveal'; G.result = { none: true }; }
}

function refuse() {
  if (G.phase !== 'answering') return;
  clearTimeout(G.timer);
  G.locked.add(G.buzzer); G.buzzer = null; G.phase = 'question';
  checkAllLocked();
  broadcast();
}

function validate() {
  if (G.phase !== 'answering' && G.phase !== 'question') return;
  clearTimeout(G.timer);
  const w = G.players[G.lastBuzzer];
  if (w) w.score++;
  G.result = w ? { name: w.name } : { none: true }; G.buzzer = null; G.phase = 'reveal';
  broadcast();
}

function skip() { G.phase = 'reveal'; G.result = { none: true }; G.buzzer = null; broadcast(); }

async function next() {
  G.idx++;
  if (G.idx >= G.queue.length) { G.phase = 'end'; G.current = null; broadcast(); } else await loadQuestion();
}

function backToLobby() {
  G.phase = 'lobby'; G.current = null; G.queue = [];
  Object.values(G.players).forEach((p) => { p.ready = false; p.score = 0; });
  broadcast();
  show('setup');
}

/* ---- écran de préparation (maître) ---- */
function updateSetup() {
  const ps = Object.values(G.players);
  $('#lobbyPlayers').innerHTML = ps.length
    ? '<table>' + ps.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.ready ? '✅ prêt' : '⏳'}</td></tr>`).join('') + '</table>'
    : '<p class="muted">En attente de joueurs…</p>';
  $('#startBtn').disabled = !ps.length || !library.length;
}

function updateDecks() {
  $('#deckList').innerHTML = library.map((d, i) => `<label class="deck"><input type="checkbox" class="deckSel" value="${i}" checked> ${esc(d.name)} <span class="muted">(${d.cards.length} cartes)</span></label>`).join('');
  updateSetup();
}

/* ================= JOUEUR ================= */
function joinRoom(code, name) {
  role = 'player'; myName = name;
  $('#joinErr').textContent = 'Connexion…';
  peer = new Peer();
  peer.on('error', (e) => { $('#joinErr').textContent = e.type === 'peer-unavailable' ? 'Room introuvable' : 'Erreur réseau : ' + e.type; });
  peer.on('open', () => {
    const c = peer.connect('qanki-' + code, { reliable: true });
    c.on('open', () => c.send({ t: 'join', name }));
    c.on('data', (d) => {
      if (d.t === 'error') { $('#joinErr').textContent = d.msg; c.close(); return; }
      if (d.t === 'state') { if (!S) { $('#roomTag').textContent = 'Room ' + code; } S = d.s; render(); }
    });
    c.on('close', () => { if (S) { S = null; $('#game').innerHTML = '<div class="card center"><p>Connexion perdue.</p><button onclick="location.reload()">Reconnecter</button></div>'; } });
    window.conn = c;
  });
  try { localStorage.setItem('qa-name', name); } catch {}
}

const send = (m) => window.conn && window.conn.open && window.conn.send(m);

/* ================= Rendu commun ================= */
function chips() {
  return '<div class="chips">' + [...S.players].sort((a, b) => b.score - a.score).map((p) => {
    const cls = ['chip', !p.connected && 'off', S.buzzer === p.name && 'buzz', S.locked.includes(p.name) && S.phase !== 'reveal' && 'locked', S.phase === 'lobby' && p.ready && 'ready'].filter(Boolean).join(' ');
    return `<span class="${cls}">${esc(p.name)} · ${p.score}</span>`;
  }).join('') + '</div>';
}

function hostActions(answering) {
  const last = S.lastBuzzer;
  return '<div class="actions">' +
    (last ? `<button class="ok" id="okBtn">✓ Valider (+1 ${esc(last)})</button>` : '<button id="skipBtn">Passer la question</button>') +
    (answering ? '<button class="ko" id="koBtn">✗ Refuser</button>' : '') +
    `</div><div class="actions" style="margin-top:14px"><button id="ansBtn">${showAns ? '🙈 Masquer' : '👁 Afficher'} la réponse</button></div>`;
}

function render() {
  if (!S) return;
  if (role === 'host' && S.phase === 'lobby') return show('setup');
  show('game');
  const host = role === 'host';
  let h = chips();
  const qBox = () => `<div class="card"><div class="muted center">Question ${S.idx + 1} / ${S.total}</div><div class="question">${sanitize(S.front)}</div>${((host && showAns) || S.phase === 'reveal') && S.answer ? `<div class="answer">${sanitize(S.answer)}</div>` : ''}</div>`;

  if (S.phase === 'lobby') {
    const me = S.players.find((p) => p.name === myName);
    h += `<div class="card center"><h2>Salle d'attente</h2><p class="muted">Le maître lancera la partie.</p><button id="readyBtn" class="${me?.ready ? 'ok' : 'primary'}">${me?.ready ? '✅ Prêt (annuler)' : 'Je suis prêt !'}</button></div>`;
  } else if (S.phase === 'question') {
    h += qBox();
    if (host) h += hostActions(false);
    else h += `<button id="buzz" ${S.locked.includes(myName) ? 'disabled' : ''}>${S.locked.includes(myName) ? 'Bloqué' : 'BUZZ'}</button>`;
  } else if (S.phase === 'answering') {
    h += qBox();
    h += `<div class="banner">🔔 <b>${esc(S.buzzer)}</b> répond !</div><div class="timer" id="timer"></div>`;
    if (host) h += hostActions(true);
    else h += '<button id="buzz" disabled>…</button>';
  } else if (S.phase === 'reveal') {
    h += qBox();
    h += `<div class="banner">${S.result?.name ? `✅ Point pour <b>${esc(S.result.name)}</b>` : 'Personne ne marque'}</div>`;
    if (host) h += '<div class="actions"><button class="primary" id="nextBtn">Question suivante</button></div>';
  } else if (S.phase === 'end') {
    const top = [...S.players].sort((a, b) => b.score - a.score);
    h += `<div class="card"><h2>🏆 Classement</h2><table>${top.map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)}</td><td>${p.score} pt</td></tr>`).join('')}</table></div>`;
    if (host) h += '<div class="actions"><button class="primary" id="againBtn">Nouvelle partie</button></div>';
  }
  $('#game').innerHTML = h;

  if (S.phase === 'answering' && S.seq !== lastSeq) { lastSeq = S.seq; timerEnd = performance.now() + S.secs * 1000; }
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#readyBtn', () => send({ t: 'ready', v: !S.players.find((p) => p.name === myName)?.ready }));
  on('#buzz', () => send({ t: 'buzz' }));
  on('#ansBtn', () => { showAns = !showAns; render(); }); on('#skipBtn', skip); on('#okBtn', validate); on('#koBtn', refuse); on('#nextBtn', next); on('#againBtn', backToLobby);
}

setInterval(() => {
  const t = $('#timer');
  if (t) t.textContent = Math.max(0, Math.ceil((timerEnd - performance.now()) / 1000)) + ' s';
}, 150);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && role === 'player' && S?.phase === 'question' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); const b = $('#buzz'); if (b && !b.disabled) b.click(); }
});

/* ================= Init ================= */
$('#hostBtn').onclick = startHost;
$('#joinBtn').onclick = () => {
  const code = $('#joinCode').value.trim().toUpperCase(), name = $('#joinName').value.trim();
  if (!code || !name) return ($('#joinErr').textContent = 'Code et pseudo requis');
  joinRoom(code, name);
};
$('#files').onchange = async (e) => {
  $('#loadMsg').textContent = 'Chargement…';
  try { for (const f of e.target.files) await loadApkg(f); $('#loadMsg').textContent = ''; }
  catch (err) { $('#loadMsg').textContent = '⚠ ' + err.message; }
  updateDecks();
  e.target.value = '';
};
$('#startBtn').onclick = startGame;
$('#copyLink').onclick = () => { navigator.clipboard.writeText(location.origin + location.pathname + '?room=' + G.code); $('#copyLink').textContent = 'Lien copié ✓'; };
const q = new URLSearchParams(location.search);
if (q.get('room')) $('#joinCode').value = q.get('room').toUpperCase();
try { $('#joinName').value = localStorage.getItem('qa-name') || ''; } catch {}
show('home');
