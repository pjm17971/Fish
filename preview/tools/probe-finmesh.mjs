import { World } from '../dist/sim/world.js';
import { FinMesh } from '../dist/render/meshes.js';

const w = new World({ seed: 7, timeScale: 1 });
for (let i = 0; i < 600; i++) w.step(1 / 60);
const p = w.locomotion.position;
console.log(`fish at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})   standard length 48 mm\n`);

for (const fin of w.fins) {
  const { rays, along } = fin.spec;
  const mesh = new FinMesh(fin);
  mesh.update();
  const v = mesh.vertices;
  const stride = v.length / (rays * along);
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], zeros = 0;
  for (let i = 0; i < rays * along; i++) {
    const x = v[i * stride], y = v[i * stride + 1], z = v[i * stride + 2];
    if (x === 0 && y === 0 && z === 0) zeros++;
    lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
    hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
  }
  const size = hi.map((h, i) => ((h - lo[i]) * 1000).toFixed(1));
  console.log(
    `${String(fin.spec.name).padEnd(12)} nodes=${rays * along} stride=${stride}` +
    `  bbox ${size.join(' x ')} mm  origin-vertices=${zeros}`);
  // Longest triangle edge in the index buffer — the real test.
  let worst = 0;
  for (let k = 0; k < mesh.indices.length; k += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const ia = mesh.indices[k + a] * stride, ib = mesh.indices[k + b] * stride;
      const e = Math.hypot(v[ia] - v[ib], v[ia + 1] - v[ib + 1], v[ia + 2] - v[ib + 2]);
      if (e > worst) worst = e;
    }
  }
  console.log(`${''.padEnd(12)} longest triangle edge = ${(worst * 1000).toFixed(2)} mm`);
}
