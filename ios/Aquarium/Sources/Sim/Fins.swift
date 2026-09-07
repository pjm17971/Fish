import Foundation
import simd

/// Fins, simulated as flexible sheets rather than animated.
///
/// A betta's fins are enormous, thin, and slow to follow the body. Rigging them
/// to a skeleton and keying a delay gets you something that looks approximately
/// right from one angle and obviously wrong from any other, because the shape a
/// real fin takes is set by the water pushing on it, and that changes with every
/// turn, stop and flare. So they are simulated.
///
/// ## Structure
///
/// Each fin is a set of **rays** — in a real fin, jointed bony spines — spread
/// from an attachment on the body, with a soft **membrane** webbed between
/// neighbouring rays. Every ray is a chain of nodes at fixed spacing.
///
/// The body drives the first *two* nodes of every ray, not just one. That detail
/// decides whether the fin works at all: pinned at a single point a fin can pivot
/// freely, so it weathervanes into the flow, meets the water edge-on and produces
/// pure drag. A real fin base is embedded in the body with its own bending
/// stiffness, and muscles at the base set its angle.
///
/// ## Why this is a chain sweep and not a constraint solver
///
/// The natural choice is a mass-spring or XPBD cloth. It does not survive contact
/// with this problem. The fin's tissue mass is a tenth of a gram while the water
/// it carries is several grams; the rays need to be near-inextensible; and the
/// root is teleported every substep by a body beating up to nine times a second.
/// A stiff positional solver under those conditions injects energy through its
/// own projections faster than any plausible damping removes it — with the tail
/// held perfectly still, the fin rang at a metre per second indefinitely and drove
/// the fish across the tank. That is not a tuning problem.
///
/// So the length constraint is enforced **by construction** instead of by
/// iteration. Nodes are integrated outward from the root, one at a time, and each
/// is projected onto the sphere of the right radius about its parent — which has
/// already reached its final position. Lengths are then exact, there is no
/// iteration to diverge, and stability does not depend on stiffness, timestep or
/// mass ratio.
///
/// ## What the body feels
///
/// Nothing, directly. The fins' effect on the fish's motion is computed in the
/// body's own hydrodynamic chain, where each segment's depth already includes
/// whatever fin is attached there and the caudal fin is carried as a continuation
/// of the body (see `Morphology`). That is Lighthill's elongated-body picture, it
/// is numerically sound, and doing it here as well would count the same water
/// twice.
///
/// This sheet exists so the fin has a *shape* — so it trails, lags, ripples and
/// furls because the water is moving it, rather than because a curve was keyed to
/// make it look as though it did.

/// Where one ray root is pinned on the body.
struct FinAttachment {
    var segment: Int
    /// Offset in that segment's local frame: along the lateral normal, and along up.
    var offNormal: Double
    var offUp: Double
}

struct FinSpec {
    var name: String
    var rays: Int
    /// Nodes along each ray, including the two the body drives.
    var along: Int
    /// How far the fin extends from the body, metres.
    var extent: Double
    /// Width across the rays. For a fanning fin this is the arc its trailing edge
    /// sweeps, not the width of its root.
    var span: Double
    /// Half-angle the rays fan through, radians.
    ///
    /// A betta's caudal fin attaches to a stalk barely a millimetre deep and opens
    /// out to three centimetres across. That only happens because the rays radiate.
    var fanHalfAngle: Double
    var attachments: [FinAttachment]
    /// Direction the fin extends, in a body segment's own frame, as
    /// (along normal, along up, along tangent). The tangent points tailward.
    var outward: Vec3
    /// Direction the fan opens towards, same frame; perpendicular to `outward`.
    var fanDir: Vec3
    /// How far the fin trails backwards.
    var rake: Double
    /// How much this fin responds to the fish clamping or flaring, 0 to 1.
    var spreadResponse: Double
}

final class FinCloth {
    let spec: FinSpec
    let count: Int
    /// Spacing between nodes along a ray.
    let nodeSpacing: Double

    /// World-space node positions and velocities.
    private(set) var pos: [Vec3]
    private(set) var vel: [Vec3]
    private var prevPos: [Vec3]
    private var smoothed: [Vec3]

