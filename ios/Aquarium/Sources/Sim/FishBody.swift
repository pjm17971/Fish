import Foundation
import simd

/// The muscle command the brain sends down. Nothing here is a velocity.
struct MotorCommand {
    /// Tail-beat frequency, Hz.
    var frequency: Double = 0
    /// Tail-tip half-amplitude, metres.
    var amplitude: Double = Fish.standardLength * Fish.tailAmplitudeRatio
    /// Steady one-sided bend for turning, -1 (right) to +1 (left).
    var bend: Double = 0
    /// Steady vertical bend, -1 (nose down) to +1 (nose up).
    ///
    /// A fish pitches by angling its body and letting its forward motion do the
    /// rest. Without it the fish can only steer in yaw, and in a tank where the
    /// food floats and the air is at the top, a fish that cannot aim upwards
    /// approaches a floating pellet to within a centimetre and then circles it
    /// forever, unable to raise its mouth the last few millimetres.
    var pitchBend: Double = 0
    /// Left and right pectoral beat frequency, Hz.
    var pectoralLeft: Double = 0
    var pectoralRight: Double = 0
    /// Commanded change in swim-bladder volume, -1 to +1.
    var bladder: Double = 0
    /// How far the mouth is open, 0 to 1. Drives the suction strike.
    var mouthOpen: Double = 0
    /// How far the fins are spread, 0 (clamped) to 1 (full flare).
    var finSpread: Double = 0.55
    /// Gill cover erection, 0 to 1. Part of the threat display.
    var gillFlare: Double = 0
    /// Braking, 0 to 1: pectoral fins held out broadside as air brakes.
    ///
    /// This is how a fish stops, and without it one cannot. A tail-beat wound
    /// down to zero still leaves the fish coasting for most of a second — far
    /// enough to sail straight past a pellet it had lined up perfectly — because
    /// a streamlined body has very little drag along its own axis.
    var brake: Double = 0
    /// How fast the fish may change its bend, 0 (deliberate) to 1 (reflex).
    ///
    /// A startle response and a cruising course correction do not use the same
    /// muscle: a C-start recruits fast white fibre and reaches full deflection in
    /// under twenty milliseconds, while steady swimming uses slow red fibre and
    /// takes several times that. Letting every steering correction move at
    /// C-start speed is not a free upgrade — it lets the steering controller
    /// oscillate at the frame rate, and because reactive force follows the *rate*
    /// of body deformation, that produces forces many times the fish's weight.
    var agility: Double = 0
}

struct BodySegmentState {
    /// Position in the body frame, measured from the instantaneous centre of mass.
    var pos: Vec3 = .zero
    /// Unit tangent, pointing from head towards tail.
    var tangent: Vec3 = v3(0, 0, -1)
    /// Unit lateral normal (the fish's local "sideways").
    var normal: Vec3 = v3(1, 0, 0)
    /// Unit dorsal direction (the fish's local "up").
    var up: Vec3 = v3(0, 1, 0)
    /// Velocity of this point in the body frame, from deformation alone.
    var velLocal: Vec3 = .zero
}

/// The fish's body shape at an instant.
///
/// Three things here are easy to get wrong and all three change how the fish
/// behaves rather than just how it looks.
///
/// **The body does not stretch.** The muscle command is a lateral displacement
/// wave, but a curve with a lateral offset is *longer* than the straight line it
/// came from. Sampling at uniform parameter would make the fish grow by a few
/// percent every time it bent, which shows up as a pumping motion. So the offset
/// curve is built densely and then resampled at uniform *arc length*. A bent fish
/// therefore spans less distance nose-to-tail than a straight one, which is what
/// a real bent fish does.
///
/// **Internal motion must not move the fish.** Undulate a body about a fixed
/// origin and its centre of mass wanders — and if the rigid-body position is that
/// origin, the fish translates itself by wiggling, with no water involved. That
/// is a free-energy machine and it is the single most common way a "physical"
/// swimmer turns out to be faked. The instantaneous mass-weighted centroid is
/// subtracted every step, so deformation moves nothing; only fluid forces do.
///
/// **Internal motion does produce recoil.** The angular equivalent is real and
/// visible: a fish's head yaws in opposition to its tail. That falls out of
/// conserving angular momentum, so the rate of change of the body's internal
/// angular momentum is fed back as a reaction torque.
final class FishBody {
    let morphology: Morphology
    private(set) var segments: [BodySegmentState]

    /// Number of dense samples used before arc-length resampling.
    private static let DENSE = 120

    /// Phase of the travelling body wave, radians. Integrated, never reset.
    private var wavePhase: Double = 0
    private(set) var pectoralPhaseLeft: Double = 0
    private(set) var pectoralPhaseRight: Double = 0

