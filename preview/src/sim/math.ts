/**
 * Small, allocation-conscious 3D maths.
 *
 * Vectors are plain {x,y,z} objects rather than arrays because the simulation
 * reads them by name far more often than it iterates them, and V8 keeps
 * monomorphic three-field objects in a very fast shape.
 *
 * Every function that can write into a destination takes one, so the hot loops
 * in hydrodynamics.ts and fins.ts run without allocating.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion, w is the scalar part. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function set(o: Vec3, x: number, y: number, z: number): Vec3 {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export function copy(o: Vec3, a: Vec3): Vec3 {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  return o;
}

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export function add(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o.x = a.x + b.x;
  o.y = a.y + b.y;
  o.z = a.z + b.z;
  return o;
}

export function sub(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o.x = a.x - b.x;
  o.y = a.y - b.y;
  o.z = a.z - b.z;
  return o;
}

export function scale(o: Vec3, a: Vec3, s: number): Vec3 {
  o.x = a.x * s;
  o.y = a.y * s;
  o.z = a.z * s;
  return o;
}

/** o += a * s */
export function addScaled(o: Vec3, a: Vec3, s: number): Vec3 {
  o.x += a.x * s;
  o.y += a.y * s;
  o.z += a.z * s;
  return o;
}

export function mul(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o.x = a.x * b.x;
  o.y = a.y * b.y;
  o.z = a.z * b.z;
  return o;
}

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export function cross(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export const len = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function normalize(o: Vec3, a: Vec3): Vec3 {
  const l = len(a);
  if (l < 1e-12) return set(o, 0, 0, 0);
  return scale(o, a, 1 / l);
}

export function lerpV(o: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  o.x = a.x + (b.x - a.x) * t;
  o.y = a.y + (b.y - a.y) * t;
  o.z = a.z + (b.z - a.z) * t;
  return o;
}

/** Clamp a vector's magnitude, leaving direction alone. */
export function clampLength(o: Vec3, a: Vec3, maxLen: number): Vec3 {
  const l = len(a);
  if (l <= maxLen || l < 1e-12) return copy(o, a);
  return scale(o, a, maxLen / l);
}

// ---------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export function quatCopy(o: Quat, a: Quat): Quat {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  o.w = a.w;
  return o;
}

export function quatMul(o: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x;
  o.y = y;
  o.z = z;
  o.w = w;
  return o;
}

export function quatNormalize(o: Quat, a: Quat): Quat {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w);
  if (l < 1e-12) {
    o.x = 0;
    o.y = 0;
    o.z = 0;
    o.w = 1;
    return o;
  }
  const inv = 1 / l;
  o.x = a.x * inv;
  o.y = a.y * inv;
  o.z = a.z * inv;
  o.w = a.w * inv;
  return o;
}

export function quatConjugate(o: Quat, a: Quat): Quat {
  o.x = -a.x;
  o.y = -a.y;
  o.z = -a.z;
  o.w = a.w;
  return o;
}

/** Rotate a vector by a quaternion: o = q * v * q^-1, via the cross-product form. */
export function quatRotate(o: Vec3, q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz x v);  o = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  const x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  const y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  const z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

/** Rotate a vector by the inverse of a quaternion (world -> body). */
export function quatRotateInv(o: Vec3, q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);
  const x = v.x + q.w * tx + (-q.y * tz + q.z * ty);
  const y = v.y + q.w * ty + (-q.z * tx + q.x * tz);
  const z = v.z + q.w * tz + (-q.x * ty + q.y * tx);
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export function quatFromAxisAngle(o: Quat, axis: Vec3, angle: number): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  o.x = axis.x * s;
  o.y = axis.y * s;
  o.z = axis.z * s;
  o.w = Math.cos(h);
  return o;
}

/**
 * Integrate an orientation by an angular velocity for dt, using the exponential
 * map rather than the usual first-order `q += 0.5*w*q`.
 *
 * The cheap form drifts badly when the body spins fast, which a startled fish
 * does — a C-start puts several hundred degrees per second through this.
 */
