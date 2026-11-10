/**
 * Does the fish know where the driftwood, the stones and the plants are, and
 * does it get round them?
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERTEX_FLOATS } from '../render/meshes.js';
import { buildHardscape, SURFACE } from '../render/scenery.js';
import { tankObstacles } from '../sim/obstacles.js';
import { tankNavGrid } from '../sim/navigation.js';
import { World } from '../sim/world.js';
import { v3, Vec3 } from '../sim/math.js';

test('the solid shapes the fish meets cover the drawn wood and stones', () => {
  const o = tankObstacles();
  const m = buildHardscape();
  let wood = 0;
  let woodInside = 0;
  let stone = 0;
  let stoneInside = 0;
  for (let i = 0; i < m.vertices.length; i += VERTEX_FLOATS) {
    const d = o.hardDistance(m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]);
    if (m.vertices[i + 8] === SURFACE.wood) {
      wood++;
      if (d < 0.001) woodInside++;
    } else if (m.vertices[i + 8] === SURFACE.stone) {
      stone++;
      if (d < 0.001) stoneInside++;
    }
  }
  assert.ok(woodInside / wood > 0.95, `only ${((100 * woodInside) / wood).toFixed(1)}% of the wood is solid`);
  assert.ok(stoneInside / stone > 0.95, `only ${((100 * stoneInside) / stone).toFixed(1)}% of the stones are solid`);
});

test('a route past the driftwood goes round it, not through it', () => {
  const o = tankObstacles();
  const nav = tankNavGrid(o);
  // Either side of the trunk, low down, where the straight line crosses it.
  const a = v3(-0.12, -0.07, -0.12);
  const b = v3(-0.06, -0.07, -0.215);
  assert.equal(nav.lineCost(a, b), Infinity, 'the straight line should cross the wood');
  const route: Vec3[] = [];
  assert.ok(nav.plan(a, b, route), 'there should be a way round');
  for (let i = 1; i < route.length; i++) {
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const p = v3(
        route[i - 1].x + (route[i].x - route[i - 1].x) * t,
        route[i - 1].y + (route[i].y - route[i - 1].y) * t,
        route[i - 1].z + (route[i].z - route[i - 1].z) * t,
      );
      assert.ok(o.hardDistance(p.x, p.y, p.z) > 0.006, `route passes ${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)} too close to the wood`);
    }
  }
});

test('over a minute of ordinary life, the body stays out of the wood and the fins stay in the water', () => {
  const w = new World({ seed: 11, timeScale: 1 });
  const o = w.obstacles;
  const segs = w.morphology.segments;
  const P = v3();
  let deepest = 0;
  let finHigh = 0;
  for (let i = 0; i < 70 * 60; i++) {
    w.step(1 / 60);
    for (let k = 0; k < segs.length; k++) {
      if (segs[k].isCaudal) continue;
      w.locomotion.toWorld(w.body.segments[k].pos, P);
      const r = (segs[k].depth + segs[k].width) / 4;
      deepest = Math.max(deepest, r - o.hardDistance(P.x, P.y, P.z));
    }
    for (const f of w.fins) {
      // Past the two nodes the body carries.
      const along = f.spec.along;
      for (let n = 0; n < f.pos.length / 3; n++) {
        if (n % along < 2) continue;
        const y = f.pos[n * 3 + 1];
        finHigh = Math.max(finHigh, y - w.water.heightAt(f.pos[n * 3], f.pos[n * 3 + 2]));
      }
    }
  }
  assert.ok(deepest < 0.002, `body went ${(deepest * 1000).toFixed(1)} mm into wood or stone`);
  // The fins are laid under the surface before the water takes its own step
  // for the frame, and a breath leaves a hollow round the snout, so a few
  // millimetres is the surface moving, not the fin standing up. Before the
  // fins knew about the surface they stood up to sixteen.
  assert.ok(finHigh < 0.003, `a fin stood ${(finHigh * 1000).toFixed(1)} mm out of the water`);
});
