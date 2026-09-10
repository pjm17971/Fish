import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';
// Sweep by scaling the whole bend shape via cmd.bend beyond 1 is not allowed,
// so instead measure turn rate and peak reactive force at the current settings.
function measure(freq, bend) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = freq; cmd.bend = bend; cmd.agility = 0;
  const dt = FISH.dt;
  let peakReact = 0, w = 0, v = 0;
  for (let i = 0; i < Math.round(10/dt); i++) {
    loc.step(cmd, null, null, dt);
    if (i > 1200) {
      peakReact = Math.max(peakReact, Math.hypot(loc.forces.reactive.x,loc.forces.reactive.y,loc.forces.reactive.z));
      w = Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z);
      v = loc.speed;
    }
  }
  const W = FISH.mass*9.81;
  return { w, v, radius: v/Math.max(1e-6,w), peakReactW: peakReact/W };
}
for (const f of [2,4,6]) {
  const r = measure(f, 1);
  console.log(`f=${f}Hz full bend: turn ${r.w.toFixed(2)} rad/s (${(r.w*180/Math.PI).toFixed(0)} deg/s)  speed ${(r.v/FISH.standardLength).toFixed(2)} SL/s  radius ${(r.radius*1000).toFixed(0)}mm (${(r.radius/FISH.standardLength).toFixed(1)} SL)  peak reactive ${r.peakReactW.toFixed(1)}x weight`);
}
