'use strict';
/* AnkiQuiz — logique de jeu (maître = serveur P2P, joueurs = clients) */

const randId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const getToken = () => { let k = ls('qa-token'); if (!k) { k = randId(); ls('qa-token', k); } return k; };
const TC = ['#ff5b6e', '#4da3ff', '#2fd27c', '#ffc83d'];

/* ================= Pseudos ================= */
const BAD = ['connard', 'connasse', 'salope', 'putain', 'pute', 'encule', 'enculer', 'nique', 'niquer', 'merde', 'fdp', 'ntm', 'tg', 'nazi', 'hitler', 'pedo', 'pedophile', 'violeur', 'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'nigger', 'nigga', 'negro', 'faggot', 'whore', 'slut', 'rapist', 'retard'];
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const leet = (s) => deaccent(s).replace(/[01345@$!]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's', '!': 'i' }[c]));
const uniq = (s) => deaccent(s).replace(/[^a-z0-9]/g, '');
function checkName(raw) {
  const name = String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 20 || !/^[\p{L}\p{N}][\p{L}\p{N} ._'’-]*$/u.test(name)) return { err: 'nameInvalid' };
  const n = leet(name);
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  const flat = n.replace(/[^a-z0-9]/g, '');
  if (BAD.some((w) => tokens.includes(w) || (w.length >= 5 && flat.includes(w)))) return { err: 'nameBad' };
  return { name };
}

/* ================= Etat global ================= */
let role = null; // 'host' | 'player' | 'tv'
let peer = null, conn = null;
let myName = '';
let S = null; // état public (reçu ou calculé)
let timerEnd = 0, showAns = false;
let G = null; // état du maître
const conns = new Map(); // pseudo | 'tv:<id>' -> connexion
const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
const baseUrl = () => location.origin + location.pathname;
const joinUrl = (c) => `${baseUrl()}?room=${c}`;
const tvUrl = (c) => `${baseUrl()}?tv=${c}`;

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id));
  if (id !== 'game') document.body.dataset.state = '';
}

function makeQR(sel, text, size = 150) {
  const el = $(sel);
  if (!el || !window.QRCode) return;
  el.innerHTML = '';
  new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
}

/* ================= MAÎTRE ================= */
function newGame() {
  return { code: '', phase: 'lobby', players: {}, queue: [], idx: 0, locked: new Set(), buzzer: null, lastBuzzer: null, seq: 0, current: null, result: null, settings: { secs: 5, nb: 20, auto: false, teams: 0 }, timer: null, paused: false, deadline: 0, remainMs: 0, log: [], cur: null, qStart: 0, pauseT: 0 };
}

const connected = () => Object.values(G.players).filter((p) => p.connected);
const short = (html) => { const s = strip(html).replace(/\s+/g, ' ').trim(); return (s || '[image]').slice(0, 140); };

async function startHost(saved) {
  role = 'host';
  $('#hostMsg').textContent = '';
  await loadSavedDecks();
  G = newGame();
  openPeer(saved ? saved.code : genCode(), saved, 0);
}

function openPeer(code, saved, tries) {
  try { peer && peer.destroy(); } catch {}
  peer = new Peer('qanki-' + code);
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') {
      try { peer.destroy(); } catch {}
      if (!saved) return openPeer(genCode(), null, 0);
      if (tries < 20) { $('#hostMsg').textContent = t('resuming'); return setTimeout(() => openPeer(code, saved, tries + 1), 2500); }
      $('#hostMsg').textContent = t('resumeFail');
    } else if (e.type !== 'peer-unavailable') $('#hostMsg').textContent = t('netError') + ' ' + e.type;
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
  peer.on('open', async () => {
    G.code = code;
    $('#roomCode').textContent = code;
    $('#roomTag').textContent = t('room') + ' ' + code;
    makeQR('#qr', joinUrl(code));
    updateDecks();
    syncSettingsUI();
    if (saved) await restore(saved);
    else { updateSetup(); show('setup'); }
    saveSession();
  });
  peer.on('connection', (c) => {
    c.on('data', (d) => onHostMsg(c, d));
    c.on('close', () => onLeave(c));
  });
}

function publicState(forHost) {
  const remain = G.phase === 'answering' ? (G.paused ? G.remainMs : G.deadline - Date.now()) / 1000 - 1 : 0;
  return {
    code: G.code, phase: G.phase, idx: G.idx, total: G.queue.length, seq: G.seq, secs: G.settings.secs, teams: G.settings.teams,
    paused: G.paused, remain, buzzer: G.buzzer, lastBuzzer: G.lastBuzzer || null, locked: [...G.locked], result: G.result,
    front: G.current?.front || '',
    answer: forHost || G.phase === 'reveal' || G.phase === 'end' ? G.current?.answer || '' : '',
    stats: G.phase === 'end' ? computeStats() : null,
    players: Object.values(G.players).map(({ name, ready, score, connected, team }) => ({ name, ready, score, connected, team })),
  };
}

function broadcast() {
  const msg = { t: 'state', s: publicState(false) };
  for (const c of conns.values()) if (c.open) c.send(msg);
  S = publicState(true);
  S.rcv = performance.now();
  render();
  if (G.phase === 'lobby') updateSetup();
  saveSession();
}

