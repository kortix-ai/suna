/**
 * dithering-sksl — Paper's Dithering fragment shader, ported from GLSL ES 3.00
 * to SkSL for `Skia.RuntimeEffect`, and masked by the Kortix symbol.
 *
 * Source: `@paper-design/shaders` 0.0.81, `dist/shaders/dithering.js`
 * (`ditheringFragmentShader`). Every shape and the Bayer thresholds are
 * byte-identical to Paper. What changed, and why:
 *  - The pattern is masked by the symbol: the alpha plane of
 *    `assets/brand/kortix-liquid-metal.png` (see `liquid-metal-bake.ts`),
 *    sampled at the centre of each dither cell so the silhouette is made of
 *    the same cells as the pattern. Paper's shader has no mask.
 *  - Paper's sizing uniforms (`u_fit`, `u_worldWidth`, ...) are folded at their
 *    defaults (`fit: none`, `origin: .5`, no world size, no offset): the object
 *    box is the canvas's shorter side, the pattern box is the canvas.
 *  - `gl_FragCoord` is in device pixels with y up; SkSL's `fragCoord` is in
 *    points with y down. The y axis is flipped so the shapes read as in Paper,
 *    and `u_pxSize` is in points (Paper: `size * u_pixelRatio` device pixels).
 *  - The Bayer matrices are computed, not tabled: SkSL has no `int[]`
 *    constructors. `M(2n)[y][x] = 4 M(n)[y mod n][x mod n] + M(2)[y / n][x / n]`
 *    reproduces Paper's tables exactly.
 *  - `switch` is an if-chain.
 *
 * Pure data only: `bun test` cannot load native modules.
 */

export const DITHERING_SKSL = `
uniform shader u_image;
uniform float2 u_imageSize;
uniform float4 u_imageBox;
uniform float2 u_resolution;
uniform float u_time;

uniform float u_scale;
uniform float u_rotation;
uniform float u_pxSize;
uniform half4 u_colorBack;
uniform half4 u_colorFront;
uniform float u_shape;
uniform float u_type;

const float PI = 3.14159265358979323846;
const float TWO_PI = 6.28318530718;

float3 permute(float3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1;
  i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  float3 p = permute(permute(i.y + float3(0.0, i1.y, 1.0))
    + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float hash11(float p) {
  p = fract(p * 0.3183099) + 0.1;
  p *= p + 19.19;
  return fract(p * p);
}

float hash21(float2 p) {
  p = fract(p * float2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float getSimplexNoise(float2 uv, float t) {
  float noise = .5 * snoise(uv - float2(0., .3 * t));
  noise += .5 * snoise(2. * uv + float2(0., .32 * t));

  return noise;
}

// Paper's bayer2x2 table: 0 2 / 3 1.
float bayer2(float2 p) {
  return (p.y < .5) ? ((p.x < .5) ? 0. : 2.) : ((p.x < .5) ? 3. : 1.);
}

// Paper's bayer4x4 and bayer8x8 tables, by the recursive definition.
float getBayerValue(float2 uv, float size) {
  float2 pos = floor(fract(uv / size) * size);
  float value = 0.;
  if (size < 3.) {
    value = bayer2(pos);
  } else if (size < 5.) {
    value = 4. * bayer2(mod(pos, 2.)) + bayer2(floor(pos / 2.));
  } else {
    float2 inner = mod(pos, 4.);
    value = 4. * (4. * bayer2(mod(inner, 2.)) + bayer2(floor(inner / 2.))) + bayer2(floor(pos / 4.));
  }
  return value / (size * size);
}

// The alpha plane of the texture at uv in [0,1], clamped half a texel inside
// the plane so linear filtering never reads the edge plane.
float sampleMask(float2 uv) {
  float2 size = float2(u_imageSize.x / 2., u_imageSize.y);
  float2 px = clamp(uv * size, float2(.5), size - float2(.5));
  float2 inside = step(float2(0.), uv) * (1. - step(float2(1.), uv));
  return u_image.eval(float2(px.x + size.x, px.y)).r * inside.x * inside.y;
}

half4 main(float2 fragCoord) {
  float t = .5 * u_time;

  // gl_FragCoord: y up.
  float2 glCoord = float2(fragCoord.x, u_resolution.y - fragCoord.y);

  float pxSize = u_pxSize;
  float2 pxSizeUV = glCoord - .5 * u_resolution;
  pxSizeUV /= pxSize;
  float2 canvasPixelizedUV = (floor(pxSizeUV) + .5) * pxSize;
  float2 normalizedUV = canvasPixelizedUV / u_resolution;

  float2 ditheringNoiseUV = canvasPixelizedUV;
  float2 shapeUV = normalizedUV;

  float r = u_rotation * PI / 180.;
  float2x2 graphicRotation = float2x2(cos(r), sin(r), -sin(r), cos(r));

  if (u_shape > 3.5) {
    // fit = none, no world size: the object box is the canvas's shorter side.
    float objectBox = min(u_resolution.x, u_resolution.y);
    float2 objectWorldScale = u_resolution.xy / objectBox;

    shapeUV *= objectWorldScale;
    shapeUV /= u_scale;
    shapeUV = graphicRotation * shapeUV;
  } else {
    // fit = none, no world size: the pattern box is the canvas.
    shapeUV *= u_resolution.xy;
    shapeUV /= u_scale;
    shapeUV = graphicRotation * shapeUV;
    shapeUV += .5;
  }

  float shape = 0.;
  if (u_shape < 1.5) {
    // Simplex noise
    shapeUV *= .001;

    shape = 0.5 + 0.5 * getSimplexNoise(shapeUV, t);
    shape = smoothstep(0.3, 0.9, shape);

  } else if (u_shape < 2.5) {
    // Warp
    shapeUV *= .003;

    for (float i = 1.0; i < 6.0; i++) {
      shapeUV.x += 0.6 / i * cos(i * 2.5 * shapeUV.y + t);
      shapeUV.y += 0.6 / i * cos(i * 1.5 * shapeUV.x + t);
    }

    shape = .15 / max(0.001, abs(sin(t - shapeUV.y - shapeUV.x)));
    shape = smoothstep(0.02, 1., shape);

  } else if (u_shape < 3.5) {
    // Dots
    shapeUV *= .05;

    float stripeIdx = floor(2. * shapeUV.x / TWO_PI);
    float rand = hash11(stripeIdx * 10.);
    rand = sign(rand - .5) * pow(.1 + abs(rand), .4);
    shape = sin(shapeUV.x) * cos(shapeUV.y - 5. * rand * t);
    shape = pow(abs(shape), 6.);

  } else if (u_shape < 4.5) {
    // Sine wave
    shapeUV *= 4.;

    float wave = cos(.5 * shapeUV.x - 2. * t) * sin(1.5 * shapeUV.x + t) * (.75 + .25 * cos(3. * t));
    shape = 1. - smoothstep(-1., 1., shapeUV.y + wave);

  } else if (u_shape < 5.5) {
    // Ripple

    float dist = length(shapeUV);
    float waves = sin(pow(dist, 1.7) * 7. - 3. * t) * .5 + .5;
    shape = waves;

  } else if (u_shape < 6.5) {
    // Swirl

    float l = length(shapeUV);
    float angle = 6. * atan(shapeUV.y, shapeUV.x) + 4. * t;
    float twist = 1.2;
    float offset = 1. / pow(max(l, 1e-6), twist) + angle / TWO_PI;
    float mid = smoothstep(0., 1., pow(l, twist));
    shape = mix(0., fract(offset), mid);

  } else {
    // Sphere
    shapeUV *= 2.;

    float d = 1. - pow(length(shapeUV), 2.);
    float3 pos = float3(shapeUV, sqrt(max(0., d)));
    float3 lightPos = normalize(float3(cos(1.5 * t), .8, sin(1.25 * t)));
    shape = .5 + .5 * dot(lightPos, pos);
    shape *= step(0., d);
  }

  float type = floor(u_type);
  float dithering = 0.0;
  if (type < 1.5) {
    dithering = step(hash21(ditheringNoiseUV), shape);
  } else if (type < 2.5) {
    dithering = getBayerValue(pxSizeUV, 2.);
  } else if (type < 3.5) {
    dithering = getBayerValue(pxSizeUV, 4.);
  } else {
    dithering = getBayerValue(pxSizeUV, 8.);
  }

  dithering -= .5;
  float res = step(.5, shape + dithering);

  // The symbol, cell by cell: the mask at the centre of this cell, y down.
  float2 cellCentre = float2(canvasPixelizedUV.x, -canvasPixelizedUV.y) + .5 * u_resolution;
  float2 maskUV = (cellCentre - u_imageBox.xy) / u_imageBox.zw;
  res *= step(.5, sampleMask(maskUV));

  float3 fgColor = float3(u_colorFront.rgb) * u_colorFront.a;
  float fgOpacity = u_colorFront.a;
  float3 bgColor = float3(u_colorBack.rgb) * u_colorBack.a;
  float bgOpacity = u_colorBack.a;

  float3 color = fgColor * res;
  float opacity = fgOpacity * res;

  color += bgColor * (1. - opacity);
  opacity += bgOpacity * (1. - opacity);

  return half4(half3(color), half(opacity));
}
`;