    /// True for nodes the body drives; they take no forces of their own.
    private(set) var driven: [Bool]
    private(set) var massTissue: [Double]
    /// Mass of water carried, for motion normal to the sheet only.
    private(set) var massAdded: [Double]
    private(set) var area: [Double]
    /// Membrane thickness at each node — thicker on a ray. The shader reads this.
    private(set) var thickness: [Float]
    /// Sheet normal at each node, kept continuous between frames.
    private(set) var normals: [Vec3]

    /// Velocity damping rate, a fraction of critical for this fin's bending mode.
    private let dampingRate: Double
    private var normalsInitialised = false

    /// Nodes per ray that the body drives directly.
    private static let DRIVEN = 2

    init(spec: FinSpec) {
        self.spec = spec
        self.count = spec.rays * spec.along
        self.nodeSpacing = spec.extent / Double(max(1, spec.along - 1))

        let n = count
        self.pos = [Vec3](repeating: .zero, count: n)
        self.vel = [Vec3](repeating: .zero, count: n)
        self.prevPos = [Vec3](repeating: .zero, count: n)
        self.smoothed = [Vec3](repeating: .zero, count: n)
        self.driven = [Bool](repeating: false, count: n)
        self.massTissue = [Double](repeating: 0, count: n)
        self.massAdded = [Double](repeating: 0, count: n)
        self.area = [Double](repeating: 0, count: n)
        self.thickness = [Float](repeating: 0, count: n)
        self.normals = [Vec3](repeating: .zero, count: n)

        let totalArea = spec.extent * spec.span
        let areaPer = totalArea / Double(n)
        // Added mass.
        //
        // The obvious figure is strip theory for a rigid plate — rho*pi*c^2/4 per
        // unit span, several times the fish's own mass — shared evenly between the
        // nodes. Both halves of that are wrong for a *flexible* fin: the rigid
        // figure only applies if the whole plate accelerates as one, and added
        // mass grows as the cube of size rather than the square, so splitting a
        // whole-plate figure between a hundred nodes gives each about fourteen
        // times what a patch that size really carries. The fin then cannot follow
        // the body at all and folds to a fifth of its length.
        //
        // The right quantity for a sheet carrying a deformation of wavelength
        // lambda is the potential-flow result rho*lambda/(2*pi) per unit area, and
        // a fin bending over its own length carries lambda of about twice its
        // extent.
        let addedPerArea = (RHO_WATER * spec.extent) / Double.pi
        let tissuePer = (totalArea * Fins.arealDensity) / Double(n)
        let addedPer = addedPerArea * areaPer

        for r in 0..<spec.rays {
            for j in 0..<spec.along {
                let i = r * spec.along + j
                driven[i] = j < FinCloth.DRIVEN
                area[i] = areaPer
                massTissue[i] = tissuePer
                massAdded[i] = addedPer
                let t = Double(j) / Double(max(1, spec.along - 1))
                thickness[i] = Float(Fins.rayThickness * (1 - t) + Fins.membraneThickness * t)
            }
        }

        // Critical damping for a mass on a spring is 2*sqrt(k*m); as a rate on the
        // velocity that is 2*zeta*sqrt(k/m).
        let nodeMass = tissuePer + addedPer
        self.dampingRate = 2 * Fins.dampingRatio * (Fins.rayStiffness / nodeMass).squareRoot()
    }

    @inline(__always) private func index(_ r: Int, _ j: Int) -> Int { r * spec.along + j }

    /// World position and velocity of a point attached to the body.
    private func attachmentWorld(_ body: FishBody, _ loco: FishLocomotion, _ att: FinAttachment)
        -> (pos: Vec3, vel: Vec3)
    {
        let st = body.segments[min(att.segment, body.segments.count - 1)]
        let local = st.pos + st.normal * att.offNormal + st.up * att.offUp
        let r = rotate(loco.orientation, local)
        let p = loco.position + r
        let v = loco.velocity + simd_cross(loco.angularVelocity, r)
            + rotate(loco.orientation, st.velLocal)
        return (p, v)
    }

