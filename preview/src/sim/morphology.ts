/**
 * The fish's shape: how deep, how wide and how heavy it is at every point along
 * its body, plus the derived quantities the physics needs (segment mass, added
 * mass, wetted area, inertia tensor).
 *
 * This is computed once at startup from the profile functions in the spec rather
 * than loaded from a modelling package, so the physics and the rendered mesh are
 * guaranteed to be the same animal. A mesh imported from a DCC tool and a
 * hand-tuned collision shape drifting apart is the usual reason a simulated
 * creature ends up feeling wrong in a way nobody can point at.
 */

import { FINS, FISH, RHO_WATER } from './config.js';

export interface Segment {
  /** Normalised arc position, 0 at the snout, 1 at the caudal peduncle. */
  s: number;
  /** Distance from the snout along the centreline. */
  arc: number;
  /** Arc length this segment is responsible for. */
  ds: number;
  /** Body depth (dorsal to ventral) here, flesh only. */
  depth: number;
  /**
   * Depth including whatever median fin is attached here.
   *
   * This is the depth the *water* sees, and it is what the added mass and the
   * cross-flow drag are computed from. A dorsal fin does not add mass to the
   * fish worth speaking of, but it very much adds surface for the water to push
   * on — treating the fish as a bare body and the fins as separate objects
   * bolted on afterwards is the harder and less accurate way round.
   */
  hydroDepth: number;
  /** True for the segments that make up the caudal fin rather than the body. */
  isCaudal: boolean;
  /** Body width (left to right) here. */
  width: number;
  /** Elliptical cross-sectional area. */
  area: number;
  /** Mass of this slice. */
  mass: number;
  /**
   * Added mass per unit length for broadside motion: (pi/4) * rho * depth^2.
   * This is the water an accelerating slice has to drag with it, and it is
   * where thrust comes from — the momentum thrown into the wake.
   */
  addedMassPerLength: number;
  /** Wetted surface area of the slice, for skin friction. */
  wettedArea: number;
  /** Lateral (broadside) projected area, for cross-flow drag. */
  lateralArea: number;
}

export interface Morphology {
  segments: Segment[];
  standardLength: number;
  totalMass: number;
  /** Volume of the body, from the elliptical cross-sections. */
  volume: number;
  /** Distance of the centre of mass from the snout, along the body. */
  comArc: number;
  /** Total arc length of the segment chain, body plus caudal fin. */
  totalArc: number;
  /** Segment index nearest the centre of mass. */
  comSegment: number;
  /** Principal moments of inertia about the centre of mass: [roll, pitch, yaw]. */
  inertia: [number, number, number];
  /**
   * Added mass of the water the body has to shove aside when it accelerates,
   * in kilograms, along [surge (forwards), sway (sideways), heave (up/down)].
   *
   * These are integrated from the real cross-sections rather than guessed as
   * multiples of body mass, and the answer is startling: sideways added mass
   * comes out at about 2.5 times the fish's own mass, because a laterally
   * compressed body moving broadside drags an enormous slug of water. Guessing
   * "about the same as body mass" — the usual shortcut — understates it by more
   * than half and makes the fish slide sideways in a way that reads as
   * weightless.
   */
  addedMass: [number, number, number];
  /** Added moment of inertia, [roll, pitch, yaw], in kg m^2. */
  addedInertia: [number, number, number];
  /** Body inertia plus added inertia, still in [roll, pitch, yaw] order. */
  effectiveInertia: [number, number, number];
  /**
   * The same thing in **body-axis order** — [about x, about y, about z] — which
   * is what the angular solver needs.
   *
   * Both forms exist because the two orderings are not the same permutation and
   * mixing them up is invisible. Body x is the fish's right, so rotation about
   * it is *pitch*; body y is up, so that is *yaw*; body z is forward, so that is
   * *roll*. Reading a [roll, pitch, yaw] array as [x, y, z] therefore gives the
   * fish its roll inertia about its pitch axis and vice versa. With the fins
   * making yaw inertia eighty times roll, the gyroscopic term in Euler's
   * equations then had wildly mismatched inertias to work with and went unstable
   * above about seven radians per second: a fish knocked into a fast spin span
   * up to the clamp and accelerated across the tank, creating energy from
   * nothing. Everything below that threshold damped perfectly, which is what
   * made it hard to see.
   */
  effectiveInertiaBody: [number, number, number];
  /** Body mass plus added mass, per axis — what the linear solver divides by. */
  effectiveMass: [number, number, number];
  /** Volume the fish must displace to be neutrally buoyant. */
  neutralVolume: number;
}

