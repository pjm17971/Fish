/**
 * Fins, simulated as flexible sheets rather than animated.
 *
 * A betta's fins are enormous, thin, and slow to follow the body. Rigging them
 * to a skeleton and keying a delay gets you something that looks approximately
 * right from one angle and obviously wrong from any other, because the shape a
 * real fin takes is set by the water pushing on it, and that changes with every
 * turn, stop and flare. So they are simulated.
 *
 * ## Structure
 *
 * Each fin is a set of **rays** — in a real fin these are jointed bony spines —
 * spread from an attachment on the body, with a soft **membrane** webbed between
 * neighbouring rays. Every ray is a chain of nodes at fixed spacing.
 *
 * The body drives the first *two* nodes of every ray, not just one. That detail
 * decides whether the fin works at all: pinned at a single point a fin can pivot
 * freely, so it weathervanes into the flow, meets the water edge-on, and
 * produces pure drag — a tail like that cannot propel anything, which is exactly
 * what the first version did. A real fin base is embedded in the body with its
 * own bending stiffness, and muscles at the base set its angle. Driving two
 * nodes reproduces that, and the lag between the driven base and the trailing
 * rest of the fin gives it an angle of attack, which is where thrust comes from.
 *
 * ## Why this is a chain sweep and not a constraint solver
 *
 * The natural choice is a mass-spring or XPBD cloth. It does not survive contact
 * with this problem. The fin's tissue mass is a tenth of a gram while the water
 * it carries is several grams; the rays need to be near-inextensible; and the
 * root is teleported every substep by a body beating up to nine times a second.
 * A stiff positional solver under those conditions injects energy through its
 * own projections faster than any plausible damping removes it — with the tail
 * held perfectly still, the fin rang at a metre per second indefinitely and drove
 * the fish across the tank. That is not a tuning problem.
 *
 * So the length constraint is enforced **by construction** instead of by
 * iteration. Nodes are integrated outward from the root, one at a time, and each
 * is projected onto the sphere of the right radius about its parent — which has
 * already reached its final position. Lengths are then exact, there is no
 * iteration to diverge, and stability does not depend on stiffness, timestep or
 * mass ratio. Bending resistance and the membrane sit on top as an ordinary
 * force and a smoothing pass, both of which can only remove energy.
 *
 * ## Added mass
 *
 * A sheet accelerating broadside drags water with it. Two things about that are
 * easy to get wrong, and both are fatal:
 *
 *   - **It is directional.** A thin sheet carries a slab of water when it sweeps
 *     broadside and essentially none when it slides edge-on. One scalar mass
 *     used in every direction turns the tail into a sea anchor several times the
 *     fish's own mass, and the fish cannot accelerate at all.
 *
 *   - **It does not divide evenly.** Added mass grows with the cube of size, not
 *     the square, so sharing a whole-plate figure between ninety-nine particles
 *     gives each about fourteen times what a patch that size really carries, and
 *     the fin lags so hard it folds to a fifth of its length. The right quantity
 *     for a sheet carrying a deformation of wavelength lambda is the
 *     potential-flow result rho*lambda/(2*pi) per unit area; a fin bending over
 *     its own length carries a lambda of about twice its extent.
 *
 * ## What the body feels
 *
 * The fin surfaces are loaded by the same model as the body — reactive (added
 * mass) plus resistive (cross-flow drag) — evaluated on the shape the sweep just
 * produced, and applied to the fish where the surface actually is. The split
 * that keeps it stable is the same one as in locomotion.ts:
 *
 *   - The share of the fins' added mass that goes with the fish's *rigid* motion
 *     lives in the fish's mass matrix (morphology.ts puts it there), implicit and
 *     unable to feed back. It is large — the fins roughly triple the fish's
 *     sideways added mass, a real and characteristic fact about a long-finned
 *     betta and much of why it handles like a barge.
 *
 *   - Only motion *relative to the body* is differentiated in time and applied
 *     explicitly. That is a solved state, not the fish's own acceleration, so
 *     there is no loop.
 */

