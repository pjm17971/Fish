/**
 * Refraction at the tank's panes, in TypeScript.
 *
 * This is the same calculation as `apparentPosition` in the scene vertex shader
 * (see APPARENT_POSITION in shaders.ts), step for step, so that it can be
 * checked by the test suite: a shader cannot be run under `node --test`, and a
 * mistake in this maths does not crash anything, it just puts the fish a
 * little in the wrong place. Change one, change the other.
 */

import { Vec3, v3 } from '../sim/math.js';

export interface Refraction {
  /** Where the point is drawn in this pass. */
  apparent: Vec3;
  /** Where the line of sight crosses the pane. */
  crossing: Vec3;
  /** Positive where this pass sees the point, negative where it does not. */
  inPane: number;
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Where a point appears to be from `eye`, seen through the pane of the water
 * box `min`..`max` whose outward normal is `pane`, for water of index `n`.
 * `topSlack` raises the top of the box for the inside test, as the surface
 * mesh needs. The pass for what is out of the water (a zero `pane`) is left to
 * the shader; this is the part with any maths in it.
 */
export function apparentPosition(
  eye: Vec3,
  p: Vec3,
  pane: Vec3,
  min: Vec3,
  max: Vec3,
  n: number,
  topSlack = 0,
): Refraction {
  const e = eye;
  const N = pane;

  const lo = v3(min.x - 1e-3, min.y - 1e-2, min.z - 1e-3);
  const hi = v3(max.x + 1e-3, max.y + topSlack, max.z + 1e-3);
  const out = Math.max(lo.x - p.x, p.x - hi.x, lo.y - p.y, p.y - hi.y, lo.z - p.z, p.z - hi.z);

  const positive = N.x + N.y + N.z >= 0;
  const onPane = positive ? max : min;
  const hE = dot(v3(e.x - onPane.x, e.y - onPane.y, e.z - onPane.z), N);
  const hP = dot(v3(onPane.x - p.x, onPane.y - p.y, onPane.z - p.z), N);

  const pp = dot(v3(p.x - onPane.x, p.y - onPane.y, p.z - onPane.z), N);
  let s = v3(p.x - N.x * pp, p.y - N.y * pp, p.z - N.z * pp);
  let apparent = v3(p.x, p.y, p.z);
  if (hE > 0 && hP > 1e-6) {
    const d = v3(p.x - e.x, p.y - e.y, p.z - e.z);
    const dn = dot(d, N);
    const lat = v3(d.x - dn * N.x, d.y - dn * N.y, d.z - dn * N.z);
    const L = Math.sqrt(dot(lat, lat));
    const inv = 1 / Math.max(L, 1e-9);
    const u = v3(lat.x * inv, lat.y * inv, lat.z * inv);

    let xlo = 0;
    let xhi = L;
    let x = (L * hE) / (hE + hP / n);
    for (let i = 0; i < 16; i++) {
      const a = Math.sqrt(x * x + hE * hE);
      const b = Math.sqrt((L - x) * (L - x) + hP * hP);
      const f = x / a - (n * (L - x)) / b;
      if (f > 0) xhi = x;
      else xlo = x;
      const slope = (hE * hE) / (a * a * a) + (n * hP * hP) / (b * b * b);
      const next = x - f / slope;
      x = next >= xlo && next <= xhi ? next : 0.5 * (xlo + xhi);
    }
    s = v3(e.x + u.x * x - N.x * hE, e.y + u.y * x - N.y * hE, e.z + u.z * x - N.z * hE);
    const view = v3(s.x - e.x, s.y - e.y, s.z - e.z);
    const vl = Math.sqrt(dot(view, view));
    const ps = v3(p.x - s.x, p.y - s.y, p.z - s.z);
    const k = Math.sqrt(dot(ps, ps)) / n / vl;
    apparent = v3(s.x + view.x * k, s.y + view.y * k, s.z + view.z * k);
  }

  const edge = (c: number, lo: number, hi: number, onAxis: number): number =>
    onAxis !== 0 ? 1 : Math.min(c - lo, hi - c);
  const inPane = Math.min(
    edge(s.x, lo.x, hi.x, N.x),
    edge(s.y, lo.y, hi.y, N.y),
    edge(s.z, lo.z, hi.z, N.z),
    -out,
  );
  return { apparent, crossing: s, inPane };
}

/** The panes an eye at `eye` can see into the box through, as outward normals. */
export function visiblePanes(eye: Vec3, min: Vec3, max: Vec3): Vec3[] {
  const panes: Vec3[] = [];
  if (eye.x > max.x) panes.push(v3(1, 0, 0));
  else if (eye.x < min.x) panes.push(v3(-1, 0, 0));
  if (eye.y > max.y) panes.push(v3(0, 1, 0));
  else if (eye.y < min.y) panes.push(v3(0, -1, 0));
  if (eye.z > max.z) panes.push(v3(0, 0, 1));
  else if (eye.z < min.z) panes.push(v3(0, 0, -1));
  return panes;
}
