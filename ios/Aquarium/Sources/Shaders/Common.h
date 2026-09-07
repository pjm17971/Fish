#ifndef Common_h
#define Common_h

#include <metal_stdlib>
#include "ShaderTypes.h"

using namespace metal;

// Shared shading maths.
//
// This lives in a header rather than a .metal file because Metal compiles each
// .metal file as its own translation unit and does not link between them.
//
// The physically interesting parts are the thin-film interference on the fish's
// scales, the Beer-Lambert absorption through the water, and the
// Henyey-Greenstein phase function for the in-scattering.

constant float PI = 3.141592653589793;

/// Beer-Lambert: what survives a path of the given length through the water.
inline float3 transmittance(float3 absorption, float pathLength) {
    return exp(-absorption * pathLength);
}

/// Schlick's approximation to the Fresnel reflectance.
inline float fresnelSchlick(float cosTheta, float f0) {
    float m = saturate(1.0 - cosTheta);
    float m2 = m * m;
    return f0 + (1.0 - f0) * m2 * m2 * m;
}

inline float3 fresnelSchlick3(float cosTheta, float3 f0) {
    float m = saturate(1.0 - cosTheta);
    float m2 = m * m;
    return f0 + (1.0 - f0) * m2 * m2 * m;
}

/// GGX / Trowbridge-Reitz normal distribution.
inline float distributionGGX(float NdotH, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / max(1e-7, PI * d * d);
}

inline float geometrySmith(float NdotV, float NdotL, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) / 8.0;
    float gv = NdotV / (NdotV * (1.0 - k) + k);
    float gl = NdotL / (NdotL * (1.0 - k) + k);
    return gv * gl;
}

/// Henyey-Greenstein phase function.
///
/// Strongly forward-scattering at g = 0.68, which is why a beam of light in water
/// is bright when you look towards it and nearly invisible when you look away.
inline float phaseHG(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

inline float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

inline float noise2(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + float2(1.0, 0.0));
    float c = hash21(i + float2(0.0, 1.0));
    float d = hash21(i + float2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/// Thin-film interference.
///
/// This is what a betta's colour actually is. The scales contain stacked guanine
/// platelets a few hundred nanometres thick, and light reflecting off the front
/// and back of each platelet interferes with itself. Which wavelengths reinforce
/// depends on the film's thickness and on the viewing angle, which is why the
/// colour slides from blue through green to violet as the fish turns — and why a
/// plain colour map, however well painted, never looks like the animal.
///
/// Evaluated per-channel at representative wavelengths rather than spectrally.
/// That is an approximation, but what it has to get right is the *shift with
/// angle*, and that it does exactly.
inline float3 thinFilm(float cosTheta, float thicknessNm, float filmIOR, float baseIOR) {
    // Refracted angle inside the film, from Snell's law.
    float sinTheta2 = (1.0 - cosTheta * cosTheta) / (filmIOR * filmIOR);
    if (sinTheta2 >= 1.0) return float3(1.0);   // total internal reflection
    float cosThetaFilm = sqrt(1.0 - sinTheta2);

    // Optical path difference between the two reflections, in nanometres.
    float opd = 2.0 * filmIOR * thicknessNm * cosThetaFilm;

    float r1 = fresnelSchlick(cosTheta, pow((1.0 - filmIOR) / (1.0 + filmIOR), 2.0));
    float r2 = fresnelSchlick(cosThetaFilm,
                              pow((filmIOR - baseIOR) / (filmIOR + baseIOR), 2.0));

    // Representative wavelengths for the three channels.
    float3 lambda = float3(612.0, 549.0, 465.0);
    float3 phase = 2.0 * PI * opd / lambda;
    // Two-beam interference, with a further pi of phase shift at the first
    // interface because the film is denser than the medium above it — which is
    // what puts the first constructive band where it belongs.
    float3 interference = r1 + r2 + 2.0 * sqrt(r1 * r2) * cos(phase + PI);
    return saturate(interference);
}

/// Filmic tone mapping (Hejl-Burgess-Dawson), which keeps highlights from
/// clipping to flat white the way a plain clamp does.
inline float3 tonemap(float3 x) {
    x = max(float3(0.0), x - 0.004);
    return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}

/// Total absorption of this tank's water: pure water plus dissolved organics.
inline float3 tankAbsorption(constant FrameUniforms &u) {
    return u.waterAbsorption + u.tanninAbsorption * u.tannin;
}

/// Where a world point lands in the caustic map.
inline float2 causticUV(float3 worldPos, constant FrameUniforms &u) {
    return float2((worldPos.x + u.causticsExtent.x) / (2.0 * u.causticsExtent.x),
                  (worldPos.z + u.causticsExtent.y) / u.causticsExtent.y);
}

/// Convert a YCbCr pair from the camera into linear sRGB.
///
/// ARKit hands the camera image over as two planes in video-range YCbCr, not as
/// RGB. Treating the luma plane as greyscale RGB — the obvious first attempt —
/// gives a monochrome, washed-out image, and using the full-range coefficients
/// instead of the video-range ones crushes the blacks and clips the highlights.
inline float3 cameraYCbCrToLinear(float y, float2 cbcr) {
    const float4x4 ycbcrToRGB = float4x4(
        float4(+1.0000f, +1.0000f, +1.0000f, +0.0000f),
        float4(+0.0000f, -0.3441f, +1.7720f, +0.0000f),
        float4(+1.4020f, -0.7141f, +0.0000f, +0.0000f),
        float4(-0.7010f, +0.5291f, -0.8860f, +1.0000f)
    );
    float4 rgba = ycbcrToRGB * float4(y, cbcr, 1.0);
    float3 srgb = saturate(rgba.rgb);
    // The camera image is in sRGB; everything else here is linear.
    return pow(srgb, float3(2.2));
}

#endif /* Common_h */