import {
  Vec3,
  v3,
  set,
  copy,
  add,
  sub,
  scale,
  addScaled,
  cross,
  dot,
  len,
  normalize,
  quatRotate,
} from './math.js';
import { FINS, FISH, RHO_WATER } from './config.js';
import { Morphology } from './morphology.js';
import { FishBody } from './fishBody.js';
import { FishLocomotion } from './locomotion.js';
import { BulkFlow } from './water.js';

/** Where one ray root is pinned on the body. */
export interface Attachment {
  /** Index into the body's segment list. */
  segment: number;
  /** Offset in that segment's local frame: along the lateral normal, and along up. */
  offNormal: number;
  offUp: number;
}

export interface FinSpec {
  name: string;
  /** Number of rays. */
  rays: number;
  /** Nodes along each ray, including the two the body drives. */
  along: number;
  /** How far the fin extends from the body, in metres. */
  extent: number;
  /**
   * Width of the fin across the rays. For a fanning fin this is the arc its
   * trailing edge sweeps, not the width of its root.
   */
  span: number;
  /**
   * Half-angle the rays fan through, in radians.
   *
   * A betta's caudal fin attaches to a stalk barely a millimetre deep and opens
   * out to three centimetres across. That only happens because the rays radiate.
   */
  fanHalfAngle: number;
  attachments: Attachment[];
  /**
   * Direction the fin extends, in a body segment's own frame, as
   * (along normal, along up, along tangent). The tangent points tailward.
   */
  outward: Vec3;
  /** Direction the fan opens towards, same frame; perpendicular to `outward`. */
  fanDir: Vec3;
  /** How far the fin trails backwards. Without it the unpaired fins stand up like sails. */
  rake: number;
  /** How much this fin responds to the fish clamping or flaring, 0 to 1. */
  spreadResponse: number;
}

/** Nodes per ray that the body drives directly. See the note at the top. */
const DRIVEN = 2;

export class FinCloth {
  readonly spec: FinSpec;
  readonly count: number;
  /** Spacing between nodes along a ray. */
  readonly nodeSpacing: number;

  /** World-space node positions and velocities, xyz-interleaved. */
  readonly pos: Float64Array;
  readonly vel: Float64Array;
  private readonly prevPos: Float64Array;
  private readonly smoothed: Float64Array;

  /** True for nodes the body drives; they take no forces of their own. */
  readonly driven: Uint8Array;
  /** Mass of the fin tissue itself, per node. */
  readonly massTissue: Float64Array;
  /** Mass of water carried, for motion normal to the sheet only. */
  readonly massAdded: Float64Array;
  /** Surface area each node is responsible for. */
  readonly area: Float64Array;
  /** Membrane thickness at each node — thicker on a ray. The shader reads this too. */
  readonly thickness: Float32Array;
  /** Sheet normal at each node, kept continuous between frames. */
  readonly normals: Float64Array;
  /**
   * Velocity damping rate, per second, set to a fraction of critical for this
   * fin's own ray bending mode. See FINS.dampingRatio.
   */
  private readonly dampingRate: number;


  private readonly tmpA = v3();
  private readonly tmpB = v3();
  private readonly tmpC = v3();
  private readonly tmpN = v3();
  private readonly tmpV = v3();
  private readonly tmpF = v3();
  private readonly tmpR = v3();
  private readonly tmpOut = v3();

