import { World } from '../dist/sim/world.js';
const w = new World({ seed: 3, timeScale: 1 });
let maxSL = 0;
for (let i = 0; i < 60*30; i++) {
  w.step(1/60);
  if (i > 120) maxSL = Math.max(maxSL, w.locomotion.speedSL);
  if (i % 180 === 0) console.log(`t=${(i/60).toFixed(0)}s ${w.brain.intention.padEnd(7)} v=${w.locomotion.speedSL.toFixed(2)}SL/s freq=${w.command.frequency.toFixed(1)} bend=${w.command.bend.toFixed(2)} pitch=${w.command.pitchBend.toFixed(2)} |w|=${Math.hypot(w.locomotion.angularVelocity.x,w.locomotion.angularVelocity.y,w.locomotion.angularVelocity.z).toFixed(2)}`);
}
console.log('max speed after settling:', maxSL.toFixed(2), 'SL/s (clamp is 12)');
