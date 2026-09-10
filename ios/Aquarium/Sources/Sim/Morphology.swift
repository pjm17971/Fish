import Foundation

/// The fish's shape: how deep, how wide and how heavy it is at every point along
/// its body, plus the derived quantities the physics needs.
///
/// This is computed once at start-up from profile functions rather than loaded
/// from a modelling package, so the physics and the rendered mesh are guaranteed
/// to be the same animal. A mesh authored in a DCC tool drifting apart from a
/// hand-tuned collision shape is the usual reason a simulated creature ends up
/// feeling wrong in a way nobody can point at.

struct Segment {
    /// Normalised arc position, 0 at the snout, 1 at the caudal peduncle.
    var s: Double
    /// Distance from the snout along the centreline.
    var arc: Double
    /// Arc length this segment is responsible for.
    var ds: Double
    /// Body depth here, flesh only.
    var depth: Double
    /// Depth including whatever median fin is attached here.
    ///
    /// This is the depth the *water* sees, and what added mass and cross-flow
    /// drag are computed from. A dorsal fin adds no mass worth speaking of but
    /// a great deal of surface for the water to push on; treating the fish as a
    /// bare body with fins bolted on separately is the harder and less accurate
    /// way round.
    var hydroDepth: Double
    /// Body width (left to right) here.
    var width: Double
    /// Elliptical cross-sectional area.
    var area: Double
    /// Mass of this slice.
    var mass: Double
    /// Added mass per unit length for broadside motion: (pi/4) * rho * depth^2.
    var addedMassPerLength: Double
    /// Wetted surface area, for skin friction.
    var wettedArea: Double
    /// Lateral (broadside) projected area, for cross-flow drag.
    var lateralArea: Double
    /// True for the segments that make up the caudal fin rather than the body.
    var isCaudal: Bool
}

struct Morphology {
    var segments: [Segment] = []
    var standardLength: Double = Fish.standardLength
    var totalMass: Double = 0
    var volume: Double = 0
    /// Distance of the centre of mass from the snout, along the body.
    var comArc: Double = 0
    /// Total arc length of the chain, body plus caudal fin.
    var totalArc: Double = 0
    /// Principal moments of inertia about the centre of mass: [roll, pitch, yaw].
    var inertia: SIMD3<Double> = .zero
    /// Added mass along [surge, sway, heave], in kilograms.
    ///
    /// Integrated from the real cross-sections rather than guessed as multiples
    /// of body mass, and the answer is startling: sideways added mass comes out
    /// several times the fish's own, because a laterally compressed body moving
    /// broadside drags an enormous slug of water. Guessing "about the same as
    /// body mass" — the usual shortcut — understates it badly and makes the fish
    /// slide sideways in a way that reads as weightless.
    var addedMass: SIMD3<Double> = .zero
    /// Added moment of inertia, [roll, pitch, yaw].
    var addedInertia: SIMD3<Double> = .zero
    /// Body mass plus added mass, per axis — what the linear solver divides by.
    var effectiveMass: SIMD3<Double> = .zero
    /// Body inertia plus added inertia, in **body-axis order**: [x, y, z].
    ///
    /// Body-axis order, not [roll, pitch, yaw] order. These are different
    /// permutations and confusing them is silent: body x is the fish's right, so
    /// rotation about it is *pitch*; body y is up, so that is *yaw*; body z is
    /// forward, so that is *roll*. Reading a [roll, pitch, yaw] array as
    /// [x, y, z] gives the fish its roll inertia about its pitch axis, and with
    /// the fins making yaw inertia far larger than roll, the gyroscopic term in
    /// Euler's equations then goes unstable — a fish knocked into a fast spin
    /// spins up without limit and creates energy from nothing.
    var effectiveInertiaBody: SIMD3<Double> = .zero
    /// Volume the fish must displace to be neutrally buoyant.
    var neutralVolume: Double = 0
}

/// Body depth at normalised position s.
///
/// A superellipse rather than a plain ellipse: the 0.62 exponent makes the
/// profile fuller than a lens, which is what a deep-bodied fish looks like. The
/// half-width differs fore and aft, so the body peaks early and tapers over a
/// longer run to a narrow peduncle — the betta silhouette.
func bodyDepth(_ s: Double) -> Double {
    let k = s < Fish.depthPeakAt ? 0.40 : 0.78
    let t = (s - Fish.depthPeakAt) / k
    let inner = 1 - t * t
    if inner <= 0 { return Fish.maxDepth * 0.06 }
    return max(Fish.maxDepth * 0.06, Fish.maxDepth * pow(inner, 0.62))
}

/// Body width at normalised position s.
///
/// Width tracks depth to the 0.85 power, so the cross-section becomes
/// progressively more laterally flattened towards the tail.
func bodyWidth(_ s: Double) -> Double {
    Fish.maxWidth * pow(bodyDepth(s) / Fish.maxDepth, 0.85)
}

