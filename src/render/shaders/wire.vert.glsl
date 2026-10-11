// Power wires: thin boxes whose width is far below a pixel at a distance. aThick = box thickness (m); vCover = how much of
// a pixel the wire covers (1 = a pixel or wider), used by wire.frag to fade it out instead of letting it alias.
attribute float aThick;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vCover;

#define WIRE_REF_HEIGHT 700.0 // half of a ~1400 px tall render target: pixels per unit of projectionMatrix[1][1]

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  vec4 clip = projectionMatrix * viewMatrix * wp;
  vCover = aThick * projectionMatrix[1][1] * WIRE_REF_HEIGHT / max(clip.w, 1e-3);
  gl_Position = clip;
}
