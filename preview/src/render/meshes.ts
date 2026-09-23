/**
 * Geometry, built from the simulation rather than from an art asset.
 *
 * The fish's surface is generated from the same cross-section profile the
 * physics integrates over, so the shape you see and the shape the water pushes
 * on cannot drift apart. A mesh authored in a modelling package alongside a
 * hand-tuned collision shape is the usual reason a simulated creature ends up
 * feeling subtly wrong in a way nobody can point at.
 */

import { Morphology, bodyDepth, bodyWidth } from '../sim/morphology.js';
import { FishBody } from '../sim/fishBody.js';
import { FishLocomotion } from '../sim/locomotion.js';
import { FinCloth } from '../sim/fins.js';
import { WaterSurface } from '../sim/water.js';
import { TANK, TANK_MIN_X, TANK_MIN_Z } from '../sim/config.js';
import {
  v3,
  Vec3,
  quatRotate,
  cross,
  normalize,
  sub,
  scale,
  set,
  copy,
  lerpV,
  smoothstep,
} from '../sim/math.js';

/** Points around each body cross-section. */
export const RING = 32;

/**
 * Vertex layout shared by the body and fin meshes:
 *   position (3), normal (3), uv (2), extra (2)
 * `uv` and `extra` carry whatever the shader needs that is not geometry. For
 * the body, uv is (distance round from the top of the back, distance back from
 * the snout), both in millimetres, and extra is (position along the fish as a
 * fraction of its length, height above the centreline in millimetres). For a
 * fin, uv is (fraction across the rays, fraction out from the body) and extra
 * is (fraction out from the body, membrane thickness in millimetres).
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

/** Length over which the snout closes to a point, in metres. */
const NOSE_LENGTH = 0.0068;
/** Rings spent on the snout, bunched towards the tip where it curves fastest. */
const NOSE_RINGS = 12;
/** Rings along the rest of the body, snout to tail stalk. */
const BODY_RINGS = 64;

/**
 * The fish's skin, as a smooth closed surface wrapped around the simulated
 * centreline.
 *
 * The physics samples the body at 24 slices, which is plenty for the water but
 * far too coarse to look at: drawn directly, each slice shows as a facet, the
 * snout is an open tube and the tail stalk ends in a hole. So the surface is
 * resampled here — a smooth curve through the slice centres, many more rings
 * along it, and a snout and tail stalk that close. The depth and width at every
 * ring still come from the same `bodyDepth`/`bodyWidth` profile the physics
 * integrates; only the two ends are reshaped, because the physics profile has
 * a flat face at the snout (it only needs the area of each slice, not the
 * outline).
 *
 * Cross-sections are not plain ellipses either. A betta is narrower along the
 * top of its back than across its belly, and its snout sits high with the
 * throat curving down beneath it; both are small changes that decide whether
 * the silhouette reads as a fish or a capsule.
 */