  constructor(spec: FinSpec) {
    this.spec = spec;
    this.count = spec.rays * spec.along;
    this.nodeSpacing = spec.extent / Math.max(1, spec.along - 1);

    const n = this.count;
    this.pos = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.prevPos = new Float64Array(n * 3);
    this.smoothed = new Float64Array(n * 3);
    this.driven = new Uint8Array(n);
    this.massTissue = new Float64Array(n);
    this.massAdded = new Float64Array(n);
    this.area = new Float64Array(n);
    this.thickness = new Float32Array(n);
    this.normals = new Float64Array(n * 3);

    const totalArea = spec.extent * spec.span;
    const areaPer = totalArea / n;
    // Potential flow over a sheet carrying a deformation of wavelength lambda:
    // rho*lambda/(2*pi) of entrained water per unit area, with lambda about
    // twice the fin's extent. For the caudal fin that is 7.6 kg/m^2, or five and
    // a half grams in total — nearly four times the fish's own mass.
    const addedPerArea = (RHO_WATER * spec.extent) / Math.PI;

    for (let r = 0; r < spec.rays; r++) {
      for (let j = 0; j < spec.along; j++) {
        const i = r * spec.along + j;
        this.driven[i] = j < DRIVEN ? 1 : 0;
        this.area[i] = areaPer;
        this.massTissue[i] = (totalArea * FINS.arealDensity) / n;
        this.massAdded[i] = addedPerArea * areaPer;
        const t = j / Math.max(1, spec.along - 1);
        this.thickness[i] = FINS.rayThickness * (1 - t) + FINS.membraneThickness * t;
      }
    }

    // Critical damping for a mass on a spring is 2*sqrt(k*m); as a rate on the
    // velocity that is 2*zeta*sqrt(k/m).
    const nodeMass = this.massTissue[0] + this.massAdded[0];
    this.dampingRate = 2 * FINS.dampingRatio * Math.sqrt(FINS.rayStiffness / nodeMass);
  }

  /** Natural frequency of this fin's ray bending mode, in Hz. Used by a test. */
  get rayModeHz(): number {
    const nodeMass = this.massTissue[0] + this.massAdded[0];
    return Math.sqrt(FINS.rayStiffness / nodeMass) / (2 * Math.PI);
  }

  private index(r: number, j: number): number {
    return r * this.spec.along + j;
  }

  /** World position and velocity of a point attached to the body. */
  private attachmentWorld(
    body: FishBody,
    loco: FishLocomotion,
    att: Attachment,
    outPos: Vec3,
    outVel: Vec3,
  ): void {
    const st = body.segments[Math.min(att.segment, body.segments.length - 1)];
    copy(this.tmpA, st.pos);
    addScaled(this.tmpA, st.normal, att.offNormal);
    addScaled(this.tmpA, st.up, att.offUp);
    quatRotate(this.tmpR, loco.orientation, this.tmpA);
    add(outPos, loco.position, this.tmpR);

    cross(outVel, loco.angularVelocity, this.tmpR);
    add(outVel, outVel, loco.velocity);
    quatRotate(this.tmpB, loco.orientation, st.velLocal);
    add(outVel, outVel, this.tmpB);
  }

  /** Direction ray `r` leaves the body in, in world space. */
  private outwardWorld(
    body: FishBody,
    loco: FishLocomotion,
    r: number,
    spread: number,
    out: Vec3,
  ): Vec3 {
    const att = this.spec.attachments[Math.min(r, this.spec.attachments.length - 1)];
    const st = body.segments[Math.min(att.segment, body.segments.length - 1)];

    // Fan the ray about the fin's axis. Spread scales the fan, so a clamped fin
    // really does close towards a line and a flared one opens fully — the actual
    // mechanism, rather than a scale on a fixed shape.
    const t = (r / Math.max(1, this.spec.rays - 1)) * 2 - 1;
    const openness = 1 - this.spec.spreadResponse * (1 - spread);
    const ang = t * this.spec.fanHalfAngle * openness;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    const fN = this.spec.outward.x * ca + this.spec.fanDir.x * sa;
    const fU = this.spec.outward.y * ca + this.spec.fanDir.y * sa;
    const fT = this.spec.outward.z * ca + this.spec.fanDir.z * sa + this.spec.rake;

    // Compose in the segment's own frame, so a fin on a bending body follows the
    // bend rather than sticking out of a straight-line idea of it.
    set(
      this.tmpC,
      fN * st.normal.x + fU * st.up.x + fT * st.tangent.x,
      fN * st.normal.y + fU * st.up.y + fT * st.tangent.y,
      fN * st.normal.z + fU * st.up.z + fT * st.tangent.z,
    );
    normalize(this.tmpC, this.tmpC);
    return quatRotate(out, loco.orientation, this.tmpC);
  }

