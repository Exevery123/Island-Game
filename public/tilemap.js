// Hex tilemap: ocean with a simplex-noise island in the center.
// ~25% of tiles are land, ~15% of land tiles are mountains (set by percentile
// thresholds on the heightmap, so the ratios hold for any seed).

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeSimplex(rand) {
  const grad = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  return function noise2D(xin, yin) {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g = grad[perm[ii + perm[jj]] % 8];
      t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g = grad[perm[ii + i1 + perm[jj + j1]] % 8];
      t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g = grad[perm[ii + 1 + perm[jj + 1]] % 8];
      t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2); // roughly [-1, 1]
  };
}

function fbm(noise2D, x, y) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * noise2D(x * freq, y * freq);
    norm += amp;
    amp *= 0.45;
    freq *= 2;
  }
  return (sum / norm + 1) / 2; // 0..1
}

const MAP_COLS = 25;
const MAP_ROWS = 25;
const HEX_SIZE = 10;                       // hex radius in world units
const HEX_W = Math.sqrt(3) * HEX_SIZE;     // pointy-top spacing
const HEX_H = 1.5 * HEX_SIZE;

const OCEAN = 0, PLAINS = 1, MOUNTAIN = 2, JUNGLE = 3, FOREST = 4, DESERT = 5,
      HILL = 6, OASIS = 7;
const LAND = PLAINS; // legacy alias

// Fractions per island type: land (of all tiles), mountain/green/desert
// (of land tiles). Extra flags add type-specific features.
const ISLAND_TYPES = {
  normal:      { land: 0.25, mountain: 0.15, green: 0.20, desert: 0.20, rivers: 3 },
  lush:        { land: 0.25, mountain: 0.12, green: 0.40, desert: 0.04, rivers: 3 },
  mountainous: { land: 0.33, mountain: 0.25, green: 0.12, desert: 0.12, rivers: 3 },
  desert:      { land: 0.25, mountain: 0.15, green: 0.04, desert: 0.50, rivers: 3,
                 extraHills: true, oasis: true },
  flooded:     { land: 0.25, mountain: 0.08, green: 0.26, desert: 0.14, rivers: 5,
                 floodLakes: true, shipwrecks: true }
};

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Hex neighbor offsets for odd-r offset coordinates (pointy-top)
const neighborOffsets = (r) => (r & 1)
  ? [[-1, 0], [1, 0], [0, -1], [1, -1], [0, 1], [1, 1]]
  : [[-1, 0], [1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];

// Flood-fill water from the map border: reachable water is the outer
// ocean, unreachable water components are inland lakes.
function findLakes(tiles) {
  const outer = new Set();
  const queue = [];
  for (let i = 0; i < tiles.length; i++) {
    const r = Math.floor(i / MAP_COLS), c = i % MAP_COLS;
    const onBorder = r === 0 || r === MAP_ROWS - 1 || c === 0 || c === MAP_COLS - 1;
    if (onBorder && tiles[i].type === OCEAN) { outer.add(i); queue.push(i); }
  }
  while (queue.length) {
    const i = queue.pop();
    const r = Math.floor(i / MAP_COLS), c = i % MAP_COLS;
    for (const [dc, dr] of neighborOffsets(r)) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
      const ni = nr * MAP_COLS + nc;
      if (!outer.has(ni) && tiles[ni].type === OCEAN) { outer.add(ni); queue.push(ni); }
    }
  }
  const lakes = [];
  const seen = new Set();
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].type !== OCEAN || outer.has(i) || seen.has(i)) continue;
    const comp = [];
    const q = [i];
    seen.add(i);
    while (q.length) {
      const j = q.pop();
      comp.push(j);
      const r = Math.floor(j / MAP_COLS), c = j % MAP_COLS;
      for (const [dc, dr] of neighborOffsets(r)) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
        const nj = nr * MAP_COLS + nc;
        if (!seen.has(nj) && tiles[nj].type === OCEAN && !outer.has(nj)) {
          seen.add(nj); q.push(nj);
        }
      }
    }
    lakes.push(comp);
  }
  return { outer, lakes };
}

