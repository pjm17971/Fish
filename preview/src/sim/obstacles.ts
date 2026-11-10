/**
 * The things in the tank the fish has to get round: what it can feel, bump
 * into and plan a way past.
 *
 * Two kinds, because a fish treats them very differently.
 *
 *   - **Hard**: the driftwood and the stones. Nothing gets through them, fish
 *     or fin. They are described as simple solid shapes laid over the drawn
 *     ones: each branch as a run of tapering rods along its spline, each stone
 *     as a squashed ball. The question asked of them is "how far is this point
 *     from the nearest solid surface, and which way is out?"
 *
 *   - **Soft**: the plants. A betta goes into plants all the time, to rest, to
 *     hide, to pick its way through; the leaves bend out of its way and spring
 *     back. They are kept as points along the middle of each leaf and stem,
 *     each with the leaf's half-width there and how freely it bends. The
 *     question asked of them is "how much plant is around here?"
 *
 * Built from the same layout the renderer draws (scenery.ts), so the shapes
 * the fish avoids are the shapes on screen.
 */

import { Vec3, set } from './math.js';
import { DRIFTWOOD, STONES, LEAF, catmullRom, sandHeight, plantLayout, leafMidrib, widthProfile } from './scenery.js';

/**
 * How much fatter the solid rods are than the branch's smooth radius. The
 * drawn wood is knotted and fluted on top of that radius; measured against
 * the drawn mesh, this puts nineteen in twenty of its vertices inside the
 * rods (see obstacles.test.ts).
 */
export const WOOD_RELIEF = 1.3;
/** Stones are cut and pitted inside their bounding ball; it is a little generous. */
const STONE_FIT = 1.0;

/** A rod from a to b whose radius tapers from ra to rb. */
interface Rod {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  ra: number; rb: number;
  /** b - a, and its squared length. */
  dx: number; dy: number; dz: number; ll: number;
  /** Bounding box, grown by the radius. */
  min: Vec3; max: Vec3;
}

/** A squashed ball turned about the vertical. */
interface Ball {
  cx: number; cy: number; cz: number;
  rx: number; ry: number; rz: number;
  cos: number; sin: number;
  min: Vec3; max: Vec3;
}

/** A point down the middle of a leaf or stem. */
export interface PlantPoint {
  x: number; y: number; z: number;
  /** Half the leaf's width here, m. */
  half: number;
  /** How freely it gives, 0 at a rooted base to 1 at a free tip. */
  give: number;
}

const BIG = 1e3;

