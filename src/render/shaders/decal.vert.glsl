// Ground decal (town yards, gas station forecourts, car parks): a flat grid laid on the ground, drawn like the road
// ribbons (same depth bias along the view ray, so the terrain never z-fights or pokes through).
// aUV = local position (m) in the decal's footprint frame, aKind = 1 paving / 2 asphalt / 3 car park,
// aLot = car park [width, depth, bays per row, entrance bay] (aKind 3) or [-, -, -, front edge v] (driveway limit).
attribute vec2 aUV;
attribute float aKind;
attribute vec4 aLot;

#define DEPTH_BIAS 0.3
#define DEPTH_BIAS_PER_M 0.004

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying float vKind;
varying vec4 vLot;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUV = aUV;
  vKind = aKind;
  vLot = aLot;
  vec4 vp = viewMatrix * wp;
  float dist = length(vp.xyz);
  vp.xyz *= max(0.0, 1.0 - (DEPTH_BIAS + DEPTH_BIAS_PER_M * dist) / max(dist, 1e-3));
  gl_Position = projectionMatrix * vp;
}
