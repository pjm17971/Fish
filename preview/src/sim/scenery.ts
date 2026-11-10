/**
 * Where everything in the tank is: the sand, the driftwood, the stones and
 * the plants.
 *
 * This is the layout only, with no drawing in it. The renderer builds its
 * meshes from it (render/scenery.ts), and the fish finds its way round the
 * same things (obstacles.ts), so what the fish avoids is exactly what is
 * drawn. It used to live in the renderer alone, and the fish swam through the
 * driftwood because it had no way of knowing the wood was there.
 *
 * Everything is fixed: built from constants and a fixed seed, the same every
 * run.
 */

import { TANK, TANK_MIN_Z } from './config.js';
import { Rng } from './rng.js';
import { v3, Vec3 } from './math.js';

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


/** Evaluate a Catmull-Rom spline through `pts` at `t` in [0, 1]. */
export function catmullRom(pts: Vec3[], t: number): Vec3 {
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


export interface Branch {
  spine: Vec3[];
  r0: number;
  r1: number;
  capStart?: boolean;
  capEnd: boolean;
}

/** Driftwood spine points are given relative to the sand, then dropped onto it. */
export const onSand = (x: number, lift: number, z: number): Vec3 => v3(x, sandHeight(x, z) + lift, z);

/**
 * The driftwood: a gnarled trunk lying diagonally from the back-left corner,
 * propped up there, with two branches rising from it.
 *
 * Malaysian-style bogwood, which is dense, dark and sinks by itself, and is
 * what leaches the tannins `OPTICS.tannin` tints the water with.
 */
export const DRIFTWOOD: Branch[] = [
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

export interface Stone {
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
 * under about a centimetre and a half above the sand.
 */
export const STONES: Stone[] = [
  { x: 0.094, z: -0.128, sx: 0.024, sy: 0.0135, sz: 0.018, yaw: 0.5, buried: 0.38, seed: 11 },
  { x: 0.124, z: -0.098, sx: 0.015, sy: 0.012, sz: 0.012, yaw: 2.1, buried: 0.3, seed: 23 },
  { x: 0.066, z: -0.104, sx: 0.010, sy: 0.008, sz: 0.009, yaw: 1.2, buried: 0.3, seed: 37 },
  { x: 0.146, z: -0.140, sx: 0.012, sy: 0.010, sz: 0.010, yaw: 0.2, buried: 0.3, seed: 41 },
  { x: -0.118, z: -0.052, sx: 0.009, sy: 0.006, sz: 0.008, yaw: 0.9, buried: 0.25, seed: 53 },
  { x: -0.097, z: -0.038, sx: 0.006, sy: 0.004, sz: 0.005, yaw: 2.6, buried: 0.25, seed: 61 },
  { x: -0.136, z: -0.034, sx: 0.005, sy: 0.0035, sz: 0.0045, yaw: 1.7, buried: 0.25, seed: 67 },
  { x: -0.020, z: -0.118, sx: 0.006, sy: 0.004, sz: 0.005, yaw: 0.4, buried: 0.3, seed: 71 },
];

/** Plant species, written into the leaf meshes for the shader. */
export const LEAF = {
  sword: 0,
  vallis: 1,
  hairgrass: 2,
  redStem: 3,
  stem: 4,
  javaFern: 5,
  crypt: 6,
} as const;

export interface LeafSpec {
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
export const SURFACE_CLEARANCE = 0.003;

/** How wide a leaf of each shape is at `t` along it, 0 to 1 of its full width. */
export function widthProfile(shape: LeafSpec['shape'], t: number): number {
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

/** A point along a leaf's midrib. */
export interface MidribPoint {
  /** Position, before the leaf's edges are pressed under the surface. */
  p: Vec3;
  /** Direction the leaf runs in here. */
  tangent: Vec3;
  /** 0 at the base, 1 at the tip. */
  t: number;
}

/**
 * The line down the middle of a leaf, from its base to its tip: it leaves at
 * `rise` above horizontal and droops by `droop` over its length, and a leaf
 * that reaches the surface runs along under it.
 */
export function leafMidrib(L: LeafSpec): MidribPoint[] {
  const SEG = L.segments ?? 10;
  const ceiling = TANK.waterY - SURFACE_CLEARANCE;
  const ch = Math.cos(L.heading);
  const sh = Math.sin(L.heading);
  const p = v3(L.base.x, L.base.y, L.base.z);
  const step = L.length / SEG;
  const out: MidribPoint[] = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    let angle = L.rise - L.droop * t;
    if (p.y >= ceiling - 1e-4) angle = Math.min(angle, 0);
    const tangent = v3(Math.cos(angle) * ch, Math.sin(angle), Math.cos(angle) * sh);
    out.push({ p: v3(p.x, p.y, p.z), tangent, t });
    p.x += tangent.x * step;
    p.y += tangent.y * step;
    p.z += tangent.z * step;
    if (p.y > ceiling) p.y = ceiling;
  }
  return out;
}

/** A plant stem: a thin tube up a spline, carrying leaves of its own. */
export interface StemSpec {
  spine: Vec3[];
  radius: number;
  /** How far the top of the stem sways, in metres; it grows as the square of height. */
  sway: number;
}

export type PlantPart = { kind: 'leaf'; leaf: LeafSpec } | { kind: 'stem'; stem: StemSpec };

let plantCache: PlantPart[] | null = null;

/** Every leaf and stem in the tank, in the order they are drawn. */
export function plantLayout(): PlantPart[] {
  if (!plantCache) plantCache = layOutPlants();
  return plantCache;
}

const rootAt = (x: number, z: number, sink = 0.001): Vec3 => v3(x, sandHeight(x, z) - sink, z);

function layOutPlants(): PlantPart[] {
  const parts: PlantPart[] = [];
  const leaf = (spec: LeafSpec): void => {
    parts.push({ kind: 'leaf', leaf: spec });
  };
  const rng = new Rng(0x9a47f00d);

  // --- Amazon sword, behind the middle ---
  {
    const c = rootAt(0.032, -0.178);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const heading = (i / n) * Math.PI * 2 + rng.sym(0.25);
      leaf({
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
    leaf({
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
    leaf({
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
    parts.push({
      kind: 'stem',
      stem: { spine: [stemPoint(0), stemPoint(0.33), stemPoint(0.66), stemPoint(1)], radius: 0.0009, sway: stemSway },
    });
    // Opposite pairs of leaves, each pair at right angles to the last.
    const nodes = Math.floor(height / 0.0045);
    for (let j = 1; j <= nodes; j++) {
      const t = j / nodes;
      const at = stemPoint(t);
      const phase = j * (Math.PI / 2) + k;
      const size = 0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      for (const side of [0, Math.PI]) {
        leaf({
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
      leaf({
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
      leaf({
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
      leaf({
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

  return parts;
}
