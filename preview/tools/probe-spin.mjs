import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';
function run(w0, v0, label) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = 0; cmd.amplitude = 0; cmd.bend = 0;
  loc.angularVelocity.y = w0;
  loc.velocity.z = v0;
  const dt = FISH.dt;
  const out = [];
  for (let i = 0; i < Math.round(3/dt); i++) {
    loc.step(cmd, null, null, dt);
    if (i % 150 === 0) out.push(`|w|=${Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z).toFixed(3)} |v|=${loc.speed.toFixed(4)}`);
  }
  console.log(label, out.join('  '));
}
for (const w of [5, 8, 10, 12, 15, 20]) run(w, 0.2, `w0=${String(w).padStart(2)} v0=0.2 :`);
