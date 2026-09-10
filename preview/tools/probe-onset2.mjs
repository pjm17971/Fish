import { World } from '../dist/sim/world.js';
import { FISH } from '../dist/sim/config.js';
// Step at exactly the physics rate so each world step is one locomotion substep.
const w = new World({ seed: 3, timeScale: 1 });
const dt = FISH.dt;
let prev = 0;
const hist = [];
for (let i = 0; i < Math.round(30/dt); i++) {
  w.step(dt);
  const L = w.locomotion;
  const wl = Math.hypot(L.angularVelocity.x,L.angularVelocity.y,L.angularVelocity.z);
  const mag = (v) => Math.hypot(v.x,v.y,v.z);
  hist.push({t:i*dt, wl, T:mag(L.netTorque), react:mag(L.forces.reactive), cross:mag(L.forces.crossFlow),
             pec:mag(L.forces.pectoral), amp:L.bodyAmplitude, freq:w.command.frequency, bend:w.command.bend, pitch:w.command.pitchBend,
             int:w.brain.intention});
  if (wl > prev + 5) {
    console.log(`SPIKE at t=${(i*dt).toFixed(3)}: ${prev.toFixed(2)} -> ${wl.toFixed(2)}`);
    for (const h of hist.slice(-6)) {
      console.log(`  t=${h.t.toFixed(3)} ${h.int.padEnd(7)} |w|=${h.wl.toFixed(3)} T=${h.T.toExponential(2)} react=${h.react.toExponential(2)} cross=${h.cross.toExponential(2)} pec=${h.pec.toExponential(2)} amp=${h.amp.toExponential(2)} f=${h.freq.toFixed(2)} bend=${h.bend.toFixed(2)} pitch=${h.pitch.toFixed(2)}`);
    }
    break;
  }
  prev = wl;
}
