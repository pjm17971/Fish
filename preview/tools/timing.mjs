import { World } from '../dist/sim/world.js';
const t0 = Date.now();
const w = new World({ seed: 1, timeScale: 40 });
const dt = 1/60;
for (let i = 0; i < 600; i++) w.step(dt);
const ms = Date.now() - t0;
console.log(`600 steps (10 s world time) in ${ms} ms = ${(ms/600).toFixed(2)} ms/step`);
console.log(`=> 300 s of world time would take ${(ms/600*18000/1000).toFixed(1)} s`);
console.log(w.describe());
