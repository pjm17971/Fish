/**
 * Geometry, built from the simulation rather than from an art asset.
 *
 * The fish's surface is generated from the same cross-section profile the
 * physics integrates over, so the shape you see and the shape the water pushes
 * on cannot drift apart. A mesh authored in a modelling package alongside a
 * hand-tuned collision shape is the usual reason a simulated creature ends up
 * feeling subtly wrong in a way nobody can point at.
 */

import { Morphology } from '../sim/morphology.js';
import { FishBody } from '../sim/fishBody.js';
import { FishLocomotion } from '../sim/locomotion.js';
import { FinCloth } from '../sim/fins.js';
import { WaterSurface } from '../sim/water.js';
import { TANK, TANK_MIN_X, TANK_MIN_Z } from '../sim/config.js';
import { v3, Vec3, quatRotate, cross, normalize, sub, add, scale } from '../sim/math.js';

/** Points around each body cross-section. */
export const RING = 14;

/**
 * Vertex layout shared by the body and fin meshes:
 *   position (3), normal (3), uv (2), extra (2)
 * `extra` carries whatever the shader needs that is not geometry — for the body
 * it is (arc position along the fish, thickness); for a fin it is (span
 * fraction, membrane thickness in millimetres).
 */
export const VERTEX_FLOATS = 10;
export const VERTEX_STRIDE = VERTEX_FLOATS * 4;

export const VERTEX_ATTRIBUTES = [
  { name: 'aPosition', size: 3, offset: 0 },
  { name: 'aNormal', size: 3, offset: 12 },
  { name: 'aUV', size: 2, offset: 24 },
  { name: 'aExtra', size: 2, offset: 32 },
];

// ---------------------------------------------------------------------------
// Fish body
// ---------------------------------------------------------------------------

export class BodyMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;
  /** Number of rings actually used — the caudal segments are drawn as fin, not body. */
  readonly ringCount: number;

  private readonly tmp = v3();
  private readonly worldPos = v3();
  private readonly n = v3();
  private readonly u = v3();
  private readonly r = v3();

  constructor(private readonly morph: Morphology) {
    // Only the fleshy body gets a tube. The caudal segments exist in the physics
    // as a continuation of the body, but visually they are the tail fin, which
    // the fin cloth draws.
    this.ringCount = morph.segments.filter((s) => !s.isCaudal).length;
    this.vertices = new Float32Array(this.ringCount * RING * VERTEX_FLOATS);

    const quads = (this.ringCount - 1) * RING;
    const idx = new Uint16Array(quads * 6);
    let k = 0;
    for (let i = 0; i < this.ringCount - 1; i++) {
      for (let j = 0; j < RING; j++) {
        const j2 = (j + 1) % RING;
        const a = i * RING + j;
        const b = i * RING + j2;
        const c = (i + 1) * RING + j;
        const d = (i + 1) * RING + j2;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    this.indices = idx;
  }

  /**
   * Rebuild the surface for the body's current pose.
   *
   * Cheap enough to do on the CPU every frame for one fish — a few hundred
   * vertices — and it keeps the geometry exactly in step with the physics
   * without a skinning shader to get out of sync.
   */
  update(body: FishBody, loco: FishLocomotion, gillFlare: number): void {
    const v = this.vertices;
    let o = 0;

    for (let i = 0; i < this.ringCount; i++) {
      const seg = this.morph.segments[i];
      const st = body.segments[i];

      // The gill covers swing out during a threat display. It is a small change
      // in geometry and a very large change in what the animal looks like it is
      // doing — the head roughly doubles in apparent width.
      let widthScale = 1;
      if (seg.s < 0.22) {
        const t = 1 - seg.s / 0.22;
        widthScale = 1 + gillFlare * 1.15 * t * t;
      }

      const halfDepth = seg.depth * 0.5;
      const halfWidth = seg.width * 0.5 * widthScale;

      for (let j = 0; j < RING; j++) {
        const a = (j / RING) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);

        // Point on the elliptical cross-section, in the segment's own frame.
        this.tmp.x = st.normal.x * ca * halfWidth + st.up.x * sa * halfDepth;
        this.tmp.y = st.normal.y * ca * halfWidth + st.up.y * sa * halfDepth;
        this.tmp.z = st.normal.z * ca * halfWidth + st.up.z * sa * halfDepth;
        add(this.tmp, this.tmp, st.pos);
        loco.toWorld(this.tmp, this.worldPos);

        // Surface normal. For an ellipse the outward normal is not the radial
        // direction — it is scaled by the reciprocal of each semi-axis, which is
        // what stops a flattened body reading as a cylinder under a specular
        // highlight.
        const nx = ca / Math.max(1e-5, halfWidth);
        const ny = sa / Math.max(1e-5, halfDepth);
        this.n.x = st.normal.x * nx + st.up.x * ny;
        this.n.y = st.normal.y * nx + st.up.y * ny;
        this.n.z = st.normal.z * nx + st.up.z * ny;
        normalize(this.n, this.n);
        loco.dirToWorld(this.n, this.u);

        v[o++] = this.worldPos.x;
        v[o++] = this.worldPos.y;
        v[o++] = this.worldPos.z;
        v[o++] = this.u.x;
        v[o++] = this.u.y;
        v[o++] = this.u.z;
        v[o++] = j / RING; // around
        v[o++] = seg.s; // along
        v[o++] = seg.s;
        v[o++] = 1; // opaque flesh
      }
    }
    void this.r;
  }
}