export class Obstacles {
  readonly rods: Rod[] = [];
  readonly balls: Ball[] = [];
  readonly plants: PlantPoint[] = [];
  /** Bounding box of everything hard, for a quick "nowhere near" answer. */
  readonly hardMin: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  readonly hardMax: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };

  constructor() {
    for (const br of DRIFTWOOD) {
      // Samples a centimetre or so apart: the branches bend gently.
      let approx = 0;
      for (let i = 1; i < br.spine.length; i++) {
        const a = br.spine[i - 1];
        const b = br.spine[i];
        approx += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      }
      const n = Math.max(3, Math.ceil(approx / 0.008));
      const radius = (t: number): number => (br.r0 + (br.r1 - br.r0) * Math.pow(t, 0.8)) * WOOD_RELIEF;
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        this.addRod(catmullRom(br.spine, t0), catmullRom(br.spine, t1), radius(t0), radius(t1));
      }
    }
    for (const s of STONES) {
      const rx = s.sx * STONE_FIT;
      const ry = s.sy * STONE_FIT;
      const rz = s.sz * STONE_FIT;
      const cy = sandHeight(s.x, s.z) + s.sy * (1 - 2 * s.buried);
      const r = Math.max(rx, rz);
      const ball: Ball = {
        cx: s.x, cy, cz: s.z, rx, ry, rz,
        cos: Math.cos(s.yaw), sin: Math.sin(s.yaw),
        min: { x: s.x - r, y: cy - ry, z: s.z - r },
        max: { x: s.x + r, y: cy + ry, z: s.z + r },
      };
      this.balls.push(ball);
      this.grow(ball.min, ball.max);
    }

    for (const part of plantLayout()) {
      if (part.kind === 'leaf') {
        const L = part.leaf;
        // The hairgrass is a lawn a centimetre or two high, under where the
        // fish swims: it bends under a fin and is not worth steering round.
        if (L.species === LEAF.hairgrass) continue;
        const petiole = L.petiole ?? 0;
        for (const { p, t } of leafMidrib(L)) {
          const blade = t < petiole ? 0.1 : widthProfile(L.shape, (t - petiole) / (1 - petiole));
          this.plants.push({ x: p.x, y: p.y, z: p.z, half: Math.max(0.0008, blade * L.width * 0.5), give: t * t });
        }
      } else {
        const st = part.stem;
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const p = catmullRom(st.spine, t);
          this.plants.push({ x: p.x, y: p.y, z: p.z, half: 0.003, give: t * t * 0.6 });
        }
      }
    }
  }

  private addRod(a: Vec3, b: Vec3, ra: number, rb: number): void {
    const r = Math.max(ra, rb);
    const rod: Rod = {
      ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra, rb,
      dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z,
      ll: (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2,
      min: { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, z: Math.min(a.z, b.z) - r },
      max: { x: Math.max(a.x, b.x) + r, y: Math.max(a.y, b.y) + r, z: Math.max(a.z, b.z) + r },
    };
    this.rods.push(rod);
    this.grow(rod.min, rod.max);
  }

  private grow(min: Vec3, max: Vec3): void {
    this.hardMin.x = Math.min(this.hardMin.x, min.x);
    this.hardMin.y = Math.min(this.hardMin.y, min.y);
    this.hardMin.z = Math.min(this.hardMin.z, min.z);
    this.hardMax.x = Math.max(this.hardMax.x, max.x);
    this.hardMax.y = Math.max(this.hardMax.y, max.y);
    this.hardMax.z = Math.max(this.hardMax.z, max.z);
  }

  /**
   * Distance from a point to the nearest hard surface: negative inside. If
   * `out` is given, it gets the direction out of that surface. Anything
   * further than `reach` may be reported as `reach` or more without the work.
   */
  hardDistance(x: number, y: number, z: number, out?: Vec3, reach = 0.03): number {
    if (
      x < this.hardMin.x - reach || x > this.hardMax.x + reach ||
      y < this.hardMin.y - reach || y > this.hardMax.y + reach ||
      z < this.hardMin.z - reach || z > this.hardMax.z + reach
    ) {
      if (out) set(out, 0, 1, 0);
      return BIG;
    }
    let best = BIG;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    for (const r of this.rods) {
      if (
        x < r.min.x - reach || x > r.max.x + reach ||
        y < r.min.y - reach || y > r.max.y + reach ||
        z < r.min.z - reach || z > r.max.z + reach
      ) continue;
      let t = ((x - r.ax) * r.dx + (y - r.ay) * r.dy + (z - r.az) * r.dz) / r.ll;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = x - (r.ax + r.dx * t);
      const qy = y - (r.ay + r.dy * t);
      const qz = z - (r.az + r.dz * t);
      const q = Math.sqrt(qx * qx + qy * qy + qz * qz);
      const d = q - (r.ra + (r.rb - r.ra) * t);
      if (d < best) {
        best = d;
        if (q > 1e-9) {
          nx = qx / q; ny = qy / q; nz = qz / q;
        }
      }
    }
    for (const b of this.balls) {
      if (
        x < b.min.x - reach || x > b.max.x + reach ||
        y < b.min.y - reach || y > b.max.y + reach ||
        z < b.min.z - reach || z > b.max.z + reach
      ) continue;
      // Into the stone's own frame.
      const px = x - b.cx;
      const py = y - b.cy;
      const pz = z - b.cz;
      const lx = px * b.cos + pz * b.sin;
      const lz = -px * b.sin + pz * b.cos;
      // A close and well-behaved estimate of the distance to an ellipsoid
      // (Quilez's): exact on the axes, and never far off between them.
      const ax = lx / b.rx, ay = py / b.ry, az = lz / b.rz;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const gx = lx / (b.rx * b.rx), gy = py / (b.ry * b.ry), gz = lz / (b.rz * b.rz);
      const k1 = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const d = k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(b.rx, b.ry, b.rz);
      if (d < best) {
        best = d;
        if (k1 > 1e-12) {
          // Back out of the stone's frame.
          nx = (gx * b.cos - gz * b.sin) / k1;
          ny = gy / k1;
          nz = (gx * b.sin + gz * b.cos) / k1;
        } else {
          nx = 0; ny = 1; nz = 0;
        }
      }
    }
    if (out) set(out, nx, ny, nz);
    return best;
  }

  /**
   * How much plant there is within `radius` of a point: the leaf area, in
   * square metres, of the midrib points inside it.
   */
  plantDensity(x: number, y: number, z: number, radius: number): number {
    let sum = 0;
    const r2 = radius * radius;
    for (const p of this.plants) {
      const dx = p.x - x;
      const dy = p.y - y;
      const dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz < r2) sum += p.half;
    }
    return sum;
  }
}

let shared: Obstacles | null = null;

/** The tank's obstacles. They never move, so there is one set. */
export function tankObstacles(): Obstacles {
  if (!shared) shared = new Obstacles();
  return shared;
}
