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
const LAND_FRACTION = 0.25;
const MOUNTAIN_FRACTION = 0.15;

const OCEAN = 0, PLAINS = 1, MOUNTAIN = 2, JUNGLE = 3, FOREST = 4, DESERT = 5, HILL = 6;
const LAND = PLAINS; // legacy alias
const GREEN_FRACTION = 0.20;   // of land: jungles + forests
const DESERT_FRACTION = 0.20;  // of land

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function generateMap(seed) {
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
  const neighborOffsets = (r) => (r & 1)
    ? [[-1, 0], [1, 0], [0, -1], [1, -1], [0, 1], [1, 1]]
    : [[-1, 0], [1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
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

  // Land threshold = 75th percentile of all elevations -> 25% land.
  const sorted = tiles.map(t => t.elevation).sort((a, b) => a - b);
  const landThreshold = sorted[Math.floor(sorted.length * (1 - LAND_FRACTION))];
  const landTiles = tiles.filter(t => t.elevation >= landThreshold);
  landTiles.forEach(t => { t.type = LAND; });

  // Mountain threshold = top 15% of land elevations.
  const landSorted = landTiles.map(t => t.elevation).sort((a, b) => a - b);
  const mountainThreshold = landSorted[Math.floor(landSorted.length * (1 - MOUNTAIN_FRACTION))];
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
  const nDesert = Math.round(DESERT_FRACTION * landTiles.length);
  const nGreen = Math.round(GREEN_FRACTION * landTiles.length);
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

  // Precompute fill colors, shaded within each class
  const minE = sorted[0];
  const landMax = landSorted[landSorted.length - 1];
  for (const t of tiles) {
    const w = t.wetness - 0.5;
    if (t.type === OCEAN) {
      const depth = (t.elevation - minE) / (landThreshold - minE || 1);
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
    } else {
      const h = (t.elevation - mountainThreshold) / (landMax - mountainThreshold || 1);
      t.color = `hsl(220, 6%, ${Math.round(52 + 16 * h)}%)`;
    }
  }
  return tiles;
}

function initTilemap() {
  if (window.__tilemapReady) return;
  window.__tilemapReady = true;

  const canvas = document.getElementById('tilemap-canvas');
  const ctx = canvas.getContext('2d');
  const tiles = generateMap((Math.random() * 2 ** 31) | 0);

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

    for (const t of tiles) {
      const sx = t.x * cam.zoom + cam.x;
      const sy = t.y * cam.zoom + cam.y;
      if (sx < -margin || sx > canvas.width + margin ||
          sy < -margin || sy > canvas.height + margin) continue;

      hexPath(sx, sy, size);
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.stroke();

      if (t.type === MOUNTAIN && size > 4) {
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
      }

      if (t.type === HILL && size > 4) {
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.45, sy + size * 0.28);
        ctx.quadraticCurveTo(sx, sy - size * 0.42, sx + size * 0.45, sy + size * 0.28);
        ctx.closePath();
        ctx.fillStyle = '#8a5424';
        ctx.fill();
      }
    }
  }

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
    generateMap, MAP_COLS, MAP_ROWS,
    OCEAN, PLAINS, LAND, MOUNTAIN, JUNGLE, FOREST, DESERT, HILL
  };
}
