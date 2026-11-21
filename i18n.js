'use strict';
/* Utilitaires communs + traductions FR / EN */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; };
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };

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

const I18N = {
  fr: {
    tagline: 'Le quizz buzzer multijoueur à partir de tes decks Anki.',
    joinTitle: '🎮 Rejoindre une partie', codePh: 'CODE', namePh: 'Ton pseudo', join: 'Rejoindre',
    hostTitle: '🎤 Animer une partie',
    step1: 'Crée une room et partage le code (ou le QR code)',
    step2: 'Charge tes decks <code>.apkg</code> (ils sont mémorisés) et règle la partie',
    step3: "Arbitre les réponses données à l'oral",
    createRoom: 'Créer une room', resumeBtn: 'Reprendre', resumeGame: 'Partie en cours (room {c})',
    roomCodeLbl: 'Code de la room', copyLink: '📋 Copier le lien', tvBtn: '📺 Écran TV', copied: 'Lien copié ✓',
    decks: 'Decks', chooseFiles: '📁 Choisir des fichiers .apkg', noDecks: 'Aucun deck. Les decks chargés sont mémorisés sur cet appareil.',
    nCards: '{n} cartes', delDeckTip: 'Supprimer ce fichier', delDeck: 'Supprimer « {f} » des decks mémorisés ?',
    settings: 'Réglages', nbQ: 'Nombre de questions', secs: 'Secondes pour répondre',
    auto: 'Démarrer dès que tout le monde est prêt', autoHint: 'La partie se lance quand chaque joueur a cliqué sur « Prêt »',
    teams: 'Équipes', teamOff: 'Sans', changeTeam: "Changer d'équipe", team0: 'Rouge', team1: 'Bleu', team2: 'Vert', team3: 'Jaune',
    playersTitle: 'Joueurs', startGame: 'Lancer la partie', leaveBtn: 'Quitter',
    waitPlayers: 'En attente de joueurs… partage le code ou le QR code.', readyCount: '{n} / {m} prêt(s)', readyTag: '✓ prêt',
    kick: 'Exclure', kickConfirm: 'Exclure « {n} » ?', noDeck: 'Sélectionne au moins un deck.', loading: 'Chargement…',
    room: 'Room', connecting: 'Connexion…', reconnecting: 'Connexion perdue — reconnexion…', resuming: 'Reprise de la room… (patiente quelques secondes)',
    resumeFail: "Impossible de reprendre la room (code encore occupé). Réessaie dans une minute.", netError: 'Erreur réseau',
    roomNotFound: 'Room introuvable', kicked: 'Tu as été exclu de la partie.', leave: 'Quitter la partie', leaveConfirm: 'Quitter la partie ?',
    nameInvalid: 'Pseudo invalide (2 à 20 caractères : lettres, chiffres, espaces, . _ - \')', nameBad: 'Ce pseudo n\'est pas autorisé.', nameTaken: 'Ce pseudo est déjà pris.', codeRequired: 'Code requis',
    minusTip: 'Retirer 1 point (erreur)', plusTip: 'Ajouter 1 point',
    questionN: 'Question {i} / {n}', answer: 'Réponse', pointFor: '✅ +1 pour {n}', nobody: 'Personne ne marque',
    paused: 'Partie en pause', lastBuzz: 'Dernier buzz : {n}', waitBuzz: "En attente d'un buzz…", answering: 'répond…',
    finalRanking: '🏆 Classement final', stats: 'Statistiques', fastest: 'Plus rapide : {n} ({s})',
    stPlayer: 'Joueur', stOk: 'Bonnes réponses', stKo: 'Erreurs / temps écoulé', stAvg: 'Temps moyen', stBest: 'Meilleur temps',
    stQuestion: 'Question', stWinner: 'Gagnant', missed: 'Questions les plus ratées', history: 'Historique des questions', exportCsv: 'Exporter en CSV',
    hideAnswer: 'Masquer la réponse', showAnswer: 'Afficher la réponse', validate: '✓ Valider · +1 {n}', skip: 'Passer la question', refuse: '✗ Refuser',
    pause: 'Pause', resume: 'Reprendre', next: 'Question suivante ▶', newGame: 'Nouvelle partie', players: 'Joueurs',
    boardHint: '« +1 » ajoute un point (et révèle la réponse si la question est en cours). « −1 » corrige une erreur.', resetRoom: 'Reset la room',
    resetConfirm: 'Réinitialiser la room ? La partie en cours est arrêtée et les scores remis à zéro.',
    waitingRoom: "Salle d'attente", masterStarts: 'Le maître lancera la partie.', readyCancel: '✅ Prêt (annuler)', imReady: 'Je suis prêt !',
    buzz: 'BUZZ', yourTurn: 'À TOI !', blocked: 'Bloqué', youBlocked: 'Tu es bloqué pour cette question', buzzIf: 'Buzze si tu connais la réponse !',
    tvJoin: 'Rejoignez la partie sur',
    tagsTitle: 'Tags', tagsMenu: 'Tags ({n} sélectionné(s))', tagFilterPh: 'Filtrer les tags…', tagsClear: 'Tout décocher', poolCount: '{n} cartes dans le tirage',
  },
  en: {
    tagline: 'The multiplayer buzzer quiz built from your Anki decks.',
    joinTitle: '🎮 Join a game', codePh: 'CODE', namePh: 'Your nickname', join: 'Join',
    hostTitle: '🎤 Host a game',
    step1: 'Create a room and share the code (or the QR code)',
    step2: 'Load your <code>.apkg</code> decks (they are remembered) and set up the game',
    step3: 'Judge the answers given out loud',
    createRoom: 'Create a room', resumeBtn: 'Resume', resumeGame: 'Game in progress (room {c})',
    roomCodeLbl: 'Room code', copyLink: '📋 Copy link', tvBtn: '📺 TV screen', copied: 'Link copied ✓',
    decks: 'Decks', chooseFiles: '📁 Choose .apkg files', noDecks: 'No deck yet. Loaded decks are remembered on this device.',
    nCards: '{n} cards', delDeckTip: 'Delete this file', delDeck: 'Delete "{f}" from saved decks?',
    settings: 'Settings', nbQ: 'Number of questions', secs: 'Seconds to answer',
    auto: 'Start as soon as everyone is ready', autoHint: 'The game starts when every player has clicked "Ready"',
    teams: 'Teams', teamOff: 'Off', changeTeam: 'Change team', team0: 'Red', team1: 'Blue', team2: 'Green', team3: 'Yellow',
    playersTitle: 'Players', startGame: 'Start the game', leaveBtn: 'Leave',
    waitPlayers: 'Waiting for players… share the code or the QR code.', readyCount: '{n} / {m} ready', readyTag: '✓ ready',
    kick: 'Kick', kickConfirm: 'Kick "{n}"?', noDeck: 'Select at least one deck.', loading: 'Loading…',
    room: 'Room', connecting: 'Connecting…', reconnecting: 'Connection lost — reconnecting…', resuming: 'Resuming the room… (please wait a few seconds)',
    resumeFail: 'Could not resume the room (code still in use). Try again in a minute.', netError: 'Network error',
    roomNotFound: 'Room not found', kicked: 'You were removed from the game.', leave: 'Leave the game', leaveConfirm: 'Leave the game?',
    nameInvalid: 'Invalid nickname (2–20 characters: letters, digits, spaces, . _ - \')', nameBad: 'This nickname is not allowed.', nameTaken: 'This nickname is already taken.', codeRequired: 'Code required',
    minusTip: 'Remove 1 point (mistake)', plusTip: 'Add 1 point',
    questionN: 'Question {i} / {n}', answer: 'Answer', pointFor: '✅ +1 for {n}', nobody: 'Nobody scores',
    paused: 'Game paused', lastBuzz: 'Last buzz: {n}', waitBuzz: 'Waiting for a buzz…', answering: 'is answering…',
    finalRanking: '🏆 Final ranking', stats: 'Statistics', fastest: 'Fastest: {n} ({s})',
    stPlayer: 'Player', stOk: 'Correct answers', stKo: 'Mistakes / timeouts', stAvg: 'Average time', stBest: 'Best time',
    stQuestion: 'Question', stWinner: 'Winner', missed: 'Most missed questions', history: 'Question history', exportCsv: 'Export as CSV',
    hideAnswer: 'Hide answer', showAnswer: 'Show answer', validate: '✓ Validate · +1 {n}', skip: 'Skip question', refuse: '✗ Reject',
    pause: 'Pause', resume: 'Resume', next: 'Next question ▶', newGame: 'New game', players: 'Players',
    boardHint: '"+1" adds a point (and reveals the answer if the question is ongoing). "−1" fixes a mistake.', resetRoom: 'Reset the room',
    resetConfirm: 'Reset the room? The current game is stopped and scores are cleared.',
    waitingRoom: 'Waiting room', masterStarts: 'The host will start the game.', readyCancel: '✅ Ready (cancel)', imReady: "I'm ready!",
    buzz: 'BUZZ', yourTurn: 'YOUR TURN!', blocked: 'Locked', youBlocked: 'You are locked for this question', buzzIf: 'Buzz if you know the answer!',
    tvJoin: 'Join the game at',
    tagsTitle: 'Tags', tagsMenu: 'Tags ({n} selected)', tagFilterPh: 'Filter tags…', tagsClear: 'Clear all', poolCount: '{n} cards in the draw',
  },
};

let LANG = ls('qa-lang') || ((navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr');
const t = (k, p) => {
  let s = I18N[LANG][k] ?? I18N.fr[k] ?? k;
  if (p) for (const x in p) s = s.split('{' + x + '}').join(p[x]);
  return s;
};
function setLang(l) { LANG = l; ls('qa-lang', l); }
function applyI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach((e) => (e.textContent = t(e.dataset.i18n)));
  document.querySelectorAll('[data-i18n-html]').forEach((e) => (e.innerHTML = t(e.dataset.i18nHtml)));
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => (e.placeholder = t(e.dataset.i18nPh)));
}