function onHostMsg(c, d) {
  if (d.t === 'watch') { c.tv = true; conns.set('tv:' + c.peer, c); c.send({ t: 'state', s: publicState(false) }); return; }
  if (d.t === 'join') {
    const r = checkName(d.name);
    if (r.err) return c.send({ t: 'error', msg: r.err });
    const key = uniq(r.name), token = String(d.token || '');
    const ex = Object.values(G.players).find((p) => uniq(p.name) === key);
    if (ex) {
      if (!token || ex.token !== token) return c.send({ t: 'error', msg: 'nameTaken' });
      const old = conns.get(ex.name);
      if (old && old !== c) { old.pname = null; try { old.close(); } catch {} }
      ex.connected = true; c.pname = ex.name; conns.set(ex.name, c);
    } else {
      const p = { name: r.name, ready: false, score: 0, connected: true, team: -1, token };
      G.players[r.name] = p;
      assignTeam(p);
      c.pname = r.name; conns.set(r.name, c);
    }
    broadcast();
    checkAuto();
    return;
  }
  const name = c.pname;
  const p = G.players[name];
  if (!p) return;
  if (d.t === 'ready' && G.phase === 'lobby') { p.ready = !!d.v; broadcast(); checkAuto(); }
  if (d.t === 'buzz' && G.phase === 'question' && !G.paused && !G.locked.has(name)) {
    G.phase = 'answering'; G.buzzer = name; G.lastBuzzer = name; G.seq++;
    G.cur?.buzzes.push({ name, ms: Date.now() - G.qStart, ok: false });
    clearTimeout(G.timer);
    const ms = (G.settings.secs + 1) * 1000; // +1s de grâce pour le maître
    G.deadline = Date.now() + ms;
    G.timer = setTimeout(refuse, ms);
    broadcast();
  }
}

function onLeave(c) {
  if (c.tv) { conns.delete('tv:' + c.peer); return; }
  const name = c.pname;
  if (!name || conns.get(name) !== c) return;
  conns.delete(name);
  if (G.phase === 'lobby') delete G.players[name];
  else if (G.players[name]) G.players[name].connected = false;
  if (G.phase === 'answering' && G.buzzer === name) return refuse();
  if (G.phase === 'question') checkAllLocked();
  broadcast();
}

function kick(name) {
  const c = conns.get(name);
  if (c) { c.pname = null; try { c.send({ t: 'kicked' }); setTimeout(() => c.close(), 200); } catch {} }
  conns.delete(name);
  delete G.players[name];
  G.locked.delete(name);
  if (G.buzzer === name) { clearTimeout(G.timer); G.buzzer = null; G.paused = false; if (G.phase === 'answering') G.phase = 'question'; }
  if (G.lastBuzzer === name) G.lastBuzzer = null;
  broadcast();
}

function checkAuto() {
  const c = connected();
  if (G.phase === 'lobby' && G.settings.auto && c.length && c.every((p) => p.ready)) startGame();
}

/* ---- équipes ---- */
function assignTeam(p) {
  const n = G.settings.teams;
  if (!n) { p.team = 0; return; }
  const cnt = Array(n).fill(0);
  Object.values(G.players).forEach((q) => { if (q !== p && q.team >= 0 && q.team < n) cnt[q.team]++; });
  p.team = cnt.indexOf(Math.min(...cnt));
}
function setTeams(n) {
  G.settings.teams = n;
  const ps = Object.values(G.players);
  ps.forEach((p) => (p.team = -1));
  ps.forEach(assignTeam);
  broadcast();
}
function cycleTeam(name) {
  const p = G.players[name], n = G.settings.teams;
  if (p && n) { p.team = (p.team + 1) % n; broadcast(); }
}
function lockWithTeam(name) {
  G.locked.add(name);
  const tm = G.players[name]?.team;
  if (G.settings.teams) Object.values(G.players).forEach((p) => { if (p.team === tm) G.locked.add(p.name); });
}

/* ---- déroulé ---- */
const selectedKeys = () => [...document.querySelectorAll('.deckSel:checked')].map((i) => library[+i.value]?.key);

function readSettings() {
  G.settings.secs = Math.max(2, +$('#secs').value || 5);
  G.settings.nb = Math.max(1, +$('#nbQ').value || 20);
  G.settings.auto = $('#auto').checked;
}

async function startGame() {
  const sel = [...document.querySelectorAll('.deckSel:checked')].flatMap((i) => library[+i.value].cards);
  if (!sel.length) return alert(t('noDeck'));
  readSettings();
  for (let i = sel.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sel[i], sel[j]] = [sel[j], sel[i]]; }
  G.queue = sel.slice(0, G.settings.nb);
  G.idx = 0; G.log = [];
  Object.values(G.players).forEach((p) => (p.score = 0));
  await loadQuestion();
}

async function loadQuestion() {
  const card = G.queue[G.idx];
  G.current = { front: await inlineMedia(card.front, card.src), answer: await inlineMedia(card.answer, card.src) };
  G.locked = new Set(); G.buzzer = null; G.lastBuzzer = null; showAns = false; G.result = null; G.paused = false; G.phase = 'question';
  G.qStart = Date.now();
  G.cur = { n: G.idx + 1, q: short(card.front), a: short(card.answer), winner: null, buzzes: [] };
  G.log.push(G.cur);
  broadcast();
}

