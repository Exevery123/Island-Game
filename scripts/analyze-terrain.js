// Measures the upper-quartile (Q3, 75th percentile) of each map stat across
// many seeds per island type. Paste the printed TERRAIN_TARGETS block into
// public/tilemap.js. Run: node scripts/analyze-terrain.js
const m = require('../public/tilemap.js');

const TYPES = ['lush', 'mountainous', 'desert', 'flooded'];
const SEEDS = 600;
const METRICS = ['land', 'plains', 'mountain', 'hill', 'forest', 'jungle',
                 'desert', 'oasis', 'lakeTiles', 'riverLen'];

function quartile(arr, q) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

const targets = {};
const t0 = Date.now();
for (const type of TYPES) {
  const cols = {};
  for (const k of METRICS) cols[k] = [];
  for (let s = 1; s <= SEEDS; s++) {
    const stats = m.mapStats(m.generateMap(s * 2654435761 % 2147483647, type));
    for (const k of METRICS) cols[k].push(stats[k]);
  }
  const q3 = {};
  for (const k of METRICS) q3[k] = quartile(cols[k], 0.75);
  targets[type] = q3;
}
const ms = Date.now() - t0;

// Pretty-print as a pasteable JS literal
let out = 'const TERRAIN_TARGETS = {\n';
for (const type of TYPES) {
  const q = targets[type];
  out += `  ${type}: { ` + METRICS.map(k => `${k}: ${q[k]}`).join(', ') + ' },\n';
}
out += '};';
console.log(out);
console.log(`\n// measured over ${SEEDS} seeds/type in ${ms}ms`);

// Also show median for context (how much Q3 exceeds typical)
console.log('\n// medians for reference:');
for (const type of TYPES) {
  const cols = {};
  for (const k of METRICS) cols[k] = [];
  for (let s = 1; s <= SEEDS; s++) {
    const stats = m.mapStats(m.generateMap(s * 2654435761 % 2147483647, type));
    for (const k of METRICS) cols[k].push(stats[k]);
  }
  const med = METRICS.map(k => `${k}: ${quartile(cols[k], 0.5)}`).join(', ');
  console.log(`//   ${type}: { ${med} }`);
}