    private var denseX = [Double](repeating: 0, count: DENSE + 1)
    private var denseY = [Double](repeating: 0, count: DENSE + 1)
    private var denseZ = [Double](repeating: 0, count: DENSE + 1)
    private var denseArc = [Double](repeating: 0, count: DENSE + 1)

    private var prevPos: [Vec3]
    private var hasPrev = false

    private var prevInternalL: Vec3 = .zero
    /// The recoil torque to apply to the rigid body this step.
    private(set) var recoilTorque: Vec3 = .zero

    /// Amplitude actually reached by the tail tip last step.
    private(set) var tailExcursion: Double = 0

    // What the muscles have actually reached, which lags what the brain asked for.
    //
    // Not cosmetic: an amplitude that snaps from full to zero in one 4 ms step
    // straightens the whole body in that step, which the deformation velocity
    // reads as the tail moving at metres per second and turns into an enormous
    // spurious impulse.
    private var actualAmplitude: Double = 0
    private var actualBend: Double = 0
    private var actualPitchBend: Double = 0
    private var actualFrequency: Double = 0
    private var actualAgility: Double = 0
    private var actualPecLeft: Double = 0
    private var actualPecRight: Double = 0

    var frequency: Double { actualFrequency }
    var currentAmplitude: Double { actualAmplitude }
    var pectoralFrequencyLeft: Double { actualPecLeft }
    var pectoralFrequencyRight: Double { actualPecRight }
    var phase: Double { wavePhase }

    init(morphology: Morphology) {
        self.morphology = morphology
        self.segments = Array(repeating: BodySegmentState(), count: morphology.segments.count)
        self.prevPos = Array(repeating: Vec3.zero, count: morphology.segments.count)
        // Start straight so the first step has a sane previous state.
        shape(MotorCommand(), dt: 0)
        commitPrevious()
    }

