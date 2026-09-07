import Foundation
import Metal
import simd

/// Geometry, built from the simulation rather than from an art asset.
///
/// The fish's surface is generated from the same cross-section profile the physics
/// integrates over, so the shape you see and the shape the water pushes on cannot
/// drift apart. A mesh authored in a modelling package alongside a hand-tuned
/// collision shape is the usual reason a simulated creature ends up feeling subtly
/// wrong in a way nobody can point at.

/// Points around each body cross-section.
let RING = 14

/// The fish's body surface, rebuilt each frame from its current pose.
///
/// Cheap enough to do on the CPU for one fish — a few hundred vertices — and it
/// keeps the geometry exactly in step with the physics without a skinning shader
/// to get out of sync.
final class BodyMesh {
    private(set) var vertices: [SceneVertex]
    private(set) var indices: [UInt16]
    let ringCount: Int
    private let morphology: Morphology

    init(morphology: Morphology) {
        self.morphology = morphology
        // Only the fleshy body gets a tube. The caudal segments exist in the
        // physics as a continuation of the body, but visually they are the tail
        // fin, which the fin sheet draws.
        ringCount = morphology.segments.filter { !$0.isCaudal }.count
        vertices = [SceneVertex](
            repeating: SceneVertex(position: .zero, normal: .zero, uv: .zero, extra: .zero),
            count: ringCount * RING
        )

        var idx: [UInt16] = []
        idx.reserveCapacity((ringCount - 1) * RING * 6)
        for i in 0..<(ringCount - 1) {
            for j in 0..<RING {
                let j2 = (j + 1) % RING
                let a = UInt16(i * RING + j)
                let b = UInt16(i * RING + j2)
                let c = UInt16((i + 1) * RING + j)
                let d = UInt16((i + 1) * RING + j2)
                idx.append(contentsOf: [a, c, b, b, c, d])
            }
        }
        indices = idx
    }

    func update(body: FishBody, loco: FishLocomotion, gillFlare: Double) {
        var o = 0
        for i in 0..<ringCount {
            let seg = morphology.segments[i]
            let st = body.segments[i]

            // The gill covers swing out during a threat display. A small change in
            // geometry and a very large change in what the animal looks like it is
            // doing — the head roughly doubles in apparent width.
            var widthScale = 1.0
            if seg.s < 0.22 {
                let t = 1 - seg.s / 0.22
                widthScale = 1 + gillFlare * 1.15 * t * t
            }

            let halfDepth = seg.depth * 0.5
            let halfWidth = seg.width * 0.5 * widthScale

            for j in 0..<RING {
                let a = (Double(j) / Double(RING)) * 2 * Double.pi
                let ca = cos(a)
                let sa = sin(a)

                let local = st.pos + st.normal * (ca * halfWidth) + st.up * (sa * halfDepth)
                let worldPos = loco.toWorld(local)

                // Surface normal. For an ellipse the outward normal is not the
                // radial direction — it is scaled by the reciprocal of each
                // semi-axis, which is what stops a flattened body reading as a
                // cylinder under a specular highlight.
                let nx = ca / max(1e-5, halfWidth)
                let ny = sa / max(1e-5, halfDepth)
                let localN = normalizeSafe(st.normal * nx + st.up * ny)
                let worldN = loco.dirToWorld(localN)

                vertices[o] = SceneVertex(
                    position: f3(worldPos),
                    normal: f3(worldN),
                    uv: SIMD2<Float>(Float(j) / Float(RING), Float(seg.s)),
                    extra: SIMD2<Float>(Float(seg.s), 1)
                )
                o += 1
            }
        }
    }
}

/// A fin's surface, taken straight from the simulated sheet.
final class FinMesh {
    private(set) var vertices: [SceneVertex]
    private(set) var indices: [UInt16]
    private let fin: FinCloth

