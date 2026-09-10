import { World } from '../dist/sim/world.js';
let ok = 0;
for (let seed = 1; seed <= 8; seed++) {
  const w = new World({ seed, timeScale: 200 });
  let gulps = 0, maxAir = 0;
  for (let i = 0; i < 60*120; i++) {
    w.step(1/60);
    if (w.brain.gulpedThisTick) gulps++;
    maxAir = Math.max(maxAir, w.brain.drives.airDebt);
  }
  if (gulps >= 2) ok++;
  console.log(`seed ${seed}: ${gulps} gulps in 2 simulated min at 200x, peak air debt ${maxAir.toFixed(2)}`);
}
console.log(`=> breathed properly in ${ok}/8`);