export function quatIntegrate(o: Quat, q: Quat, omega: Vec3, dt: number): Quat {
  const wx = omega.x * dt * 0.5;
  const wy = omega.y * dt * 0.5;
  const wz = omega.z * dt * 0.5;
  const theta = Math.sqrt(wx * wx + wy * wy + wz * wz);
  let s: number;
  let c: number;
  if (theta < 1e-8) {
    // sin(t)/t -> 1 as t -> 0; expanding avoids a 0/0.
    s = 1 - (theta * theta) / 6;
    c = 1 - (theta * theta) / 2;
  } else {
    s = Math.sin(theta) / theta;
    c = Math.cos(theta);
  }
  const dq: Quat = { x: wx * s, y: wy * s, z: wz * s, w: c };
  quatMul(o, dq, q);
  return quatNormalize(o, o);
}

/**
 * Shortest-arc rotation taking `from` to `to`. Both must be unit vectors.
 * Used to align the fish's forward axis with a desired heading.
 */
export function quatFromTo(o: Quat, from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);
  if (d > 0.999999) return quatCopy(o, { x: 0, y: 0, z: 0, w: 1 });
  if (d < -0.999999) {
    // Opposite vectors: any perpendicular axis will do; pick the most stable one.
    let ax = v3(1, 0, 0);
    if (Math.abs(from.x) > 0.9) ax = v3(0, 1, 0);
    const axis = v3();
    cross(axis, from, ax);
    normalize(axis, axis);
    return quatFromAxisAngle(o, axis, Math.PI);
  }
  const c = v3();
  cross(c, from, to);
  o.x = c.x;
  o.y = c.y;
  o.z = c.z;
  o.w = 1 + d;
  return quatNormalize(o, o);
}

/** Build a quaternion from an orthonormal basis given as forward and up hints. */
export function quatLookAlong(o: Quat, forward: Vec3, upHint: Vec3): Quat {
  const f = normalize(v3(), forward);
  const r = v3();
  cross(r, upHint, f);
  if (lenSq(r) < 1e-10) {
    // forward is parallel to the up hint; nudge to something usable.
    cross(r, v3(0, 0, 1), f);
  }
  normalize(r, r);
  const u = v3();
  cross(u, f, r);

  // Columns (r, u, f) form the rotation matrix; convert with the standard
  // branch-on-largest-diagonal method for numerical stability.
  const m00 = r.x, m01 = u.x, m02 = f.x;
  const m10 = r.y, m11 = u.y, m12 = f.y;
  const m20 = r.z, m21 = u.z, m22 = f.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    o.w = 0.25 * s;
    o.x = (m21 - m12) / s;
    o.y = (m02 - m20) / s;
    o.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    o.w = (m21 - m12) / s;
    o.x = 0.25 * s;
    o.y = (m01 + m10) / s;
    o.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    o.w = (m02 - m20) / s;
    o.x = (m01 + m10) / s;
    o.y = 0.25 * s;
    o.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    o.w = (m10 - m01) / s;
    o.x = (m02 + m20) / s;
    o.y = (m12 + m21) / s;
    o.z = 0.25 * s;
  }
  return quatNormalize(o, o);
}