/**
 * Body depth at normalised position s.
 *
 * A superellipse rather than a plain ellipse: the 0.62 exponent makes the
 * profile fuller than a lens, which is what a real deep-bodied fish looks like.
 * The half-width `k` differs fore and aft, so the body peaks early (at s = 0.34)
 * and tapers over a longer run to a narrow peduncle — the betta silhouette.
 */
export function bodyDepth(s: number): number {
  const k = s < FISH.depthPeakAt ? 0.40 : 0.78;
  const t = (s - FISH.depthPeakAt) / k;
  const inner = 1 - t * t;
  if (inner <= 0) return FISH.maxDepth * 0.06;
  return Math.max(FISH.maxDepth * 0.06, FISH.maxDepth * Math.pow(inner, 0.62));
}

/**
 * Body width at normalised position s.
 *
 * Width tracks depth to the 0.85 power, so the cross-section becomes
 * progressively more laterally flattened towards the tail. A betta is a very
 * compressed fish; this is what gives its tail stalk the blade shape that makes
 * the cross-flow drag term behave the way it does.
 */
export function bodyWidth(s: number): number {
  return FISH.maxWidth * Math.pow(bodyDepth(s) / FISH.maxDepth, 0.85);
}

/**
 * Height of the median fin (dorsal above, anal below) at position s, if any.
 * Tapered at both ends: a fin does not start and stop abruptly.
 */
function medianFinHeight(s: number): number {
  let h = 0;
  const lobe = (fromS: number, toS: number, height: number): number => {
    if (s < fromS || s > toS) return 0;
    const t = (s - fromS) / (toS - fromS);
    // A rounded profile, fullest around the middle of the fin's run.
    return height * Math.pow(Math.sin(Math.PI * t), 0.55);
  };
  h += lobe(FINS.dorsal.fromS, FINS.dorsal.toS, FINS.dorsal.height);
  h += lobe(FINS.anal.fromS, FINS.anal.toS, FINS.anal.height);
  return h;
}

/**
 * Vertical span of the caudal fin at a distance `c` back from the peduncle.
 *
 * The fin's rays radiate, so its span opens out with distance from the root.
 */
function caudalSpan(c: number): number {
  const half = Math.asin(Math.min(0.98, FINS.caudal.span / (2 * FINS.caudal.chord)));
  return 2 * c * Math.sin(half);
}

