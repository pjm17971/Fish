import { World } from '../dist/sim/world.js';
const w = new World({ seed: 31, timeScale: 1 });
w.brain.drives.airDebt = 0.99;
for (let i = 0; i < 60*25; i++) {
  w.step(1/60);
  const fwd = w.locomotion.forward({x:0,y:0,z:0});
  if (i % 30 === 0) {
    const m = w.brain.mouth;
    const sy = w.water.heightAt(m.x, m.z);
    console.log(`t=${(i/60).toFixed(1)} ${w.brain.intention.padEnd(7)} air=${w.brain.drives.airDebt.toFixed(2)} `
      + `mouthY=${m.y.toFixed(4)} surfaceY=${sy.toFixed(4)} gap=${((sy-m.y)*1000).toFixed(1)}mm `
      + `v=${w.locomotion.speedSL.toFixed(2)} vy=${w.locomotion.velocity.y.toFixed(4)} attitude=${(Math.asin(fwd.y)*180/Math.PI).toFixed(1)}deg `
      + `tgtY=${w.brain.goal.target.y.toFixed(4)} phase=${w.brain.surfacePhaseDebug ?? '?'} buoyF=${w.locomotion.forces.buoyancy.y.toExponential(2)}`);
  }
}