    /// Direction ray `r` leaves the body in, in world space.
    private func outwardWorld(_ body: FishBody, _ loco: FishLocomotion, _ r: Int, _ spread: Double) -> Vec3 {
        let att = spec.attachments[min(r, spec.attachments.count - 1)]
        let st = body.segments[min(att.segment, body.segments.count - 1)]

        // Fan the ray about the fin's axis. Spread scales the fan, so a clamped
        // fin really does close towards a line and a flared one opens fully — the
        // actual mechanism, rather than a scale on a fixed shape.
        let t = (Double(r) / Double(max(1, spec.rays - 1))) * 2 - 1
        let openness = 1 - spec.spreadResponse * (1 - spread)
        let ang = t * spec.fanHalfAngle * openness
        let ca = cos(ang)
        let sa = sin(ang)

        let fN = spec.outward.x * ca + spec.fanDir.x * sa
        let fU = spec.outward.y * ca + spec.fanDir.y * sa
        let fT = spec.outward.z * ca + spec.fanDir.z * sa + spec.rake

        // Compose in the segment's own frame, so a fin on a bending body follows
        // the bend rather than sticking out of a straight-line idea of it.
        let dir = st.normal * fN + st.up * fU + st.tangent * fT
        return rotate(loco.orientation, normalizeSafe(dir))
    }

    /// Lay the fin out straight along its rest direction.
    func initialise(body: FishBody, loco: FishLocomotion, spread: Double) {
        for r in 0..<spec.rays {
            let att = spec.attachments[min(r, spec.attachments.count - 1)]
            let (p0, _) = attachmentWorld(body, loco, att)
            let out = outwardWorld(body, loco, r, spread)
            for j in 0..<spec.along {
                pos[index(r, j)] = p0 + out * (nodeSpacing * Double(j))
            }
        }
        prevPos = pos
        for i in 0..<count { vel[i] = .zero }
        normalsInitialised = false
        rebuildNormals()
        normalsInitialised = true
    }

    /// Advance the fin.
    func step(body: FishBody, loco: FishLocomotion, flow: BulkFlow?, spread: Double, dt: Double) {
        let sub = dt / Double(Fins.substeps)
        for _ in 0..<Fins.substeps {
            driveBase(body, loco, spread)
            sweepRays(flow, sub)
            smoothAcrossRays()
            rebuildNormals()
        }
    }

    /// Place the two nodes of each ray that the body owns.
    private func driveBase(_ body: FishBody, _ loco: FishLocomotion, _ spread: Double) {
        for r in 0..<spec.rays {
            let att = spec.attachments[min(r, spec.attachments.count - 1)]
            let (p0, v0) = attachmentWorld(body, loco, att)
            let out = outwardWorld(body, loco, r, spread)
            for j in 0..<FinCloth.DRIVEN {
                let i = index(r, j)
                pos[i] = p0 + out * (nodeSpacing * Double(j))
                // The extra term from the base direction rotating is left out: it
                // is small next to the attachment's own motion.
                vel[i] = v0
            }
        }
    }

