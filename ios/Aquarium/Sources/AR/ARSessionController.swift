import ARKit
import CoreMotion
import Foundation
import UIKit
import simd

/// Everything the tank needs to know about the real world.
///
/// Two things are being tracked and they do different jobs.
///
/// **The rear camera, with world tracking**, anchors the tank and provides the
/// image you see through it. The tank is rigidly attached behind the phone — the
/// screen *is* its front glass — so the rear camera sees exactly what is behind
/// the tank: the room. That is what makes the passthrough physically consistent
/// rather than a wallpaper. World tracking also gives the device's linear
/// acceleration, which drives the sloshing, and the direction of gravity, which
/// tells the water and the fish which way is up. Turn the phone and the water
/// level stays horizontal.
///
/// **The front camera, with face tracking**, sets the projection. With
/// `userFaceTrackingEnabled` both run at once on A12 and later. The eye midpoint
/// in device coordinates gives the off-axis frustum that makes the screen behave
/// like a window.
///
/// There is one honest approximation here worth stating. The passthrough image is
/// taken from the rear camera's viewpoint, not from the viewer's eye, so what you
/// see through the tank is *nearly* but not exactly what you would see if the
/// phone were a hole. At arm's length the parallax error is a few degrees, well
/// below what anyone notices against a room several metres away; it would matter
/// for something close behind the phone.
protocol ARSessionControllerDelegate: AnyObject {
    func arSessionDidUpdate(_ controller: ARSessionController, frame: ARFrame)
    func arSession(_ controller: ARSessionController, didFailWith error: Error)
    func arSessionTrackingStateChanged(_ controller: ARSessionController, state: ARCamera.TrackingState)
}

final class ARSessionController: NSObject, ARSessionDelegate {
    let session = ARSession()
    weak var delegate: ARSessionControllerDelegate?

    /// Whether the front camera is contributing a face position.
    private(set) var isFaceTracked = false
    /// The viewer's eye midpoint in the tank's frame, metres.
    private(set) var eyePosition = SIMD3<Float>(0, 0, Float(ViewConfig.fallbackEyeDistance))
    /// Device linear acceleration in the tank's frame, gravity removed, m/s^2.
    var tankAcceleration: SIMD3<Float> {
        rotateAboutZ(rawDeviceAcceleration, by: deviceToScreenAngle)
    }
    /// Ambient light in the room, as intensity in lumens and colour temperature.
    private(set) var ambientIntensity: Float = 1000
    private(set) var ambientColourTemperature: Float = 6500
    /// The camera's exposure, so the rendered content can be matched to it.
    private(set) var exposureOffset: Float = 0

    /// How far the eye tracking has faded in, 0 (fallback) to 1 (face tracked).
    private(set) var faceBlend: Float = 0

    private var eyeFilter = OneEuroVector3(
        minCutoff: ViewConfig.oneEuroMinCutoff,
        beta: ViewConfig.oneEuroBeta,
        derivativeCutoff: ViewConfig.oneEuroDerivativeCutoff
    )

    private let motion = CMMotionManager()
    private var lastTimestamp: TimeInterval = 0
    private var rawDeviceAcceleration = SIMD3<Float>(0, 0, 0)

    /// Which way up the app is currently drawn. Set by the view controller.
    var interfaceOrientation: UIInterfaceOrientation = .landscapeRight

    /// Rotation taking a vector in the rear camera's own frame into the tank's
    /// frame — the frame in which +x is to the right *as the viewer sees it*, +y
    /// is up the screen, and +z comes out of the glass towards them.
    ///
    /// This is asked of ARKit rather than worked out here. Both ARKit's camera
    /// frame and UIKit's orientation names are fixed conventions, but they are
    /// conventions that are easy to get backwards, and getting them backwards
    /// gives a tank whose parallax runs the wrong way — which looks like a bug in
    /// the physics rather than in an axis. `viewMatrix(for:)` is ARKit's own
    /// answer to "which way is up on screen right now", so using it means the
    /// convention never has to be guessed at.
    private(set) var cameraToTank = matrix_identity_float3x3

    /// Rotation about the screen's normal taking CoreMotion's device frame into
    /// the tank's frame, in radians.
    ///
    /// CoreMotion reports in the device's own frame, which is defined with the
    /// phone in portrait; held in landscape, its x and y are swapped relative to
    /// what the viewer sees, so an unrotated acceleration sloshes the water
    /// sideways when you nod the phone. The angle is always a multiple of a
    /// quarter turn and is measured, not assumed: gravity is a single physical
    /// vector that both CoreMotion and ARKit report, so comparing the two gives
    /// the rotation between their frames directly.
    private var deviceToScreenAngle: Float = 0

