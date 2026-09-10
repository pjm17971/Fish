#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"

using namespace metal;

// The fish, its fins, and the tank it lives in.

struct SceneInOut {
    float4 position [[position]];
    float3 worldPos;
    float3 normal;
    float2 uv;
    float2 extra;
    float3 view;
};

vertex SceneInOut sceneVertex(
    const device SceneVertex *vertices [[buffer(BufferIndexVertices)]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    uint vid [[vertex_id]]
) {
    SceneVertex v = vertices[vid];
    SceneInOut out;
    out.worldPos = v.position;
    out.normal = normalize(v.normal);
    out.uv = v.uv;
    out.extra = v.extra;
    out.view = normalize(u.cameraPosition - v.position);
    out.position = u.viewProjection * float4(v.position, 1.0);
    return out;
}

/// The fish's skin.
///
/// Four layers, in the order light meets them:
///   1. a thin specular mucus coat,
///   2. thin-film interference in the guanine platelets of the scales,
///   3. the pigment layer, with a scale pattern,
///   4. subsurface scattering, which is what stops thin parts reading as plastic.
fragment float4 fishFragment(
    SceneInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    constant ObjectUniforms &o [[buffer(BufferIndexObjectUniforms)]],
    texture2d<float> caustics [[texture(TextureIndexCaustics)]]
) {
    constexpr sampler linearSampler(mag_filter::linear, min_filter::linear,
                                    address::clamp_to_edge);

    float3 N = normalize(in.normal);
    float3 V = normalize(in.view);
    float3 L = normalize(u.lightDirection);

    // --- Scales ---
    //
    // A hexagonal-ish lattice running along the body. The pattern perturbs both
    // the normal and the film thickness, so the iridescence breaks into
    // individual scales instead of sliding across the fish as one sheet.
    float along = in.extra.x;
    float2 scaleUV = float2(in.uv.x * 26.0, along * 34.0);
    float2 cell = floor(scaleUV);
    // Offset alternate rows, which is how fish scales actually tile.
    scaleUV.x += fmod(cell.y, 2.0) * 0.5;
    cell = floor(scaleUV);
    float2 local = fract(scaleUV) - 0.5;
    float scaleEdge = smoothstep(0.42, 0.5, max(abs(local.x), abs(local.y) * 0.85));
    float scaleJitter = hash21(cell) - 0.5;

    // Perturb the normal so each scale is a slightly domed plate.
    float3 tangent = normalize(cross(N, float3(0.0, 1.0, 0.0)) + float3(1e-4));
    float3 bitangent = cross(N, tangent);
    N = normalize(N + (tangent * local.x + bitangent * local.y) * 0.35 * (1.0 - scaleEdge));

    float NdotV = max(dot(N, V), 1e-4);
    float NdotL = max(dot(N, L), 0.0);
    float3 H = normalize(V + L);
    float NdotH = max(dot(N, H), 0.0);

    // --- Thin-film iridescence ---
    float thickness = u.filmThicknessNm + scaleJitter * 90.0
        + 40.0 * sin(along * 9.0 + u.time * 0.05);
    float3 iridescence = thinFilm(NdotV, thickness, u.filmIOR, u.baseIOR);

    // --- Pigment ---
    //
    // Darker along the back, paler on the belly. Countershading is nearly
    // universal in fish and its absence is immediately readable, even to someone
    // who has never thought about why.
    float ventral = smoothstep(-0.2, 0.9, -N.y);
    float3 albedo = mix(o.baseColour, o.secondaryColour, ventral * 0.75);
    albedo *= 1.0 - scaleEdge * 0.25;
    // The head is less iridescent than the flank, as on the real animal.
    float irisMask = smoothstep(0.05, 0.35, along) * (1.0 - scaleEdge * 0.5);

    // --- Direct lighting ---
    float D = distributionGGX(NdotH, o.roughness);
    float G = geometrySmith(NdotV, NdotL, o.roughness);
    float3 F = fresnelSchlick3(max(dot(H, V), 0.0), float3(0.04));
    float3 specular = (D * G * F) / max(1e-4, 4.0 * NdotV * NdotL + 1e-4);

    // --- Caustics ---
    //
    // The dappled light from the surface falls on the fish too, not only on the
    // sand. Leaving it off the animal is a common omission and it quietly
    // separates the fish from the scene it is swimming in.
    float caustic = caustics.sample(linearSampler, causticUV(in.worldPos, u)).r;
    float depthBelow = max(0.0, u.waterY - in.worldPos.y);
    caustic *= smoothstep(-0.1, 0.4, N.y) * exp(-depthBelow * 1.5);

    float3 lit = u.lightColour * (1.0 + caustic * 2.4) * NdotL;
    float3 colour = albedo * (lit + u.ambient);
    colour += specular * lit * 2.0;
    colour += iridescence * irisMask * (lit * 0.55 + u.ambient * 0.8) * 1.15;

    // --- Subsurface ---
    //
    // Wrapped diffuse plus a back-lit term. Fish flesh is thin and translucent
    // near the edges; without this the silhouette reads as cut from card.
    float wrap = max(0.0, (dot(N, L) + 0.45) / 1.45);
    float back = pow(max(0.0, dot(V, -L)), 4.0);
    float3 sss = float3(0.95, 0.42, 0.34) * (wrap * 0.30 + back * 0.55);
    float thin = 1.0 - smoothstep(0.0, 0.55, NdotV);   // grazing angles are thin
    colour += sss * u.lightColour * thin * 0.8;

    colour *= transmittance(tankAbsorption(u), depthBelow * 0.5);

    return float4(colour * u.exposure, 1.0);
}

/// Fins.
///
/// A fin is a membrane a tenth of a millimetre thick stretched between rays about
/// three times that. Almost all of what it looks like is transmission, not
/// reflection: it glows when the light is behind it, and the rays show through as
/// darker struts. Shading it as an opaque surface with a colour map is what makes
/// most rendered fish look like toys.
fragment float4 finFragment(
    SceneInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    constant ObjectUniforms &o [[buffer(BufferIndexObjectUniforms)]],
    texture2d<float> caustics [[texture(TextureIndexCaustics)]]
) {
    constexpr sampler linearSampler(mag_filter::linear, min_filter::linear,
                                    address::clamp_to_edge);

    float3 N = normalize(in.normal);
    float3 V = normalize(in.view);
    float3 L = normalize(u.lightDirection);

    // A fin has no front and no back — it is a sheet — so flip the normal to
    // whichever side faces us before doing any lighting.
    if (dot(N, V) < 0.0) N = -N;

    float NdotV = max(dot(N, V), 1e-4);
    float NdotL = abs(dot(N, L));

    float across = in.uv.x;      // 0 to 1 across the rays
    float along = in.extra.x;    // 0 at the body, 1 at the trailing edge
    float thicknessMm = in.extra.y;

    // --- Rays ---
    //
    // The bony struts, running out from the body and branching towards the edge
    // as real ones do.
    float rayCoord = across * 9.0;
    float rayPhase = fract(rayCoord * (1.0 + step(0.55, along)));
    float ray = 1.0 - smoothstep(0.06, 0.30, abs(rayPhase - 0.5));

    // --- Transmission ---
    //
    // Beer-Lambert through the membrane. It is thin enough that most light gets
    // through, and the rays are the parts that stop it.
    float thickness = thicknessMm * (1.0 + ray * 2.2);
    float sigma = 2.2;   // per millimetre
    float through = exp(-sigma * thickness / max(0.15, NdotV));
    // Strongest when looking towards the light through the fin.
    float backlight = pow(max(0.0, dot(V, -L)), 3.0);

    // --- Colour ---
    //
    // Betta fin membrane is a saturated wash that deepens towards the edge, with
    // the iridescent sheen concentrated near the body where the scales reach onto
    // the fin base.
    float3 tint = o.baseColour * (0.55 + 0.45 * smoothstep(0.0, 0.8, along));
    float3 iridescence = thinFilm(NdotV,
                                  u.filmThicknessNm * 0.8 + 60.0 * sin(across * 18.0 + u.time * 0.03),
                                  u.filmIOR, u.baseIOR);
    float sheen = (1.0 - smoothstep(0.05, 0.5, along)) * 0.5;

    float caustic = caustics.sample(linearSampler, causticUV(in.worldPos, u)).r;
    float depthBelow = max(0.0, u.waterY - in.worldPos.y);
    caustic *= exp(-depthBelow * 1.5);

    float3 lit = u.lightColour * (1.0 + caustic * 2.0);
    float3 colour = tint * (NdotL * lit * 0.55 + u.ambient);
    colour += tint * through * (backlight * 2.6 + 0.35) * lit;
    colour += iridescence * sheen * (lit * 0.4 + u.ambient);
    colour *= 1.0 - ray * 0.35;

    colour *= transmittance(tankAbsorption(u), depthBelow * 0.5);

    // A fin is genuinely see-through, and how much depends on the angle and on
    // whether we are looking at membrane or at a ray.
    float alpha = saturate(0.30 + 0.55 * (1.0 - through) + ray * 0.35);
    alpha *= mix(1.0, 0.75, smoothstep(0.5, 1.0, along));

    return float4(colour * u.exposure, alpha);
}

/// Substrate, walls, plants. `extra.x` selects which.
fragment float4 tankFragment(
    SceneInOut in [[stage_in]],
    constant FrameUniforms &u [[buffer(BufferIndexFrameUniforms)]],
    texture2d<float> caustics [[texture(TextureIndexCaustics)]]
) {
    constexpr sampler linearSampler(mag_filter::linear, min_filter::linear,
                                    address::clamp_to_edge);

    float3 N = normalize(in.normal);
    float3 V = normalize(in.view);
    float3 L = normalize(u.lightDirection);
    float kind = in.extra.x;

    float3 albedo;
    float roughness;

    if (kind < 0.5) {
        // Sand: individual grains at two scales, so it does not read as one
        // texture frequency, and slightly warm.
        float grain = noise2(in.uv * 420.0) * 0.5 + noise2(in.uv * 1400.0) * 0.5;
        albedo = mix(float3(0.20, 0.17, 0.14), float3(0.42, 0.37, 0.30), grain);
        // A scattering of darker grains, which is what makes real sand read as
        // granular rather than as noise.
        float dark = step(0.86, noise2(in.uv * 900.0 + 13.0));
        albedo *= 1.0 - dark * 0.45;
        roughness = 0.9;
    } else if (kind < 1.5) {
        // Glass seen from inside, and the darkness beyond it.
        albedo = float3(0.04, 0.055, 0.06);
        roughness = 0.25;
    } else {
        // Plant leaf: translucent, with veins.
        float vein = smoothstep(0.02, 0.0, abs(fract(in.uv.x * 5.0) - 0.5) - 0.44);
        albedo = mix(float3(0.055, 0.16, 0.055), float3(0.10, 0.26, 0.09), in.uv.y);
        albedo = mix(albedo, albedo * 1.5, vein);
        roughness = 0.55;
    }

    float NdotL = max(dot(N, L), 0.0);

    float caustic = caustics.sample(linearSampler, causticUV(in.worldPos, u)).r;
    float depthBelow = max(0.0, u.waterY - in.worldPos.y);
    caustic *= exp(-depthBelow * 1.2) * smoothstep(-0.2, 0.5, N.y);

    float3 lit = u.lightColour * (NdotL + caustic * 2.6);
    float3 colour = albedo * (lit + u.ambient);

    // Leaves are thin enough to glow when the light is behind them.
    if (kind > 1.5) {
        float back = pow(max(0.0, dot(V, -L)), 2.5);
        colour += float3(0.10, 0.30, 0.08) * back * u.lightColour * 1.4;
    }

    float3 H = normalize(V + L);
    float D = distributionGGX(max(dot(N, H), 0.0), roughness);
    colour += u.lightColour * D * 0.04 * NdotL;

    colour *= transmittance(tankAbsorption(u), depthBelow);

    return float4(colour * u.exposure, 1.0);
}
