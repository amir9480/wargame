uniform sampler2D tGrass;
uniform sampler2D tSand;
uniform sampler2D tRock;
uniform sampler2D tSnow;
uniform sampler2D tDirt;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float waterLevel;
uniform float snowLine;
uniform float heightScale; // vertical scale of the mountains (1 = reference map)
uniform sampler2D tCover; // R: dirt amount, G: forest canopy (per grid cell)
uniform float mapSize;
uniform float gridSize;

varying vec3 vWorldPos;
varying vec3 vNormal;

#include ./chunks/fog.glsl;
// Texture detail (the fine tiling scale) fades out farther than other surface detail: the ground fills the view.
#define DETAIL_START 260.0
#define DETAIL_END 400.0
#include ./chunks/lod.glsl;

// Two scales blended to hide texture repetition; far away only the coarse one (one tap instead of two). Explicit
// gradients (taken outside any branch) keep mip selection right in the branches below.
vec3 sampleTex(sampler2D t, vec2 uv, vec2 dx, vec2 dy, float detail) {
  vec3 b = textureGrad(t, uv * 0.23 + vec2(0.37, 0.71), dx * 0.23, dy * 0.23).rgb;
  if (detail <= 0.0) return b;
  vec3 a = textureGrad(t, uv, dx, dy).rgb;
  return mix(b, mix(a, b, 0.4), detail);
}

// World position gradients (taken outside any branch), for the side projections of `cliffTex`.
vec3 pdx, pdy;

// Rock / snow: projected from above, plus from the sides on steep faces (mountain walls would otherwise smear the
// top-down texture into vertical streaks). The side taps are only taken where a side projection has weight.
vec3 cliffTex(sampler2D t, vec3 p, vec3 n, float scale, float detail) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  // Tiny side weights go to the top projection (no tap for them).
  if (w.x < 0.02) { w.y += w.x; w.x = 0.0; }
  if (w.z < 0.02) { w.y += w.z; w.z = 0.0; }
  float s = scale / 24.0;
  vec3 c = vec3(0.0);
  if (w.y > 0.0) c += sampleTex(t, p.xz * s, pdx.xz * s, pdy.xz * s, detail) * w.y;
  if (w.x > 0.0) c += sampleTex(t, p.zy * s, pdx.zy * s, pdy.zy * s, detail) * w.x;
  if (w.z > 0.0) c += sampleTex(t, p.xy * s, pdx.xy * s, pdy.xy * s, detail) * w.z;
  return c;
}

void main() {
  vec3 n = normalize(vNormal);
  float h = vWorldPos.y;
  float slope = 1.0 - n.y;
  vec2 uv = vWorldPos.xz / 24.0;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  pdx = dFdx(vWorldPos);
  pdy = dFdy(vWorldPos);
  float detail = surfaceDetail(vWorldPos);
  float macro = texture2D(tRock, vWorldPos.xz / 420.0).r;

  // Blend weights first: sand, rock and snow are only sampled where they show.
  vec2 cuv = (vWorldPos.xz / mapSize + 0.5) * (gridSize - 1.0) / gridSize + 0.5 / gridSize;
  vec2 cover = texture2D(tCover, cuv).rg;
  float edgeNoise = texture2D(tDirt, vWorldPos.xz / 13.0).r - 0.35;
  float dirtW = smoothstep(0.35, 0.65, cover.r + edgeNoise * 0.8);
  float sandW = 1.0 - smoothstep(waterLevel + 0.3, waterLevel + 1.1, h + (macro - 0.4) * 0.6);
  float under = smoothstep(waterLevel, waterLevel - 4.0, h);
  // Rock on steep slopes, and on high ground (mountains) regardless of slope.
  // (Heights scale with the mountains' vertical scale, so a tall map looks like a small one.)
  float rockW = max(
    smoothstep(0.26, 0.48, slope + (macro - 0.4) * 0.15),
    smoothstep(14.0 * heightScale, 22.0 * heightScale, h + (macro - 0.4) * 6.0 * heightScale) * 0.85
  );
  float snowW = smoothstep(snowLine - 5.0 * heightScale, snowLine + 5.0 * heightScale, h + (macro - 0.4) * 16.0 * heightScale)
              * (1.0 - smoothstep(0.25, 0.45, slope + (macro - 0.4) * 0.2)); // slides off faces steeper than ~40 degrees

  // Each ground texture only where it shows (gradients were taken above, outside the branches).
  float dirtPatch = smoothstep(0.55, 0.75, macro) * 0.25 * (1.0 - dirtW);
  vec3 grass = dirtW < 1.0 ? sampleTex(tGrass, uv, dx, dy, detail) : vec3(0.0);
  vec3 dirt = (dirtW > 0.0 || dirtPatch > 0.0 || under > 0.0) ? sampleTex(tDirt, uv, dx, dy, detail) : vec3(0.0);
  // Late autumn: dead, straw-olive grass instead of fresh green; cold dull mud.
  grass = mix(vec3(dot(grass, vec3(0.33))), grass, 0.7) * vec3(1.12, 0.96, 0.7);
  dirt *= vec3(0.9, 0.9, 0.95);

  // Ground cover from the generator: grass vs bare dirt, with a noisy, ragged edge.
  // Drier, lighter and less red than road dirt.
  vec3 bare = mix(dirt, vec3(dot(dirt, vec3(0.33))), 0.25) * vec3(1.22, 1.14, 1.0);
  vec3 col = mix(grass, bare, dirtW);
  // A little dirt showing through the grass in places, as before.
  col = mix(col, dirt, dirtPatch);
  // Forest floor: darker, mossier under the canopy.
  col *= 1.0 - cover.g * 0.3;

  if (sandW > 0.0 || under > 0.0) {
    vec3 sand = sampleTex(tSand, uv * 1.3, dx * 1.3, dy * 1.3, detail);
    col = mix(col, sand, sandW);
    col = mix(col, mix(sand, dirt, 0.5) * 0.75, under);
  }
  if (rockW > 0.0) col = mix(col, cliffTex(tRock, vWorldPos, n, 0.8, detail), rockW);
  if (snowW > 0.0) col = mix(col, cliffTex(tSnow, vWorldPos, n, 1.0, detail), snowW);

  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
