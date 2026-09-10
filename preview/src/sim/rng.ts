/**
 * xoshiro128** — a small, seeded, statistically sound random number generator.
 *
 * Why not Math.random(): the simulation has to be reproducible. A seed must
 * replay a run exactly, so the TypeScript and Swift ports can be checked against
 * each other and so a behaviour bug seen once can be seen again. Math.random()
 * is unseeded and its algorithm is not specified by the language.
 *
 * Why xoshiro128** specifically, and not PCG32 (the more usual choice):
 * PCG32's state update is a 64-bit multiply. JavaScript's bitwise operators are
 * 32-bit, and its numbers lose precision above 2^53, so a 64-bit multiply can
 * only be done exactly with BigInt — far too slow for a per-step generator — or
 * approximately, which silently produces a *different stream* from the Swift
 * side and destroys the cross-port reproducibility that is the entire point.
 * xoshiro128** (Blackman & Vigna) uses nothing but 32-bit shifts, xors and
 * multiplies, so JavaScript and Swift produce bit-identical output. It passes
 * TestU01 BigCrush and has a 2^128-1 period, which is ample here.
 */

/** splitmix32: turns one seed integer into a well-mixed 128-bit state. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private spare: number | null = null;

  constructor(seed = 0x2545f491) {
    this.seedWith(seed);
  }

  seedWith(seed: number): void {
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    // A zero state is a fixed point of the recurrence; nudge it if we land there.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    this.spare = null;
  }

  /** Snapshot/restore, so a test can fork a stream without disturbing the run. */
  getState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(st: [number, number, number, number]): void {
    this.s0 = st[0] >>> 0;
    this.s1 = st[1] >>> 0;
    this.s2 = st[2] >>> 0;
    this.s3 = st[3] >>> 0;
    this.spare = null;
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** Uniform in [0, 1). Uses 24 bits, which is exactly a float32 mantissa. */
  next(): number {
    return (this.nextUint() >>> 8) * (1 / 16777216);
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform in [-a, a]. */
  sym(a: number): number {
    return (this.next() * 2 - 1) * a;
  }

  /** Uniform integer in [0, lessThan). */
  int(lessThan: number): number {
    return Math.min(lessThan - 1, Math.floor(this.next() * lessThan));
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /**
   * Standard normal via Marsaglia polar, with the second value cached.
   * Used for sensory noise and for the scatter on dropped pellets.
   */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + sd * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    return mean + sd * u * f;
  }

  /**
   * Wrapped Cauchy turn angle on (-pi, pi], concentration rho in [0, 1).
   *
   * This is the standard model for turn angles in animal correlated random
   * walks: rho = 0 is a uniform turn (pure diffusion), rho -> 1 is near-straight
   * travel. Foraging fish sit around 0.6 to 0.8, which is why forage uses 0.72.
   *
   * A Gaussian turn angle is the common shortcut and it is wrong in the tails:
   * it under-produces the occasional sharp reorientation that makes a search
   * path read as an animal's rather than a drunkard's.
   *
   * Inverse-CDF form from Fisher, *Statistical Analysis of Circular Data* (1993).
   */
  wrappedCauchy(rho: number): number {
    if (rho < 1e-6) return (this.next() * 2 - 1) * Math.PI;
    if (rho > 0.9999) return 0;
    const u = this.next();
    const num = (1 - rho) * Math.tan(Math.PI * (u - 0.5));
    const den = 1 + rho;
    return 2 * Math.atan2(num, den);
  }

  /** Unit vector uniform on the sphere (Archimedes' hat-box method). */
  onSphere(out: { x: number; y: number; z: number }): void {
    const z = this.next() * 2 - 1;
    const t = this.next() * 2 * Math.PI;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.x = r * Math.cos(t);
    out.y = r * Math.sin(t);
    out.z = z;
  }
}

/**
 * Deterministic 3D value noise with a quintic fade.
 *
 * Used for the curl-noise flow potential. The fade is quintic rather than the
 * cheaper cubic because we take the *derivative* of this field to get the curl:
 * a cubic fade is only C1, so its derivative has visible creases on the cell
 * boundaries, which show up as a grid pattern in the drifting particles.
 */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);

  const h = (ix: number, iy: number, iz: number): number => {
    let n = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1) ^ seed) >>> 0;
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967295 - 0.5;
  };

  const lx = (a: number, b: number) => a + (b - a) * u;
  const ly = (a: number, b: number) => a + (b - a) * v;
  const lz = (a: number, b: number) => a + (b - a) * w;

  const c000 = h(xi, yi, zi), c100 = h(xi + 1, yi, zi);
  const c010 = h(xi, yi + 1, zi), c110 = h(xi + 1, yi + 1, zi);
  const c001 = h(xi, yi, zi + 1), c101 = h(xi + 1, yi, zi + 1);
  const c011 = h(xi, yi + 1, zi + 1), c111 = h(xi + 1, yi + 1, zi + 1);

  return lz(
    ly(lx(c000, c100), lx(c010, c110)),
    ly(lx(c001, c101), lx(c011, c111)),
  );
}

/** Two octaves of value noise — enough structure for the flow field, still cheap. */
export function fbm3(x: number, y: number, z: number, seed: number): number {
  return valueNoise3(x, y, z, seed) + 0.5 * valueNoise3(x * 2.03, y * 2.03, z * 2.03, seed ^ 0x9e37);
}
