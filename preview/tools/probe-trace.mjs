// What does the fish actually do over two minutes at real speed?
import { World } from '../dist/sim/world.js';
const seed = Number(process.argv[2] ?? 7);
const w = new World({ seed, timeScale: 1 });
const dt = 1 / 60;
let last = null, path = 0, vert = 0;
const spans = {};
let cur = w.brain.intention, curStart = 0;
console.log(' t(s)  intention   x      y      z    speed(SL/s)  tailHz  pitchCmd  beat');
for (let i = 0; i <= 120 * 60; i++) {
  w.step(dt);
  const p = w.locomotion.position;
  if (last) { path += Math.hypot(p.x-last.x, p.y-last.y, p.z-last.z); vert += Math.abs(p.y-last.y); }
  last = { ...p };
  if (w.brain.intention !== cur) {
    spans[cur] = (spans[cur] ?? 0) + (i*dt - curStart);
    cur = w.brain.intention; curStart = i*dt;
  }
  if (i % 120 === 0) {
    const c = w.command;
    console.log(
      `${(i*dt).toFixed(0).padStart(4)}  ${w.brain.intention.padEnd(9)} ` +
      `${p.x.toFixed(3).padStart(6)} ${p.y.toFixed(3).padStart(6)} ${p.z.toFixed(3).padStart(6)}   ` +
      `${w.speedSL.toFixed(2).padStart(5)}       ${c.frequency.toFixed(2)}    ${c.pitchBend.toFixed(2).padStart(5)}    ${c.amplitude.toFixed(2)}`);
  }
}
spans[cur] = (spans[cur] ?? 0) + (120 - curStart);
console.log('\npath length', (path).toFixed(2), 'm   of which vertical', (vert).toFixed(2), 'm   (' + (100*vert/path).toFixed(0) + '%)');
console.log('time by intention:', Object.entries(spans).map(([k,v]) => `${k} ${v.toFixed(0)}s`).join(', '));
