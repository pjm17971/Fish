import Foundation
import simd

/// Hydrodynamics and rigid-body motion.
///
/// The contract for this file: **nothing here ever sets the fish's velocity.**
/// The brain sends down a tail-beat frequency, an amplitude and a bend; those
/// shape the body; the shape pushes water; the water pushes back; and the fish's
/// speed is whatever comes out of that. That is the difference between a
/// simulation and an animation, and it is what makes the emergent Strouhal
/// number in the test suite mean anything.
///
/// Three force families act on every body segment:
///
///  - **Reactive (added mass).** A slender body pushing sideways drags a cylinder
///    of water with it, of mass (pi/4)*rho*depth^2 per unit length. The force is
///    the rate of change of that water's momentum — the discrete form of
///    Lighthill's elongated-body theory. The momentum the tail throws into the
///    wake is the momentum the fish gains forwards.
///
///  - **Resistive (cross-flow drag).** A segment held at an angle to its own
///    motion sheds vortices and feels quadratic drag normal to its surface. On a
///    travelling wave whose wave speed exceeds the swimming speed this integrates
///    to net thrust — Taylor's resistive theory.
///
///  - **Skin friction.** Tangential, from the boundary layer. Blasius laminar
///    flat-plate friction with a Hoerner form factor for the body's thickness.
///
/// At a 3 Hz tail beat all three come out the same order of magnitude, which is
/// the sign the model is balanced rather than dominated by one fudged term.

struct ForceBreakdown {
    var reactive = Vec3.zero
    var crossFlow = Vec3.zero
    var friction = Vec3.zero
    var pectoral = Vec3.zero
    var buoyancy = Vec3.zero
    var contact = Vec3.zero
    var external = Vec3.zero

    mutating func clear() {
        reactive = .zero; crossFlow = .zero; friction = .zero
        pectoral = .zero; buoyancy = .zero; contact = .zero; external = .zero
    }
}

struct TankBounds {
    var minX: Double
    var maxX: Double
    var minZ: Double
    var maxZ: Double
    var floorY: Double
    var ceilY: Double
}

private struct SegmentWork {
    /// Offset from the centre of mass, world space.
    var rWorld = Vec3.zero
    var posWorld = Vec3.zero
    /// World-space lateral normal and tangent.
    var n = Vec3.zero
    var t = Vec3.zero
    /// Normal velocity relative to the water, including rigid-body motion.
    var wFull: Double = 0
    /// Normal velocity from the body's own bending alone.
    var wDeform: Double = 0
    /// Bending plus the fish's translation, but excluding its rigid rotation.
    ///
    /// This is the quantity Lighthill's convective term is written in: bending
    /// gives the dh/dt part, translation through an inclined body gives the
    /// U*dh/ds part, and rotation belongs to neither — it is handled by the added
    /// inertia in the mass matrix.
    ///
    /// Using the full relative velocity here instead makes a rigidly rotating
    /// body drive its own rotation: its normal velocity varies linearly along its
    /// length even with no bending at all, so the convective term reads that as a
    /// huge gradient. A fish that stopped swimming would spin up without limit.
    /// Using only the bending part removes that but also removes the genuine
    /// speed-dependent drag the term carries, and the fish comes out about 70%
    /// too efficient.
    var wSlender: Double = 0
    /// Tangential velocity relative to the water.
    var vt: Double = 0
}

final class FishLocomotion {
    /// World position of the centre of mass.
    var position = v3(0, -0.045, -0.12)
    /// Body-to-world rotation.
    var orientation = quatIdentity()
    /// World linear velocity of the centre of mass.
    var velocity = Vec3.zero
    /// World angular velocity.
    var angularVelocity = Vec3.zero

    /// Swim-bladder volume as a multiple of the neutral-buoyancy volume.
    var bladder: Double = 1.0

