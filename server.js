const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use(express.json({ limit: '1mb' }));

const ISLANDS_PATH = path.join(__dirname, 'islands.json');
const PLAYER_PATH  = path.join(__dirname, 'player.json');
const GAMES_PATH   = path.join(__dirname, 'games.json');

function readIslands() {
  return JSON.parse(fs.readFileSync(ISLANDS_PATH, 'utf8'));
}
function readPlayer() {
  return JSON.parse(fs.readFileSync(PLAYER_PATH, 'utf8'));
}
function savePlayer(player) {
  fs.writeFileSync(PLAYER_PATH, JSON.stringify(player, null, 2));
}
function readGames() {
  try { return JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8')); }
  catch (e) { return []; }
}
function saveGames(games) {
  fs.writeFileSync(GAMES_PATH, JSON.stringify(games, null, 2));
}

app.get('/api/player', (req, res) => {
  res.json(readPlayer());
});

app.post('/api/player', (req, res) => {
  const { username, flag } = req.body;
  let player = {};
  try { player = readPlayer(); } catch (e) {}

  if (username !== undefined) {
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    player.username = username.trim();
  }
  if (flag !== undefined) {
    if (typeof flag !== 'string' || !flag.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'Invalid flag' });
    }
    player.flag = flag;
  }
  savePlayer(player);
  res.json(player);
});

// ---- Saved games ----
// List returns lightweight summaries (no map data) for the start screen
app.get('/api/games', (req, res) => {
  const games = readGames().map(g => ({
    id: g.id,
    username: g.username,
    flag: g.flag,
    islandType: g.islandType,
    capitalName: g.capital && g.capital.name,
    updatedAt: g.updatedAt
  }));
  games.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(games);
});

app.get('/api/games/:id', (req, res) => {
  const game = readGames().find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(game);
});

// Upsert: creates a new game if no id, otherwise updates the existing one
app.post('/api/games', (req, res) => {
  const body = req.body || {};
  const games = readGames();
  let game = body.id && games.find(g => g.id === body.id);
  if (!game) {
    game = { id: crypto.randomUUID() };
    games.push(game);
  }
  Object.assign(game, body, { id: game.id, updatedAt: Date.now() });
  saveGames(games);
  res.json({ id: game.id });
});

app.delete('/api/games/:id', (req, res) => {
  const games = readGames().filter(g => g.id !== req.params.id);
  saveGames(games);
  res.json({ ok: true });
});

app.get('/api/islands', (req, res) => {
  res.json(readIslands());
});

app.get('/api/islands/:id', (req, res) => {
  const island = readIslands().find(i => i.id === req.params.id);
  if (!island) return res.status(404).json({ error: 'Island not found' });
  res.json(island);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
