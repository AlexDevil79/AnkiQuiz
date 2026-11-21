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
let timerEnd = 0, lastSeq = -1, showAns = false, pick = null;

// côté maître
let G = null;
const conns = new Map(); // pseudo -> connexion
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id));
  if (id !== 'game') document.body.dataset.state = '';
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
    makeQR('#qr', joinUrl(code));
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
  if (d.t === 'watch') { c.tv = true; conns.set('tv:' + c.peer, c); c.send({ t: 'state', s: publicState(false) }); return; }
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
    G.timer = setTimeout(refuse, (G.settings.secs + 1) * 1000); // +1s de grâce pour le maître
    broadcast();
  }
}

function onLeave(c) {
  if (c.tv) { conns.delete('tv:' + c.peer); return; }
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
  G.locked = new Set(); G.buzzer = null; G.lastBuzzer = null; showAns = false; pick = null; G.result = null; G.phase = 'question';
  broadcast();
}

function checkAllLocked() {
  if (connected().every((p) => G.locked.has(p.name))) { G.phase = 'reveal'; showAns = true; G.result = { none: true }; }
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
  showAns = true; G.result = w ? { name: w.name } : { none: true }; G.buzzer = null; G.phase = 'reveal';
  broadcast();
}

function skip() { G.phase = 'reveal'; showAns = true; G.result = { none: true }; G.buzzer = null; broadcast(); }

async function next() {
  if (G.phase !== 'reveal') return;
  await advance();
}

let advancing = false;
async function advance() {
  if (advancing) return;
  advancing = true;
  try { await advance2(); } finally { advancing = false; }
}

async function advance2() {
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
  const nr = ps.filter((p) => p.ready).length;
  $('#lobbyPlayers').innerHTML = ps.length
    ? `<div class="chips">${ps.map((p) => `<span class="pchip ${p.ready ? 'ready' : ''}" style="--c:${col(p.name)}">${av(p.name)}${esc(p.name)}<i>${p.ready ? '✓ prêt' : '…'}</i></span>`).join('')}</div><p class="muted">${nr} / ${ps.length} prêt${nr > 1 ? 's' : ''}</p>`
    : '<p class="muted">En attente de joueurs… partage le code ou le QR code.</p>';
  $('#startBtn').disabled = !ps.length || !library.length;
}

function updateDecks() {
  $('#deckList').innerHTML = library.map((d, i) => `<label class="deck"><input type="checkbox" class="deckSel" value="${i}" checked> ${esc(d.name)} <span class="muted">(${d.cards.length} cartes)</span></label>`).join('');
  updateSetup();
}

/* ================= JOUEUR ================= */
function joinRoom(code, name, tv = false) {
  role = tv ? 'tv' : 'player'; myName = name;
  $('#joinErr').textContent = 'Connexion…';
  peer = new Peer();
  peer.on('error', (e) => { $('#joinErr').textContent = e.type === 'peer-unavailable' ? 'Room introuvable' : 'Erreur réseau : ' + e.type; });
  peer.on('open', () => {
    const c = peer.connect('qanki-' + code, { reliable: true });
    c.on('open', () => c.send(tv ? { t: 'watch' } : { t: 'join', name }));
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
/* ================= Interface ================= */
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };
const baseUrl = () => location.origin + location.pathname;
const joinUrl = (c) => `${baseUrl()}?room=${c}`;
const tvUrl = (c) => `${baseUrl()}?tv=${c}`;
function makeQR(sel, text, size = 150) {
  const el = $(sel);
  if (!el || !window.QRCode) return;
  el.innerHTML = '';
  new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
}

const hue = (n) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const col = (n) => `hsl(${hue(n)} 72% 58%)`;
const av = (n) => `<span class="av" style="--c:${col(n)}">${esc([...n][0]?.toUpperCase() || '?')}</span>`;
const sorted = () => [...S.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const prevScores = {};
const ringSvg = '<svg class="ring" viewBox="0 0 100 100"><circle class="rbg" cx="50" cy="50" r="46"/><circle id="ringc" class="rfg" cx="50" cy="50" r="46"/></svg>';

/* ---- sons & vibrations ---- */
let ac, prevPhase = null, fxSeq = -1, lastKey = '';
const muted = () => ls('qa-mute') === '1';
function initAudio() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch {} }
function tone(f, t0, d, type = 'sine', v = 0.18) {
  const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0;
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
  o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d);
}
function sfx(k) {
  if (!ac || muted()) return;
  const m = {
    buzz: () => { tone(660, 0, 0.12, 'square', 0.12); tone(990, 0.1, 0.2, 'square', 0.12); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.25)),
    no: () => tone(160, 0, 0.35, 'sawtooth', 0.14),
    none: () => tone(300, 0, 0.25, 'triangle'),
    end: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3)),
  };
  m[k]?.();
}
function effects() {
  if (S.phase === 'answering' && S.seq !== fxSeq) { fxSeq = S.seq; sfx('buzz'); if (S.buzzer === myName) navigator.vibrate?.([120, 60, 120]); }
  else if (prevPhase === 'answering' && S.phase === 'question') sfx('no');
  else if (S.phase === 'reveal' && prevPhase !== 'reveal') sfx(S.result?.name ? 'win' : 'none');
  else if (S.phase === 'end' && prevPhase !== 'end') sfx('end');
  prevPhase = S.phase;
}

