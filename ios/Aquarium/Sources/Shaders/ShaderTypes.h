#ifndef ShaderTypes_h
#define ShaderTypes_h

#include <simd/simd.h>

// Types shared between Swift and Metal.
//
// Declared once here rather than twice, because a uniform buffer whose layouts
// disagree between the two does not fail to build — it silently reads the wrong
// bytes, and the result is a shader that behaves as though several unrelated
// numbers changed at once. Anything harder to debug is difficult to imagine.
//
// Metal packs structures to 16-byte alignment for anything containing a
// float4/matrix, so members are ordered largest-first and the padding is
// explicit.

#ifdef __METAL_VERSION__
#define NS_ENUM(_type, _name) enum _name : _type _name; enum _name : _type
typedef metal::int32_t EnumBackingType;
#else
#import <Foundation/Foundation.h>
typedef NSInteger EnumBackingType;
#endif

typedef NS_ENUM(EnumBackingType, BufferIndex) {
    BufferIndexVertices     = 0,
    BufferIndexFrameUniforms = 1,
    BufferIndexObjectUniforms = 2
};

typedef NS_ENUM(EnumBackingType, TextureIndex) {
    TextureIndexCameraY      = 0,
    TextureIndexCameraCbCr   = 1,
    TextureIndexCaustics     = 2,
    TextureIndexScene        = 3,
    TextureIndexDepth        = 4,
    TextureIndexHeightField  = 5
};

typedef NS_ENUM(EnumBackingType, VertexAttribute) {
    VertexAttributePosition = 0,
    VertexAttributeNormal   = 1,
    VertexAttributeUV       = 2,
    VertexAttributeExtra    = 3
};

/// One vertex of the body, fins, tank or water surface.
///
/// `extra` carries whatever the shader needs that is not geometry: for the body
/// it is (arc position along the fish, unused); for a fin, (span fraction,
/// membrane thickness in millimetres); for the tank, (surface kind, unused).
typedef struct {
    simd_float3 position;
    simd_float3 normal;
    simd_float2 uv;
    simd_float2 extra;
} SceneVertex;

/// Uniforms that change once per frame.
typedef struct {
    matrix_float4x4 viewProjection;
    matrix_float4x4 inverseViewProjection;
    /// Maps the camera image into the drawable's orientation and aspect.
    matrix_float3x3 cameraTransform;

    simd_float3 cameraPosition;
    float time;

    simd_float3 lightDirection;   // towards the light
    float exposure;

    simd_float3 lightColour;
    float scattering;

    simd_float3 ambient;
    float scatteringG;

    simd_float3 waterAbsorption;
    float tannin;

    simd_float3 tanninAbsorption;
    float waterY;

    simd_float2 causticsExtent;   // tank half-width, depth
    simd_float2 viewport;

    /// Thin-film parameters for the fish's scales.
    float filmThicknessNm;
    float filmIOR;
    float baseIOR;
    float mucusRoughness;

    /// Sensor noise measured from the passthrough frame, so the rendered content
    /// can be given the same amount. Clean CG over noisy video is the classic
    /// composite tell.
    float cameraGrain;
    float particleDensity;
    float glassIOR;
    float pad0;
} FrameUniforms;

/// Uniforms that change per draw call.
typedef struct {
    simd_float3 baseColour;
    float roughness;
    simd_float3 secondaryColour;
    float pad1;
} ObjectUniforms;

/// One caustic grid point, in normalised water-surface coordinates.
typedef struct {
    simd_float2 grid;
} CausticVertex;

#endif /* ShaderTypes_h */
