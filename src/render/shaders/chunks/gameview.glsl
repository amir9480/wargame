// The game camera, for everything that measures distance from it or faces it: LOD / fog / halo distances and
// camera-facing sprites. Normally the camera that draws; with the debug camera frozen (Engine.cameraFrozen) it is the
// frozen game camera, so a free camera can look around at what the game camera sees.
uniform vec3 fogOrigin; // position
uniform vec3 gameRight;
uniform vec3 gameUp;

// Far light halos stay a few pixels wide, but shrink again when very far (whole-map view): from HALO_SHRINK_START to
// HALO_SHRINK_END camera distance they go down to HALO_SHRINK_MIN of their size.
#define HALO_SHRINK_START 450.0
#define HALO_SHRINK_END 1300.0
#define HALO_SHRINK_MIN 0.3
float haloShrink(float dist) {
  return mix(1.0, HALO_SHRINK_MIN, smoothstep(HALO_SHRINK_START, HALO_SHRINK_END, dist));
}

// Bokeh (ultra): far halos open up into a soft, rim-lit out-of-focus disc, like a real lens shows distant lights.
// `haloBokeh` is 0 on every other quality (halos stay sharp dots).
uniform float haloBokeh;
#define BOKEH_START 380.0
#define BOKEH_END 1000.0
#define BOKEH_GROW 0.35 // extra radius (times the dot's size) at full defocus
/** 0 = in focus .. 1 = full bokeh, by camera distance. */
float bokehAmount(float dist) {
  return haloBokeh * smoothstep(BOKEH_START, BOKEH_END, dist);
}
