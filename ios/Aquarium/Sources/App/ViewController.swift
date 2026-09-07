import ARKit
import MetalKit
import UIKit

/// Hosts the tank.
///
/// The whole app is one screen with no interface on it, which is the point: the
/// phone should read as a pane of glass with water behind it, and a button
/// floating over that would break the illusion faster than any rendering error.
/// The only control is the one the brief asked for — a double tap drops food.
final class ViewController: UIViewController, MTKViewDelegate, ARSessionControllerDelegate {
    private var metalView: MTKView!
    private var renderer: Renderer?
    private let arController = ARSessionController()
    private var world: World?

    /// Shown only when something is wrong, or briefly while tracking settles.
    private let statusLabel = UILabel()
    private var statusHideWork: DispatchWorkItem?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        do {
            try setUp()
        } catch {
            showStatus(error.localizedDescription, permanent: true)
        }
    }

    private func setUp() throws {
        guard ARSessionController.isSupported else { throw AquariumError.arUnsupported }
        guard let device = MTLCreateSystemDefaultDevice() else { throw AquariumError.metalUnavailable }

        let world = try World()
        self.world = world

        let metalView = MTKView(frame: view.bounds, device: device)
        // The post pass writes 8-bit colour to the drawable; everything before it
        // works in half float, because the water and the thin-film colours on the
        // scales both have a much wider range than 8 bits can hold and banding in
        // a gradient across a fish's flank is very visible.
        metalView.colorPixelFormat = .bgra8Unorm
        // Depth is handled by the renderer's own texture, which several passes
        // need to read from after the scene pass has finished with it.
        metalView.depthStencilPixelFormat = .invalid
        metalView.preferredFramesPerSecond = 60
        metalView.autoResizeDrawable = true
        metalView.isOpaque = true
        metalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(metalView)
        self.metalView = metalView

        let renderer = try Renderer(
            device: device, world: world, arController: arController,
            screen: DeviceScreen.geometry())
        metalView.delegate = renderer
        self.renderer = renderer

        arController.delegate = self
        arController.interfaceOrientation = currentOrientation()

        setUpStatusLabel()
        setUpGestures()

        if !ARSessionController.supportsSimultaneousFaceTracking {
            // Not fatal. Without the front camera the perspective comes from how
            // the phone is tilted rather than from where your head is, which is
            // less convincing but still moves the right way.
            showStatus("No face tracking on this device — tilt to look around.")
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        arController.start()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        arController.pause()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        metalView?.frame = view.bounds
        // Rotating the device swaps the screen's long and short edges, and the
        // projection is built from the screen's real rectangle, so it has to be
        // rebuilt when that happens.
        renderer?.setScreen(DeviceScreen.geometry())
        arController.interfaceOrientation = currentOrientation()
    }

    private func currentOrientation() -> UIInterfaceOrientation {
        view.window?.windowScene?.interfaceOrientation ?? .landscapeRight
    }

    /// Landscape only. The tank is 35 cm wide and 20 cm tall — a real betta tank's
    /// proportions — and there is no sensible way to look into it through a
    /// portrait window.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: - Feeding

    private func setUpGestures() {
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        view.addGestureRecognizer(doubleTap)
    }

    @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
        guard let world = world else { return }
        let point = gesture.location(in: view)

        // Where the tap lands in the tank is found by casting a ray from the eye
        // through the point of glass that was touched, exactly as the projection
        // does — so the food goes in where you were looking when you tapped, not
        // where it would have gone if you were staring straight down the middle.
        let ray = arController.tankRay(
            forScreenPoint: point,
            viewport: view.bounds.size,
            screen: DeviceScreen.geometry())

        guard let hit = rayToWaterSurface(
            origin: ray.origin, direction: ray.direction, water: world.water)
        else {
            // The ray missed the water entirely — a tap on the sky above the
            // surface, or below the tank. Nothing is dropped, but the fish still
            // hears the knock on the glass.
            world.stimuli.tapImpulse = 1
            return
        }

        // Keep the pellet inside the tank rather than refusing a tap near the
        // edge; someone aiming at the corner meant the corner.
        let x = min(max(hit.x, -Tank.width / 2 + 0.01), Tank.width / 2 - 0.01)
        let z = min(max(hit.z, -Tank.depth + 0.01), -0.01)
        world.feed(atX: x, z: z)

        // A short haptic tick. It is the only feedback there is, and without it a
        // tap that lands outside the water feels like the app has stopped
        // responding.
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: - MTKViewDelegate
    //
    // The renderer is the view's delegate; these exist only so that this class
    // satisfies the protocol if it is ever swapped in for debugging.

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}
    func draw(in view: MTKView) {}

    // MARK: - ARSessionControllerDelegate

    func arSessionDidUpdate(_ controller: ARSessionController, frame: ARFrame) {
        renderer?.updateCameraTextures(from: frame)
    }

    func arSession(_ controller: ARSessionController, didFailWith error: Error) {
        showStatus(error.localizedDescription, permanent: true)
    }

    func arSessionTrackingStateChanged(_ controller: ARSessionController,
                                       state: ARCamera.TrackingState)
    {
        switch state {
        case .normal:
            hideStatus()
        case .notAvailable:
            showStatus("Finding the room…")
        case .limited(let reason):
            switch reason {
            case .initializing:
                showStatus("Finding the room…")
            case .excessiveMotion:
                showStatus("Hold steadier.")
            case .insufficientFeatures:
                showStatus("Too dark, or too plain a background, to track the room.")
            case .relocalizing:
                showStatus("Picking the room back up…")
            @unknown default:
                hideStatus()
            }
        }
    }

    // MARK: - Status text

    private func setUpStatusLabel() {
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.alpha = 0
        statusLabel.shadowColor = .black
        statusLabel.shadowOffset = CGSize(width: 0, height: 1)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor,
                                                constant: -24),
            statusLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.7),
        ])
    }

    private func showStatus(_ text: String, permanent: Bool = false) {
        statusHideWork?.cancel()
        statusLabel.text = text
        UIView.animate(withDuration: 0.2) { self.statusLabel.alpha = 1 }
        guard !permanent else { return }
        let work = DispatchWorkItem { [weak self] in self?.hideStatus() }
        statusHideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    private func hideStatus() {
        statusHideWork?.cancel()
        UIView.animate(withDuration: 0.3) { self.statusLabel.alpha = 0 }
    }
}
