// Probe: the feeding test's routine over many seeds, four at a time. Prints how
// many runs fed and how often the fish turned on the spot within 2 cm of food.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dist = process.env.DIST ?? '../dist';
const { World } = await import(`${dist}/sim/world.js`);
const { quatRotateInv, v3, sub, normalize } = await import(`${dist}/sim/math.js`);

function runSeed(seed) {
  const w = new World({ seed, timeScale: 1 });
  w.brain.drives.hunger = 0.9;
  const before = w.brain.drives.hunger;
  const dt = 1 / 60;
  const tmp = v3(), loc = v3();
  const s = { close: 0, pivot: 0, dy: [], horiz: [], minD: Infinity, strikes: 0, eaten: 0, firstEat: -1, t: 0 };
  const step = () => {
    w.step(dt); s.t += dt;
    const b = w.brain, L = w.locomotion, f = b.percepts.nearestFood;
    if (b.atePelletThisTick) { s.eaten++; if (s.firstEat < 0) s.firstEat = s.t; }
    if (b.intention === 'strike' && f && b.percepts.foodDistance < 0.02) {
      s.close++;
      s.minD = Math.min(s.minD, b.percepts.foodDistance);
      sub(tmp, b.goal.target, L.position); normalize(tmp, tmp); quatRotateInv(loc, L.orientation, tmp);
      const h = Math.hypot(loc.x, loc.z);
      if (h > 0.25 && Math.abs(Math.atan2(loc.x, loc.z)) > 0.85) s.pivot++;
      s.dy.push(f.position.y - b.mouth.y);
      s.horiz.push(Math.hypot(f.position.x - b.mouth.x, f.position.z - b.mouth.z));
    }
  };
  for (let i = 0; i < 180; i++) step();
  for (let k = 0; k < 3; k++) { const p = w.locomotion.position; w.feedAt(p.x, p.z); for (let i = 0; i < 1800; i++) step(); }
  const med = (a) => { if (!a.length) return NaN; const q = [...a].sort((x, y) => x - y); return q[q.length >> 1]; };
  return { seed, fed: w.brain.drives.hunger < before - 0.05, eaten: s.eaten, firstEat: s.firstEat, close: s.close, pivot: s.pivot, minD: s.minD, dy: med(s.dy), horiz: med(s.horiz) };
}

if (process.argv[2] === '--child') {
  process.on('message', (seeds) => { for (const seed of seeds) process.send(runSeed(seed)); process.exit(0); });
} else {
  const spec = process.argv[2] ?? '41-46';
  const seeds = spec.split(',').flatMap((r) => { const [a, b] = r.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });
  const workers = 4, results = [];
  await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((res) => {
    const c = fork(fileURLToPath(import.meta.url), ['--child']);
    c.on('message', (r) => results.push(r)); c.on('exit', res);
    c.send(seeds.filter((_, i) => i % workers === k));
  })));
  results.sort((a, b) => a.seed - b.seed);
  const mm = (x) => (x * 1000).toFixed(1);
  if (process.env.VERBOSE) for (const r of results) console.log(`seed ${r.seed} fed=${r.fed} eaten=${r.eaten} first=${r.firstEat.toFixed(1)}s close=${r.close} pivot=${r.pivot} minD=${mm(r.minD)} dy=${mm(r.dy)} horiz=${mm(r.horiz)}`);
  const fed = results.filter((r) => r.fed).length;
  const close = results.reduce((a, r) => a + r.close, 0), pivot = results.reduce((a, r) => a + r.pivot, 0);
  console.log(`${spec}: fed ${fed}/${results.length}  pellets eaten ${results.reduce((a, r) => a + r.eaten, 0)}  close-range strike ticks ${close}, of which target >49deg off heading ${pivot} (${(100 * pivot / close).toFixed(0)}%)`);
}
