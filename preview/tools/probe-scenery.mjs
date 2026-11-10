// How the fish gets on with the things in the tank, measured every frame:
// how often its body or fins are inside the driftwood or a stone, how far it
// presses into the glass, how much fin sticks up out of the water, and how
// often it swims through a plant.
// node tools/probe-scenery.mjs [seed] [seconds]     (DIST=../other-dist to compare builds)
const dist = process.env.DIST ?? '../dist';
const { World } = await import(`${dist}/sim/world.js`);
const { tankObstacles } = await import('../dist/sim/obstacles.js');
const seed = Number(process.argv[2] ?? 7);
const seconds = Number(process.argv[3] ?? 300);
const w = new World({ seed, timeScale: 1 });
const o = tankObstacles();
const dt = 1 / 60, n = seconds * 60;
const segs = w.morphology.segments.filter((s) => !s.isCaudal);
const P = { x: 0, y: 0, z: 0 };
const T = { minX: -0.175, maxX: 0.175, minZ: -0.25, maxZ: 0 };
let bodyHard = 0, bodyHardMax = 0, finHard = 0, glass = 0, glassMax = 0, finAir = 0, finAirMax = 0, plant = 0;
let surfaceTime = 0, nearWood = 0;
let hardEntries = 0, wasHard = false, plantEntries = 0, wasPlant = false;
for (let i = 0; i < n; i++) {
  w.step(dt);
  const L = w.locomotion;
  // Body: each slice as a ball of its mean half-thickness.
  let pen = 0, gpen = 0, inPlant = false, close = Infinity;
  for (let k = 0; k < segs.length; k++) {
    L.toWorld(w.body.segments[k].pos, P);
    const r = (segs[k].depth + segs[k].width) / 4;
    const d = o.hardDistance(P.x, P.y, P.z);
    close = Math.min(close, d);
    pen = Math.max(pen, r - d);
    const half = segs[k].width / 2;
    gpen = Math.max(gpen, T.minX - (P.x - half), (P.x + half) - T.maxX, T.minZ - (P.z - half), (P.z + half) - T.maxZ);
    if (!inPlant) for (const q of o.plants) {
      const dd = Math.hypot(q.x - P.x, q.y - P.y, q.z - P.z);
      if (dd < r + q.half * 0.5) { inPlant = true; break; }
    }
  }
  if (close < 0.02) nearWood += dt;
  if (pen > 0.001) bodyHard += dt;
  if (pen > 0.001 && !wasHard) hardEntries++;
  wasHard = pen > 0.001;
  bodyHardMax = Math.max(bodyHardMax, pen);
  if (gpen > 0.001) glass += dt;
  glassMax = Math.max(glassMax, gpen);
  if (inPlant) plant += dt;
  if (inPlant && !wasPlant) plantEntries++;
  wasPlant = inPlant;
  // Fins.
  let fh = 0, fa = 0, faMax = 0;
  for (const f of w.fins) for (let k = 0; k < f.pos.length; k += 3) {
    const x = f.pos[k], y = f.pos[k + 1], z = f.pos[k + 2];
    if (o.hardDistance(x, y, z) < -0.0005) fh++;
    const above = y - w.water.heightAt(x, z);
    if (above > 0.0005) { fa++; faMax = Math.max(faMax, above); }
  }
  if (fh > 3) finHard += dt;
  if (fa > 3) finAir += dt;
  finAirMax = Math.max(finAirMax, faMax);
  if (w.brain.intention === 'surface') surfaceTime += dt;
}
const pc = (t) => (100 * t / seconds).toFixed(1) + '%';
console.log(`seed ${seed}, ${seconds}s`);
console.log(`body inside wood or stone: ${pc(bodyHard)} of the time, ${hardEntries} times, deepest ${(bodyHardMax * 1000).toFixed(1)} mm; within 2 cm of wood or stone ${pc(nearWood)}`);
console.log(`fins inside wood or stone: ${pc(finHard)}`);
console.log(`body pressed into the glass by over 1 mm: ${pc(glass)}, deepest ${(glassMax * 1000).toFixed(1)} mm`);
console.log(`fins out of the water: ${pc(finAir)} (surfacing ${pc(surfaceTime)}), highest ${(finAirMax * 1000).toFixed(1)} mm`);
console.log(`body passing through a plant: ${pc(plant)}, ${plantEntries} times`);
