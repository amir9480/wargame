// x: signed distance from the centre line, y: distance along the road (world units),
// z: 1 = lane markings allowed, 0 = none (junction caps).
attribute vec3 aRoad;
// Lane marking clips at junctions (see markingClips in roads.ts):
// aEnds = (distance from start node, distance to end node, markings off within this of start, of end)
// aGaps = edge line off within (start +side, start -side, end +side, end -side)
attribute vec4 aEnds;
// aSkip = pavement pass skipped within (start, end) distance (side road inside a through road)
attribute vec4 aGaps;
attribute vec2 aSkip;
// aCross = crosswalk start distance from (start, end) node, 0 = none
attribute vec2 aCross;
// aWalk = (town street 0/1, sidewalk starts this far from the start node, ends this far from the end node)
attribute vec3 aWalk;
// Town junction plates: road directions (angles, > 50 = none) and their half widths (see buildPlate in roads.ts)
attribute vec4 aJunc;
attribute vec4 aJuncW;
varying vec2 vCross;
varying vec3 vWalk;
varying vec4 vJunc;
varying vec4 vJuncW;
varying vec4 vEnds;
varying vec4 vGaps;
varying vec2 vSkip;

// Depth bias along the view ray (m): the ribbon only samples the ground at three columns, and coarser terrain
// detail levels interpolate across it, so terrain triangles can rise a little above it. Pulling each vertex
// towards the camera along its own view ray keeps its screen position and only wins the depth test.
#define DEPTH_BIAS 0.3
#define DEPTH_BIAS_PER_M 0.004

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vRoad;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vRoad = aRoad;
  vEnds = aEnds;
  vGaps = aGaps;
  vSkip = aSkip;
  vCross = aCross;
  vWalk = aWalk;
  vJunc = aJunc;
  vJuncW = aJuncW;
  vec4 vp = viewMatrix * wp;
  float dist = length(vp.xyz);
  vp.xyz *= max(0.0, 1.0 - (DEPTH_BIAS + DEPTH_BIAS_PER_M * dist) / max(dist, 1e-3));
  gl_Position = projectionMatrix * vp;
}
