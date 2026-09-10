/**
 * A very small WebGL2 helper layer.
 *
 * Deliberately thin — enough to stop the renderer being a wall of boilerplate,
 * not so much that it becomes a framework in its own right. Everything here is
 * the kind of thing that is worth writing once and never thinking about again.
 */

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    depth: true,
    // The water and glass passes read what was drawn behind them, so the
    // drawing buffer has to survive being sampled.
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  // Float render targets are needed for the caustic accumulation pass.
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, name: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    // Number the lines: a GLSL error that says "line 84" is useless without them.
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
      .join('\n');
    throw new Error(`Failed to compile ${name}:\n${log}\n\n${numbered}`);
  }
  return shader;
}

export interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attribs: Record<string, number>;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  name: string,
): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${name} vertex shader`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${name} fragment shader`);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Failed to link ${name}: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  // Reflect everything once, so draw calls never do a string lookup in the API.
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < uniformCount; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const base = info.name.replace(/\[0\]$/, '');
    uniforms[base] = gl.getUniformLocation(program, info.name);
  }

  const attribs: Record<string, number> = {};
  const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < attribCount; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (!info) continue;
    attribs[info.name] = gl.getAttribLocation(program, info.name);
  }

  return { program, uniforms, attribs };
}

export interface AttributeSpec {
  name: string;
  size: number;
  /** Byte offset into the interleaved buffer. */
  offset: number;
  type?: number;
  normalized?: boolean;
}

export class Mesh {
  readonly vao: WebGLVertexArrayObject;
  readonly vbo: WebGLBuffer;
  readonly ibo: WebGLBuffer | null;
  indexCount = 0;
  vertexCount = 0;
  readonly stride: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    program: Program,
    attributes: AttributeSpec[],
    stride: number,
    dynamic = false,
  ) {
    this.stride = stride;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (const a of attributes) {
      const loc = program.attribs[a.name];
      if (loc === undefined || loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(
        loc,
        a.size,
        a.type ?? gl.FLOAT,
        a.normalized ?? false,
        stride,
        a.offset,
      );
    }
    gl.bindVertexArray(null);
    void dynamic;
  }

  setVertices(data: Float32Array, dynamic = false): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    this.vertexCount = data.length / (this.stride / 4);
  }

  /** Update vertex data in place, for meshes rebuilt every frame. */
  updateVertices(data: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  setIndices(data: Uint16Array | Uint32Array): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = data.length;
    this.indexType = data instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  indexType = 0x1403; // UNSIGNED_SHORT

  draw(mode?: number): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.indexCount > 0) {
      gl.drawElements(mode ?? gl.TRIANGLES, this.indexCount, this.indexType, 0);
    } else {
      gl.drawArrays(mode ?? gl.TRIANGLES, 0, this.vertexCount);
    }
    gl.bindVertexArray(null);
  }
}

export interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  filter = gl.LINEAR,
): RenderTarget {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Render target is incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, width, height };
}

/** A texture built from a function of (u, v), for procedural detail. */
export function createProceduralTexture(
  gl: WebGL2RenderingContext,
  size: number,
  fn: (u: number, v: number) => [number, number, number, number],
): WebGLTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}
