import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';
import { existsSync } from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

if (existsSync('dist')) {
  app.use(express.static('dist'));
  // SPA fallback for client-side routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.sendFile('index.html', { root: 'dist' });
  });
}
app.use(express.static('public'));

const games = new Map();
const queue = new Map(); // tc -> [socket]
const genId = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// Cleanup old games every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.created > 3600000) games.delete(id);
}, 1800000);

io.on('connection', (socket) => {

  // ── Matchmaking queue ──
  socket.on('find-game', ({ tc }) => {
    const key = tc || '5+0';
    if (!queue.has(key)) queue.set(key, []);
    const q = queue.get(key);

    // Remove if already in queue
    const idx = q.findIndex(s => s.id === socket.id);
    if (idx !== -1) q.splice(idx, 1);

    // Check for opponent
    if (q.length > 0) {
      const opponent = q.shift();
      if (!opponent.connected) { q.push(socket); return; }

      // Pair them
      const colors = Math.random() < 0.5 ? ['white', 'black'] : ['black', 'white'];
      const id = genId();
      games.set(id, {
        id, players: { [colors[0]]: opponent.id, [colors[1]]: socket.id },
        tc: key, status: 'active', created: Date.now()
      });
      opponent.join(id); opponent.gameId = id; opponent.playerColor = colors[0];
      socket.join(id); socket.gameId = id; socket.playerColor = colors[1];
      opponent.emit('game-matched', { gameId: id, color: colors[0], tc: key });
      socket.emit('game-matched', { gameId: id, color: colors[1], tc: key });
    } else {
      q.push(socket);
      socket.emit('queue-joined', { tc: key });
    }
  });

  socket.on('cancel-find', () => {
    for (const [key, q] of queue) {
      const idx = q.findIndex(s => s.id === socket.id);
      if (idx !== -1) { q.splice(idx, 1); break; }
    }
  });

  // ── Private games (play a friend) ──
  socket.on('create-game', ({ tc, color }) => {
    if (color === 'random') color = Math.random() < 0.5 ? 'white' : 'black';
    const id = genId();
    games.set(id, {
      id, players: { [color]: socket.id }, creatorColor: color,
      tc: tc || '5+0', status: 'waiting', created: Date.now()
    });
    socket.join(id); socket.gameId = id; socket.playerColor = color;
    socket.emit('game-created', { gameId: id, color });
  });

  socket.on('join-game', ({ gameId: id }) => {
    id = (id || '').toUpperCase().trim();
    const g = games.get(id);
    if (!g) return socket.emit('error-msg', { message: 'Game not found' });
    if (g.status !== 'waiting') return socket.emit('error-msg', { message: 'Already started' });
    const myColor = g.creatorColor === 'white' ? 'black' : 'white';
    g.players[myColor] = socket.id; g.status = 'active';
    socket.join(id); socket.gameId = id; socket.playerColor = myColor;
    socket.emit('game-joined', { gameId: id, color: myColor, tc: g.tc });
    io.to(id).emit('game-start', { tc: g.tc });
  });

  // ── Gameplay ──
  socket.on('move', (data) => socket.to(data.gameId).emit('opponent-move', data));
  socket.on('resign', ({ gameId }) => socket.to(gameId).emit('opponent-resigned'));
  socket.on('offer-draw', ({ gameId }) => socket.to(gameId).emit('draw-offered'));
  socket.on('accept-draw', ({ gameId }) => socket.to(gameId).emit('draw-accepted'));

  // ── Rematch ──
  socket.on('offer-rematch', ({ gameId }) => {
    const g = games.get(gameId);
    if (!g) return;
    if (!g.rematchFrom) {
      g.rematchFrom = socket.id;
      socket.to(gameId).emit('rematch-offered');
    } else if (g.rematchFrom !== socket.id) {
      // Both agreed — create new game with swapped colors
      const oldWhiteId = g.players.white;
      const oldBlackId = g.players.black;
      const newId = genId();
      const newGame = {
        id: newId,
        players: { white: oldBlackId, black: oldWhiteId },
        tc: g.tc, status: 'active', created: Date.now()
      };
      games.set(newId, newGame);
      // Move both sockets to new room
      const sockets = io.sockets.sockets;
      for (const [color, playerId] of Object.entries(newGame.players)) {
        const s = sockets.get(playerId);
        if (s) {
          s.leave(gameId);
          s.join(newId);
          s.gameId = newId;
          s.playerColor = color;
          s.emit('rematch-start', { gameId: newId, color, tc: g.tc });
        }
      }
    }
  });

  socket.on('cancel-rematch', ({ gameId }) => {
    const g = games.get(gameId);
    if (g) { delete g.rematchFrom; socket.to(gameId).emit('rematch-cancelled'); }
  });

  socket.on('decline-rematch', ({ gameId }) => {
    const g = games.get(gameId);
    if (g) { delete g.rematchFrom; socket.to(gameId).emit('rematch-declined'); }
  });

  socket.on('disconnect', () => {
    // Remove from queue
    for (const [key, q] of queue) {
      const idx = q.findIndex(s => s.id === socket.id);
      if (idx !== -1) { q.splice(idx, 1); break; }
    }
    // Handle active game
    if (socket.gameId) {
      const g = games.get(socket.gameId);
      if (g?.status === 'active') socket.to(socket.gameId).emit('opponent-disconnected');
      if (g?.status === 'waiting') games.delete(socket.gameId);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`  ♟ chessr server → http://localhost:${PORT}`));
