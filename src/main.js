import { Chessground } from '@lichess-org/chessground';
import '@lichess-org/chessground/assets/chessground.base.css';
import './style.css';
import { Chess } from 'chess.js';
import { io } from 'socket.io-client';

// ─── State ───
let chess = new Chess();
let ground = null;
let mode = 'ai';
let orientation = 'white';
let posHistory = [chess.fen()];
let viewIndex = 0;
let sfWorker = null;
let sfReady = false;
let aiLevel = 3;
let socket = null;
let onlineColor = null;
let onlineGameId = null;
let chosenTC = '5+0';
let chosenColor = 'white';
let timeWhite = 300000, timeBlack = 300000, increment = 0;
let timerInterval = null, lastTickTime = null;
let gameStarted = false, gameOver = false;

// ─── Audio (lichess sounds) ───
const moveAudio = new Audio('/sound/move.mp3');
const captureAudio = new Audio('/sound/capture.mp3');
moveAudio.volume = 0.6;
captureAudio.volume = 0.7;
function playSound(type) {
  const a = type === 'capture' ? captureAudio : moveAudio;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// ─── Game State Persistence ───
function saveGameState() {
  const state = {
    fen: chess.fen(),
    history: chess.history(),
    posHistory,
    viewIndex,
    mode, orientation, aiLevel,
    chosenTC,
    timeWhite, timeBlack, increment,
    gameStarted, gameOver,
  };
  localStorage.setItem('chessr-game', JSON.stringify(state));
}
function loadGameState() {
  try {
    const raw = localStorage.getItem('chessr-game');
    if (!raw) return false;
    const s = JSON.parse(raw);
    chess = new Chess();
    for (const san of s.history) chess.move(san);
    posHistory = s.posHistory || [chess.fen()];
    viewIndex = s.viewIndex || posHistory.length - 1;
    mode = s.mode || 'ai';
    orientation = s.orientation || 'white';
    aiLevel = s.aiLevel || 3;
    chosenTC = s.chosenTC || '5+0';
    timeWhite = s.timeWhite ?? 300000;
    timeBlack = s.timeBlack ?? 300000;
    increment = s.increment || 0;
    gameStarted = s.gameStarted || false;
    gameOver = s.gameOver || false;
    return true;
  } catch { return false; }
}
function clearGameState() {
  localStorage.removeItem('chessr-game');
}

// ─── Routing ───
const ROUTES = {
  '/': 'home',
  '/play/computer': 'setup-ai',
  '/play/online': 'setup-online',
  '/play/friend': 'setup-friend',
  '/game': 'game',
};

function navigate(path, replace) {
  if (replace) history.replaceState({ path }, '', path);
  else history.pushState({ path }, '', path);
  showScreen(ROUTES[path] || 'home');
}

function showScreen(id) {
  ['home', 'setup-ai', 'setup-online', 'setup-friend', 'game'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === id) {
      el.classList.remove('hide');
      el.style.animation = 'none';
      el.offsetHeight;
      el.style.animation = '';
    } else {
      el.classList.add('hide');
    }
  });

  // Show video on all pages except game
  const vid = document.getElementById('hero-video');
  if (vid) {
    if (id === 'game') { vid.classList.add('vid-hidden'); vid.pause(); }
    else { vid.classList.remove('vid-hidden'); vid.play().catch(() => {}); }
  }
  // Close any game-end banner and confirm dialogs when leaving game
  if (id !== 'game') $endBanner.classList.add('hide');
  document.getElementById('confirm-bar')?.classList.add('hide');
  document.getElementById('draw-offer-bar')?.classList.add('hide');
  // Resize board when switching to game
  if (id === 'game' && ground) {
    requestAnimationFrame(() => { resizeBoard(); ground.redrawAll(); });
  }
}

window.addEventListener('popstate', (e) => {
  const path = e.state?.path || '/';
  showScreen(ROUTES[path] || 'home');
});

