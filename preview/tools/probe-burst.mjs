import { World } from '../dist/sim/world.js';
const w = new World({ seed: 6, timeScale: 1 });
let prev = 0, n = 0;
for (let i = 0; i < 60*60; i++) {
  w.step(1/60);
  const v = w.locomotion.speedSL;
  if (v > prev + 3 && n < 10) {
    n++;
    const f = w.locomotion.forces;
    const mag = (x) => Math.hypot(x.x,x.y,x.z).toExponential(2);
    console.log(`t=${(i/60).toFixed(2)} ${w.brain.intention.padEnd(7)} v ${prev.toFixed(2)}->${v.toFixed(2)} SL/s `
      + `freq=${w.command.frequency.toFixed(2)} amp=${w.locomotion.bodyAmplitude.toExponential(2)} bend=${w.command.bend.toFixed(2)} agility=${w.command.agility.toFixed(2)} `
      + `react=${mag(f.reactive)} cross=${mag(f.crossFlow)} pec=${mag(f.pectoral)} contact=${mag(f.contact)}`);
  }
  prev = v;
}
console.log('bursts counted:', n);
