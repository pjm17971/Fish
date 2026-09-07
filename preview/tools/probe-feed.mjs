import { World } from '../dist/sim/world.js';
const w = new World({ seed: 41, timeScale: 1 });
w.brain.drives.hunger = 0.95;
for (let i = 0; i < 180; i++) w.step(1/60);
const p = w.locomotion.position;
w.feedAt(p.x, p.z);
console.log('dropped at', p.x.toFixed(3), p.z.toFixed(3), 'fish y', p.y.toFixed(3));
for (let i = 0; i < 60*40; i++) {
  w.step(1/60);
  if (i % 60 === 0) {
    const f = w.brain.percepts.nearestFood;
    const m = w.brain.mouth;
    console.log(`t=${(i/60).toFixed(0)}s ${w.brain.intention.padEnd(7)} d=${(w.brain.percepts.foodDistance*1000).toFixed(1)}mm `
      + `mouth=(${m.x.toFixed(3)},${m.y.toFixed(3)},${m.z.toFixed(3)}) `
      + (f ? `pellet=(${f.position.x.toFixed(3)},${f.position.y.toFixed(3)},${f.position.z.toFixed(3)})` : 'no pellet seen')
      + ` v=${w.locomotion.speedSL.toFixed(2)}SL/s bend=${w.command.bend.toFixed(2)} pitch=${w.command.pitchBend.toFixed(2)}`);
  }
}