/* ---- briques d'affichage ---- */
function board(host) {
  return '<div class="board">' + sorted().map((p, i) => {
    const cls = ['pl', !p.connected && 'off', S.buzzer === p.name && 'buzz', S.locked.includes(p.name) && (S.phase === 'question' || S.phase === 'answering') && 'locked', p.name === myName && 'me', S.phase === 'lobby' && p.ready && 'ready', (prevScores[p.name] ?? p.score) < p.score && 'pop'].filter(Boolean).join(' ');
    const sc = S.phase === 'lobby' ? (p.ready ? '✓' : '…') : p.score;
    const plus = host && S.phase !== 'end' ? `<button class="plus" data-award="${esc(p.name)}" title="+1 point et question suivante">+1 ▶</button>` : '';
    return `<div class="${cls}" style="--c:${col(p.name)}"><span class="rk">${i + 1}</span>${av(p.name)}<span class="nm">${esc(p.name)}</span><span class="sc">${sc}</span>${plus}</div>`;
  }).join('') + '</div>';
}

function qcard() {
  const showA = role === 'host' ? showAns : S.phase === 'reveal';
  const pct = ((S.idx + (S.phase === 'reveal' ? 1 : 0)) / S.total) * 100;
  return `<div class="qcard"><div class="qmeta">Question ${S.idx + 1} / ${S.total}</div><div class="prog"><i style="width:${pct}%"></i></div><div class="question">${sanitize(S.front)}</div>${showA && S.answer ? `<div class="answer"><span class="lbl">Réponse</span>${sanitize(S.answer)}</div>` : ''}</div>`;
}

const resultBanner = () => `<div class="status reveal">${S.result?.name ? `✅ +1 pour <b>${esc(S.result.name)}</b>` : 'Personne ne marque'}</div>`;

function statusBox() {
  if (S.phase === 'question') return `<div class="status wait">${S.lastBuzzer ? `Dernier buzz : <b>${esc(S.lastBuzzer)}</b>` : 'En attente d\'un buzz…'}</div>`;
  if (S.phase === 'answering') return `<div class="status who" style="--c:${col(S.buzzer)}"><div class="ringbox" id="ringwrap">${ringSvg}<span id="timer" class="tnum"></span></div><div>${av(S.buzzer)}<b class="who-nm">${esc(S.buzzer)}</b><div class="muted">répond…</div></div></div>`;
  if (S.phase === 'reveal') return resultBanner();
  return '';
}

function podium() {
  const t = sorted();
  const order = [1, 0, 2].filter((i) => t[i]);
  const rest = t.slice(3);
  return `<div class="card podium-card"><h2 class="center">🏆 Classement final</h2><div class="podium">${order.map((i) => `<div class="pod p${i + 1}" style="--c:${col(t[i].name)}"><div class="medal">${['🥇', '🥈', '🥉'][i]}</div>${av(t[i].name)}<div class="nm">${esc(t[i].name)}</div><div class="bar"><b>${t[i].score}</b></div></div>`).join('')}</div>${rest.length ? '<div class="board">' + rest.map((p, i) => `<div class="pl" style="--c:${col(p.name)}"><span class="rk">${i + 4}</span>${av(p.name)}<span class="nm">${esc(p.name)}</span><span class="sc">${p.score}</span></div>`).join('') + '</div>' : ''}</div>`;
}

async function award(name) {
  if (G.phase === 'lobby' || G.phase === 'end') return;
  clearTimeout(G.timer);
  if (G.players[name]) G.players[name].score++;
  G.buzzer = null;
  await advance();
}

