uniform sampler2D tRock;
uniform sampler2D tGrass;
uniform sampler2D tSnow;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float snowLine;
uniform float heightScale; // vertical scale of the mountains (1 = reference map)

varying vec3 vWorldPos;
varying float vLodDist;
varying vec3 vNormal;
varying vec3 vTint;
varying float vBase;

#include ./chunks/fog.glsl;
#include ./chunks/lodfade.glsl;

// Rocks have no UVs: project the texture along the three world axes.
vec3 triplanar(sampler2D t, vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z;
}

void main() {
  // Cross-fade with the sprite: keep this pixel only where the noise is below the near model's share.
  float nearShare = lodNearShare(vLodDist);
  if (nearShare < 1.0 && lodNoise() >= nearShare) discard;
  vec3 n = normalize(vNormal);
  vec3 col = triplanar(tRock, vWorldPos / 5.0, n) * vTint;

  // Moss on upward faces in the lowlands, snow on top above the snow line.
  float up = smoothstep(0.55, 0.9, n.y);
  // (Their textures are only sampled where they show; gradients taken outside the branches.)
  vec2 uv = vWorldPos.xz / 8.0, dx = dFdx(uv), dy = dFdy(uv);
  float moss = up * (1.0 - smoothstep(8.0, 18.0, vWorldPos.y)) * 0.35;
  if (moss > 0.0) col = mix(col, textureGrad(tGrass, uv, dx, dy).rgb * 0.75, moss);
  float snow = up * smoothstep(snowLine - 4.0 * heightScale, snowLine + 2.0 * heightScale, vWorldPos.y);
  if (snow > 0.0) col = mix(col, textureGrad(tSnow, uv, dx, dy).rgb, snow);

  col *= mix(0.6, 1.0, vBase);

  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