    private func rotateAboutZ(_ v: SIMD3<Float>, by angle: Float) -> SIMD3<Float> {
        let c = cos(angle), s = sin(angle)
        return SIMD3<Float>(c * v.x - s * v.y, s * v.x + c * v.y, v.z)
    }

    /// Whether this device can run world and face tracking together.
    static var supportsSimultaneousFaceTracking: Bool {
        ARWorldTrackingConfiguration.supportsUserFaceTracking
    }

    static var isSupported: Bool {
        ARWorldTrackingConfiguration.isSupported
    }

    /// See the note in `updateEye`. Left off deliberately; flip it if the parallax
    /// on a real device runs backwards.
    static var mirrorFaceAnchor = false

    override init() {
        super.init()
        session.delegate = self
    }

    func start() {
        guard ARSessionController.isSupported else {
            delegate?.arSession(self, didFailWith: AquariumError.arUnsupported)
            return
        }

        let config = ARWorldTrackingConfiguration()
        // The tank sits behind the phone and travels with it, so no plane
        // detection or scene reconstruction is needed — and leaving them off saves
        // a great deal of power and thermal headroom for the renderer, which is
        // where it is wanted.
        config.planeDetection = []
        config.environmentTexturing = .automatic
        config.isLightEstimationEnabled = true

        if ARWorldTrackingConfiguration.supportsUserFaceTracking {
            config.userFaceTrackingEnabled = true
        }

        // Prefer a format with a high frame rate: the passthrough is half of what
        // the eye is judging, and a 30 Hz camera behind a 60 Hz render reads as
        // the room stuttering behind a smooth tank, which is worse than both being
        // slower.
        if let format = ARWorldTrackingConfiguration.supportedVideoFormats
            .filter({ $0.framesPerSecond >= 60 })
            .min(by: { $0.imageResolution.width < $1.imageResolution.width })
        {
            config.videoFormat = format
        }

        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        startMotionUpdates()
    }

    func pause() {
        session.pause()
        motion.stopDeviceMotionUpdates()
    }

    // MARK: - Device motion

