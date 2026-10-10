// Final full-screen pass on the graded, display-encoded image (every quality), straight to the screen:
//  - FXAA (presets without MSAA), contrast-adaptive sharpening
//  - fake tilt-shift depth of field (blurs the top / bottom of the screen when zoomed out)
//  - chromatic aberration towards the corners
//  - vignette, extra corner darkening and a very light film grain
uniform sampler2D tColor;
uniform vec2 texel;          // 1 / render size
uniform float fxaaOn;
uniform float sharpen;       // 0 = off
uniform float tilt;          // 0 = off (already scaled by zoom)
uniform float chroma;        // 0 = off
uniform float vignette;
uniform float corner;
uniform float grain;
uniform float time;

varying vec2 vUv;

vec3 tap(vec2 uv) {
  return texture2D(tColor, uv).rgb;
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// Compact FXAA (Lottes): blur along the local edge direction, keeping the result inside the neighbourhood's luma range.
vec3 fxaa(vec2 uv, vec3 rgbM) {
  vec3 rgbNW = tap(uv + vec2(-1.0, -1.0) * texel);
  vec3 rgbNE = tap(uv + vec2(1.0, -1.0) * texel);
  vec3 rgbSW = tap(uv + vec2(-1.0, 1.0) * texel);
  vec3 rgbSE = tap(uv + vec2(1.0, 1.0) * texel);
  float lM = luma(rgbM), lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.03, lMax * 0.125)) return rgbM; // flat: nothing to smooth
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * texel;
  vec3 a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  float lB = luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}

void main() {
  vec2 vc = vUv - 0.5;
  float r2 = dot(vc, vc) * 2.0; // 0 centre .. 1 corner
  vec3 col = tap(vUv);
  if (fxaaOn > 0.5) col = fxaa(vUv, col);

  // Chromatic aberration: red and blue shift apart radially, growing towards the corners (under 1.5 px at the corner).
  // The shifted taps are anti-aliased like the centre one: without MSAA a thin aliased line (road paint far away) sampled
  // at a slightly different place per channel turns pink / green.
  if (chroma > 0.0 && r2 > 0.3) {
    vec2 off = vc * (r2 - 0.3) * chroma * 2.5 * texel * 2.5;
    vec2 uvR = vUv + off, uvB = vUv - off;
    vec3 cr = tap(uvR), cb = tap(uvB);
    if (fxaaOn > 0.5) {
      cr = fxaa(uvR, cr);
      cb = fxaa(uvB, cb);
    }
    col.r = cr.r;
    col.b = cb.b;
  }

  // Tilt-shift: out of focus away from the horizontal band through the screen centre.
  float blur = tilt * smoothstep(0.2, 0.5, abs(vc.y));
  if (blur > 0.01) {
    vec2 rad = texel * (1.0 + 3.0 * blur);
    vec3 sum = col;
    sum += tap(vUv + vec2(1.0, 0.0) * rad) + tap(vUv + vec2(-1.0, 0.0) * rad);
    sum += tap(vUv + vec2(0.0, 1.0) * rad) + tap(vUv + vec2(0.0, -1.0) * rad);
    sum += tap(vUv + vec2(0.7, 0.7) * rad * 1.8) + tap(vUv + vec2(-0.7, 0.7) * rad * 1.8);
    sum += tap(vUv + vec2(0.7, -0.7) * rad * 1.8) + tap(vUv + vec2(-0.7, -0.7) * rad * 1.8);
    col = mix(col, sum / 9.0, clamp(blur, 0.0, 0.85));
  }

  // Contrast-adaptive sharpening on the cross neighbourhood (weaker where out of focus).
  float sharp = sharpen * (1.0 - clamp(blur * 1.5, 0.0, 1.0));
  if (sharp > 0.0) {
    vec3 n = tap(vUv + vec2(0.0, -1.0) * texel), s = tap(vUv + vec2(0.0, 1.0) * texel);
    vec3 w = tap(vUv + vec2(-1.0, 0.0) * texel), e = tap(vUv + vec2(1.0, 0.0) * texel);
    // On luma only: sharpening each channel by its own amount shifts the hue along thin bright lines (road paint
    // against dark asphalt shows coloured fringes once MSAA no longer softens those edges).
    float lc = luma(col), ln = luma(n), ls = luma(s), lw = luma(w), le = luma(e);
    float mn = min(min(ln, ls), min(min(lw, le), lc));
    float mx = max(max(ln, ls), max(max(lw, le), lc));
    float amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-3), 0.0, 1.0));
    float k = -amp / mix(8.0, 5.0, sharp);
    float lSharp = clamp((lc + (ln + ls + lw + le) * k) / (1.0 + 4.0 * k), 0.0, 1.0);
    col = clamp(col * (lSharp / max(lc, 1e-3)), 0.0, 1.0);
  }

  // Vignette + corner darkening, as a multiplier on the linear light (so it is raised to 1/2.2 in the encoded image).
  float v = 1.0 - vignette * smoothstep(0.25, 0.85, r2);
  v *= 1.0 - corner * smoothstep(0.45, 1.0, r2 * r2);
  col *= pow(v, 1.0 / 2.2);
  float n = fract(sin(dot(gl_FragCoord.xy + time, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += n * grain * (0.4 + luma(col));

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0); // already display-encoded: no colour space conversion
}