export function buildMorphology(): Morphology {
  const n = FISH.segments;
  const L = FISH.standardLength;
  const ds = L / n;
  const segments: Segment[] = [];

  let volume = 0;
  let areaMoment = 0;
  let totalArea = 0;

  for (let i = 0; i < n; i++) {
    // Sample at the segment centre, not its edge — a midpoint rule, which is
    // second-order accurate and matters at only 24 segments.
    const s = (i + 0.5) / n;
    const depth = bodyDepth(s);
    const width = bodyWidth(s);
    const area = Math.PI * 0.25 * depth * width;

    volume += area * ds;
    areaMoment += area * (s * L);
    totalArea += area;

    // Perimeter of an ellipse, Ramanujan's second approximation. Accurate to
    // better than 1e-5 for these eccentricities, and much cheaper than the
    // elliptic integral it approximates.
    const a = depth * 0.5;
    const b = width * 0.5;
    const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
    const perimeter = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));

    const hydroDepth = depth + medianFinHeight(s);
    segments.push({
      s,
      arc: s * L,
      ds,
      depth,
      hydroDepth,
      isCaudal: false,
      width,
      area,
      mass: 0, // filled below, once the total volume is known
      addedMassPerLength: Math.PI * 0.25 * RHO_WATER * hydroDepth * hydroDepth,
      wettedArea: perimeter * ds,
      lateralArea: hydroDepth * ds,
    });
  }

  // --- The caudal fin, as a continuation of the body ---
  //
  // This is Lighthill's elongated-body picture taken at its word: the tail fin
  // is not a separate object to be bolted on with a coefficient, it is the last
  // and deepest part of the body, and it inherits the same travelling wave. The
  // amplitude envelope keeps growing past the peduncle, so the fin's trailing
  // edge sweeps nearly twice as far as its root does — which is where most of
  // the thrust comes from and why every attempt to bolt the fin on separately
  // ran into trouble.
  //
  // The alternative — simulating the fin as a sheet and feeding its forces back
  // into the fish — is what the code originally did. It is far harder than it
  // looks: the fin carries several times the fish's own mass in entrained water,
  // so the coupling is stiff, and every formulation tried (constraint
  // multipliers, momentum differencing, per-surface loads) either rang or
  // produced thrust from nothing. The fin sheet in fins.ts is still simulated,
  // and still moves because the water moves it — but it is there for shape, and
  // the propulsion is computed here, where the numerics are sound.
  const nCaudal = FISH.caudalSegments;
  const dsC = FINS.caudal.chord / nCaudal;
  const caudalTissue = FINS.caudal.chord * FINS.caudal.span * FINS.arealDensity;
  for (let i = 0; i < nCaudal; i++) {
    const c = (i + 0.5) * dsC; // distance back from the peduncle
    const span = caudalSpan(c);
    const arc = L + c;
    segments.push({
      s: arc / L,
      arc,
      ds: dsC,
      depth: span,
      hydroDepth: span,
      isCaudal: true,
      width: FINS.rayThickness * 2,
      area: span * FINS.rayThickness * 2,
      mass: caudalTissue / nCaudal,
      addedMassPerLength: Math.PI * 0.25 * RHO_WATER * span * span,
      // Both faces of a thin fin are wetted.
      wettedArea: 2 * span * dsC,
      lateralArea: span * dsC,
    });
  }

  // Distribute the body's mass by cross-sectional area so density is uniform.
  // That puts the centre of mass forward of the geometric centre, as in a real
  // fish. The caudal segments already carry their own (much smaller) fin-tissue
  // mass and are skipped.
  for (const seg of segments) {
    if (!seg.isCaudal) seg.mass = FISH.mass * (seg.area / totalArea);
  }

  const totalMass = segments.reduce((a, sg) => a + sg.mass, 0);
  let massMoment = 0;
  for (const sg of segments) massMoment += sg.mass * sg.arc;
  const comArc = massMoment / totalMass;
  let comSegment = 0;
  let best = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const d = Math.abs(segments[i].arc - comArc);
    if (d < best) {
      best = d;
      comSegment = i;
    }
  }

  // Inertia, treating each segment as a solid elliptical cylinder about its own
  // centre and applying the parallel axis theorem to the centre of mass.
  //
  // Body axes: x = left/right (roll is about the long axis, which is z here),
  // so we label them [roll, pitch, yaw] = [about body-forward, about body-right,
  // about body-up].
  let Iroll = 0;
  let Ipitch = 0;
  let Iyaw = 0;
  for (const seg of segments) {
    const a = seg.depth * 0.5; // semi-axis, vertical
    const b = seg.width * 0.5; // semi-axis, lateral
    const m = seg.mass;
    const r = seg.arc - comArc; // signed distance along the body from the CoM

    // Solid elliptical cylinder of length ds, semi-axis `a` vertical and `b`
    // lateral, long axis along the body:
    //   about the long axis (roll):        m/4  * (a^2 + b^2)
    //   about the lateral axis (pitch):    m/12 * (3*a^2 + ds^2)
    //   about the vertical axis (yaw):     m/12 * (3*b^2 + ds^2)
    //
    // Pitch uses the vertical semi-axis and yaw the lateral one, not the other
    // way round. Because a betta is much deeper than it is wide, that makes yaw
    // inertia the smaller of the two — which is why it turns left and right far
    // more readily than it pitches up and down, exactly as the real fish does.
    Iroll += 0.25 * m * (a * a + b * b);
    Ipitch += (m / 12) * (3 * a * a + seg.ds * seg.ds) + m * r * r;
    Iyaw += (m / 12) * (3 * b * b + seg.ds * seg.ds) + m * r * r;
  }

  // Added mass and added inertia, integrated over the real cross-sections.
  //
  // For a slice of an elongated body, the mass of water that moves with it is
  //   broadside (sideways):  (pi/4) * rho * depth^2   per unit length
  //   edgewise  (up/down):   (pi/4) * rho * width^2   per unit length
  // and the added moment of inertia about an axis is the same quantity weighted
  // by the square of the distance from that axis.
  //
  // Rolling about the long axis is different — a circular section rotating
  // about its own centre moves no water at all, so the added inertia comes
  // entirely from how far the section departs from circular:
  //   (pi/8) * rho * (a^2 - b^2)^2   per unit length.
  let maSway = 0;
  let maHeave = 0;
  let iaYaw = 0;
  let iaPitch = 0;
  let iaRoll = 0;
  for (const seg of segments) {
    // The depth the *water* sees, fins included. Rolling a long-finned betta
    // means swinging a dorsal and an anal fin broadside through the water, and
    // they resist that far more than the body does — computing the roll added
    // inertia from the bare flesh understates it by more than an order of
    // magnitude.
    //
    // That is not a cosmetic error. Roll inertia appears in the denominator of
    // the gyroscopic term in Euler's equations, and with it eighty times smaller
    // than the yaw inertia the explicit integrator went unstable: any
    // simultaneous yaw and pitch drove the roll rate up until it hit the clamp.
    const a = seg.hydroDepth * 0.5;
    const b = seg.width * 0.5;
    const r = seg.arc - comArc;
    const perLenSway = (Math.PI / 4) * RHO_WATER * seg.hydroDepth * seg.hydroDepth;
    const perLenHeave = (Math.PI / 4) * RHO_WATER * seg.width * seg.width;
    maSway += perLenSway * seg.ds;
    maHeave += perLenHeave * seg.ds;
    // Yaw swings the body sideways, so it pays the broadside added mass;
    // pitch swings it up and down, so it pays the much smaller edgewise one.
    iaYaw += perLenSway * seg.ds * r * r;
    iaPitch += perLenHeave * seg.ds * r * r;
    const e = a * a - b * b;
    iaRoll += (Math.PI / 8) * RHO_WATER * e * e * seg.ds;
  }

  // Along the body, added mass is a small fraction of the displaced water: a
  // slender shape accelerating nose-first barely disturbs anything. k1 = 0.15
  // is the standard Lamb coefficient for a body of this fineness ratio.
  const maSurge = FISH.addedMassSurgeCoefficient * RHO_WATER * volume;

  const neutralVolume = totalMass / RHO_WATER;

  return {
    segments,
    standardLength: L,
    totalMass,
    volume,
    comArc,
    totalArc: segments[segments.length - 1].arc + segments[segments.length - 1].ds * 0.5,
    comSegment,
    inertia: [Iroll, Ipitch, Iyaw],
    addedMass: [maSurge, maSway, maHeave],
    addedInertia: [iaRoll, iaPitch, iaYaw],
    effectiveInertia: [Iroll + iaRoll, Ipitch + iaPitch, Iyaw + iaYaw],
    // [about body x (pitch), about body y (yaw), about body z (roll)]
    effectiveInertiaBody: [Ipitch + iaPitch, Iyaw + iaYaw, Iroll + iaRoll],
    effectiveMass: [totalMass + maSurge, totalMass + maSway, totalMass + maHeave],
    neutralVolume,
  };
}