    /// Device motion is read from CoreMotion rather than differentiated from the
    /// ARKit camera transform.
    ///
    /// ARKit's pose is the output of a filter fusing vision and inertial data, and
    /// it is optimised for *position* accuracy, not for the second derivative.
    /// Differentiating it twice gives an acceleration signal buried in the filter's
    /// own corrections, which reads as the water being kicked at random. CoreMotion
    /// reports the accelerometer's own reading with gravity already separated out,
    /// at 100 Hz, which is exactly the quantity wanted.
    private func startMotionUpdates() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 100.0
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] data, _ in
            guard let self = self, let data = data else { return }
            let a = data.userAcceleration   // in g, gravity already removed
            // CoreMotion's device frame, in units of g: +x through the right-hand
            // edge with the phone in portrait, +y through the top, +z out of the
            // screen. Turning it into the tank's frame is a quarter-turn about z
            // that `tankAcceleration` applies.
            self.rawDeviceAcceleration = SIMD3<Float>(
                Float(a.x * 9.81), Float(a.y * 9.81), Float(a.z * 9.81))
        }
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let now = frame.timestamp
        defer { lastTimestamp = now }

        updateFrames(from: frame)
        updateEye(from: frame, timestamp: now)
        updateLighting(from: frame)

        delegate?.arSessionDidUpdate(self, frame: frame)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        delegate?.arSession(self, didFailWith: error)
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        delegate?.arSessionTrackingStateChanged(self, state: camera.trackingState)
    }

    func sessionWasInterrupted(_ session: ARSession) {
        // Losing the session mid-run is common — a call, a notification pulling
        // focus. The eye filter has to forget its history or the first frame back
        // arrives as an enormous apparent head movement and the tank lurches.
        eyeFilter.reset()
    }

    // MARK: - Coordinate frames

    /// Work out, from this frame, how the camera's frame and CoreMotion's frame
    /// each relate to the tank's.
    private func updateFrames(from frame: ARFrame) {
        // ARKit's view matrix maps world space into "what is on screen": +x right,
        // +y up, and the view looking down -z. Composing it with the camera's own
        // world transform cancels the world out and leaves camera -> screen.
        let viewMatrix = frame.camera.viewMatrix(for: interfaceOrientation)
        let m = simd_mul(viewMatrix, frame.camera.transform)
        cameraToTank = simd_float3x3(
            SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z),
            SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z),
            SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        )

        guard let deviceGravity = motion.deviceMotion?.gravity else { return }

        // The same downward vector, seen two ways. ARKit's world has +y up by
        // definition in a world-tracking session, so down in world space is
        // (0, -1, 0); rotating that into the tank's frame gives what CoreMotion
        // ought to be reporting once its frame is corrected.
        let worldDown = SIMD3<Float>(0, -1, 0)
        let cameraRotation = simd_float3x3(
            SIMD3<Float>(frame.camera.transform.columns.0.x,
                         frame.camera.transform.columns.0.y,
                         frame.camera.transform.columns.0.z),
            SIMD3<Float>(frame.camera.transform.columns.1.x,
                         frame.camera.transform.columns.1.y,
                         frame.camera.transform.columns.1.z),
            SIMD3<Float>(frame.camera.transform.columns.2.x,
                         frame.camera.transform.columns.2.y,
                         frame.camera.transform.columns.2.z)
        )
        let gravityInTank = cameraToTank * (cameraRotation.transpose * worldDown)
        let gravityInDevice = SIMD3<Float>(
            Float(deviceGravity.x), Float(deviceGravity.y), Float(deviceGravity.z))

        // Both frames share the screen's normal, so the only difference between
        // them is a rotation about it, and the in-plane part of gravity measures
        // it. With the phone lying flat that part vanishes and the angle is
        // undefined — so keep the last good one, which is right because the phone
        // has not been rotated in its own plane in the meantime.
        let inPlaneTank = simd_length(SIMD2<Float>(gravityInTank.x, gravityInTank.y))
        let inPlaneDevice = simd_length(SIMD2<Float>(gravityInDevice.x, gravityInDevice.y))
        guard inPlaneTank > 0.25, inPlaneDevice > 0.25 else { return }

        let angle = atan2(gravityInTank.y, gravityInTank.x)
            - atan2(gravityInDevice.y, gravityInDevice.x)
        // It can only be a quarter turn, so snap. Snapping also stops the angle
        // dithering by a fraction of a degree from frame to frame, which would
        // otherwise put a slow wobble into the sloshing.
        let quarter = Float.pi / 2
        deviceToScreenAngle = (angle / quarter).rounded() * quarter
    }

    // MARK: - Eye tracking

    private func updateEye(from frame: ARFrame, timestamp: Double) {
        var trackedEye: SIMD3<Float>?

        if let faceAnchor = frame.anchors.compactMap({ $0 as? ARFaceAnchor }).first,
           faceAnchor.isTracked
        {
            // The face anchor is in world space; the projection needs the eye in
            // the tank's frame, because the screen is defined there.
            let cameraTransform = frame.camera.transform
            let faceInCamera = simd_mul(simd_inverse(cameraTransform), faceAnchor.transform)

            // Midpoint of the two eyes. ARKit gives them as transforms relative to
            // the face anchor.
            let leftEye = faceAnchor.leftEyeTransform.columns.3
            let rightEye = faceAnchor.rightEyeTransform.columns.3
            let midpointInFace = (leftEye + rightEye) * 0.5
            let eyeInCamera = simd_mul(faceInCamera, midpointInFace)

            // No mirroring is applied. With `userFaceTrackingEnabled` the front
            // and rear cameras share one world, so the face anchor is at the
            // place in that world where the face really is; mirroring it would
            // put it somewhere it is not. (A face-tracking-only session is the
            // case where the mirroring question arises, and this is not one.)
            //
            // If a device ever proves otherwise, the symptom is unmistakable and
            // the fix is one line: the tank's contents slide the *same* way your
            // head moves instead of the opposite way. Set this to true.
            let eye = ARSessionController.mirrorFaceAnchor
                ? SIMD3<Float>(-eyeInCamera.x, eyeInCamera.y, -eyeInCamera.z)
                : SIMD3<Float>(eyeInCamera.x, eyeInCamera.y, eyeInCamera.z)
            trackedEye = cameraToTank * eye
        }

        let targetBlend: Float = trackedEye != nil ? 1 : 0
        let blendRate = Float(1.0 / ViewConfig.eyeSourceBlendTime)
        let dt = Float(max(1e-4, timestamp - lastTimestamp))
        faceBlend += (targetBlend - faceBlend) * min(1, blendRate * dt)
        isFaceTracked = trackedEye != nil

        // The fallback: a virtual eye in front of the screen, displaced by how the
        // device is tilted relative to gravity. Tilting still changes the
        // perspective, just with less fidelity than a tracked head.
        let fallback = fallbackEye(from: frame)

        let raw = trackedEye ?? fallback
        let filtered = eyeFilter.filter(raw, timestamp: timestamp)
        // Blend rather than switch. A hard cut when the face is found or lost is
        // very visible — the whole scene jumps — and faces are lost constantly at
        // the edge of the front camera's field of view.
        eyePosition = simd_mix(fallback, filtered, SIMD3<Float>(repeating: faceBlend))
    }

    private func fallbackEye(from frame: ARFrame) -> SIMD3<Float> {
        // Gravity in the device's frame tells us how the phone is tilted. The
        // virtual eye is placed a comfortable viewing distance away, offset in the
        // direction the phone is leaning, which reproduces roughly what a viewer
        // holding it that way would see.
        let d = Float(ViewConfig.fallbackEyeDistance)
        guard let gravity = motion.deviceMotion?.gravity else {
            return SIMD3<Float>(0, 0, d)
        }
        // Gravity is a unit vector pointing down; rotate it out of CoreMotion's
        // portrait-based frame into the tank's before reading a tilt from it.
        let g = rotateAboutZ(
            SIMD3<Float>(Float(gravity.x), Float(gravity.y), Float(gravity.z)),
            by: deviceToScreenAngle)
        return SIMD3<Float>(-g.x * d * 0.6, -(g.y + 1) * d * 0.6, d)
    }

    private func updateLighting(from frame: ARFrame) {
        guard let estimate = frame.lightEstimate else { return }
        ambientIntensity = Float(estimate.ambientIntensity)
        ambientColourTemperature = Float(estimate.ambientColorTemperature)

        // Match the render's exposure to the camera's.
        //
        // This is the single most important thing for the composite. The eye
        // judges "is this in the same room as that" almost entirely on whether the
        // two agree about brightness, and a rendered scene at a fixed exposure over
        // a camera that is auto-exposing drifts apart within seconds of anyone
        // walking past a window.
        //
        // ARKit reports ambient intensity in lumens, with 1000 as a nominal
        // neutral indoor level.
        exposureOffset = log2(max(1, ambientIntensity) / 1000.0)
    }

    /// Where a screen point lands in the tank, as a ray in tank coordinates.
    ///
    /// The tank is rigidly attached behind the device, so tank coordinates *are*
    /// device coordinates with the origin at the centre of the screen — no world
    /// transform is involved, which is what makes the tap land where you aimed it
    /// even while you are moving.
    func tankRay(forScreenPoint point: CGPoint, viewport: CGSize, screen: ScreenGeometry)
        -> (origin: Vec3, direction: Vec3)
    {
        // Normalised device coordinates, +x right and +y up.
        let ndcX = Float(point.x / viewport.width) * 2 - 1
        let ndcY = 1 - Float(point.y / viewport.height) * 2

        // The point on the physical screen the finger touched.
        let halfWidth = (screen.bottomRight.x - screen.bottomLeft.x) * 0.5
        let halfHeight = (screen.topLeft.y - screen.bottomLeft.y) * 0.5
        let onScreen = SIMD3<Float>(ndcX * halfWidth, ndcY * halfHeight, 0)

        // The ray runs from the eye through that point and on into the tank.
        let dir = simd_normalize(onScreen - eyePosition)
        return (
            origin: v3(Double(eyePosition.x), Double(eyePosition.y), Double(eyePosition.z)),
            direction: v3(Double(dir.x), Double(dir.y), Double(dir.z))
        )
    }
}

enum AquariumError: LocalizedError {
    case arUnsupported
    case metalUnavailable
    case shaderCompilation(String)

    var errorDescription: String? {
        switch self {
        case .arUnsupported:
            return "This device does not support ARKit world tracking, which the aquarium needs "
                + "to know where it is and to see through the camera."
        case .metalUnavailable:
            return "Metal is not available on this device."
        case .shaderCompilation(let detail):
            return "A shader failed to compile: \(detail)"
        }
    }
}
