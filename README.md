# MARE

An ocean, some boats, and the birds that follow them.

A Mediterranean sailing simulation that runs in a browser. There are no
textures, no models, no audio files and no build step — the sea, the islands,
the boats, the gulls and every sound in it are generated in code at load time.
The whole thing is about 6,000 lines of ES modules and one `<canvas>`.

```
open index.html   # needs a local server, because it uses ES modules
```

Any static server will do:

```bash
python3 -m http.server 4488
```

Then visit <http://localhost:4488>. Three.js is pulled from a CDN via an import
map; nothing else is fetched.

---

## The five ways to play

| Mode | What it is |
|---|---|
| **Easy** — *Drift* | No body, no needs, no end. A free camera over a calm summer sea in a fixed golden afternoon. Nothing can hurt you. |
| **Medium** — *Deckhand* | You are a person standing on a hull that is genuinely being thrown about. Walk the deck, lose your footing, go over the side, swim, climb back. Something aboard will tell you why you sailed. |
| **Hard** — *Passage* | The sea keeps its manners; your body does not. Health, hunger, thirst, scurvy and sanity, over a full day/night cycle. Islands hold fresh water and fruit. Nothing out there does. |
| **Insane** — *The unwelcoming side* | Black water, six-metre seas, no compass, no help, and the strong feeling that the sea is counting you. |
| **Insane+** — *Contested waters* | All of that, plus somebody else's air force using this stretch of sea as a range. Unmarked fast jets run in low, mark the water, and leave. |

**The objective is not given to you.** From Medium up you start knowing only
that you are aboard and under way. There is a logbook on deck; reading it is
what turns "sail around" into a goal.

### Controls

| | |
|---|---|
| `WASD` | move |
| `Mouse` | look |
| `Space` / `Shift` | jump / sprint (up / down in Easy) |
| `E` | interact — read, drink, eat, take, climb aboard |
| `Q` / `R` | shorten / make sail |
| `A` / `D` at the tiller | steer |
| `V` | first / third person |
| `M` | the chart |
| `Esc` | pause |

---

## How it works

### The sea

The water is a sum of Gerstner waves drawn from a wind-sea spectrum. The same
spectrum is evaluated **twice, identically** — once in GLSL for displacement and
shading, once in JavaScript for buoyancy — so a hull floats on exactly the
surface you can see, rather than on an approximation of it.

Two things make it hold up:

- **Per-pixel level of detail.** Each wave component fades out once its
  wavelength approaches the world-space size of a pixel (`fwidth` in the
  fragment shader, a distance estimate in the vertex shader). Without this a
  summed-sine ocean turns into moiré corduroy in the middle distance — with it,
  the horizon stays smooth and the detail budget goes where it can be seen.
- **A polar mesh re-centred on the camera** every frame, snapped to a 2 m grid so
  vertices don't crawl underfoot. Dense at your feet, cheap at the horizon, and
  it never tiles.

Normals are recomputed per-fragment from the undisplaced coordinate, so surface
detail is independent of mesh density.

### Ray tracing, such as it is

WebGL has no hardware ray tracing, but the sea is a closed-form surface, so it
can be marched directly:

- **Traced reflections.** Grazing reflected rays are marched against the wave
  field and genuinely bounce off the wave in front, which is what gives rough
  water its dark, broken look instead of a uniform mirror.
- **Traced island reflections and shadows.** Islands are intersected as
  ellipsoids for both the reflection term and the shadow they throw across the
  water.

Step counts are a quality knob and the first thing the governor gives up.

### The atmosphere

One GLSL function, `skyColor(dir)`, is shared by the sky dome and the ocean's
reflection term, so the water always mirrors exactly the sky above it. It
carries the day/night palette, a projected cloud deck, stars, a moon, and the
storm states.

### The boat

A rigid body with an inertia tensor, integrated at up to 140 Hz. Buoyancy is
sampled at 27 probes over the wetted hull; each probe contributes lift
proportional to its submersion and anisotropic drag against the water's local
orbital velocity — lateral resistance far exceeding fore-and-aft, which is what
lets her sail rather than slide. The rig's force acts normal to the sail at the
centre of effort, well above the keel's side force, so she heels for the right
reason. She makes about 8 knots on a broad reach in 15 knots of wind and turns
at roughly 6°/s.

The player lives in the ship's local frame while aboard, so the deck's heel and
the ship's acceleration show up as real forces underfoot. Fall off the side and
you are in the water; swim to a beach and you are ashore on a heightfield.

### The islands

Limestone bones, scrub and olive terraces raised from layered value noise with a
ragged, angularly-warped coastline. Vegetation, rocks and villages are scattered
by rule and drawn as instances. One island — the farthest — carries the light.

The chart traces each coastline by bisecting each island's own height function
along 72 bearings, so the outline you navigate by is the outline you run aground
on. It only draws water you have actually sailed.

### Performance

Everything is sized to the machine and then governed. The renderer picks a tier
from the reported GPU, and an adaptive governor watches the frame rate and moves
a single quality scalar up or down, which drives render resolution, ray-march
step count, active wave components, shadow map size, ripple octaves and the
post chain. The target is to stay in the 30–60 fps band and spend everything
above that on the water.

On an M1 Max the top tier is a 32-component spectrum, a ~740k-triangle ocean and
native-resolution rendering with bloom and ray-marched crepuscular rays.

### Sound

