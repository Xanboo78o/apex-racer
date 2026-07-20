# Apex Racer

A small 3D low-poly racing game. Pure browser, no build step, no internet needed
(three.js is vendored locally).

## Play

Open `index.html` in a browser:

```
xdg-open ~/Games/apex-racer/index.html
```

(Everything loads over `file://` — no server required.)

## Controls

| Key | Action |
|-----|--------|
| **W** | Throttle |
| **S** | Brake / reverse |
| **A / D** | Steer left / right |
| **Space** | Handbrake (breaks rear grip — flick it for drifts) |
| **R** | Reset car to track (keeps lap progress) |
| **C** | Cycle camera: Chase → Cockpit (first-person) → Cinematic |
| **M** | Mute |
| **Esc** | Pause |

Arrow keys work too.

## Look

Cel / toon shaded (`MeshToonMaterial` + stepped gradient) with inverted-hull black
outlines on cars and scenery, real directional sun + soft shadows. Roads use a
generated tarmac texture with white edge lines and a dashed centre line so the
racing surface reads clearly. Note: the road strip is drawn `DoubleSide` — its
triangles wind front-face-down, so a single-sided material is invisible from above.

## Tracks

1. **Brickyard Oval** — flat-out Indy-style superspeedway (5 laps)
2. **Autodromo Monza** — long straights + hard chicanes
3. **Cote d'Azur Streets** — Monaco-style street circuit with barriers
4. **Northampton GP** — fast, flowing Silverstone-style esses
5. **Figure Eight** — Suzuka-style crossover with an over/under bridge
6. **Dust Devil Rally** — loose off-road dirt track, big momentum slides

Each track has **Race** (5 AI opponents, grid start, lights-out) and
**Time Trial** (solo, ghost of the clock, best lap saved per track in
`localStorage`).

## Physics

Grip-limited handling model: engine/brake forces along the car axis, a
lateral-grip cap that lets the back step out when you overdrive a corner,
and per-surface grip (asphalt / dirt / grass / sand). Off-track = low grip,
so keep it on the black stuff.

## Files

- `index.html` / `style.css` — shell + HUD/menu
- `js/three.min.js` — vendored three.js r149 (UMD, works from `file://`)
- `js/tracks.js` — the six circuit centerlines
- `js/main.js` — engine: track builder, physics, AI, HUD, audio
