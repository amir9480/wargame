// Needs fogOrigin (the game camera): include chunks/fog.glsl (it pulls in gameview.glsl) before this chunk.
// Distance level of detail for surface shaders: fine pattern (sleepers, rails, paving joints, small painted lines,
// texture detail taps) fades to its average colour between DETAIL_START and DETAIL_END metres from the camera, and is
// not computed at all beyond (it would only alias there). A material may define its own range before including this.
#ifndef DETAIL_START
#define DETAIL_START 110.0
#endif
#ifndef DETAIL_END
#define DETAIL_END 170.0
#endif

/** 1 near the camera, 0 beyond DETAIL_END: how much of the fine detail at `p` (world) is drawn. */
float surfaceDetail(vec3 p) {
  return 1.0 - smoothstep(DETAIL_START, DETAIL_END, distance(fogOrigin, p));
}

/** Mean shading of the 0.5 m paving slabs (dirt texture mean 0.1 linear, joints ~4% darker): their far colour. */
#define PAVING_AVG 0.84
