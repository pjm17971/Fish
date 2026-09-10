import ARKit
import Metal
import MetalKit
import simd

/// The Metal renderer.
///
/// Pass order, and why:
///
///   1. **Caustics.** A grid of light rays is refracted through the current water
///      surface and scattered additively onto a map of the tank floor, then
///      blurred. This runs first because everything else reads it.
///   2. **Camera.** The rear-camera image, which is the room behind the tank.
///   3. **Scene.** Tank, plants, fish, fins, pellets — everything under the water
///      — composited over the camera image, with depth.
///   4. **Volume.** A full-screen pass applying what the water does to light on
///      its way out: Beer-Lambert absorption over the path length, and
///      in-scattering from suspended particulate.
///   5. **Surface.** The water surface, refracting the pass-4 result and
///      reflecting the room, with a proper Fresnel mix.
///   6. **Glass.** The front pane, which is the phone's own screen.
///   7. **Post.** Tone mapping and camera-matched grain.
///
/// The volume pass has to come after the scene and before the surface, because
/// the absorption applies to light travelling from the object to the eye and the
/// surface then bends what is left. Doing the surface first and fogging afterwards
/// is the more common arrangement and it puts the haze in front of the
/// reflections, which looks like a dirty window rather than deep water.
final class Renderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let world: World
    private weak var arController: ARSessionController?

    // Pipelines
    private var fishPipeline: MTLRenderPipelineState!
    private var finPipeline: MTLRenderPipelineState!
    private var tankPipeline: MTLRenderPipelineState!
    private var surfacePipeline: MTLRenderPipelineState!
    private var causticPipeline: MTLRenderPipelineState!
    private var blurPipeline: MTLRenderPipelineState!
    private var cameraPipeline: MTLRenderPipelineState!
    private var volumePipeline: MTLRenderPipelineState!
    private var glassPipeline: MTLRenderPipelineState!
    private var postPipeline: MTLRenderPipelineState!
    private var pelletPipeline: MTLRenderPipelineState!
    private var bubblePipeline: MTLRenderPipelineState!
    private var depthState: MTLDepthStencilState!
    private var depthReadOnlyState: MTLDepthStencilState!
    private var noDepthState: MTLDepthStencilState!

    // Geometry
    private let bodyMesh: BodyMesh
    private var finMeshes: [FinMesh] = []
    private let waterMesh: WaterMesh
    private var bodyVertexBuffer: MTLBuffer!
    private var bodyIndexBuffer: MTLBuffer!
    private var finVertexBuffers: [MTLBuffer] = []
    private var finIndexBuffers: [MTLBuffer] = []
    private var waterVertexBuffer: MTLBuffer!
    private var waterIndexBuffer: MTLBuffer!
    private var tankVertexBuffer: MTLBuffer!
    private var tankIndexBuffer: MTLBuffer!
    private var tankIndexCount = 0
    private var plantsVertexBuffer: MTLBuffer!
    private var plantsIndexBuffer: MTLBuffer!
    private var plantsIndexCount = 0
    private var particleBuffer: MTLBuffer!
    private var causticGridBuffer: MTLBuffer!
    private var causticPointCount = 0

    // Targets
    private var sceneTexture: MTLTexture!
    private var volumeTexture: MTLTexture!
    private var surfaceTexture: MTLTexture!
    private var glassTexture: MTLTexture!
    private var depthTexture: MTLTexture!
    private var causticTexture: MTLTexture!
    private var causticBlurTexture: MTLTexture!
    private var heightTexture: MTLTexture!
    private var drawableSize = CGSize(width: 1, height: 1)

    // Camera passthrough
    private var cameraTextureCache: CVMetalTextureCache!
    private var cameraYTexture: MTLTexture?
    private var cameraCbCrTexture: MTLTexture?

    // Uniforms
    /// Three frames in flight is Metal's usual choice: enough that the CPU never
    /// waits on the GPU, few enough that input latency stays low.
    private static let maxFramesInFlight = 3
    private var uniformBuffers: [MTLBuffer] = []
    private var objectBuffers: [MTLBuffer] = []
    private var frameIndex = 0
    private let inFlightSemaphore = DispatchSemaphore(value: maxFramesInFlight)

    private var screen: ScreenGeometry
    private var lastFrameTime: CFTimeInterval = CACurrentMediaTime()

    private static let causticSize = 256

    init(device: MTLDevice, world: World, arController: ARSessionController, screen: ScreenGeometry) throws {
        self.device = device
        self.world = world
        self.arController = arController
        self.screen = screen
        guard let queue = device.makeCommandQueue() else { throw AquariumError.metalUnavailable }
        self.queue = queue

        bodyMesh = BodyMesh(morphology: world.morphology)
        waterMesh = WaterMesh(water: world.water)
        for fin in world.fins { finMeshes.append(FinMesh(fin: fin)) }

        super.init()

        try buildPipelines()
        buildGeometry()
        buildCausticTargets()

        var cache: CVMetalTextureCache?
        CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
        cameraTextureCache = cache
    }

    // MARK: - Setup

    private func buildPipelines() throws {
        guard let library = device.makeDefaultLibrary() else {
            throw AquariumError.shaderCompilation("no default Metal library in the bundle")
        }

        func makePipeline(
            _ label: String, vertex: String, fragment: String,
            pixelFormat: MTLPixelFormat = .rgba16Float,
            depth: Bool = true, blend: Bool = false
        ) throws -> MTLRenderPipelineState {
            let desc = MTLRenderPipelineDescriptor()
            desc.label = label
            desc.vertexFunction = library.makeFunction(name: vertex)
            desc.fragmentFunction = library.makeFunction(name: fragment)
            desc.colorAttachments[0].pixelFormat = pixelFormat
            if blend {
                desc.colorAttachments[0].isBlendingEnabled = true
                desc.colorAttachments[0].rgbBlendOperation = .add
                desc.colorAttachments[0].alphaBlendOperation = .add
                desc.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
                desc.colorAttachments[0].sourceAlphaBlendFactor = .one
                desc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
                desc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            if depth { desc.depthAttachmentPixelFormat = .depth32Float }
            guard desc.vertexFunction != nil, desc.fragmentFunction != nil else {
                throw AquariumError.shaderCompilation("missing \(vertex) or \(fragment)")
            }
            return try device.makeRenderPipelineState(descriptor: desc)
        }

        fishPipeline = try makePipeline("fish", vertex: "sceneVertex", fragment: "fishFragment")
        finPipeline = try makePipeline("fin", vertex: "sceneVertex", fragment: "finFragment", blend: true)
        tankPipeline = try makePipeline("tank", vertex: "sceneVertex", fragment: "tankFragment")
        surfacePipeline = try makePipeline("surface", vertex: "surfaceVertex", fragment: "surfaceFragment")
        pelletPipeline = try makePipeline("pellet", vertex: "particleVertex", fragment: "pelletFragment")
        bubblePipeline = try makePipeline("bubble", vertex: "particleVertex", fragment: "bubbleFragment",
                                          blend: true)
        cameraPipeline = try makePipeline("camera", vertex: "fullscreenVertex",
                                          fragment: "cameraFragment", depth: false)
        volumePipeline = try makePipeline("volume", vertex: "fullscreenVertex",
                                          fragment: "volumeFragment", depth: false)
        glassPipeline = try makePipeline("glass", vertex: "fullscreenVertex",
                                         fragment: "glassFragment", depth: false)
        postPipeline = try makePipeline("post", vertex: "fullscreenVertex",
                                        fragment: "postFragment", pixelFormat: .bgra8Unorm, depth: false)

        // Caustics accumulate additively into a float target.
        let causticDesc = MTLRenderPipelineDescriptor()
        causticDesc.label = "caustics"
        causticDesc.vertexFunction = library.makeFunction(name: "causticVertex")
        causticDesc.fragmentFunction = library.makeFunction(name: "causticFragment")
        causticDesc.colorAttachments[0].pixelFormat = .rgba16Float
        causticDesc.colorAttachments[0].isBlendingEnabled = true
        causticDesc.colorAttachments[0].rgbBlendOperation = .add
        causticDesc.colorAttachments[0].sourceRGBBlendFactor = .one
        causticDesc.colorAttachments[0].destinationRGBBlendFactor = .one
        causticPipeline = try device.makeRenderPipelineState(descriptor: causticDesc)

        blurPipeline = try makePipeline("blur", vertex: "fullscreenVertex",
                                        fragment: "blurFragment", depth: false)

        let dsDesc = MTLDepthStencilDescriptor()
        dsDesc.depthCompareFunction = .lessEqual
        dsDesc.isDepthWriteEnabled = true
        depthState = device.makeDepthStencilState(descriptor: dsDesc)

        // Fins are sheets. Letting each part occlude the rest produces hard
        // internal edges no real fin has, so they test depth but do not write it.
        dsDesc.isDepthWriteEnabled = false
        depthReadOnlyState = device.makeDepthStencilState(descriptor: dsDesc)

        dsDesc.depthCompareFunction = .always
        noDepthState = device.makeDepthStencilState(descriptor: dsDesc)

        for _ in 0..<Renderer.maxFramesInFlight {
            uniformBuffers.append(device.makeBuffer(length: MemoryLayout<FrameUniforms>.stride,
                                                    options: .storageModeShared)!)
            objectBuffers.append(device.makeBuffer(length: MemoryLayout<ObjectUniforms>.stride * 8,
                                                   options: .storageModeShared)!)
        }
    }

    private func buildGeometry() {
        bodyVertexBuffer = device.makeBuffer(length: MemoryLayout<SceneVertex>.stride * bodyMesh.vertices.count,
                                             options: .storageModeShared)
        bodyIndexBuffer = device.makeBuffer(bytes: bodyMesh.indices,
                                            length: MemoryLayout<UInt16>.stride * bodyMesh.indices.count,
                                            options: .storageModeShared)

        for mesh in finMeshes {
            finVertexBuffers.append(device.makeBuffer(
                length: MemoryLayout<SceneVertex>.stride * mesh.vertices.count,
                options: .storageModeShared)!)
            finIndexBuffers.append(device.makeBuffer(
                bytes: mesh.indices,
                length: MemoryLayout<UInt16>.stride * mesh.indices.count,
                options: .storageModeShared)!)
        }

        waterVertexBuffer = device.makeBuffer(
            length: MemoryLayout<SceneVertex>.stride * waterMesh.vertices.count,
            options: .storageModeShared)
        waterIndexBuffer = device.makeBuffer(
            bytes: waterMesh.indices,
            length: MemoryLayout<UInt32>.stride * waterMesh.indices.count,
            options: .storageModeShared)

        let tank = buildTankMesh()
        tankVertexBuffer = device.makeBuffer(bytes: tank.vertices,
                                             length: MemoryLayout<SceneVertex>.stride * tank.vertices.count,
                                             options: .storageModeShared)
        tankIndexBuffer = device.makeBuffer(bytes: tank.indices,
                                            length: MemoryLayout<UInt16>.stride * tank.indices.count,
                                            options: .storageModeShared)
        tankIndexCount = tank.indices.count

        let plants = buildPlantsMesh()
        plantsVertexBuffer = device.makeBuffer(bytes: plants.vertices,
                                               length: MemoryLayout<SceneVertex>.stride * plants.vertices.count,
                                               options: .storageModeShared)
        plantsIndexBuffer = device.makeBuffer(bytes: plants.indices,
                                              length: MemoryLayout<UInt16>.stride * plants.indices.count,
                                              options: .storageModeShared)
        plantsIndexCount = plants.indices.count

        // 72 quads is comfortably more than the pellets and bubbles together.
        particleBuffer = device.makeBuffer(length: MemoryLayout<Float>.stride * 72 * 6 * 5,
                                           options: .storageModeShared)

        // Caustics: one point per cell of the water grid.
        let cw = world.water.nx - 1
        let ch = world.water.nz - 1
        var grid = [CausticVertex]()
        grid.reserveCapacity(cw * ch)
        for j in 0..<ch {
            for i in 0..<cw {
                grid.append(CausticVertex(grid: SIMD2<Float>(
                    (Float(i) + 0.5) / Float(world.water.nx),
                    (Float(j) + 0.5) / Float(world.water.nz)
                )))
            }
        }
        causticPointCount = grid.count
        causticGridBuffer = device.makeBuffer(bytes: grid,
                                              length: MemoryLayout<CausticVertex>.stride * grid.count,
                                              options: .storageModeShared)
    }

    private func buildCausticTargets() {
        func target(_ size: Int) -> MTLTexture {
            let desc = MTLTextureDescriptor.texture2DDescriptor(
                pixelFormat: .rgba16Float, width: size, height: size, mipmapped: false)
            desc.usage = [.renderTarget, .shaderRead]
            desc.storageMode = .private
            return device.makeTexture(descriptor: desc)!
        }
        causticTexture = target(Renderer.causticSize)
        causticBlurTexture = target(Renderer.causticSize)

        let hDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r32Float, width: world.water.nx, height: world.water.nz, mipmapped: false)
        hDesc.usage = [.shaderRead]
        hDesc.storageMode = .shared
        heightTexture = device.makeTexture(descriptor: hDesc)
    }

    // MARK: - MTKViewDelegate

    /// The screen's physical rectangle changes when the device rotates, because
    /// the long edge changes places with the short one.
    func setScreen(_ screen: ScreenGeometry) {
        self.screen = screen
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
        guard size.width > 0 && size.height > 0 else { return }

        func target(_ format: MTLPixelFormat, _ usage: MTLTextureUsage) -> MTLTexture {
            let desc = MTLTextureDescriptor.texture2DDescriptor(
                pixelFormat: format, width: Int(size.width), height: Int(size.height),
                mipmapped: false)
            desc.usage = usage
            desc.storageMode = .private
            return device.makeTexture(descriptor: desc)!
        }
        sceneTexture = target(.rgba16Float, [.renderTarget, .shaderRead])
        volumeTexture = target(.rgba16Float, [.renderTarget, .shaderRead])
        surfaceTexture = target(.rgba16Float, [.renderTarget, .shaderRead])
        glassTexture = target(.rgba16Float, [.renderTarget, .shaderRead])
        // The volume pass reconstructs world positions from depth, so the depth
        // buffer has to be readable as a texture rather than a bare attachment.
        depthTexture = target(.depth32Float, [.renderTarget, .shaderRead])
    }

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let dt = min(0.05, now - lastFrameTime)
        lastFrameTime = now

        // Drive the simulation from the tank's own motion, then advance it.
        if let ar = arController {
            let a = ar.tankAcceleration
            world.setTankAcceleration(x: Double(a.x), z: Double(a.z))
            // Where the viewer is, in tank coordinates. The tank's origin is the
            // centre of the screen, so the eye position is already in that frame.
            let eye = ar.eyePosition
            world.stimuli.viewerPosition = v3(Double(eye.x), Double(eye.y), Double(eye.z))
        }
        world.step(dt: dt)

        guard let drawable = view.currentDrawable,
              sceneTexture != nil,
              let commandBuffer = queue.makeCommandBuffer()
        else { return }

        _ = inFlightSemaphore.wait(timeout: .distantFuture)
        let semaphore = inFlightSemaphore
        commandBuffer.addCompletedHandler { _ in semaphore.signal() }

        frameIndex = (frameIndex + 1) % Renderer.maxFramesInFlight
        updateUniforms()
        updateGeometry()

        renderCaustics(commandBuffer)
        renderScene(commandBuffer)
        renderVolume(commandBuffer)
        renderSurface(commandBuffer)
        renderGlass(commandBuffer)
        renderPost(commandBuffer, to: drawable.texture)

        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    // MARK: - Per-frame updates

    /// Hand ARKit's captured image to Metal without copying it.
    ///
    /// `CVMetalTextureCache` maps the camera's IOSurface directly, so the two
    /// planes become Metal textures with no per-frame copy. Copying a 1080p
    /// YCbCr frame every frame is easily several milliseconds, which is most of
    /// the budget for everything else.
    func updateCameraTextures(from frame: ARFrame) {
        let pixelBuffer = frame.capturedImage
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 2 else { return }
        cameraYTexture = makeTexture(from: pixelBuffer, plane: 0, format: .r8Unorm)
        cameraCbCrTexture = makeTexture(from: pixelBuffer, plane: 1, format: .rg8Unorm)
    }

    private func makeTexture(from pixelBuffer: CVPixelBuffer, plane: Int,
                             format: MTLPixelFormat) -> MTLTexture?
    {
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
        var textureRef: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil, cameraTextureCache, pixelBuffer, nil, format, width, height, plane, &textureRef)
        guard status == kCVReturnSuccess, let ref = textureRef else { return nil }
        return CVMetalTextureGetTexture(ref)
    }

    private func updateUniforms() {
        guard let ar = arController else { return }

        let (projection, viewMatrix) = OffAxisProjection.matrices(
            eye: ar.eyePosition, screen: screen,
            near: ViewConfig.near, far: ViewConfig.far)
        let viewProjection = projection * viewMatrix

        var u = FrameUniforms()
        u.viewProjection = viewProjection
        u.inverseViewProjection = viewProjection.inverse
        u.cameraTransform = matrix_identity_float3x3   // replaced below when a frame is available
        u.cameraPosition = ar.eyePosition
        u.time = Float(world.time)

        // A tank light above and slightly forward, which is where an aquarium
        // hood puts it — plus the room's own ambient, taken from ARKit's estimate
        // so the fish is lit by the light that is actually there.
        u.lightDirection = simd_normalize(SIMD3<Float>(0.12, 0.96, 0.25))
        let kelvin = ar.ambientColourTemperature
        u.lightColour = colourFromKelvin(kelvin) * 1.05
        let ambientLevel = min(1.5, ar.ambientIntensity / 1000.0)
        u.ambient = colourFromKelvin(kelvin) * 0.13 * ambientLevel

        // Match the render's exposure to the camera's. The eye judges "is this in
        // the same room as that" almost entirely on whether the two agree about
        // brightness.
        u.exposure = 1.5 * pow(2.0, -ar.exposureOffset * 0.5)

        u.waterAbsorption = Optics.waterAbsorption
        u.tanninAbsorption = Optics.tanninAbsorption
        u.tannin = Optics.tannin
        u.scattering = Optics.scatteringCoefficient
        u.scatteringG = Optics.scatteringG
        u.waterY = Float(Tank.waterY)
        u.causticsExtent = SIMD2<Float>(Float(Tank.width / 2), Float(Tank.depth))
        u.viewport = SIMD2<Float>(Float(drawableSize.width), Float(drawableSize.height))
        u.filmThicknessNm = Optics.filmThicknessNm
        u.filmIOR = Optics.iorFilm
        u.baseIOR = Optics.iorSkinBase
        u.mucusRoughness = Optics.mucusRoughness
        u.glassIOR = Optics.iorGlass
        // Sensor noise rises steeply as the room gets darker, and matching it is
        // most of what makes the rendered content and the camera image read as one
        // photograph.
        u.cameraGrain = 0.006 + 0.022 * Float(max(0, 1 - ambientLevel))
        u.particleDensity = 0.35

        if let ar = arController, let frame = ar.session.currentFrame {
            let orientation = UIApplication.shared.currentInterfaceOrientation
            let transform = frame.displayTransform(for: orientation, viewportSize: drawableSize)
            let inverted = transform.inverted()
            u.cameraTransform = matrix_float3x3(
                SIMD3<Float>(Float(inverted.a), Float(inverted.b), 0),
                SIMD3<Float>(Float(inverted.c), Float(inverted.d), 0),
                SIMD3<Float>(Float(inverted.tx), Float(inverted.ty), 1)
            )
        }

        uniformBuffers[frameIndex].contents()
            .copyMemory(from: &u, byteCount: MemoryLayout<FrameUniforms>.stride)
    }

    /// Blackbody colour, normalised so it does not also change the brightness.
    ///
    /// ARKit reports the room's colour temperature and using it is what stops the
    /// fish looking daylight-lit in a room full of tungsten lamps.
    private func colourFromKelvin(_ kelvin: Float) -> SIMD3<Float> {
        let t = max(1500, min(15000, kelvin)) / 100
        var r: Float = 255
        var g: Float
        var b: Float = 255
        if t <= 66 {
            g = 99.4708025861 * log(t) - 161.1195681661
            b = t <= 19 ? 0 : 138.5177312231 * log(t - 10) - 305.0447927307
        } else {
            r = 329.698727446 * pow(t - 60, -0.1332047592)
            g = 288.1221695283 * pow(t - 60, -0.0755148492)
        }
        var c = SIMD3<Float>(max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))) / 255
        // Normalise to unit luminance so the temperature tints without dimming.
        let lum = max(1e-3, 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z)
        c /= lum
        return c
    }

    private func updateGeometry() {
        bodyMesh.update(body: world.body, loco: world.locomotion,
                        gillFlare: world.command.gillFlare)
        bodyVertexBuffer.contents().copyMemory(
            from: bodyMesh.vertices,
            byteCount: MemoryLayout<SceneVertex>.stride * bodyMesh.vertices.count)

        for (i, mesh) in finMeshes.enumerated() {
            mesh.update()
            finVertexBuffers[i].contents().copyMemory(
                from: mesh.vertices,
                byteCount: MemoryLayout<SceneVertex>.stride * mesh.vertices.count)
        }

        waterMesh.update()
        waterVertexBuffer.contents().copyMemory(
            from: waterMesh.vertices,
            byteCount: MemoryLayout<SceneVertex>.stride * waterMesh.vertices.count)

        // The height field, for the caustics. Computed from *this* surface, which
        // is the whole point: a pellet hitting the water sends a ring through the
        // caustics because it sent a ring through the water.
        let region = MTLRegionMake2D(0, 0, world.water.nx, world.water.nz)
        world.water.height.withUnsafeBufferPointer { buf in
            heightTexture.replace(region: region, mipmapLevel: 0, withBytes: buf.baseAddress!,
                                  bytesPerRow: MemoryLayout<Float>.stride * world.water.nx)
        }
    }

    // MARK: - Passes

    private func renderCaustics(_ commandBuffer: MTLCommandBuffer) {
        var c = CausticUniformsSwift(
            gridSize: SIMD2<Float>(Float(world.water.nx), Float(world.water.nz)),
            tankExtent: SIMD2<Float>(Float(Tank.width / 2), Float(Tank.depth)),
            waterY: Float(Tank.waterY),
            floorY: Float(Tank.floorY),
            ior: Optics.iorWater,
            pad: 0,
            lightDirection: simd_normalize(SIMD3<Float>(0.12, 0.96, 0.25))
        )

        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = causticTexture
        desc.colorAttachments[0].loadAction = .clear
        desc.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        desc.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "caustics"
        encoder.setRenderPipelineState(causticPipeline)
        encoder.setDepthStencilState(noDepthState)
        encoder.setVertexBuffer(causticGridBuffer, offset: 0, index: BufferIndexVertices.rawValue)
        encoder.setVertexBytes(&c, length: MemoryLayout<CausticUniformsSwift>.stride,
                               index: BufferIndexFrameUniforms.rawValue)
        encoder.setVertexTexture(heightTexture, index: TextureIndexHeightField.rawValue)
        encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: causticPointCount)
        encoder.endEncoding()

        // Blur, separably. Real caustics have soft edges; a sharp accumulation
        // buffer reads as a scatter of dots.
        let texel = 1.0 / Float(Renderer.causticSize)
        blurPass(commandBuffer, from: causticTexture, to: causticBlurTexture,
                 direction: SIMD2<Float>(texel, 0))
        blurPass(commandBuffer, from: causticBlurTexture, to: causticTexture,
                 direction: SIMD2<Float>(0, texel))
        blurPass(commandBuffer, from: causticTexture, to: causticBlurTexture,
                 direction: SIMD2<Float>(texel * 1.5, 0))
    }

    private func blurPass(_ commandBuffer: MTLCommandBuffer, from source: MTLTexture,
                          to destination: MTLTexture, direction: SIMD2<Float>)
    {
        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = destination
        desc.colorAttachments[0].loadAction = .dontCare
        desc.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.setRenderPipelineState(blurPipeline)
        encoder.setDepthStencilState(noDepthState)
        var dir = direction
        encoder.setFragmentBytes(&dir, length: MemoryLayout<SIMD2<Float>>.stride, index: 0)
        encoder.setFragmentTexture(source, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    private func renderScene(_ commandBuffer: MTLCommandBuffer) {
        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = sceneTexture
        desc.colorAttachments[0].loadAction = .clear
        desc.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 1)
        desc.colorAttachments[0].storeAction = .store
        desc.depthAttachment.texture = depthTexture
        desc.depthAttachment.loadAction = .clear
        desc.depthAttachment.clearDepth = 1.0
        desc.depthAttachment.storeAction = .store

        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "scene"
        let uniforms = uniformBuffers[frameIndex]

        // --- The room behind the tank ---
        //
        // Drawn first, filling the frame. Everything in the tank is composited
        // over it, and the water's absorption is applied to it on the way out —
        // so the room genuinely dims and shifts colour with the depth of water in
        // front of it, which is what makes the glass read as glass.
        if let y = cameraYTexture, let cbcr = cameraCbCrTexture {
            encoder.setRenderPipelineState(cameraPipeline)
            encoder.setDepthStencilState(noDepthState)
            encoder.setFragmentBuffer(uniforms, offset: 0, index: BufferIndexFrameUniforms.rawValue)
            encoder.setFragmentTexture(y, index: TextureIndexCameraY.rawValue)
            encoder.setFragmentTexture(cbcr, index: TextureIndexCameraCbCr.rawValue)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }

        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.back)
        encoder.setVertexBuffer(uniforms, offset: 0, index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentBuffer(uniforms, offset: 0, index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentTexture(causticBlurTexture, index: TextureIndexCaustics.rawValue)

        // --- Tank and plants ---
        encoder.setRenderPipelineState(tankPipeline)
        encoder.setVertexBuffer(tankVertexBuffer, offset: 0, index: BufferIndexVertices.rawValue)
        encoder.drawIndexedPrimitives(type: .triangle, indexCount: tankIndexCount,
                                      indexType: .uint16, indexBuffer: tankIndexBuffer,
                                      indexBufferOffset: 0)
        // Leaves are two-sided.
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(plantsVertexBuffer, offset: 0, index: BufferIndexVertices.rawValue)
        encoder.drawIndexedPrimitives(type: .triangle, indexCount: plantsIndexCount,
                                      indexType: .uint16, indexBuffer: plantsIndexBuffer,
                                      indexBufferOffset: 0)

        // --- Fish body ---
        //
        // A red-and-blue betta: a red pigment layer with the blue-green
        // iridescence of the guanine platelets over it. That combination is what a
        // "royal blue" or "red dragon" betta actually is.
        encoder.setCullMode(.back)
        var fishUniforms = ObjectUniforms(
            baseColour: SIMD3<Float>(0.42, 0.045, 0.055),
            roughness: Optics.mucusRoughness,
            secondaryColour: SIMD3<Float>(0.30, 0.10, 0.08),
            pad1: 0
        )
        encoder.setRenderPipelineState(fishPipeline)
        encoder.setFragmentBytes(&fishUniforms, length: MemoryLayout<ObjectUniforms>.stride,
                                 index: BufferIndexObjectUniforms.rawValue)
        encoder.setVertexBuffer(bodyVertexBuffer, offset: 0, index: BufferIndexVertices.rawValue)
        encoder.drawIndexedPrimitives(type: .triangle, indexCount: bodyMesh.indices.count,
                                      indexType: .uint16, indexBuffer: bodyIndexBuffer,
                                      indexBufferOffset: 0)

        // --- Fins ---
        encoder.setCullMode(.none)
        encoder.setDepthStencilState(depthReadOnlyState)
        encoder.setRenderPipelineState(finPipeline)
        var finUniforms = ObjectUniforms(
            baseColour: SIMD3<Float>(0.52, 0.06, 0.09),
            roughness: 0.3,
            secondaryColour: SIMD3<Float>(0.3, 0.05, 0.10),
            pad1: 0
        )
        encoder.setFragmentBytes(&finUniforms, length: MemoryLayout<ObjectUniforms>.stride,
                                 index: BufferIndexObjectUniforms.rawValue)
        for (i, mesh) in finMeshes.enumerated() {
            encoder.setVertexBuffer(finVertexBuffers[i], offset: 0, index: BufferIndexVertices.rawValue)
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: mesh.indices.count,
                                          indexType: .uint16, indexBuffer: finIndexBuffers[i],
                                          indexBufferOffset: 0)
        }

        // --- Pellets and bubbles ---
        drawParticles(encoder)

        encoder.endEncoding()
    }

    private func drawParticles(_ encoder: MTLRenderCommandEncoder) {
        guard let ar = arController else { return }
        // Billboard basis from the eye towards the fish.
        let toFish = f3(world.locomotion.position) - ar.eyePosition
        let forward = simd_normalize(toFish)
        var right = simd_cross(SIMD3<Float>(0, 1, 0), forward)
        if simd_length_squared(right) < 1e-8 { right = SIMD3<Float>(1, 0, 0) }
        right = simd_normalize(right)
        let up = simd_cross(forward, right)

        let ptr = particleBuffer.contents().bindMemory(to: Float.self, capacity: 72 * 6 * 5)
        var scratch = [Float](repeating: 0, count: 72 * 6 * 5)

        // Pellets.
        var offset = 0
        var count = 0
        for p in world.food.pellets where p.alive && count < 48 {
            offset = writeBillboard(centre: f3(p.position), right: right, up: up,
                                    size: Float(p.radius) * 1.6, into: &scratch, at: offset)
            count += 1
        }
        if count > 0 {
            scratch.withUnsafeBufferPointer { buf in
                ptr.update(from: buf.baseAddress!, count: offset)
            }
            encoder.setRenderPipelineState(pelletPipeline)
            encoder.setDepthStencilState(depthState)
            encoder.setVertexBuffer(particleBuffer, offset: 0, index: BufferIndexVertices.rawValue)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: count * 6)
        }

        // Bubbles.
        offset = 0
        count = 0
        for b in world.bubbles where b.alive && count < 24 {
            offset = writeBillboard(centre: f3(b.position), right: right, up: up,
                                    size: Float(b.radius) * 2.2, into: &scratch, at: offset)
            count += 1
        }
        if count > 0 {
            scratch.withUnsafeBufferPointer { buf in
                ptr.update(from: buf.baseAddress!, count: offset)
            }
            encoder.setRenderPipelineState(bubblePipeline)
            encoder.setDepthStencilState(depthReadOnlyState)
            encoder.setVertexBuffer(particleBuffer, offset: 0, index: BufferIndexVertices.rawValue)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: count * 6)
        }
    }

    private func renderVolume(_ commandBuffer: MTLCommandBuffer) {
        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = volumeTexture
        desc.colorAttachments[0].loadAction = .dontCare
        desc.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "volume"
        encoder.setRenderPipelineState(volumePipeline)
        encoder.setDepthStencilState(noDepthState)
        encoder.setFragmentBuffer(uniformBuffers[frameIndex], offset: 0,
                                  index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentTexture(sceneTexture, index: TextureIndexScene.rawValue)
        encoder.setFragmentTexture(depthTexture, index: TextureIndexDepth.rawValue)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    private func renderSurface(_ commandBuffer: MTLCommandBuffer) {
        // Copy the volume result forward, then draw the surface over it sampling
        // that copy — the surface has to read what is behind it, and a texture
        // cannot be read and written in the same pass.
        let copyDesc = MTLRenderPassDescriptor()
        copyDesc.colorAttachments[0].texture = surfaceTexture
        copyDesc.colorAttachments[0].loadAction = .dontCare
        copyDesc.colorAttachments[0].storeAction = .store
        if let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: copyDesc) {
            encoder.setRenderPipelineState(blurPipeline)
            encoder.setDepthStencilState(noDepthState)
            var dir = SIMD2<Float>(0, 0)
            encoder.setFragmentBytes(&dir, length: MemoryLayout<SIMD2<Float>>.stride, index: 0)
            encoder.setFragmentTexture(volumeTexture, index: 0)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
        }

        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = surfaceTexture
        desc.colorAttachments[0].loadAction = .load
        desc.colorAttachments[0].storeAction = .store
        desc.depthAttachment.texture = depthTexture
        desc.depthAttachment.loadAction = .load
        desc.depthAttachment.storeAction = .dontCare

        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "water surface"
        encoder.setRenderPipelineState(surfacePipeline)
        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(waterVertexBuffer, offset: 0, index: BufferIndexVertices.rawValue)
        encoder.setVertexBuffer(uniformBuffers[frameIndex], offset: 0,
                                index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentBuffer(uniformBuffers[frameIndex], offset: 0,
                                  index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentTexture(volumeTexture, index: TextureIndexScene.rawValue)
        encoder.drawIndexedPrimitives(type: .triangle, indexCount: waterMesh.indices.count,
                                      indexType: .uint32, indexBuffer: waterIndexBuffer,
                                      indexBufferOffset: 0)
        encoder.endEncoding()
    }

    private func renderGlass(_ commandBuffer: MTLCommandBuffer) {
        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = glassTexture
        desc.colorAttachments[0].loadAction = .dontCare
        desc.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "front glass"
        encoder.setRenderPipelineState(glassPipeline)
        encoder.setDepthStencilState(noDepthState)
        encoder.setFragmentBuffer(uniformBuffers[frameIndex], offset: 0,
                                  index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentTexture(surfaceTexture, index: TextureIndexScene.rawValue)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    private func renderPost(_ commandBuffer: MTLCommandBuffer, to target: MTLTexture) {
        let desc = MTLRenderPassDescriptor()
        desc.colorAttachments[0].texture = target
        desc.colorAttachments[0].loadAction = .dontCare
        desc.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: desc) else { return }
        encoder.label = "post"
        encoder.setRenderPipelineState(postPipeline)
        encoder.setDepthStencilState(noDepthState)
        encoder.setFragmentBuffer(uniformBuffers[frameIndex], offset: 0,
                                  index: BufferIndexFrameUniforms.rawValue)
        encoder.setFragmentTexture(glassTexture, index: TextureIndexScene.rawValue)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }
}

/// Mirror of the caustic pass's uniform block. Kept next to the renderer because
/// it is used by exactly one pass.
private struct CausticUniformsSwift {
    var gridSize: SIMD2<Float>
    var tankExtent: SIMD2<Float>
    var waterY: Float
    var floorY: Float
    var ior: Float
    var pad: Float
    var lightDirection: SIMD3<Float>
}

#if canImport(UIKit)
import UIKit

extension UIApplication {
    /// The interface orientation, which `displayTransform` needs to map the
    /// camera image correctly. Reading it from the window scene rather than the
    /// deprecated application-level property.
    var currentInterfaceOrientation: UIInterfaceOrientation {
        (connectedScenes.first as? UIWindowScene)?.interfaceOrientation ?? .landscapeRight
    }
}
#endif
