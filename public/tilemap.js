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
  flooded:     { land: 0.25, mountain: 0.08, green: 0.26, desert: 0.14, rivers: 7,
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

  // Exactly 15% of hills are silver: they hold uranium (not useful yet)
  const hillTiles = landTiles.filter(t => t.type === HILL);
  let nSilver = Math.round(hillTiles.length * 0.15);
  const hillPool = hillTiles.slice();
  while (nSilver-- > 0 && hillPool.length) {
    hillPool.splice(Math.floor(rand() * hillPool.length), 1)[0].silver = true;
  }

  // Flooded islands: 10% of lake tiles hold a shipwreck, and non-lake
  // OCEAN tiles inside the island spawn zone (the central area the
  // border falloff leaves free, d < 0.7) have a 4% chance of one too
  if (P.shipwrecks) {
    const lakeSet = new Set();
    lakes.forEach(l => l.forEach(i => lakeSet.add(i)));
    const zoneOcean = []; // non-lake ocean inside the island spawn zone
    for (const t of tiles) {
      if (t.type !== OCEAN || lakeSet.has(t.r * MAP_COLS + t.c)) continue;
      const nx = (t.c / (MAP_COLS - 1)) * 2 - 1;
      const ny = (t.r / (MAP_ROWS - 1)) * 2 - 1;
      if (Math.sqrt(nx * nx + ny * ny) < 0.7) zoneOcean.push(t);
    }
    for (const i of lakeSet) {
      if (rand() < 0.10) tiles[i].shipwreck = true;
    }
    for (const t of zoneOcean) {
      if (rand() < 0.04) t.shipwreck = true;
    }
    // Guarantee at least 5 shipwrecks on flooded maps
    const eligible = [...[...lakeSet].map(i => tiles[i]), ...zoneOcean];
    let have = eligible.filter(t => t.shipwreck).length;
    const without = () => eligible.filter(t => !t.shipwreck);
    while (have < 5) {
      const pool = without();
      if (!pool.length) break;
      pool[Math.floor(rand() * pool.length)].shipwreck = true;
      have++;
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
      t.color = t.silver
        ? `hsl(210, 8%, ${Math.round(70 + 5 * w)}%)`   // silver = uranium
        : `hsl(27, 52%, ${Math.round(45 + 6 * w)}%)`;
    } else if (t.type === OASIS) {
      t.color = 'hsl(150, 55%, 45%)';
    } else {
      const h = (t.elevation - mountainThreshold) / (landMax - mountainThreshold || 1);
      t.color = `hsl(220, 6%, ${Math.round(52 + 16 * h)}%)`;
    }
  }
  return { tiles, rivers, lakes };
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
  let lakes = [];
  let mode = 'tutorial'; // -> 'revealing' -> 'placing' -> 'done'
  let revealedCols = 0;
  let revealStart = 0;
  let walker = null;
  let lastTick = 0;
  let currentType = 'normal';
  let cityTile = null;      // where the capital was placed
  let cityBorder = [];      // dashed territory outline segments
  let cityTerritory = null; // tiles inside the border (buildable area)
  let validSet = null;      // tiles where the capital may be placed
  let freshSet = null;      // subset next to freshwater (green, 2 food)
  let coastSet = null;      // subset next to open sea (yellow, 1 food)
  let hoverTile = null;     // tile under the cursor while placing
  let flagColors = ['rgb(255,153,0)'];
  let selectedTile = null;  // tile whose build popup is open
  let currentSeed = null;   // seed the current map was generated from

  // Economy: tokens are a global resource, cities hold per-city stats
  let tokens = 0;
  let tokensActive = false;
  let capital = null;       // { name, level, wood, food, iron, gold, uranium }

  const CITY_NAMES = {
    lush: 'Brasilia',       // capital of Brazil
    mountainous: 'Bern',    // capital of Switzerland
    desert: 'Riyadh',       // capital of Saudi Arabia
    flooded: 'London',      // capital of Great Britain
    normal: 'Capital'
  };

  const BUILD_COST = 10;
  // What each tile type can build, and the stat it yields to the city
  function buildOptionFor(t) {
    if (t.building) return null; // one building per tile
    if (t.type === FOREST || t.type === OASIS) return { key: 'sawmill', label: 'Sawmill', stat: 'wood', amount: 1 };
    if (t.type === JUNGLE) return { key: 'sawmill', label: 'Sawmill', stat: 'wood', amount: 2 };
    if (t.type === PLAINS) return { key: 'farm', label: 'Farm', stat: 'food', amount: 1 };
    if (t.type === MOUNTAIN) return { key: 'mine', label: 'Mine', stat: 'iron', amount: 1 };
    if (t.type === HILL) return t.silver
      ? { key: 'mine', label: 'Uranium Mine', stat: 'uranium', amount: 1 }
      : { key: 'mine', label: 'Mine', stat: 'gold', amount: 1 };
    return null;
  }
  const tokensPerSecond = () => (capital ? capital.level : 0); // = total city levels

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

  const spriteFiles = {
    stand: {
      front: 'villager_front.png',
      back: 'villager_back.png',
      left: 'villager_facing_left.png',
      right: 'villager_facing_right.png'
    },
    walk: {
      front: 'villager_walking_front.png',
      back: 'villager_walking_back.png',
      left: 'villager_walking_left.png',
      right: 'villager_walking_right.png'
    }
  };
  const villagerImgs = { stand: {}, walk: {} };
  for (const pose of ['stand', 'walk']) {
    for (const dir of ['front', 'back', 'left', 'right']) {
      const img = new Image();
      img.src = 'villager/' + spriteFiles[pose][dir];
      villagerImgs[pose][dir] = img;
    }
  }

  // Terrain and building sprites (drawn on top of the colored hex)
  const loadImgs = (dir, files) => {
    const out = {};
    for (const [k, f] of Object.entries(files)) {
      const img = new Image();
      img.src = dir + f;
      out[k] = img;
    }
    return out;
  };
  const terrainImgs = loadImgs('/images/terrain/', {
    mountain: 'mountain_terrain.png',
    hill: 'hill_terrain.png',
    uraniumhill: 'uraniumhill_terrain.png',
    forest: 'forest_terrain.png',
    jungle: 'jungle_terrain.png',
    oasis: 'oasis_terrain.png',
    shipwreck: 'shipwreck_terrain.png'
  });
  const buildingImgs = loadImgs('/images/buildings/', {
    farm: 'farm_building.png',
    sawmill: 'sawmill_building.png',
    junglesawmill: 'jungle_sawmill_buliding.png',
    oasissawmill: 'oasis_sawmill_buliding.png',
    mountainmine: 'mountain_mine_building.png',
    hillmine: 'hill_mine_building.png',
    uraniumhillmine: 'uraniumhill_mine_building.png'
  });
  function terrainImageFor(t) {
    if (t.type === MOUNTAIN) return terrainImgs.mountain;
    if (t.type === HILL) return t.silver ? terrainImgs.uraniumhill : terrainImgs.hill;
    if (t.type === FOREST) return terrainImgs.forest;
    if (t.type === JUNGLE) return terrainImgs.jungle;
    if (t.type === OASIS) return terrainImgs.oasis;
    return null;
  }
  function buildingImageFor(t) {
    if (t.building === 'sawmill') {
      if (t.type === JUNGLE) return buildingImgs.junglesawmill;
      if (t.type === OASIS) return buildingImgs.oasissawmill;
      return buildingImgs.sawmill;
    }
    if (t.building === 'mine') {
      if (t.type === MOUNTAIN) return buildingImgs.mountainmine;
      return t.silver ? buildingImgs.uraniumhillmine : buildingImgs.hillmine;
    }
    return null;
  }

  // The player's flag: drawn as a banner over the capital, and its
  // dominant colors drive the territory border and name banner.
  const flagImg = new Image();
  function extractFlagColors(img) {
    try {
      const oc = document.createElement('canvas');
      oc.width = img.naturalWidth || 100;
      oc.height = img.naturalHeight || 70;
      const octx = oc.getContext('2d');
      octx.drawImage(img, 0, 0, oc.width, oc.height);
      const data = octx.getImageData(0, 0, oc.width, oc.height).data;
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // skip transparent
        const r = Math.min(255, Math.round(data[i] / 32) * 32);
        const g = Math.min(255, Math.round(data[i + 1] / 32) * 32);
        const b = Math.min(255, Math.round(data[i + 2] / 32) * 32);
        const key = r + ',' + g + ',' + b;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const cols = sorted.slice(0, 3).map(([k]) => 'rgb(' + k + ')');
      return cols.length ? cols : ['rgb(255,153,0)'];
    } catch (e) {
      return ['rgb(255,153,0)'];
    }
  }
  window.setCityFlag = function (dataUrl) {
    if (!dataUrl) return;
    flagImg.onload = () => {
      flagColors = extractFlagColors(flagImg);
      // If a capital already exists (e.g. resumed game), refresh its banner
      if (capital && banner) banner.style.background = bannerGradient(flagColors);
    };
    flagImg.src = dataUrl;
  };

  const banner = document.getElementById('city-banner');
  const cityNameEl = document.getElementById('city-name');
  const cityLevelEl = document.getElementById('city-level');
  const hudTokens = document.getElementById('hud-tokens');
  const buildPopup = document.getElementById('build-popup');
  const citySidebar = document.getElementById('city-sidebar');
  function bannerGradient(cols, dir = '90deg') {
    if (cols.length >= 3) return `linear-gradient(${dir}, ${cols[0]}, ${cols[1]}, ${cols[2]})`;
    if (cols.length === 2) return `linear-gradient(${dir}, ${cols[0]} 0 50%, ${cols[1]} 50% 100%)`;
    return cols[0];
  }
  // Double-click the banner to rename the capital (edits the name line only)
  if (cityNameEl) {
    cityNameEl.addEventListener('dblclick', () => {
      cityNameEl.contentEditable = 'true';
      cityNameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(cityNameEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    cityNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cityNameEl.blur(); }
    });
    cityNameEl.addEventListener('blur', () => {
      cityNameEl.contentEditable = 'false';
      const name = cityNameEl.textContent.trim() || CITY_NAMES[currentType] || 'Capital';
      cityNameEl.textContent = name;
      if (capital) { capital.name = name; window.dispatchEvent(new Event('game-changed')); }
    });
  }

  function updateHud() {
    if (!hudTokens) return;
    if (!tokensActive) { hudTokens.style.display = 'none'; return; }
    hudTokens.style.display = 'block';
    hudTokens.textContent = `${Math.floor(tokens)} (+${tokensPerSecond()}/s)`;
  }

  // Each resource is a row of 10 slots; filled slots show the colored icon,
  // the rest are blacked-out. Order: food, wood, iron, gold, uranium.
  const SIDEBAR_SLOTS = 10;
  const RESOURCE_ROWS = [
    { stat: 'food', icon: 'food_icon.png', label: 'Food' },
    { stat: 'wood', icon: 'wood_icon.png', label: 'Wood' },
    { stat: 'iron', icon: 'iron_icon.png', label: 'Iron' },
    { stat: 'gold', icon: 'gold_icon.png', label: 'Gold' },
    { stat: 'uranium', icon: 'uranium.png', label: 'Uranium' }
  ];

  function renderSidebar() {
    if (!citySidebar || !capital) return;
    // Outline = the banner's flag-color gradient, most prominent at the top
    const g = bannerGradient(flagColors, 'to bottom');
    if (g.startsWith('linear-gradient')) {
      citySidebar.style.borderImage = g + ' 1';
    } else {
      citySidebar.style.borderImage = 'none';
      citySidebar.style.borderColor = g;
    }
    // City name uses the same flag gradient as text fill
    const nameGrad = bannerGradient(flagColors, '90deg');
    const nameStyle = `background:${nameGrad};-webkit-background-clip:text;` +
      `background-clip:text;-webkit-text-fill-color:transparent;color:transparent;`;
    let html =
      `<h3 style="${nameStyle}">${capital.name}</h3>` +
      `<div class="stat-row">Level <b>${capital.level}</b></div>` +
      `<div class="stat-row">Tokens <b id="sb-tokens">${Math.floor(tokens)}</b>` +
      ` (+${tokensPerSecond()}/s)</div>` +
      `<div class="res-rows">`;
    for (const res of RESOURCE_ROWS) {
      const amount = capital[res.stat] || 0;
      // Each resource's 10 slots span two rows of five, under a label
      html += `<div class="res-block">`;
      html += `<div class="res-label">${res.label}</div>`;
      for (let line = 0; line < 2; line++) {
        html += `<div class="res-line">`;
        for (let j = 0; j < 5; j++) {
          const i = line * 5 + j;
          // Food shows a dashed line after `level` slots (city's food upkeep)
          if (res.stat === 'food' && i === capital.level) html += `<span class="food-divider"></span>`;
          const lit = i < amount ? ' lit' : '';
          html += `<img class="res-icon${lit}" src="/images/icons/${res.icon}" alt="" draggable="false" />`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    citySidebar.innerHTML = html;
  }

  function showBuildPopup(t) {
    selectedTile = t;
    if (citySidebar) citySidebar.style.display = 'none';
    if (!buildPopup) return;
    const opt = buildOptionFor(t);
    if (!opt) {
      const why = t.building ? `Already has a ${t.building}.` : 'Nothing can be built here.';
      buildPopup.innerHTML = `<div class="bp-title">${why}</div>`;
    } else {
      const afford = tokens >= BUILD_COST;
      buildPopup.innerHTML =
        `<div class="bp-title">${opt.label}</div>` +
        `<div class="bp-yield">+${opt.amount} ${opt.stat} · ${BUILD_COST} tokens</div>` +
        `<button class="bp-build"${afford ? '' : ' disabled'}>Build</button>`;
      const btn = buildPopup.querySelector('.bp-build');
      if (btn) btn.addEventListener('click', () => build(t, opt));
    }
    buildPopup.style.display = 'block';
  }

  function build(t, opt) {
    if (tokens < BUILD_COST || t.building) return;
    tokens -= BUILD_COST;
    t.building = opt.key;
    capital[opt.stat] += opt.amount;
    updateHud();
    showBuildPopup(t); // refresh (now shows "already built")
    requestDraw();
    window.dispatchEvent(new Event('game-changed'));
  }

  function dismissPanels() {
    selectedTile = null;
    if (buildPopup) buildPopup.style.display = 'none';
    if (citySidebar) citySidebar.style.display = 'none';
  }

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

      // Once placed or being placed the whole island stays visible; during
      // the reveal only the columns that have swept in are shown.
      const revealed = mode === 'done' || mode === 'placing' ||
        (mode === 'revealing' && t.c < revealedCols);

      hexPath(sx, sy, size);
      ctx.fillStyle = revealed ? t.color : OCEAN_BLANK;
      ctx.fill();
      // Reset the outline every tile so no feature/building stroke leaks in
      ctx.lineWidth = Math.max(0.4, size * 0.06);
      ctx.strokeStyle = 'rgba(0, 20, 40, 0.25)';
      ctx.stroke();
      if (!revealed || size <= 4) continue;

      // Hills (and their mines) sit slightly lower on the tile, like farms
      const lower = t.type === HILL ? size * 0.3 : 0;
      // Sawmills and mines replace the terrain image; farms sit on top of it
      const replacing = t.building === 'sawmill' || t.building === 'mine';
      if (replacing) {
        drawTileSprite(buildingImageFor(t), sx, sy + lower, size);
      } else {
        const timg = terrainImageFor(t);
        if (timg) drawTileSprite(timg, sx, sy + lower, size);
        // Farm sits slightly lower on the tile than terrain sprites
        if (t.building === 'farm') drawTileSprite(buildingImgs.farm, sx, sy + size * 0.3, size);
      }

      if (t.shipwreck) drawTileSprite(terrainImgs.shipwreck, sx, sy, size);

      // Highlight the tile whose build popup is open
      if (t === selectedTile) {
        hexPath(sx, sy, size);
        ctx.lineWidth = Math.max(1.2, size * 0.12);
        ctx.strokeStyle = '#ffe066';
        ctx.stroke();
        ctx.lineWidth = Math.max(0.4, size * 0.06);
        ctx.strokeStyle = 'rgba(0, 20, 40, 0.25)';
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

    const size2 = HEX_SIZE * cam.zoom;

    // Placed capital: dashed territory border, village huts, flag banner
    if (cityTile) {
      if (cityBorder.length) {
        ctx.save();
        ctx.setLineDash([size2 * 0.4, size2 * 0.3]);
        ctx.lineWidth = Math.max(1.5, size2 * 0.14);
        ctx.strokeStyle = flagColors[0];
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const [p1, p2] of cityBorder) {
          ctx.moveTo(p1.x * cam.zoom + cam.x, p1.y * cam.zoom + cam.y);
          ctx.lineTo(p2.x * cam.zoom + cam.x, p2.y * cam.zoom + cam.y);
        }
        ctx.stroke();
        ctx.restore();
      }
      const csx = cityTile.x * cam.zoom + cam.x;
      const csy = cityTile.y * cam.zoom + cam.y;
      drawVillage(csx, csy, size2, '#d0a066', '#7a4a1e');
      drawCityFlag(csx, csy, size2);
      positionBanner(csx, csy, size2);
    }

    // Ghost village that snaps to the hovered tile while placing.
    // Green = freshwater (2 food), yellow = coast (1 food), red = invalid.
    if (mode === 'placing' && hoverTile) {
      const gsx = hoverTile.x * cam.zoom + cam.x;
      const gsy = hoverTile.y * cam.zoom + cam.y;
      const kind = freshSet && freshSet.has(hoverTile) ? 'fresh'
        : (coastSet && coastSet.has(hoverTile) ? 'coast' : 'invalid');
      const fill = kind === 'fresh' ? 'rgba(40, 200, 90, 0.4)'
        : kind === 'coast' ? 'rgba(230, 200, 40, 0.4)'
        : 'rgba(220, 50, 50, 0.4)';
      const hut = kind === 'fresh' ? 'rgba(70, 170, 100, 0.75)'
        : kind === 'coast' ? 'rgba(200, 170, 50, 0.8)'
        : 'rgba(200, 70, 70, 0.75)';
      hexPath(gsx, gsy, size2);
      ctx.fillStyle = fill;
      ctx.fill();
      drawVillage(gsx, gsy, size2, hut, 'rgba(0, 0, 0, 0.55)');
    }

    // The little villager wandering the island: alternate standing and
    // walking frames while he moves for a 2-frame walk cycle
    if (mode === 'done' && walker) {
      const moving = walker.next && walker.pause <= 0;
      const pose = moving && Math.floor(performance.now() / 160) % 2 ? 'walk' : 'stand';
      const img = villagerImgs[pose][walker.facing];
      if (img.complete && img.naturalWidth) {
        const h = 2.1 * size; // about one tile tall
        const w = h * img.naturalWidth / img.naturalHeight;
        const px = walker.x * cam.zoom + cam.x;
        const py = walker.y * cam.zoom + cam.y;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, px - w / 2, py - h * 0.8, w, h);
      }
    }

    // Keep the build popup pinned above its tile as the camera moves
    if (selectedTile && buildPopup && buildPopup.style.display === 'block') {
      buildPopup.style.left = (selectedTile.x * cam.zoom + cam.x) + 'px';
      buildPopup.style.top = (selectedTile.y * cam.zoom + cam.y - size2 - 10) + 'px';
    }
  }

  // ---- Villager random walk (land only; rivers are on edges, so he
  // simply walks across them) ----
  const tileAt = (c, r) =>
    (c < 0 || c >= MAP_COLS || r < 0 || r >= MAP_ROWS) ? null : tiles[r * MAP_COLS + c];

  // ---- Capital city placement ----
  const cornerKeyAt = (px, py) => Math.round(px * 10) + ',' + Math.round(py * 10);
  function tileCornerPoints(t) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 180 * (60 * k - 30);
      pts.push({ x: t.x + HEX_SIZE * Math.cos(ang), y: t.y + HEX_SIZE * Math.sin(ang) });
    }
    return pts;
  }

  // Which land tiles may host the capital. Freshwater tiles (next to a lake,
  // river, or oasis) are best; coastal tiles (next to the open sea) are also
  // allowed but start the city with less food.
  function computeValidCity() {
    const lakeSet = new Set();
    lakes.forEach(l => l.forEach(i => lakeSet.add(i)));
    const riverEdgeKeys = new Set();
    for (const path of rivers) {
      for (let i = 0; i + 1 < path.length; i++) {
        const a = cornerKeyAt(path[i].x, path[i].y);
        const b = cornerKeyAt(path[i + 1].x, path[i + 1].y);
        riverEdgeKeys.add(a < b ? a + '|' + b : b + '|' + a);
      }
    }
    // Freshwater = an adjacent lake tile or an adjacent oasis (oases count
    // as freshwater for capital placement)
    const bordersLake = (t) => neighborOffsets(t.r).some(([dc, dr]) => {
      const n = tileAt(t.c + dc, t.r + dr);
      return n && (lakeSet.has(n.r * MAP_COLS + n.c) || n.type === OASIS);
    });
    const bordersRiver = (t) => {
      const cs = tileCornerPoints(t).map(p => cornerKeyAt(p.x, p.y));
      for (let k = 0; k < 6; k++) {
        const a = cs[k], b = cs[(k + 1) % 6];
        if (riverEdgeKeys.has(a < b ? a + '|' + b : b + '|' + a)) return true;
      }
      return false;
    };
    // Coast = adjacent to open sea (an ocean tile that isn't an inland lake)
    const bordersCoast = (t) => neighborOffsets(t.r).some(([dc, dr]) => {
      const n = tileAt(t.c + dc, t.r + dr);
      return n && n.type === OCEAN && !lakeSet.has(n.r * MAP_COLS + n.c);
    });
    freshSet = new Set();
    coastSet = new Set();
    validSet = new Set();
    for (const t of tiles) {
      if (t.type === OCEAN) continue;
      if (bordersLake(t) || bordersRiver(t)) { freshSet.add(t); validSet.add(t); }
      else if (bordersCoast(t)) { coastSet.add(t); validSet.add(t); }
    }
  }

  // Dashed outline one tile out from the city = boundary of {city + its
  // neighbors}. An edge shared by two territory tiles is interior; an
  // edge touched by only one is on the boundary.
  function buildCityBorder(city) {
    const territory = [city];
    for (const [dc, dr] of neighborOffsets(city.r)) {
      const n = tileAt(city.c + dc, city.r + dr);
      if (n) territory.push(n);
    }
    cityTerritory = new Set(territory); // buildings are limited to these tiles
    const edges = new Map();
    for (const t of territory) {
      const pts = tileCornerPoints(t);
      for (let k = 0; k < 6; k++) {
        const p1 = pts[k], p2 = pts[(k + 1) % 6];
        const ka = cornerKeyAt(p1.x, p1.y), kb = cornerKeyAt(p2.x, p2.y);
        const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const e = edges.get(key);
        if (e) e.count++; else edges.set(key, { count: 1, p1, p2 });
      }
    }
    cityBorder = [...edges.values()].filter(e => e.count === 1).map(e => [e.p1, e.p2]);
  }

  function screenToTile(sx, sy) {
    const wx = (sx - cam.x) / cam.zoom;
    const wy = (sy - cam.y) / cam.zoom;
    let best = null, bestD = Infinity;
    for (const t of tiles) {
      const d = (t.x - wx) ** 2 + (t.y - wy) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  function drawVillage(sx, sy, size, fill, stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(0.6, size * 0.05);
    const hut = (ox, oy, w) => {
      const h = w * 0.9;
      ctx.fillStyle = fill;
      ctx.fillRect(sx + ox - w / 2, sy + oy - h / 2, w, h);
      ctx.strokeRect(sx + ox - w / 2, sy + oy - h / 2, w, h);
      ctx.beginPath(); // roof
      ctx.moveTo(sx + ox - w * 0.62, sy + oy - h / 2);
      ctx.lineTo(sx + ox, sy + oy - h * 1.15);
      ctx.lineTo(sx + ox + w * 0.62, sy + oy - h / 2);
      ctx.closePath();
      ctx.fillStyle = stroke;
      ctx.fill();
    };
    hut(-size * 0.28, size * 0.18, size * 0.42);
    hut(size * 0.30, size * 0.20, size * 0.38);
    hut(0, -size * 0.05, size * 0.5);
  }

  // Draw a terrain/building sprite on a tile at 3x the hex size, sitting on
  // the tile and rising upward (so it pops out like the villager)
  function drawTileSprite(img, sx, sy, size, scale = 2) {
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = scale * size;
    const h = w * img.naturalHeight / img.naturalWidth;
    const baseY = sy + size * 0.5; // bottom of the sprite sits at the hex base
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx - w / 2, baseY - h, w, h);
  }

  function drawCityFlag(sx, sy, size) {
    if (!flagImg.complete || !flagImg.naturalWidth) return;
    // Flag drawn at half its former size
    const fw = size * 0.75;
    const fh = fw * flagImg.naturalHeight / flagImg.naturalWidth;
    const poleX = sx + size * 0.55;
    const poleTop = sy - size * 1.4;
    ctx.strokeStyle = '#5a3a1a';
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(poleX, sy);
    ctx.lineTo(poleX, poleTop);
    ctx.stroke();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(flagImg, poleX, poleTop, fw, fh);
  }

  function positionBanner(csx, csy, size) {
    if (!banner) return;
    // Sit just below the capital tile and scale with the zoom like the tiles
    banner.style.left = csx + 'px';
    banner.style.top = (csy + size * 0.275) + 'px';
    banner.style.transform = `translateX(-50%) scale(${size / 64})`;
  }

  function placeCity(tile) {
    cityTile = tile;
    currentType = window.__islandType || currentType;
    buildCityBorder(tile);
    mode = 'done';
    walker = { cur: tile, next: null, path: [], t: 0, x: tile.x, y: tile.y,
               facing: 'front', pause: 1400 };
    const name = CITY_NAMES[currentType] || 'Capital';
    // Freshwater capitals start with 2 food, coastal ones with only 1
    const startFood = freshSet && freshSet.has(tile) ? 2 : 1;
    capital = { name, level: 1, wood: 0, food: startFood, iron: 0, gold: 0, uranium: 0 };
    tokens = 25;            // starting tokens once the capital is placed
    tokensActive = true;
    if (banner) {
      if (cityNameEl) cityNameEl.textContent = name;
      if (cityLevelEl) cityLevelEl.textContent = 'Lvl ' + capital.level;
      banner.style.background = bannerGradient(flagColors);
      banner.style.display = 'block';
    }
    updateHud();
    window.dispatchEvent(new Event('city-placed'));
    requestDraw();
  }

  function startWalker() {
    const land = tiles.filter(t => t.type !== OCEAN);
    if (!land.length) return;
    const start = land[Math.floor(Math.random() * land.length)];
    walker = { cur: start, next: null, t: 0, x: start.x, y: start.y, facing: 'front', pause: 800 };
  }

  // BFS over land tiles: shortest tile path from one tile to another,
  // or null if the destination is on a separate landmass
  function findPath(from, to) {
    if (from === to) return [from];
    const prev = new Map();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const [dc, dr] of neighborOffsets(cur.r)) {
        const n = tileAt(cur.c + dc, cur.r + dr);
        if (n === null || n.type === OCEAN || seen.has(n)) continue;
        seen.add(n);
        prev.set(n, cur);
        if (n === to) {
          const path = [n];
          let p = n;
          while (prev.has(p)) { p = prev.get(p); path.push(p); }
          return path.reverse();
        }
        queue.push(n);
      }
    }
    return null;
  }

  function updateWalker(dt) {
    if (walker.pause > 0) { walker.pause -= dt; return; }
    if (!walker.next) {
      if (!walker.path || !walker.path.length) {
        // Pick a random reachable destination somewhere on the island
        const land = tiles.filter(t => t.type !== OCEAN && t !== walker.cur);
        let path = null;
        for (let tries = 0; tries < 10 && !path && land.length; tries++) {
          const dest = land[Math.floor(Math.random() * land.length)];
          path = findPath(walker.cur, dest);
          if (path && path.length < 2) path = null;
        }
        if (!path) { walker.pause = 1000; return; }
        walker.path = path.slice(1); // drop the tile he is standing on
      }
      walker.next = walker.path.shift();
      walker.t = 0;
      // Horizontal hex steps face left/right; diagonal steps face
      // front (downward) or back (upward)
      const dx = walker.next.x - walker.cur.x;
      const dy = walker.next.y - walker.cur.y;
      walker.facing = Math.abs(dy) > 5
        ? (dy > 0 ? 'front' : 'back')
        : (dx > 0 ? 'right' : 'left');
    }
    walker.t += dt / 700; // ms per step
    if (walker.t >= 1) {
      walker.cur = walker.next;
      walker.next = null;
      walker.x = walker.cur.x;
      walker.y = walker.cur.y;
      if (!walker.path.length) { // destination reached: look around
        walker.pause = 600 + Math.random() * 1500;
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
        mode = 'placing';
        computeValidCity();
        window.dispatchEvent(new Event('island-revealed'));
      }
    }
    if (mode === 'done' && walker) updateWalker(dt);
    if (tokensActive) {
      const before = Math.floor(tokens);
      tokens += tokensPerSecond() * dt / 1000;
      if (Math.floor(tokens) !== before) {
        updateHud();
        if (citySidebar && citySidebar.style.display === 'flex') {
          const el = document.getElementById('sb-tokens');
          if (el) el.textContent = Math.floor(tokens);
        }
        if (selectedTile && buildPopup && buildPopup.style.display === 'block') {
          // re-enable the Build button once the player can afford it
          const btn = buildPopup.querySelector('.bp-build');
          if (btn) btn.disabled = tokens < BUILD_COST;
        }
      }
    }
    draw();
    requestAnimationFrame(tick);
  }

  // Called by the tutorial once the player picks an island type
  window.startIsland = function (type) {
    if (tiles) return;
    currentType = type;
    window.__islandType = type;
    currentSeed = (Math.random() * 2 ** 31) | 0;
    ({ tiles, rivers, lakes } = generateMap(currentSeed, type));
    mode = 'revealing';
    revealStart = performance.now();
    revealedCols = 0;
    requestAnimationFrame(tick);
  };

  // Serialize the current game so it can be saved. Map is regenerated from
  // seed + type, so only the seed and the player's changes are stored.
  window.getGameState = function () {
    if (!capital || !cityTile) return null;
    const buildings = [];
    for (const t of tiles) if (t.building) buildings.push({ c: t.c, r: t.r, building: t.building });
    return {
      seed: currentSeed,
      islandType: currentType,
      capital: {
        c: cityTile.c, r: cityTile.r,
        name: capital.name, level: capital.level,
        wood: capital.wood, food: capital.food, iron: capital.iron,
        gold: capital.gold, uranium: capital.uranium
      },
      tokens: Math.floor(tokens),
      buildings
    };
  };

  // Load a saved game and jump straight into play (no tutorial/reveal)
  window.resumeGame = function (state) {
    if (tiles) return;
    currentType = state.islandType;
    window.__islandType = state.islandType;
    currentSeed = state.seed;
    ({ tiles, rivers, lakes } = generateMap(currentSeed, currentType));
    for (const b of state.buildings || []) {
      const t = tileAt(b.c, b.r);
      if (t) t.building = b.building;
    }
    const ct = tileAt(state.capital.c, state.capital.r);
    cityTile = ct;
    buildCityBorder(ct);
    const s = state.capital;
    capital = { name: s.name, level: s.level, wood: s.wood, food: s.food,
                iron: s.iron, gold: s.gold, uranium: s.uranium };
    tokens = state.tokens || 0;
    tokensActive = true;
    mode = 'done';
    walker = { cur: ct, next: null, path: [], t: 0, x: ct.x, y: ct.y,
               facing: 'front', pause: 1400 };
    if (banner) {
      if (cityNameEl) cityNameEl.textContent = capital.name;
      if (cityLevelEl) cityLevelEl.textContent = 'Lvl ' + capital.level;
      banner.style.background = bannerGradient(flagColors);
      banner.style.display = 'block';
    }
    updateHud();
    fitCamera();
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

  // While placing the capital, the ghost village snaps to the hovered tile
  canvas.addEventListener('mousemove', (e) => {
    if (mode !== 'placing' || !tiles) return;
    hoverTile = screenToTile(e.offsetX, e.offsetY);
    canvas.style.cursor = validSet && validSet.has(hoverTile) ? 'pointer' : 'not-allowed';
    requestDraw();
  });

  // Left-click: place the capital while placing; once placed, click tiles
  // to open build popups or the city sidebar
  canvas.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    if (mode === 'placing') {
      const t = screenToTile(e.offsetX, e.offsetY);
      if (t && validSet && validSet.has(t)) {
        canvas.style.cursor = '';
        placeCity(t);
      }
      return;
    }
    if (mode === 'done') {
      const t = screenToTile(e.offsetX, e.offsetY);
      if (!t) { dismissPanels(); return; }
      if (t === cityTile) {
        // Show the city sidebar
        if (buildPopup) buildPopup.style.display = 'none';
        selectedTile = null;
        renderSidebar();
        if (citySidebar) citySidebar.style.display = 'flex';
      } else if (t.type !== OCEAN && cityTerritory && cityTerritory.has(t)) {
        // Buildings can only go inside the city borders
        showBuildPopup(t);
      } else {
        dismissPanels(); // ocean, or outside the city borders -> dismiss
      }
      requestDraw();
    }
  });

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
