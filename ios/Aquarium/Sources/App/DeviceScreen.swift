import UIKit

/// How big the screen physically is, in metres.
///
/// This is not a cosmetic detail. The whole window effect is built from the
/// rectangle of the screen as seen from the eye, so if the code thinks the
/// screen is 15 cm wide when it is really 13 cm, every angle in the projection
/// is wrong by the same ratio. The tank then appears the wrong size and, worse,
/// the parallax when you tilt is wrong too — which reads as the scene sliding
/// about rather than sitting still behind the glass.
///
/// UIKit will happily report the screen size in points, and points are not a
/// physical unit: they are pixels divided by a scale factor chosen by Apple, and
/// two devices with the same point size can have different physical sizes. So
/// the size has to come from the pixel count and the panel's real pixel density.
///
/// Pixel densities are published by Apple in the device specifications. Nearly
/// every iPhone since the X is 458 or 460 pixels per inch; the LCD models (SE,
/// 8, XR, 11) are 326. Rather than a table of model identifiers that goes stale
/// with every autumn, this keys off the native pixel resolution, which in
/// practice identifies the panel.
enum DeviceScreen {
    /// If you know your device's real display size and want to be exact, put it
    /// here — the diagonal in inches, measured the way Apple quotes it (corner to
    /// corner of the full rounded rectangle). Leaving it nil uses the table below.
    static var overrideDiagonalInches: Double?

    /// Pixel density of the panel, in pixels per inch.
    private static func pixelsPerInch(forNativePixels pixels: CGSize) -> Double {
        // Normalise to portrait so the lookup does not depend on how the phone is
        // being held.
        let w = Int(min(pixels.width, pixels.height).rounded())
        let h = Int(max(pixels.width, pixels.height).rounded())

        switch (w, h) {
        // 326 ppi LCD panels: SE (2nd/3rd gen), 6/7/8, XR, 11.
        case (640, 1136), (750, 1334), (828, 1792):
            return 326
        // 401 ppi: the Plus models, 6/7/8 Plus, which render at 1242x2208 and
        // downsample to the 1080x1920 panel.
        case (1080, 1920):
            return 401
        // 458 ppi: X, XS, XS Max, 11 Pro, 11 Pro Max, 12/13 Pro Max.
        case (1125, 2436), (1242, 2688), (1284, 2778):
            return 458
        // 460 ppi: 12 mini through 17, including the Pro and Max sizes.
        case (1080, 2340), (1170, 2532), (1179, 2556), (1206, 2622),
             (1290, 2796), (1320, 2868):
            return 460
        default:
            // An unknown panel. Every OLED iPhone is within half a per cent of
            // 460 and every LCD one is 326, so the scale factor is a good guess:
            // @3x has always meant a high-density panel.
            return UIScreen.main.nativeScale >= 2.9 ? 460 : 326
        }
    }

    /// The screen's physical width and height in metres, for the current
    /// orientation of the device.
    static func physicalSize() -> (width: Float, height: Float) {
        let native = UIScreen.main.nativeBounds.size    // always portrait-oriented
        let ppi: Double
        if let diagonal = overrideDiagonalInches {
            let diagonalPixels = (native.width * native.width + native.height * native.height)
                .squareRoot()
            ppi = Double(diagonalPixels) / diagonal
        } else {
            ppi = pixelsPerInch(forNativePixels: native)
        }

        let metresPerPixel = 0.0254 / ppi
        let portraitWidth = Double(native.width) * metresPerPixel
        let portraitHeight = Double(native.height) * metresPerPixel

        // In landscape the long edge is horizontal.
        let landscape = UIApplication.shared.currentInterfaceOrientation.isLandscape
        return landscape
            ? (Float(portraitHeight), Float(portraitWidth))
            : (Float(portraitWidth), Float(portraitHeight))
    }

    static func geometry() -> ScreenGeometry {
        let size = physicalSize()
        return ScreenGeometry.forCurrentDevice(widthMetres: size.width, heightMetres: size.height)
    }
}