/** Paper's `DitheringShapes` and `DitheringTypes`. */
export const DITHERING_SHAPES = {
  simplex: 1,
  warp: 2,
  dots: 3,
  wave: 4,
  ripple: 5,
  swirl: 6,
  sphere: 7,
} as const;
export const DITHERING_TYPES = { random: 1, '2x2': 2, '4x4': 3, '8x8': 4 } as const;

/**
 * The dither design: Paper's default preset (a lit sphere, 4x4 Bayer, 2 px
 * cells), with the sphere scaled to cover the symbol's corners (its diameter is
 * the object box times `scale`; the symbol's half-diagonal is 0.65 of its
 * width) and the cells in points.
 */
export const DITHERING_PARAMS = {
  speed: 1,
  shape: DITHERING_SHAPES.sphere,
  type: DITHERING_TYPES['4x4'],
  size: 2,
  scale: 1.4,
  rotation: 0,
} as const;

/**
 * Shader time at rest: the light sits high and to the left, as a still page's
 * highlight. Reduce Motion freezes on it.
 */
export const DITHERING_REST_TIME = 5.2;

/**
 * Shader seconds the light travels from rest to a fully moved phone. The
 * light's azimuth is `1.5 * .5 * u_time`, so 4 s is about a third of a turn.
 */
export const DITHERING_SWEEP_SECONDS = 4;

type Vec2 = [number, number];
type Vec4 = [number, number, number, number];

export type DitheringUniforms = {
  u_imageSize: Vec2;
  u_imageBox: Vec4;
  u_resolution: Vec2;
  u_time: number;
  u_scale: number;
  u_rotation: number;
  u_pxSize: number;
  u_colorBack: Vec4;
  u_colorFront: Vec4;
  u_shape: number;
  u_type: number;
};