/// Height of the median fin (dorsal above, anal below) at position s, if any.
private func medianFinHeight(_ s: Double) -> Double {
    func lobe(_ fromS: Double, _ toS: Double, _ height: Double) -> Double {
        if s < fromS || s > toS { return 0 }
        let t = (s - fromS) / (toS - fromS)
        // A rounded profile, fullest around the middle of the fin's run.
        return height * pow(sin(.pi * t), 0.55)
    }
    return lobe(Fins.dorsal.fromS, Fins.dorsal.toS, Fins.dorsal.extent)
        + lobe(Fins.anal.fromS, Fins.anal.toS, Fins.anal.extent)
}

/// Vertical span of the caudal fin a distance `c` back from the peduncle.
func caudalSpan(_ c: Double) -> Double {
    let half = asin(min(0.98, Fins.caudal.span / (2 * Fins.caudal.extent)))
    return 2 * c * sin(half)
}

/// Where the trailing edge of the caudal fin sits, in body lengths from the snout.
let TIP_S: Double = (Fish.standardLength + Fins.caudal.extent) / Fish.standardLength

/// The amplitude envelope of the body wave, normalised to 1.0 at the trailing
/// edge of the caudal fin.
///
/// The raw shape is small but non-zero at the snout (real fish do yaw their heads
/// a little), dips to a minimum around s = 0.12 — a measured feature of
/// subcarangiform swimmers, where the body is stiffest — then grows quadratically
/// backwards.
///
/// The normalisation point matters and is easy to get wrong. The measured figure
/// this is anchored to, a tail-beat amplitude of about 20% of body length
/// peak-to-peak, refers to the tip of the *fin*. Normalising at the peduncle,
/// where the flesh ends, makes the fin's trailing edge sweep nearly two and a
/// half times as far as it should, and every speed and efficiency figure that
/// follows is quietly wrong by that factor.
func amplitudeEnvelope(_ s: Double) -> Double {
    let raw = Fish.ampA0 + Fish.ampA1 * s + Fish.ampA2 * s * s
    let atTip = Fish.ampA0 + Fish.ampA1 * TIP_S + Fish.ampA2 * TIP_S * TIP_S
    return raw / atTip
}

/// The shape of the one-sided bend used for turning.
///
/// Two parts, because a turning fish does two things at once: it beats its tail
/// asymmetrically — which rides the wave, so it scales with the beat amplitude —
/// and it cambers its whole body into the turn, which does not.
///
/// Modelling it as a single large static camber gets the mechanism wrong and the
/// magnitude badly wrong. To get a useful turning moment from a static shape
/// alone the body has to bend a very long way, and because the reactive force
/// follows the *rate* of deformation, every reversal of the steering controller
/// then throws the fish across the tank.
func bendShape(_ s: Double) -> Double {
    // The camber of the whole body into a turn; the asymmetric beat rides the
    // wave and is handled in the body shape itself.
    Fish.bendCamber * pow(s, 1.6)
}

