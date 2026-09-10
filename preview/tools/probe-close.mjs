import { World } from '../dist/sim/world.js';
const w = new World({ seed: 6, timeScale: 1 });
w.brain.drives.hunger = 0.95;
for (let i = 0; i < 120; i++) w.step(1/60);
const p = w.locomotion.position;
w.feedAt(p.x, p.z);
let best = 99, printed = 0;
for (let i = 0; i < 60*45; i++) {
  w.step(1/60);
  const d = w.brain.percepts.foodDistance;
  if (d < 0.030 && printed < 30) {
    printed++;
    const f = w.brain.percepts.nearestFood;
    const m = w.brain.mouth;
    console.log(`t=${(i/60).toFixed(2)} ${w.brain.intention.padEnd(7)} d=${(d*1000).toFixed(1)} `
      + `mouthY=${m.y.toFixed(4)} pelletY=${f?f.position.y.toFixed(4):'-'} `
      + `v=${w.locomotion.speedSL.toFixed(2)} hover=${w.brain.goal.hover} brake=${w.command.brake.toFixed(2)} `
      + `freq=${w.command.frequency.toFixed(1)} mouthOpen=${w.command.mouthOpen.toFixed(2)} `
      + `strikeDesire=${w.brain.desires.strike.toFixed(2)} avoid=${w.brain.desires.avoid.toFixed(2)}`);
  }
  if (d < best) best = d;
}
console.log('best', (best*1000).toFixed(1), 'mm');