    /// The walls the fish is confined by, or nil for open water.
    ///
    /// Tests set this to nil. That is not a convenience: with walls in place a
    /// fish swimming in a straight line reaches the front glass in a couple of
    /// seconds and is held there, while its velocity — which the contact spring
    /// never fully kills — keeps reading as though it were still swimming. Every
    /// speed measured that way is meaningless, and looks plausible enough to be
    /// believed.
    var bounds: TankBounds? = TankBounds(
        minX: Tank.minX, maxX: Tank.maxX,
        minZ: Tank.minZ, maxZ: Tank.maxZ,
        floorY: Tank.floorY, ceilY: Tank.waterY + Fish.maxDepth
    )

    private(set) var forces = ForceBreakdown()
    private(set) var netForce = Vec3.zero
    private(set) var netTorque = Vec3.zero

    private let morphology: Morphology
    private let body: FishBody

    /// Per-segment deformation normal velocity from the previous substep.
    private var prevVn: [Double]
    private var work: [SegmentWork]
    private var hasPrevVn = false
    private var prevPecVnL: Double = 0
    private var prevPecVnR: Double = 0

    private var externalForce = Vec3.zero
    private var externalTorque = Vec3.zero
    private var accumulator: Double = 0

    /// Integral of (lateral area * |r|^3) over the body — the geometric part of
    /// the quadratic rotational drag.
    private let rotationalDragFactor: Double

    init(morphology: Morphology, body: FishBody) {
        self.morphology = morphology
        self.body = body
        self.prevVn = [Double](repeating: 0, count: morphology.segments.count)
        self.work = [SegmentWork](repeating: SegmentWork(), count: morphology.segments.count)
        var sum: Double = 0
        for seg in morphology.segments {
            let r = seg.arc - morphology.comArc
            sum += seg.lateralArea * r * r * abs(r)
        }
        self.rotationalDragFactor = sum
    }

    // MARK: - Frames and queries

    func toWorld(_ local: Vec3) -> Vec3 { position + rotate(orientation, local) }
    func dirToWorld(_ local: Vec3) -> Vec3 { rotate(orientation, local) }
    func forward() -> Vec3 { rotate(orientation, v3(0, 0, 1)) }
    func dorsal() -> Vec3 { rotate(orientation, v3(0, 1, 0)) }
    func right() -> Vec3 { rotate(orientation, v3(1, 0, 0)) }

    /// Forward speed along the body axis, not the speed of the CoM through space.
    var forwardSpeed: Double { simd_dot(velocity, forward()) }
    var speed: Double { lengthSafe(velocity) }
    /// Speed in body lengths per second — the unit fish biology is written in.
    var speedSL: Double { speed / morphology.standardLength }

    /// Outside contributors add world-space force at a world point.
    func applyForce(_ force: Vec3, at worldPoint: Vec3) {
        externalForce += force
        externalTorque += simd_cross(worldPoint - position, force)
    }

    func applyTorque(_ torque: Vec3) { externalTorque += torque }

    // MARK: - Stepping

    /// Advance the fish. Accumulates elapsed time and runs fixed 4 ms substeps,
    /// so behaviour is identical at any frame rate.
    func step(_ cmd: MotorCommand, water: WaterSurface?, flow: BulkFlow?, dt: Double) {
        accumulator += dt
        var steps = 0
        while accumulator >= Fish.dt && steps < Fish.maxSubsteps {
            substep(cmd, water: water, flow: flow, dt: Fish.dt)
            accumulator -= Fish.dt
            steps += 1
        }
        if steps == Fish.maxSubsteps { accumulator = 0 }
    }

