import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { FISH } from '../dist/sim/config.js';

function run(freq, seconds, label) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  const dt = FISH.dt;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    if (i % Math.round(n/6) === 0) {
      const f = loc.forces;
      console.log(`${label} t=${(i*dt).toFixed(2)} U=${loc.forwardSpeed.toFixed(5)} |v|=${loc.speed.toFixed(5)} `
        + `react.z=${f.reactive.z.toExponential(2)} cross.z=${f.crossFlow.z.toExponential(2)} fric.z=${f.friction.z.toExponential(2)} `
        + `pos=(${loc.position.x.toFixed(3)},${loc.position.y.toFixed(3)},${loc.position.z.toFixed(3)}) `
        + `w=(${loc.angularVelocity.x.toFixed(2)},${loc.angularVelocity.y.toFixed(2)},${loc.angularVelocity.z.toFixed(2)})`);
    }
  }
}
run(0, 6, 'f=0 ');
console.log('---');
run(3, 6, 'f=3 ');
