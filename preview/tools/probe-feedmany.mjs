import { World } from '../dist/sim/world.js';
let fed = 0, tried = 0;
for (let seed = 1; seed <= 12; seed++) {
  const w = new World({ seed, timeScale: 1 });
  w.brain.drives.hunger = 0.95;
  for (let i = 0; i < 120; i++) w.step(1/60);
  const p = w.locomotion.position;
  w.feedAt(p.x, p.z);
  let ate = 0, minD = 99;
  for (let i = 0; i < 60*45; i++) {
    w.step(1/60);
    if (w.brain.atePelletThisTick) ate++;
    if (w.brain.percepts.nearestFood) minD = Math.min(minD, w.brain.percepts.foodDistance);
  }
  tried++;
  if (ate > 0) fed++;
  console.log(`seed ${String(seed).padStart(2)}: ate ${ate}/3  closest ${(minD*1000).toFixed(1)}mm  hunger ${w.brain.drives.hunger.toFixed(2)}`);
}
console.log(`\n=> fed in ${fed}/${tried} runs`);
