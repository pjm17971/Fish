import { buildMorphology } from '../dist/sim/morphology.js';
const m = buildMorphology();
console.log('effectiveInertiaBody [pitch(x), yaw(y), roll(z)]:', m.effectiveInertiaBody.map(x=>x.toExponential(2)).join(', '));
console.log('ratio max/min:', (Math.max(...m.effectiveInertiaBody)/Math.min(...m.effectiveInertiaBody)).toFixed(1));