// ─── DOM ───
const $ = (id) => document.getElementById(id);
const $board = $('board');
const $topName = $('top-name'), $botName = $('bot-name');
const $topClk = $('top-clk'), $botClk = $('bot-clk');
const $topBar = $('top-bar'), $botBar = $('bot-bar');
const $topDot = $('top-dot'), $botDot = $('bot-dot');
const $movelist = $('movelist');
const $endBanner = $('game-end-banner');
const $ovTitle = $('ov-title'), $ovMsg = $('ov-msg');
const $ovPromo = $('ov-promo'), $promoOpts = $('promo-opts');
const $toasts = $('toasts');

// ─── Helpers ───
function formatTime(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000), m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}
function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}
function parseTC(tc) {
  if (tc === '0+0') return [0, 0];
  const [m, i] = tc.split('+').map(Number);
  return [m * 60000, (i || 0) * 1000];
}
function toDests() {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}
function turnColor() { return chess.turn() === 'w' ? 'white' : 'black'; }
function isPromotion(orig, dest) {
  const p = chess.get(orig);
  if (!p || p.type !== 'p') return false;
  return (p.color === 'w' && dest[1] === '8') || (p.color === 'b' && dest[1] === '1');
}
function getMovableColor() {
  if (gameOver) return undefined;
  if (mode === 'ai') return orientation;
  if (mode === 'online') return onlineColor || undefined;
  return undefined;
}

// ─── Board ───
function initBoard() {
  resizeBoard();
  ground = Chessground($board, {
    fen: chess.fen(), orientation,
    turnColor: turnColor(),
    movable: { color: getMovableColor(), free: false, dests: toDests(), events: { after: onUserMove } },
    animation: { enabled: true, duration: 150 },
    highlight: { lastMove: true, check: true },
    premovable: { enabled: true, showDests: true, events: { set: onPremoveSet, unset: onPremoveUnset } },
    predroppable: { enabled: false },
    draggable: { showGhost: true },
    coordinates: true,
  });
}

let pendingPremove = null;
function onPremoveSet(orig, dest) { pendingPremove = { orig, dest }; }
function onPremoveUnset() { pendingPremove = null; }

function tryPremove() {
  if (!pendingPremove || gameOver) return;
  const { orig, dest } = pendingPremove;
  pendingPremove = null;
  ground.cancelPremove();
  if (isPromotion(orig, dest)) {
    showPromoDialog(chess.turn() === 'w' ? 'white' : 'black');
    pendingPromo = { orig, dest };
  } else {
    executeMove(orig, dest);
  }
}

function syncBoard(lastMove) {
  ground.set({
    fen: chess.fen(), turnColor: turnColor(),
    movable: { color: getMovableColor(), dests: toDests() },
    lastMove,
    check: chess.in_check() ? turnColor() : false,
  });
}
function resizeBoard() {
  const mainEl = $('main');
  if (!mainEl) return;
  const availH = mainEl.clientHeight - 50 * 2 - 40;
  const wrap = $('board-wrap');
  const availW = wrap ? wrap.clientWidth : 600;
  const sz = Math.max(200, Math.min(availH, availW, 900));
  $board.style.width = sz + 'px';
  $board.style.height = sz + 'px';
  document.documentElement.style.setProperty('--board-px', sz + 'px');
}

// ─── Moves ───
let pendingPromo = null;
function onUserMove(orig, dest) {
  if (isPromotion(orig, dest)) { pendingPromo = { orig, dest }; showPromoDialog(chess.turn() === 'w' ? 'white' : 'black'); return; }
  executeMove(orig, dest);
}
function executeMove(orig, dest, promotion) {
  const move = chess.move({ from: orig, to: dest, promotion });
  if (!move) { syncBoard(); return; }
  playSound(move.captured ? 'capture' : 'move');
  posHistory = posHistory.slice(0, viewIndex + 1);
  posHistory.push(chess.fen());
  viewIndex = posHistory.length - 1;
  syncBoard([orig, dest]);
  updateMoveList(); updateBars();
  if (timeWhite > 0 || timeBlack > 0) {
    if (!gameStarted && posHistory.length > 2) { gameStarted = true; startTimer(); }
    else if (gameStarted) { if (move.color === 'w') timeWhite += increment; else timeBlack += increment; updateClocks(); }
  }
  saveGameState();
  if (checkGameEnd()) return;
  if (mode === 'ai' && turnColor() !== orientation) setTimeout(aiMove, 150);
  if (mode === 'online' && onlineGameId) socket.emit('move', { gameId: onlineGameId, from: orig, to: dest, promotion });
}
function showPromoDialog(color) {
  $ovPromo.classList.add('open');
  $promoOpts.innerHTML = '';
  const prefix = color === 'white' ? 'w' : 'b';
  for (const [p, n] of [['q','Q'],['r','R'],['b','B'],['n','N']]) {
    const btn = document.createElement('div');
    btn.className = 'promo-pc';
    btn.style.backgroundImage = `url('/piece/${prefix}${n}.svg')`;
    btn.addEventListener('click', () => { $ovPromo.classList.remove('open'); if (pendingPromo) { executeMove(pendingPromo.orig, pendingPromo.dest, p); pendingPromo = null; } });
    $promoOpts.appendChild(btn);
  }
}

