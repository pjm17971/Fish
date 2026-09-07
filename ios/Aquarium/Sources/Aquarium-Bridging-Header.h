//
//  Makes the shader-shared types visible to Swift.
//
//  `ShaderTypes.h` declares the uniform structures and the buffer/texture slot
//  numbers once, so that the Swift side and the Metal side cannot drift apart.
//  Swift reaches them through this bridging header; the Metal shaders include
//  the same file directly.
//

#import "Shaders/ShaderTypes.h"
