/**
 * Everything in the tank that is not the fish or the water, and the room the
 * tank stands in.
 *
 * All of it is built procedurally, from a fixed seed, so the layout is the same
 * every run. Nothing here is simulated: the stones and the wood are static, and
 * the plants' sway is a kinematic motion in the vertex shader (see SCENE_VERT),
 * not a solved one. The fish does not know any of it is here — it swims
 * through leaves, as it always has — so the hard pieces are kept low and to the
 * edges, away from where it spends its time and clear of the spot it rests in.
 *
 * Layout, looking in through the front glass:
 *
 *   - a piece of branching driftwood lying from the back-left corner towards
 *     the middle, with a java fern tied onto it;
 *   - a low group of grey stones right of centre, and pebbles at the front left;
 *   - vallisneria along the back right, long enough to reach the surface and
 *     trail along it, as it does in a real tank;
 *   - an Amazon sword behind the middle, with one broad leaf reaching forward
 *     at mid-depth — the leaf a betta lies on;
 *   - a stand of red-topped stem plants on the right;
 *   - cryptocorynes at the front left, and a carpet of hairgrass across the
 *     front.
 */

import { TANK, TANK_MIN_X, TANK_MIN_Z } from '../sim/config.js';
import { Rng, valueNoise3, fbm3 } from '../sim/rng.js';
import { v3, Vec3, cross, normalize, sub, dot, len, add, scale } from '../sim/math.js';
import { VERTEX_FLOATS } from './meshes.js';

export interface BuiltMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Depth of substrate at the front glass, from the bottom pane to the sand. */
export const SUBSTRATE_DEPTH = 0.028;
/** Bottom of the tank's interior, where the substrate sits on the bottom pane. */
export const TANK_BOTTOM_Y = TANK.floorY - SUBSTRATE_DEPTH;
/** Top of the glass, above the waterline. */
export const TANK_RIM_Y = TANK.waterY + 0.03;
/** The desk top the tank stands on: the underside of the bottom pane. */
export const DESK_Y = TANK_BOTTOM_Y - TANK.glassThickness;
/** The room's floor, a desk's height below its top. */
export const ROOM_FLOOR_Y = DESK_Y - 0.76;

/**
 * The room: a box around the tank, big enough that the orbit camera (at most
 * 1.2 m from its target) can never leave it.
 */
export const ROOM = {
  minX: -1.7,
  maxX: 1.7,
  minZ: -1.6,
  maxZ: 1.5,
  floorY: ROOM_FLOOR_Y,
  ceilingY: 1.45,
} as const;

/** Where the lamp hangs. Matches the lamp `envColour` puts in reflections. */
export const LAMP_Y = TANK.waterY + 0.16;
/** Half the depth of the lamp's emitting strip, front to back. */
export const LAMP_HALF_DEPTH = 0.016;

/**
 * Height of the sand surface. It slopes up towards the back, as aquascapers
 * bank it, with a gentle undulation so it reads as a surface rather than a
 * plane.
 */
export function sandHeight(x: number, z: number): number {
  const t = (z - TANK_MIN_Z) / -TANK_MIN_Z; // 0 at the back, 1 at the front
  return (
    TANK.floorY +
    TANK.floorSlopeBack * (1 - t) +
    0.0016 * Math.sin(x * 47 + z * 11) +
    0.0011 * Math.sin(x * 23 - z * 37 + 1.3)
  );
}

/** Upward normal of the sand, from the analytic derivative of `sandHeight`. */
function sandNormal(x: number, z: number): Vec3 {
  const dx = 0.0016 * 47 * Math.cos(x * 47 + z * 11) + 0.0011 * 23 * Math.cos(x * 23 - z * 37 + 1.3);
  const dz =
    TANK.floorSlopeBack / TANK_MIN_Z +
    0.0016 * 11 * Math.cos(x * 47 + z * 11) -
    0.0011 * 37 * Math.cos(x * 23 - z * 37 + 1.3);
  const n = v3(-dx, 1, -dz);
  return normalize(n, n);
}

// ---------------------------------------------------------------------------
// Surface kinds
//
// Written into `aExtra.x`; the fragment shader for each mesh switches on it.
// ---------------------------------------------------------------------------

/** TANK_FRAG. Leaves are 2.0 + species / 10. */
export const SURFACE = {
  sand: 0,
  substrate: 1,
  leaf: 2,
  wood: 3,
  stone: 4,
} as const;

export const LEAF = {
  sword: 0,
  vallis: 1,
  hairgrass: 2,
  redStem: 3,
  stem: 4,
  javaFern: 5,
  crypt: 6,
} as const;

const leafKind = (species: number): number => SURFACE.leaf + species / 10;

/** GLASS_FRAG. */
export const GLASS = { pane: 0, edge: 1 } as const;

/** ROOM_FRAG. */
export const ROOM_SURFACE = {
  wall: 0,
  floor: 1,
  deskTop: 2,
  deskBody: 3,
  ceiling: 4,
  skirting: 5,
  lampHousing: 6,
  lampEmitter: 7,
} as const;

// ---------------------------------------------------------------------------
// Mesh building
// ---------------------------------------------------------------------------