/* ---- vues ---- */
function hostView() {
  const ph = S.phase;
  const ans = `<button id="ansBtn" class="btn">${showAns ? '🙈 Masquer' : '👁 Afficher'} la réponse <kbd>A</kbd></button>`;
  let ctl = '';
  if (ph === 'question' || ph === 'answering') {
    ctl = (S.lastBuzzer ? `<button id="okBtn" class="btn ok big">✓ Valider · +1 ${esc(S.lastBuzzer)} <kbd>V</kbd></button>` : '<button id="skipBtn" class="btn big">Passer la question <kbd>P</kbd></button>') +
      (ph === 'answering' ? '<button id="koBtn" class="btn ko big">✗ Refuser <kbd>R</kbd></button>' : '') + ans;
  } else if (ph === 'reveal') ctl = '<button id="nextBtn" class="btn primary big">Question suivante ▶ <kbd>Espace</kbd></button>' + ans;
  else if (ph === 'end') ctl = '<button id="againBtn" class="btn primary big">Nouvelle partie</button>';
  const stage = ph === 'end' ? `${podium()}<div class="ctl">${ctl}</div>` : `${qcard()}${statusBox()}<div class="ctl">${ctl}</div>`;
  return `<div class="dash"><div class="stage">${stage}</div><aside class="side"><h3>Joueurs</h3>${board(true)}<p class="hint">« +1 ▶ » donne un point et passe à la question suivante.</p></aside></div>`;
}

function playerView() {
  const me = S.players.find((p) => p.name === myName) || { score: 0, ready: false };
  const rk = sorted().findIndex((p) => p.name === myName) + 1;
  const head = `<div class="mebar" style="--c:${col(myName)}">${av(myName)}<b>${esc(myName)}</b><span class="spacer"></span><span class="pill">#${rk}/${S.players.length}</span><span class="pill score">${me.score} pt</span></div>`;
  const ph = S.phase;
  if (ph === 'lobby') return `${head}<div class="card center"><h2>Salle d'attente</h2><p class="muted">Le maître lancera la partie.</p><button id="readyBtn" class="btn big ${me.ready ? 'ok' : 'primary'}">${me.ready ? '✅ Prêt (annuler)' : 'Je suis prêt !'}</button></div><div class="card">${board(false)}</div>`;
  if (ph === 'end') return `${head}${podium()}`;
  const locked = S.locked.includes(myName);
  const canBuzz = ph === 'question' && !locked;
  const mine = ph === 'answering' && S.buzzer === myName;
  const label = canBuzz ? 'BUZZ' : mine ? 'À TOI !' : ph === 'answering' ? '🔒' : 'Bloqué';
  let mid = '';
  if (ph === 'answering') mid = `<div class="status who" style="--c:${col(S.buzzer)}">${av(S.buzzer)}<b>${esc(S.buzzer)}</b> répond · <span id="timer" class="tnum"></span> s</div>`;
  else if (ph === 'reveal') mid = resultBanner();
  else mid = `<div class="status wait">${locked ? 'Tu es bloqué pour cette question' : 'Buzze si tu connais la réponse !'}</div>`;
  const buzzer = ph === 'reveal' ? '' : `<div class="buzzwrap${mine ? ' mine' : ''}" id="ringwrap">${ph === 'answering' ? ringSvg : ''}<button id="buzz" ${canBuzz ? '' : 'disabled'}>${label}</button></div>`;
  return `${head}${qcard()}${mid}${buzzer}<div class="card compact">${board(false)}</div>`;
}

function tvView() {
  if (S.phase === 'lobby') return `<div class="tv center"><h2>Rejoignez la partie sur</h2><p class="muted">${esc(baseUrl())}</p><div class="bigcode">${esc(S.code)}</div><div id="qrtv" class="qr"></div>${board(false)}</div>`;
  if (S.phase === 'end') return `<div class="tv">${podium()}</div>`;
  return `<div class="tv">${qcard()}${statusBox()}${board(false)}</div>`;
}

function stateName() {
  if (role !== 'player') return '';
  const ph = S.phase;
  if (ph === 'question') return S.locked.includes(myName) ? 'locked' : 'go';
  if (ph === 'answering') return S.buzzer === myName ? 'me' : 'busy';
  return ph;
}

function tick() {
  if (!S || S.phase !== 'answering') return;
  const rem = Math.max(0, (timerEnd - performance.now()) / 1000);
  const t = $('#timer'); if (t) t.textContent = Math.ceil(rem);
  const r = $('#ringc'); if (r) r.style.strokeDashoffset = 289.03 * (1 - Math.min(1, rem / S.secs));
  const w = $('#ringwrap'); if (w) w.classList.toggle('low', rem <= 3);
}
setInterval(tick, 100);

