/**
 * heatmap-sksl — Paper's Heatmap fragment shader, ported from GLSL ES 3.00 to
 * SkSL for `Skia.RuntimeEffect`.
 *
 * Source: `@paper-design/shaders` 0.0.76, `dist/shaders/heatmap.js`
 * (`heatmapFragmentShader`). Every constant in `shadowShape` and `main` is
 * byte-identical to Paper. What changed, and why:
 *  - `sampler2D` becomes `uniform shader`; SkSL samples in pixel coordinates,
 *    so every lookup multiplies by `u_imageSize`. `textureSize` is that uniform.
 *  - `textureGrad`, `dFdx`, `dFdy` do not exist in SkSL. The texture has no
 *    mipmaps, so a plain `.eval` reads the same texel.
 *  - Paper's `u_colors[10]` loop is unrolled to the two colors the design uses
 *    (`u_color0`, `u_color1`): `outerShape = clamp(heat*2, 0, 1)` and
 *    `gradient = mix(c0, c1, clamp(heat*2 - 1, 0, 1))`, which is what the loop
 *    computes for `u_colorsCount == 2`.
 *  - `v_imageUV` is derived from the fragment position and `u_scale`.
 *  - The output color is clamped to `[0, opacity]`. Paper's grain can push a
 *    fully transparent pixel to a non-zero color, which is an invalid
 *    premultiplied value in Skia and shows as a faint haze on a transparent
 *    background.
 *
 * Texture: `assets/brand/kortix-heatmap.png` (see `heatmap-bake.ts`): three gray
 * planes side by side, `u_imageSize` wide in total. Plane 0 = contour, 1 = big
 * blur, 2 = inner blur. Paper reads them as the R, G, B channels of one image;
 * here they are separate planes so that Skia's color management cannot mix
 * them. The symbol's box is the central 1/1.75 of each plane, hence the
 * `0.5714285714285714` in `main`.
 *
 * Pure data only: `bun test` cannot load native modules.
 */