  /** Lay the fin out straight along its rest direction. */
  initialise(body: FishBody, loco: FishLocomotion, spread: number): void {
    for (let r = 0; r < this.spec.rays; r++) {
      const att = this.spec.attachments[Math.min(r, this.spec.attachments.length - 1)];
      this.attachmentWorld(body, loco, att, this.tmpA, this.tmpV);
      this.outwardWorld(body, loco, r, spread, this.tmpOut);
      for (let j = 0; j < this.spec.along; j++) {
        const i = this.index(r, j);
        this.pos[i * 3] = this.tmpA.x + this.tmpOut.x * this.nodeSpacing * j;
        this.pos[i * 3 + 1] = this.tmpA.y + this.tmpOut.y * this.nodeSpacing * j;
        this.pos[i * 3 + 2] = this.tmpA.z + this.tmpOut.z * this.nodeSpacing * j;
      }
    }
    this.prevPos.set(this.pos);
    this.vel.fill(0);
    this.rebuildNormals(true);
  }

  /**
   * Advance the fin.
   *
   * Note what this does *not* do: it does not push the fish. The fins' effect on
   * the fish's motion is computed in the body's own hydrodynamic chain, where
   * each segment's depth already includes whatever fin is attached there and the
   * caudal fin is carried as a continuation of the body (see morphology.ts).
   * That is Lighthill's elongated-body picture, it is numerically sound, and
   * doing it here as well would count the same water twice.
   *
   * This sheet exists so the fin has a *shape* — so it trails, lags, ripples and
   * furls because the water is moving it, rather than because a curve was keyed
   * to make it look as though it did.
   */
  step(body: FishBody, loco: FishLocomotion, flow: BulkFlow | null, spread: number, dt: number): void {
    const sub = dt / FINS.substeps;
    for (let s = 0; s < FINS.substeps; s++) {
      this.driveBase(body, loco, spread);
      this.sweepRays(flow, sub);
      this.smoothAcrossRays();
      this.rebuildNormals(false);
    }
  }

  /** Place the two nodes of each ray that the body owns. */
  private driveBase(body: FishBody, loco: FishLocomotion, spread: number): void {
    for (let r = 0; r < this.spec.rays; r++) {
      const att = this.spec.attachments[Math.min(r, this.spec.attachments.length - 1)];
      this.attachmentWorld(body, loco, att, this.tmpA, this.tmpV);
      this.outwardWorld(body, loco, r, spread, this.tmpOut);
      for (let j = 0; j < DRIVEN; j++) {
        const i = this.index(r, j);
        this.pos[i * 3] = this.tmpA.x + this.tmpOut.x * this.nodeSpacing * j;
        this.pos[i * 3 + 1] = this.tmpA.y + this.tmpOut.y * this.nodeSpacing * j;
        this.pos[i * 3 + 2] = this.tmpA.z + this.tmpOut.z * this.nodeSpacing * j;
        this.vel[i * 3] = this.tmpV.x;
        this.vel[i * 3 + 1] = this.tmpV.y;
        this.vel[i * 3 + 2] = this.tmpV.z;
      }
    }
  }