function toReveal(result) { clearTimeout(G.timer); G.paused = false; G.buzzer = null; G.result = result; G.phase = 'reveal'; showAns = true; }
function checkAllLocked() { if (connected().every((p) => G.locked.has(p.name))) toReveal({ none: true }); }

function refuse() {
  if (G.phase !== 'answering') return;
  clearTimeout(G.timer); G.paused = false;
  lockWithTeam(G.buzzer); G.buzzer = null; G.phase = 'question';
  checkAllLocked();
  broadcast();
}

function markWin(name) {
  if (!G.cur) return;
  G.cur.winner = name;
  const b = [...G.cur.buzzes].reverse().find((x) => x.name === name);
  if (b) b.ok = true;
}

function validate() {
  if (G.phase !== 'answering' && G.phase !== 'question') return;
  const w = G.players[G.lastBuzzer];
  if (w) { w.score++; markWin(w.name); }
  toReveal(w ? { name: w.name } : { none: true });
  broadcast();
}

function skip() { if (G.phase === 'question') { toReveal({ none: true }); broadcast(); } }

function togglePause() {
  if (G.phase !== 'question' && G.phase !== 'answering') return;
  if (!G.paused) {
    G.paused = true; G.pauseT = Date.now();
    if (G.phase === 'answering') { clearTimeout(G.timer); G.remainMs = Math.max(0, G.deadline - Date.now()); }
  } else {
    G.paused = false; G.qStart += Date.now() - G.pauseT;
    if (G.phase === 'answering') { G.deadline = Date.now() + G.remainMs; G.timer = setTimeout(refuse, G.remainMs); }
  }
  broadcast();
}

function adjust(name, d) {
  const p = G.players[name];
  if (!p) return;
  p.score = Math.max(0, p.score + d);
  broadcast();
}

async function award(name) {
  if (G.phase === 'lobby' || G.phase === 'end') return;
  clearTimeout(G.timer);
  if (G.players[name]) { G.players[name].score++; markWin(name); }
  G.buzzer = null; G.paused = false;
  await advance();
}

async function next() { if (G.phase === 'reveal') await advance(); }

let advancing = false;
async function advance() {
  if (advancing) return;
  advancing = true;
  try {
    G.idx++;
    if (G.idx >= G.queue.length) { G.phase = 'end'; G.current = null; G.paused = false; broadcast(); }
    else await loadQuestion();
  } finally { advancing = false; }
}

function backToLobby() {
  clearTimeout(G.timer);
  G.phase = 'lobby'; G.current = null; G.queue = []; G.buzzer = null; G.lastBuzzer = null; G.locked = new Set(); G.result = null; G.paused = false; G.log = []; G.cur = null;
  Object.values(G.players).forEach((p) => { p.ready = false; p.score = 0; });
  broadcast();
  show('setup');
}

/* ---- statistiques ---- */
function computeStats() {
  const per = {};
  Object.values(G.players).forEach((p) => (per[p.name] = { name: p.name, ok: 0, ko: 0, t: [] }));
  for (const q of G.log) {
    for (const b of q.buzzes) { const s = per[b.name]; if (!s) continue; if (!b.ok) s.ko++; s.t.push(b.ms); }
    if (q.winner && per[q.winner]) per[q.winner].ok++;
  }
  const players = Object.values(per).map((s) => ({ name: s.name, ok: s.ok, ko: s.ko, avg: s.t.length ? Math.round(s.t.reduce((a, b) => a + b, 0) / s.t.length) : null, best: s.t.length ? Math.min(...s.t) : null }));
  const fastest = players.filter((p) => p.best != null).sort((a, b) => a.best - b.best)[0] || null;
  const missed = G.log.map((q) => ({ n: q.n, q: q.q, a: q.a, miss: q.buzzes.filter((b) => !b.ok).length, none: !q.winner })).filter((x) => x.none || x.miss).sort((a, b) => b.none - a.none || b.miss - a.miss).slice(0, 5);
  return { players, fastest: fastest && { name: fastest.name, ms: fastest.best }, missed, history: G.log.map((q) => ({ n: q.n, q: q.q, a: q.a, winner: q.winner })) };
}