// ─── Stockfish ───
const SKILL = [
  { skill: 0, depth: 1, time: 50 }, { skill: 3, depth: 2, time: 100 },
  { skill: 6, depth: 4, time: 200 }, { skill: 9, depth: 6, time: 300 },
  { skill: 12, depth: 8, time: 500 }, { skill: 15, depth: 11, time: 800 },
  { skill: 18, depth: 14, time: 1200 }, { skill: 20, depth: 18, time: 2000 },
];
const AI_NAMES = ['Beginner', 'Novice', 'Casual', 'Club', 'Advanced', 'Expert', 'Master', 'Maximum'];

function initStockfish() {
  if (sfWorker) return;
  sfWorker = new Worker('/js/stockfish.js');
  sfWorker.onmessage = (e) => {
    const line = e.data;
    if (line === 'uciok') { sfReady = true; sfWorker.postMessage('isready'); }
    if (typeof line === 'string' && line.startsWith('bestmove')) {
      const best = line.split(' ')[1];
      if (!best || best === '(none)') return;
      const from = best.substring(0, 2), to = best.substring(2, 4);
      const promo = best.length > 4 ? best[4] : undefined;
      const move = chess.move({ from, to, promotion: promo });
      if (move) {
        playSound(move.captured ? 'capture' : 'move');
        posHistory = posHistory.slice(0, viewIndex + 1);
        posHistory.push(chess.fen());
        viewIndex = posHistory.length - 1;
        ground.move(from, to);
        syncBoard([from, to]);
        updateMoveList(); updateBars();
        if (gameStarted) { if (move.color === 'w') timeWhite += increment; else timeBlack += increment; updateClocks(); }
        saveGameState();
        if (!checkGameEnd()) {
          if (pendingPremove) setTimeout(tryPremove, 50);
        }
      }
    }
  };
  sfWorker.postMessage('uci');
}
function aiMove() {
  if (!sfReady || gameOver) return;
  const cfg = SKILL[aiLevel - 1] || SKILL[2];
  sfWorker.postMessage('setoption name Skill Level value ' + cfg.skill);
  sfWorker.postMessage('position fen ' + chess.fen());
  sfWorker.postMessage('go depth ' + cfg.depth + ' movetime ' + cfg.time);
}

// ─── Timer ───
function startTimer() {
  clearInterval(timerInterval);
  lastTickTime = Date.now();
  timerInterval = setInterval(() => {
    if (gameOver) { clearInterval(timerInterval); return; }
    const now = Date.now(), dt = now - lastTickTime; lastTickTime = now;
    if (chess.turn() === 'w') timeWhite -= dt; else timeBlack -= dt;
    if (timeWhite <= 0) { timeWhite = 0; endGame('Black wins on time'); return; }
    if (timeBlack <= 0) { timeBlack = 0; endGame('White wins on time'); return; }
    updateClocks();
  }, 100);
}
function updateClocks() {
  const topW = orientation === 'black';
  $topClk.textContent = formatTime(topW ? timeWhite : timeBlack);
  $botClk.textContent = formatTime(topW ? timeBlack : timeWhite);
  $topClk.parentElement.classList.toggle('low', (topW ? timeWhite : timeBlack) < 30000 && gameStarted);
  $botClk.parentElement.classList.toggle('low', (topW ? timeBlack : timeWhite) < 30000 && gameStarted);
  const wm = chess.turn() === 'w', tt = topW ? wm : !wm;
  $topClk.parentElement.classList.toggle('ticking', tt && gameStarted);
  $botClk.parentElement.classList.toggle('ticking', !tt && gameStarted);
}
function resetTimers(ms, inc) {
  clearInterval(timerInterval);
  timeWhite = ms; timeBlack = ms; increment = inc || 0;
  gameStarted = false; lastTickTime = null;
  updateClocks();
}