  /**
   * Integrate each ray outward from its base.
   *
   * Working strictly root to tip is what makes this stable: by the time a node
   * is handled its parent is already in its final position for this substep, so
   * clamping the node to the right distance from that parent is one exact
   * operation rather than something a solver has to converge on.
   */
  private sweepRays(flow: BulkFlow | null, dt: number): void {
    const { rays, along } = this.spec;
    const L = this.nodeSpacing;
    const damp = Math.exp(-this.dampingRate * dt);
    const invDt = 1 / dt;

    for (let r = 0; r < rays; r++) {
      for (let j = DRIVEN; j < along; j++) {
        const i = this.index(r, j);
        const parent = this.index(r, j - 1);
        const grand = this.index(r, j - 2);

        this.prevPos[i * 3] = this.pos[i * 3];
        this.prevPos[i * 3 + 1] = this.pos[i * 3 + 1];
        this.prevPos[i * 3 + 2] = this.pos[i * 3 + 2];

        // --- Water drag, normal to the sheet ---
        set(this.tmpV, this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]);
        if (flow) {
          flow.sample(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.tmpC);
          sub(this.tmpV, this.tmpV, this.tmpC);
        }
        set(this.tmpN, this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]);
        const vn = dot(this.tmpV, this.tmpN);
        const fDrag = -0.5 * RHO_WATER * FISH.crossFlowCd * this.area[i] * Math.abs(vn) * vn;
        scale(this.tmpF, this.tmpN, fDrag);

        // --- Bending: the ray wants to carry straight on from its parent ---
        set(
          this.tmpB,
          this.pos[parent * 3] - this.pos[grand * 3],
          this.pos[parent * 3 + 1] - this.pos[grand * 3 + 1],
          this.pos[parent * 3 + 2] - this.pos[grand * 3 + 2],
        );
        normalize(this.tmpB, this.tmpB);
        // Rays taper, so they get floppier towards the tip, as real ones do.
        const stiffness = FINS.rayStiffness * Math.pow(1 - (j - 1) / along, 1.5);
        this.tmpF.x += stiffness * (this.pos[parent * 3] + this.tmpB.x * L - this.pos[i * 3]);
        this.tmpF.y += stiffness * (this.pos[parent * 3 + 1] + this.tmpB.y * L - this.pos[i * 3 + 1]);
        this.tmpF.z += stiffness * (this.pos[parent * 3 + 2] + this.tmpB.z * L - this.pos[i * 3 + 2]);

        // Normal-direction mass: the sheet carries water only when it sweeps
        // broadside. Along the sheet it is nearly massless, but that direction
        // is governed by the length projection below anyway, so using the normal
        // mass throughout is both simpler and better conditioned.
        const invM = 1 / (this.massTissue[i] + this.massAdded[i]);
        this.vel[i * 3] = (this.vel[i * 3] + this.tmpF.x * invM * dt) * damp;
        this.vel[i * 3 + 1] = (this.vel[i * 3 + 1] + this.tmpF.y * invM * dt) * damp;
        this.vel[i * 3 + 2] = (this.vel[i * 3 + 2] + this.tmpF.z * invM * dt) * damp;

        this.pos[i * 3] += this.vel[i * 3] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
        this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

        // --- Inextensibility, enforced exactly ---
        let dx = this.pos[i * 3] - this.pos[parent * 3];
        let dy = this.pos[i * 3 + 1] - this.pos[parent * 3 + 1];
        let dz = this.pos[i * 3 + 2] - this.pos[parent * 3 + 2];
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) {
          // Degenerate: fall back on the direction the parent came in on.
          dx = this.tmpB.x;
          dy = this.tmpB.y;
          dz = this.tmpB.z;
          d = 1;
        }
        const k = L / d;
        this.pos[i * 3] = this.pos[parent * 3] + dx * k;
        this.pos[i * 3 + 1] = this.pos[parent * 3 + 1] + dy * k;
        this.pos[i * 3 + 2] = this.pos[parent * 3 + 2] + dz * k;