// ---------------------------------------------------------------------------
// Fins
// ---------------------------------------------------------------------------

export class FinMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;

  private readonly a = v3();
  private readonly b = v3();
  private readonly n = v3();

  constructor(private readonly fin: FinCloth) {
    const { rays, along } = fin.spec;
    this.vertices = new Float32Array(rays * along * VERTEX_FLOATS);

    const quads = (rays - 1) * (along - 1);
    const idx = new Uint16Array(quads * 6);
    let k = 0;
    for (let r = 0; r < rays - 1; r++) {
      for (let j = 0; j < along - 1; j++) {
        const a = r * along + j;
        const b = a + 1;
        const c = a + along;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    this.indices = idx;
  }

  update(): void {
    const { rays, along } = this.fin.spec;
    const v = this.vertices;
    const p = this.fin.pos;
    let o = 0;

    for (let r = 0; r < rays; r++) {
      for (let j = 0; j < along; j++) {
        const i = r * along + j;
        v[o++] = p[i * 3];
        v[o++] = p[i * 3 + 1];
        v[o++] = p[i * 3 + 2];
        v[o++] = this.fin.normals[i * 3];
        v[o++] = this.fin.normals[i * 3 + 1];
        v[o++] = this.fin.normals[i * 3 + 2];
        v[o++] = r / Math.max(1, rays - 1);
        v[o++] = j / Math.max(1, along - 1);
        v[o++] = j / Math.max(1, along - 1);
        // Thickness in millimetres — the shader uses it for the translucency,
        // so a fin ray reads as a denser strut than the webbing between them.
        v[o++] = this.fin.thickness[i] * 1000;
      }
    }
    void this.a;
    void this.b;
    void this.n;
  }
}

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------

export class WaterMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;

  constructor(private readonly water: WaterSurface) {
    const { nx, nz } = water;
    this.vertices = new Float32Array(nx * nz * VERTEX_FLOATS);

    const quads = (nx - 1) * (nz - 1);
    const idx = new Uint32Array(quads * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    this.indices = idx;
  }

  update(): void {
    const { nx, nz } = this.water;
    const v = this.vertices;
    let o = 0;
    for (let j = 0; j < nz; j++) {
      const z = TANK_MIN_Z + j * this.water.dz;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const x = TANK_MIN_X + i * this.water.dx;
        v[o++] = x;
        v[o++] = TANK.waterY + this.water.height[k];
        v[o++] = z;
        v[o++] = this.water.normals[k * 3];
        v[o++] = this.water.normals[k * 3 + 1];
        v[o++] = this.water.normals[k * 3 + 2];
        v[o++] = i / (nx - 1);
        v[o++] = j / (nz - 1);
        v[o++] = this.water.height[k];
        v[o++] = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tank
// ---------------------------------------------------------------------------

/**
 * The tank interior: substrate, back and side walls.
 *
 * The front is deliberately left out. On the phone the front face of the tank is
 * the screen itself, so there is nothing to draw there; in the preview the
 * camera simply looks in through the same opening.
 */
export function buildTankMesh(): { vertices: Float32Array; indices: Uint16Array } {
  const verts: number[] = [];
  const idx: number[] = [];

  const push = (
    p: Vec3,
    n: Vec3,
    u: number,
    v: number,
    kind: number,
  ): number => {
    const i = verts.length / VERTEX_FLOATS;
    verts.push(p.x, p.y, p.z, n.x, n.y, n.z, u, v, kind, 0);
    return i;
  };

  const quad = (
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    n: Vec3,
    kind: number,
    uvScale = 1,
  ): void => {
    const i0 = push(a, n, 0, 0, kind);
    const i1 = push(b, n, uvScale, 0, kind);
    const i2 = push(c, n, uvScale, uvScale, kind);
    const i3 = push(d, n, 0, uvScale, kind);
    idx.push(i0, i1, i2, i0, i2, i3);
  };

  const x0 = TANK_MIN_X;
  const x1 = -TANK_MIN_X;
  const z0 = TANK_MIN_Z;
  const z1 = 0;
  const yTop = TANK.waterY + 0.03;

  // Substrate, as a grid so it can slope up towards the back and take caustics
  // with some spatial variation.
  const N = 24;
  const floorY = (z: number): number => {
    const t = (z - z0) / (z1 - z0); // 0 at the back, 1 at the front
    return TANK.floorY + TANK.floorSlopeBack * (1 - t);
  };
  const base = verts.length / VERTEX_FLOATS;
  for (let j = 0; j <= N; j++) {
    const z = z0 + ((z1 - z0) * j) / N;
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N;
      // A gentle undulation, so the sand is a surface rather than a plane.
      const ripple =
        0.0016 * Math.sin(x * 47 + z * 11) + 0.0011 * Math.sin(x * 23 - z * 37 + 1.3);
      const p = v3(x, floorY(z) + ripple, z);
      // Normal from the analytic derivative of the same expression.
      const dx = 0.0016 * 47 * Math.cos(x * 47 + z * 11) + 0.0011 * 23 * Math.cos(x * 23 - z * 37 + 1.3);
      const dz =
        -TANK.floorSlopeBack / (z1 - z0) +
        0.0016 * 11 * Math.cos(x * 47 + z * 11) -
        0.0011 * 37 * Math.cos(x * 23 - z * 37 + 1.3);
      const n = v3(-dx, 1, -dz);
      normalize(n, n);
      push(p, n, i / N, j / N, 0);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = base + j * (N + 1) + i;
      const b = a + 1;
      const c = a + (N + 1);
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // Back wall and the two sides, seen from inside.
  quad(v3(x0, TANK.floorY, z0), v3(x1, TANK.floorY, z0), v3(x1, yTop, z0), v3(x0, yTop, z0), v3(0, 0, 1), 1);
  quad(v3(x0, TANK.floorY, z1), v3(x0, TANK.floorY, z0), v3(x0, yTop, z0), v3(x0, yTop, z1), v3(1, 0, 0), 1);
  quad(v3(x1, TANK.floorY, z0), v3(x1, TANK.floorY, z1), v3(x1, yTop, z1), v3(x1, yTop, z0), v3(-1, 0, 0), 1);

  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

/**
 * Plants and driftwood.
 *
 * There is a functional reason for at least one broad leaf: the fish rests on
 * one. A betta lying on a leaf in the middle of the water column is one of the
 * more recognisable things the animal does, and it needs somewhere to do it.
 */
export function buildPlantsMesh(): { vertices: Float32Array; indices: Uint16Array } {
  const verts: number[] = [];
  const idx: number[] = [];

  const addLeaf = (
    origin: Vec3,
    direction: Vec3,
    length: number,
    width: number,
    curl: number,
    seed: number,
  ): void => {
    const SEGMENTS = 10;
    const side = v3();
    cross(side, direction, v3(0, 1, 0));
    if (side.x * side.x + side.z * side.z < 1e-8) side.x = 1;
    normalize(side, side);

    const base = verts.length / VERTEX_FLOATS;
    const p = v3();
    const n = v3();
    const dir = v3(direction.x, direction.y, direction.z);
    normalize(dir, dir);

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      // A leaf tapers at both ends and curls over as it rises.
      const w = width * Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.5;
      const bend = curl * t * t;
      scale(p, dir, length * t);
      p.x += origin.x + Math.sin(seed + t * 3) * 0.004;
      p.y += origin.y - bend;
      p.z += origin.z + Math.cos(seed * 1.7 + t * 2.5) * 0.004;

      // Normal roughly perpendicular to the leaf blade.
      cross(n, side, dir);
      normalize(n, n);

      verts.push(p.x - side.x * w, p.y, p.z - side.z * w, n.x, n.y, n.z, 0, t, 2, 0);
      verts.push(p.x + side.x * w, p.y, p.z + side.z * w, n.x, n.y, n.z, 1, t, 2, 0);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = base + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };

  // A broad-leaved plant on the left, with one leaf reaching into mid-water:
  // this is the one the fish rests on.
  addLeaf(v3(-0.10, TANK.floorY, -0.16), v3(0.25, 1, 0.1), 0.075, 0.026, 0.022, 1.1);
  addLeaf(v3(-0.095, TANK.floorY, -0.17), v3(-0.15, 1, 0.2), 0.062, 0.022, 0.016, 2.3);
  addLeaf(v3(-0.105, TANK.floorY, -0.15), v3(0.05, 1, -0.25), 0.055, 0.02, 0.012, 3.7);

  // A taller stem plant at the back right.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addLeaf(
      v3(0.11 + Math.cos(a) * 0.012, TANK.floorY, -0.20 + Math.sin(a) * 0.012),
      v3(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3),
      0.055 + (i % 3) * 0.012,
      0.007,
      0.008,
      i * 1.7,
    );
  }

  // A low clump at the right front.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    addLeaf(
      v3(0.13 + Math.cos(a) * 0.01, TANK.floorY, -0.07 + Math.sin(a) * 0.01),
      v3(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5),
      0.032,
      0.012,
      0.01,
      i * 2.9,
    );
  }

  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

/** A single screen-filling triangle, for full-screen passes. */
export function fullscreenTriangle(): Float32Array {
  // One triangle rather than two: no seam down the diagonal, and every pixel is
  // shaded exactly once.
  return new Float32Array([-1, -1, 3, -1, -1, 3]);
}

/** Small helper the renderer uses to place billboarded particles. */
export function billboard(
  centre: Vec3,
  right: Vec3,
  up: Vec3,
  size: number,
  out: Float32Array,
  offset: number,
): number {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ];
  let o = offset;
  for (const [cx, cy] of corners) {
    out[o++] = centre.x + right.x * cx * size + up.x * cy * size;
    out[o++] = centre.y + right.y * cx * size + up.y * cy * size;
    out[o++] = centre.z + right.z * cx * size + up.z * cy * size;
    out[o++] = (cx + 1) * 0.5;
    out[o++] = (cy + 1) * 0.5;
  }
  return o;
}

void quatRotate;
void sub;