// ─── Game end ───
function checkGameEnd() {
  if (chess.in_checkmate()) { endGame((chess.turn() === 'w' ? 'Black' : 'White') + ' wins by checkmate'); return true; }
  if (chess.in_stalemate()) { endGame('Stalemate'); return true; }
  if (chess.in_threefold_repetition()) { endGame('Draw by repetition'); return true; }
  if (chess.insufficient_material()) { endGame('Insufficient material'); return true; }
  if (chess.in_draw()) { endGame('Draw'); return true; }
  return false;
}
function endGame(msg) {
  gameOver = true; clearInterval(timerInterval);
  $ovTitle.textContent = msg;
  $ovMsg.textContent = '';
  $endBanner.classList.remove('hide');
  ground.set({ movable: { color: undefined }, premovable: { enabled: false } });
  saveGameState();
}

// ─── Move list ───
function updateMoveList() {
  const history = chess.history();
  $movelist.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('div'); row.className = 'mv';
    const num = document.createElement('span'); num.className = 'mv-n';
    num.textContent = Math.floor(i / 2) + 1 + '.'; row.appendChild(num);
    const w = document.createElement('span'); w.className = 'mv-s';
    w.textContent = history[i]; const wi = i;
    w.addEventListener('click', () => goToMove(wi + 1));
    if (i + 1 === viewIndex) w.classList.add('cur');
    row.appendChild(w);
    if (history[i + 1]) {
      const b = document.createElement('span'); b.className = 'mv-s';
      b.textContent = history[i + 1]; const bi = i + 1;
      b.addEventListener('click', () => goToMove(bi + 1));
      if (i + 2 === viewIndex) b.classList.add('cur');
      row.appendChild(b);
    }
    $movelist.appendChild(row);
  }
  $movelist.scrollTop = $movelist.scrollHeight;
}
function goToMove(idx) {
  if (idx < 0 || idx >= posHistory.length) return;
  const prev = viewIndex;
  viewIndex = idx;
  const fen = posHistory[viewIndex];
  ground.set({
    fen, lastMove: undefined,
    movable: { color: viewIndex === posHistory.length - 1 ? getMovableColor() : undefined, dests: viewIndex === posHistory.length - 1 ? toDests() : new Map() },
    turnColor: fen.split(' ')[1] === 'w' ? 'white' : 'black',
    animation: { enabled: false },
  });
  document.querySelectorAll('.mv-s').forEach((el, i) => el.classList.toggle('cur', i + 1 === viewIndex));
  if (prev !== viewIndex) playSound('move');
  // Re-enable animation for actual moves
  ground.set({ animation: { enabled: true, duration: 150 } });
}

// ─── Bars ───
function updateBars() {
  const wm = chess.turn() === 'w', topW = orientation === 'black';
  const ta = topW ? wm : !wm;
  $topBar.classList.toggle('active', ta && !gameOver);
  $botBar.classList.toggle('active', !ta && !gameOver);
  $topDot.classList.toggle('on', ta && !gameOver);
  $botDot.classList.toggle('on', !ta && !gameOver);
}
function updateNames() {
  if (mode === 'ai') {
    const n = AI_NAMES[aiLevel - 1] || 'AI';
    if (orientation === 'white') { $topName.textContent = 'Stockfish · ' + n; $botName.textContent = 'You'; }
    else { $topName.textContent = 'You'; $botName.textContent = 'Stockfish · ' + n; }
  } else {
    $topName.textContent = 'Opponent';
    $botName.textContent = 'You';
  }
}

