# Stickynotee — UX research & design decisions

## 1. Problem

People want a thought pinned *on top of their work*: a reminder next to the code they're
editing, a phone number beside a form, a quick sketch. Existing tools either live inside an
app window (OneNote, Notion) or look dated and fiddly.

## 2. Landscape review

| Product | What works | What hurts |
|---|---|---|
| Windows Sticky Notes (Microsoft) | Fast to create, colors, sync | Notes live behind a "notes list" window; heavy chrome; no drawing on desktop; no always-on-top |
| macOS Stickies | Floats on desktop, translucent mode, "floating window" option | Dated look, no drawing, no Windows version |
| Notezilla / Simple Sticky Notes | Power features (alarms, attach to apps) | Cluttered UI, toolbars everywhere, steep learning curve |
| Reference image (target look) | Soft pastels, rounded cards, one clear title, a single mode chip (Draw / Type), close ×, resize grip | — |

## 3. Key user needs (jobs to be done)

1. **Capture in < 2 s** — from anywhere, without switching apps → global hotkey + tray.
2. **Glanceable** — short notes should be readable from across the screen → text auto-scales
   (one-liners render large, long notes shrink to fit).
3. **Sketch, not just type** — arrows, circles, a quick smiley → Draw mode on the same note.
4. **Stay out of the way** — no taskbar clutter, no dead click-zones around notes, controls
   appear only on hover.
5. **Never lose anything** — autosave every keystroke; closing a note is recoverable.
6. **Survive real life** — monitor unplugged, reboot, crash → notes come back on-screen.

## 4. Design principles

- **Content first, chrome on demand.** Resting state shows only title, mode chip and ×
  (as in the reference). Color + pin buttons fade in on hover.
- **One primary toggle.** The chip shows the mode you'll switch *to* ("Draw ✎" while typing,
  "Type T" while drawing), mirroring the reference.
- **Forgiving destruction.** × closes immediately (no confirm dialog), but non-empty notes go
  to *Recently closed* in the tray menu. Empty notes are just discarded.
- **Native feel per OS.** Right-click menu includes cut/copy/paste + spellcheck; macOS gets a
  real Edit menu so ⌘C/⌘V work; shortcuts use Ctrl on Windows, ⌘ on macOS.
- **No rotation.** The reference tilts notes; we keep them straight because rotated text is
  blurrier and harder to hit-target. Depth comes from soft shadows instead.

## 5. Interaction spec

| Action | How |
|---|---|
| New note | `Ctrl+Alt+N` (⌘⌥N) anywhere · tray → New note · `Ctrl+N` inside a note |
| Show / hide all notes | `Ctrl+Alt+H` (⌘⌥H) · tray click (Windows) |
| Move | Drag the header |
| Resize | Drag bottom-right grip |
| Rename | Click the title |
| Draw / Type | Chip · `Ctrl+D` |
| Undo stroke | `Ctrl+Z` in Draw mode |
| Color, keep-on-top, clear drawing, delete | Hover buttons or right-click |
| Close note | × · `Ctrl+W` |
| Restore closed note | Tray → Recently closed |

## 6. Visual tokens

| Color | Background | Ink |
|---|---|---|
| Yellow | `#FFE7A3` | `#8A5A00` |
| Blue | `#A8E6FF` | `#17609E` |
| Green | `#BFF5C3` | `#1E8A3C` |
| Pink | `#FFC4C4` | `#C21B1B` |
| Purple | `#E2CCFF` | `#6B2FB3` |
| Gray | `#E9E9EE` | `#3D3D47` |

Radius 10 px · title 15 px semibold · body auto-fit 14–36 px · chip 12 px pill on 14 % ink.

## 7. Later (backlog)

- Cloud sync between Windows and Mac.
- Reminders / due time on a note.
- Markdown checklists.
- Snap notes to screen edges; "stack" mode.
- Configurable hotkeys.