function render() {
  if (!S) return;
  if (role === 'host' && S.phase === 'lobby') return show('setup');
  show('game');
  const g = $('#game');
  g.dataset.role = role;
  document.body.dataset.state = stateName();
  const key = `${S.idx}-${S.phase}`;
  g.classList.toggle('fresh', key !== lastKey);
  lastKey = key;
  if (S.phase === 'answering' && S.seq !== lastSeq) { lastSeq = S.seq; timerEnd = performance.now() + S.secs * 1000; }
  g.innerHTML = role === 'host' ? hostView() : role === 'tv' ? tvView() : playerView();
  if (role === 'tv' && S.phase === 'lobby') makeQR('#qrtv', joinUrl(S.code), 200);

  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#readyBtn', () => send({ t: 'ready', v: !S.players.find((p) => p.name === myName)?.ready }));
  const bz = $('#buzz'); if (bz) bz.onpointerdown = buzzClick;
  on('#ansBtn', () => { showAns = !showAns; render(); });
  on('#skipBtn', skip); on('#okBtn', validate); on('#koBtn', refuse); on('#nextBtn', next); on('#againBtn', backToLobby);
  g.querySelectorAll('[data-award]').forEach((b) => (b.onclick = () => award(b.dataset.award)));
  tick(); effects();
  S.players.forEach((p) => (prevScores[p.name] = p.score));
}

function buzzClick() { initAudio(); navigator.vibrate?.(60); send({ t: 'buzz' }); }

document.addEventListener('pointerdown', initAudio);
document.addEventListener('keydown', (e) => {
  if (e.repeat || !S || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (role === 'player') {
    if (e.code === 'Space' && S.phase === 'question' && !S.locked.includes(myName)) { e.preventDefault(); buzzClick(); }
    return;
  }
  if (role !== 'host' || S.phase === 'lobby' || S.phase === 'end') return;
  if (k === 'a') { showAns = !showAns; render(); }
  else if (k === 'v' && S.lastBuzzer && S.phase !== 'reveal') validate();
  else if (k === 'r' && S.phase === 'answering') refuse();
  else if (k === 'p' && S.phase === 'question' && !S.lastBuzzer) skip();
  else if ((e.code === 'Space' || k === 'n' || k === 'enter') && S.phase === 'reveal') { e.preventDefault(); next(); }
});

/* ---- préférences (thème, taille du texte, son) ---- */
let prefTheme = ls('qa-theme') || 'dark', prefQs = +ls('qa-qs') || 1;
function applyPrefs() {
  document.documentElement.dataset.theme = prefTheme;
  document.documentElement.style.setProperty('--qs', prefQs);
  $('#muteBtn').textContent = muted() ? '🔇' : '🔊';
  $('#themeBtn').textContent = prefTheme === 'dark' ? '☀️' : '🌙';
}
$('#muteBtn').onclick = () => { ls('qa-mute', muted() ? '0' : '1'); initAudio(); applyPrefs(); };
$('#themeBtn').onclick = () => { prefTheme = prefTheme === 'dark' ? 'light' : 'dark'; ls('qa-theme', prefTheme); applyPrefs(); };
$('#fsDown').onclick = () => { prefQs = Math.max(0.7, +(prefQs - 0.15).toFixed(2)); ls('qa-qs', prefQs); applyPrefs(); };
$('#fsUp').onclick = () => { prefQs = Math.min(2.2, +(prefQs + 0.15).toFixed(2)); ls('qa-qs', prefQs); applyPrefs(); };
applyPrefs();

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
$('#copyLink').onclick = () => { navigator.clipboard.writeText(joinUrl(G.code)); $('#copyLink').textContent = 'Lien copié ✓'; };
$('#tvBtn').onclick = () => window.open(tvUrl(G.code), '_blank');
const q = new URLSearchParams(location.search);
if (q.get('room')) $('#joinCode').value = q.get('room').toUpperCase();
try { $('#joinName').value = localStorage.getItem('qa-name') || ''; } catch {}
if (q.get('tv')) joinRoom(q.get('tv').toUpperCase(), '', true);
if (q.get('tv')) $('#game').innerHTML = '<div class="card center">Connexion à la room…</div>';
show(q.get('tv') ? 'game' : 'home');