// ─── Resume game from localStorage ───
function resumeGame() {
  if (!loadGameState()) return false;
  if (mode === 'ai') initStockfish();
  $endBanner.classList.add('hide');
  $ovPromo.classList.remove('open');

  const [ms] = parseTC(chosenTC);
  if (ms === 0) {
    $('top-cw').style.display = 'none';
    $('bot-cw').style.display = 'none';
  } else {
    $('top-cw').style.display = '';
    $('bot-cw').style.display = '';
  }

  if (!ground) {
    requestAnimationFrame(() => {
      initBoard(); syncBoard(); updateMoveList(); updateNames(); updateBars();
      if (ms > 0) updateClocks();
      if (gameOver) {
        ground.set({ movable: { color: undefined }, premovable: { enabled: false } });
        endGame($ovTitle.textContent || 'Game over');
      } else {
        // Restart timer if game was in progress
        if (gameStarted && ms > 0) startTimer();
        if (mode === 'ai' && turnColor() !== orientation) setTimeout(aiMove, 300);
      }
    });
  } else {
    resizeBoard();
    ground.set({ orientation, premovable: { enabled: !gameOver } });
    syncBoard(); ground.redrawAll();
    updateMoveList(); updateNames(); updateBars();
    if (ms > 0) updateClocks();
    if (!gameOver && gameStarted && ms > 0) startTimer();
    if (!gameOver && mode === 'ai' && turnColor() !== orientation) setTimeout(aiMove, 300);
  }
  return true;
}

// ─── Start game ───
function startGame() {
  clearGameState();
  navigate('/game');
  chess = new Chess();
  posHistory = [chess.fen()]; viewIndex = 0;
  gameOver = false; pendingPremove = null;
  $endBanner.classList.add('hide');
  $ovPromo.classList.remove('open');
  $('confirm-bar').classList.add('hide');
  $('draw-offer-bar').classList.add('hide');

  const [ms, inc] = parseTC(chosenTC);
  if (ms === 0) {
    timeWhite = 0; timeBlack = 0; increment = 0;
    $('top-cw').style.display = 'none';
    $('bot-cw').style.display = 'none';
  } else {
    $('top-cw').style.display = '';
    $('bot-cw').style.display = '';
    resetTimers(ms, inc);
  }

  if (!ground) {
    requestAnimationFrame(() => {
      initBoard(); syncBoard(); updateMoveList(); updateNames(); updateBars();
      if (ms > 0) updateClocks();
      if (mode === 'ai' && orientation === 'black') setTimeout(aiMove, 300);
    });
  } else {
    resizeBoard();
    ground.set({ orientation, premovable: { enabled: true } });
    syncBoard(); ground.redrawAll();
    updateMoveList(); updateNames(); updateBars();
    if (ms > 0) updateClocks();
    if (mode === 'ai' && orientation === 'black') setTimeout(aiMove, 300);
  }
}

