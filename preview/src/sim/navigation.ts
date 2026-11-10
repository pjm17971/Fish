/**
 * Finding a way round things.
 *
 * The brain decides where the fish wants to be; this works out how to get
 * there without going through the driftwood, and preferring the gaps between
 * plants to the middle of a clump. Before it, the fish steered straight at
 * wherever it wanted to be, and went through whatever was in the way.
 *
 * The water is divided into cubes eight millimetres across, and each cube
 * gets a cost: impassable where the fish's middle would put its body into
 * the wood, a stone, the sand or the glass, dearer the more plant there is
 * in it, and a little dearer close to the glass, where a fish this long has
 * no room to turn. The cheapest route through the cubes is found by the usual
 * shortest-path search (A*), and the fish then heads for the furthest point
 * along that route it can see in a straight, clear line: a fish looks where
 * it is going, it does not follow a staircase of cubes.
 *
 * When the straight line to where the fish wants to be is clear, which in
 * open water is nearly always, none of this changes anything.
 */

import { Vec3, v3, set, copy } from './math.js';
import { TANK, TANK_MIN_X, TANK_MAX_X, TANK_MIN_Z, TANK_MAX_Z } from './config.js';
import { Obstacles } from './obstacles.js';
import { sandHeight } from './scenery.js';

/** Edge of a cube, m. */
export const NAV_CELL = 0.008;
/**
 * How close the fish's middle may come to wood or stone. The body is 13.5 mm
 * deep, so its centreline is about 7 mm from its belly and back; the rest is
 * room for the fins.
 */
const HARD_CLEARANCE = 0.010;
/** Further out than this, wood and stone cost nothing extra. */
const HARD_COMFORT = 0.030;
/** How close the middle may come to a pane, and from where the glass starts to cost. */
const GLASS_CLEARANCE = 0.014;
const GLASS_COMFORT = 0.035;
/**
 * How much the plants cost, per unit of leaf within reach of a cube's middle.
 * At this rate going through the middle of the sword plant costs about five
 * times going round it, so the fish goes round it when there is a way round
 * that is not much longer, and threads a gap when there is one.
 */
const PLANT_COST = 160;
const PLANT_REACH = 0.018;

const BLOCKED = Infinity;