func buildMorphology() -> Morphology {
    var m = Morphology()
    let n = Fish.segments
    let L = Fish.standardLength
    let ds = L / Double(n)

    var volume: Double = 0
    var areaMoment: Double = 0
    var totalArea: Double = 0

    for i in 0..<n {
        // Sample at the segment centre, not its edge — a midpoint rule, which is
        // second-order accurate and matters at only 24 segments.
        let s = (Double(i) + 0.5) / Double(n)
        let depth = bodyDepth(s)
        let width = bodyWidth(s)
        let area = Double.pi * 0.25 * depth * width

        volume += area * ds
        areaMoment += area * (s * L)
        totalArea += area

        // Perimeter of an ellipse, Ramanujan's second approximation: accurate to
        // better than 1e-5 here and far cheaper than the elliptic integral.
        let a = depth * 0.5
        let b = width * 0.5
        let h = ((a - b) * (a - b)) / ((a + b) * (a + b))
        let perimeter = Double.pi * (a + b) * (1 + (3 * h) / (10 + (4 - 3 * h).squareRoot()))

        let hydroDepth = depth + medianFinHeight(s)
        m.segments.append(Segment(
            s: s,
            arc: s * L,
            ds: ds,
            depth: depth,
            hydroDepth: hydroDepth,
            width: width,
            area: area,
            mass: 0,
            addedMassPerLength: Double.pi * 0.25 * RHO_WATER * hydroDepth * hydroDepth,
            wettedArea: perimeter * ds,
            lateralArea: hydroDepth * ds,
            isCaudal: false
        ))
    }

    // The caudal fin, as a continuation of the body.
    //
    // Lighthill's elongated-body picture taken at its word: the tail fin is not
    // a separate object to be bolted on with a coefficient, it is the last and
    // deepest part of the body, and it inherits the same travelling wave.
    let nCaudal = Fish.caudalSegments
    let dsC = Fins.caudal.extent / Double(nCaudal)
    let caudalTissue = Fins.caudal.extent * Fins.caudal.span * Fins.arealDensity
    for i in 0..<nCaudal {
        let c = (Double(i) + 0.5) * dsC   // distance back from the peduncle
        let span = caudalSpan(c)
        let arc = L + c
        m.segments.append(Segment(
            s: arc / L,
            arc: arc,
            ds: dsC,
            depth: span,
            hydroDepth: span,
            width: Fins.rayThickness * 2,
            area: span * Fins.rayThickness * 2,
            mass: caudalTissue / Double(nCaudal),
            addedMassPerLength: Double.pi * 0.25 * RHO_WATER * span * span,
            // Both faces of a thin fin are wetted.
            wettedArea: 2 * span * dsC,
            lateralArea: span * dsC,
            isCaudal: true
        ))
    }

    // Distribute the body's mass by cross-sectional area so density is uniform,
    // which puts the centre of mass forward of the geometric centre as in a real
    // fish. The caudal segments already carry their own fin-tissue mass.
    for i in 0..<m.segments.count where !m.segments[i].isCaudal {
        m.segments[i].mass = Fish.mass * (m.segments[i].area / totalArea)
    }

    let totalMass = m.segments.reduce(0.0) { $0 + $1.mass }
    var massMoment: Double = 0
    for sg in m.segments { massMoment += sg.mass * sg.arc }
    let comArc = massMoment / totalMass
    _ = areaMoment

    // Inertia, treating each segment as a solid elliptical cylinder about its own
    // centre and applying the parallel axis theorem to the centre of mass.
    var iRoll: Double = 0
    var iPitch: Double = 0
    var iYaw: Double = 0
    for sg in m.segments {
        let a = sg.depth * 0.5   // semi-axis, vertical
        let b = sg.width * 0.5   // semi-axis, lateral
        let mass = sg.mass
        let r = sg.arc - comArc

        // Pitch uses the vertical semi-axis and yaw the lateral one, not the
        // other way round. Because a betta is much deeper than it is wide, that
        // makes yaw inertia the smaller of the two — which is why it turns left
        // and right far more readily than it pitches up and down.
        iRoll += 0.25 * mass * (a * a + b * b)
        iPitch += (mass / 12) * (3 * a * a + sg.ds * sg.ds) + mass * r * r
        iYaw += (mass / 12) * (3 * b * b + sg.ds * sg.ds) + mass * r * r
    }

    // Added mass and added inertia, integrated over the real cross-sections.
    //
    // For a slice of an elongated body the water that moves with it is
    //   broadside: (pi/4) * rho * depth^2   per unit length
    //   edgewise:  (pi/4) * rho * width^2   per unit length
    // and the added moment of inertia is the same quantity weighted by the square
    // of the distance from the axis.
    //
    // Rolling about the long axis is different: a circular section rotating about
    // its own centre moves no water at all, so the added inertia comes entirely
    // from how far the section departs from circular.
    var maSway: Double = 0
    var maHeave: Double = 0
    var iaYaw: Double = 0
    var iaPitch: Double = 0
    var iaRoll: Double = 0
    for sg in m.segments {
        // The depth the water sees, fins included. Rolling a long-finned betta
        // means swinging a dorsal and an anal fin broadside through the water,
        // and they resist that far more than the bare body does — computing roll
        // added inertia from the flesh alone understates it by more than an order
        // of magnitude, and roll inertia is in the denominator of the gyroscopic
        // term.
        let a = sg.hydroDepth * 0.5
        let b = sg.width * 0.5
        let r = sg.arc - comArc
        let perLenSway = (Double.pi / 4) * RHO_WATER * sg.hydroDepth * sg.hydroDepth
        let perLenHeave = (Double.pi / 4) * RHO_WATER * sg.width * sg.width
        maSway += perLenSway * sg.ds
        maHeave += perLenHeave * sg.ds
        // Yaw swings the body sideways and pays the broadside added mass; pitch
        // swings it up and down and pays the much smaller edgewise one.
        iaYaw += perLenSway * sg.ds * r * r
        iaPitch += perLenHeave * sg.ds * r * r
        let e = a * a - b * b
        iaRoll += (Double.pi / 8) * RHO_WATER * e * e * sg.ds
    }

    // Along the body, added mass is a small fraction of the displaced water: a
    // slender shape accelerating nose-first barely disturbs anything.
    let maSurge = Fish.addedMassSurgeCoefficient * RHO_WATER * volume

    m.totalMass = totalMass
    m.volume = volume
    m.comArc = comArc
    if let last = m.segments.last {
        m.totalArc = last.arc + last.ds * 0.5
    }
    m.inertia = SIMD3<Double>(iRoll, iPitch, iYaw)
    m.addedMass = SIMD3<Double>(maSurge, maSway, maHeave)
    m.addedInertia = SIMD3<Double>(iaRoll, iaPitch, iaYaw)
    m.effectiveMass = SIMD3<Double>(totalMass + maSurge, totalMass + maSway, totalMass + maHeave)
    // [about body x (pitch), about body y (yaw), about body z (roll)]
    m.effectiveInertiaBody = SIMD3<Double>(iPitch + iaPitch, iYaw + iaYaw, iRoll + iaRoll)
    m.neutralVolume = totalMass / RHO_WATER
    return m
}
