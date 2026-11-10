// How the fish spends ordinary time, measured every frame: how fast it goes,
// how often it is still, how it turns, how often it touches the glass.
// node tools/probe-life.mjs [seed] [seconds]     (DIST=../other-dist to compare builds)
const dist = process.env.DIST ?? '../dist';
const { World } = await import(`${dist}/sim/world.js`);
const seed = Number(process.argv[2] ?? 7);
const seconds = Number(process.argv[3] ?? 300);
const w = new World({ seed, timeScale: 1 });
const dt = 1 / 60, SL = 0.048;
const n = seconds * 60;
const bins = [0.15, 0.5, 1, 1.5, 2.5, Infinity], speedT = bins.map(() => 0);
let tail = 0, pect = 0, pivot = 0, touch = 0, touches = 0, wasTouch = false;
let path = 0, vert = 0, last = null, maxSp = 0, turnAbs = 0;
let stillRuns = 0, stillNow = 0, longestStill = 0, stillTime = 0;
const spans = {}; const switches = {};
let prevInt = w.brain.intention, pitchAbs = 0, rollAbs = 0, pitchMax = 0, rollMax = 0;
const f = { x: 0, y: 0, z: 0 }, u = { x: 0, y: 0, z: 0 };
let prevYaw = null, reversals = 0, prevSign = 0;
for (let i = 0; i < n; i++) {
  w.step(dt);
  const L = w.locomotion, p = L.position, c = w.command;
  const sp = Math.hypot(L.velocity.x, L.velocity.y, L.velocity.z) / SL;
  maxSp = Math.max(maxSp, sp);
  speedT[bins.findIndex((b) => sp < b)] += dt;
  if (c.frequency > 0.3) tail += dt;
  if (c.pectoralLeft > 0.2 || c.pectoralRight > 0.2) pect += dt;
  if (w.brain.turnPhaseDebug && w.brain.turnPhaseDebug !== 'none') pivot += dt;
  const ct = L.forces.contact, cm = Math.hypot(ct.x, ct.y, ct.z);
  const touching = cm > 1e-6;
  if (touching) touch += dt;
  if (touching && !wasTouch) touches++;
  wasTouch = touching;
  if (last) { path += Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z); vert += Math.abs(p.y - last.y); }
  last = { ...p };
  if (sp < 0.15) { stillNow += dt; stillTime += dt; } else { if (stillNow > 1) stillRuns++; longestStill = Math.max(longestStill, stillNow); stillNow = 0; }
  L.forward(f); L.dorsal(u);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y))) * 57.3;
  pitchAbs += Math.abs(pitch); pitchMax = Math.max(pitchMax, Math.abs(pitch));
  const right = { x: f.z, z: -f.x }; const rl = Math.hypot(right.x, right.z) || 1;
  const roll = Math.asin(Math.max(-1, Math.min(1, (u.x * right.x + u.z * right.z) / rl))) * 57.3;
  rollAbs += Math.abs(roll); rollMax = Math.max(rollMax, Math.abs(roll));
  const yaw = Math.atan2(f.x, f.z);
  if (prevYaw !== null) {
    let d = yaw - prevYaw; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    turnAbs += Math.abs(d);
  }
  prevYaw = yaw;
  spans[w.brain.intention] = (spans[w.brain.intention] ?? 0) + dt;
  if (w.brain.intention !== prevInt) { switches[w.brain.intention] = (switches[w.brain.intention] ?? 0) + 1; prevInt = w.brain.intention; }
}
const pc = (t) => (100 * t / seconds).toFixed(0).padStart(3) + '%';
console.log(`seed ${seed}, ${seconds}s`);
console.log('time at speed (body lengths/s):  <0.15 ' + pc(speedT[0]) + '  0.15-0.5 ' + pc(speedT[1]) + '  0.5-1 ' + pc(speedT[2]) + '  1-1.5 ' + pc(speedT[3]) + '  1.5-2.5 ' + pc(speedT[4]) + '  >2.5 ' + pc(speedT[5]));
console.log(`mean speed ${(path / seconds / SL).toFixed(2)} SL/s, top ${maxSp.toFixed(1)} SL/s, path ${path.toFixed(1)} m (${(100 * vert / path).toFixed(0)}% vertical)`);
console.log(`tail beating ${pc(tail)}, pectorals rowing ${pc(pect)}, turning round ${pc(pivot)}`);
console.log(`still: ${pc(stillTime)} of the time, ${stillRuns} pauses over 1s, longest ${longestStill.toFixed(1)}s`);
console.log(`touching glass or sand ${pc(touch)}, ${touches} separate touches (${(touches / seconds * 60).toFixed(1)}/min)`);
console.log(`turning: ${(turnAbs * 57.3 / seconds).toFixed(0)} deg/s on average; pitch mean ${(pitchAbs / n).toFixed(1)} max ${pitchMax.toFixed(0)} deg; roll mean ${(rollAbs / n).toFixed(1)} max ${rollMax.toFixed(0)} deg`);
console.log('time by intention: ' + Object.entries(spans).map(([k, v]) => `${k} ${pc(v)}`).join(', '));
console.log('entries: ' + Object.entries(switches).map(([k, v]) => `${k} ${v}`).join(', '));
