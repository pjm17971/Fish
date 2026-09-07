import { buildMorphology } from '../dist/sim/morphology.js';
import { FishBody, createMotorCommand } from '../dist/sim/fishBody.js';
import { createLocomotion } from '../dist/sim/locomotion.js';
import { buildFins } from '../dist/sim/fins.js';
import { FISH } from '../dist/sim/config.js';

function run(freq) {
  const morph = buildMorphology();
  const body = new FishBody(morph);
  const loc = createLocomotion(morph, body);
  loc.bounds = null; // free water: no walls to swim into
  const cmd = createMotorCommand();
  cmd.frequency = freq;
  const fins = buildFins(morph);
  for (const f of fins) f.initialise(body, loc, 0.7);
  const dt = FISH.dt;
  const n = Math.round(14 / dt);
  const acc = new Map(fins.map(f => [f.spec.name, 0]));
  let bodyReact = 0, bodyCross = 0, bodyFric = 0, cnt = 0, uSum = 0, finTotal = 0, pecTotal = 0, buoyTotal = 0;
  const fwd = {x:0,y:0,z:0};
  for (let i = 0; i < n; i++) {
    loc.step(cmd, null, null, dt);
    for (const f of fins) f.step(body, loc, null, 0.7, dt);
    if (i > n*0.6) {
      loc.forward(fwd);
      for (const f of fins) {
        const bf = f.bodyForce;
        acc.set(f.spec.name, acc.get(f.spec.name) + (bf.x*fwd.x+bf.y*fwd.y+bf.z*fwd.z));
      }
      bodyReact += loc.forces.reactive.x*fwd.x+loc.forces.reactive.y*fwd.y+loc.forces.reactive.z*fwd.z;
      bodyCross += loc.forces.crossFlow.x*fwd.x+loc.forces.crossFlow.y*fwd.y+loc.forces.crossFlow.z*fwd.z;
      bodyFric  += loc.forces.friction.x*fwd.x+loc.forces.friction.y*fwd.y+loc.forces.friction.z*fwd.z;
      finTotal  += loc.forces.fin.x*fwd.x+loc.forces.fin.y*fwd.y+loc.forces.fin.z*fwd.z;
      pecTotal  += loc.forces.pectoral.x*fwd.x+loc.forces.pectoral.y*fwd.y+loc.forces.pectoral.z*fwd.z;
      buoyTotal += loc.forces.buoyancy.x*fwd.x+loc.forces.buoyancy.y*fwd.y+loc.forces.buoyancy.z*fwd.z;
      uSum += loc.forwardSpeed;
      cnt++;
    }
  }
  const W = FISH.mass*9.81;
  console.log(`f=${freq}Hz U=${(uSum/cnt).toFixed(4)} m/s   mean forward force / weight:`);
  console.log(`   body reactive ${(bodyReact/cnt/W).toFixed(3)}  crossflow ${(bodyCross/cnt/W).toFixed(3)}  friction ${(bodyFric/cnt/W).toFixed(4)}`);
  for (const [k,v] of acc) console.log(`   fin ${k.padEnd(12)} ${(v/cnt/W).toFixed(3)}`);
  const finSum = [...acc.values()].reduce((a,b)=>a+b,0)/cnt/W;
  console.log(`   -- fins summed from each fin: ${finSum.toFixed(3)}`);
  console.log(`   -- fin force as the solver saw it: ${(finTotal/cnt/W).toFixed(3)}`);
  console.log(`   -- pectoral ${(pecTotal/cnt/W).toFixed(3)}  buoyancy ${(buoyTotal/cnt/W).toFixed(3)}`);
  const net = (bodyReact+bodyCross+bodyFric+finTotal+pecTotal+buoyTotal)/cnt/W;
  console.log(`   == NET forward force / weight: ${net.toFixed(4)} (should be ~0 at steady speed)`);
}
for (const f of [1,4]) { run(f); console.log(); }
