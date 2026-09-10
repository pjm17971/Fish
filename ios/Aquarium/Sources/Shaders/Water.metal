#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"

using namespace metal;

// The water: caustics, the surface itself, and the volume between it and the eye.

// MARK: - Caustics

/// Caustics, computed rather than looped.
///
/// A grid of light rays is refracted through the real water surface with Snell's
/// law and projected onto the substrate. Where neighbouring rays converge the
/// light concentrates; the brightness at a point is the ratio of the original
/// cell's area to the deformed cell's area — the Jacobian of the refraction map.
///
/// The alternative is a looping caustic texture, which is what most real-time
/// water uses. It is cheaper and it is wrong in a way that shows the instant
/// anything disturbs the water: the dapples carry on their pre-recorded dance
/// while the surface supposedly casting them does something else entirely. Here,
/// a pellet hitting the water sends a ring through the caustics because it sent a
/// ring through the water.
///
/// Drawn as points with additive blending, which is how you scatter into a target.

struct CausticInOut {
    float4 position [[position]];
    float pointSize [[point_size]];
    float intensity;
};

struct CausticUniforms {
    float2 gridSize;
    float2 tankExtent;      // half-width, depth
    float waterY;
    float floorY;
    float ior;
    float pad;
    float3 lightDirection;
};

/// Where does a light ray hitting the surface at this grid point land?
static float2 refractTo(float2 g,
                        texture2d<float> heights,
                        sampler s,
                        constant CausticUniforms &c)
{
    float h = heights.sample(s, g).r;
    float2 texel = 1.0 / c.gridSize;
    float hL = heights.sample(s, g - float2(texel.x, 0.0)).r;
    float hR = heights.sample(s, g + float2(texel.x, 0.0)).r;
    float hD = heights.sample(s, g - float2(0.0, texel.y)).r;
    float hU = heights.sample(s, g + float2(0.0, texel.y)).r;

    float2 world = float2((g.x - 0.5) * 2.0 * c.tankExtent.x,
                          -c.tankExtent.y + g.y * c.tankExtent.y);
    float dx = (2.0 * c.tankExtent.x) * texel.x;
    float dz = c.tankExtent.y * texel.y;
    float3 n = normalize(float3(-(hR - hL) / (2.0 * dx), 1.0, -(hU - hD) / (2.0 * dz)));

    // Snell's law, vector form. Air to water, so the ray bends towards the normal.
    float3 i = normalize(-c.lightDirection);
    float eta = 1.0 / c.ior;
    float cosi = -dot(n, i);
    float k = 1.0 - eta * eta * (1.0 - cosi * cosi);
    float3 refracted = (k < 0.0) ? reflect(i, n) : eta * i + (eta * cosi - sqrt(k)) * n;

    float surfaceY = c.waterY + h;
    float t = (c.floorY - surfaceY) / min(-1e-4, refracted.y);
    return world + refracted.xz * t;
}

vertex CausticInOut causticVertex(
    const device CausticVertex *points [[buffer(BufferIndexVertices)]],
    constant CausticUniforms &c [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> heights [[texture(TextureIndexHeightField)]],
    uint vid [[vertex_id]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
    float2 g = points[vid].grid;
    float2 texel = 1.0 / c.gridSize;

    float2 p00 = refractTo(g, heights, s, c);
    float2 p10 = refractTo(g + float2(texel.x, 0.0), heights, s, c);
    float2 p01 = refractTo(g + float2(0.0, texel.y), heights, s, c);

    // Area of the deformed cell against the area it started with. Where rays
    // converge the ratio is large and the light piles up.
    float2 e1 = p10 - p00;
    float2 e2 = p01 - p00;
    float deformedArea = abs(e1.x * e2.y - e1.y * e2.x);
    float originalArea = (2.0 * c.tankExtent.x * texel.x) * (c.tankExtent.y * texel.y);

    CausticInOut out;
    out.intensity = clamp(originalArea / max(1e-9, deformedArea), 0.0, 12.0);

    float2 uv = float2((p00.x + c.tankExtent.x) / (2.0 * c.tankExtent.x),
                       (p00.y + c.tankExtent.y) / c.tankExtent.y);
    out.position = float4(uv * 2.0 - 1.0, 0.0, 1.0);
    out.pointSize = 2.0;
    return out;
}

fragment float4 causticFragment(CausticInOut in [[stage_in]],
                                float2 pointCoord [[point_coord]])
{
    // Soften the point into a small disc so the accumulation does not alias into
    // a grid of dots.
    float2 d = pointCoord - 0.5;
    float falloff = exp(-8.0 * dot(d, d));
    return float4(float3(in.intensity * falloff * 0.06), 1.0);
}

// MARK: - Full-screen passes

struct FullscreenInOut {
    float4 position [[position]];
    float2 uv;
};

/// One triangle rather than two: no seam down the diagonal, and every pixel is
/// shaded exactly once.
vertex FullscreenInOut fullscreenVertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid == 2) ? 3.0 : -1.0, (vid == 1) ? 3.0 : -1.0);
    FullscreenInOut out;
    out.position = float4(p, 0.0, 1.0);
    out.uv = p * 0.5 + 0.5;
    // Metal's texture origin is top-left; clip space y is up.
    out.uv.y = 1.0 - out.uv.y;
    return out;
}