/**
 * Where the trailing edge of the caudal fin sits, in body lengths from the snout.
 * Just over 1.5 for this fish: the tail fin is half the body length again.
 */
export const TIP_S =
  (FISH.standardLength + FINS.caudal.chord) / FISH.standardLength;

/**
 * The amplitude envelope of the body wave, normalised to 1.0 at the trailing
 * edge of the caudal fin.
 *
 * The raw shape is a0 + a1*s + a2*s^2 with (0.08, -0.30, 1.22): small but
 * non-zero at the snout (real fish do yaw their heads a little), a minimum of
 * 0.062 at s = 0.123, then quadratic growth backwards. That dip in the front
 * quarter is a measured feature of subcarangiform swimmers, not a stylistic
 * choice — it is where the body is stiffest.
 *
 * The normalisation point matters and is easy to get wrong. The measured figure
 * this is anchored to — tail-beat amplitude of about 20% of body length,
 * peak-to-peak — refers to the tip of the *fin*, which is the part anyone can
 * see moving. Normalising at the peduncle instead, where the flesh ends, makes
 * the fin's trailing edge sweep nearly two and a half times as far as it should,
 * and every speed and efficiency figure that follows is quietly wrong by that
 * factor. Anchoring here means the commanded amplitude means what the literature
 * means by it, and the peduncle correctly moves only about 40% as far as the fin
 * tip does.
 */
export function amplitudeEnvelope(s: number): number {
  const { a0, a1, a2 } = FISH.ampEnvelope;
  const raw = a0 + a1 * s + a2 * s * s;
  const atTip = a0 + a1 * TIP_S + a2 * TIP_S * TIP_S;
  return raw / atTip;
}

/**
 * The shape of the one-sided bend used for turning.
 *
 * This follows the *amplitude envelope*, not an independent curve, because a
 * fish does not turn by holding a static bend — it turns by beating its tail
 * asymmetrically, sweeping further to one side than the other. The offset is
 * therefore applied to the travelling wave itself and scaled by how far that
 * part of the body is already moving.
 *
 * Modelling it as a separate static camber, as the first version did, gets both
 * the mechanism and the magnitude wrong. To generate a useful turning moment
 * from a static shape the body has to be bent a very long way — full deflection
 * swung the caudal fin's tip nearly forty millimetres off the centreline, which
 * is an escape posture — and because the reactive force follows the *rate* of
 * deformation, every time the steering controller reversed, the fish was thrown
 * across the tank. Riding on the wave instead, the same turning authority needs
 * a peak offset of under four millimetres.
 */
export function bendShape(s: number): number {
  // Two parts, because a turning fish does two things at once: it beats its tail
  // asymmetrically (which rides the wave, so it scales with the beat amplitude)
  // and it cambers its whole body into the turn (which does not).
  return amplitudeEnvelope(s) * FISH.bendScale + FISH.bendCamber * Math.pow(s, 1.6);
}
