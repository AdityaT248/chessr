import { Chessground } from 'chessground';

/* ═══════════════════════════════════
   MONARCH — Chess App
   ═══════════════════════════════════ */
const App = (() => {
  // ── State ──
  let ground = null;
  let chess = new Chess();
  let mode = 'ai';
  let playerColor = 'white';
  let flipped = false;
  let gameOver = false;

  // AI
  let stockfish = null;
  let aiLevel = 3;
  let aiThinking = false;

  // Timers
  let timeControl = 60;
  let increment = 0;
  let timers = { white: 60000, black: 60000 };
  let timerInterval = null;
  let activeTimer = null;

  // Move history + navigation
  let positions = [];   // FEN after each move
  let sans = [];        // SAN strings
  let viewIdx = -1;     // -1 = live view

  // Online (our server)
  let socket = null;
  let gameId = null;

  // Lichess
  let lichessToken = null;
  let lichessAbort = null;

  // Audio
  let audioCtx = null;

  /* ═══ INIT ═══ */
  function init() {
    initBoard();
    initStockfish();
    bindUI();
    newGame();
    checkUrlJoin();
  }

  function initBoard() {
    ground = Chessground(document.getElementById('board'), {
      fen: chess.fen(),
      orientation: 'white',
      turnColor: 'white',
      coordinates: true,
      animation: { enabled: true, duration: 180 },
      movable: {
        free: false, color: 'white',
        showDests: true,
        dests: getDests(),
        events: { after: onUserMove }
      },
      premovable: { enabled: false },
      draggable: { showGhost: true, distance: 3 },
      highlight: { lastMove: true, check: true },
    });
  }

  function initStockfish() {
    try {
      stockfish = new Worker('/js/stockfish.js');
      stockfish.postMessage('uci');
      stockfish.onmessage = e => {
        if (typeof e.data === 'string' && e.data.startsWith('bestmove')) {
          const uci = e.data.split(' ')[1];
          if (uci && uci !== '(none)') handleAiMove(uci);
        }
      };
    } catch (err) {
      console.warn('Stockfish failed to load:', err);
    }
  }

  /* ═══ CHESSGROUND HELPERS ═══ */
  function getDests() {
    const dests = new Map();
    'abcdefgh'.split('').forEach(f => {
      for (let r = 1; r <= 8; r++) {
        const sq = f + r;
        const ms = chess.moves({ square: sq, verbose: true });
        if (ms.length) dests.set(sq, ms.map(m => m.to));
      }
    });
    return dests;
  }

  function syncGround() {
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    ground.set({
      fen: chess.fen(),
      turnColor: turn,
      movable: { color: movableColor(), dests: getDests() },
      check: chess.in_check() ? turn : false,
    });
    updateDots();
    updateClocks();
  }

  function movableColor() {
    if (gameOver || viewIdx >= 0) return undefined;
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    if (mode === 'local') return turn;
    return turn === playerColor ? playerColor : undefined;
  }

  /* ═══ MOVES ═══ */
  function onUserMove(orig, dest) {
    // Promotion check
    const piece = chess.get(orig);
    if (piece && piece.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      showPromotion(orig, dest, piece.color);
      return;
    }
    execMove(orig, dest);
  }

  function execMove(from, to, promo) {
    const move = chess.move({ from, to, promotion: promo || undefined });
    if (!move) { syncGround(); return; }
    afterMove(move);
  }

  function afterMove(move) {
    positions.push(chess.fen());
    sans.push(move.san);
    viewIdx = -1;

    syncGround();
    renderMoves();
    sound(move.captured ? 'cap' : 'mv');
    if (chess.in_check()) sound('chk');

    // Increment
    if (timeControl > 0 && increment > 0 && activeTimer) {
      timers[activeTimer] += increment * 1000;
    }
    switchTimer();
    updateClocks();

    if (chess.game_over()) { endGame(); return; }

    // AI
    if (mode === 'ai' && !isMyTurn()) requestAi();

    // Online
    if (mode === 'online' && socket) {
      socket.emit('move', { gameId, move: { from: move.from, to: move.to, promotion: move.promotion }, fen: chess.fen(), timeLeft: timers[playerColor] });
    }

    // Lichess
    if (mode === 'lichess' && lichessToken && gameId) {
      const uci = move.from + move.to + (move.promotion || '');
      fetch(`https://lichess.org/api/board/game/${gameId}/move/${uci}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${lichessToken}` }
      });
    }
  }

  function isMyTurn() {
    return (chess.turn() === 'w' ? 'white' : 'black') === playerColor;
  }

  /* ═══ PROMOTION ═══ */
  function showPromotion(from, to, color) {
    const row = document.getElementById('promo-row');
    row.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(p => {
      const btn = document.createElement('div');
      btn.className = 'promo-btn';
      const file = color === 'w' ? 'w' : 'b';
      btn.style.backgroundImage = `url('/piece/${file}${p.toUpperCase()}.svg')`;
      btn.style.backgroundSize = 'cover';
      btn.onclick = () => { closeOv('ov-promo'); execMove(from, to, p); };
      row.appendChild(btn);
    });
    openOv('ov-promo');
  }

  /* ═══ AI ═══ */
  function requestAi() {
    if (!stockfish || aiThinking) return;
    aiThinking = true;
    const levels = [
      { skill: 0, depth: 1, time: 100 },
      { skill: 3, depth: 2, time: 200 },
      { skill: 6, depth: 4, time: 350 },
      { skill: 9, depth: 6, time: 500 },
      { skill: 12, depth: 8, time: 700 },
      { skill: 15, depth: 10, time: 1000 },
      { skill: 18, depth: 12, time: 1500 },
      { skill: 20, depth: 16, time: 2500 },
    ];
    const lv = levels[aiLevel - 1] || levels[2];
    stockfish.postMessage(`setoption name Skill Level value ${lv.skill}`);
    stockfish.postMessage(`position fen ${chess.fen()}`);
    stockfish.postMessage(`go depth ${lv.depth} movetime ${lv.time}`);
  }

  function handleAiMove(uci) {
    aiThinking = false;
    if (gameOver) return;
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4] || undefined;
    const move = chess.move({ from, to, promotion: promo });
    if (!move) return;
    ground.move(from, to);
    afterMove(move);
  }

  /* ═══ MOVE NAV ═══ */
  function navBack() {
    if (positions.length === 0) return;
    if (viewIdx === -1) viewIdx = positions.length - 1;
    if (viewIdx <= 0) {
      viewIdx = 0;
      ground.set({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', movable: { color: undefined, dests: new Map() }, check: false, lastMove: undefined });
    } else {
      viewIdx--;
      ground.set({ fen: positions[viewIdx], movable: { color: undefined, dests: new Map() }, check: false });
    }
    highlightMoveInList();
  }
  function navFwd() {
    if (viewIdx === -1) return;
    viewIdx++;
    if (viewIdx >= positions.length) { viewIdx = -1; syncGround(); }
    else { ground.set({ fen: positions[viewIdx], movable: { color: undefined, dests: new Map() }, check: false }); }
    highlightMoveInList();
  }
  function navStart() { if (positions.length === 0) return; viewIdx = 0; ground.set({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', movable: { color: undefined, dests: new Map() }, check: false, lastMove: undefined }); highlightMoveInList(); }
  function navEnd() { viewIdx = -1; syncGround(); highlightMoveInList(); }

  function highlightMoveInList() {
    document.querySelectorAll('.mn-san').forEach((el, i) => {
      const active = viewIdx === -1 ? i === sans.length - 1 : i === viewIdx - 1;
      el.classList.toggle('cur', active);
    });
  }

  /* ═══ MOVE LIST ═══ */
  function renderMoves() {
    const el = document.getElementById('moves');
    el.innerHTML = '';
    for (let i = 0; i < sans.length; i += 2) {
      const row = document.createElement('div'); row.className = 'mr';
      const num = document.createElement('span'); num.className = 'mn-num'; num.textContent = (i / 2 + 1) + '.';
      const w = document.createElement('span'); w.className = 'mn-san' + (i === sans.length - 1 ? ' cur' : '');
      w.textContent = sans[i]; w.onclick = () => goToMove(i + 1);
      row.append(num, w);
      if (sans[i + 1]) {
        const b = document.createElement('span'); b.className = 'mn-san' + (i + 1 === sans.length - 1 ? ' cur' : '');
        b.textContent = sans[i + 1]; b.onclick = () => goToMove(i + 2);
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    el.scrollTop = el.scrollHeight;
  }

  function goToMove(idx) {
    if (idx >= positions.length) { viewIdx = -1; syncGround(); }
    else { viewIdx = idx; ground.set({ fen: positions[viewIdx], movable: { color: undefined, dests: new Map() }, check: false }); }
    highlightMoveInList();
  }

  /* ═══ TIMERS ═══ */
  function startTimers() {
    stopTimers();
    if (timeControl === 0) {
      document.getElementById('top-clk').textContent = '∞';
      document.getElementById('bot-clk').textContent = '∞';
      return;
    }
    timers.white = timeControl * 1000;
    timers.black = timeControl * 1000;
    activeTimer = 'white';
    updateClocks();
    timerInterval = setInterval(tickTimer, 100);
  }

  function tickTimer() {
    if (!activeTimer || gameOver) return;
    timers[activeTimer] -= 100;
    if (timers[activeTimer] <= 0) {
      timers[activeTimer] = 0;
      updateClocks();
      const winner = activeTimer === 'white' ? 'Black' : 'White';
      finishGame(activeTimer === 'white' ? '0-1' : '1-0', `${winner} wins on time`);
      return;
    }
    updateClocks();
  }

  function switchTimer() {
    if (timeControl === 0) return;
    activeTimer = chess.turn() === 'w' ? 'white' : 'black';
  }

  function stopTimers() { if (timerInterval) clearInterval(timerInterval); activeTimer = null; }

  function fmtTime(ms) {
    if (ms <= 0) return '0:00';
    const s = Math.ceil(ms / 1000), m = Math.floor(s / 60), ss = s % 60;
    return m >= 60 ? `${Math.floor(m/60)}:${(m%60).toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}` : `${m}:${ss.toString().padStart(2,'0')}`;
  }

  function updateClocks() {
    if (timeControl === 0) return;
    const orient = ground.state.orientation;
    const topC = orient === 'white' ? 'black' : 'white';
    const botC = orient === 'white' ? 'white' : 'black';
    document.getElementById('top-clk').textContent = fmtTime(timers[topC]);
    document.getElementById('bot-clk').textContent = fmtTime(timers[botC]);
    const tcw = document.getElementById('top-cw'), bcw = document.getElementById('bot-cw');
    tcw.classList.toggle('act', activeTimer === topC);
    bcw.classList.toggle('act', activeTimer === botC);
    tcw.classList.toggle('low', timers[topC] > 0 && timers[topC] <= 30000);
    bcw.classList.toggle('low', timers[botC] > 0 && timers[botC] <= 30000);
  }

  function updateDots() {
    const orient = ground.state.orientation;
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const topC = orient === 'white' ? 'black' : 'white';
    document.getElementById('top-dot').classList.toggle('on', turn === topC);
    document.getElementById('bot-dot').classList.toggle('on', turn !== topC);
    document.getElementById('top-bar').classList.toggle('turn', turn === topC);
    document.getElementById('bot-bar').classList.toggle('turn', turn !== topC);
  }

  /* ═══ CAPTURED PIECES ═══ */
  function updateCaptures() {
    const hist = chess.history({ verbose: true });
    const cap = { w: [], b: [] };
    hist.forEach(m => { if (m.captured) cap[m.color === 'w' ? 'b' : 'w'].push(m.captured); });
    const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    cap.w.sort((a, b) => order[a] - order[b]);
    cap.b.sort((a, b) => order[a] - order[b]);
    let wm = 0, bm = 0;
    cap.w.forEach(p => { wm += val[p] || 0; });
    cap.b.forEach(p => { bm += val[p] || 0; });
    const diff = bm - wm;
    const orient = ground.state.orientation;
    const topC = orient === 'white' ? 'b' : 'w';
    const botC = orient === 'white' ? 'w' : 'b';
    const sym = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
    document.getElementById('top-cap').textContent = cap[botC === 'w' ? 'w' : 'b'].map(p => sym[p] || '').join('');
    document.getElementById('bot-cap').textContent = cap[topC === 'w' ? 'w' : 'b'].map(p => sym[p] || '').join('');
    const td = orient === 'white' ? -diff : diff;
    const bd = orient === 'white' ? diff : -diff;
    document.getElementById('top-diff').textContent = td > 0 ? `+${td}` : '';
    document.getElementById('bot-diff').textContent = bd > 0 ? `+${bd}` : '';
  }

  /* ═══ GAME END ═══ */
  function endGame() {
    if (chess.in_checkmate()) {
      const w = chess.turn() === 'w' ? 'Black' : 'White';
      finishGame(w === 'White' ? '1-0' : '0-1', `${w} wins by checkmate`);
    } else if (chess.in_stalemate()) finishGame('½-½', 'Stalemate');
    else if (chess.in_threefold_repetition()) finishGame('½-½', 'Threefold repetition');
    else if (chess.insufficient_material()) finishGame('½-½', 'Insufficient material');
    else if (chess.in_draw()) finishGame('½-½', 'Draw');
  }

  function finishGame(result, reason) {
    gameOver = true;
    stopTimers();
    sound('end');
    syncGround();
    document.getElementById('go-icon').textContent = result === '1-0' ? '♔' : result === '0-1' ? '♚' : '½';
    document.getElementById('go-title').textContent = result;
    document.getElementById('go-msg').textContent = reason;
    setTimeout(() => openOv('ov-gameover'), 350);
  }

  /* ═══ NEW GAME ═══ */
  function newGame() {
    chess = new Chess();
    positions = [];
    sans = [];
    viewIdx = -1;
    gameOver = false;
    aiThinking = false;

    if (mode === 'ai') {
      playerColor = 'white';
      flipped = false;
      document.getElementById('top-name').textContent = 'Stockfish';
      document.getElementById('bot-name').textContent = 'You';
    } else if (mode === 'local') {
      playerColor = 'white';
      flipped = false;
      document.getElementById('top-name').textContent = 'Black';
      document.getElementById('bot-name').textContent = 'White';
    }

    ground.set({
      fen: chess.fen(),
      orientation: flipped ? 'black' : 'white',
      turnColor: 'white',
      lastMove: undefined,
      check: false,
      movable: { color: movableColor(), dests: getDests() },
    });

    document.getElementById('moves').innerHTML = '';
    startTimers();
    updateDots();
    updateCaptures();
  }

  /* ═══ MODE SWITCHING ═══ */
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.m === m));
    document.getElementById('blk-ai').classList.toggle('hide', m !== 'ai');
    document.getElementById('blk-online').classList.toggle('hide', m !== 'online');
    document.getElementById('blk-lichess').classList.toggle('hide', m !== 'lichess');
    if (socket) { socket.disconnect(); socket = null; }
    if (lichessAbort) { lichessAbort.abort(); lichessAbort = null; }
    newGame();
  }

  /* ═══ ONLINE (OUR SERVER) ═══ */
  function connectSocket() {
    if (socket && socket.connected) return;
    socket = io();
    socket.on('game-created', ({ gameId: id, color }) => {
      gameId = id; playerColor = color;
      document.getElementById('share-code').textContent = id;
      show('ol-wait'); hide('ol-lobby');
    });
    socket.on('game-joined', ({ color, timeControl: tc, increment: inc }) => {
      playerColor = color; timeControl = tc; increment = inc;
    });
    socket.on('game-start', ({ timeControl: tc, increment: inc }) => {
      timeControl = tc; increment = inc;
      flipped = playerColor === 'black';
      chess = new Chess(); positions = []; sans = []; viewIdx = -1; gameOver = false;
      ground.set({ fen: chess.fen(), orientation: flipped ? 'black' : 'white', turnColor: 'white', movable: { color: movableColor(), dests: getDests() }, lastMove: undefined, check: false });
      document.getElementById('top-name').textContent = 'Opponent';
      document.getElementById('bot-name').textContent = 'You';
      startTimers(); updateDots();
      show('ol-lobby'); hide('ol-wait');
      toast('Game started!', 'ok');
    });
    socket.on('opponent-move', ({ move: mv, timeLeft }) => {
      const m = chess.move(mv);
      if (!m) return;
      const opp = playerColor === 'white' ? 'black' : 'white';
      if (timeLeft != null && timeControl > 0) timers[opp] = timeLeft;
      ground.move(mv.from, mv.to);
      afterMove(m);
    });
    socket.on('opponent-resigned', () => finishGame(playerColor === 'white' ? '1-0' : '0-1', 'Opponent resigned'));
    socket.on('draw-offered', () => toast('Opponent offers draw'));
    socket.on('draw-accepted', () => finishGame('½-½', 'Draw by agreement'));
    socket.on('opponent-disconnected', () => toast('Opponent disconnected', 'err'));
    socket.on('error-msg', ({ message }) => toast(message, 'err'));
  }

  function createGame() {
    mode = 'online'; connectSocket();
    socket.emit('create-game', { timeControl, increment, color: 'random' });
  }
  function joinByCode() {
    const code = document.getElementById('join-input').value.trim();
    if (!code) return toast('Enter a code', 'err');
    mode = 'online'; connectSocket();
    socket.emit('join-game', { gameId: code });
  }
  function copyCode() { navigator.clipboard.writeText(document.getElementById('share-code').textContent); toast('Copied!', 'ok'); }
  function cancelWait() { show('ol-lobby'); hide('ol-wait'); if (socket) { socket.disconnect(); socket = null; } }
  function checkUrlJoin() {
    const code = new URLSearchParams(location.search).get('game');
    if (code) { mode = 'online'; setMode('online'); connectSocket(); socket.emit('join-game', { gameId: code }); history.replaceState({}, '', '/'); }
  }

  /* ═══ LICHESS INTEGRATION ═══ */
  function lichessAuth() {
    // Generate PKCE
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    localStorage.setItem('li_verifier', verifier);
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(hash => {
      const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const params = new URLSearchParams({
        response_type: 'code', client_id: 'monarch-chess',
        redirect_uri: location.origin + '/auth/lichess',
        code_challenge_method: 'S256', code_challenge: challenge,
        scope: 'board:play'
      });
      location.href = 'https://lichess.org/oauth?' + params;
    });
  }

  function lichessSetToken() {
    const token = document.getElementById('li-token').value.trim();
    if (!token) return toast('Enter a token', 'err');
    lichessToken = token;
    localStorage.setItem('li_token', token);
    lichessCheckAuth();
  }

  function lichessCheckAuth() {
    if (!lichessToken) return;
    fetch('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${lichessToken}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(u => {
        document.getElementById('li-name').textContent = u.username;
        hide('li-noauth'); show('li-authed'); hide('li-seeking');
        toast(`Connected as ${u.username}`, 'ok');
      })
      .catch(() => { toast('Invalid token', 'err'); lichessToken = null; localStorage.removeItem('li_token'); });
  }

  function lichessDisconnect() {
    lichessToken = null;
    localStorage.removeItem('li_token');
    show('li-noauth'); hide('li-authed'); hide('li-seeking');
  }

  function lichessSeek() {
    if (!lichessToken) return;
    hide('li-authed'); show('li-seeking');
    lichessAbort = new AbortController();
    // Create a seek
    const body = new URLSearchParams({
      rated: 'false',
      time: String(Math.max(1, Math.floor(timeControl / 60))),
      increment: String(increment),
    });
    fetch('https://lichess.org/api/board/seek', {
      method: 'POST', headers: { Authorization: `Bearer ${lichessToken}` },
      body, signal: lichessAbort.signal,
    }).then(r => {
      if (!r.ok) throw new Error('Seek failed');
      return readNdJson(r.body, data => {
        if (data.type === 'gameStart' || data.gameId) {
          gameId = data.gameId || data.game?.gameId || data.id;
          lichessStreamGame(gameId);
        }
      });
    }).catch(e => {
      if (e.name !== 'AbortError') toast('Seek failed', 'err');
      show('li-authed'); hide('li-seeking');
    });

    // Also listen on event stream
    lichessStreamEvents();
  }

  function lichessStreamEvents() {
    fetch('https://lichess.org/api/stream/event', {
      headers: { Authorization: `Bearer ${lichessToken}` },
      signal: lichessAbort?.signal,
    }).then(r => readNdJson(r.body, data => {
      if (data.type === 'gameStart') {
        gameId = data.game.gameId;
        lichessStreamGame(gameId);
      }
    })).catch(() => {});
  }

  function lichessStreamGame(gid) {
    hide('li-seeking'); show('li-authed');
    toast('Game found!', 'ok');
    gameId = gid;
    chess = new Chess(); positions = []; sans = []; viewIdx = -1; gameOver = false;

    fetch(`https://lichess.org/api/board/game/stream/${gid}`, {
      headers: { Authorization: `Bearer ${lichessToken}` },
      signal: lichessAbort?.signal,
    }).then(r => readNdJson(r.body, data => {
      if (data.type === 'gameFull') {
        // Initial full game state
        playerColor = data.white?.id?.toLowerCase() === document.getElementById('li-name').textContent.toLowerCase() ? 'white' : 'black';
        flipped = playerColor === 'black';
        ground.set({ orientation: flipped ? 'black' : 'white' });
        document.getElementById('top-name').textContent = playerColor === 'white' ? (data.black?.name || 'Opponent') : (data.white?.name || 'Opponent');
        document.getElementById('bot-name').textContent = 'You';
        if (data.state) applyLichessMoves(data.state.moves);
        startTimers();
      } else if (data.type === 'gameState') {
        applyLichessMoves(data.moves);
        if (data.status !== 'started') {
          const result = data.winner === 'white' ? '1-0' : data.winner === 'black' ? '0-1' : '½-½';
          finishGame(result, data.status);
        }
      }
    })).catch(() => {});
  }

  function applyLichessMoves(movesStr) {
    if (!movesStr) return;
    const uciMoves = movesStr.trim().split(' ').filter(Boolean);
    // Reset and replay
    chess = new Chess();
    positions = []; sans = [];
    uciMoves.forEach(uci => {
      const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4] || undefined;
      const m = chess.move({ from, to, promotion: promo });
      if (m) { positions.push(chess.fen()); sans.push(m.san); }
    });
    viewIdx = -1;
    syncGround();
    renderMoves();
    updateCaptures();
    if (sans.length > 0) {
      const last = chess.history({ verbose: true }).slice(-1)[0];
      if (last) ground.set({ lastMove: [last.from, last.to] });
    }
  }

  function lichessCancelSeek() {
    if (lichessAbort) { lichessAbort.abort(); lichessAbort = null; }
    show('li-authed'); hide('li-seeking');
  }

  async function readNdJson(body, onLine) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try { onLine(JSON.parse(trimmed)); } catch {}
        }
      }
    }
  }

  /* ═══ SOUND ═══ */
  function sound(type) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dur = type === 'cap' ? 0.07 : type === 'end' ? 0.3 : 0.035;
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      const decay = dur / (type === 'cap' ? 3 : type === 'end' ? 6 : 4);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * decay));
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const filt = audioCtx.createBiquadFilter(); filt.type = 'bandpass';
      filt.frequency.value = type === 'cap' ? 1000 : type === 'chk' ? 3000 : type === 'end' ? 600 : 2200;
      filt.Q.value = 0.7;
      const gain = audioCtx.createGain();
      gain.gain.value = type === 'cap' ? 0.12 : type === 'end' ? 0.08 : 0.06;
      src.connect(filt); filt.connect(gain); gain.connect(audioCtx.destination);
      src.start();
    } catch {}
  }

  /* ═══ ACTIONS ═══ */
  function flip() {
    flipped = !flipped;
    ground.toggleOrientation();
    updateClocks(); updateDots(); updateCaptures();
  }

  function resign() {
    if (gameOver) return;
    if (!confirm('Resign?')) return;
    if (mode === 'online' && socket) socket.emit('resign', { gameId });
    if (mode === 'lichess' && lichessToken && gameId) {
      fetch(`https://lichess.org/api/board/game/${gameId}/resign`, { method: 'POST', headers: { Authorization: `Bearer ${lichessToken}` } });
    }
    const turn = chess.turn() === 'w' ? 'White' : 'Black';
    const winner = turn === 'White' ? 'Black' : 'White';
    finishGame(turn === 'White' ? '0-1' : '1-0', `${winner} wins — ${turn} resigned`);
  }

  /* ═══ UI HELPERS ═══ */
  function show(id) { document.getElementById(id).classList.remove('hide'); }
  function hide(id) { document.getElementById(id).classList.add('hide'); }
  function openOv(id) { document.getElementById(id).classList.add('open'); }
  function closeOv(id) { document.getElementById(id).classList.remove('open'); }
  function toast(msg, cls) {
    const el = document.createElement('div'); el.className = 'toast ' + (cls || '');
    el.textContent = msg; document.getElementById('toast-box').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
  }

  /* ═══ BIND UI ═══ */
  function bindUI() {
    // Mode tabs
    document.querySelectorAll('.tab').forEach(t => t.onclick = () => setMode(t.dataset.m));

    // AI slider
    document.getElementById('ai-lv').oninput = e => {
      aiLevel = +e.target.value;
      const n = ['Beginner','Casual','Intermediate','Advanced','Strong','Expert','Master','Maximum'];
      document.getElementById('diff-lbl').textContent = n[aiLevel - 1];
    };

    // Time control
    document.getElementById('tc-grid') && document.querySelectorAll('.tc').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('.tc').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      timeControl = +btn.dataset.t;
      increment = +btn.dataset.i;
    });

    // Keyboard nav
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); navBack(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navFwd(); }
    });

    // Check for stored lichess token
    const stored = localStorage.getItem('li_token');
    if (stored) { lichessToken = stored; lichessCheckAuth(); }

    // Check for lichess OAuth callback
    const params = new URLSearchParams(location.search);
    if (params.get('li_code')) {
      const code = params.get('li_code');
      const verifier = localStorage.getItem('li_verifier');
      if (verifier) {
        fetch('https://lichess.org/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code, code_verifier: verifier,
            redirect_uri: location.origin + '/auth/lichess',
            client_id: 'monarch-chess',
          }),
        }).then(r => r.json()).then(d => {
          if (d.access_token) {
            lichessToken = d.access_token;
            localStorage.setItem('li_token', d.access_token);
            localStorage.removeItem('li_verifier');
            setMode('lichess');
            lichessCheckAuth();
          }
        }).catch(() => toast('Lichess auth failed', 'err'));
      }
      history.replaceState({}, '', '/');
    }
  }

  /* ═══ BOOT ═══ */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    newGame, setMode, flip, resign, createGame, joinByCode, copyCode, cancelWait,
    navBack, navFwd, navStart, navEnd,
    lichessAuth, lichessSetToken, lichessDisconnect, lichessSeek, lichessCancelSeek,
    closeOv, pickColor(c) {
      document.querySelectorAll('.color-opt').forEach(b => b.classList.toggle('active', b.dataset.c === c));
    },
  };
})();

window.App = App;