// Graph of hex corners joined by hex edges. Rivers travel on this graph,
// and only along edges that have land on both sides.
function buildCornerGraph(tiles) {
  const corners = new Map(); // key -> { key, x, y, tiles: [tileIdx] }
  const edges = new Map();   // "a|b" -> { a, b, tiles: [tileIdx] }
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const keys = [];
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 180 * (60 * k - 30);
      const px = t.x + HEX_SIZE * Math.cos(ang);
      const py = t.y + HEX_SIZE * Math.sin(ang);
      const key = Math.round(px * 10) + ',' + Math.round(py * 10);
      let cn = corners.get(key);
      if (!cn) { cn = { key, x: px, y: py, tiles: [] }; corners.set(key, cn); }
      cn.tiles.push(i);
      keys.push(key);
    }
    for (let k = 0; k < 6; k++) {
      const a = keys[k], b = keys[(k + 1) % 6];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      let e = edges.get(ek);
      if (!e) { e = { a, b, tiles: [] }; edges.set(ek, e); }
      e.tiles.push(i);
    }
  }
  const adj = new Map();
  for (const [ek, e] of edges) {
    if (e.tiles.length !== 2) continue;
    if (e.tiles.some(i => tiles[i].type === OCEAN)) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ to: e.b, ek });
    adj.get(e.b).push({ to: e.a, ek });
  }
  return { corners, edges, adj };
}

// Dijkstra with randomized edge weights: guaranteed-connected path from
// start to any target corner, but winding because weights are random.
function riverPath(startKey, targets, adj, rand) {
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const weights = new Map();
  for (;;) {
    let cur = null, best = Infinity;
    for (const [k, d] of dist) {
      if (!done.has(k) && d < best) { best = d; cur = k; }
    }
    if (cur === null) return null; // no route to any target
    if (targets.has(cur)) {
      const path = [cur];
      while (prev.has(cur)) { cur = prev.get(cur); path.push(cur); }
      return path.reverse();
    }
    done.add(cur);
    for (const { to, ek } of adj.get(cur) || []) {
      if (done.has(to)) continue;
      let w = weights.get(ek);
      if (w === undefined) { w = 1 + 3 * rand(); weights.set(ek, w); }
      const nd = best + w;
      if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
        dist.set(to, nd);
        prev.set(to, cur);
      }
    }
  }
}

// Connectivity test: every consecutive pair of river corners must be a
// real hex edge, so the river is one unbroken flow.
function isConnectedRiver(pathKeys, edges) {
  if (!pathKeys || pathKeys.length < 2) return false;
  for (let i = 0; i + 1 < pathKeys.length; i++) {
    const a = pathKeys[i], b = pathKeys[i + 1];
    const ek = a < b ? a + '|' + b : b + '|' + a;
    if (!edges.has(ek)) return false;
  }
  return true;
}

