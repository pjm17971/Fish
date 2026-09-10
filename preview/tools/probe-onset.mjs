import { World } from '../dist/sim/world.js';
const w = new World({ seed: 3, timeScale: 1 });
let prev = 0, reported = 0;
for (let i = 0; i < 60*30; i++) {
  w.step(1/60);
  const wl = Math.hypot(w.locomotion.angularVelocity.x,w.locomotion.angularVelocity.y,w.locomotion.angularVelocity.z);
  if (wl > prev + 3 && reported < 12) {
    reported++;
    const f = w.locomotion.forces;
    const mag = (v) => Math.hypot(v.x,v.y,v.z).toExponential(2);
    console.log(`t=${(i/60).toFixed(3)} |w| ${prev.toFixed(2)} -> ${wl.toFixed(2)}  ${w.brain.intention} `
      + `T=${mag(w.locomotion.netTorque)} react=${mag(f.reactive)} cross=${mag(f.crossFlow)} pec=${mag(f.pectoral)} buoy=${mag(f.buoyancy)} contact=${mag(f.contact)} fin=${mag(f.fin)} `
      + `pecL=${w.command.pectoralLeft.toFixed(1)} pecR=${w.command.pectoralRight.toFixed(1)} brake=${w.command.brake.toFixed(2)}`);
  }
  prev = wl;
}
