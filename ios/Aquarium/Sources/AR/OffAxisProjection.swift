import Foundation
import simd

/// Generalised off-axis perspective projection.
///
/// This is the maths that makes the screen behave like a window rather than like
/// a screen, and it is the difference between the tank looking as though it is
/// behind the glass and the tank looking as though it is painted on it.
///
/// The usual approach — a symmetric frustum with the camera rotated to match the
/// device — is wrong, and wrong in a way people notice without being able to name.
/// With a symmetric frustum the scene swings *with* the phone: tilt the device and
/// the contents rotate as though they were attached to it. Through a real window
/// the view stays put and you see round the edges of the frame. Getting that right
/// needs the frustum to be asymmetric, cut by the actual rectangle of the screen
/// as seen from wherever the eye happens to be.
///
/// The construction is Robert Kooima's *Generalised Perspective Projection*
/// (2009). Given the eye's position and the screen's three defining corners, it
/// builds the frustum that exactly fills that rectangle.
struct ScreenGeometry {
    /// Bottom-left, bottom-right and top-left corners of the screen, in the
    /// device's own coordinate frame, in metres.
    ///
    /// ARKit's device frame has +x to the right of the device in landscape, +y up,
    /// and +z out of the screen towards the user, so a screen lies in the plane
    /// z = 0 and these are its corners measured from its centre.
    var bottomLeft: SIMD3<Float>
    var bottomRight: SIMD3<Float>
    var topLeft: SIMD3<Float>

    /// The screen of the device this is running on.
    ///
    /// The physical size of the display, not its point or pixel size. A projection
    /// built from pixels is scaled wrongly by whatever the device's pixel density
    /// happens to be, and the illusion is extremely sensitive to that — a ten per
    /// cent error in screen width reads as the tank being the wrong size.
    static func forCurrentDevice(widthMetres: Float, heightMetres: Float) -> ScreenGeometry {
        let w = widthMetres * 0.5
        let h = heightMetres * 0.5
        return ScreenGeometry(
            bottomLeft: SIMD3<Float>(-w, -h, 0),
            bottomRight: SIMD3<Float>(w, -h, 0),
            topLeft: SIMD3<Float>(-w, h, 0)
        )
    }
}

enum OffAxisProjection {
    /// Build the projection and view matrices for an eye at `eye`, looking through
    /// `screen`.
    ///
    /// Both are returned because they are not separable: the view matrix has to
    /// put the eye at the origin looking along the screen's normal, and the
    /// projection has to be cut for that same orientation.
    static func matrices(
        eye: SIMD3<Float>,
        screen: ScreenGeometry,
        near: Float,
        far: Float
    ) -> (projection: simd_float4x4, view: simd_float4x4) {
        // Orthonormal basis of the screen.
        let vr = simd_normalize(screen.bottomRight - screen.bottomLeft)   // right
        let vu = simd_normalize(screen.topLeft - screen.bottomLeft)       // up
        let vn = simd_normalize(simd_cross(vr, vu))                       // towards the viewer

        // Vectors from the eye to three corners.
        let va = screen.bottomLeft - eye
        let vb = screen.bottomRight - eye
        let vc = screen.topLeft - eye

        // Distance from the eye to the screen plane, along the screen's normal.
        let dist = -simd_dot(va, vn)
        // Guard against an eye on or behind the screen plane, which the face
        // tracker can briefly report when it loses confidence.
        let d = max(dist, 1e-3)

        let scale = near / d
        let left = simd_dot(vr, va) * scale
        let right = simd_dot(vr, vb) * scale
        let bottom = simd_dot(vu, va) * scale
        let top = simd_dot(vu, vc) * scale

        let projection = frustum(left: left, right: right, bottom: bottom, top: top,
                                 near: near, far: far)

        // Rotate the world into the screen's frame, then translate the eye to the
        // origin. The rows are the basis vectors, which is the transpose of the
        // matrix that would rotate *into* world space.
        var m = matrix_identity_float4x4
        m.columns.0 = SIMD4<Float>(vr.x, vu.x, vn.x, 0)
        m.columns.1 = SIMD4<Float>(vr.y, vu.y, vn.y, 0)
        m.columns.2 = SIMD4<Float>(vr.z, vu.z, vn.z, 0)
        m.columns.3 = SIMD4<Float>(0, 0, 0, 1)

        var t = matrix_identity_float4x4
        t.columns.3 = SIMD4<Float>(-eye.x, -eye.y, -eye.z, 1)

        return (projection, m * t)
    }

