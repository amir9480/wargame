// Instanced billboard (trees, rocks) (the geometry's real-sized quad only serves the culling box): a quad centred on the tree and facing the camera.
// The sprite is one cell row of an atlas baked at several camera pitches; the two nearest pitches are blended.
#include ./chunks/gameview.glsl;

varying vec2 vUv0;
varying vec2 vUv1;
varying float vMix;
varying vec3 vWorldPos;
varying float vLodDist;
varying vec3 vTint;

#ifdef SPRITE_ATTR
// Several models in one mesh (rocks): per instance (atlas row, quad size, quad centre height).
attribute vec3 aSprite;
#else
uniform float quadSize; // world size of the (square) quad at scale 1
uniform float centerY;  // quad centre height above the root at scale 1
uniform float atlasRow;
#endif
uniform float atlasRows;
uniform float pitchCols;
uniform float pitchMin;
uniform float pitchStep;
uniform float lodSwitch; // distance where the near mesh gives way to the sprite
uniform float lodBias;   // both are drawn this far either side of it

void main() {
#ifdef SPRITE_ATTR
  float atlasRow = aSprite.x, quadSize = aSprite.y, centerY = aSprite.z;
#endif
  vec3 root = instanceMatrix[3].xyz;
  // Near mesh still drawn here (see the near shaders): the sprite starts lodBias before the switch.
  float lodDist = distance(fogOrigin, root);
  if (lodDist < lodSwitch - lodBias) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }
  vLodDist = lodDist;
  float sx = length(instanceMatrix[0].xyz);
  float sy = length(instanceMatrix[1].xyz);

  // Camera right / up axes in world space -> quad is parallel to the screen.
  vec3 right = gameRight;
  vec3 up = gameUp;

  vec3 center = root + vec3(0.0, centerY * sy, 0.0);
  vec3 wp = center + (right * (uv.x - 0.5) * sx + up * (uv.y - 0.5) * sy) * quadSize;

  // Atlas columns: one per baked camera pitch (camera up.y = cos pitch).
  float pitch = acos(clamp(up.y, -1.0, 1.0));
  float f = clamp((pitch - pitchMin) / pitchStep, 0.0, pitchCols - 1.0);
  float c0 = min(floor(f), pitchCols - 2.0);
  vMix = f - c0;
  vUv0 = vec2((c0 + uv.x) / pitchCols, (atlasRow + uv.y) / atlasRows);
  vUv1 = vec2((c0 + 1.0 + uv.x) / pitchCols, vUv0.y);

  vWorldPos = wp;
  vTint = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