        // Velocity from what actually happened, so the projection cannot leave
        // energy behind in a velocity the position never took.
        this.vel[i * 3] = (this.pos[i * 3] - this.prevPos[i * 3]) * invDt;
        this.vel[i * 3 + 1] = (this.pos[i * 3 + 1] - this.prevPos[i * 3 + 1]) * invDt;
        this.vel[i * 3 + 2] = (this.pos[i * 3 + 2] - this.prevPos[i * 3 + 2]) * invDt;
      }
    }
  }

  /**
   * The membrane: pull each node a little towards the average of its neighbours
   * on the adjacent rays, then re-fix the ray lengths.
   *
   * This is the webbing between the rays. Doing it as smoothing rather than as
   * constraints keeps it unconditionally dissipative — it can only move a node
   * towards where its neighbours already are, never past them.
   */
  private smoothAcrossRays(): void {
    const { rays, along } = this.spec;
    if (rays < 2) return;
    const w = FINS.membraneCoupling;
    this.smoothed.set(this.pos);

    for (let r = 0; r < rays; r++) {
      for (let j = DRIVEN; j < along; j++) {
        const i = this.index(r, j);
        const a = this.index(Math.max(0, r - 1), j);
        const b = this.index(Math.min(rays - 1, r + 1), j);
        // The webbing is taut near the body and loose at the trailing edge,
        // which is what gives a betta's tail its rippling outer margin.
        const t = j / (along - 1);
        const wj = w * (1 - 0.6 * t);
        for (let c = 0; c < 3; c++) {
          const avg = 0.5 * (this.pos[a * 3 + c] + this.pos[b * 3 + c]);
          this.smoothed[i * 3 + c] = this.pos[i * 3 + c] + wj * (avg - this.pos[i * 3 + c]);
        }
      }
    }
    this.pos.set(this.smoothed);

    // Smoothing moves nodes off their parents' spheres, so re-fix the lengths —
    // still outward, so each parent is settled before its child is touched.
    const L = this.nodeSpacing;
    for (let r = 0; r < rays; r++) {
      for (let j = DRIVEN; j < along; j++) {
        const i = this.index(r, j);
        const p = this.index(r, j - 1);
        const dx = this.pos[i * 3] - this.pos[p * 3];
        const dy = this.pos[i * 3 + 1] - this.pos[p * 3 + 1];
        const dz = this.pos[i * 3 + 2] - this.pos[p * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) continue;
        const k = L / d;
        this.pos[i * 3] = this.pos[p * 3] + dx * k;
        this.pos[i * 3 + 1] = this.pos[p * 3 + 1] + dy * k;
        this.pos[i * 3 + 2] = this.pos[p * 3 + 2] + dz * k;
      }
    }
  }

  /**
   * Sheet normals, kept pointing the same way they did last frame.
   *
   * A cross product of two grid directions takes whichever sign the geometry
   * happens to give it, and on a rippling sheet that sign flips. Drag does not
   * care — it is quadratic, so flipping the normal flips the velocity with it.
   * The reactive term very much does: it differentiates the normal velocity in
   * time, so a flip from one frame to the next reads as the water reversing
   * instantly and injects a huge fictitious impulse. Left unfixed this made even
   * the dorsal fin — a stabiliser that should produce no thrust whatsoever —
   * shove the fish around at random.
   */
  private rebuildNormals(first: boolean): void {
    const { rays, along } = this.spec;
    for (let r = 0; r < rays; r++) {
      for (let j = 0; j < along; j++) {
        const i = this.index(r, j);
        const rN = this.index(Math.min(rays - 1, r + 1), j);
        const rP = this.index(Math.max(0, r - 1), j);
        const jN = this.index(r, Math.min(along - 1, j + 1));
        const jP = this.index(r, Math.max(0, j - 1));

        set(
          this.tmpA,
          this.pos[rN * 3] - this.pos[rP * 3],
          this.pos[rN * 3 + 1] - this.pos[rP * 3 + 1],
          this.pos[rN * 3 + 2] - this.pos[rP * 3 + 2],
        );
        set(
          this.tmpB,
          this.pos[jN * 3] - this.pos[jP * 3],
          this.pos[jN * 3 + 1] - this.pos[jP * 3 + 1],
          this.pos[jN * 3 + 2] - this.pos[jP * 3 + 2],
        );
        cross(this.tmpN, this.tmpA, this.tmpB);
        if (len(this.tmpN) < 1e-14) continue;
        normalize(this.tmpN, this.tmpN);

        if (!first) {
          const px = this.normals[i * 3];
          const py = this.normals[i * 3 + 1];
          const pz = this.normals[i * 3 + 2];
          if (this.tmpN.x * px + this.tmpN.y * py + this.tmpN.z * pz < 0) {
            this.tmpN.x = -this.tmpN.x;
            this.tmpN.y = -this.tmpN.y;
            this.tmpN.z = -this.tmpN.z;
          }
        }
        this.normals[i * 3] = this.tmpN.x;
        this.normals[i * 3 + 1] = this.tmpN.y;
        this.normals[i * 3 + 2] = this.tmpN.z;
      }
    }
  }

}

/**
 * Build the fin set for a male veiltail betta.
 *
 * The proportions are the distinguishing thing about the animal — the caudal fin
 * alone is about a third of its total length, and the anal fin runs nearly the
 * whole underside. Get these wrong and it reads as a generic fish.
 */
