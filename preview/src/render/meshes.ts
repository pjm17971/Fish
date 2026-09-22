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
import { v3, Vec3, quatRotate, normalize, sub, add } from '../sim/math.js';

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