export class NavGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly x0 = TANK_MIN_X;
  readonly y0 = TANK.floorY;
  readonly z0 = TANK_MIN_Z;
  /** Extra cost of passing through each cube, 0 for open water; Infinity where the fish cannot be. */
  readonly cost: Float32Array;
  /** How much of each cube's cost is plant. */
  readonly plant: Float32Array;

  // Search state, kept between searches so planning does not allocate.
  private readonly g: Float32Array;
  private readonly from: Int32Array;
  private readonly closed: Uint8Array;
  private readonly stamp: Uint32Array;
  private search = 0;
  private heap: Int32Array;
  private heapF: Float32Array;
  private heapSize = 0;

  constructor(readonly obstacles: Obstacles) {
    this.nx = Math.round((TANK_MAX_X - TANK_MIN_X) / NAV_CELL);
    this.ny = Math.ceil((TANK.waterY - TANK.floorY) / NAV_CELL);
    this.nz = Math.round((TANK_MAX_Z - TANK_MIN_Z) / NAV_CELL);
    const n = this.nx * this.ny * this.nz;
    this.cost = new Float32Array(n);
    this.plant = new Float32Array(n);
    this.g = new Float32Array(n);
    this.from = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.stamp = new Uint32Array(n);
    this.heap = new Int32Array(n * 4);
    this.heapF = new Float32Array(n * 4);

    const c = v3();
    for (let k = 0; k < this.nz; k++) {
      for (let j = 0; j < this.ny; j++) {
        for (let i = 0; i < this.nx; i++) {
          this.centre(i, j, k, c);
          const idx = this.index(i, j, k);
          this.cost[idx] = this.costAt(c.x, c.y, c.z, idx);
        }
      }
    }
  }

  private costAt(x: number, y: number, z: number, idx: number): number {
    // The sand: the anal fin hangs a couple of centimetres below the middle.
    // The same floor the steering keeps the fish's middle above.
    const floor = Math.max(TANK.floorY + 0.026, sandHeight(x, z) + 0.018);
    if (y < floor) return BLOCKED;
    // The top cubes are open, up to the surface: the fish has to be able to
    // get there to breathe.
    const glass = Math.min(x - TANK_MIN_X, TANK_MAX_X - x, z - TANK_MIN_Z, TANK_MAX_Z - z);
    if (glass < GLASS_CLEARANCE) return BLOCKED;
    const hard = this.obstacles.hardDistance(x, y, z, undefined, HARD_COMFORT + 0.01);
    if (hard < HARD_CLEARANCE) return BLOCKED;
    let cost = 0;
    if (hard < HARD_COMFORT) cost += 3 * (1 - (hard - HARD_CLEARANCE) / (HARD_COMFORT - HARD_CLEARANCE));
    if (glass < GLASS_COMFORT) cost += 0.6 * (1 - (glass - GLASS_CLEARANCE) / (GLASS_COMFORT - GLASS_CLEARANCE));
    const leaf = PLANT_COST * this.obstacles.plantDensity(x, y, z, PLANT_REACH);
    const plant = Math.min(6, leaf);
    this.plant[idx] = plant;
    return cost + plant;
  }

  index(i: number, j: number, k: number): number {
    return (k * this.ny + j) * this.nx + i;
  }

  centre(i: number, j: number, k: number, out: Vec3): Vec3 {
    // The top layer sits just under the surface rather than across it.
    const y = Math.min(this.y0 + (j + 0.5) * NAV_CELL, TANK.waterY - 0.004);
    return set(out, this.x0 + (i + 0.5) * NAV_CELL, y, this.z0 + (k + 0.5) * NAV_CELL);
  }

  /** The cube a point is in, clamped to the grid. */
  cellOf(p: Vec3): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((p.x - this.x0) / NAV_CELL)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((p.y - this.y0) / NAV_CELL)));
    const k = Math.min(this.nz - 1, Math.max(0, Math.floor((p.z - this.z0) / NAV_CELL)));
    return this.index(i, j, k);
  }

  /** Cost of the cube a point is in. */
  costOf(p: Vec3): number {
    return this.cost[this.cellOf(p)];
  }

  /**
   * The open cube nearest a given one, by a widening search; the cube itself
   * if it is open. With `maxCost`, the nearest costing no more than that.
   */
  nearestOpen(idx: number, maxCost = BLOCKED): number {
    const ok = (n: number): boolean => this.cost[n] !== BLOCKED && this.cost[n] <= maxCost;
    if (ok(idx)) return idx;
    const i0 = idx % this.nx;
    const j0 = Math.floor(idx / this.nx) % this.ny;
    const k0 = Math.floor(idx / (this.nx * this.ny));
    for (let r = 1; r < Math.max(this.nx, this.nz); r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dk = -r; dk <= r; dk++) {
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
            const i = i0 + di, j = j0 + dj, k = k0 + dk;
            if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) continue;
            const n = this.index(i, j, k);
            if (!ok(n)) continue;
            const d = di * di + dj * dj + dk * dk;
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
        }
      }
      if (best >= 0) return best;
    }
    return idx;
  }

  /**
   * Move a point into the nearest open cube, if it is not in one; with
   * `maxCost`, into the nearest one costing no more than that.
   */
  openPoint(p: Vec3, out: Vec3, maxCost = BLOCKED): Vec3 {
    const idx = this.cellOf(p);
    if (this.cost[idx] !== BLOCKED && this.cost[idx] <= maxCost) return copy(out, p);
    const n = this.nearestOpen(idx, maxCost);
    return this.centre(n % this.nx, Math.floor(n / this.nx) % this.ny, Math.floor(n / (this.nx * this.ny)), out);
  }

  /**
   * The most a straight line from a to b costs anywhere along it, sampled
   * every half cube; Infinity if it crosses anywhere the fish cannot go.
   */
  lineCost(a: Vec3, b: Vec3): number {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(L / (NAV_CELL * 0.5)));
    const p = v3();
    let worst = 0;
    // The first stretch is where the fish already is: it may be somewhere
    // dear (in a plant, close to a pane) and must still be able to leave.
    const skip = Math.min(steps, Math.ceil(0.012 / (NAV_CELL * 0.5)));
    for (let s = skip; s <= steps; s++) {
      const t = s / steps;
      set(p, a.x + dx * t, a.y + dy * t, a.z + dz * t);
      const c = this.cost[this.cellOf(p)];
      if (c > worst) worst = c;
      if (worst === BLOCKED) return BLOCKED;
    }
    return worst;
  }

  /**
   * The cheapest route from `start` to `goal`, as cube centres, written into
   * `out` (start first, goal last). Returns false if there is none.
   */
  plan(start: Vec3, goal: Vec3, out: Vec3[]): boolean {
    out.length = 0;
    const s = this.nearestOpen(this.cellOf(start));
    const t = this.nearestOpen(this.cellOf(goal));
    if (this.cost[t] === BLOCKED || this.cost[s] === BLOCKED) return false;
    this.search++;
    const { nx, ny } = this;
    const nxy = nx * ny;
    const ti = t % nx, tj = Math.floor(t / nx) % ny, tk = Math.floor(t / nxy);
    const h = (n: number): number => {
      const i = n % nx, j = Math.floor(n / nx) % ny, k = Math.floor(n / nxy);
      return Math.sqrt((i - ti) ** 2 + (j - tj) ** 2 + (k - tk) ** 2);
    };
    this.heapSize = 0;
    this.touch(s);
    this.g[s] = 0;
    this.from[s] = -1;
    this.pushHeap(s, h(s));
    let found = false;
    while (this.heapSize > 0) {
      const cur = this.popHeap();
      if (this.closed[cur]) continue;
      this.closed[cur] = 1;
      if (cur === t) {
        found = true;
        break;
      }
      const ci = cur % nx, cj = Math.floor(cur / nx) % ny, ck = Math.floor(cur / nxy);
      const cc = this.cost[cur];
      for (let dk = -1; dk <= 1; dk++) {
        const k = ck + dk;
        if (k < 0 || k >= this.nz) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const j = cj + dj;
          if (j < 0 || j >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj && !dk) continue;
            const i = ci + di;
            if (i < 0 || i >= nx) continue;
            const n = (k * ny + j) * nx + i;
            const nc = this.cost[n];
            if (nc === BLOCKED) continue;
            this.touch(n);
            if (this.closed[n]) continue;
            const step = Math.sqrt(di * di + dj * dj + dk * dk);
            const g = this.g[cur] + step * (1 + 0.5 * (cc + nc));
            if (g < this.g[n]) {
              this.g[n] = g;
              this.from[n] = cur;
              this.pushHeap(n, g + h(n));
            }
          }
        }
      }
    }
    if (!found) return false;
    const cells: number[] = [];
    for (let n = t; n >= 0; n = this.from[n]) cells.push(n);
    cells.reverse();
    for (const n of cells) {
      out.push(this.centre(n % nx, Math.floor(n / nx) % ny, Math.floor(n / nxy), v3()));
    }
    return true;
  }

  private touch(n: number): void {
    if (this.stamp[n] !== this.search) {
      this.stamp[n] = this.search;
      this.g[n] = Infinity;
      this.closed[n] = 0;
    }
  }

  private pushHeap(n: number, f: number): void {
    if (this.heapSize >= this.heap.length) {
      const h = new Int32Array(this.heap.length * 2);
      h.set(this.heap);
      this.heap = h;
      const hf = new Float32Array(this.heapF.length * 2);
      hf.set(this.heapF);
      this.heapF = hf;
    }
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapF[p] <= f) break;
      this.heap[i] = this.heap[p];
      this.heapF[i] = this.heapF[p];
      i = p;
    }
    this.heap[i] = n;
    this.heapF[i] = f;
  }

  private popHeap(): number {
    const top = this.heap[0];
    const n = this.heap[--this.heapSize];
    const f = this.heapF[this.heapSize];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.heapSize) break;
      const r = l + 1;
      const c = r < this.heapSize && this.heapF[r] < this.heapF[l] ? r : l;
      if (this.heapF[c] >= f) break;
      this.heap[i] = this.heap[c];
      this.heapF[i] = this.heapF[c];
      i = c;
    }
    this.heap[i] = n;
    this.heapF[i] = f;
    return top;
  }
}

let shared: NavGrid | null = null;

/** The tank's route-finding grid. The scenery never moves, so there is one. */
export function tankNavGrid(obstacles: Obstacles): NavGrid {
  if (!shared || shared.obstacles !== obstacles) shared = new NavGrid(obstacles);
  return shared;
}