function exportCsv() {
  const st = S?.stats;
  if (!st) return;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const sec = (ms) => (ms == null ? '' : (ms / 1000).toFixed(2));
  const rows = [[t('stPlayer'), t('stOk'), t('stKo'), t('stAvg'), t('stBest')], ...st.players.map((p) => [p.name, p.ok, p.ko, sec(p.avg), sec(p.best)]), [], ['#', t('stQuestion'), t('answer'), t('stWinner')], ...st.history.map((h) => [h.n, h.q, h.a, h.winner || ''])];
  const blob = new Blob(['﻿' + rows.map((r) => r.map(q).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'ankiquiz-results.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---- reprise après coupure ---- */
function saveSession() {
  if (role !== 'host' || !G || !G.code) return;
  try {
    ls('qa-host', JSON.stringify({
      code: G.code, phase: G.phase, idx: G.idx, queue: G.queue.map((c) => c.key),
      players: Object.values(G.players).map(({ name, ready, score, team, token }) => ({ name, ready, score, team, token })),
      locked: [...G.locked], lastBuzzer: G.lastBuzzer, result: G.result, settings: G.settings, sel: selectedKeys(), log: G.log, ts: Date.now(),
    }));
  } catch {}
}
const savedHost = () => { try { const s = JSON.parse(ls('qa-host')); return s && Date.now() - s.ts < 12 * 3600e3 ? s : null; } catch { return null; } };

async function restore(sv) {
  G.settings = Object.assign(G.settings, sv.settings);
  syncSettingsUI();
  updateDecks(sv.sel);
  sv.players.forEach((p) => (G.players[p.name] = { ...p, connected: false }));
  const map = new Map();
  library.forEach((l) => l.cards.forEach((c) => map.set(c.key, c)));
  G.queue = sv.queue.map((k) => map.get(k)).filter(Boolean);
  G.idx = sv.idx; G.log = sv.log || [];
  const ok = sv.phase !== 'lobby' && G.queue.length && G.queue.length === sv.queue.length;
  if (ok && sv.phase === 'end') G.phase = 'end';
  else if (ok) {
    const card = G.queue[G.idx];
    G.current = { front: await inlineMedia(card.front, card.src), answer: await inlineMedia(card.answer, card.src) };
    G.locked = new Set(sv.locked); G.lastBuzzer = sv.lastBuzzer; G.result = sv.result;
    G.cur = G.log.find((x) => x.n === G.idx + 1) || null;
    G.qStart = Date.now();
    G.phase = sv.phase === 'reveal' ? 'reveal' : 'question';
    G.paused = G.phase === 'question'; // le maître relance quand les joueurs sont revenus
    showAns = G.phase === 'reveal';
  } else G.phase = 'lobby';
  broadcast();
}

/* ---- écran de préparation ---- */
function syncSettingsUI() {
  $('#secs').value = G.settings.secs; $('#nbQ').value = G.settings.nb; $('#auto').checked = !!G.settings.auto;
}

function updateSetup() {
  const ps = Object.values(G.players);
  const nr = ps.filter((p) => p.ready).length;
  const n = G.settings.teams;
  document.querySelectorAll('#teamSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.n === n));
  $('#lobbyPlayers').innerHTML = ps.length
    ? `<div class="chips">${ps.map((p) => {
      const c = n ? TC[p.team] : col(p.name);
      return `<span class="pchip ${p.ready ? 'ready' : ''}" style="--c:${c}"><span class="av" style="--c:${c}">${esc([...p.name][0].toUpperCase())}</span>${esc(p.name)}<i>${p.ready ? t('readyTag') : '…'}</i>${n ? `<button class="tdot" data-team="${esc(p.name)}" title="${t('changeTeam')}">${esc(t('team' + p.team))}</button>` : ''}<button class="kick" data-kick="${esc(p.name)}" title="${t('kick')}">✕</button></span>`;
    }).join('')}</div><p class="muted">${t('readyCount', { n: nr, m: ps.length })}</p>`
    : `<p class="muted">${t('waitPlayers')}</p>`;
  document.querySelectorAll('[data-team]').forEach((b) => (b.onclick = () => cycleTeam(b.dataset.team)));
  document.querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => confirm(t('kickConfirm', { n: b.dataset.kick })) && kick(b.dataset.kick)));
  $('#startBtn').disabled = !ps.length || !library.length;
}

let knownDecks = new Set();
function updateDecks(sel) {
  const prev = sel || selectedKeys();
  $('#deckList').innerHTML = library.length
    ? library.map((d, i) => `<div class="deck"><label><input type="checkbox" class="deckSel" value="${i}" ${!knownDecks.has(d.key) || prev.includes(d.key) ? 'checked' : ''}> ${esc(d.name)} <span class="muted">(${t('nCards', { n: d.cards.length })})</span></label><button class="kick" data-delfile="${esc(d.file)}" title="${t('delDeckTip')}">🗑</button></div>`).join('')
    : `<p class="muted">${t('noDecks')}</p>`;
  knownDecks = new Set(library.map((d) => d.key));
  document.querySelectorAll('[data-delfile]').forEach((b) => (b.onclick = async () => {
    if (!confirm(t('delDeck', { f: b.dataset.delfile }))) return;
    await DB.del(b.dataset.delfile);
    removeFile(b.dataset.delfile);
    updateDecks();
    if (G) updateSetup();
  }));
  if (G) updateSetup();
}

async function loadSavedDecks() {
  if (library.length) return;
  for (const { name, blob } of await DB.all()) { try { await loadApkg(blob, name); } catch {} }
}

/* ================= JOUEUR / TV ================= */
let reconnecting = false, retryT = null, lastRoom = null, left = false, fatal = false;

function banner(txt) { const b = $('#banner'); b.hidden = !txt; $('#bannerTxt').textContent = txt || ''; }

function joinRoom(code, name, tv = false, silent = false) {
  role = tv ? 'tv' : 'player'; myName = name; lastRoom = { code, name, tv };
  left = false; fatal = false;
  if (!silent) $('#joinErr').textContent = t('connecting');
  clearTimeout(retryT);
  try { peer && peer.destroy(); } catch {}
  const retry = () => { if (left || fatal) return; banner(t('reconnecting')); clearTimeout(retryT); retryT = setTimeout(() => joinRoom(code, name, tv, true), 2500); };
  const err = (key) => { if (reconnecting || tv || silent) retry(); else $('#joinErr').textContent = t(key); };
  peer = new Peer();
  peer.on('error', (e) => err(e.type === 'peer-unavailable' ? 'roomNotFound' : 'netError'));
  peer.on('open', () => {
    const c = peer.connect('qanki-' + code, { reliable: true });
    conn = c;
    c.on('open', () => c.send(tv ? { t: 'watch' } : { t: 'join', name, token: getToken() }));
    c.on('data', (d) => {
      if (d.t === 'error') { fatal = true; reconnecting = false; ls('qa-player', ''); S = null; show('home'); banner(''); $('#joinErr').textContent = t(d.msg); c.close(); return; }
      if (d.t === 'kicked') { leave(t('kicked')); return; }
      if (d.t === 'state') {
        S = d.s; S.rcv = performance.now();
        if (!reconnecting && !tv) { reconnecting = true; ls('qa-player', JSON.stringify({ code, name, ts: Date.now() })); }
        $('#roomTag').textContent = t('room') + ' ' + code;
        banner('');
        render();
      }
    });
    c.on('close', () => { if (!left && !fatal) retry(); });
  });
}

function leave(msg) {
  left = true; reconnecting = false; clearTimeout(retryT);
  ls('qa-player', '');
  try { peer && peer.destroy(); } catch {}
  S = null; role = null; banner('');
  $('#roomTag').textContent = '';
  $('#joinErr').textContent = msg || '';
  show('home');
}

const send = (m) => conn && conn.open && conn.send(m);

/* ================= Rendu ================= */
const hue = (n) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const col = (n) => `hsl(${hue(n)} 72% 58%)`;
const colOf = (n) => { const p = S?.teams && S.players.find((x) => x.name === n); return p ? TC[p.team] || col(n) : col(n); };
const av = (n) => `<span class="av" style="--c:${colOf(n)}">${esc([...n][0]?.toUpperCase() || '?')}</span>`;
const sorted = () => [...S.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const teamTotals = () => { const tot = Array(S.teams).fill(0); S.players.forEach((p) => { if (tot[p.team] !== undefined) tot[p.team] += p.score; }); return tot; };
const prevScores = {};
const ringSvg = '<svg class="ring" viewBox="0 0 100 100"><circle class="rbg" cx="50" cy="50" r="46"/><circle id="ringc" class="rfg" cx="50" cy="50" r="46"/></svg>';
const secF = (ms) => (ms / 1000).toFixed(1) + ' s';

/* ---- sons & vibrations ---- */
let ac, prevPhase = null, fxSeq = -1, lastKey = '';
const muted = () => ls('qa-mute') === '1';
function initAudio() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch {} }
function tone(f, t0, d, type = 'sine', v = 0.18) {
  const o = ac.createOscillator(), g = ac.createGain(), tt = ac.currentTime + t0;
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(v, tt); g.gain.exponentialRampToValueAtTime(0.001, tt + d);
  o.connect(g); g.connect(ac.destination); o.start(tt); o.stop(tt + d);
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

/* ---- briques ---- */
function playerRow(p, i, host) {
  const cls = ['pl', !p.connected && 'off', S.buzzer === p.name && 'buzz', S.locked.includes(p.name) && (S.phase === 'question' || S.phase === 'answering') && 'locked', p.name === myName && 'me', S.phase === 'lobby' && p.ready && 'ready', (prevScores[p.name] ?? p.score) < p.score && 'pop'].filter(Boolean).join(' ');
  const sc = S.phase === 'lobby' ? (p.ready ? '✓' : '…') : p.score;
  const minus = host ? `<button class="minus" data-minus="${esc(p.name)}" title="${t('minusTip')}">−1</button>` : '';
  const plus = host && S.phase !== 'end' ? `<button class="plus" data-award="${esc(p.name)}" title="${t('plusTip')}">+1 ▶</button>` : '';
  return `<div class="${cls}" style="--c:${colOf(p.name)}">${S.teams ? '' : `<span class="rk">${i + 1}</span>`}${av(p.name)}<span class="nm">${esc(p.name)}</span><span class="sc">${sc}</span>${minus}${plus}</div>`;
}

function board(host) {
  if (S.teams) {
    const tot = teamTotals();
    const order = [...tot.keys()].sort((a, b) => tot[b] - tot[a]);
    return '<div class="board">' + order.map((ti) => {
      const mem = S.players.filter((p) => p.team === ti).sort((a, b) => b.score - a.score);
      return `<div class="team" style="--c:${TC[ti]}"><div class="thead"><span>${esc(t('team' + ti))}</span><b>${tot[ti]}</b></div>${mem.map((p, i) => playerRow(p, i, host)).join('') || '<div class="muted tiny">—</div>'}</div>`;
    }).join('') + '</div>';
  }
  return '<div class="board">' + sorted().map((p, i) => playerRow(p, i, host)).join('') + '</div>';
}

function qcard() {
  const showA = role === 'host' ? showAns : S.phase === 'reveal';
  const pct = ((S.idx + (S.phase === 'reveal' ? 1 : 0)) / S.total) * 100;
  return `<div class="qcard"><div class="qmeta">${t('questionN', { i: S.idx + 1, n: S.total })}</div><div class="prog"><i style="width:${pct}%"></i></div><div class="question">${sanitize(S.front)}</div>${showA && S.answer ? `<div class="answer"><span class="lbl">${t('answer')}</span>${sanitize(S.answer)}</div>` : ''}</div>`;
}

const resultBanner = () => `<div class="status reveal">${S.result?.name ? t('pointFor', { n: `<b>${esc(S.result.name)}</b>` }) : t('nobody')}</div>`;
const pausedBox = () => `<div class="status pausedbox">⏸ ${t('paused')}</div>`;

function statusBox() {
  if (S.phase === 'question') return S.paused ? pausedBox() : `<div class="status wait">${S.lastBuzzer ? t('lastBuzz', { n: `<b>${esc(S.lastBuzzer)}</b>` }) : t('waitBuzz')}</div>`;
  if (S.phase === 'answering') return (S.paused ? pausedBox() : '') + `<div class="status who" style="--c:${colOf(S.buzzer)}"><div class="ringbox" id="ringwrap">${ringSvg}<span id="timer" class="tnum"></span></div><div>${av(S.buzzer)}<b class="who-nm">${esc(S.buzzer)}</b><div class="muted">${t('answering')}</div></div></div>`;
  if (S.phase === 'reveal') return resultBanner();
  return '';
}

function podiumEntries() {
  if (S.teams) {
    const tot = teamTotals();
    return [...tot.keys()].filter((i) => S.players.some((p) => p.team === i)).map((i) => ({ name: t('team' + i), score: tot[i], color: TC[i], ini: t('team' + i)[0] })).sort((a, b) => b.score - a.score);
  }
  return sorted().map((p) => ({ name: p.name, score: p.score, color: colOf(p.name), ini: [...p.name][0].toUpperCase() }));
}

function podium() {
  const e = podiumEntries();
  const order = [1, 0, 2].filter((i) => e[i]);
  const rest = S.teams ? [] : e.slice(3);
  return `<div class="card podium-card"><h2 class="center">${t('finalRanking')}</h2><div class="podium">${order.map((i) => `<div class="pod p${i + 1}" style="--c:${e[i].color}"><div class="medal">${['🥇', '🥈', '🥉'][i]}</div><span class="av" style="--c:${e[i].color}">${esc(e[i].ini)}</span><div class="nm">${esc(e[i].name)}</div><div class="bar"><b>${e[i].score}</b></div></div>`).join('')}</div>${rest.length ? '<div class="board">' + rest.map((p, i) => `<div class="pl" style="--c:${p.color}"><span class="rk">${i + 4}</span><span class="av" style="--c:${p.color}">${esc(p.ini)}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score}</span></div>`).join('') + '</div>' : ''}${S.teams ? board(false) : ''}</div>`;
}

function statsCard() {
  const st = S.stats;
  if (!st) return '';
  const rows = [...st.players].sort((a, b) => b.ok - a.ok || a.ko - b.ko).map((p) => `<tr><td>${av(p.name)} ${esc(p.name)}</td><td>${p.ok}</td><td>${p.ko}</td><td>${p.avg != null ? secF(p.avg) : '–'}</td><td>${p.best != null ? secF(p.best) : '–'}</td></tr>`).join('');
  return `<div class="card"><h2>📊 ${t('stats')}</h2>
  ${st.fastest ? `<p class="award">⚡ ${t('fastest', { n: `<b>${esc(st.fastest.name)}</b>`, s: secF(st.fastest.ms) })}</p>` : ''}
  <div class="tscroll"><table class="stats"><tr><th>${t('stPlayer')}</th><th title="${t('stOk')}">✓</th><th title="${t('stKo')}">✗</th><th title="${t('stAvg')}">⏱</th><th title="${t('stBest')}">⚡</th></tr>${rows}</table></div>
  ${st.missed.length ? `<h3 style="margin-top:14px">${t('missed')}</h3><ul class="missed">${st.missed.map((m) => `<li><b>${m.n}.</b> ${esc(m.q)} <span class="muted">→ ${esc(m.a)}</span></li>`).join('')}</ul>` : ''}
  <details><summary>${t('history')}</summary><ul class="missed">${st.history.map((h) => `<li><b>${h.n}.</b> ${esc(h.q)} <span class="muted">→ ${esc(h.a)}</span> ${h.winner ? `<span class="pill">${esc(h.winner)}</span>` : '<span class="muted">–</span>'}</li>`).join('')}</ul></details>
  ${role === 'host' ? `<div class="actions"><button id="csvBtn" class="btn small">⬇ ${t('exportCsv')}</button></div>` : ''}</div>`;
}

/* ---- vues ---- */
function hostView() {
  const ph = S.phase;
  const ans = `<button id="ansBtn" class="btn">${showAns ? '🙈 ' + t('hideAnswer') : '👁 ' + t('showAnswer')} <kbd>A</kbd></button>`;
  let ctl = '';
  if (ph === 'question' || ph === 'answering') {
    ctl = (S.lastBuzzer ? `<button id="okBtn" class="btn ok big">${t('validate', { n: esc(S.lastBuzzer) })} <kbd>V</kbd></button>` : `<button id="skipBtn" class="btn big">${t('skip')} <kbd>P</kbd></button>`) +
      (ph === 'answering' ? `<button id="koBtn" class="btn ko big">${t('refuse')} <kbd>R</kbd></button>` : '') +
      `<button id="pauseBtn" class="btn">${S.paused ? '▶ ' + t('resume') : '⏸ ' + t('pause')} <kbd>␣</kbd></button>` + ans;
  } else if (ph === 'reveal') ctl = `<button id="nextBtn" class="btn primary big">${t('next')} <kbd>␣</kbd></button>` + ans;
  else if (ph === 'end') ctl = `<button id="againBtn" class="btn primary big">${t('newGame')}</button>`;
  const stage = ph === 'end' ? `${podium()}${statsCard()}<div class="ctl">${ctl}</div>` : `${qcard()}${statusBox()}<div class="ctl">${ctl}</div>`;
  return `<div class="dash"><div class="stage">${stage}</div><aside class="side"><h3>${t('players')}</h3>${board(true)}<p class="hint">${t('boardHint')}</p><button id="resetBtn" class="btn small ko reset">↺ ${t('resetRoom')}</button></aside></div>`;
}

function playerView() {
  const me = S.players.find((p) => p.name === myName) || { score: 0, ready: false, team: 0 };
  const rk = sorted().findIndex((p) => p.name === myName) + 1;
  const head = `<div class="mebar" style="--c:${colOf(myName)}">${av(myName)}<b>${esc(myName)}</b>${S.teams ? `<span class="pill" style="background:${TC[me.team]};border-color:transparent;color:#fff">${esc(t('team' + me.team))}</span>` : ''}<span class="spacer"></span><span class="pill">#${rk}/${S.players.length}</span><span class="pill score">${me.score} pt</span><button id="leaveBtn2" class="tool" title="${t('leave')}">⎋</button></div>`;
  const ph = S.phase;
  if (ph === 'lobby') return `${head}<div class="card center"><h2>${t('waitingRoom')}</h2><p class="muted">${t('masterStarts')}</p><button id="readyBtn" class="btn big ${me.ready ? 'ok' : 'primary'}">${me.ready ? t('readyCancel') : t('imReady')}</button></div><div class="card">${board(false)}</div>`;
  if (ph === 'end') return `${head}${podium()}${statsCard()}`;
  const locked = S.locked.includes(myName);
  const canBuzz = ph === 'question' && !locked && !S.paused;
  const mine = ph === 'answering' && S.buzzer === myName;
  const label = canBuzz ? t('buzz') : mine ? t('yourTurn') : S.paused ? '⏸' : ph === 'answering' ? '🔒' : t('blocked');
  let mid;
  if (S.paused) mid = pausedBox();
  else if (ph === 'answering') mid = `<div class="status who" style="--c:${colOf(S.buzzer)}">${av(S.buzzer)}<b>${esc(S.buzzer)}</b> ${t('answering')} · <span id="timer" class="tnum"></span> s</div>`;
  else if (ph === 'reveal') mid = resultBanner();
  else mid = `<div class="status wait">${locked ? t('youBlocked') : t('buzzIf')}</div>`;
  const buzzer = ph === 'reveal' ? '' : `<div class="buzzwrap${mine ? ' mine' : ''}" id="ringwrap">${ph === 'answering' ? ringSvg : ''}<button id="buzz" ${canBuzz ? '' : 'disabled'}>${label}</button></div>`;
  return `${head}${qcard()}${mid}${buzzer}<div class="card compact">${board(false)}</div>`;
}

function tvView() {
  if (S.phase === 'lobby') return `<div class="tv center"><h2>${t('tvJoin')}</h2><p class="muted">${esc(baseUrl())}</p><div class="bigcode">${esc(S.code)}</div><div id="qrtv" class="qr"></div>${board(false)}</div>`;
  if (S.phase === 'end') return `<div class="tv">${podium()}${statsCard()}</div>`;
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
  const rem = Math.max(0, S.paused ? S.remain : (timerEnd - performance.now()) / 1000);
  const tt = $('#timer'); if (tt) tt.textContent = Math.ceil(rem);
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
  if (S.phase === 'answering') timerEnd = (S.rcv || performance.now()) + S.remain * 1000;
  g.innerHTML = role === 'host' ? hostView() : role === 'tv' ? tvView() : playerView();
  if (role === 'tv' && S.phase === 'lobby') makeQR('#qrtv', joinUrl(S.code), 200);

  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#readyBtn', () => send({ t: 'ready', v: !S.players.find((p) => p.name === myName)?.ready }));
  const bz = $('#buzz'); if (bz) bz.onpointerdown = buzzClick;
  on('#ansBtn', () => { showAns = !showAns; render(); });
  on('#skipBtn', skip); on('#okBtn', validate); on('#koBtn', refuse); on('#nextBtn', next); on('#againBtn', backToLobby); on('#pauseBtn', togglePause);
  on('#csvBtn', exportCsv);
  on('#leaveBtn2', () => confirm(t('leaveConfirm')) && leave());
  on('#resetBtn', () => { if (confirm(t('resetConfirm'))) backToLobby(); });
  g.querySelectorAll('[data-minus]').forEach((b) => (b.onclick = () => adjust(b.dataset.minus, -1)));
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
    if (e.code === 'Space' && S.phase === 'question' && !S.paused && !S.locked.includes(myName)) { e.preventDefault(); buzzClick(); }
    return;
  }
  if (role !== 'host' || S.phase === 'lobby' || S.phase === 'end') return;
  if (k === 'a') { showAns = !showAns; render(); }
  else if (k === 'v' && S.lastBuzzer && S.phase !== 'reveal') validate();
  else if (k === 'r' && S.phase === 'answering') refuse();
  else if (k === 'p' && S.phase === 'question' && !S.lastBuzzer) skip();
  else if (e.code === 'Space' || k === 'n' || k === 'enter') {
    e.preventDefault();
    if (S.phase === 'reveal') next(); else togglePause();
  }
});

window.addEventListener('beforeunload', (e) => { if (role === 'host' && G && G.phase !== 'lobby') { e.preventDefault(); e.returnValue = ''; } });

/* ---- préférences ---- */
let prefTheme = ls('qa-theme') || 'dark';
function applyPrefs() {
  document.documentElement.dataset.theme = prefTheme;
  $('#muteBtn').textContent = muted() ? '🔇' : '🔊';
  $('#themeBtn').textContent = prefTheme === 'dark' ? '☀️' : '🌙';
  $('#langBtn').textContent = LANG === 'fr' ? 'EN' : 'FR';
}
function refreshLang() {
  applyI18n(); applyPrefs(); refreshHome();
  if (G) { updateDecks(); updateSetup(); if (G.code) $('#roomTag').textContent = t('room') + ' ' + G.code; }
  if (S) render();
}
$('#muteBtn').onclick = () => { ls('qa-mute', muted() ? '0' : '1'); initAudio(); applyPrefs(); };
$('#themeBtn').onclick = () => { prefTheme = prefTheme === 'dark' ? 'light' : 'dark'; ls('qa-theme', prefTheme); applyPrefs(); };
$('#langBtn').onclick = () => { setLang(LANG === 'fr' ? 'en' : 'fr'); refreshLang(); };

/* ================= Init ================= */
function refreshHome() {
  const sv = savedHost();
  $('#resumeBox').hidden = !sv;
  if (sv) $('#resumeTxt').textContent = t('resumeGame', { c: sv.code });
}

$('#hostBtn').onclick = () => startHost();
$('#resumeBtn').onclick = () => { const sv = savedHost(); if (sv) startHost(sv); };
$('#resumeDel').onclick = () => { ls('qa-host', ''); refreshHome(); };
$('#joinBtn').onclick = () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  const r = checkName($('#joinName').value);
  if (!code) return ($('#joinErr').textContent = t('codeRequired'));
  if (r.err) return ($('#joinErr').textContent = t(r.err));
  ls('qa-name', r.name);
  reconnecting = false;
  joinRoom(code, r.name);
};
$('#files').onchange = async (e) => {
  $('#loadMsg').textContent = t('loading');
  let msg = '';
  for (const f of e.target.files) {
    try { await loadApkg(f); await DB.put(f.name, f); }
    catch (err) { msg += `⚠ ${f.name} : ${err.message}\n`; }
  }
  $('#loadMsg').textContent = msg;
  updateDecks();
  e.target.value = '';
};
$('#startBtn').onclick = startGame;
$('#copyLink').onclick = () => { navigator.clipboard.writeText(joinUrl(G.code)); $('#copyLink').textContent = t('copied'); };
$('#tvBtn').onclick = () => window.open(tvUrl(G.code), '_blank');
document.querySelectorAll('#teamSeg button').forEach((b) => (b.onclick = () => G && setTeams(+b.dataset.n)));
$('#leaveBtn').onclick = () => leave();

const q = new URLSearchParams(location.search);
if (q.get('room')) $('#joinCode').value = q.get('room').toUpperCase();
$('#joinName').value = ls('qa-name') || '';
applyI18n(); applyPrefs(); refreshHome();

(function boot() {
  if (q.get('tv')) { $('#game').innerHTML = `<div class="card center">${t('connecting')}</div>`; show('game'); joinRoom(q.get('tv').toUpperCase(), '', true, true); reconnecting = true; return; }
  show('home');
  if (q.get('room')) return;
  try {
    const sp = JSON.parse(ls('qa-player') || 'null');
    if (sp && Date.now() - sp.ts < 8 * 3600e3) { reconnecting = true; banner(t('reconnecting')); joinRoom(sp.code, sp.name, false, true); }
  } catch {}
})();
