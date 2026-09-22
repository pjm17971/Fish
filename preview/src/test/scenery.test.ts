/**
 * Does the scenery stay where it is supposed to be?
 *
 * The fish cannot see the stones, the wood or the plants, and nothing stops a
 * procedural layout drifting through the glass or out of the water when a
 * number changes. These check the promises the layout makes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TANK, TANK_MIN_X, TANK_MAX_X, TANK_MIN_Z, TANK_MAX_Z } from '../sim/config.js';
import { VERTEX_FLOATS } from '../render/meshes.js';
import {
  buildHardscape,
  buildPlantsMesh,
  buildTankMesh,
  buildGlassMesh,
  buildRoomMesh,
  sandHeight,
  SURFACE,
  TANK_BOTTOM_Y,
  ROOM,
  BuiltMesh,
} from '../render/scenery.js';
import { MAX_OCCLUDERS, FISH_OCCLUDERS } from '../render/shaders.js';

type Vertex = { x: number; y: number; z: number; kind: number; sway: number };

function vertices(m: BuiltMesh): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < m.vertices.length; i += VERTEX_FLOATS) {
    out.push({
      x: m.vertices[i],
      y: m.vertices[i + 1],
      z: m.vertices[i + 2],
      kind: m.vertices[i + 8],
      sway: m.vertices[i + 9],
    });
  }
  return out;
}

/**
 * The furthest SCENE_VERT's swayOffset can move a vertex, per unit of its sway
 * weight: 0.7 times the sum of the lean, swing and flutter amplitudes.
 */
const SWAY_REACH = 0.7 * (Math.hypot(0.4, 0.15) + Math.hypot(1, 0.55) + 0.22 * Math.SQRT2);

function assertWellFormed(name: string, m: BuiltMesh): void {
  assert.equal(m.vertices.length % VERTEX_FLOATS, 0, `${name}: partial vertex`);
  assert.ok(m.vertices.every(Number.isFinite), `${name}: a vertex is not a finite number`);
  assert.equal(m.indices.length % 3, 0, `${name}: partial triangle`);
  const count = m.vertices.length / VERTEX_FLOATS;
  assert.ok(m.indices.every((i) => i < count), `${name}: an index points past the last vertex`);
}

const TOLERANCE = 5e-4;
const inside = (v: Vertex): boolean =>
  v.x >= TANK_MIN_X - TOLERANCE &&
  v.x <= TANK_MAX_X + TOLERANCE &&
  v.z >= TANK_MIN_Z - TOLERANCE &&
  v.z <= TANK_MAX_Z + TOLERANCE &&
  v.y >= TANK_BOTTOM_Y - TOLERANCE;

/** Inside the glass wherever the current pushes it. */
const insideSwaying = (v: Vertex): boolean => {
  const r = v.sway * SWAY_REACH;
  return inside({ ...v, x: v.x - r, z: v.z - r }) && inside({ ...v, x: v.x + r, z: v.z + r });
};

test('every scenery mesh is well formed', () => {
  assertWellFormed('tank', buildTankMesh());
  assertWellFormed('glass', buildGlassMesh());
  assertWellFormed('hardscape', buildHardscape());
  assertWellFormed('plants', buildPlantsMesh());
  assertWellFormed('room', buildRoomMesh());
});

test('plants grow inside the glass and stay under the water', () => {
  for (const v of vertices(buildPlantsMesh())) {
    assert.ok(
      insideSwaying(v),
      `leaf vertex can sway outside the tank at ${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`,
    );
    assert.ok(v.y < TANK.waterY, `leaf vertex above the waterline at y = ${v.y.toFixed(4)}`);
  }
});

test('the wood and the stones are inside the glass and sit on the sand', () => {
  const hard = buildHardscape();
  for (const v of vertices(hard)) {
    assert.ok(inside(v), `hardscape vertex outside the tank at ${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`);
    assert.ok(v.y < TANK.waterY, 'hardscape above the waterline');
  }
  // Every stone reaches down into the sand, rather than floating on it.
  const stones = vertices(hard).filter((v) => v.kind === SURFACE.stone);
  assert.ok(stones.length > 0);
  const buried = stones.filter((v) => v.y < sandHeight(v.x, v.z)).length;
  assert.ok(buried > stones.length * 0.1, 'stones are not bedded into the sand');
});

test('the stones are low enough for a fish that cannot see them', () => {
  // The brain never steers the fish's centre lower than 2.6 cm above the front
  // of the sand (Brain.runRoutine's final clamp). Over the stones, where the
  // sand is banked up a little, that leaves its belly about 1.5 cm up, so the
  // stones stay under that and the body passes over them. The fins trail
  // lower and can still pass through.
  for (const v of vertices(buildHardscape()).filter((w) => w.kind === SURFACE.stone)) {
    assert.ok(v.y - sandHeight(v.x, v.z) < 0.016, `a stone stands ${(v.y - sandHeight(v.x, v.z)).toFixed(3)} m tall`);
  }
});

test('the resting spot is left clear of wood and stone', () => {
  // Brain.pickRestTarget picks from x in [-0.05, 0.05], z in [-0.15, -0.075]
  // at 4.5 cm above the sand; nothing hard may be in the way of a fish lying
  // there, with a margin for its body and fins.
  const clash = vertices(buildHardscape()).find(
    (v) =>
      Math.abs(v.x) < 0.06 &&
      v.z > -0.16 &&
      v.z < -0.065 &&
      v.y > TANK.floorY + 0.028 &&
      v.y < TANK.floorY + 0.065,
  );
  assert.equal(clash, undefined, 'hardscape in the resting spot');
});

test('the shadow spheres fit the shader, with room left for the fish', () => {
  const { occluders } = buildHardscape();
  assert.ok(occluders.length > 0);
  assert.ok(
    occluders.length <= MAX_OCCLUDERS - FISH_OCCLUDERS,
    `${occluders.length} hardscape spheres, but the shader only takes ${MAX_OCCLUDERS - FISH_OCCLUDERS}`,
  );
});

test('the orbit camera cannot leave the room', () => {
  // main.ts: distance at most 1.2 m from a target at the middle of the tank,
  // pitch from -0.3 to 1.2 radians.
  const target = { y: TANK.floorY + 0.06, z: -TANK.depth * 0.5 };
  const d = 1.2;
  assert.ok(ROOM.minX < -d && ROOM.maxX > d);
  assert.ok(ROOM.minZ < target.z - d && ROOM.maxZ > target.z + d);
  assert.ok(ROOM.ceilingY > target.y + d * Math.sin(1.2));
  assert.ok(ROOM.floorY < target.y - d * Math.sin(0.3));
});