    /// Rebuild the body's shape for the current motor command.
    ///
    /// Body frame: +x is the fish's right, +y is up (dorsal), +z is forward. The
    /// snout sits near z = 0 and the tail near z = -SL, before the centroid shift.
    func shape(_ cmd: MotorCommand, dt: Double) {
        let L = morphology.standardLength
        let totalArc = morphology.totalArc
        let lambda = Fish.waveLengthRatio * L
        let k = (2 * Double.pi) / lambda   // rad per metre of arc

        if dt > 0 {
            // Finite muscle: the fish cannot bend fully sideways and fully
            // upwards at once, any more than a person can.
            var bendX = cmd.bend
            var bendY = cmd.pitchBend
            let total = (bendX * bendX + bendY * bendY).squareRoot()
            if total > 1 {
                bendX /= total
                bendY /= total
            }
            let agility = clampd(cmd.agility, 0, 1)
            actualAgility = expApproach(actualAgility, agility, rate: 1 / 0.05, dt: dt)
            // Deliberate steering is slow; a reflex is fast. 120 ms is about
            // right for red muscle making a course correction, and it also keeps
            // the steering controller from slamming the bend from one extreme to
            // the other inside a single tail beat.
            let bendTau = 0.120 + (0.015 - 0.120) * agility
            actualAmplitude = expApproach(actualAmplitude, cmd.amplitude, rate: 1 / 0.06, dt: dt)
            actualBend = expApproach(actualBend, bendX, rate: 1 / bendTau, dt: dt)
            actualPitchBend = expApproach(actualPitchBend, bendY, rate: 1 / (bendTau * 2.5), dt: dt)
            actualFrequency = expApproach(actualFrequency, cmd.frequency, rate: 1 / 0.04, dt: dt)

            wavePhase += 2 * Double.pi * actualFrequency * dt
            // Keep the phase bounded so it never loses precision over a long run.
            if wavePhase > 2 * Double.pi {
                wavePhase -= 2 * Double.pi * (wavePhase / (2 * Double.pi)).rounded(.down)
            }
        } else {
            actualAmplitude = cmd.amplitude
            actualBend = cmd.bend
            actualPitchBend = cmd.pitchBend
            actualFrequency = cmd.frequency
            actualAgility = cmd.agility
        }

        // 1. Dense sample of the laterally offset centreline.
        let bendGain = 1 + Fish.bendReflexGain * actualAgility
        for j in 0...FishBody.DENSE {
            let arc = (Double(j) / Double(FishBody.DENSE)) * totalArc
            // s is measured in body lengths, so it runs past 1 over the caudal
            // fin and the amplitude envelope keeps growing — which is what makes
            // the fin's trailing edge the biggest-amplitude part of the animal.
            let s = arc / L
            let env = amplitudeEnvelope(s) * actualAmplitude
            let theta = k * arc - wavePhase
            let wave = sin(theta)
            let steer = actualBend * bendGain
            // The ordinary wave; the same wave beaten harder to one side (sin^2 is
            // one-signed and largest at the extremes: an amplitude asymmetry, not
            // a shift); and the camber of the whole body into the turn.
            let h = env * wave + steer * (Fish.bendAsymmetry * env * wave * wave + bendShape(s))
            denseX[j] = h
            // Vertical bend. Gentler than the lateral one — a fish is far stiffer
            // in that plane, which is why it turns much more readily than it
            // climbs.
            denseY[j] = actualPitchBend * bendShape(s) * 0.55 * bendGain
            denseZ[j] = -arc
        }
        tailExcursion = abs(denseX[FishBody.DENSE])

        // 2. Cumulative arc length along that curve.
        denseArc[0] = 0
        for j in 1...FishBody.DENSE {
            let dx = denseX[j] - denseX[j - 1]
            let dy = denseY[j] - denseY[j - 1]
            let dz = denseZ[j] - denseZ[j - 1]
            denseArc[j] = denseArc[j - 1] + (dx * dx + dy * dy + dz * dz).squareRoot()
        }

        // 3. Resample at uniform arc length, so the body cannot stretch.
        let segs = morphology.segments
        let n = segs.count
        var cursor = 0
        for i in 0..<n {
            let targetArc = segs[i].arc
            while cursor < FishBody.DENSE && denseArc[cursor + 1] < targetArc { cursor += 1 }
            let j1 = min(cursor + 1, FishBody.DENSE)
            let a0 = denseArc[cursor]
            let a1 = denseArc[j1]
            let t = a1 > a0 ? (targetArc - a0) / (a1 - a0) : 0
            segments[i].pos = v3(
                denseX[cursor] + (denseX[j1] - denseX[cursor]) * t,
                denseY[cursor] + (denseY[j1] - denseY[cursor]) * t,
                denseZ[cursor] + (denseZ[j1] - denseZ[cursor]) * t
            )
        }

        // 4. Frames: tangent along the body, normal sideways, up = t x n.
        //
        // A rotation-minimising frame, carried along the body from the head.
        // Building each segment's frame independently from a fixed "up" reference
        // is the obvious approach and it fails as soon as the body bends in both
        // planes at once: the reference becomes nearly parallel to the tangent,
        // the cross product collapses, and the frame spins wildly from segment to
        // segment. Every hydrodynamic force is computed against those directions,
        // so the fish then tears itself apart — turning alone is fine, climbing
        // alone is fine, and doing both spins it up without limit.
        for i in 0..<n {
            let a = segments[max(0, i - 1)].pos
            let b = segments[min(n - 1, i + 1)].pos
            var tmp = b - a
            if lengthSafe(tmp) < 1e-9 { tmp = v3(0, 0, -1) }
            let tg = normalizeSafe(tmp, fallback: v3(0, 0, -1))
            segments[i].tangent = tg

            var nrm: Vec3
            if i == 0 {
                var upRef = v3(0, 1, 0)
                nrm = simd_cross(upRef, tg)
                if lengthSafe(nrm) < 1e-6 {
                    upRef = v3(0, 0, 1)
                    nrm = simd_cross(upRef, tg)
                }
            } else {
                // Project the previous normal onto the plane perpendicular to
                // this tangent — the least possible twist along the body.
                let prev = segments[i - 1].normal
                nrm = prev - tg * simd_dot(prev, tg)
                if lengthSafe(nrm) < 1e-6 {
                    nrm = simd_cross(v3(0, 1, 0), tg)
                }
            }
            segments[i].normal = normalizeSafe(nrm, fallback: v3(1, 0, 0))
            segments[i].up = normalizeSafe(simd_cross(segments[i].tangent, segments[i].normal),
                                           fallback: v3(0, 1, 0))
        }

        // 5. Shift so the mass-weighted centroid is at the body-frame origin.
        var c = Vec3.zero
        let M = morphology.totalMass
        for i in 0..<n { c += segments[i].pos * segs[i].mass }
        c /= M
        for i in 0..<n { segments[i].pos -= c }

        // 6. Deformation velocity, and the recoil torque it implies.
        if dt > 0 && hasPrev {
            let invDt = 1 / dt
            var L_int = Vec3.zero
            for i in 0..<n {
                segments[i].velLocal = (segments[i].pos - prevPos[i]) * invDt
                L_int += simd_cross(segments[i].pos, segments[i].velLocal) * segs[i].mass
            }
            // Reaction torque on the rigid frame is minus the rate of change of
            // the internal angular momentum. This is what makes the head yaw
            // against the tail — the recoil a real swimming fish shows.
            recoilTorque = -(L_int - prevInternalL) * invDt
            prevInternalL = L_int
        } else {
            for i in 0..<n { segments[i].velLocal = .zero }
            recoilTorque = .zero
        }

        commitPrevious()
    }

