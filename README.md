# Stickynotee

Modern sticky notes that float on your desktop. Type or draw. Windows now, macOS from the same code.

## Run

```sh
npm install
npm start
```

## Build installers

```sh
npm run dist:win   # NSIS installer in dist/  (run on Windows)
npm run dist:mac   # DMG in dist/             (run on a Mac)
```

## Shortcuts

| Action | Windows | macOS |
|---|---|---|
| New note (global) | Ctrl+Alt+N | ⌘⌥N |
| Show / hide all (global) | Ctrl+Alt+H | ⌘⌥H |
| New note (in a note) | Ctrl+N | ⌘N |
| Draw / Type | Ctrl+D | ⌘D |
| Undo stroke (Draw mode) | Ctrl+Z | ⌘Z |
| Pen / Eraser (Draw mode) | P / E | P / E |
| Bold / Italic / Underline | Ctrl+B / I / U | ⌘B / I / U |
| Close note | Ctrl+W | ⌘W |

Five styles for all notes: Toon (default: cartoon outlines, googly eyes, custom cursors), Aura, Minimal, Midnight, Classic. Pick one in the palette popover or tray → Style.

Select text to get the format toolbar: font size (− 16 +, or type a number), bold, italic,
underline, strike, bullets, checklist, and **Aa** for font family, text color and clear.
Type `[] ` at the start of a line for a checklist, `- ` for bullets. Click a box to tick it.
Tilt a note with the palette button → slider, or right-click → Tilt.

Closed notes with content can be restored from the tray menu → **Recently closed**.

Notes are stored in `notes.json` under the app's user-data folder
(`%APPDATA%\stickynotee` on Windows, `~/Library/Application Support/stickynotee` on macOS).

## Layout

- `src/main.js` — windows, tray, global shortcuts, menus, IPC
- `src/store.js` — JSON persistence (debounced, atomic writes)
- `src/preload.js` — safe bridge to the note page
- `src/renderer/` — the note UI (text auto-fit, drawing canvas, custom resize)
- `scripts/make-icons.js` — regenerates `assets/*.png`
- `docs/UX-RESEARCH.md` — research and design decisions