    private func substep(_ cmd: MotorCommand, water: WaterSurface?, flow: BulkFlow?, dt: Double) {
        // 1. Reshape the body for this instant of the muscle command.
        body.shape(cmd, dt: dt)
        body.stepPectorals(cmd, dt: dt)

        // 2. The swim bladder slews towards its commanded volume. Deliberately
        //    slow — about four seconds end to end — so the fish hangs slightly
        //    nose-up while it trims, as a real one does.
        let bladderTarget = 1.0 + cmd.bladder * 0.15
        let slew = Fish.bladderSlewRate * (Fish.bladderRange.1 - Fish.bladderRange.0)
        bladder = clampd(
            bladder + clampd(bladderTarget - bladder, -slew * dt, slew * dt),
            Fish.bladderRange.0, Fish.bladderRange.1
        )

        forces.clear()
        var F = Vec3.zero
        var T = Vec3.zero

        accumulateBodyForces(&F, &T, flow: flow, dt: dt)
        accumulatePectoralForces(cmd, &F, &T, flow: flow, dt: dt)
        accumulateBuoyancy(&F, &T, water: water)

        // Recoil from internal deformation, rotated into world space.
        T += rotate(orientation, body.recoilTorque)

        accumulateContact(&F)

        F += externalForce
        T += externalTorque
        forces.external = externalForce
        externalForce = .zero
        externalTorque = .zero

        netForce = F
        netTorque = T
        integrate(F, T, dt: dt)
    }

    private func accumulateBodyForces(_ F: inout Vec3, _ T: inout Vec3, flow: BulkFlow?, dt: Double) {
        let segs = morphology.segments
        let n = segs.count
        let invDt = 1 / dt

        // Skin friction coefficients are whole-body properties, evaluated once.
        let sp = max(1e-4, speed)
        let Re = (sp * morphology.standardLength) / NU_WATER
        // Blasius laminar flat plate. At a 0.1 m/s cruise Re is about 5.4e3, well
        // inside the laminar range — a fish this small never gets a turbulent
        // boundary layer.
        let Cf = 1.328 / max(1, Re).squareRoot()
        // Hoerner form factor: a thick body has more than flat-plate friction
        // because the flow has to speed up around it.
        let tRatio = Fish.maxDepth / morphology.standardLength
        let FF = 1 + 1.5 * pow(tRatio, 1.5) + 7 * pow(tRatio, 3)

        // --- Pass 1: relative velocity at every segment ---
        //
        // Only `wDeform` is differentiated in time. That is the fix for a trap
        // that is easy to fall into and fatal when you do: the reactive force is
        // proportional to acceleration, so computing it from the *total* normal
        // acceleration and then applying it as a force feeds the force back into
        // the acceleration that produced it. With added mass this large the loop
        // has gain well above one and the solver diverges within a second,
        // regardless of timestep. The rigid-body share is already accounted for,
        // exactly and implicitly, by the added mass in the mass matrix in
        // `integrate`.
        for i in 0..<n {
            let st = body.segments[i]
            let r = rotate(orientation, st.pos)
            let worldPos = position + r
            work[i].rWorld = r
            work[i].posWorld = worldPos

            // Rigid-body velocity of this point, plus its deformation velocity.
            let deformWorld = rotate(orientation, st.velLocal)
            let worldVel = velocity + simd_cross(angularVelocity, r) + deformWorld

            var flowVel = Vec3.zero
            if let flow = flow {
                flowVel = flow.sample(worldPos)
            }
            let rel = worldVel - flowVel

            work[i].n = rotate(orientation, st.normal)
            work[i].t = rotate(orientation, st.tangent)
            work[i].wFull = simd_dot(rel, work[i].n)
            work[i].wDeform = simd_dot(deformWorld, work[i].n)
            work[i].wSlender = simd_dot(deformWorld + velocity - flowVel, work[i].n)
            work[i].vt = simd_dot(rel, work[i].t)
        }

        // --- Pass 2: forces ---
        for i in 0..<n {
            let seg = segs[i]
            let w = work[i]

            // Speed of the water flowing past the body, head to tail. The tangent
            // points tailward, so a fish swimming forwards has a negative
            // tangential relative velocity and a positive U.
            let U = -w.vt

            let iPrev = max(0, i - 1)
            let iNext = min(n - 1, i + 1)
            let dArc = segs[iNext].arc - segs[iPrev].arc
            let dwds = dArc > 1e-9 ? (work[iNext].wSlender - work[iPrev].wSlender) / dArc : 0

            // The clamp is a real physical bound, not a large round number picked
            // to catch disasters. A tail tip beating at the fish's maximum 9 Hz
            // through its 4.8 mm amplitude peaks at 15 m/s^2, so 80 is already
            // five times anything the animal can do. A looser bound sounds
            // harmlessly generous and is not: the caudal segments carry grams of
            // added mass, so an unphysical spike there produces almost a newton
            // on a fish that weighs fifteen millinewtons.
            let dwdt = hasPrevVn ? clampd((w.wDeform - prevVn[i]) * invDt, -80, 80) : 0
            prevVn[i] = w.wDeform

            // Lighthill's material derivative, following a water particle as it
            // slides along the body: D/Dt = d/dt + U * d/ds. The convective term
            // is what makes thrust depend on forward speed as well as on tail
            // motion, and it is why the fish reaches a steady cruise instead of
            // accelerating without limit.
            let Dw = dwdt + U * dwds
            let ma = seg.addedMassPerLength * seg.ds
            let fReactive = -ma * Dw

            let fCross = -0.5 * RHO_WATER * Fish.crossFlowCd * seg.lateralArea * abs(w.wFull) * w.wFull
            let fFric = -0.5 * RHO_WATER * Cf * FF * seg.wettedArea * abs(w.vt) * w.vt

            let fr = w.n * fReactive
            forces.reactive += fr
            F += fr
            T += simd_cross(w.rWorld, fr)

            let fc = w.n * fCross
            forces.crossFlow += fc
            F += fc
            T += simd_cross(w.rWorld, fc)

            let ff = w.t * fFric
            forces.friction += ff
            F += ff
            T += simd_cross(w.rWorld, ff)
        }
        hasPrevVn = true
    }

