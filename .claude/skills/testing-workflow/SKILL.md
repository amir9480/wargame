---
name: testing-workflow
description: How to verify generator and renderer changes - ad-hoc Node scripts (determinism hash, streaming equivalence, health metrics over many seeds), headless-Chrome screenshots (also over CDP for a specific seed/camera), and known limitations / ideas. Load before verifying a change or when asked to screenshot the app.
---

# Verification (no test framework)

- Node ≥ 23.6 runs `.ts` directly (imports with `.ts` extensions, erasable syntax only). Write ad-hoc scripts importing `src/terrain/generate.ts` and `loadMountainLibrary()` from `src/terrain/mountains/node.ts`; `generateTerrain(seed, lib, { size: MAP_SIZE, cell: MAP_CELL })` (from `terrain/scale.ts`) matches the app (default is 256; 1280 maps take ~20 s, use few seeds; bit-identity checks are easiest at size 640, where scale 1 applies). Keep scripts in the **session scratchpad**, not the repo. Absolute imports like `/c:/Projects/wargame/src/...` work on this Windows box.
- **Determinism** after generator changes: hash `generateTerrain` output (heights, dirt, mountain + JSON of the rest) for ~200 seeds before and after; also check the streamed events (`runPipeline`) rebuild the same `Terrain` (compare event payloads with the final fields). Adding a stage with its own stream must not change other modules' output (compare against a git stash).
- Health metrics: bridges per river, road connectivity (`findRoadRoute` from node 0), off-bridge road points over water (0), max road grade, min turn radius, terrain poking above road surface, base spacing / flatness, trees on mountains (0), buildings over water / on roads / overlapping / with trees or rocks inside (0), city count distribution, gas stations per city, maps without cities keep identical roads, power network invariants (skill `terrain-power`). Generation is ~0.5–1.5 s per map in Node (640 maps ~3 s), so 200 seeds takes minutes: run in the background or use fewer seeds.
- `pnpm typecheck` must pass (`erasableSyntaxOnly`: no enums / namespaces / parameter properties).

# Screenshots
- **Fastest: the Tauri debug build's command line** (needs `pnpm dev` running: the debug exe loads http://localhost:3000; rebuild the exe with `cargo build` in `src-tauri` only when `lib.rs` changes). `src-tauri/target/debug/wargame.exe --seed N --hour H --quality low|medium|high|ultra --camera x,z,yaw,pitch,distance --screenshot out.png [--shot-delay 8]` opens the window, generates the map, waits `shot-delay` s (default 6), saves the next frame as PNG and exits (~15 s). The camera string is the "camera focus ... yaw ... pitch ... distance" line of the debug snapshot. Run sequentially (parallel runs share the WebView2 profile). Native side: `src-tauri/src/lib.rs` (`startup_script`, `save_screenshot`), page side: `captureRequested` in `main.ts`, `Engine.screenshot()`.
- **Check first whether a dev server is already running on port 3000** (the user often has `pnpm dev` up; `curl localhost:3000`). `vite` uses `strictPort`, so a second start fails; just use the running one (HMR serves current code).
- Windows: Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`; WebGL via `--headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader`. Swiftshader is slow (a 640 map takes minutes to build, ~10 fps): use `low` quality and **wait until the panel text shows `map sea=`** (the "map not loaded" line disappears) before capturing.
- For a specific seed / view, drive Chrome over CDP (`--remote-debugging-port`, Node 23 global `WebSocket`): open the page, `localStorage.setItem('wargame.settings', JSON.stringify({ seed, hour, quality: 'low', collapsed: false, camera: { x, z, yaw, pitch, distance } }))`, reload, poll `document.body.innerText`, then `Page.captureScreenshot`. No source edits needed (camera front direction = (sin yaw, cos yaw) from the target; camera sits at `target + distance·(cos pitch·sin yaw, sin pitch, cos pitch·cos yaw)`). Find coordinates for a seed from `Terrain` data with the app's options.
- WSL variant (older): `pnpm exec vite build`, `vite preview --port 3100`, `google-chrome --headless=new ... --screenshot=out.png`; stop the preview with `fuser -k 3100/tcp`, never `pkill -f`. Headless screenshots cut the canvas at ~763 px height: a screenshot quirk.
- Mid-load screenshots need real time (virtual-time screenshots only show the settled page).
- If you temporarily edit the default seed (`src/main.ts`) or `rtsCamera.ts` `reset()`, **restore them** (seed 42).

# Known limitations / ideas
- ~14% of rivers get < 2 bridges (no valid crossing site in the play area, or bank can't reach the network).
- 3-sea-side / small-land maps can have bases as close as ~90 m; power plants and substations shrink on such maps.
- Whole-map view draws hundreds of chunk meshes; could use larger chunks or LOD for far trees. No occlusion culling (not worth it for a top-down RTS camera).
- Towns are compact (median ~17 buildings, 2–4 blocks); lots only along street fronts.
- ~1/3 of cities get no gas station. Rail lines avoid cities, so a railway crossing no road is a bit more common (~8/63 rail maps).
- Plants have no access road; power poles are not drawn to individual buildings (no service drops).
- Touchpad camera rotation not implemented (suggested: two-finger drag with modifier / pinch).
