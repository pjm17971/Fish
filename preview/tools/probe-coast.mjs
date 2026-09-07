import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';
const morph = buildMorphology();
const body = new FishBody(morph);
const loc = createLocomotion(morph, body);
loc.bounds = null;
const cmd = createMotorCommand();
cmd.frequency = 4;
const dt = FISH.dt;
for (let i = 0; i < Math.round(12/dt); i++) loc.step(cmd, null, null, dt);
console.log(`cruise: |v|=${loc.speed.toFixed(4)} fwd=${loc.forwardSpeed.toFixed(4)} |w|=${Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z).toFixed(3)}`);
cmd.frequency = 0; cmd.amplitude = 0; cmd.bend = 0;
for (let i = 0; i < Math.round(6/dt); i++) {
  loc.step(cmd, null, null, dt);
  if (i % 100 === 0 && i < 900) console.log(`  t=${(i*dt).toFixed(2)} |v|=${loc.speed.toFixed(5)} fwd=${loc.forwardSpeed.toFixed(5)} |w|=${Math.hypot(loc.angularVelocity.x,loc.angularVelocity.y,loc.angularVelocity.z).toFixed(3)} bladder=${loc.bladder.toFixed(3)} T=${Math.hypot(loc.netTorque.x,loc.netTorque.y,loc.netTorque.z).toExponential(2)} react=${Math.hypot(loc.forces.reactive.x,loc.forces.reactive.y,loc.forces.reactive.z).toExponential(2)} cross=${Math.hypot(loc.forces.crossFlow.x,loc.forces.crossFlow.y,loc.forces.crossFlow.z).toExponential(2)} amp=${loc.bodyAmplitude.toExponential(2)}`);
}
