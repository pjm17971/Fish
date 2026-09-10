import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';
for (const [bend, pitch] of [[0.3,0],[1,0],[0,1],[1,1]]) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null;
  const cmd = createMotorCommand();
  cmd.frequency = 3; cmd.bend = bend; cmd.pitchBend = pitch;
  const dt = FISH.dt;
  const out = [];
  for (let i = 0; i < Math.round(8/dt); i++) {
    loc.step(cmd, null, null, dt);
    if (i % 500 === 0) out.push(`|w|=${Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z).toFixed(2)} v=${loc.speedSL.toFixed(2)}`);
  }
  console.log(`bend=${bend} pitch=${pitch}: ${out.join('  ')}`);
}