export function buildFins(morph: Morphology): FinCloth[] {
  const segs = morph.segments;
  const n = segs.length;
  const L = morph.standardLength;
  const segAt = (s: number): number => Math.max(0, Math.min(n - 1, Math.round(s * n - 0.5)));

  const fins: FinCloth[] = [];

  // --- Caudal: rays radiate from the peduncle and fan vertically ---
  {
    const spec = FINS.caudal;
    const attachments: Attachment[] = [];
    for (let r = 0; r < spec.rows; r++) {
      const t = r / (spec.rows - 1);
      attachments.push({
        segment: n - 1,
        offNormal: 0,
        offUp: (t - 0.5) * segs[n - 1].depth * 1.2,
      });
    }
    // Half-angle set so the trailing edge sweeps the intended span:
    // span = 2 * chord * sin(halfAngle).
    const half = Math.asin(Math.min(0.98, spec.span / (2 * spec.chord)));
    fins.push(
      new FinCloth({
        name: 'caudal',
        rays: spec.rows,
        along: spec.cols,
        extent: spec.chord,
        span: spec.span,
        fanHalfAngle: half,
        attachments,
        outward: v3(0, 0, 1), // along the body tangent, which points tailward
        fanDir: v3(0, 1, 0), // fans up and down
        rake: 0.0,
        spreadResponse: 0.75,
      }),
    );
  }

  // --- Dorsal: along the back ---
  {
    const spec = FINS.dorsal;
    const attachments: Attachment[] = [];
    for (let r = 0; r < spec.rows; r++) {
      const t = r / (spec.rows - 1);
      const idx = segAt(spec.fromS + (spec.toS - spec.fromS) * t);
      attachments.push({ segment: idx, offNormal: 0, offUp: segs[idx].depth * 0.5 });
    }
    fins.push(
      new FinCloth({
        name: 'dorsal',
        rays: spec.rows,
        along: spec.cols,
        extent: spec.height,
        span: (spec.toS - spec.fromS) * L,
        fanHalfAngle: 0.22,
        attachments,
        outward: v3(0, 1, 0),
        fanDir: v3(0, 0, 1),
        rake: 0.55,
        spreadResponse: 1.0,
      }),
    );
  }

  // --- Anal: along the belly, running nearly the whole underside ---
  {
    const spec = FINS.anal;
    const attachments: Attachment[] = [];
    for (let r = 0; r < spec.rows; r++) {
      const t = r / (spec.rows - 1);
      const idx = segAt(spec.fromS + (spec.toS - spec.fromS) * t);
      attachments.push({ segment: idx, offNormal: 0, offUp: -segs[idx].depth * 0.5 });
    }
    fins.push(
      new FinCloth({
        name: 'anal',
        rays: spec.rows,
        along: spec.cols,
        extent: spec.height,
        span: (spec.toS - spec.fromS) * L,
        fanHalfAngle: 0.22,
        attachments,
        outward: v3(0, -1, 0),
        fanDir: v3(0, 0, 1),
        rake: 0.45,
        spreadResponse: 1.0,
      }),
    );
  }

  // --- Pelvics: the pair of long ventral streamers ---
  for (const side of [-1, 1]) {
    const spec = FINS.pelvic;
    const idx = segAt(spec.attachS);
    const attachments: Attachment[] = [];
    for (let r = 0; r < spec.rows; r++) {
      const t = r / (spec.rows - 1);
      attachments.push({
        segment: idx,
        offNormal: side * segs[idx].width * 0.35,
        offUp: -segs[idx].depth * 0.45 + (t - 0.5) * 0.0008,
      });
    }
    fins.push(
      new FinCloth({
        name: side < 0 ? 'pelvicLeft' : 'pelvicRight',
        rays: spec.rows,
        along: spec.cols,
        extent: spec.height,
        span: 0.0035,
        fanHalfAngle: 0.16,
        attachments,
        outward: v3(0, -1, 0),
        fanDir: v3(0, 0, 1),
        rake: 0.35,
        spreadResponse: 0.6,
      }),
    );
  }

  return fins;
}