export const HEATMAP_SKSL = `
uniform shader u_image;
uniform float2 u_resolution;
uniform float2 u_imageSize;
uniform float u_time;
uniform float u_scale;

uniform half4 u_color0;
uniform half4 u_color1;
uniform half4 u_colorBack;

uniform float u_angle;
uniform float u_noise;
uniform float u_innerGlow;
uniform float u_outerGlow;
uniform float u_contour;

const float TWO_PI = 6.28318530718;
const float PI = 3.14159265358979323846;

float getImgFrame(float2 uv, float th) {
  float frame = 1.;
  frame *= smoothstep(0., th, uv.y);
  frame *= 1. - smoothstep(1. - th, 1., uv.y);
  frame *= smoothstep(0., th, uv.x);
  frame *= 1. - smoothstep(1. - th, 1., uv.x);
  return frame;
}

float circle(float2 uv, float2 c, float2 r) {
  return 1. - smoothstep(r[0], r[1], length(uv - c));
}

float lst(float edge0, float edge1, float x) {
  return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
}

float sst(float edge0, float edge1, float x) {
  return smoothstep(edge0, edge1, x);
}

float shadowShape(float2 uv, float t, float contour) {
  float2 scaledUV = uv;

  // base shape tranjectory
  float posY = mix(-1., 2., t);

  // scaleX when it's moving down
  scaledUV.y -= .5;
  float mainCircleScale = sst(0., .8, posY) * lst(1.4, .9, posY);
  scaledUV *= float2(1., 1. + 1.5 * mainCircleScale);
  scaledUV.y += .5;

  // base shape
  float innerR = .4;
  float outerR = 1. - .3 * (sst(.1, .2, t) * (1. - sst(.2, .5, t)));
  float s = circle(scaledUV, float2(.5, posY - .2), float2(innerR, outerR));
  float shapeSizing = sst(.2, .3, t) * sst(.6, .3, t);
  s = pow(s, 1.4);
  s *= 1.2;

  // flat gradient to take over the shadow shape
  float topFlattener = 0.;
  {
    float pos = posY - uv.y;
    float edge = 1.2;
    topFlattener = lst(-.4, 0., pos) * (1. - sst(.0, edge, pos));
    topFlattener = pow(topFlattener, 3.);
    float topFlattenerMixer = (1. - sst(.0, .3, pos));
    s = mix(topFlattener, s, topFlattenerMixer);
  }

  // apple right circle
  {
    float visibility = sst(.6, .7, t) * (1. - sst(.8, .9, t));
    float angle = -2. - t * TWO_PI;
    float rightCircle = circle(uv, float2(.95 - .2 * cos(angle), .4 - .1 * sin(angle)), float2(.15, .3));
    rightCircle *= visibility;
    s = mix(s, 0., rightCircle);
  }

  // apple top circle
  {
    float topCircle = circle(uv, float2(.5, .19), float2(.05, .25));
    topCircle += 2. * contour * circle(uv, float2(.5, .19), float2(.2, .5));
    float visibility = .55 * sst(.2, .3, t) * (1. - sst(.3, .45, t));
    topCircle *= visibility;
    s = mix(s, 0., topCircle);
  }

  float leafMask = circle(uv, float2(.53, .13), float2(.08, .19));
  leafMask = mix(leafMask, 0., 1. - sst(.4, .54, uv.x));
  leafMask = mix(0., leafMask, sst(.0, .2, uv.y));
  leafMask *= (sst(.5, 1.1, posY) * sst(1.5, 1.3, posY));
  s += leafMask;

  // apple bottom circle
  {
    float visibility = sst(.0, .4, t) * (1. - sst(.6, .8, t));
    s = mix(s, 0., visibility * circle(uv, float2(.52, .92), float2(.09, .25)));
  }

  // random balls that are invisible if apple logo is selected
  {
    float pos = sst(.0, .6, t) * (1. - sst(.6, 1., t));
    s = mix(s, .5, circle(uv, float2(.0, 1.2 - .5 * pos), float2(.1, .3)));
    s = mix(s, .0, circle(uv, float2(1., .5 + .5 * pos), float2(.1, .3)));

    s = mix(s, 1., circle(uv, float2(.95, .2 + .2 * sst(.3, .4, t) * sst(.7, .5, t)), float2(.07, .22)));
    s = mix(s, 1., circle(uv, float2(.95, .2 + .2 * sst(.3, .4, t) * (1. - sst(.5, .7, t))), float2(.07, .22)));
    s /= max(1e-4, sst(1., .85, uv.y));
  }

  s = clamp(s, 0., 1.);
  return s;
}

// The size Paper's blur radius is measured in: the baked texture before it was
// downscaled to the plane size.
const float BAKE_SIZE = 1750.;

// One plane of the texture at uv in [0,1]. The uv is clamped half a texel inside
// the plane, so linear filtering never reads the neighbouring plane.
float samplePlane(float plane, float2 uv) {
  float2 size = float2(u_imageSize.x / 3., u_imageSize.y);
  float2 px = clamp(uv * size, float2(.5), size - float2(.5));
  return u_image.eval(float2(px.x + plane * size.x, px.y)).r;
}

float blurEdge3x3(float2 uv, float radius, float centerSample) {
  float2 r = float2(radius / BAKE_SIZE);

  float sum = 4.0 * centerSample;

  sum += 2.0 * samplePlane(1., uv + float2(0.0, -r.y));
  sum += 2.0 * samplePlane(1., uv + float2(0.0, r.y));
  sum += 2.0 * samplePlane(1., uv + float2(-r.x, 0.0));
  sum += 2.0 * samplePlane(1., uv + float2(r.x, 0.0));

  sum += samplePlane(1., uv + float2(-r.x, -r.y));
  sum += samplePlane(1., uv + float2(r.x, -r.y));
  sum += samplePlane(1., uv + float2(-r.x, r.y));
  sum += samplePlane(1., uv + float2(r.x, r.y));

  return sum / 16.0;
}

half4 main(float2 fragCoord) {
  float2 canvasUV = fragCoord / u_resolution;

  // Paper's objectUV, with y flipped: only the grain uses it.
  float2 uv = canvasUV;
  uv.y = 1. - uv.y;

  // v_imageUV: the symbol box spans [0,1]; u_scale < 1 leaves a margin that
  // shows the halo baked into the texture's padding.
  float2 imgUV = (canvasUV - .5) / u_scale + .5;
  imgUV -= .5;
  imgUV *= 0.5714285714285714;
  imgUV += .5;
  float imgSoftFrame = getImgFrame(imgUV, .03);

  float3 img = float3(samplePlane(0., imgUV), samplePlane(1., imgUV), samplePlane(2., imgUV));

  float t = .1 * u_time;
  t -= .3;

  float tCopy = t + 1. / 3.;
  float tCopy2 = t + 2. / 3.;

  t = mod(t, 1.);
  tCopy = mod(tCopy, 1.);
  tCopy2 = mod(tCopy2, 1.);

  float2 animationUV = imgUV - float2(.5);
  float angle = -u_angle * PI / 180.;
  float cosA = cos(angle);
  float sinA = sin(angle);
  animationUV = float2(
    animationUV.x * cosA - animationUV.y * sinA,
    animationUV.x * sinA + animationUV.y * cosA
  ) + float2(.5);

  float shape = img.r;

  float bigBlur = blurEdge3x3(imgUV, 8., img.g);

  float outerBlur = 1. - mix(1., bigBlur, shape);
  float innerBlur = mix(bigBlur, 0., shape);
  float contour = mix(img.b, 0., shape);

  outerBlur *= imgSoftFrame;

  float shadow = shadowShape(animationUV, t, innerBlur);
  float shadowCopy = shadowShape(animationUV, tCopy, innerBlur);
  float shadowCopy2 = shadowShape(animationUV, tCopy2, innerBlur);

  float inner = .8 + .8 * innerBlur;
  inner = mix(inner, 0., shadow);
  inner = mix(inner, 0., shadowCopy);
  inner = mix(inner, 0., shadowCopy2);

  inner *= mix(0., 2., u_innerGlow);

  inner += (u_contour * 2.) * contour;
  inner = min(1., inner);
  inner *= (1. - shape);

  float outer = 0.;
  {
    t *= 3.;
    t = mod(t - .1, 1.);

    outer = .9 * pow(outerBlur, .8);
    float y = mod(animationUV.y - t, 1.);
    float animatedMask = sst(.3, .65, y) * (1. - sst(.65, 1., y));
    animatedMask = .5 + animatedMask;
    outer *= animatedMask;
    outer *= mix(0., 5., pow(u_outerGlow, 2.));
    outer *= imgSoftFrame;
  }

  inner = pow(inner, 1.2);
  float heat = clamp(inner + outer, 0., 1.);

  heat += (.005 + .35 * u_noise) * (fract(sin(dot(uv, float2(12.9898, 78.233))) * 43758.5453123) - .5);

  float mixer = heat * 2.;
  float outerShape = clamp(mixer, 0., 1.);
  float4 c0 = float4(u_color0);
  float4 c1 = float4(u_color1);
  c0.rgb *= c0.a;
  c1.rgb *= c1.a;
  float4 gradient = mix(c0, c1, clamp(mixer - 1., 0., 1.));

  float3 color = gradient.rgb * outerShape;
  float opacity = gradient.a * outerShape;

  float3 bgColor = float3(u_colorBack.rgb) * u_colorBack.a;
  color = color + bgColor * (1.0 - opacity);
  opacity = opacity + u_colorBack.a * (1.0 - opacity);

  color += .02 * (fract(sin(dot(uv + 1., float2(12.9898, 78.233))) * 43758.5453123) - .5);
  color = clamp(color, 0., opacity);

  return half4(half3(color), half(opacity));
}
`;

/** Paper's own values for the design Jay shared (Heatmap, 2026-09-21). */
export const PAPER_HEATMAP_PARAMS = {
  speed: 0.64,
  contour: 1,
  angle: 51,
  noise: 0,
  innerGlow: 0.89,
  outerGlow: 0,
  scale: 0.9,
} as const;

/**
 * Paper's exported frame (643565.02 ms) as shader time, `frame * 0.001 * speed`.
 * A still phone shows exactly the design Jay shared, and Reduce Motion freezes
 * on it.
 */
export const HEATMAP_REST_TIME = 643565.019999678 * 0.001 * PAPER_HEATMAP_PARAMS.speed;

/** Shader seconds the highlight travels from rest to a fully moved phone. */
export const HEATMAP_SWEEP_SECONDS = 2.5;

type Vec2 = [number, number];
type Rgba = [number, number, number, number];

export type HeatmapUniforms = {
  u_resolution: Vec2;
  u_imageSize: Vec2;
  u_time: number;
  u_scale: number;
  u_angle: number;
  u_contour: number;
  u_innerGlow: number;
  u_outerGlow: number;
  u_noise: number;
  u_color0: Rgba;
  u_color1: Rgba;
  u_colorBack: Rgba;
};