    /// A general asymmetric perspective frustum.
    ///
    /// Metal's clip space runs z from 0 to 1, not -1 to 1 as OpenGL's does. Using
    /// the OpenGL form here compiles, runs, and produces a scene where everything
    /// beyond the middle distance is clipped away — which looks like a depth-buffer
    /// bug rather than a projection one.
    static func frustum(
        left: Float, right: Float, bottom: Float, top: Float, near: Float, far: Float
    ) -> simd_float4x4 {
        let rl = 1 / (right - left)
        let tb = 1 / (top - bottom)
        let fn = 1 / (far - near)

        var m = simd_float4x4(0)
        m.columns.0.x = 2 * near * rl
        m.columns.1.y = 2 * near * tb
        m.columns.2.x = (right + left) * rl
        m.columns.2.y = (top + bottom) * tb
        m.columns.2.z = -far * fn
        m.columns.2.w = -1
        m.columns.3.z = -far * near * fn
        return m
    }
}

/// The 1-euro filter (Casiez, Roussel & Vogel, 2012).
///
/// Head-tracked displays are unusable without something like this. The eye
/// position from face tracking is noisy at the millimetre scale, and a millimetre
/// of jitter at the eye is several millimetres of jitter in the scene — the tank
/// visibly shivers. A fixed low-pass filter forces a choice between jitter when
/// you are still and lag when you move, and both are obvious.
///
/// This one adapts: it filters hard when the signal is slow and barely at all when
/// it is fast, so a still head gives a still image and a moving head gives an
/// image that keeps up.
struct OneEuroFilter {
    private var minCutoff: Double
    private var beta: Double
    private var derivativeCutoff: Double

    private var lastValue: Double = 0
    private var lastDerivative: Double = 0
    private var lastTime: Double = -1
    private var initialised = false

    init(minCutoff: Double, beta: Double, derivativeCutoff: Double = 1.0) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.derivativeCutoff = derivativeCutoff
    }

    private static func alpha(cutoff: Double, dt: Double) -> Double {
        let tau = 1 / (2 * Double.pi * cutoff)
        return 1 / (1 + tau / dt)
    }

    mutating func filter(_ value: Double, timestamp: Double) -> Double {
        guard initialised else {
            lastValue = value
            lastDerivative = 0
            lastTime = timestamp
            initialised = true
            return value
        }
        let dt = max(1e-4, timestamp - lastTime)
        lastTime = timestamp

        // Filter the derivative first: the cutoff for the value depends on it.
        let rawDerivative = (value - lastValue) / dt
        let aD = OneEuroFilter.alpha(cutoff: derivativeCutoff, dt: dt)
        lastDerivative = aD * rawDerivative + (1 - aD) * lastDerivative

        // The faster the signal is moving, the less it is filtered.
        let cutoff = minCutoff + beta * abs(lastDerivative)
        let a = OneEuroFilter.alpha(cutoff: cutoff, dt: dt)
        lastValue = a * value + (1 - a) * lastValue
        return lastValue
    }

    mutating func reset() {
        initialised = false
    }
}

/// Three 1-euro filters, one per axis.
struct OneEuroVector3 {
    private var x: OneEuroFilter
    private var y: OneEuroFilter
    private var z: OneEuroFilter

    init(minCutoff: Double, beta: Double, derivativeCutoff: Double = 1.0) {
        x = OneEuroFilter(minCutoff: minCutoff, beta: beta, derivativeCutoff: derivativeCutoff)
        y = OneEuroFilter(minCutoff: minCutoff, beta: beta, derivativeCutoff: derivativeCutoff)
        z = OneEuroFilter(minCutoff: minCutoff, beta: beta, derivativeCutoff: derivativeCutoff)
    }

    mutating func filter(_ v: SIMD3<Float>, timestamp: Double) -> SIMD3<Float> {
        SIMD3<Float>(
            Float(x.filter(Double(v.x), timestamp: timestamp)),
            Float(y.filter(Double(v.y), timestamp: timestamp)),
            Float(z.filter(Double(v.z), timestamp: timestamp))
        )
    }

    mutating func reset() {
        x.reset()
        y.reset()
        z.reset()
    }
}