    private func commitPrevious() {
        for i in 0..<segments.count { prevPos[i] = segments[i].pos }
        hasPrev = true
    }

    /// Advance the pectoral stroke phases.
    ///
    /// The commanded frequency is slewed for the same reason the tail's is: an
    /// instantaneous change in beat rate makes the blade's normal velocity jump,
    /// and the added-mass term differentiates that into an enormous force. The
    /// fin carries about a third of a gram of water and the fish weighs one and a
    /// half, so a spike there is not a small perturbation.
    func stepPectorals(_ cmd: MotorCommand, dt: Double) {
        actualPecLeft = expApproach(actualPecLeft, cmd.pectoralLeft, rate: 1 / 0.08, dt: dt)
        actualPecRight = expApproach(actualPecRight, cmd.pectoralRight, rate: 1 / 0.08, dt: dt)
        pectoralPhaseLeft += 2 * Double.pi * actualPecLeft * dt
        pectoralPhaseRight += 2 * Double.pi * actualPecRight * dt
        let twoPi = 2 * Double.pi
        if pectoralPhaseLeft > twoPi { pectoralPhaseLeft = pectoralPhaseLeft.truncatingRemainder(dividingBy: twoPi) }
        if pectoralPhaseRight > twoPi { pectoralPhaseRight = pectoralPhaseRight.truncatingRemainder(dividingBy: twoPi) }
    }

    /// Body-frame position of the snout tip, for the mouth and strike logic.
    func snout() -> Vec3 {
        let s0 = segments[0]
        return s0.pos - s0.tangent * (morphology.segments[0].ds * 0.5)
    }

    /// Body-frame position of the caudal peduncle.
    func peduncle() -> Vec3 {
        segments[segments.count - 1].pos
    }

    /// Body-frame attachment point of a pectoral fin. `side` is -1 left, +1 right.
    func pectoralAttach(side: Double) -> Vec3 {
        let segs = morphology.segments
        let targetArc = Pectoral.attachAt * morphology.standardLength
        var idx = 0
        for i in 0..<segs.count where segs[i].arc >= targetArc {
            idx = i
            break
        }
        let seg = segments[idx]
        // The segment normal points towards -x on a straight body and the blade
        // extends towards +x for side = +1; this sign puts the root on the same
        // side as the blade, so the fin has a lever arm about the yaw axis.
        return seg.pos + seg.normal * (-side * segs[idx].width * 0.5)
    }
}

/// Position and orientation of a pectoral fin at its current stroke phase.
///
/// The rowing stroke is a sweep back and forth combined with a feathering pitch,
/// and the *phase offset between them* is the whole mechanism. On the power
/// stroke the fin is broadside to its motion and pushes a lot of water; on the
/// recovery stroke it is edge-on and pushes almost none. Set the offset to zero
/// and the two cancel exactly, giving a fin that waves about and produces no
/// thrust at all.
struct PectoralPose {
    var sweep: Double = 0
    var pitch: Double = 0
    var normal: Vec3 = .zero
    var dSweepDPhase: Double = 0
}

func pectoralPose(phase: Double, side: Double, spread: Double, pitchBias: Double,
                  rowing: Double) -> PectoralPose {
    var p = PectoralPose()
    // Folded back along the flank when still; out and rowing when beating. The
    // sweep angle increasing means the fin moving backwards: the power stroke.
    let fold = 1 - rowing
    p.sweep = Pectoral.sweepFolded * fold
        + rowing * (Pectoral.sweepMean + Pectoral.sweepAmp * spread * sin(phase))
    // Feathering: flat through the power stroke (phase near 0), edge-on through
    // the recovery (phase near pi). The steady tilt rides on top of it.
    let feather = rowing * Pectoral.pitchAmp * 0.5 * (1 - cos(phase))
    // Positive bias is nose-up. Sign by measurement.
    p.pitch = feather - pitchBias * 0.55
    p.dSweepDPhase = rowing * Pectoral.sweepAmp * spread * cos(phase)

    // Fin blade normal in the body frame. The span runs outwards at the sweep
    // angle, (side*cs, 0, -ss); the blade is a paddle standing on that span,
    // so its normal is span x up, tilted about the span by the feather angle.
    // It was once set *along* the span, which made the paddle move edge-on and
    // produce no force at all.
    let cs = cos(p.sweep)
    let ss = sin(p.sweep)
    let cp = cos(p.pitch)
    let sp = sin(p.pitch)
    // The tilt about the span mirrors with the side, or the two fins' vertical
    // forces have opposite signs and every turn becomes a climb.
    p.normal = normalizeSafe(v3(ss * cp, side * sp, side * cs * cp), fallback: v3(0, 0, side))
    return p
}