    private func accumulatePectoralForces(
        _ cmd: MotorCommand, _ F: inout Vec3, _ T: inout Vec3, flow: BulkFlow?, dt: Double
    ) {
        let invDt = 1 / dt
        let chord = Pectoral.area / Pectoral.span
        // Added mass of a flat plate moving broadside: rho * pi/4 * chord^2 per
        // unit span, times the span.
        let maBlade = RHO_WATER * (Double.pi / 4) * chord * chord * Pectoral.span

        for s in 0..<2 {
            let side: Double = s == 0 ? -1 : 1
            let phase = s == 0 ? body.pectoralPhaseLeft : body.pectoralPhaseRight
            // The slewed frequency, not the commanded one.
            let freq = s == 0 ? body.pectoralFrequencyLeft : body.pectoralFrequencyRight

            // --- Braking ---
            //
            // The pectoral held broadside to the flow, as a flat plate. Applied
            // at the fin's attachment so it also pitches the fish nose-up
            // slightly, which is what a braking fish visibly does.
            if cmd.brake > 1e-3 {
                let r = rotate(orientation, body.pectoralAttach(side: side))
                let worldPos = position + r
                var rel = velocity + simd_cross(angularVelocity, r)
                if let flow = flow { rel -= flow.sample(worldPos) }
                let sp = lengthSafe(rel)
                if sp > 1e-4 {
                    let mag = -0.5 * RHO_WATER * Fish.crossFlowCd * Pectoral.area * cmd.brake * sp
                    let f = rel * mag
                    forces.pectoral += f
                    F += f
                    T += simd_cross(r, f)
                }
            }

            // The fin still does something when it is not beating: held out at an
            // angle in moving water it is a control surface, and that is how the
            // fish pitches. Skipping it whenever the beat frequency was zero left
            // the fish with no elevators at all — and a laterally compressed body
            // generates almost no lift on its own, so it could not change depth
            // by swimming.
            if freq <= 1e-4 && abs(cmd.pectoralPitch) < 1e-3 {
                if s == 0 { prevPecVnL = 0 } else { prevPecVnR = 0 }
                continue
            }

            let spread = 0.55 + 0.45 * cmd.finSpread
            let pose = pectoralPose(phase: phase, side: side, spread: spread, pitchBias: cmd.pectoralPitch)

            // Blade centre, half a span out from the attachment along the blade.
            let cs = cos(pose.sweep)
            let ss = sin(pose.sweep)
            let bladeDir = v3(side * cs, 0, -ss)
            let bladeCentreLocal = body.pectoralAttach(side: side) + bladeDir * (Pectoral.span * 0.5)

            // Blade velocity from the sweep, in the body frame.
            let dSweep = 2 * Double.pi * freq * Pectoral.sweepAmp * spread * cos(phase)
            let bladeVelLocal = v3(
                side * -ss * dSweep * Pectoral.span * 0.5,
                0,
                -cs * dSweep * Pectoral.span * 0.5
            )

            let r = rotate(orientation, bladeCentreLocal)
            let worldPos = position + r
            var rel = velocity + simd_cross(angularVelocity, r) + rotate(orientation, bladeVelLocal)
            if let flow = flow { rel -= flow.sample(worldPos) }

            let bladeN = rotate(orientation, pose.normal)
            let vn = simd_dot(rel, bladeN)
            let prev = s == 0 ? prevPecVnL : prevPecVnR
            // As on the body, this bound is physical: a pectoral beating at its
            // maximum 6 Hz through a 5.5 mm half-stroke peaks at 7.8 m/s^2.
            let dvn = clampd((vn - prev) * invDt, -40, 40)
            if s == 0 { prevPecVnL = vn } else { prevPecVnR = vn }

            let fn = -maBlade * dvn
                - 0.5 * RHO_WATER * Fish.crossFlowCd * Pectoral.area * abs(vn) * vn
            let f = bladeN * fn
            forces.pectoral += f
            F += f
            T += simd_cross(r, f)
        }
    }