export class BodyMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;
  /** Rings along the body, snout tip to tail stalk. */
  readonly ringCount: number;

  /** Per ring: distance from the snout, and the shape of the cross-section there. */
  private readonly ringArc: Float64Array;
  private readonly ringS: Float64Array;
  private readonly ringHalfWidth: Float64Array;
  private readonly ringTop: Float64Array;
  private readonly ringBottom: Float64Array;
  private readonly ringLift: Float64Array;
  /** Which physics segment each ring falls after, and how far towards the next. */
  private readonly ringSeg: Int32Array;
  private readonly ringT: Float64Array;

  /** World-space positions and the ring centres, rebuilt every frame. */
  private readonly world: Float64Array;
  private readonly centres: Float64Array;
  private readonly tangents: Float64Array;

  private readonly local = v3();
  private readonly out = v3();
  private readonly pos = v3();
  private readonly nrm = v3();
  private readonly up = v3();
  private readonly tan = v3();
  private readonly da = v3();
  private readonly db = v3();
  private readonly n = v3();

  constructor(private readonly morph: Morphology) {
    const L = morph.standardLength;
    const arcs: number[] = [];
    for (let k = 0; k < NOSE_RINGS; k++) {
      arcs.push(NOSE_LENGTH * (1 - Math.cos(((k / NOSE_RINGS) * Math.PI) / 2)));
    }
    for (let k = 0; k <= BODY_RINGS; k++) {
      arcs.push(NOSE_LENGTH + ((L - NOSE_LENGTH) * k) / BODY_RINGS);
    }
    this.ringCount = arcs.length;

    const n = this.ringCount;
    this.ringArc = new Float64Array(arcs);
    this.ringS = new Float64Array(n);
    this.ringHalfWidth = new Float64Array(n);
    this.ringTop = new Float64Array(n);
    this.ringBottom = new Float64Array(n);
    this.ringLift = new Float64Array(n);
    this.ringSeg = new Int32Array(n);
    this.ringT = new Float64Array(n);

    const segs = morph.segments;
    for (let i = 0; i < n; i++) {
      const a = arcs[i];
      const s = a / L;
      this.ringS[i] = s;

      // The snout: a tapering cap, so the head closes to a blunt point instead
      // of ending in the physics profile's flat face. Parabolic rather than
      // round: a hemisphere here makes the head a bulb.
      const x = Math.min(1, a / NOSE_LENGTH);
      const nose = 1 - (1 - x) * (1 - x);
      // The tail stalk flattens into a blade where the tail fin takes over,
      // and closes to an edge at its very end.
      const stalk = 1 - 0.85 * smoothstep(0.9, 1.0, s);
      const closed = i === n - 1 ? 0 : 1;

      const depth = bodyDepth(Math.min(1, s)) * nose;
      this.ringHalfWidth[i] = bodyWidth(Math.min(1, s)) * 0.5 * nose * stalk * closed;

      // A deeper belly than back over the front half of the fish, where the
      // gut is, and the snout carried high so the mouth sits near the top of
      // the head as a betta's does.
      const belly = 0.14 * Math.exp(-Math.pow((s - 0.3) / 0.16, 2));
      this.ringTop[i] = depth * 0.5 * (1 - belly);
      this.ringBottom[i] = depth * 0.5 * (1 + belly);
      this.ringLift[i] = 0.0011 * (1 - smoothstep(0.0, 0.32, s));

      // Bracket the ring between physics segments for interpolation.
      let k = 0;
      while (k < segs.length - 2 && segs[k + 1].arc <= a) k++;
      this.ringSeg[i] = k;
      this.ringT[i] = (a - segs[k].arc) / (segs[k + 1].arc - segs[k].arc);
    }

    const stride = RING + 1; // the ring's first vertex repeated, so texture coordinates can wrap
    this.vertices = new Float32Array(n * stride * VERTEX_FLOATS);
    this.world = new Float64Array(n * stride * 3);
    this.centres = new Float64Array(n * 3);
    this.tangents = new Float64Array(n * 3);

    const idx = new Uint16Array((n - 1) * RING * 6);
    let q = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < RING; j++) {
        const a = i * stride + j;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx[q++] = a;
        idx[q++] = b;
        idx[q++] = c;
        idx[q++] = b;
        idx[q++] = d;
        idx[q++] = c;
      }
    }
    this.indices = idx;
  }

  /**
   * Rebuild the surface for the body's current pose.
   *
   * Cheap enough to do on the CPU every frame for one fish — a couple of
   * thousand vertices — and it keeps the geometry exactly in step with the
   * physics without a skinning shader to get out of sync.
   */
  update(body: FishBody, loco: FishLocomotion, gillFlare: number): void {
    const n = this.ringCount;
    const stride = RING + 1;
    const segs = body.segments;
    const w = this.world;

    for (let i = 0; i < n; i++) {
      const k = this.ringSeg[i];
      const t = this.ringT[i];
      const s0 = segs[Math.max(0, k - 1)];
      const s1 = segs[k];
      const s2 = segs[k + 1];
      const s3 = segs[Math.min(segs.length - 1, k + 2)];

      if (t < 0) {
        // Ahead of the first slice: carry straight on along the head's axis.
        const ahead = this.morph.segments[k].arc - this.ringArc[i];
        this.pos.x = s1.pos.x - s1.tangent.x * ahead;
        this.pos.y = s1.pos.y - s1.tangent.y * ahead;
        this.pos.z = s1.pos.z - s1.tangent.z * ahead;
        copy(this.nrm, s1.normal);
        copy(this.up, s1.up);
        copy(this.tan, s1.tangent);
      } else {
        // Catmull-Rom through the slice centres, so the outline bends smoothly
        // rather than in a chain of straight pieces.
        const t2 = t * t;
        const t3 = t2 * t;
        const c0 = -0.5 * t3 + t2 - 0.5 * t;
        const c1 = 1.5 * t3 - 2.5 * t2 + 1;
        const c2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
        const c3 = 0.5 * t3 - 0.5 * t2;
        this.pos.x = c0 * s0.pos.x + c1 * s1.pos.x + c2 * s2.pos.x + c3 * s3.pos.x;
        this.pos.y = c0 * s0.pos.y + c1 * s1.pos.y + c2 * s2.pos.y + c3 * s3.pos.y;
        this.pos.z = c0 * s0.pos.z + c1 * s1.pos.z + c2 * s2.pos.z + c3 * s3.pos.z;
        lerpV(this.nrm, s1.normal, s2.normal, t);
        normalize(this.nrm, this.nrm);
        lerpV(this.up, s1.up, s2.up, t);
        normalize(this.up, this.up);
        lerpV(this.tan, s1.tangent, s2.tangent, t);
        normalize(this.tan, this.tan);
      }

      // The gill covers swing out during a threat display. It is a small change
      // in geometry and a very large change in what the animal looks like it is
      // doing — the head roughly doubles in apparent width.
      const s = this.ringS[i];
      let flare = 1;
      if (s < 0.22) {
        const f = 1 - s / 0.22;
        flare = 1 + gillFlare * 1.15 * f * f;
      }
      const hw = this.ringHalfWidth[i] * flare;
      const top = this.ringTop[i];
      const bottom = this.ringBottom[i];
      const lift = this.ringLift[i];

      loco.toWorld(this.pos, this.out);
      this.centres[i * 3] = this.out.x;
      this.centres[i * 3 + 1] = this.out.y;
      this.centres[i * 3 + 2] = this.out.z;
      loco.dirToWorld(this.tan, this.out);
      this.tangents[i * 3] = this.out.x;
      this.tangents[i * 3 + 1] = this.out.y;
      this.tangents[i * 3 + 2] = this.out.z;

      for (let j = 0; j <= RING; j++) {
        // j = 0 is the top of the back, RING/2 the middle of the belly.
        const phi = ((j % RING) / RING) * Math.PI * 2;
        const side = Math.sin(phi);
        const vert = Math.cos(phi);
        // Narrower along the ridge of the back, fuller through the belly.
        const pinch = 1 - 0.28 * Math.max(0, vert) * Math.max(0, vert) - 0.08 * vert * vert * (vert < 0 ? 1 : 0);
        const x = hw * side * pinch;
        const y = (vert > 0 ? top : bottom) * vert + lift;

        this.local.x = this.pos.x + this.nrm.x * x + this.up.x * y;
        this.local.y = this.pos.y + this.nrm.y * x + this.up.y * y;
        this.local.z = this.pos.z + this.nrm.z * x + this.up.z * y;
        loco.toWorld(this.local, this.out);
        const o = (i * stride + j) * 3;
        w[o] = this.out.x;
        w[o + 1] = this.out.y;
        w[o + 2] = this.out.z;

        const v = (i * stride + j) * VERTEX_FLOATS;
        this.vertices[v + 7] = this.ringArc[i] * 1000; // along the body, mm
        this.vertices[v + 8] = s;
        this.vertices[v + 9] = y * 1000; // height above the centreline, mm
      }

      // Distance around the ring from the top of the back, taken the short way
      // round so it is the same on both flanks. Scales are laid out in these
      // millimetres, which keeps them the same size from head to tail and
      // leaves no seam anywhere on the body.
      let around = 0;
      const base = i * stride;
      const vtx = this.vertices;
      vtx[base * VERTEX_FLOATS + 6] = 0;
      const perimeter = (() => {
        let p = 0;
        for (let j = 0; j < RING; j++) {
          const a = (base + j) * 3;
          const b = (base + j + 1) * 3;
          p += Math.hypot(w[b] - w[a], w[b + 1] - w[a + 1], w[b + 2] - w[a + 2]);
        }
        return p;
      })();
      for (let j = 1; j <= RING; j++) {
        const a = (base + j - 1) * 3;
        const b = (base + j) * 3;
        around += Math.hypot(w[b] - w[a], w[b + 1] - w[a + 1], w[b + 2] - w[a + 2]);
        vtx[(base + j) * VERTEX_FLOATS + 6] = Math.min(around, perimeter - around) * 1000;
      }
    }

    // Normals from the surface itself, by differencing neighbouring vertices.
    // The cross-section is no longer an ellipse and the rings are bent by the
    // body wave, so an analytic normal would be wrong in both respects.
    for (let i = 0; i < n; i++) {
      const iP = Math.max(0, i - 1);
      const iN = Math.min(n - 1, i + 1);
      for (let j = 0; j <= RING; j++) {
        const jj = j % RING;
        const jP = (jj + RING - 1) % RING;
        const jN = (jj + 1) % RING;
        const pa = (i * stride + jP) * 3;
        const pb = (i * stride + jN) * 3;
        const qa = (iP * stride + jj) * 3;
        const qb = (iN * stride + jj) * 3;
        set(this.da, w[pb] - w[pa], w[pb + 1] - w[pa + 1], w[pb + 2] - w[pa + 2]);
        set(this.db, w[qb] - w[qa], w[qb + 1] - w[qa + 1], w[qb + 2] - w[qa + 2]);
        cross(this.n, this.db, this.da);
        const o = (i * stride + j) * 3;
        const ox = w[o] - this.centres[i * 3];
        const oy = w[o + 1] - this.centres[i * 3 + 1];
        const oz = w[o + 2] - this.centres[i * 3 + 2];
        if (this.n.x * this.n.x + this.n.y * this.n.y + this.n.z * this.n.z < 1e-24) {
          // The snout tip, where the ring has shrunk to a point: face forwards.
          set(this.n, -this.tangents[i * 3], -this.tangents[i * 3 + 1], -this.tangents[i * 3 + 2]);
        } else if (this.n.x * ox + this.n.y * oy + this.n.z * oz < 0) {
          scale(this.n, this.n, -1);
        }
        normalize(this.n, this.n);

        const v = (i * stride + j) * VERTEX_FLOATS;
        this.vertices[v] = w[o];
        this.vertices[v + 1] = w[o + 1];
        this.vertices[v + 2] = w[o + 2];
        this.vertices[v + 3] = this.n.x;
        this.vertices[v + 4] = this.n.y;
        this.vertices[v + 5] = this.n.z;
      }
    }
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
    // As a grid rather than two triangles. Refraction moves each vertex by a
    // different amount (see apparentPosition in the shaders), and straight
    // edges seen through the water really do bow; a wall drawn as one quad
    // would stay flat and straight between its corners.
    const S = 12;
    const base = verts.length / VERTEX_FLOATS;
    const p = v3();
    for (let j = 0; j <= S; j++) {
      for (let i = 0; i <= S; i++) {
        const s = i / S;
        const t = j / S;
        // Bilinear across the quad a-b-c-d.
        p.x = (1 - t) * ((1 - s) * a.x + s * b.x) + t * ((1 - s) * d.x + s * c.x);
        p.y = (1 - t) * ((1 - s) * a.y + s * b.y) + t * ((1 - s) * d.y + s * c.y);
        p.z = (1 - t) * ((1 - s) * a.z + s * b.z) + t * ((1 - s) * d.z + s * c.z);
        push(p, n, s * uvScale, t * uvScale, kind);
      }
    }
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const i0 = base + j * (S + 1) + i;
        const i1 = i0 + 1;
        const i3 = i0 + (S + 1);
        const i2 = i3 + 1;
        idx.push(i0, i1, i2, i0, i2, i3);
      }
    }
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

  // Back wall and the two sides, seen from inside. Each is split at the
  // waterline: the part under water is drawn where refraction makes it appear
  // and the part above is not, and the kink between them at the waterline is
  // real — look at the side of any tank through its front.
  const yW = TANK.waterY;
  quad(v3(x0, TANK.floorY, z0), v3(x1, TANK.floorY, z0), v3(x1, yW, z0), v3(x0, yW, z0), v3(0, 0, 1), 1);
  quad(v3(x0, yW, z0), v3(x1, yW, z0), v3(x1, yTop, z0), v3(x0, yTop, z0), v3(0, 0, 1), 1);
  quad(v3(x0, TANK.floorY, z1), v3(x0, TANK.floorY, z0), v3(x0, yW, z0), v3(x0, yW, z1), v3(1, 0, 0), 1);
  quad(v3(x0, yW, z1), v3(x0, yW, z0), v3(x0, yTop, z0), v3(x0, yTop, z1), v3(1, 0, 0), 1);
  quad(v3(x1, TANK.floorY, z0), v3(x1, TANK.floorY, z1), v3(x1, yW, z1), v3(x1, yW, z0), v3(-1, 0, 0), 1);
  quad(v3(x1, yW, z0), v3(x1, yW, z1), v3(x1, yTop, z1), v3(x1, yTop, z0), v3(-1, 0, 0), 1);

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