/** Spherical linear interpolation, taking the short way round. */
export function quatSlerp(o: Quat, a: Quat, b: Quat, t: number): Quat {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (d > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(d);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }
  o.x = a.x * s0 + bx * s1;
  o.y = a.y * s0 + by * s1;
  o.z = a.z * s0 + bz * s1;
  o.w = a.w * s0 + bw * s1;
  return quatNormalize(o, o);
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const saturate = (x: number): number => clamp(x, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Wrap an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

/**
 * Frame-rate independent exponential approach.
 *
 * `x += (target - x) * rate * dt` is the usual form and it is wrong: the amount
 * approached depends on how the frame was chopped up. This is the exact solution
 * of the same differential equation, so a 30 fps and a 120 fps run agree.
 */
export function expApproach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function expApproachV(o: Vec3, current: Vec3, target: Vec3, rate: number, dt: number): Vec3 {
  const k = Math.exp(-rate * dt);
  o.x = target.x + (current.x - target.x) * k;
  o.y = target.y + (current.y - target.y) * k;
  o.z = target.z + (current.z - target.z) * k;
  return o;
}

// ---------------------------------------------------------------------------
// 4x4 matrices, column-major (the layout both WebGL and Metal want)
// ---------------------------------------------------------------------------

export type Mat4 = Float32Array;

export const mat4 = (): Mat4 => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export function mat4Identity(o: Mat4): Mat4 {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function mat4Multiply(o: Mat4, a: Mat4, b: Mat4): Mat4 {
  // o = a * b, both column-major.
  const t = mat4Multiply._t;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    t[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    t[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    t[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    t[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  o.set(t);
  return o;
}
mat4Multiply._t = new Float32Array(16);

export function mat4FromQuatPos(o: Mat4, q: Quat, p: Vec3): Mat4 {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  o[0] = 1 - (yy + zz); o[1] = xy + wz;       o[2] = xz - wy;       o[3] = 0;
  o[4] = xy - wz;       o[5] = 1 - (xx + zz); o[6] = yz + wx;       o[7] = 0;
  o[8] = xz + wy;       o[9] = yz - wx;       o[10] = 1 - (xx + yy); o[11] = 0;
  o[12] = p.x;          o[13] = p.y;          o[14] = p.z;          o[15] = 1;
  return o;
}

/** Inverse of a rigid transform (rotation + translation only) — transpose and re-translate. */
export function mat4InvertRigid(o: Mat4, m: Mat4): Mat4 {
  const tx = m[12], ty = m[13], tz = m[14];
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8];  o[3] = 0;
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9];  o[7] = 0;
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10]; o[11] = 0;
  o[12] = -(m[0] * tx + m[1] * ty + m[2] * tz);
  o[13] = -(m[4] * tx + m[5] * ty + m[6] * tz);
  o[14] = -(m[8] * tx + m[9] * ty + m[10] * tz);
  o[15] = 1;
  return o;
}

/**
 * General off-axis perspective frustum. `near`/`far` are positive distances and
 * the eye looks down -z, matching OpenGL/WebGL conventions.
 */
export function mat4Frustum(
  o: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const rl = 1 / (right - left);
  const tb = 1 / (top - bottom);
  const nf = 1 / (near - far);
  o.fill(0);
  o[0] = 2 * near * rl;
  o[5] = 2 * near * tb;
  o[8] = (right + left) * rl;
  o[9] = (top + bottom) * tb;
  o[10] = (far + near) * nf;
  o[11] = -1;
  o[14] = 2 * far * near * nf;
  return o;
}

export function mat4Perspective(o: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const top = near * Math.tan(fovY * 0.5);
  const right = top * aspect;
  return mat4Frustum(o, -right, right, -top, top, near, far);
}

export function mat4LookAt(o: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = v3();
  sub(f, target, eye);
  normalize(f, f);
  const s = v3();
  cross(s, f, up);
  normalize(s, s);
  const u = v3();
  cross(u, s, f);
  o[0] = s.x; o[1] = u.x; o[2] = -f.x; o[3] = 0;
  o[4] = s.y; o[5] = u.y; o[6] = -f.y; o[7] = 0;
  o[8] = s.z; o[9] = u.z; o[10] = -f.z; o[11] = 0;
  o[12] = -dot(s, eye);
  o[13] = -dot(u, eye);
  o[14] = dot(f, eye);
  o[15] = 1;
  return o;
}

export function mat4Transpose(o: Mat4, m: Mat4): Mat4 {
  const t = mat4Transpose._t;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = m[r * 4 + c];
  o.set(t);
  return o;
}
mat4Transpose._t = new Float32Array(16);

/** Full 4x4 inverse. Only used off the hot path (camera setup). */
export function mat4Invert(o: Mat4, m: Mat4): Mat4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-20) return null;
  det = 1 / det;

  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

export function mat4TransformPoint(o: Vec3, m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export function mat4TransformDir(o: Vec3, m: Mat4, d: Vec3): Vec3 {
  const x = m[0] * d.x + m[4] * d.y + m[8] * d.z;
  const y = m[1] * d.x + m[5] * d.y + m[9] * d.z;
  const z = m[2] * d.x + m[6] * d.y + m[10] * d.z;
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}