    private func accumulateBuoyancy(_ F: inout Vec3, _ T: inout Vec3, water: WaterSurface?) {
        // How much of the fish is under water. A fish gulping air at the surface
        // has part of its head out and loses that share of its buoyancy, which is
        // why it has to work to stay up there.
        var submerged: Double = 1
        if let water = water {
            let surfaceY = water.height(atX: position.x, z: position.z)
            let halfDepth = Fish.maxDepth * 0.5
            submerged = clampd((surfaceY - (position.y - halfDepth)) / (2 * halfDepth), 0, 1)
        }

        let displaced = morphology.neutralVolume * bladder * submerged
        let fy = RHO_WATER * displaced * GRAVITY - morphology.totalMass * GRAVITY
        let f = v3(0, fy, 0)
        forces.buoyancy = f
        F += f

        // Buoyancy acts at the centre of volume, a little above the centre of
        // mass. That offset is the fish's righting moment: it is why a healthy
        // fish rolls upright by itself, and why a sick one lists.
        let arm = rotate(orientation, v3(0, Fish.centreOfVolumeOffsetY, 0))
        T += simd_cross(arm, v3(0, RHO_WATER * displaced * GRAVITY, 0))

        // Rotational drag. Without it the fish would spin freely once torqued; in
        // reality the body sweeping sideways through water damps rotation hard.
        let wl = lengthSafe(angularVelocity)
        if wl > 1e-6 {
            let cRot = 0.5 * RHO_WATER * Fish.crossFlowCd * rotationalDragFactor
            T += angularVelocity * (-cRot * wl)
        }
    }

    private func accumulateContact(_ F: inout Vec3) {
        // Soft contact with the tank. The brain steers away from walls long
        // before this fires; this exists so a startled fish that does clip the
        // glass bounces off rather than passing through.
        //
        // Spring-damper rather than positional correction: a hard reposition
        // injects energy and is what makes a bumped fish jitter against a wall.
        guard let b = bounds else { return }
        let k: Double = 240   // N/m
        let c: Double = 0.9   // N.s/m
        // The margin covers the fish's *reach*, not its girth: the centre of mass
        // sits roughly two centimetres behind the snout, so half the body depth
        // let the head poke through the glass while the centre was still inside.
        let margin = Fish.maxDepth * 0.5 + Fish.standardLength * 0.30

        func push(_ nx: Double, _ ny: Double, _ nz: Double, _ penetration: Double) {
            guard penetration > 0 else { return }
            let vn = velocity.x * nx + velocity.y * ny + velocity.z * nz
            // Damp only while moving into the wall, so the fish is not sucked back.
            let damp = vn < 0 ? -c * vn : 0
            let mag = k * penetration + damp
            let f = v3(nx * mag, ny * mag, nz * mag)
            forces.contact += f
            F += f
        }

        push(1, 0, 0, b.minX + margin - position.x)
        push(-1, 0, 0, position.x - (b.maxX - margin))
        push(0, 0, 1, b.minZ + margin - position.z)
        push(0, 0, -1, position.z - (b.maxZ - margin))
        push(0, 1, 0, b.floorY + margin - position.y)
    }

