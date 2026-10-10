// Building (far detail): simple boxes and roofs. Windows come from the near level's window grid, rebuilt in the
// fragment shader (see buildFar in buildings/geometry.ts for the attributes).
attribute vec4 aFacade;
attribute vec4 aGrid;
attribute vec4 aCols;
attribute vec4 aDoor;
attribute float aSeed;
attribute vec3 aGlass;
flat varying vec4 vCols;
flat varying vec4 vDoor;
flat varying vec3 vGlass;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vFacade;
flat varying vec4 vGrid;
flat varying float vSeed;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  vFacade = aFacade;
  vGrid = aGrid;
  vSeed = aSeed;
  vCols = aCols;
  vDoor = aDoor;
  vGlass = aGlass;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