class MeshBuilder {
  readonly verts: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.verts.length / VERTEX_FLOATS;
  }

  vertex(p: Vec3, n: Vec3, u: number, v: number, kind: number, extra = 0): number {
    const i = this.count;
    this.verts.push(p.x, p.y, p.z, n.x, n.y, n.z, u, v, kind, extra);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * A quad a-b-c-d, wound so that it faces along `n` (counter-clockwise seen
   * from that side), whatever order the corners were given in.
   */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, kind: number, uv?: number[][]): void {
    const e1 = sub(v3(), b, a);
    const e2 = sub(v3(), c, a);
    const facing = dot(cross(v3(), e1, e2), n) >= 0;
    const t = uv ?? [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const i0 = this.vertex(a, n, t[0][0], t[0][1], kind);
    const i1 = this.vertex(b, n, t[1][0], t[1][1], kind);
    const i2 = this.vertex(c, n, t[2][0], t[2][1], kind);
    const i3 = this.vertex(d, n, t[3][0], t[3][1], kind);
    if (facing) this.idx.push(i0, i1, i2, i0, i2, i3);
    else this.idx.push(i0, i2, i1, i0, i3, i2);
  }

  /**
   * An axis-aligned box. `kindFor(axis, sign)` picks each face's kind, or
   * returns null to leave that face out.
   */
  box(min: Vec3, max: Vec3, kindFor: (axis: 0 | 1 | 2, sign: 1 | -1) => number | null): void {
    const corner = (i: number, j: number, k: number): Vec3 =>
      v3(i ? max.x : min.x, j ? max.y : min.y, k ? max.z : min.z);
    const faces: [0 | 1 | 2, 1 | -1, Vec3[]][] = [
      [0, -1, [corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 1), corner(0, 1, 0)]],
      [0, 1, [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)]],
      [1, -1, [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)]],
      [1, 1, [corner(0, 1, 0), corner(0, 1, 1), corner(1, 1, 1), corner(1, 1, 0)]],
      [2, -1, [corner(0, 0, 0), corner(0, 1, 0), corner(1, 1, 0), corner(1, 0, 0)]],
      [2, 1, [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)]],
    ];
    for (const [axis, sign, [a, b, c, d]] of faces) {
      const kind = kindFor(axis, sign);
      if (kind === null) continue;
      const n = v3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      // Texture coordinates in metres across the face, for shaders that want
      // a scale-true pattern.
      const w = len(sub(v3(), b, a));
      const h = len(sub(v3(), d, a));
      this.quad(a, b, c, d, n, kind, [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ]);
    }
  }

  /**
   * Recompute normals from the triangles, for vertices from `start` on,
   * averaging across vertices that share a position so that texture seams do
   * not show up as creases.
   */
  smoothNormals(start: number): void {
    const n = this.count - start;
    const acc = new Float64Array(n * 3);
    const v = this.verts;
    const F = VERTEX_FLOATS;
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t];
      const b = this.idx[t + 1];
      const c = this.idx[t + 2];
      if (a < start || b < start || c < start) continue;
      const ux = v[b * F] - v[a * F];
      const uy = v[b * F + 1] - v[a * F + 1];
      const uz = v[b * F + 2] - v[a * F + 2];
      const wx = v[c * F] - v[a * F];
      const wy = v[c * F + 1] - v[a * F + 1];
      const wz = v[c * F + 2] - v[a * F + 2];
      // Area-weighted: the cross product's length is twice the area.
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      for (const i of [a, b, c]) {
        acc[(i - start) * 3] += nx;
        acc[(i - start) * 3 + 1] += ny;
        acc[(i - start) * 3 + 2] += nz;
      }
    }
    // Weld by position.
    const key = (i: number): string =>
      `${Math.round(v[i * F] * 1e5)},${Math.round(v[i * F + 1] * 1e5)},${Math.round(v[i * F + 2] * 1e5)}`;
    const groups = new Map<string, number[]>();
    for (let i = start; i < this.count; i++) {
      const k = key(i);
      const g = groups.get(k);
      if (g) g.push(i);
      else groups.set(k, [i]);
    }
    for (const g of groups.values()) {
      let x = 0;
      let y = 0;
      let z = 0;
      for (const i of g) {
        x += acc[(i - start) * 3];
        y += acc[(i - start) * 3 + 1];
        z += acc[(i - start) * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      for (const i of g) {
        v[i * F + 3] = x / l;
        v[i * F + 4] = y / l;
        v[i * F + 5] = z / l;
      }
    }
  }

  build(): BuiltMesh {
    return { vertices: new Float32Array(this.verts), indices: new Uint32Array(this.idx) };
  }
}

// ---------------------------------------------------------------------------
// Tank: substrate and glass
// ---------------------------------------------------------------------------

const X0 = TANK_MIN_X;
const X1 = -TANK_MIN_X;
const Z0 = TANK_MIN_Z;
const Z1 = 0;

/**
 * The substrate: the sand surface, and its cut faces against the glass.
 *
 * Seen through the front pane, the substrate of a planted tank shows as
 * layers — a dark nutrient soil at the bottom and the sand capping it. Without
 * those faces the sand is a sheet floating in the air, which is what it was.
 */