    init(fin: FinCloth) {
        self.fin = fin
        let rays = fin.spec.rays
        let along = fin.spec.along
        vertices = [SceneVertex](
            repeating: SceneVertex(position: .zero, normal: .zero, uv: .zero, extra: .zero),
            count: rays * along
        )

        var idx: [UInt16] = []
        idx.reserveCapacity((rays - 1) * (along - 1) * 6)
        for r in 0..<(rays - 1) {
            for j in 0..<(along - 1) {
                let a = UInt16(r * along + j)
                let b = a + 1
                let c = UInt16((r + 1) * along + j)
                let d = c + 1
                idx.append(contentsOf: [a, c, b, b, c, d])
            }
        }
        indices = idx
    }

    func update() {
        let rays = fin.spec.rays
        let along = fin.spec.along
        var o = 0
        for r in 0..<rays {
            for j in 0..<along {
                let i = r * along + j
                let t = Float(j) / Float(max(1, along - 1))
                vertices[o] = SceneVertex(
                    position: f3(fin.pos[i]),
                    normal: f3(fin.normals[i]),
                    uv: SIMD2<Float>(Float(r) / Float(max(1, rays - 1)), t),
                    // Thickness in millimetres — the shader uses it for the
                    // translucency, so a ray reads as a denser strut than the
                    // webbing between them.
                    extra: SIMD2<Float>(t, fin.thickness[i] * 1000)
                )
                o += 1
            }
        }
    }
}

/// The water surface as a mesh, from the height field.
final class WaterMesh {
    private(set) var vertices: [SceneVertex]
    private(set) var indices: [UInt32]
    private let water: WaterSurface

    init(water: WaterSurface) {
        self.water = water
        vertices = [SceneVertex](
            repeating: SceneVertex(position: .zero, normal: .zero, uv: .zero, extra: .zero),
            count: water.nx * water.nz
        )

        var idx: [UInt32] = []
        idx.reserveCapacity((water.nx - 1) * (water.nz - 1) * 6)
        for j in 0..<(water.nz - 1) {
            for i in 0..<(water.nx - 1) {
                let a = UInt32(j * water.nx + i)
                let b = a + 1
                let c = a + UInt32(water.nx)
                let d = c + 1
                idx.append(contentsOf: [a, c, b, b, c, d])
            }
        }
        indices = idx
    }

    func update() {
        var o = 0
        for j in 0..<water.nz {
            let z = Float(Tank.minZ + Double(j) * water.dz)
            for i in 0..<water.nx {
                let k = j * water.nx + i
                let x = Float(Tank.minX + Double(i) * water.dx)
                vertices[o] = SceneVertex(
                    position: SIMD3<Float>(x, Float(Tank.waterY) + water.height[k], z),
                    normal: SIMD3<Float>(water.normals[k * 3],
                                         water.normals[k * 3 + 1],
                                         water.normals[k * 3 + 2]),
                    uv: SIMD2<Float>(Float(i) / Float(water.nx - 1), Float(j) / Float(water.nz - 1)),
                    extra: SIMD2<Float>(water.height[k], 0)
                )
                o += 1
            }
        }
    }
}

