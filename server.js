const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use(express.json());

const ISLANDS_PATH = path.join(__dirname, 'islands.json');
const PLAYER_PATH  = path.join(__dirname, 'player.json');

function readIslands() {
  return JSON.parse(fs.readFileSync(ISLANDS_PATH, 'utf8'));
}
function readPlayer() {
  return JSON.parse(fs.readFileSync(PLAYER_PATH, 'utf8'));
}
function savePlayer(player) {
  fs.writeFileSync(PLAYER_PATH, JSON.stringify(player, null, 2));
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