function generateMap(seed, islandType) {
  const P = ISLAND_TYPES[islandType] || ISLAND_TYPES.normal;
  const rand = mulberry32(seed);
  const noise2D = makeSimplex(rand);
  // Random rotation + stretch so islands can be elongated in any direction
  const angle = rand() * Math.PI * 2;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const stretch = 0.65 + rand() * 0.85;
  // Independent noise field for wetness (its own permutation table)
  const wetNoise = makeSimplex(rand);
  const tiles = [];

  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const x = HEX_W * (c + 0.5 * (r & 1));
      const y = HEX_H * r;
      const nx = (c / (MAP_COLS - 1)) * 2 - 1;
      const ny = (r / (MAP_ROWS - 1)) * 2 - 1;

      const rx = (nx * cosA - ny * sinA) * stretch * 3.0;
      const ry = (nx * sinA + ny * cosA) / stretch * 3.0;

      // Domain warp: offset the sample point by low-frequency noise, which
      // bends the whole landmass into crescents, lobes and chains while
      // keeping it coherent (the warp varies slowly across the map)
      const qx = fbm(noise2D, rx * 0.4 + 5.2, ry * 0.4 + 1.3) - 0.5;
      const qy = fbm(noise2D, rx * 0.4 - 3.1, ry * 0.4 + 8.7) - 0.5;
      const base = fbm(noise2D, rx + 3.2 * qx, ry + 3.2 * qy);

      // Only the map border is forced down; the interior shape is free.
      // The free zone (d < 0.7) is much larger than the 25% land budget,
      // so the landmass has room to take on varied shapes within it.
      const d = Math.sqrt(nx * nx + ny * ny);
      const elevation = base - 1.6 * smoothstep(0.7, 1.0, d);

      // Wetness: high-frequency warped noise, deliberately unsmoothed so
      // it stays super chaotic while fbm keeps it locally recognizable
      const wqx = fbm(wetNoise, nx * 0.9 + 11.3, ny * 0.9 - 7.1) - 0.5;
      const wqy = fbm(wetNoise, nx * 0.9 - 4.7, ny * 0.9 + 6.9) - 0.5;
      const wetness = fbm(wetNoise, nx * 1.2 + 0.8 * wqx, ny * 1.2 + 0.8 * wqy);

      tiles.push({ x, y, c, r, elevation, wetness, type: OCEAN });
    }
  }

  // Smooth the heightmap with hex-neighbor averaging: removes single-tile
  // speckle so the island is coherent, while the warped large-scale shape
  // (and the exact land/mountain ratios, applied after) are preserved.
  for (let pass = 0; pass < 2; pass++) {
    const prev = tiles.map(t => t.elevation);
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        let sum = 0, count = 0;
        for (const [dc, dr] of neighborOffsets(r)) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
          sum += prev[nr * MAP_COLS + nc];
          count++;
        }
        const idx = r * MAP_COLS + c;
        tiles[idx].elevation = 0.5 * prev[idx] + 0.5 * (sum / count);
      }
    }
  }

  // Land threshold percentile -> P.land fraction of tiles becomes land.
  const sorted = tiles.map(t => t.elevation).sort((a, b) => a - b);
  const landThreshold = sorted[Math.floor(sorted.length * (1 - P.land))];
  const landTiles = tiles.filter(t => t.elevation >= landThreshold);
  landTiles.forEach(t => { t.type = LAND; });

  // Mountain threshold = top P.mountain fraction of land elevations.
  const landSorted = landTiles.map(t => t.elevation).sort((a, b) => a - b);
  const mountainThreshold = landSorted[Math.floor(landSorted.length * (1 - P.mountain))];
  landTiles.forEach(t => { if (t.elevation >= mountainThreshold) t.type = MOUNTAIN; });

  // Dry mountains are hills: split at the median wetness of all land, so
  // hills end up on the dry side of the map, near the deserts
  const wetLand = landTiles.map(t => t.wetness).sort((a, b) => a - b);
  const medianWet = wetLand[Math.floor(wetLand.length / 2)];
  landTiles.forEach(t => {
    if (t.type === MOUNTAIN && t.wetness < medianWet) t.type = HILL;
  });

  // Biomes by wetness rank: driest 20% of land -> desert, wettest 20% ->
  // forest, with the wetter half of those being jungle. Counts are taken
  // as fractions of ALL land, assigned from the non-mountain tiles.
  const vegTiles = landTiles
    .filter(t => t.type === PLAINS)
    .sort((a, b) => a.wetness - b.wetness);
  const nDesert = Math.round(P.desert * landTiles.length);
  const nGreen = Math.round(P.green * landTiles.length);
  const nJungle = Math.round(nGreen / 2);
  vegTiles.slice(0, nDesert).forEach(t => { t.type = DESERT; });
  const green = vegTiles.slice(vegTiles.length - nGreen);
  green.forEach((t, i) => {
    t.type = i >= green.length - nJungle ? JUNGLE : FOREST;
  });

  // Never let a forest/jungle touch a desert: offenders are relocated to
  // the wettest plains tile that has no desert neighbor, keeping counts
  const at = (c, r) =>
    (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) ? null : tiles[r * MAP_COLS + c];
  const touchesDesert = (t) => neighborOffsets(t.r).some(([dc, dr]) => {
    const n = at(t.c + dc, t.r + dr);
    return n !== null && n.type === DESERT;
  });
  const offenders = landTiles.filter(
    t => (t.type === JUNGLE || t.type === FOREST) && touchesDesert(t));
  if (offenders.length) {
    const spots = landTiles
      .filter(t => t.type === PLAINS && !touchesDesert(t))
      .sort((a, b) => b.wetness - a.wetness);
    for (const g of offenders) {
      const spot = spots.shift();
      if (spot) spot.type = g.type;
      g.type = PLAINS;
    }
  }

  // ---- Lakes & rivers ----
  // No natural lakes: sink one fully-inland tile into water
  const digLake = () => {
    const inland = landTiles.filter(t =>
      t.type !== MOUNTAIN && t.type !== HILL && t.type !== OCEAN &&
      neighborOffsets(t.r).every(([dc, dr]) => {
        const n = at(t.c + dc, t.r + dr);
        return n !== null && n.type !== OCEAN;
      }));
    if (inland.length) {
      inland[Math.floor(rand() * inland.length)].type = OCEAN;
    }
  };

  let { outer, lakes } = findLakes(tiles);
  if (lakes.length === 0) {
    digLake();
    ({ outer, lakes } = findLakes(tiles));
  }

  // Flooded islands: grow every lake by one ring of water
  if (P.floodLakes && lakes.length) {
    const ring = new Set();
    for (const lake of lakes) {
      for (const i of lake) {
        const r = Math.floor(i / MAP_COLS), c = i % MAP_COLS;
        for (const [dc, dr] of neighborOffsets(r)) {
          const n = at(c + dc, r + dr);
          if (n !== null && n.type !== OCEAN) ring.add(n);
        }
      }
    }
    ring.forEach(t => { t.type = OCEAN; });
    ({ outer, lakes } = findLakes(tiles));
    if (lakes.length === 0) { // flooding merged every lake into the sea
      digLake();
      ({ outer, lakes } = findLakes(tiles));
    }
  }

  // Desert islands: oases can appear on desert tiles beside lakes (20%
  // chance each), plus a few extra hills scattered in the desert
  if (P.oasis && lakes.length) {
    const lakeSet = new Set();
    lakes.forEach(l => l.forEach(i => lakeSet.add(i)));
    for (const t of landTiles) {
      if (t.type !== DESERT) continue;
      const byLake = neighborOffsets(t.r).some(([dc, dr]) => {
        const n = at(t.c + dc, t.r + dr);
        return n !== null && lakeSet.has(n.r * MAP_COLS + n.c);
      });
      if (byLake && rand() < 0.20) t.type = OASIS;
    }
  }
  if (P.extraHills) {
    const desertTiles = landTiles.filter(t => t.type === DESERT);
    let nExtra = Math.min(desertTiles.length, 4 + Math.floor(rand() * 4));
    while (nExtra-- > 0 && desertTiles.length) {
      const i = Math.floor(rand() * desertTiles.length);
      desertTiles.splice(i, 1)[0].type = HILL;
    }
  }

  // Flooded islands: 10% of lake tiles hold a shipwreck
  if (P.shipwrecks) {
    for (const lake of lakes) {
      for (const i of lake) if (rand() < 0.10) tiles[i].shipwreck = true;
    }
  }

  const rivers = [];
  if (lakes.length) {
    const { corners, edges, adj } = buildCornerGraph(tiles);
    const coastCorners = [...corners.values()].filter(cn =>
      cn.tiles.some(i => outer.has(i)) && (adj.get(cn.key) || []).length > 0);
    for (let n = 0; n < P.rivers; n++) {
      let pathKeys = null;
      for (let attempt = 0; attempt < 10 && !pathKeys && coastCorners.length; attempt++) {
        const start = coastCorners[Math.floor(rand() * coastCorners.length)];
        const lake = lakes[Math.floor(rand() * lakes.length)];
        const lakeSet = new Set(lake);
        const targets = new Set();
        for (const cn of corners.values()) {
          if (cn.tiles.some(i => lakeSet.has(i))) targets.add(cn.key);
        }
        pathKeys = riverPath(start.key, targets, adj, rand);
        // Reject any path that fails the edge-connectivity test
        if (pathKeys && !isConnectedRiver(pathKeys, edges)) pathKeys = null;
      }
      if (pathKeys) {
        rivers.push(pathKeys.map(k => ({ x: corners.get(k).x, y: corners.get(k).y })));
      }
    }
  }

  // Precompute fill colors, shaded within each class
  const minE = sorted[0];
  const landMax = landSorted[landSorted.length - 1];
  for (const t of tiles) {
    const w = t.wetness - 0.5;
    if (t.type === OCEAN) {
      const depth = Math.min(1, Math.max(0, (t.elevation - minE) / (landThreshold - minE || 1)));
      t.color = `hsl(207, 65%, ${Math.round(20 + 16 * depth)}%)`;
    } else if (t.type === PLAINS) {
      t.color = `hsl(85, 45%, ${Math.round(52 - 8 * w)}%)`;
    } else if (t.type === JUNGLE) {
      t.color = `hsl(150, 60%, ${Math.round(24 - 6 * w)}%)`;
    } else if (t.type === FOREST) {
      t.color = `hsl(125, 45%, ${Math.round(33 - 6 * w)}%)`;
    } else if (t.type === DESERT) {
      t.color = `hsl(45, 60%, ${Math.round(66 + 10 * w)}%)`;
    } else if (t.type === HILL) {
      t.color = `hsl(27, 52%, ${Math.round(45 + 6 * w)}%)`;
    } else if (t.type === OASIS) {
      t.color = 'hsl(150, 55%, 45%)';
    } else {
      const h = (t.elevation - mountainThreshold) / (landMax - mountainThreshold || 1);
      t.color = `hsl(220, 6%, ${Math.round(52 + 16 * h)}%)`;
    }
  }
  return { tiles, rivers };
}