/// Separable Gaussian blur — real caustics have soft edges.
fragment float4 blurFragment(
    FullscreenInOut in [[stage_in]],
    constant float2 &direction [[buffer(0)]],
    texture2d<float> source [[texture(0)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
    float3 sum = source.sample(s, in.uv).rgb * 0.227;
    sum += source.sample(s, in.uv + direction * 1.3846).rgb * 0.3162;
    sum += source.sample(s, in.uv - direction * 1.3846).rgb * 0.3162;
    sum += source.sample(s, in.uv + direction * 3.2308).rgb * 0.0702;
    sum += source.sample(s, in.uv - direction * 3.2308).rgb * 0.0702;
    return float4(sum, 1.0);
}

// MARK: - The camera passthrough

/// The room behind the tank.
///
/// This is not a backdrop. The tank is rigidly attached behind the phone, so the
/// rear camera is looking at exactly what is behind the tank — the passthrough is
/// physically the right image in the right place, which is what makes the glass
/// read as glass. It is drawn first, then everything in the tank is composited
/// over it, and the water's absorption and refraction are applied to it on the
/// way out.
fragment float4 cameraFragment(
    FullscreenInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> cameraY [[texture(TextureIndexCameraY)]],
    texture2d<float> cameraCbCr [[texture(TextureIndexCameraCbCr)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
    // ARKit's image is in its own orientation and aspect; the transform maps the
    // drawable's coordinates onto it.
    float3 uv3 = u.cameraTransform * float3(in.uv, 1.0);
    float2 uv = uv3.xy / uv3.z;

    float y = cameraY.sample(s, uv).r;
    float2 cbcr = cameraCbCr.sample(s, uv).rg;
    return float4(cameraYCbCrToLinear(y, cbcr), 1.0);
}

// MARK: - Water volume

/// The water volume, as a full-screen pass.
///
/// Everything drawn so far is inside the tank, so this applies what the water
/// does to light on its way to the eye: absorption over the path length,
/// in-scattering from suspended particulate, and the motes drifting in it.
fragment float4 volumeFragment(
    FullscreenInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> scene [[texture(TextureIndexScene)]],
    depth2d<float> depthTexture [[texture(TextureIndexDepth)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
    constexpr sampler pointSampler(mag_filter::nearest, min_filter::nearest,
                                   address::clamp_to_edge);

    float3 colour = scene.sample(s, in.uv).rgb;
    float depth = depthTexture.sample(pointSampler, in.uv);

    // Nothing was drawn here: this is the room seen through the glass, and the
    // water in front of it still absorbs, so it is handled below by the depth of
    // the tank rather than skipped.
    float3 world;
    if (depth >= 1.0) {
        // The back wall of the tank, for the purpose of how much water the light
        // came through.
        world = float3(0.0, u.waterY, -u.causticsExtent.y);
    } else {
        float4 clip = float4(in.uv.x * 2.0 - 1.0, (1.0 - in.uv.y) * 2.0 - 1.0, depth, 1.0);
        float4 w = u.inverseViewProjection * clip;
        world = w.xyz / w.w;
    }

    float3 toEye = u.cameraPosition - world;
    float pathLength = length(toEye);
    float3 dir = toEye / max(1e-5, pathLength);

    // Only the part of the path actually under water counts.
    float underwater = pathLength;
    if (u.cameraPosition.y > u.waterY && world.y < u.waterY) {
        underwater = pathLength * (u.waterY - world.y) / max(1e-5, u.cameraPosition.y - world.y);
    } else if (u.cameraPosition.y > u.waterY) {
        underwater = 0.0;
    }

    float3 T = transmittance(tankAbsorption(u), underwater);

    // In-scattering. The Henyey-Greenstein phase function makes the haze brighten
    // sharply when looking towards the light, which is what a real beam in water
    // does and what a constant fog term cannot do.
    float cosTheta = dot(dir, normalize(u.lightDirection));
    float phase = phaseHG(cosTheta, u.scatteringG);
    float3 inScatter = u.lightColour * u.scattering * phase * underwater * 4.0;

    colour = colour * T + inScatter;

    // Suspended particulate — the motes drifting in any real tank. Sparse, and
    // only visible when the light catches them.
    float motes = 0.0;
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float2 p = in.uv * (60.0 + fi * 37.0) + float2(u.time * (0.01 + fi * 0.004), u.time * 0.006);
        motes += smoothstep(0.975, 1.0, noise2(p)) * (1.0 - fi * 0.3);
    }
    colour += float3(0.8, 0.85, 0.8) * motes * u.particleDensity * (0.3 + phase * 2.0);

    return float4(colour, 1.0);
}

// MARK: - The water surface

struct SurfaceInOut {
    float4 position [[position]];
    float3 worldPos;
    float3 normal;
    float3 view;
};

vertex SurfaceInOut surfaceVertex(
    const device SceneVertex *vertices [[buffer(BufferIndexVertices)]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    uint vid [[vertex_id]]
) {
    SceneVertex v = vertices[vid];
    SurfaceInOut out;
    out.worldPos = v.position;
    out.normal = normalize(v.normal);
    out.view = normalize(u.cameraPosition - v.position);
    out.position = u.viewProjection * float4(v.position, 1.0);
    return out;
}

/// The water surface.
///
/// Refraction is done in screen space: the scene behind has already been rendered
/// to a texture, and the surface samples it at an offset given by the refracted
/// ray. That is not physically exact — the offset is a plane approximation and it
/// can sample something that is not really behind the surface — but it is right
/// where it matters and costs one texture read.
///
/// The Fresnel term is the part that must not be fudged. At a grazing angle water
/// is almost a mirror and at normal incidence it is almost clear, and that
/// transition is most of what tells the eye it is looking at water at all.
fragment float4 surfaceFragment(
    SurfaceInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> scene [[texture(TextureIndexScene)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);

    float3 N = normalize(in.normal);
    float3 V = normalize(in.view);
    bool fromBelow = dot(N, V) < 0.0;
    if (fromBelow) N = -N;

    // Small-scale ripples the height field does not resolve. Two layers drifting
    // against each other, so it never reads as one scrolling pattern.
    float2 rippleUV = in.worldPos.xz * 260.0;
    float r1 = noise2(rippleUV + float2(u.time * 0.6, u.time * 0.35));
    float r2 = noise2(rippleUV * 1.7 - float2(u.time * 0.42, u.time * 0.71));
    float3 rippleNormal = normalize(float3((r1 - 0.5) * 0.10, 1.0, (r2 - 0.5) * 0.10));
    N = normalize(N + rippleNormal * 0.35 - float3(0.0, 0.35, 0.0));

    float NdotV = max(dot(N, V), 1e-4);
    float3 L = normalize(u.lightDirection);

    // Fresnel, with water's f0 of 0.02.
    float F = fresnelSchlick(NdotV, 0.02);

    // Screen-space refraction: offset the lookup by the surface's slope.
    float2 screenUV = in.position.xy / u.viewport;
    float2 offset = N.xz * (fromBelow ? 0.14 : 0.055);
    float3 refracted = scene.sample(s, clamp(screenUV + offset, float2(0.001), float2(0.999))).rgb;

    // Reflection. Looking down from above, mostly the room; from underneath, the
    // surface is a mirror past the critical angle, which is the single most
    // striking thing about being under water and is almost never rendered.
    float3 R = reflect(-V, N);
    float3 sky = mix(u.ambient * 3.0, u.lightColour * 0.5, saturate(R.y * 0.5 + 0.5));
    float reflectance = F;
    if (fromBelow) {
        // Total internal reflection beyond the critical angle, 48.6 degrees for
        // water. Past it the surface reflects everything.
        float critical = 1.0 / 1.333;
        float sinT = sqrt(max(0.0, 1.0 - NdotV * NdotV)) / critical;
        reflectance = sinT >= 1.0 ? 1.0 : mix(F, 1.0, smoothstep(0.85, 1.0, sinT));
    }

    float3 colour = mix(refracted, sky, reflectance);

    // Specular glint off the surface, which is what makes the ripples read.
    float3 H = normalize(V + L);
    float spec = distributionGGX(max(dot(N, H), 0.0), 0.06);
    colour += u.lightColour * spec * 0.35 * (fromBelow ? 0.3 : 1.0);

    return float4(colour, 1.0);
}

// MARK: - The front glass

/// The front glass of the tank, which is the phone's own screen.
///
/// It refracts everything behind it — the water, the fish, and the room beyond —
/// by a small screen-space offset, and adds the Fresnel sheen a sheet of glass
/// has at a glancing angle. It is subtle, and leaving it out is one of the things
/// that makes an AR object look pasted on: real glass between you and a scene
/// always does *something*.
fragment float4 glassFragment(
    FullscreenInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> scene [[texture(TextureIndexScene)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);

    // The glass is flat, so the only refraction is at the edges where the view is
    // glancing. Offset outward from the centre, scaled by how oblique the view is.
    float2 centred = in.uv - 0.5;
    float r2 = dot(centred, centred);
    float2 offset = centred * r2 * (u.glassIOR - 1.0) * 0.02;

    // A touch of chromatic aberration through the glass: every real sheet has
    // some, and its complete absence reads as computer graphics without anyone
    // being able to name why.
    float3 colour;
    colour.r = scene.sample(s, clamp(in.uv + offset * 1.04, float2(0.001), float2(0.999))).r;
    colour.g = scene.sample(s, clamp(in.uv + offset, float2(0.001), float2(0.999))).g;
    colour.b = scene.sample(s, clamp(in.uv + offset * 0.96, float2(0.001), float2(0.999))).b;

    // Fresnel sheen at the edges.
    float cosTheta = 1.0 - sqrt(r2) * 0.9;
    float F = fresnelSchlick(saturate(cosTheta), 0.04);
    colour += u.ambient * F * 1.5;

    return float4(colour, 1.0);
}

// MARK: - Post

fragment float4 postFragment(
    FullscreenInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> scene [[texture(TextureIndexScene)]]
) {
    constexpr sampler s(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
    float3 colour = scene.sample(s, in.uv).rgb;

    colour = tonemap(colour);

    // Grain, matched to the camera's own measured noise.
    //
    // This matters more than it sounds. The eye is very good at spotting that two
    // parts of an image were made by different processes, and the most obvious
    // difference between rendered content and a camera feed is that one is clean
    // and the other is not. Matching the noise is most of what makes the two read
    // as one photograph.
    float n = hash21(in.uv * 1024.0 + fract(u.time) * 71.0) - 0.5;
    colour += n * u.cameraGrain;

    return float4(colour, 1.0);
}

// MARK: - Particles

struct ParticleInOut {
    float4 position [[position]];
    float2 uv;
    float3 worldPos;
};

vertex ParticleInOut particleVertex(
    const device float *vertices [[buffer(BufferIndexVertices)]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    uint vid [[vertex_id]]
) {
    // Five floats per vertex: position and uv.
    float3 p = float3(vertices[vid * 5], vertices[vid * 5 + 1], vertices[vid * 5 + 2]);
    ParticleInOut out;
    out.uv = float2(vertices[vid * 5 + 3], vertices[vid * 5 + 4]);
    out.worldPos = p;
    out.position = u.viewProjection * float4(p, 1.0);
    return out;
}

fragment float4 pelletFragment(
    ParticleInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]]
) {
    float2 d = in.uv * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard_fragment();
    // Shade it as a sphere: the normal follows from the disc coordinate.
    float3 N = normalize(float3(d, sqrt(max(0.0, 1.0 - r2))));
    float NdotL = max(dot(N, normalize(u.lightDirection)), 0.0);
    float3 albedo = float3(0.30, 0.18, 0.09);
    float3 colour = albedo * (u.lightColour * (NdotL * 0.8 + 0.2) + u.ambient);
    colour += u.lightColour * pow(NdotL, 24.0) * 0.25;
    colour *= transmittance(tankAbsorption(u), max(0.0, u.waterY - in.worldPos.y));
    return float4(colour * u.exposure, 1.0);
}

fragment float4 bubbleFragment(
    ParticleInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]]
) {
    float2 d = in.uv * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard_fragment();
    float r = sqrt(r2);
    // A bubble is a thin shell of air in water: almost invisible in the middle,
    // with a bright rim where the view grazes the surface and total internal
    // reflection takes over.
    float rim = smoothstep(0.55, 1.0, r);
    float highlight = smoothstep(0.90, 1.0, 1.0 - length(d - float2(-0.35, 0.35)));
    float3 colour = u.lightColour * (rim * 0.5 + highlight * 1.6);
    colour *= transmittance(tankAbsorption(u), max(0.0, u.waterY - in.worldPos.y));
    float alpha = rim * 0.55 + highlight * 0.9;
    return float4(colour * u.exposure, alpha);
}
