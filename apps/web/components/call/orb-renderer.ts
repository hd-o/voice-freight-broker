const vertexSource = `
    attribute vec2 aPosition;
    void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
  `;

const fragmentSource = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uFlow;

    // Half-width of the cyan-to-cream blend, in orb-radius units.
    // Increase for a more diffuse cloud boundary.
    const float CLOUD_SOFTNESS = 0.38;
    // Gentle local circulation keeps the clouds from forming long ribbons.
    const float CURL_STRENGTH = 0.30;

    // Continuous value noise; all hash operations stay in a small range.
    float calculateHash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }
    float calculateNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      // Quintic interpolation keeps first and second derivatives continuous.
      f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      return mix(mix(calculateHash(i), calculateHash(i + vec2(1.0, 0.0)), f.x),
                 mix(calculateHash(i + vec2(0.0, 1.0)), calculateHash(i + 1.0), f.x), f.y);
    }
    // Three broad noise layers; higher frequencies fade out quickly.
    float calculateLayers(vec2 p) {
      float value = 0.0, amplitude = 0.5, weight = 0.0;
      mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
      for (int i = 0; i < 3; i++) {
        value += amplitude * calculateNoise(p);
        weight += amplitude;
        p = turn * p * 1.9 + vec2(17.1, 9.2);
        amplitude *= 0.35;
      }
      // Preserve a 0..1 range when changing the number of noise layers.
      return value / weight;
    }

    // Gentle eddies plus a broad cross-current carry the drifting vapor.
    // Each term has zero divergence, so the flow curls and shears locally.
    vec2 calculateVelocity(vec2 p, float t) {
      vec2 a = p - vec2(0.42 * cos(t * 0.41), 0.32 * sin(t * 0.37));
      vec2 b = p - vec2(-0.46 * cos(t * 0.29 + 0.7),
                        -0.34 * sin(t * 0.43 + 1.1));
      vec2 eddies = 2.1 * vec2(-a.y, a.x) * exp(-2.2 * dot(a, a))
                  + 1.7 * vec2(b.y, -b.x) * exp(-1.8 * dot(b, b));
      vec2 current = 0.18 * vec2(sin(p.y * 2.3 + t * 0.8),
                                 cos(p.x * 2.1 - t * 0.65));
      return CURL_STRENGTH * eddies + current;
    }

    vec2 advect(vec2 p, float t) {
      // Trace the material coordinates backward through the flow. Applying
      // this to the entire color field carries the cloud boundary with it.
      // This is procedural advection, not a pressure-solving fluid simulation.
      float stepSize = (0.18 + 0.45 * uFlow) / 5.0;
      for (int i = 0; i < 5; i++) {
        vec2 midpoint = p - 0.5 * stepSize * calculateVelocity(p, t);
        p -= stepSize * calculateVelocity(midpoint, t - 0.5 * stepSize);
        t -= stepSize;
      }
      return p;
    }

    void main() {
      // Aspect-correct coordinates, centered in the canvas; y points upward.
      float size = min(uResolution.x, uResolution.y);
      vec2 p = (2.0 * gl_FragCoord.xy - uResolution) / size;
      float radius = 0.84;
      p /= radius;
      float r = length(p);
      float aa = 2.0 / (size * radius);
      float alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
      if (alpha <= 0.0) { gl_FragColor = vec4(0.0); return; }

      // A sphere-like depth coordinate bends the cloud texture near the rim.
      float z = sqrt(max(0.0, 1.0 - dot(p, p)));
      vec2 material = advect(p, uTime);
      vec2 q = material * 1.10 + vec2(0.12, -0.20) * z;
      // Texture transport supplies visible motion without deep contour folds.
      vec2 drift = vec2(uTime * 0.14, -uTime * 0.10);
      vec2 warp = vec2(calculateLayers(q + drift),
                       calculateLayers(q + vec2(4.8, 1.7) - drift * 0.7)) - 0.5;
      float cloud = calculateLayers(q * 1.75 + 0.65 * warp + drift);
      float wisps = calculateLayers(q * vec2(2.8, 2.0) - drift * 0.65 + vec2(7.3, 2.8));
      // A gently deformed base and independently drifting density layers.
      float height = mix(p.y, material.y, 0.55);
      float field = height + (cloud - 0.5) * 0.60
                           + 0.035 * sin(material.x * 2.4 + uTime * 0.32);

      vec3 blue  = vec3(0.015, 0.46, 1.00);
      vec3 cyan  = vec3(0.30, 0.78, 0.96);
      vec3 cream = vec3(1.00, 0.995, 0.93);
      vec3 ice   = vec3(0.83, 0.96, 1.00);

      vec3 color = mix(blue, cyan, smoothstep(-0.55, 0.55, field));
      color = mix(color, cream,
                  smoothstep(0.42 - CLOUD_SOFTNESS, 0.42 + CLOUD_SOFTNESS, field));
      // A translucent second layer breaks up the single continuous boundary.
      float haze = 0.18 * smoothstep(0.38, 0.72, wisps)
                       * (1.0 - smoothstep(0.10, 0.90, abs(field - 0.05)));
      color = mix(color, mix(cyan, ice, 0.4), haze);
      color = mix(color, ice, smoothstep(0.78, 1.02, p.y) * 0.75);
      // Very mild edge shading: keep the flat, luminous appearance.
      color *= 0.98 + 0.02 * z;
      gl_FragColor = vec4(color * alpha, alpha);
    }
  `;

/** Procedural cloud renderer adapted from the supplied voice-orb.html reference. */

export function createOrbRenderer(canvas: HTMLCanvasElement) {
  const canvasContext = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });

  if (!canvasContext) {
    return undefined;
  }

  const context = canvasContext;
  const program = context.createProgram();
  const buffer = context.createBuffer();
  const shaders: WebGLShader[] = [];

  if (!program || !buffer) {
    if (program) context.deleteProgram(program);
    if (buffer) context.deleteBuffer(buffer);

    return undefined;
  }

  function compileShader(type: number, source: string) {
    const shader = context.createShader(type);

    if (!shader) {
      throw new Error("Shader unavailable");
    }

    shaders.push(shader);
    context.shaderSource(shader, source);
    context.compileShader(shader);

    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      throw new Error("Shader compilation failed");
    }

    return shader;
  }

  try {
    context.attachShader(
      program,
      compileShader(context.VERTEX_SHADER, vertexSource),
    );
    context.attachShader(
      program,
      compileShader(context.FRAGMENT_SHADER, fragmentSource),
    );
    context.linkProgram(program);

    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      throw new Error("Shader link failed");
    }
  } catch {
    shaders.forEach((shader) => context.deleteShader(shader));
    context.deleteBuffer(buffer);
    context.deleteProgram(program);

    return undefined;
  }

  shaders.forEach((shader) => context.deleteShader(shader));
  context.useProgram(program);
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    context.STATIC_DRAW,
  );

  const position = context.getAttribLocation(program, "aPosition");
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

  const resolution = context.getUniformLocation(program, "uResolution");
  const clock = context.getUniformLocation(program, "uTime");
  const flow = context.getUniformLocation(program, "uFlow");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let frame = 0;
  let previous = 0;
  let elapsed = 0;
  let loss = false;
  let disposal = false;

  function drawFrame() {
    if (loss || disposal) {
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.min(560, Math.round(bounds.width * scale)));
    const height = Math.max(
      1,
      Math.min(560, Math.round(bounds.height * scale)),
    );

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.viewport(0, 0, width, height);
    context.uniform2f(resolution, width, height);
    context.uniform1f(clock, elapsed);
    context.uniform1f(flow, 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
    canvas.style.opacity = "1";
  }

  function advanceFrame(timestamp: number) {
    frame = 0;

    if (motion.matches || document.hidden || loss || disposal) {
      return;
    }

    elapsed += previous
      ? Math.min((timestamp - previous) / 1000, 0.05) * 0.18
      : 0;
    previous = timestamp;
    drawFrame();
    frame = requestAnimationFrame(advanceFrame);
  }

  function scheduleFrame() {
    cancelAnimationFrame(frame);
    previous = 0;

    if (!motion.matches && !document.hidden && !loss && !disposal) {
      frame = requestAnimationFrame(advanceFrame);
    } else if (!document.hidden) {
      drawFrame();
    }
  }

  function handleContextLoss(event: Event) {
    event.preventDefault();
    loss = true;
    cancelAnimationFrame(frame);
    canvas.style.opacity = "0";
  }

  const observer = new ResizeObserver(drawFrame);
  observer.observe(canvas);
  motion.addEventListener("change", scheduleFrame);
  document.addEventListener("visibilitychange", scheduleFrame);
  canvas.addEventListener("webglcontextlost", handleContextLoss);
  drawFrame();
  scheduleFrame();

  return function destroyOrb() {
    disposal = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    motion.removeEventListener("change", scheduleFrame);
    document.removeEventListener("visibilitychange", scheduleFrame);
    canvas.removeEventListener("webglcontextlost", handleContextLoss);
    context.deleteBuffer(buffer);
    context.deleteProgram(program);
    canvas.style.opacity = "0";
  };
}