export function buildTankMesh(): BuiltMesh {
  const b = new MeshBuilder();

  const N = 32;
  const base = b.count;
  for (let j = 0; j <= N; j++) {
    const z = Z0 + ((Z1 - Z0) * j) / N;
    for (let i = 0; i <= N; i++) {
      const x = X0 + ((X1 - X0) * i) / N;
      b.vertex(v3(x, sandHeight(x, z), z), sandNormal(x, z), i / N, j / N, SURFACE.sand);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = base + j * (N + 1) + i;
      const c = a + (N + 1);
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }

  // The four cut faces, each a strip from the bottom pane up to the sand's
  // edge. `uv` is (distance along the face, height) in metres.
  const strip = (from: Vec3, to: Vec3, n: Vec3): void => {
    const start = b.count;
    const length = len(sub(v3(), to, from));
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      const top = sandHeight(x, z);
      b.vertex(v3(x, TANK_BOTTOM_Y, z), n, length * t, TANK_BOTTOM_Y, SURFACE.substrate);
      b.vertex(v3(x, top, z), n, length * t, top, SURFACE.substrate);
    }
    // Wind each quad to face along n.
    const p0 = v3(from.x, 0, from.z);
    const p1 = v3(to.x, 0, to.z);
    const along = sub(v3(), p1, p0);
    const facing = dot(cross(v3(), along, v3(0, 1, 0)), n) >= 0;
    for (let i = 0; i < N; i++) {
      const a = start + i * 2;
      if (facing) b.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  strip(v3(X0, 0, Z1), v3(X1, 0, Z1), v3(0, 0, 1));
  strip(v3(X1, 0, Z0), v3(X0, 0, Z0), v3(0, 0, -1));
  strip(v3(X0, 0, Z0), v3(X0, 0, Z1), v3(-1, 0, 0));
  strip(v3(X1, 0, Z1), v3(X1, 0, Z0), v3(1, 0, 0));

  return b.build();
}

/**
 * The glass: four panes and the bottom, each a slab of real thickness.
 *
 * The broad faces of the back and side panes are drawn as glass — mostly
 * clear, reflecting a little of the room. The thin faces are drawn as edges,
 * because seen end-on a pane of float glass is a green line: light travelling
 * along the glass passes through centimetres of it instead of millimetres,
 * and the iron in it absorbs the red. That line is most of how a rimless tank
 * reads as glass at all. The front pane has only its edges: its broad face is
 * the phone's screen, and in the preview the camera looks through it.
 *
 * The broad faces are subdivided at the sand line and the waterline because
 * the apparent-depth shift in SCENE_VERT is applied per vertex and bends at
 * both.
 */
export function buildGlassMesh(): BuiltMesh {
  const b = new MeshBuilder();
  const t = TANK.glassThickness;
  const yB = TANK_BOTTOM_Y;
  const bands = [yB - t, TANK.floorY, TANK.waterY, TANK_RIM_Y];
  const COLUMNS = 8;

  // A broad face in the plane `axis = at`, spanning [u0, u1] along the other
  // horizontal axis.
  const broad = (axis: 'x' | 'z', at: number, u0: number, u1: number, n: Vec3): void => {
    for (let j = 0; j < bands.length - 1; j++) {
      for (let i = 0; i < COLUMNS; i++) {
        const ua = u0 + ((u1 - u0) * i) / COLUMNS;
        const ub = u0 + ((u1 - u0) * (i + 1)) / COLUMNS;
        const p = (u: number, y: number): Vec3 => (axis === 'x' ? v3(at, y, u) : v3(u, y, at));
        b.quad(p(ua, bands[j]), p(ub, bands[j]), p(ub, bands[j + 1]), p(ua, bands[j + 1]), n, GLASS.pane);
      }
    }
  };

  // Back pane.
  broad('z', Z0, X0 - t, X1 + t, v3(0, 0, 1));
  broad('z', Z0 - t, X0 - t, X1 + t, v3(0, 0, -1));
  b.box(v3(X0 - t, yB - t, Z0 - t), v3(X1 + t, TANK_RIM_Y, Z0), (axis) => (axis === 2 ? null : GLASS.edge));
  // Side panes.
  broad('x', X0, Z0, Z1, v3(1, 0, 0));
  broad('x', X0 - t, Z0, Z1, v3(-1, 0, 0));
  b.box(v3(X0 - t, yB - t, Z0), v3(X0, TANK_RIM_Y, Z1), (axis) => (axis === 0 ? null : GLASS.edge));
  broad('x', X1, Z0, Z1, v3(-1, 0, 0));
  broad('x', X1 + t, Z0, Z1, v3(1, 0, 0));
  b.box(v3(X1, yB - t, Z0), v3(X1 + t, TANK_RIM_Y, Z1), (axis) => (axis === 0 ? null : GLASS.edge));
  // Front pane: edges only.
  b.box(v3(X0 - t, yB - t, Z1), v3(X1 + t, TANK_RIM_Y, Z1 + t), (axis) => (axis === 2 ? null : GLASS.edge));
  // Bottom pane: edges only; its broad faces are under the substrate and on
  // the desk.
  b.box(v3(X0 - t, yB - t, Z0 - t), v3(X1 + t, yB, Z1 + t), (axis) => (axis === 1 ? null : GLASS.edge));

  return b.build();
}

// ---------------------------------------------------------------------------
// Hardscape: driftwood and stones
// ---------------------------------------------------------------------------

/** Evaluate a Catmull-Rom spline through `pts` at `t` in [0, 1]. */
function catmullRom(pts: Vec3[], t: number): Vec3 {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n, i + 2)];
  const c = (a: number, b: number, c2: number, d: number): number =>
    0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
  return v3(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y), c(p0.z, p1.z, p2.z, p3.z));
}

interface TubeOptions {
  kind: number;
  sides: number;
  /** Samples per metre along the spine. */
  density: number;
  /** Radius at t in [0, 1]. */
  radius: (t: number) => number;
  /** Surface roughness: radial displacement at (t, angle, arc length). */
  relief?: (t: number, angle: number, s: number) => number;
  /** Sway weight written to `aExtra.y`, at t. */
  sway?: (t: number) => number;
  /** Close the near end with a flat cap. */
  capStart?: boolean;
  /** Close the far end with a cone. */
  capEnd?: boolean;
}

/**
 * A tube along a spline, with frames carried along by parallel transport so
 * the rings do not twist. Returns the sampled spine.
 */