/// The tank interior: substrate, back and side walls.
///
/// The front is deliberately left out. The front face of the tank is the phone's
/// screen, so there is nothing to draw there — the glass shader handles what a
/// sheet of glass does to the view, and the passthrough handles what is behind it.
func buildTankMesh() -> (vertices: [SceneVertex], indices: [UInt16]) {
    var verts: [SceneVertex] = []
    var idx: [UInt16] = []

    func push(_ p: SIMD3<Float>, _ n: SIMD3<Float>, _ uv: SIMD2<Float>, _ kind: Float) -> UInt16 {
        let i = UInt16(verts.count)
        verts.append(SceneVertex(position: p, normal: n, uv: uv, extra: SIMD2<Float>(kind, 0)))
        return i
    }

    func quad(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, _ d: SIMD3<Float>,
              _ n: SIMD3<Float>, _ kind: Float)
    {
        let i0 = push(a, n, SIMD2<Float>(0, 0), kind)
        let i1 = push(b, n, SIMD2<Float>(1, 0), kind)
        let i2 = push(c, n, SIMD2<Float>(1, 1), kind)
        let i3 = push(d, n, SIMD2<Float>(0, 1), kind)
        idx.append(contentsOf: [i0, i1, i2, i0, i2, i3])
    }

    let x0 = Float(Tank.minX), x1 = Float(Tank.maxX)
    let z0 = Float(Tank.minZ), z1 = Float(Tank.maxZ)
    let yTop = Float(Tank.waterY + 0.03)
    let floorY = Float(Tank.floorY)

    // Substrate, as a grid so it can slope up towards the back and take caustics
    // with some spatial variation.
    let N = 24
    func floorHeight(_ z: Float) -> Float {
        let t = (z - z0) / (z1 - z0)   // 0 at the back, 1 at the front
        return floorY + Float(Tank.floorSlopeBack) * (1 - t)
    }
    let base = UInt16(verts.count)
    for j in 0...N {
        let z = z0 + (z1 - z0) * Float(j) / Float(N)
        for i in 0...N {
            let x = x0 + (x1 - x0) * Float(i) / Float(N)
            // A gentle undulation, so the sand is a surface rather than a plane.
            let ripple = 0.0016 * sin(x * 47 + z * 11) + 0.0011 * sin(x * 23 - z * 37 + 1.3)
            let p = SIMD3<Float>(x, floorHeight(z) + ripple, z)
            // Normal from the analytic derivative of the same expression.
            let dx = 0.0016 * 47 * cos(x * 47 + z * 11) + 0.0011 * 23 * cos(x * 23 - z * 37 + 1.3)
            let dz = -Float(Tank.floorSlopeBack) / (z1 - z0)
                + 0.0016 * 11 * cos(x * 47 + z * 11)
                - 0.0011 * 37 * cos(x * 23 - z * 37 + 1.3)
            let n = simd_normalize(SIMD3<Float>(-dx, 1, -dz))
            _ = push(p, n, SIMD2<Float>(Float(i) / Float(N), Float(j) / Float(N)), 0)
        }
    }
    for j in 0..<N {
        for i in 0..<N {
            let a = base + UInt16(j * (N + 1) + i)
            let b = a + 1
            let c = a + UInt16(N + 1)
            let d = c + 1
            idx.append(contentsOf: [a, c, b, b, c, d])
        }
    }

    // Back wall and the two sides, seen from inside.
    quad(SIMD3(x0, floorY, z0), SIMD3(x1, floorY, z0), SIMD3(x1, yTop, z0), SIMD3(x0, yTop, z0),
         SIMD3(0, 0, 1), 1)
    quad(SIMD3(x0, floorY, z1), SIMD3(x0, floorY, z0), SIMD3(x0, yTop, z0), SIMD3(x0, yTop, z1),
         SIMD3(1, 0, 0), 1)
    quad(SIMD3(x1, floorY, z0), SIMD3(x1, floorY, z1), SIMD3(x1, yTop, z1), SIMD3(x1, yTop, z0),
         SIMD3(-1, 0, 0), 1)

    return (verts, idx)
}