Synthesised at runtime with the Web Audio API — filtered noise shaped into
swell, foam, wind, rain and rigging, with the gulls, thunder and ordnance as
scheduled one-shots. No audio files are loaded.

---

## Layout

```
index.html          markup for the menu, HUD and overlays
style.css
src/
  main.js           modes, the loop, the quality governor, input, interaction
  waves.js          the wave spectrum — evaluated on CPU and GPU identically
  ocean.js          the water shader and its polar mesh
  sky.js            shared atmosphere, day/night, storm
  post.js           HDR, bloom, ray-marched god rays, grade
  islands.js        terrain, vegetation, villages, the lighthouse
  boats.js          rigid-body hull, buoyancy, rig, rudder, the fleet
  player.js         fly / deck / swim / land, and an articulated body
  birds.js          gull flocking
  survival.js       the body, and the objective you have to discover
  chart.js          the traced sea chart
  strikes.js        air strikes: scheduling, ballistics, consequences
  ui.js             HUD, compass, toasts, the reader
  audio.js          procedural sound
  fx/
    f18.js          the aircraft
    ordnance.js     the stores it carries
    flyover.js      the run-in, release solution and egress
    blast.js        detonations on water and on land
```

---

## Notes

The air strikes in Insane+ are attributed to an unnamed, unmarked foreign
flight. That is deliberate: the mechanic is the point, and naming a real
government as the party bombing you is not.

Built with [Claude Code](https://claude.com/claude-code).

## Two players

An asymmetric mode for two people: one on the water, one in the air.

The rule the whole thing is built around is that **the simulation knows
everything and the players only know what they can observe**. There is no shared
HUD, no marker over the other player, and no health bar. What crosses the wire
is physical state, and each side works out what it means with their own eyes.

**SAILOR** sails the boat in a hostile sea, knowing only that something is
looking for them.

**PILOT** flies the aircraft with one tank of fuel and a handful of stores.
There is no target marker, no CCIP, no release cue and no kill confirmation —
an altimeter, an airspeed indicator, a compass, fuel, stores and a window.

The sailor's client sends **every boat, unlabelled**, in a privately shuffled
order that cannot be reconstructed from the shared world seed. There are no
target labels or markers; the pilot watches the wakes to find the sailor.

Authority splits along who can see what. The sailor owns the sea, every hull and
all damage. The pilot owns the aircraft. A release is an event carrying the
store's exact position and velocity off the pylon; both ends integrate it
through the same drag model, so both watch it fall in the same place, but only
the sailor's answer counts. The pilot's only feedback is *near* or *nothing* —
the sailor's word for it, never a number.

Weather needs no synchronisation at all: it is a pure function of seed and
elapsed time, so both clients drift through the same front at the same moment
without a byte crossing the wire.

### Connecting

The game is static files, so there is no matchmaking server and there is not
going to be one. Connection is direct peer-to-peer WebRTC with the signalling
done by hand:

1. The sailor picks **Sail** and copies the invite code.
2. The pilot picks **Fly**, pastes it, and copies the reply code back.
3. The sailor pastes the reply and the link comes up.

Codes are deflate-compressed before base64 and come out around 600–700
characters, which is short enough to paste into a chat window.

### Flying

`W`/`S` pitch · `A`/`D` roll · `Q`/`R` rudder · `Space`/`Ctrl` throttle ·
`Shift` afterburner · `X` airbrake · `F` release · `V` view · `B` reset the
altimeter datum · `[`/`]` nose-down/nose-up trim · hold `G` minigun · hold `Z`
zoom · hold `Alt` and move the mouse to look around (release to centre).

The pilot has a clear cockpit view independent of the sailor's eyesight,
reduced distance haze, a forward gun sight, and a 32° zoom view. Weather still
affects visibility. The sight hides while looking away from the gun direction.

Each sortie carries 600 minigun rounds and the mixed bomb loadout. The sailor
draws the loadout once: there is a **10% chance of one extra nuclear store**,
placed first in the release order. The panel shows the next store and remaining
gun ammunition. `F` releases one store per press; `G` fires five-round bursts.

The nuclear store is a stylised game effect: a bright flash at every graphics
setting, rising fireball and mushroom cloud, expanding shock ring, and a large
outward-moving tsunami. The wave deforms both the rendered ocean and the water
sampled by boat buoyancy, then dissipates. Returning to the menu clears it.

Both players must use protocol version 2 (refresh the game before connecting).
The sailor enforces the assigned store inventory, single-use message sequence
numbers, gun ammunition and burst rate, and bounded release coordinates.
The network rejects malformed poses and oversized messages/invites. This is
still peer-to-peer: each player controls their own simulation, so these checks
do not provide server-authoritative anti-cheat.

### Multiplayer verification

Serve the repository and open `tests/multiplayer.html` to run the flight,
particle, gameplay, shore, weapon-budget, replay, invite-limit, and tsunami
checks. `tests/preview.html` remains the interactive effects viewer.

The aircraft starts with attitude, trim and throttle balanced for its current
airspeed, fuel, stores and air density. This is a one-time spawn adjustment;
after changing speed or loadout, hold the trim keys to relieve stick pressure
and adjust throttle to settle the climb or descent.

That last one matters. The altimeter is barometric and reads what the pressure
tells it, so flying through a front without resetting the datum will lie to you
by a hundred metres or more and never mention it. Rain is stripped off the
canopy by the airflow above about 70 knots, condensation forms when the skin
sits below the dew point, and cloud base is derived from the temperature/dew
point spread — inside the layer there is no horizon and only the instruments.