function tube(b: MeshBuilder, spine: Vec3[], o: TubeOptions): { p: Vec3; r: number }[] {
  // Arc length, roughly, to choose the sampling.
  let approx = 0;
  for (let i = 1; i < spine.length; i++) approx += len(sub(v3(), spine[i], spine[i - 1]));
  const samples = Math.max(4, Math.ceil(approx * o.density));

  const pts: Vec3[] = [];
  for (let i = 0; i <= samples; i++) pts.push(catmullRom(spine, i / samples));

  const tangentAt = (i: number): Vec3 => {
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(samples, i + 1)];
    return normalize(v3(), sub(v3(), c, a));
  };

  // Initial frame.
  let T = tangentAt(0);
  const ref = Math.abs(T.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  let Nf = normalize(v3(), cross(v3(), cross(v3(), T, ref), T));

  const start = b.count;
  const out: { p: Vec3; r: number }[] = [];
  let s = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    if (i > 0) {
      s += len(sub(v3(), pts[i], pts[i - 1]));
      const T2 = tangentAt(i);
      // Parallel transport: remove the component of the old normal along the
      // new tangent.
      Nf = normalize(v3(), sub(v3(), Nf, scale(v3(), T2, dot(Nf, T2))));
      T = T2;
    }
    const B = cross(v3(), T, Nf);
    const r = o.radius(t);
    out.push({ p: pts[i], r });
    const sw = o.sway ? o.sway(t) : 0;
    for (let k = 0; k <= o.sides; k++) {
      const a = (k / o.sides) * Math.PI * 2;
      const dir = add(v3(), scale(v3(), Nf, Math.cos(a)), scale(v3(), B, Math.sin(a)));
      const rr = r * (1 + (o.relief ? o.relief(t, a, s) : 0));
      const p = add(v3(), pts[i], scale(v3(), dir, rr));
      b.vertex(p, dir, k / o.sides, s, o.kind, sw);
    }
  }
  const ring = o.sides + 1;
  for (let i = 0; i < samples; i++) {
    for (let k = 0; k < o.sides; k++) {
      const a = start + i * ring + k;
      const c = a + ring;
      b.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
  if (o.capStart) {
    // A sawn or broken end: a flat disc.
    const t0 = tangentAt(0);
    const centre = add(v3(), pts[0], scale(v3(), t0, -o.radius(0) * 0.15));
    const ci = b.vertex(centre, scale(v3(), t0, -1), 0.5, -o.radius(0), o.kind, o.sway ? o.sway(0) : 0);
    for (let k = 0; k < o.sides; k++) b.idx.push(start + k + 1, start + k, ci);
  }
  if (o.capEnd) {
    const last = start + samples * ring;
    const tip = add(v3(), pts[samples], scale(v3(), T, o.radius(1) * 1.2));
    const ti = b.vertex(tip, T, 0.5, s + o.radius(1), o.kind, o.sway ? o.sway(1) : 0);
    for (let k = 0; k < o.sides; k++) b.idx.push(last + k, last + k + 1, ti);
  }
  return out;
}

interface Branch {
  spine: Vec3[];
  r0: number;
  r1: number;
  capStart?: boolean;
  capEnd: boolean;
}

/** Driftwood spine points are given relative to the sand, then dropped onto it. */
const onSand = (x: number, lift: number, z: number): Vec3 => v3(x, sandHeight(x, z) + lift, z);

/**
 * The driftwood: a gnarled trunk lying diagonally from the back-left corner,
 * propped up there, with two branches rising from it.
 *
 * Malaysian-style bogwood, which is dense, dark and sinks by itself, and is
 * what leaches the tannins `OPTICS.tannin` tints the water with.
 */
const DRIFTWOOD: Branch[] = [
  {
    // Trunk. The front end is buried in the sand, which is how a piece this
    // size is usually set.
    spine: [
      onSand(-0.157, 0.030, -0.231),
      onSand(-0.137, 0.021, -0.212),
      onSand(-0.112, 0.011, -0.186),
      onSand(-0.072, 0.004, -0.158),
      onSand(-0.036, -0.002, -0.140),
      onSand(-0.012, -0.008, -0.132),
    ],
    r0: 0.0095,
    r1: 0.0045,
    capStart: true,
    capEnd: false,
  },
  {
    // A branch rising into the back-left corner.
    spine: [
      onSand(-0.128, 0.014, -0.199),
      onSand(-0.120, 0.030, -0.214),
      onSand(-0.106, 0.047, -0.226),
      onSand(-0.098, 0.060, -0.238),
    ],
    r0: 0.0052,
    r1: 0.0016,
    capEnd: true,
  },
  {
    // A shorter one leaning back and right.
    spine: [
      onSand(-0.086, 0.007, -0.168),
      onSand(-0.072, 0.020, -0.186),
      onSand(-0.054, 0.029, -0.212),
      onSand(-0.046, 0.034, -0.228),
    ],
    r0: 0.0042,
    r1: 0.0013,
    capEnd: true,
  },
  {
    // A twig off the rising branch.
    spine: [onSand(-0.112, 0.040, -0.221), onSand(-0.126, 0.050, -0.229), onSand(-0.140, 0.055, -0.232)],
    r0: 0.0022,
    r1: 0.0009,
    capEnd: true,
  },
];

interface Stone {
  x: number;
  z: number;
  /** Half-extents before rotation. */
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  /** How much of the stone's height is buried, 0 to 1. */
  buried: number;
  seed: number;
}

/**
 * Stones: a main group right of centre and pebbles at the front left. Kept
 * under about a centimetre and a half above the sand, because the fish cannot
 * see them: the brain never steers its centre lower than 2.6 cm above the
 * front of the sand, which puts its belly about there over the stones.
 */
const STONES: Stone[] = [
  { x: 0.094, z: -0.128, sx: 0.024, sy: 0.0135, sz: 0.018, yaw: 0.5, buried: 0.38, seed: 11 },
  { x: 0.124, z: -0.098, sx: 0.015, sy: 0.012, sz: 0.012, yaw: 2.1, buried: 0.3, seed: 23 },
  { x: 0.066, z: -0.104, sx: 0.010, sy: 0.008, sz: 0.009, yaw: 1.2, buried: 0.3, seed: 37 },
  { x: 0.146, z: -0.140, sx: 0.012, sy: 0.010, sz: 0.010, yaw: 0.2, buried: 0.3, seed: 41 },
  { x: -0.118, z: -0.052, sx: 0.009, sy: 0.006, sz: 0.008, yaw: 0.9, buried: 0.25, seed: 53 },
  { x: -0.097, z: -0.038, sx: 0.006, sy: 0.004, sz: 0.005, yaw: 2.6, buried: 0.25, seed: 61 },
  { x: -0.136, z: -0.034, sx: 0.005, sy: 0.0035, sz: 0.0045, yaw: 1.7, buried: 0.25, seed: 67 },
  { x: -0.020, z: -0.118, sx: 0.006, sy: 0.004, sz: 0.005, yaw: 0.4, buried: 0.3, seed: 71 },
];

/** An icosphere, subdivided `levels` times, as unit vectors and triangles. */
function icosphere(levels: number): { dirs: Vec3[]; tris: number[] } {
  const p = (1 + Math.sqrt(5)) / 2;
  const dirs: Vec3[] = [
    [-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0],
    [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p],
    [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1],
  ].map(([x, y, z]) => normalize(v3(), v3(x, y, z)));
  let tris = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const hit = mid.get(k);
      if (hit !== undefined) return hit;
      const m = normalize(v3(), add(v3(), dirs[a], dirs[b]));
      dirs.push(m);
      mid.set(k, dirs.length - 1);
      return dirs.length - 1;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  return { dirs, tris };
}

/**
 * One stone: a lumpy sphere cut by a few planes.
 *
 * The planes are what make it read as rock rather than as a potato. Real
 * aquascaping stone (seiryu, the grey limestone used here) is broken rather
 * than worn, so it has flat faces meeting at edges, and noise alone never
 * produces those.
 */
function addStone(b: MeshBuilder, s: Stone, sphere: { dirs: Vec3[]; tris: number[] }): void {
  const rng = new Rng(0x57013 + s.seed * 7919);
  const planes: { n: Vec3; d: number }[] = [];
  const cuts = 6 + rng.int(3);
  for (let i = 0; i < cuts; i++) {
    const a = (i / cuts) * Math.PI * 2 + rng.sym(0.4);
    const up = rng.range(-0.1, 0.8);
    const n = normalize(v3(), v3(Math.cos(a), up, Math.sin(a)));
    planes.push({ n, d: rng.range(0.5, 0.75) });
  }
  // Nearly always a flattish top.
  planes.push({ n: normalize(v3(), v3(rng.sym(0.3), 1, rng.sym(0.3))), d: rng.range(0.6, 0.75) });

  const cy = Math.cos(s.yaw);
  const sy = Math.sin(s.yaw);
  const centreY = sandHeight(s.x, s.z) + s.sy * (1 - 2 * s.buried);
  const start = b.count;
  for (const d of sphere.dirs) {
    let r = 1 + 0.2 * fbm3(d.x * 1.6, d.y * 1.6, d.z * 1.6, s.seed);
    const p = scale(v3(), d, r);
    for (const pl of planes) {
      const h = dot(p, pl.n);
      if (h > pl.d) {
        const cut = scale(v3(), pl.n, (h - pl.d) * 0.94);
        sub(p, p, cut);
      }
    }
    // Fine pitting, after the cuts so the faces are not perfectly flat.
    r = 1 + 0.025 * valueNoise3(d.x * 9, d.y * 9, d.z * 9, s.seed ^ 0x51);
    scale(p, p, r);
    const lx = p.x * s.sx;
    const ly = p.y * s.sy;
    const lz = p.z * s.sz;
    const w = v3(s.x + lx * cy - lz * sy, centreY + ly, s.z + lx * sy + lz * cy);
    b.vertex(w, d, 0, 0, SURFACE.stone, 0);
  }
  for (let i = 0; i < sphere.tris.length; i += 3) {
    b.tri(start + sphere.tris[i], start + sphere.tris[i + 1], start + sphere.tris[i + 2]);
  }
  b.smoothNormals(start);
}

export function buildHardscape(): BuiltMesh {
  const b = new MeshBuilder();

  for (const [bi, br] of DRIFTWOOD.entries()) {
    const start = b.count;
    tube(b, br.spine, {
      kind: SURFACE.wood,
      sides: 14,
      density: 420,
      radius: (t) => br.r0 + (br.r1 - br.r0) * Math.pow(t, 0.8),
      // Gnarl and flutes. Driftwood is wood with the soft parts rotted and
      // worn away, so what is left is ridged along the grain and knotted.
      relief: (t, a, s) => {
        // Knots: a few swellings along the length.
        const knot = Math.max(0, valueNoise3(s * 40, 0.5, 0.5, 0x2b + bi)) * 0.9;
        // Flutes running with the grain, twisting slowly along the branch.
        const flute = Math.abs(Math.sin(a * 3 + s * 45 + bi * 2)) - 0.5;
        return (
          0.30 * valueNoise3(s * 55, Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0x3d + bi) +
          0.14 * flute +
          knot +
          0.08 * valueNoise3(s * 260, Math.cos(a) * 3, Math.sin(a) * 3, 0x7f + bi)
        );
      },
      capStart: br.capStart,
      capEnd: br.capEnd,
    });
    b.smoothNormals(start);
  }

  const sphere = icosphere(3);
  for (const s of STONES) addStone(b, s, sphere);

  return b.build();
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

interface LeafSpec {
  base: Vec3;
  /** Compass direction the leaf grows towards, radians (0 = +x). */
  heading: number;
  /** Angle above horizontal where it leaves the stem or crown, radians. */
  rise: number;
  /** How far the angle falls over the length of the leaf, radians. */
  droop: number;
  length: number;
  width: number;
  shape: 'lance' | 'ribbon' | 'blade' | 'oval';
  species: number;
  /** Bare stalk, as a fraction of the length. */
  petiole?: number;
  /** Twist about the leaf's own axis over its length, radians. */
  twist?: number;
  /** Fold along the midrib: the depth of the V, relative to the half-width. */
  fold?: number;
  /** Wavy margins, relative to the half-width. */
  ruffle?: number;
  /** Sway at the base, and added towards the tip, in metres. */
  swayBase?: number;
  sway: number;
  segments?: number;
  seed?: number;
}

/** Leaves stay this far under the still waterline; ribbons that reach it trail along it. */
const SURFACE_CLEARANCE = 0.003;

function widthProfile(shape: LeafSpec['shape'], t: number): number {
  switch (shape) {
    case 'lance':
      return Math.sin(Math.PI * Math.pow(t, 0.75));
    case 'ribbon':
      return Math.min(1, (1 - t) / 0.12) * (0.8 + 0.2 * Math.min(1, t / 0.06));
    case 'blade':
      return Math.pow(1 - t, 0.8);
    case 'oval':
      return Math.pow(Math.sin(Math.PI * t), 0.7);
  }
}

/**
 * A leaf as a strip three vertices wide — edge, midrib, edge — so it can be
 * folded along the midrib. A flat quad strip lights as one flat plane; the
 * fold gives each half its own angle to the light, which is most of what
 * makes a leaf look like a leaf.
 */
function addLeaf(b: MeshBuilder, L: LeafSpec): void {
  const SEG = L.segments ?? 10;
  const petiole = L.petiole ?? 0;
  const fold = L.fold ?? 0.15;
  const ruffle = L.ruffle ?? 0;
  const twist = L.twist ?? 0;
  const seed = L.seed ?? 0;
  const kind = leafKind(L.species);
  const ceiling = TANK.waterY - SURFACE_CLEARANCE;

  const ch = Math.cos(L.heading);
  const sh = Math.sin(L.heading);
  const p = v3(L.base.x, L.base.y, L.base.z);
  const step = L.length / SEG;
  const start = b.count;

  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    let angle = L.rise - L.droop * t;
    if (p.y >= ceiling - 1e-4) angle = Math.min(angle, 0);
    const tangent = v3(Math.cos(angle) * ch, Math.sin(angle), Math.cos(angle) * sh);
    // Across the blade: horizontal and square to the heading, then twisted
    // about the leaf's axis.
    const side0 = v3(-sh, 0, ch);
    const up0 = cross(v3(), side0, tangent);
    const tw = twist * t + Math.sin(seed + t * 4) * 0.15;
    const side = add(v3(), scale(v3(), side0, Math.cos(tw)), scale(v3(), up0, Math.sin(tw)));
    const n = normalize(v3(), cross(v3(), tangent, side));

    const blade = t < petiole ? 0 : widthProfile(L.shape, (t - petiole) / (1 - petiole));
    // A stalk keeps a little width so it does not vanish.
    const half = Math.max(blade * L.width * 0.5, t < petiole ? L.width * 0.05 : 0);
    const wave = ruffle * half * Math.sin(t * 38 + seed * 3);
    const keel = fold * half;

    const left = add(v3(), p, scale(v3(), side, -half));
    add(left, left, scale(v3(), n, wave));
    const right = add(v3(), p, scale(v3(), side, half));
    add(right, right, scale(v3(), n, -wave));
    const mid = add(v3(), p, scale(v3(), n, -keel));

    const nL = normalize(v3(), add(v3(), n, scale(v3(), side, fold)));
    const nR = normalize(v3(), sub(v3(), n, scale(v3(), side, fold)));
    const sway = (L.swayBase ?? 0) + L.sway * t * t;
    // A ribbon that has reached the surface lies flat along it.
    for (const q of [left, mid, right]) q.y = Math.min(q.y, ceiling);
    b.vertex(left, nL, 0, t, kind, sway);
    b.vertex(mid, n, 0.5, t, kind, sway);
    b.vertex(right, nR, 1, t, kind, sway);

    // Step along the leaf, staying under the surface.
    add(p, p, scale(v3(), tangent, step));
    if (p.y > ceiling) p.y = ceiling;
  }
  for (let i = 0; i < SEG; i++) {
    const a = start + i * 3;
    b.idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
  }
}

const rootAt = (x: number, z: number, sink = 0.001): Vec3 => v3(x, sandHeight(x, z) - sink, z);

export function buildPlantsMesh(): BuiltMesh {
  const b = new MeshBuilder();
  const rng = new Rng(0x9a47f00d);

  // --- Amazon sword, behind the middle ---
  {
    const c = rootAt(0.032, -0.178);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const heading = (i / n) * Math.PI * 2 + rng.sym(0.25);
      addLeaf(b, {
        base: v3(c.x + Math.cos(heading) * 0.003, c.y, c.z + Math.sin(heading) * 0.003),
        heading,
        rise: rng.range(1.05, 1.35),
        droop: rng.range(0.7, 1.1),
        length: rng.range(0.058, 0.074),
        width: rng.range(0.016, 0.021),
        shape: 'lance',
        species: LEAF.sword,
        petiole: 0.3,
        fold: 0.22,
        twist: rng.sym(0.3),
        sway: 0.0028,
        segments: 12,
        seed: i * 1.7,
      });
    }
    // The resting leaf: broad, reaching forward and left at mid-depth over the
    // area the brain picks rest spots in (see Brain.pickRestTarget).
    addLeaf(b, {
      base: c,
      heading: Math.PI * 0.62,
      rise: 0.95,
      droop: 1.05,
      length: 0.078,
      width: 0.026,
      shape: 'lance',
      species: LEAF.sword,
      petiole: 0.28,
      fold: 0.12,
      sway: 0.0022,
      segments: 14,
      seed: 4.2,
    });
  }

  // --- Vallisneria along the back right ---
  for (let i = 0; i < 17; i++) {
    const x = 0.02 + (i / 16) * 0.13 + rng.sym(0.006);
    const z = -0.226 + rng.sym(0.006);
    addLeaf(b, {
      base: rootAt(x, z),
      // Mostly leaning forward, away from the back glass: the ones that reach
      // the surface then trail along it towards the front, with the current.
      heading: Math.PI / 2 + rng.sym(1.1),
      rise: rng.range(1.42, 1.54),
      droop: rng.range(0.15, 0.45),
      length: rng.range(0.07, 0.105),
      width: rng.range(0.0045, 0.0065),
      shape: 'ribbon',
      species: LEAF.vallis,
      twist: rng.range(0.8, 2.2) * (rng.bool() ? 1 : -1),
      fold: 0.05,
      sway: rng.range(0.004, 0.006),
      segments: 16,
      seed: i * 2.3,
    });
  }

  // --- Red-topped stem plants on the right ---
  for (let k = 0; k < 6; k++) {
    const x = 0.140 + rng.sym(0.014);
    const z = -0.172 + rng.sym(0.016);
    const height = rng.range(0.048, 0.064);
    const lean = rng.range(0, Math.PI * 2);
    const bend = rng.range(0.004, 0.009);
    const base = rootAt(x, z, 0.002);
    const stemPoint = (t: number): Vec3 =>
      v3(
        base.x + Math.cos(lean) * bend * t * t,
        base.y + height * t,
        base.z + Math.sin(lean) * bend * t * t,
      );
    const stemSway = 0.003;
    tube(b, [stemPoint(0), stemPoint(0.33), stemPoint(0.66), stemPoint(1)], {
      kind: leafKind(LEAF.stem),
      sides: 5,
      density: 250,
      radius: () => 0.0009,
      sway: (t) => stemSway * t * t,
      capEnd: true,
    });
    // Opposite pairs of leaves, each pair at right angles to the last.
    const nodes = Math.floor(height / 0.0045);
    for (let j = 1; j <= nodes; j++) {
      const t = j / nodes;
      const at = stemPoint(t);
      const phase = j * (Math.PI / 2) + k;
      const size = 0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      for (const side of [0, Math.PI]) {
        addLeaf(b, {
          base: at,
          heading: phase + side,
          rise: 0.35 + t * 0.5,
          droop: 0.5,
          length: 0.011 * size,
          width: 0.0034 * size,
          shape: 'oval',
          species: LEAF.redStem,
          fold: 0.25,
          swayBase: stemSway * t * t,
          sway: 0.0006,
          segments: 5,
          seed: j + k,
        });
      }
    }
  }

  // --- Java fern, tied onto the driftwood ---
  {
    const rhizome = onSand(-0.124, 0.022, -0.196);
    for (let i = 0; i < 6; i++) {
      addLeaf(b, {
        base: v3(rhizome.x + rng.sym(0.004), rhizome.y, rhizome.z + rng.sym(0.004)),
        heading: -0.2 + (i / 5) * 2.4 + rng.sym(0.2),
        rise: rng.range(0.7, 1.15),
        droop: rng.range(0.6, 1.0),
        length: rng.range(0.032, 0.046),
        width: rng.range(0.008, 0.011),
        shape: 'lance',
        species: LEAF.javaFern,
        petiole: 0.12,
        fold: 0.3,
        ruffle: 0.08,
        twist: rng.sym(0.4),
        sway: 0.0016,
        segments: 10,
        seed: i * 3.1,
      });
    }
  }

  // --- Cryptocorynes at the front left ---
  for (const [cx, cz, count] of [
    [-0.148, -0.078, 7],
    [-0.070, -0.066, 6],
    [-0.150, -0.128, 5],
  ] as [number, number, number][]) {
    const c = rootAt(cx, cz);
    for (let i = 0; i < count; i++) {
      const heading = (i / count) * Math.PI * 2 + rng.sym(0.3);
      addLeaf(b, {
        base: c,
        heading,
        rise: rng.range(0.95, 1.3),
        droop: rng.range(0.9, 1.4),
        length: rng.range(0.026, 0.036),
        width: rng.range(0.009, 0.012),
        shape: 'lance',
        species: LEAF.crypt,
        petiole: 0.35,
        fold: 0.2,
        ruffle: 0.22,
        sway: 0.0012,
        segments: 9,
        seed: i * 1.3 + cx * 10,
      });
    }
  }

  // --- A carpet of hairgrass across the front ---
  //
  // Tufts rather than evenly spread blades: it spreads by runners, and a
  // uniform lawn is the giveaway of a planted-by-computer carpet.
  const tufts: [number, number][] = [];
  while (tufts.length < 90) {
    const x = rng.range(-0.05, 0.165);
    const z = rng.range(-0.075, -0.012);
    // Clear of the stones.
    if (STONES.some((s) => Math.hypot(s.x - x, s.z - z) < Math.max(s.sx, s.sz) + 0.004)) continue;
    // Thinner towards the left, where it runs out against the crypts.
    if (x < 0 && rng.next() > 0.4 + (x + 0.05) * 8) continue;
    tufts.push([x, z]);
  }
  for (const [x, z] of tufts) {
    const blades = 12 + rng.int(10);
    for (let i = 0; i < blades; i++) {
      const bx = x + rng.sym(0.0035);
      const bz = z + rng.sym(0.0035);
      addLeaf(b, {
        base: rootAt(bx, bz),
        heading: rng.range(0, Math.PI * 2),
        rise: rng.range(1.15, 1.5),
        droop: rng.range(0.1, 0.6),
        length: rng.range(0.009, 0.022),
        width: rng.range(0.0006, 0.0009),
        shape: 'blade',
        species: LEAF.hairgrass,
        fold: 0,
        sway: 0.0009,
        segments: 4,
        seed: i,
      });
    }
  }

  return b.build();
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** The desk the tank stands on, as (min, max) of its top slab. */
export const DESK = {
  min: v3(-0.62, DESK_Y - 0.032, -0.42),
  max: v3(0.62, DESK_Y, 0.10),
} as const;

/**
 * A plain room around the tank: floor, four walls, a ceiling, a desk, and the
 * lamp hanging over the tank.
 *
 * It is deliberately undetailed. With the eye focused on a fish half a metre
 * away, a wall a metre and a half behind it is well out of focus, so anything
 * sharp on it would look wrong. The shading in ROOM_FRAG is soft gradients
 * for the same reason.
 */
export function buildRoomMesh(): BuiltMesh {
  const b = new MeshBuilder();
  const R = ROOM;
  const face = (kind: number) => (): number => kind;

  // Walls, floor and ceiling, as the inside of a box. Each face is split into
  // a grid so the per-vertex refraction shift in SCENE_VERT stays smooth where
  // the wall is seen through the tank.
  const grid = (
    corner: Vec3,
    du: Vec3,
    dv: Vec3,
    nu: number,
    nv: number,
    n: Vec3,
    kind: number,
  ): void => {
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p = (a: number, c: number): Vec3 =>
          add(v3(), corner, add(v3(), scale(v3(), du, a / nu), scale(v3(), dv, c / nv)));
        b.quad(p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1), n, kind);
      }
    }
  };
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  const H = R.ceilingY - R.floorY;
  grid(v3(R.minX, R.floorY, R.minZ), v3(W, 0, 0), v3(0, H, 0), 24, 16, v3(0, 0, 1), ROOM_SURFACE.wall);
  grid(v3(R.minX, R.floorY, R.maxZ), v3(W, 0, 0), v3(0, H, 0), 8, 6, v3(0, 0, -1), ROOM_SURFACE.wall);
  grid(v3(R.minX, R.floorY, R.minZ), v3(0, 0, D), v3(0, H, 0), 12, 8, v3(1, 0, 0), ROOM_SURFACE.wall);
  grid(v3(R.maxX, R.floorY, R.minZ), v3(0, 0, D), v3(0, H, 0), 12, 8, v3(-1, 0, 0), ROOM_SURFACE.wall);
  grid(v3(R.minX, R.floorY, R.minZ), v3(W, 0, 0), v3(0, 0, D), 12, 12, v3(0, 1, 0), ROOM_SURFACE.floor);
  grid(v3(R.minX, R.ceilingY, R.minZ), v3(W, 0, 0), v3(0, 0, D), 4, 4, v3(0, -1, 0), ROOM_SURFACE.ceiling);

  // Skirting boards.
  const sk = 0.07;
  const st = 0.012;
  b.box(v3(R.minX, R.floorY, R.minZ), v3(R.maxX, R.floorY + sk, R.minZ + st), face(ROOM_SURFACE.skirting));
  b.box(v3(R.minX, R.floorY, R.maxZ - st), v3(R.maxX, R.floorY + sk, R.maxZ), face(ROOM_SURFACE.skirting));
  b.box(v3(R.minX, R.floorY, R.minZ), v3(R.minX + st, R.floorY + sk, R.maxZ), face(ROOM_SURFACE.skirting));
  b.box(v3(R.maxX - st, R.floorY, R.minZ), v3(R.maxX, R.floorY + sk, R.maxZ), face(ROOM_SURFACE.skirting));

  // The desk: a top slab, and a cabinet under it set back a little.
  const top = DESK;
  b.box(top.min, top.max, (axis, sign) => (axis === 1 && sign === 1 ? ROOM_SURFACE.deskTop : ROOM_SURFACE.deskBody));
  b.box(
    v3(top.min.x + 0.02, R.floorY + 0.06, top.min.z + 0.02),
    v3(top.max.x - 0.02, top.min.y, top.max.z - 0.025),
    face(ROOM_SURFACE.deskBody),
  );
  // Plinth, recessed.
  b.box(
    v3(top.min.x + 0.05, R.floorY, top.min.z + 0.05),
    v3(top.max.x - 0.05, R.floorY + 0.06, top.max.z - 0.06),
    face(ROOM_SURFACE.skirting),
  );

  // The lamp: a slim bar across the tank, hung from the ceiling on two
  // cables. `envColour` in the shaders puts its reflection in the water
  // surface at this height and width.
  const lampHalfW = TANK.width * 0.45;
  const zMid = TANK_MIN_Z / 2;
  const rim = LAMP_HALF_DEPTH + 0.006;
  b.box(
    v3(-lampHalfW - 0.01, LAMP_Y, zMid - rim),
    v3(lampHalfW + 0.01, LAMP_Y + 0.011, zMid + rim),
    (axis, sign) => (axis === 1 && sign === -1 ? null : ROOM_SURFACE.lampHousing),
  );
  // The emitting strip, just under the housing.
  b.quad(
    v3(-lampHalfW, LAMP_Y - 0.0005, zMid - LAMP_HALF_DEPTH),
    v3(lampHalfW, LAMP_Y - 0.0005, zMid - LAMP_HALF_DEPTH),
    v3(lampHalfW, LAMP_Y - 0.0005, zMid + LAMP_HALF_DEPTH),
    v3(-lampHalfW, LAMP_Y - 0.0005, zMid + LAMP_HALF_DEPTH),
    v3(0, -1, 0),
    ROOM_SURFACE.lampEmitter,
  );
  // Housing underside around the strip.
  for (const [z0, z1] of [
    [zMid - rim, zMid - LAMP_HALF_DEPTH],
    [zMid + LAMP_HALF_DEPTH, zMid + rim],
  ]) {
    b.quad(
      v3(-lampHalfW - 0.01, LAMP_Y, z0),
      v3(lampHalfW + 0.01, LAMP_Y, z0),
      v3(lampHalfW + 0.01, LAMP_Y, z1),
      v3(-lampHalfW - 0.01, LAMP_Y, z1),
      v3(0, -1, 0),
      ROOM_SURFACE.lampHousing,
    );
  }
  for (const x of [-lampHalfW + 0.02, lampHalfW - 0.02]) {
    b.box(
      v3(x - 0.0008, LAMP_Y + 0.011, zMid - 0.0008),
      v3(x + 0.0008, R.ceilingY, zMid + 0.0008),
      face(ROOM_SURFACE.lampHousing),
    );
  }

  return b.build();
}
