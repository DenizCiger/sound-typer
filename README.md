# Sound Typer

Plays an audio file and types text in sync with the music's intensity. Louder = faster typing.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

## Usage

1. Drag and drop an audio file onto the app or use the file button (top left) to select one
2. Hit play
3. Watch the text get typed out at a pace driven by the audio's volume

### Customization

- **Text source** — swap out the default text with your own via the text source button (top right)
- **Volume / Speed / Power** — sliders in the toolbar adjust how aggressively audio intensity maps to typing speed
- **Settings** — screenshake, cursor position, text width

## Build

```bash
bun run build
```

Output goes to `dist/`.
