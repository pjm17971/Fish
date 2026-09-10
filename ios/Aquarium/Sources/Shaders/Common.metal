#include <metal_stdlib>
#include "ShaderTypes.h"
#include "Common.h"

using namespace metal;

// Deliberately empty beyond the header.
//
// Metal compiles each .metal file as its own translation unit and does not link
// between them, so anything shared has to live in a header that each file
// includes. This file exists so the shared code has an obvious home and so the
// build has something to point at if the header goes missing.
