/**
 * Refraction at the tank's panes, checked against Snell's law and the textbook
 * apparent-depth result rather than against a previous run.
 *
 * These exercise the TypeScript copy of the shader's calculation
 * (render/refraction.ts); the two are kept step for step the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apparentPosition, visiblePanes } from '../render/refraction.js';
import { Rng } from '../sim/rng.js';
import { v3, Vec3 } from '../sim/math.js';
import { OPTICS, TANK, TANK_MIN_Z } from '../sim/config.js';

const MIN = v3(-TANK.width / 2, TANK.floorY, TANK_MIN_Z);
const MAX = v3(TANK.width / 2, TANK.waterY, 0);
const n = OPTICS.iorWater;
const FRONT = v3(0, 0, 1);
const LEFT = v3(-1, 0, 0);

const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return v3(a.x / l, a.y / l, a.z / l);
};
const crossLen = (a: Vec3, b: Vec3): number =>
  len(v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x));
const degreesBetween = (a: Vec3, b: Vec3): number =>
  (Math.asin(Math.min(1, crossLen(unit(a), unit(b)))) * 180) / Math.PI;

test('looking straight in, the tank looks shallower by the index of water', () => {
  // The apparent depth of something behind a flat surface, seen square on, is
  // its real depth divided by the index: 25 cm of water looks like 18.8 cm.
  const eye = v3(0, -0.05, 0.4);
  const backWall = v3(0, -0.05, TANK_MIN_Z);
  const { apparent, inPane } = apparentPosition(eye, backWall, FRONT, MIN, MAX, n);
  assert.ok(Math.abs(apparent.z - TANK_MIN_Z / n) < 1e-9, `apparent z ${apparent.z}`);
  assert.ok(Math.abs(apparent.x) < 1e-9 && Math.abs(apparent.y + 0.05) < 1e-9);
  assert.ok(inPane > 0);
});

test("the bent ray obeys Snell's law, from any viewpoint and through any pane", () => {
  // Eyes all round the tank and above it, points anywhere in the water. Where
  // a pane sees a point, the sine of the angle in air at the crossing must be
  // n times the sine of the angle in water, and the point must be drawn on the
  // eye's line of sight. And every point must be seen through some pane: no
  // part of the tank can go missing.
  const rng = new Rng(7);
  let checked = 0;
  for (let k = 0; k < 4000; k++) {
    const yaw = rng.range(-Math.PI, Math.PI);
    const pitch = rng.range(-0.3, 1.2);
    const r = rng.range(0.3, 1.0);
    const eye = v3(
      r * Math.cos(pitch) * Math.sin(yaw),
      MIN.y + 0.06 + r * Math.sin(pitch),
      -TANK.depth / 2 + r * Math.cos(pitch) * Math.cos(yaw),
    );
    const p = v3(rng.range(MIN.x, MAX.x), rng.range(MIN.y, MAX.y), rng.range(MIN.z, MAX.z));
    const panes = visiblePanes(eye, MIN, MAX);
    assert.ok(panes.length > 0, 'the eye is outside the tank, so it sees a pane');

    let seen = 0;
    for (const pane of panes) {
      const { apparent, crossing, inPane } = apparentPosition(eye, p, pane, MIN, MAX, n);
      if (inPane <= 0) continue;
      seen++;
      checked++;
      const inAir = unit(sub(crossing, eye));
      const inWater = unit(sub(p, crossing));
      const sinAir = crossLen(inAir, pane);
      const sinWater = crossLen(inWater, pane);
      assert.ok(Math.abs(sinAir - n * sinWater) < 1e-6, `Snell: ${sinAir} vs ${n * sinWater}`);
      assert.ok(crossLen(inAir, unit(sub(apparent, eye))) < 1e-6, 'on the line of sight');
      assert.ok(Math.abs(len(sub(apparent, crossing)) * n - len(sub(p, crossing))) < 1e-9);
    }
    assert.ok(seen > 0, `a point went missing: eye ${JSON.stringify(eye)}, point ${JSON.stringify(p)}`);
  }
  assert.ok(checked >= 4000);
});

test('seen at a slant through the surface, an upright stick looks shorter', () => {
  // Looking down into water at an angle, anything upright looks squashed: by
  // cos(angle in air) / (n cos(angle in water)) for a distant eye, which is
  // why the far end of a pool looks so shallow. Nothing in the code computes
  // this ratio; it has to come out of where the two ends are drawn.
  const TOP = v3(0, 1, 0);
  for (const fromVertical of [20, 45, 70]) {
    const a = (fromVertical * Math.PI) / 180;
    const far = 200;
    const eye = v3(0, TANK.waterY + far * Math.cos(a), -0.12 + far * Math.sin(a));
    const bottom = v3(0, -0.07, -0.12);
    const top = v3(0, -0.06, -0.12);
    const view = unit(sub(v3(0, TANK.waterY, -0.12), eye));
    // Length across the line of sight, which is what the eye sees.
    const across = (p: Vec3, q: Vec3): number => crossLen(sub(p, q), view);
    const withWater = across(
      apparentPosition(eye, bottom, TOP, MIN, MAX, n).apparent,
      apparentPosition(eye, top, TOP, MIN, MAX, n).apparent,
    );
    const without = across(bottom, top);
    const inWater = Math.asin(Math.sin(a) / n);
    const expected = Math.cos(a) / (n * Math.cos(inWater));
    const ratio = withWater / without;
    assert.ok(Math.abs(ratio - expected) < 0.01 * expected, `${fromVertical} deg: ${ratio} vs ${expected}`);
  }
});

test('a point off to one side appears in a different direction, not just nearer', () => {
  // The earlier version moved points along the straight line from the eye,
  // which changes nothing on screen. Leaving the water, a ray bends away from
  // the pane's normal, so the part of it in air is more slanted than the
  // straight line. Seen from in front and to the left, a plant at the back
  // right should therefore appear further to the right than the straight line
  // would put it.
  const eye = v3(-0.1, -0.05, 0.35);
  const p = v3(0.1, -0.05, -0.2);
  const { apparent } = apparentPosition(eye, p, FRONT, MIN, MAX, n);
  const straight = unit(sub(p, eye));
  const seen = unit(sub(apparent, eye));
  assert.ok(degreesBetween(straight, seen) > 1, 'the direction moved by more than a degree');
  assert.ok(seen.x / -seen.z > straight.x / -straight.z, 'bent away from the normal in air');
});

test('near a corner the same point is seen twice, through both panes', () => {
  // Look at the front-left corner of any tank from diagonally in front of it
  // and a fish close to the corner shows up twice, once through each pane.
  const eye = v3(-0.45, -0.05, 0.3);
  const p = v3(-0.15, -0.05, -0.03);
  const front = apparentPosition(eye, p, FRONT, MIN, MAX, n);
  const left = apparentPosition(eye, p, LEFT, MIN, MAX, n);
  assert.ok(front.inPane > 0 && left.inPane > 0, `front ${front.inPane}, left ${left.inPane}`);
  const apart = degreesBetween(sub(front.apparent, eye), sub(left.apparent, eye));
  assert.ok(apart > 1, `the two images are only ${apart.toFixed(2)} degrees apart`);
});

test('what is out of the water is not drawn through a pane; the walls are', () => {
  const eye = v3(0, -0.05, 0.4);
  const above = v3(0.05, TANK.waterY + 0.01, -0.1);
  assert.ok(apparentPosition(eye, above, FRONT, MIN, MAX, n).inPane < 0);
  // The walls and the sand lie exactly on the faces of the water box.
  const onBackWall = v3(0.05, -0.05, TANK_MIN_Z);
  const onSideWall = v3(MIN.x, -0.05, -0.1);
  assert.ok(apparentPosition(eye, onBackWall, FRONT, MIN, MAX, n).inPane > 0);
  assert.ok(apparentPosition(eye, onSideWall, FRONT, MIN, MAX, n).inPane >= 0);
});
