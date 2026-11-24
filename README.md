# Sound Typer

Turns an audio file into a rhythm game, or types text in sync with it. In the typewriter, louder = faster typing, and hits (drums, a vocal kicking in, anything sudden) slam chunks of text in and shake the screen.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

## Usage

1. Drag and drop an audio file anywhere onto the app, or choose one in the menu
2. Pick a style and difficulty and start

**Esc** pauses and opens the menu, where style and difficulty can be changed at any time; the song goes on from the same place. The bar at the top is the song: click or drag to jump around in it, it snaps to checkpoints. **,** and **.** step through the checkpoints (10 s in Bullet hell and the typewriter), clicking the time while paused types one in, **1**–**5** pick the style while paused, the mouse wheel or **-** / **+** / **M** set the volume, **F** goes fullscreen.

### Typewriter

Types along with the music over a spectrum and a timeline of the hits. The text to type is picked in the menu or dropped onto the window; **C** clears the page. Its corner has the settings, so the feel can be tuned while it runs.

### Game styles

Rhythm games generated from the song, played with the keyboard (or touch). Leaving the window pauses. Your health is right at the player, and the screen's edges glow red on the last one (both can be turned off in Settings).

**Bullet hell** — emitters charge up and fire on the beat: bass hits throw out rings, crisp hits fire aimed spreads, the biggest hits get a warned laser, and loud sections fill the screen with spirals.

- **Move** — WASD or arrow keys; on touch, drag anywhere (the ship moves relative to your finger)
- **Focus** — hold Shift for slow, precise movement
- **Space**, **Esc** or **P** — pause / resume
- Only the white dot is your hitbox. Grazing bullets scores extra. Getting hit clears nearby bullets; there's no game over.

**Shapes** (Just Shapes & Beats style) — faint pink shapes warn where something is about to land, then turn solid exactly on the beat. Mostly bars: full rows and columns slamming down (some aimed at where you're standing), bars marching across the arena one lane per beat, walls sweeping through with a gap, and beams spinning around a drifting pivot, speeding up with the music and firing bursts of rays on the big hits. In between: circles and boxes popping up on the beat, trails of small bombs stepping across the arena, rows of shots flying in from an edge, and the occasional small bomb that lands where you were standing. Every warning lasts long enough to walk out of the way, so you never *have* to dash. Like the typewriter, it follows the music's intensity: quiet passages thin out and the background crawls; loud ones fill up, the background streaks rush past, and strong hits punch the camera in and thump the arena.

- **Move** — WASD or arrow keys; on touch, drag anywhere
- **Dash** — Space, Shift or X (on touch: a quick tap or a second finger). You're invulnerable while dashing, so you can dash *through* shapes, which scores extra
- **Esc** or **P** — pause
- You have a few health pips (more on Easy). Run out and the song rewinds to the last checkpoint (about every 30 s)
- Dashes need to recharge (a ring around you fills back up), longer on harder difficulties

**Wave** (Geometry Dash wave style) — hold to fly up at a steep diagonal, let go to fly down, while the level scrolls by. The level is laid around a path that turns on the music's hits, so you click and release on the beat. Tight tunnels zigzag along it, spiked corridors have saws on the outside of the turns, block columns leave a gap where the path passes, mini sections make the wave smaller and twice as steep, and spam sections turn on every hit. Speed follows the song: it changes only where the music does (a drop, a breakdown, a build), across six speed stages from the calmest parts to the most intense, and the wave goes mini for the busiest drops. Changes are marked by portals, a FASTER/SLOWER callout and a color change (cool when slow, hot when fast; the meter in the corner shows the current stage). Orbs on the turns score extra.

- **Fly up** — hold Space, W or Up (on touch: hold anywhere)
- **Esc** or **P** — pause
- Health and checkpoints work like in Shapes; after a hit you're put back on the path
- Plain floors and ceilings are safe to slide along, spiked ones aren't

**Shield** — you can't move, only turn a shield to face up, right, down or left. Spears fly in from the four sides and land exactly on the music's notes, so blocking them plays the song. Every stretch of the song gets a dance from what it sounds like: kicks on one side and snares on the other, a march turning with each beat, stomps answered from the opposite side, streams of hats, a spin rising through a build. Bars that sound alike play alike and a refrain comes back identical, so you learn the song as you go. Blunt spears are kicks, thin darts are hats. When the music stops dead the spears hang in the air until it returns, a build squeezes the border in and the drop bursts it open. Big red spears are the heavy hits: they come in much faster and land with a blast. Amber ones fly in backwards, then jump to the opposite side just before they land (not on Easy), so block the side they point away from. Speed follows the song, like in Wave: at each big change in the music the spears speed up or slow down, the diamond border and camera open up or close in, and the colour changes with a FASTER/SLOWER callout. Long teal lances on loud held notes have to be blocked for as long as the note lasts.

- **Turn** — WASD or arrows (on touch: press on the side to block)
- **Space**, **Esc** or **P** — pause
- Health and checkpoints work like in Shapes

In every style, the score multiplier grows the longer you go without getting hit. At the end you get a grade and your best score for that song, style and difficulty. Seeking turns the run into a practice run that doesn't count.

## How it works

When a song is loaded it's analyzed once, up front, in a Web Worker (well under a second for a typical song):

- **Loudness** — K-weighted, normalized to the track itself, so quiet intros type slowly and the loudest parts hit full speed regardless of how loud the file was mastered.
- **Hits** — onsets from spectral flux on a semitone filterbank (SuperFlux-style, so vocal vibrato doesn't trigger false hits), picked with a centered adaptive threshold. Each hit gets a strength from how it ranks within the track combined with how much louder it is than the moment before it — so a drum after silence or someone starting to scream counts as a big hit.

Because the whole track is known in advance, playback just looks up features at the audible position (output latency compensated): no smoothing lag, no late reactions. Typing is time-based, so it behaves the same on 60 Hz and 144 Hz displays.

### Customization

- **Text source** — swap out the default text with your own in the menu while the typewriter is picked
- **Volume** — in the menu (hidden on phones; use the hardware buttons)
- **Visualizer** — spectrum and a timeline of the typing intensity and detected hits (bright ones shake), including a look-ahead past the playhead
- **Settings** (gear icon, shows what the current mode uses):
  - **Typing** — Speed (characters per second at full volume), Dynamics (higher = quiet parts slower, loud parts stand out), Punch (how hard hits slam text in), Hits complete words, Whitespace handling
  - **Game** — Respawn timer, show health, invincible (style and difficulty are in the menu)
  - **Effects** — Screen shake on/off, shake strength and threshold, glow on hits (0 = off, up to 3x)
  - **Layout** — Text anchor (bottom or center), text width (ignored on phones)
  - **Reset to defaults**

## Build

```bash
bun run build
```

Output goes to `dist/`.