const REVEAL_MS_PER_COL = 250; // island appears one column every 0.25s

function initTilemap() {
  if (window.__tilemapReady) return;
  window.__tilemapReady = true;

  const canvas = document.getElementById('tilemap-canvas');
  const ctx = canvas.getContext('2d');

  // Nothing is generated until an island type is chosen: the screen
  // starts as blank ocean while the villager runs the tutorial.
  let tiles = null;
  let rivers = [];
  let mode = 'tutorial'; // -> 'revealing' -> 'done'
  let revealedCols = 0;
  let revealStart = 0;
  let walker = null;
  let lastTick = 0;

  const OCEAN_BLANK = 'hsl(207, 65%, 26%)';
  const placeholder = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      placeholder.push({
        x: HEX_W * (c + 0.5 * (r & 1)),
        y: HEX_H * r,
        c, r, type: OCEAN, color: OCEAN_BLANK
      });
    }
  }

  const villagerImgs = {
    front: new Image(),
    left: new Image(),
    right: new Image()
  };
  villagerImgs.front.src = 'villager/villager_front.png';
  villagerImgs.left.src = 'villager/villager_facing_left.png';
  villagerImgs.right.src = 'villager/villager_facing_right.png';

  const mapW = HEX_W * (MAP_COLS + 0.5);
  const mapH = HEX_H * (MAP_ROWS - 1) + 2 * HEX_SIZE;
  const cam = { x: 0, y: 0, zoom: 1 };

  function fitCamera() {
    cam.zoom = Math.min(canvas.width / mapW, canvas.height / mapH) * 0.95;
    cam.x = (canvas.width - mapW * cam.zoom) / 2;
    cam.y = (canvas.height - mapH * cam.zoom) / 2 + HEX_SIZE * cam.zoom;
  }

  function hexPath(cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 180 * (60 * i - 30); // pointy-top
      const px = cx + size * Math.cos(angle);
      const py = cy + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function draw() {
    ctx.fillStyle = '#0d3a5c'; // deep ocean backdrop
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const size = HEX_SIZE * cam.zoom;
    const margin = size * 2;
    ctx.lineWidth = Math.max(0.4, size * 0.06);
    ctx.strokeStyle = 'rgba(0, 20, 40, 0.25)';

    const list = tiles || placeholder;
    for (const t of list) {
      const sx = t.x * cam.zoom + cam.x;
      const sy = t.y * cam.zoom + cam.y;
      if (sx < -margin || sx > canvas.width + margin ||
          sy < -margin || sy > canvas.height + margin) continue;

      const revealed = mode === 'done' ||
        (mode === 'revealing' && t.c < revealedCols);

      hexPath(sx, sy, size);
      ctx.fillStyle = revealed ? t.color : OCEAN_BLANK;
      ctx.fill();
      ctx.stroke();
      if (!revealed || size <= 4) continue;

      if (t.type === MOUNTAIN) {
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.45, sy + size * 0.32);
        ctx.lineTo(sx, sy - size * 0.42);
        ctx.lineTo(sx + size * 0.45, sy + size * 0.32);
        ctx.closePath();
        ctx.fillStyle = '#565b63';
        ctx.fill();
        // snow cap
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.14, sy - size * 0.19);
        ctx.lineTo(sx, sy - size * 0.42);
        ctx.lineTo(sx + size * 0.14, sy - size * 0.19);
        ctx.closePath();
        ctx.fillStyle = '#e8ecf2';
        ctx.fill();
      } else if (t.type === HILL) {
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.45, sy + size * 0.28);
        ctx.quadraticCurveTo(sx, sy - size * 0.42, sx + size * 0.45, sy + size * 0.28);
        ctx.closePath();
        ctx.fillStyle = '#8a5424';
        ctx.fill();
      } else if (t.type === OASIS) {
        // little pond in the middle
        ctx.beginPath();
        ctx.ellipse(sx, sy + size * 0.08, size * 0.34, size * 0.22, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#2f86c9';
        ctx.fill();
      }

      if (t.shipwreck) {
        // sunken hull with a broken mast
        ctx.fillStyle = '#6b4226';
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.42, sy - size * 0.05);
        ctx.lineTo(sx + size * 0.42, sy - size * 0.05);
        ctx.lineTo(sx + size * 0.22, sy + size * 0.28);
        ctx.lineTo(sx - size * 0.22, sy + size * 0.28);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(sx - size * 0.04, sy - size * 0.5, size * 0.08, size * 0.45);
      }
    }

    // Rivers run along hex edges; during the reveal they are clipped to
    // the columns that have already appeared
    if (mode !== 'tutorial' && rivers.length) {
      ctx.save();
      if (mode === 'revealing') {
        const clipX = HEX_W * (revealedCols - 0.5) * cam.zoom + cam.x;
        ctx.beginPath();
        ctx.rect(-100000, -100000, 100000 + clipX, 200000);
        ctx.clip();
      }
      ctx.lineWidth = Math.max(1.2, size * 0.22);
      ctx.strokeStyle = '#3d8fc9';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const path of rivers) {
        ctx.beginPath();
        for (let i = 0; i < path.length; i++) {
          const px = path[i].x * cam.zoom + cam.x;
          const py = path[i].y * cam.zoom + cam.y;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // The little villager wandering the island
    if (mode === 'done' && walker) {
      const img = villagerImgs[walker.facing];
      if (img.complete && img.naturalWidth) {
        const h = 2.1 * size; // about one tile tall
        const w = h * img.naturalWidth / img.naturalHeight;
        const px = walker.x * cam.zoom + cam.x;
        const py = walker.y * cam.zoom + cam.y;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, px - w / 2, py - h * 0.8, w, h);
      }
    }
  }

  // ---- Villager random walk (land only; rivers are on edges, so he
  // simply walks across them) ----
  const tileAt = (c, r) =>
    (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) ? null : tiles[r * MAP_COLS + c];

  function startWalker() {
    const land = tiles.filter(t => t.type !== OCEAN);
    if (!land.length) return;
    const start = land[Math.floor(Math.random() * land.length)];
    walker = { cur: start, next: null, t: 0, x: start.x, y: start.y, facing: 'front', pause: 800 };
  }

  function updateWalker(dt) {
    if (walker.pause > 0) { walker.pause -= dt; return; }
    if (!walker.next) {
      const options = neighborOffsets(walker.cur.r)
        .map(([dc, dr]) => tileAt(walker.cur.c + dc, walker.cur.r + dr))
        .filter(t => t !== null && t.type !== OCEAN);
      if (!options.length) { walker.pause = 1000; return; }
      walker.next = options[Math.floor(Math.random() * options.length)];
      walker.t = 0;
      const dx = walker.next.x - walker.cur.x;
      walker.facing = dx > 1 ? 'right' : dx < -1 ? 'left' : 'front';
    }
    walker.t += dt / 700; // ms per step
    if (walker.t >= 1) {
      walker.cur = walker.next;
      walker.next = null;
      walker.x = walker.cur.x;
      walker.y = walker.cur.y;
      if (Math.random() < 0.25) { // sometimes stop and look around
        walker.pause = 400 + Math.random() * 1200;
        walker.facing = 'front';
      }
    } else {
      walker.x = walker.cur.x + (walker.next.x - walker.cur.x) * walker.t;
      walker.y = walker.cur.y + (walker.next.y - walker.cur.y) * walker.t;
    }
  }

  function tick(now) {
    const dt = lastTick ? now - lastTick : 16;
    lastTick = now;
    if (mode === 'revealing') {
      revealedCols = (now - revealStart) / REVEAL_MS_PER_COL;
      if (revealedCols >= MAP_COLS + 1) {
        mode = 'done';
        startWalker();
        window.dispatchEvent(new Event('island-revealed'));
      }
    }
    if (mode === 'done' && walker) updateWalker(dt);
    draw();
    requestAnimationFrame(tick);
  }

  // Called by the tutorial once the player picks an island type
  window.startIsland = function (type) {
    if (tiles) return;
    ({ tiles, rivers } = generateMap((Math.random() * 2 ** 31) | 0, type));
    mode = 'revealing';
    revealStart = performance.now();
    revealedCols = 0;
    requestAnimationFrame(tick);
  };

  let rafPending = false;
  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }

  function resize() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    requestDraw();
  }

  // Zoom with the scroll wheel, keeping the point under the cursor fixed
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.min(6, Math.max(0.2, cam.zoom * factor));
    cam.x = e.offsetX - (e.offsetX - cam.x) * (newZoom / cam.zoom);
    cam.y = e.offsetY - (e.offsetY - cam.y) * (newZoom / cam.zoom);
    cam.zoom = newZoom;
    window.dispatchEvent(new Event('tilemap-zoom'));
    requestDraw();
  }, { passive: false });

  // Pan with middle-click drag
  let panning = false;
  let lastMouse = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault(); // stop browser autoscroll
      panning = true;
      lastMouse = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    cam.x += e.clientX - lastMouse.x;
    cam.y += e.clientY - lastMouse.y;
    lastMouse = { x: e.clientX, y: e.clientY };
    window.dispatchEvent(new Event('tilemap-pan'));
    requestDraw();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 1) {
      panning = false;
      canvas.style.cursor = '';
    }
  });

  window.addEventListener('resize', resize);
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  fitCamera();
  draw();
}

if (typeof window !== 'undefined') {
  window.initTilemap = initTilemap;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateMap, MAP_COLS, MAP_ROWS, ISLAND_TYPES,
    OCEAN, PLAINS, LAND, MOUNTAIN, JUNGLE, FOREST, DESERT, HILL, OASIS
  };
}