// ─── Socket.IO ───
function initSocket() {
  if (socket) return;
  const backendUrl = import.meta.env.VITE_BACKEND_URL || undefined;
  socket = io(backendUrl);
  socket.on('queue-joined', () => {});
  socket.on('game-matched', ({ gameId, color, tc }) => {
    onlineGameId = gameId; onlineColor = color; orientation = color;
    chosenTC = tc; mode = 'online'; startGame();
  });
  socket.on('game-created', ({ gameId, color }) => {
    onlineGameId = gameId; onlineColor = color;
    $('share-code').textContent = gameId;
    const host = window.location.hostname === 'localhost' ? window.location.origin : 'https://chessr.gg';
    $('share-link').value = host + '/play/friend?join=' + gameId;
    $('friend-actions').classList.add('hide');
    $('wait-card').classList.remove('hide');
  });
  socket.on('game-joined', ({ gameId, color, tc }) => {
    onlineGameId = gameId; onlineColor = color; orientation = color;
    chosenTC = tc; mode = 'online'; startGame();
  });
  socket.on('game-start', ({ tc }) => {
    orientation = onlineColor; chosenTC = tc; mode = 'online'; startGame();
  });
  socket.on('opponent-move', ({ from, to, promotion }) => {
    const move = chess.move({ from, to, promotion });
    if (move) {
      playSound(move.captured ? 'capture' : 'move');
      posHistory.push(chess.fen()); viewIndex = posHistory.length - 1;
      ground.move(from, to); syncBoard([from, to]);
      updateMoveList(); updateBars();
      if (!gameStarted && posHistory.length > 2 && (timeWhite > 0 || timeBlack > 0)) { gameStarted = true; startTimer(); }
      else if (gameStarted) { if (move.color === 'w') timeWhite += increment; else timeBlack += increment; updateClocks(); }
      if (!checkGameEnd() && pendingPremove) setTimeout(tryPremove, 50);
    }
  });
  socket.on('opponent-resigned', () => endGame('Opponent resigned'));
  socket.on('opponent-disconnected', () => { toast('Opponent disconnected', true); endGame('Opponent left'); });
  socket.on('draw-offered', () => {
    $('draw-offer-bar').classList.remove('hide');
  });
  socket.on('draw-accepted', () => endGame('Draw by agreement'));
  socket.on('rematch-offer', ({ gameId, color, tc }) => {
    onlineGameId = gameId; onlineColor = color; orientation = color;
    chosenTC = tc; startGame();
  });
  socket.on('error-msg', ({ message }) => toast(message, true));
}

// ─── Selection helper ───
function wireSelection(containerId, attr, callback) {
  const container = $(containerId);
  if (!container) return;
  container.querySelectorAll('.g-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.g-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      callback(btn.dataset[attr]);
    });
  });
}

// ─── WIRING ───

// Home → Setup
$('play-computer').addEventListener('click', () => navigate('/play/computer'));
$('play-online').addEventListener('click', () => navigate('/play/online'));
$('play-friend').addEventListener('click', () => navigate('/play/friend'));

// Brand + back → home
document.querySelectorAll('[data-go="home"]').forEach(el => {
  el.addEventListener('click', () => {
    clearInterval(timerInterval);
    $endBanner.classList.add('hide');
    if (socket) socket.emit('cancel-find');
    navigate('/');
  });
});

// Computer setup
wireSelection('diff-grid', 'lv', (v) => { aiLevel = parseInt(v); });
wireSelection('tc-grid-ai', 'tc', (v) => { chosenTC = v; });
document.querySelectorAll('.color-row .g-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-row .g-btn').forEach(b => b.classList.remove('sel'));
    btn.classList.add('sel');
    chosenColor = btn.dataset.c;
  });
});
$('btn-start-ai').addEventListener('click', () => {
  initStockfish();
  orientation = chosenColor === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : chosenColor;
  mode = 'ai'; startGame();
});

// Online setup
wireSelection('tc-grid-online', 'tc', (v) => { chosenTC = v; });
$('btn-find-game').addEventListener('click', () => {
  initSocket();
  socket.emit('find-game', { tc: chosenTC });
  $('btn-find-game').classList.add('hide');
  $('searching-box').classList.remove('hide');
});
$('btn-cancel-search').addEventListener('click', () => {
  if (socket) socket.emit('cancel-find');
  $('searching-box').classList.add('hide');
  $('btn-find-game').classList.remove('hide');
});

// Friend setup
wireSelection('tc-grid-friend', 'tc', (v) => { chosenTC = v; });
$('btn-create-game').addEventListener('click', () => { initSocket(); socket.emit('create-game', { tc: chosenTC, color: 'random' }); });
$('btn-join-game').addEventListener('click', () => {
  const code = $('join-inp').value.trim();
  if (!code) return toast('Enter a game code', true);
  initSocket(); socket.emit('join-game', { gameId: code });
});
$('btn-copy-code').addEventListener('click', () => { navigator.clipboard.writeText($('share-code').textContent).then(() => toast('Code copied!')); });
$('btn-copy-link').addEventListener('click', () => { navigator.clipboard.writeText($('share-link').value).then(() => toast('Link copied!')); });
$('btn-cancel-wait').addEventListener('click', () => {
  $('wait-card').classList.add('hide'); $('friend-actions').classList.remove('hide');
  onlineGameId = null;
});