/// Plants and driftwood.
///
/// There is a functional reason for at least one broad leaf: the fish rests on
/// one. A betta lying on a leaf in the middle of the water column is one of the
/// more recognisable things the animal does, and it needs somewhere to do it.
func buildPlantsMesh() -> (vertices: [SceneVertex], indices: [UInt16]) {
    var verts: [SceneVertex] = []
    var idx: [UInt16] = []

    func addLeaf(origin: SIMD3<Float>, direction: SIMD3<Float>, length: Float,
                 width: Float, curl: Float, seed: Float)
    {
        let SEGMENTS = 10
        var side = simd_cross(direction, SIMD3<Float>(0, 1, 0))
        if side.x * side.x + side.z * side.z < 1e-8 { side.x = 1 }
        side = simd_normalize(side)

        let base = UInt16(verts.count)
        let dir = simd_normalize(direction)

        for i in 0...SEGMENTS {
            let t = Float(i) / Float(SEGMENTS)
            // A leaf tapers at both ends and curls over as it rises.
            let w = width * sin(Float.pi * pow(t, 0.7)) * 0.5
            let bend = curl * t * t
            var p = dir * (length * t)
            p.x += origin.x + sin(seed + t * 3) * 0.004
            p.y += origin.y - bend
            p.z += origin.z + cos(seed * 1.7 + t * 2.5) * 0.004

            let n = simd_normalize(simd_cross(side, dir))
            verts.append(SceneVertex(position: p - side * w, normal: n,
                                     uv: SIMD2<Float>(0, t), extra: SIMD2<Float>(2, 0)))
            verts.append(SceneVertex(position: p + side * w, normal: n,
                                     uv: SIMD2<Float>(1, t), extra: SIMD2<Float>(2, 0)))
        }
        for i in 0..<SEGMENTS {
            let a = base + UInt16(i * 2)
            idx.append(contentsOf: [a, a + 2, a + 1, a + 1, a + 2, a + 3])
        }
    }

    let floorY = Float(Tank.floorY)

    // A broad-leaved plant on the left, with one leaf reaching into mid-water:
    // this is the one the fish rests on.
    addLeaf(origin: SIMD3(-0.10, floorY, -0.16), direction: SIMD3(0.25, 1, 0.1),
            length: 0.075, width: 0.026, curl: 0.022, seed: 1.1)
    addLeaf(origin: SIMD3(-0.095, floorY, -0.17), direction: SIMD3(-0.15, 1, 0.2),
            length: 0.062, width: 0.022, curl: 0.016, seed: 2.3)
    addLeaf(origin: SIMD3(-0.105, floorY, -0.15), direction: SIMD3(0.05, 1, -0.25),
            length: 0.055, width: 0.02, curl: 0.012, seed: 3.7)

    // A taller stem plant at the back right.
    for i in 0..<6 {
        let a = (Float(i) / 6) * 2 * Float.pi
        addLeaf(origin: SIMD3(0.11 + cos(a) * 0.012, floorY, -0.20 + sin(a) * 0.012),
                direction: SIMD3(cos(a) * 0.3, 1, sin(a) * 0.3),
                length: 0.055 + Float(i % 3) * 0.012, width: 0.007, curl: 0.008,
                seed: Float(i) * 1.7)
    }

    // A low clump at the right front.
    for i in 0..<4 {
        let a = (Float(i) / 4) * 2 * Float.pi + 0.4
        addLeaf(origin: SIMD3(0.13 + cos(a) * 0.01, floorY, -0.07 + sin(a) * 0.01),
                direction: SIMD3(cos(a) * 0.5, 1, sin(a) * 0.5),
                length: 0.032, width: 0.012, curl: 0.01, seed: Float(i) * 2.9)
    }

    return (verts, idx)
}

/// Write a camera-facing quad for a particle into a float buffer.
func writeBillboard(centre: SIMD3<Float>, right: SIMD3<Float>, up: SIMD3<Float>,
                    size: Float, into out: inout [Float], at offset: Int) -> Int
{
    let corners: [(Float, Float)] = [(-1, -1), (1, -1), (1, 1), (-1, -1), (1, 1), (-1, 1)]
    var o = offset
    for (cx, cy) in corners {
        let p = centre + right * (cx * size) + up * (cy * size)
        out[o] = p.x; o += 1
        out[o] = p.y; o += 1
        out[o] = p.z; o += 1
        out[o] = (cx + 1) * 0.5; o += 1
        out[o] = (cy + 1) * 0.5; o += 1
    }
    return o
}