    /// Integrate each ray outward from its base.
    ///
    /// Working strictly root to tip is what makes this stable: by the time a node
    /// is handled its parent is already in its final position for this substep, so
    /// clamping the node to the right distance from that parent is one exact
    /// operation rather than something a solver has to converge on.
    private func sweepRays(_ flow: BulkFlow?, _ dt: Double) {
        let L = nodeSpacing
        let damp = exp(-dampingRate * dt)
        let invDt = 1 / dt

        for r in 0..<spec.rays {
            for j in FinCloth.DRIVEN..<spec.along {
                let i = index(r, j)
                let parent = index(r, j - 1)
                let grand = index(r, j - 2)
                prevPos[i] = pos[i]

                // --- Water drag, normal to the sheet ---
                var rel = vel[i]
                if let flow = flow { rel -= flow.sample(pos[i]) }
                let n = normals[i]
                let vn = simd_dot(rel, n)
                let fDrag = -0.5 * RHO_WATER * Fish.crossFlowCd * area[i] * abs(vn) * vn
                var force = n * fDrag

                // --- Bending: the ray wants to carry straight on from its parent ---
                let dirParent = normalizeSafe(pos[parent] - pos[grand])
                // Rays taper, so they get floppier towards the tip, as real ones do.
                let stiffness = Fins.rayStiffness * pow(1 - Double(j - 1) / Double(spec.along), 1.5)
                force += (pos[parent] + dirParent * L - pos[i]) * stiffness

                // Normal-direction mass: the sheet carries water only when it
                // sweeps broadside. Along the sheet it is nearly massless, but
                // that direction is governed by the length projection below
                // anyway, so using the normal mass throughout is both simpler and
                // better conditioned.
                let invM = 1 / (massTissue[i] + massAdded[i])
                vel[i] = (vel[i] + force * (invM * dt)) * damp
                pos[i] += vel[i] * dt

                // --- Inextensibility, enforced exactly ---
                var d = pos[i] - pos[parent]
                var len = lengthSafe(d)
                if len < 1e-9 {
                    d = dirParent
                    len = 1
                }
                pos[i] = pos[parent] + d * (L / len)

                // Velocity from what actually happened, so the projection cannot
                // leave energy behind in a velocity the position never took.
                vel[i] = (pos[i] - prevPos[i]) * invDt
            }
        }
    }

    /// The membrane: pull each node a little towards the average of its neighbours
    /// on the adjacent rays, then re-fix the ray lengths.
    ///
    /// Doing the webbing as smoothing rather than as constraints keeps it
    /// unconditionally dissipative — it can only move a node towards where its
    /// neighbours already are, never past them.
    private func smoothAcrossRays() {
        guard spec.rays >= 2 else { return }
        let w = Fins.membraneCoupling
        smoothed = pos

        for r in 0..<spec.rays {
            for j in FinCloth.DRIVEN..<spec.along {
                let i = index(r, j)
                let a = index(max(0, r - 1), j)
                let b = index(min(spec.rays - 1, r + 1), j)
                // The webbing is taut near the body and loose at the trailing
                // edge, which gives a betta's tail its rippling outer margin.
                let t = Double(j) / Double(spec.along - 1)
                let wj = w * (1 - 0.6 * t)
                let avg = (pos[a] + pos[b]) * 0.5
                smoothed[i] = pos[i] + (avg - pos[i]) * wj
            }
        }
        pos = smoothed

        // Smoothing moves nodes off their parents' spheres, so re-fix the lengths
        // — still outward, so each parent is settled before its child is touched.
        let L = nodeSpacing
        for r in 0..<spec.rays {
            for j in FinCloth.DRIVEN..<spec.along {
                let i = index(r, j)
                let p = index(r, j - 1)
                let d = pos[i] - pos[p]
                let len = lengthSafe(d)
                if len < 1e-9 { continue }
                pos[i] = pos[p] + d * (L / len)
            }
        }
    }

    /// Sheet normals, kept pointing the same way they did last frame.
    ///
    /// A cross product of two grid directions takes whichever sign the geometry
    /// happens to give it, and on a rippling sheet that sign flips. Drag does not
    /// care — it is quadratic, so flipping the normal flips the velocity with it.
    /// Anything that differentiates the normal velocity in time very much does: a
    /// flip from one frame to the next reads as the water reversing instantly.
    private func rebuildNormals() {
        for r in 0..<spec.rays {
            for j in 0..<spec.along {
                let i = index(r, j)
                let rN = index(min(spec.rays - 1, r + 1), j)
                let rP = index(max(0, r - 1), j)
                let jN = index(r, min(spec.along - 1, j + 1))
                let jP = index(r, max(0, j - 1))

                var n = simd_cross(pos[rN] - pos[rP], pos[jN] - pos[jP])
                if lengthSafe(n) < 1e-14 { continue }
                n = normalizeSafe(n)

                if normalsInitialised && simd_dot(n, normals[i]) < 0 { n = -n }
                normals[i] = n
            }
        }
    }
}