// Dismiss banner by clicking outside the inner card
$endBanner.addEventListener('click', (e) => {
  if (e.target === $endBanner) $endBanner.classList.add('hide');
});

// Game
$('btn-new-game').addEventListener('click', () => { clearInterval(timerInterval); $endBanner.classList.add('hide'); navigate(mode === 'ai' ? '/play/computer' : '/'); });
$('btn-ov-new').addEventListener('click', () => {
  $endBanner.classList.add('hide');
  if (mode === 'ai') {
    startGame();
  } else if (mode === 'online') {
    navigate('/play/online');
  } else {
    navigate('/play/friend');
  }
});
$('btn-flip').addEventListener('click', () => {
  orientation = orientation === 'white' ? 'black' : 'white';
  ground.set({ orientation }); updateNames(); updateBars();
  if (timeWhite > 0) updateClocks();
});
// ─── Confirm dialog helper ───
let confirmAction = null;
function showConfirm(msg, action) {
  $('confirm-msg').textContent = msg;
  confirmAction = action;
  $('confirm-bar').classList.remove('hide');
}
function hideConfirm() {
  $('confirm-bar').classList.add('hide');
  confirmAction = null;
}
$('confirm-yes').addEventListener('click', () => { if (confirmAction) confirmAction(); hideConfirm(); });
$('confirm-no').addEventListener('click', hideConfirm);

// Resign with confirmation
$('btn-resign').addEventListener('click', () => {
  if (gameOver) return;
  showConfirm('Resign this game?', () => {
    if (mode === 'online' && onlineGameId) socket.emit('resign', { gameId: onlineGameId });
    endGame('You resigned');
  });
});

// Draw offer with confirmation
$('btn-draw').addEventListener('click', () => {
  if (gameOver) return;
  if (mode === 'ai') {
    showConfirm('Offer draw to engine?', () => endGame('Draw by agreement'));
  } else if (mode === 'online' && onlineGameId) {
    showConfirm('Offer a draw?', () => {
      socket.emit('offer-draw', { gameId: onlineGameId });
      toast('Draw offer sent');
    });
  }
});

// Draw offer received buttons
$('draw-accept').addEventListener('click', () => {
  $('draw-offer-bar').classList.add('hide');
  if (onlineGameId) socket.emit('accept-draw', { gameId: onlineGameId });
  endGame('Draw by agreement');
});
$('draw-decline').addEventListener('click', () => {
  $('draw-offer-bar').classList.add('hide');
  toast('Draw declined');
});

// Move nav
$('mn-start').addEventListener('click', () => goToMove(0));
$('mn-back').addEventListener('click', () => goToMove(viewIndex - 1));
$('mn-fwd').addEventListener('click', () => goToMove(viewIndex + 1));
$('mn-end').addEventListener('click', () => goToMove(posHistory.length - 1));

// Arrow keys
document.addEventListener('keydown', (e) => {
  if ($('game').classList.contains('hide')) return;
  if (e.key === 'ArrowLeft') goToMove(viewIndex - 1);
  else if (e.key === 'ArrowRight') goToMove(viewIndex + 1);
  else if (e.key === 'ArrowUp') { e.preventDefault(); goToMove(0); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); goToMove(posHistory.length - 1); }
});

// Resize
window.addEventListener('resize', () => { if (ground) { resizeBoard(); ground.redrawAll(); } });

// ─── Init: route based on URL ───
const initPath = window.location.pathname;
const initParams = new URLSearchParams(window.location.search);
const joinCode = initParams.get('join');

if (joinCode) {
  initSocket();
  setTimeout(() => socket.emit('join-game', { gameId: joinCode }), 500);
  showScreen('setup-friend');
} else if (initPath === '/game') {
  showScreen('game');
  history.replaceState({ path: '/game' }, '', '/game');
  if (!resumeGame()) {
    navigate('/', true);
  }
} else {
  const screen = ROUTES[initPath];
  if (screen) {
    showScreen(screen);
    history.replaceState({ path: initPath }, '', initPath);
  } else {
    navigate('/', true);
  }
}