    private func integrate(_ F: Vec3, _ T: Vec3, dt: Double) {
        // --- Linear ---
        //
        // Added mass is strongly direction-dependent: accelerating forwards is
        // cheap, sideways is expensive, because of how much water has to be
        // shoved aside. Doing this in the body frame is the whole point; an
        // isotropic added mass makes the fish slide sideways far too easily and
        // is immediately readable as wrong.
        let bodyF = rotateInverse(orientation, F)
        let m = morphology.effectiveMass
        let accelBody = v3(bodyF.x / m.y, bodyF.y / m.z, bodyF.z / m.x)
        velocity += rotate(orientation, accelBody) * dt

        // --- Angular ---
        //
        // Euler's equations in the body frame, including the gyroscopic term.
        // Body-axis order, not [roll, pitch, yaw] order — see the note on
        // `effectiveInertiaBody`.
        let bodyT = rotateInverse(orientation, T)
        let wBody = rotateInverse(orientation, angularVelocity)
        let I = morphology.effectiveInertiaBody
        let gx = (I.z - I.y) * wBody.y * wBody.z
        let gy = (I.x - I.z) * wBody.z * wBody.x
        let gz = (I.y - I.x) * wBody.x * wBody.y
        var alphaBody = v3(
            (bodyT.x - gx) / I.x,
            (bodyT.y - gy) / I.y,
            (bodyT.z - gz) / I.z
        )
        // Bound the angular acceleration to something an animal can produce. A
        // C-start in a fish this size reaches about 20 rad/s in 20 ms, roughly
        // 1000 rad/s^2; twice that is beyond anything real, and anything beyond
        // it is a numerical artefact rather than a manoeuvre.
        let alphaMax: Double = 2000
        let al = lengthSafe(alphaBody)
        if al > alphaMax { alphaBody *= alphaMax / al }
        angularVelocity += rotate(orientation, alphaBody) * dt

        // Sanity clamps. A fish cannot exceed about 12 body lengths a second in a
        // burst, or roughly 25 rad/s in a C-start; beyond that is a bug, and
        // clamping keeps a bug visible rather than catastrophic.
        let maxSpeed = 12 * morphology.standardLength
        let sp = lengthSafe(velocity)
        if sp > maxSpeed { velocity *= maxSpeed / sp }
        let wl = lengthSafe(angularVelocity)
        if wl > 25 { angularVelocity *= 25 / wl }

        position += velocity * dt
        orientation = integrateOrientation(orientation, angularVelocity: angularVelocity, dt: dt)

        // Hard backstop on position, with velocity into the wall killed alongside
        // it so a pinned fish reads as stopped rather than as still swimming at
        // full speed.
        if let b = bounds {
            let margin = Fish.maxDepth * 0.5 + Fish.standardLength * 0.30
            func clampAxis(_ v: Double, _ vel: Double, _ lo: Double, _ hi: Double) -> (Double, Double) {
                if v < lo { return (lo, max(0, vel)) }
                if v > hi { return (hi, min(0, vel)) }
                return (v, vel)
            }
            (position.x, velocity.x) = clampAxis(position.x, velocity.x, b.minX + margin, b.maxX - margin)
            (position.z, velocity.z) = clampAxis(position.z, velocity.z, b.minZ + margin, b.maxZ - margin)
            (position.y, velocity.y) = clampAxis(position.y, velocity.y, b.floorY + margin, b.ceilY)
        }
    }
}