/// Build the fin set for a male veiltail betta.
///
/// The proportions are the distinguishing thing about the animal — the caudal fin
/// alone is about a third of its total length, and the anal fin runs nearly the
/// whole underside. Get these wrong and it reads as a generic fish.
func buildFins(morphology: Morphology) -> [FinCloth] {
    let segs = morphology.segments
    let n = segs.count
    let L = morphology.standardLength

    func segAt(_ s: Double) -> Int {
        max(0, min(n - 1, Int((s * Double(n) - 0.5).rounded())))
    }

    var fins: [FinCloth] = []

    // --- Caudal: rays radiate from the peduncle and fan vertically ---
    do {
        let spec = Fins.caudal
        var attachments: [FinAttachment] = []
        for r in 0..<spec.rows {
            let t = Double(r) / Double(spec.rows - 1)
            attachments.append(FinAttachment(
                segment: n - 1, offNormal: 0,
                offUp: (t - 0.5) * segs[n - 1].depth * 1.2
            ))
        }
        // Half-angle set so the trailing edge sweeps the intended span:
        // span = 2 * chord * sin(halfAngle).
        let half = asin(min(0.98, spec.span / (2 * spec.extent)))
        fins.append(FinCloth(spec: FinSpec(
            name: "caudal", rays: spec.rows, along: spec.cols,
            extent: spec.extent, span: spec.span, fanHalfAngle: half,
            attachments: attachments,
            outward: v3(0, 0, 1),   // along the body tangent, which points tailward
            fanDir: v3(0, 1, 0),    // fans up and down
            rake: 0.0, spreadResponse: 0.75
        )))
    }

    // --- Dorsal: along the back ---
    do {
        let spec = Fins.dorsal
        var attachments: [FinAttachment] = []
        for r in 0..<spec.rows {
            let t = Double(r) / Double(spec.rows - 1)
            let idx = segAt(spec.fromS + (spec.toS - spec.fromS) * t)
            attachments.append(FinAttachment(segment: idx, offNormal: 0, offUp: segs[idx].depth * 0.5))
        }
        fins.append(FinCloth(spec: FinSpec(
            name: "dorsal", rays: spec.rows, along: spec.cols,
            extent: spec.extent, span: (spec.toS - spec.fromS) * L, fanHalfAngle: 0.22,
            attachments: attachments,
            outward: v3(0, 1, 0), fanDir: v3(0, 0, 1),
            rake: 0.55, spreadResponse: 1.0
        )))
    }

    // --- Anal: along the belly, running nearly the whole underside ---
    do {
        let spec = Fins.anal
        var attachments: [FinAttachment] = []
        for r in 0..<spec.rows {
            let t = Double(r) / Double(spec.rows - 1)
            let idx = segAt(spec.fromS + (spec.toS - spec.fromS) * t)
            attachments.append(FinAttachment(segment: idx, offNormal: 0, offUp: -segs[idx].depth * 0.5))
        }
        fins.append(FinCloth(spec: FinSpec(
            name: "anal", rays: spec.rows, along: spec.cols,
            extent: spec.extent, span: (spec.toS - spec.fromS) * L, fanHalfAngle: 0.22,
            attachments: attachments,
            outward: v3(0, -1, 0), fanDir: v3(0, 0, 1),
            rake: 0.45, spreadResponse: 1.0
        )))
    }

    // --- Pelvics: the pair of long ventral streamers ---
    for side in [-1.0, 1.0] {
        let spec = Fins.pelvic
        let idx = segAt(spec.fromS)
        var attachments: [FinAttachment] = []
        for r in 0..<spec.rows {
            let t = Double(r) / Double(spec.rows - 1)
            attachments.append(FinAttachment(
                segment: idx,
                offNormal: side * segs[idx].width * 0.35,
                offUp: -segs[idx].depth * 0.45 + (t - 0.5) * 0.0008
            ))
        }
        fins.append(FinCloth(spec: FinSpec(
            name: side < 0 ? "pelvicLeft" : "pelvicRight",
            rays: spec.rows, along: spec.cols,
            extent: spec.extent, span: spec.span, fanHalfAngle: 0.16,
            attachments: attachments,
            outward: v3(0, -1, 0), fanDir: v3(0, 0, 1),
            rake: 0.35, spreadResponse: 0.6
        )))
    }

    return fins
}
