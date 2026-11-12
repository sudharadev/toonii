// Toonii main process (Tauri). Each note is its own transparent, frameless window; the
// page (src/renderer) does all drawing and talks to this file through the commands below.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use store::{Bounds, Note, Store, COLOR_IDS};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_updater::{Update, UpdaterExt};

const APP_NAME: &str = "Toonii";
const DATA_DIR: &str = "Toonii"; // %APPDATA%\Toonii or ~/Library/Application Support/Toonii
const LEGACY_DATA_DIRS: [&str; 2] = ["Stickynotee", "stickynotee"];
const DEFAULT_SIZE: (f64, f64) = (340.0, 270.0);
const MIN_SIZE: (f64, f64) = (200.0, 140.0);
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const MENU_PAD: f64 = 10.0; // transparent room around the menu card; mirrors --pad in menu.css
const MENU_LABEL: &str = "menu";
const NOTE_PREFIX: &str = "note-";
const TOON_COLORS: [(&str, &str, &str); 6] = [
    ("yellow", "Yellow", "#FFD84D"),
    ("blue", "Blue", "#6CC8FF"),
    ("green", "Green", "#7DE38D"),
    ("pink", "Pink", "#FF8FAB"),
    ("purple", "Purple", "#B79CFF"),
    ("gray", "Gray", "#D6D6E0"),
];
const TILTS: [(&str, f64); 3] = [("Left", -3.0), ("Straight", 0.0), ("Right", 3.0)];

// ---------- state ----------

#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq)]
struct Stage {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

#[derive(Clone)]
enum Action {
    Edit(&'static str),
    Color,
    Tilt,
    Pin,
    ClearInk,
    Save,
    Update,
    New,
    Close,
}

struct MenuState {
    owner: String, // note window label
    actions: HashMap<String, Action>,
    at: (f64, f64), // cursor, physical px
    spec: Value,
}

/// A title-bar drag in progress, in physical px.
struct Drag {
    cursor: (f64, f64),
    win: (i32, i32),
    last_x: f64,
}

/// An edge or corner resize in progress, in physical px. `edge` is -1/0/1 per axis
/// (left/none/right, top/none/bottom).
struct Resize {
    cursor: (f64, f64),
    pos: (i32, i32),
    size: (f64, f64),
    edge: (i8, i8),
    min: (f64, f64),
}

struct Inner {
    store: Store,
    stages: HashMap<String, Stage>,
    focus_pending: HashSet<String>,
    drags: HashMap<String, Drag>,
    resizes: HashMap<String, Resize>,
    notes_hidden: bool,
    menu: Option<MenuState>,
}

struct AppState {
    inner: Mutex<Inner>,
    dirty: AtomicBool,
}

impl AppState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn touch(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }
}

fn state(app: &AppHandle) -> State<'_, AppState> {
    app.state::<AppState>()
}

fn label_for(id: &str) -> String {
    format!("{NOTE_PREFIX}{id}")
}
fn id_for(label: &str) -> Option<&str> {
    label.strip_prefix(NOTE_PREFIX)
}

// ---------- geometry (logical px, like the stored bounds) ----------

#[derive(Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn monitor_area(m: &tauri::Monitor) -> Area {
    let s = m.scale_factor();
    let r = m.work_area();
    Area {
        x: r.position.x as f64 / s,
        y: r.position.y as f64 / s,
        w: r.size.width as f64 / s,
        h: r.size.height as f64 / s,
    }
}

fn areas(app: &AppHandle) -> Vec<Area> {
    app.available_monitors().unwrap_or_default().iter().map(monitor_area).collect()
}

/// Work area of the display containing a logical point (or the first display).
fn area_at(app: &AppHandle, x: f64, y: f64) -> Area {
    let all = areas(app);
    all.iter()
        .copied()
        .find(|a| x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h)
        .or_else(|| all.first().copied())
        .unwrap_or(Area { x: 0.0, y: 0.0, w: 1280.0, h: 720.0 })
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi.max(lo))
}

fn cursor_logical(app: &AppHandle) -> (f64, f64) {
    let Ok(p) = app.cursor_position() else { return (0.0, 0.0) };
    let scale = app
        .monitor_from_point(p.x, p.y)
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    (p.x / scale, p.y / scale)
}

/// Whole window bounds in logical px.
fn win_bounds(win: &WebviewWindow) -> Option<Bounds> {
    let s = win.scale_factor().ok()?;
    let p = win.outer_position().ok()?;
    let z = win.outer_size().ok()?;
    Some(Bounds { x: p.x as f64 / s, y: p.y as f64 / s, width: z.width as f64 / s, height: z.height as f64 / s })
}

fn set_win_bounds(win: &WebviewWindow, b: Bounds) {
    let _ = win.set_position(LogicalPosition::new(b.x.round(), b.y.round()));
    let _ = win.set_size(LogicalSize::new(b.width.round(), b.height.round()));
}

/// The note's own bounds, without the temporary stage around it.
fn core_bounds(win: &WebviewWindow, st: Stage) -> Option<Bounds> {
    let b = win_bounds(win)?;
    Some(Bounds {
        x: b.x + st.left,
        y: b.y + st.top,
        width: b.width - st.left - st.right,
        height: b.height - st.top - st.bottom,
    })
}

fn ensure_on_screen(app: &AppHandle, inner: &Inner, bounds: Option<Bounds>) -> Bounds {
    let mut b = bounds.unwrap_or(Bounds { x: f64::NAN, y: f64::NAN, width: DEFAULT_SIZE.0, height: DEFAULT_SIZE.1 });
    b.width = b.width.max(MIN_SIZE.0);
    b.height = b.height.max(MIN_SIZE.1);
    let (cx, cy) = (b.x + b.width / 2.0, b.y + 24.0);
    let visible = areas(app).iter().any(|a| cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
    if b.x.is_finite() && visible {
        return b;
    }
    let (x, y) = place_new(app, inner, None);
    Bounds { x, y, ..b }
}

fn place_new(app: &AppHandle, inner: &Inner, near: Option<Bounds>) -> (f64, f64) {
    let (mut x, mut y, area) = match near {
        Some(b) => (b.x + 32.0, b.y + 32.0, area_at(app, b.x + 20.0, b.y + 20.0)),
        None => {
            let (cx, cy) = cursor_logical(app);
            let a = area_at(app, cx, cy);
            ((a.x + a.w / 2.0 - DEFAULT_SIZE.0 / 2.0).round(), (a.y + a.h / 3.0 - DEFAULT_SIZE.1 / 2.0).round(), a)
        }
    };
    let taken = |x: f64, y: f64| {
        inner.store.all().iter().any(|n| n.bounds.map_or(false, |b| (b.x - x).abs() < 10.0 && (b.y - y).abs() < 10.0))
    };
    for _ in 0..30 {
        if !taken(x, y) {
            break;
        }
        x += 32.0;
        y += 32.0;
    }
    (
        clamp(x, area.x, area.x + area.w - DEFAULT_SIZE.0),
        clamp(y, area.y, area.y + area.h - DEFAULT_SIZE.1),
    )
}

// ---------- windows ----------

fn note_window(app: &AppHandle, id: &str) -> Option<WebviewWindow> {
    app.get_webview_window(&label_for(id))
}

fn note_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with(NOTE_PREFIX)).map(|(_, w)| w).collect()
}

/// Keep a note above other windows. On macOS a full-screen app has its own Space, so an
/// on-top window must also join every Space (as a full-screen auxiliary) to float over it.
fn set_on_top(win: &WebviewWindow, on: bool) {
    let _ = win.set_always_on_top(on);
    set_all_spaces(win, on);
}

#[cfg(target_os = "macos")]
fn set_all_spaces(win: &WebviewWindow, on: bool) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as B};
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        let Ok(ptr) = w.ns_window() else { return };
        // SAFETY: tao's NSWindow pointer, valid while the window lives; on the main thread.
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let flags = B::CanJoinAllSpaces | B::FullScreenAuxiliary;
        let mut b = ns.collectionBehavior();
        if on {
            b = (b - B::MoveToActiveSpace) | flags;
        } else {
            b = b - flags;
        }
        ns.setCollectionBehavior(b);
    });
}

#[cfg(not(target_os = "macos"))]
fn set_all_spaces(_win: &WebviewWindow, _on: bool) {}

fn raise(win: &WebviewWindow, pinned: bool) {
    // Toggling topmost brings a window to the front without stealing focus.
    let _ = win.set_always_on_top(true);
    set_on_top(win, pinned);
}

fn open_window(app: &AppHandle, note: &Note, focus: bool) {
    let label = label_for(&note.id);
    if app.get_webview_window(&label).is_some() {
        return;
    }
    let st = state(app);
    let bounds = {
        let mut inner = st.lock();
        let b = ensure_on_screen(app, &inner, note.bounds);
        if note.bounds != Some(b) {
            if let Some(n) = inner.store.get_mut(&note.id) {
                n.bounds = Some(b);
            }
            st.touch();
        }
        inner.stages.insert(label.clone(), Stage::default());
        if focus {
            inner.focus_pending.insert(label.clone());
        }
        b
    };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("note.html".into()))
        .title(&note.title)
        .inner_size(bounds.width, bounds.height)
        .position(bounds.x, bounds.y)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false) // custom grip
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(note.pinned)
        .visible(false) // shown by note_ready once the page has laid out
        .disable_drag_drop_handler()
        .build();
    match built {
        Ok(w) if note.pinned => set_all_spaces(&w, true),
        Ok(_) => {}
        Err(_) => {
            st.lock().stages.remove(&label);
        }
    }
}

fn create_note(app: &AppHandle, near: Option<&WebviewWindow>, text: &str) {
    let st = state(app);
    let note = {
        let mut inner = st.lock();
        let near_b = near.and_then(|w| {
            let s = inner.stages.get(w.label()).copied().unwrap_or_default();
            core_bounds(w, s)
        });
        let (x, y) = place_new(app, &inner, near_b);
        let color = COLOR_IDS[(inner.store.all().len() + inner.store.trash().len()) % COLOR_IDS.len()];
        let note = Note {
            color: color.into(),
            text: text.into(),
            bounds: Some(Bounds { x, y, width: DEFAULT_SIZE.0, height: DEFAULT_SIZE.1 }),
            ..Default::default()
        };
        let note = inner.store.create(note);
        inner.notes_hidden = false;
        note
    };
    st.touch();
    open_window(app, &note, true);
    refresh_tray(app);
}

fn close_note(app: &AppHandle, id: &str) {
    let st = state(app);
    st.lock().store.discard(id);
    st.touch();
    if let Some(w) = note_window(app, id) {
        // Hide first so the note is gone at once; tearing down a webview takes a moment and
        // blocks the UI thread, so let this frame paint before destroying it.
        let _ = w.hide();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            let _ = w.destroy();
        });
    }
    refresh_tray(app);
}

fn restore_note(app: &AppHandle, id: &str) {
    let st = state(app);
    let note = {
        let mut inner = st.lock();
        inner.notes_hidden = false;
        inner.store.restore(id)
    };
    if let Some(note) = note {
        st.touch();
        open_window(app, &note, true);
    }
    refresh_tray(app);
}

fn open_saved(app: &AppHandle, id: &str) {
    let st = state(app);
    let note = {
        let mut inner = st.lock();
        inner.notes_hidden = false;
        inner.store.from_library(id)
    };
    if let Some(note) = note {
        st.touch();
        open_window(app, &note, true);
    }
}

fn save_note(app: &AppHandle, id: &str) {
    let st = state(app);
    let saved = st.lock().store.save_to_library(id);
    if saved {
        st.touch();
        if let Some(w) = note_window(app, id) {
            let _ = app.emit_to(w.label(), "note:saved", ());
        }
        refresh_tray(app);
    }
}

// ---------- updates ----------
// Releases on GitHub carry a signed latest.json (see scripts/make-latest-json.js). A check
// runs shortly after launch and every few hours; "Check for updates…" runs one on demand and
// is the only kind that reports "up to date" or errors.

static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);

fn check_for_updates(app: &AppHandle, manual: bool) {
    if UPDATE_BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let found = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => offer_update(&app, update),
            Ok(None) => {
                UPDATE_BUSY.store(false, Ordering::SeqCst);
                if manual {
                    let v = app.package_info().version.to_string();
                    notify(&app, MessageDialogKind::Info, "You're up to date", &format!("{APP_NAME} {v} is the latest version."));
                }
            }
            Err(e) => {
                UPDATE_BUSY.store(false, Ordering::SeqCst);
                if manual {
                    notify(&app, MessageDialogKind::Warning, "Couldn't check for updates", &format!("{e}\n\nCheck your connection and try again."));
                }
            }
        }
    });
}

fn offer_update(app: &AppHandle, update: Update) {
    let now = app.package_info().version.to_string();
    let notes = update.body.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(|b| format!("\n\n{b}")).unwrap_or_default();
    let handle = app.clone();
    app.dialog()
        .message(format!("{APP_NAME} {} is out (you have {now}).{notes}\n\nInstall it now? {APP_NAME} restarts and your notes stay put.", update.version))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install & restart".into(), "Later".into()))
        .show(move |yes| {
            if !yes {
                UPDATE_BUSY.store(false, Ordering::SeqCst);
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        state(&handle).lock().store.save_now();
                        handle.restart();
                    }
                    Err(e) => {
                        UPDATE_BUSY.store(false, Ordering::SeqCst);
                        notify(&handle, MessageDialogKind::Error, "Update failed", &format!("{e}"));
                    }
                }
            });
        });
}

fn notify(app: &AppHandle, kind: MessageDialogKind, title: &str, text: &str) {
    app.dialog().message(text).title(title).kind(kind).buttons(MessageDialogButtons::Ok).show(|_| {});
}

fn spawn_update_checks(app: AppHandle) {
    if cfg!(debug_assertions) {
        return; // dev builds are never "behind" a release
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(8));
        loop {
            check_for_updates(&app, false);
            thread::sleep(UPDATE_EVERY);
        }
    });
}

/// Apply a change made from main-process UI (menus) and tell the page.
fn set_note_props(app: &AppHandle, id: &str, patch: Value) {
    let st = state(app);
    let applied = {
        let mut inner = st.lock();
        let Some(n) = inner.store.get_mut(id) else { return };
        let applied = n.apply_patch(&patch);
        n.updated_at = store::now_ms();
        applied
    };
    st.touch();
    let Some(win) = note_window(app, id) else { return };
    if let Some(p) = applied.get("pinned").and_then(Value::as_bool) {
        set_on_top(&win, p);
    }
    let _ = app.emit_to(win.label(), "note:changed", patch);
}

fn any_visible(app: &AppHandle) -> bool {
    note_windows(app).iter().any(|w| w.is_visible().unwrap_or(false))
}

fn show_all(app: &AppHandle) {
    let notes: Vec<Note> = {
        let st = state(app);
        let mut inner = st.lock();
        inner.notes_hidden = false;
        inner.store.all().to_vec()
    };
    let mut last = None;
    for note in &notes {
        match note_window(app, &note.id) {
            Some(w) => {
                let _ = w.show();
                raise(&w, note.pinned);
                last = Some(w);
            }
            None => open_window(app, note, false),
        }
    }
    if let Some(w) = last {
        let _ = w.set_focus();
    }
    refresh_tray(app);
}

fn hide_all(app: &AppHandle) {
    state(app).lock().notes_hidden = true;
    for w in note_windows(app) {
        let _ = w.hide();
    }
    refresh_tray(app);
}

fn toggle_all(app: &AppHandle) {
    if any_visible(app) {
        hide_all(app)
    } else {
        show_all(app)
    }
}

// ---------- stage ----------
// A note's window can temporarily grow an invisible, click-through "stage" beside the card
// to hold the customize panel and the format bar, so they sit outside the note instead of
// covering it. The card itself does not move.

/// Pick sides with screen room. Keeps the previous side while open so nothing flips mid-use.
fn plan_stage(app: &AppHandle, core: Bounds, old: Stage, side: f64, vert: f64) -> Stage {
    let area = area_at(app, core.x + 20.0, core.y + 20.0);
    let side = clamp(side.round(), 0.0, 600.0);
    let vert = clamp(vert.round(), 0.0, 900.0);
    let mut st = Stage::default();
    if side > 0.0 {
        let room_right = area.x + area.w - (core.x + core.width);
        let room_left = core.x - area.x;
        let use_left = if old.left > 0.0 { true } else if old.right > 0.0 { false } else { room_right < side && room_left > room_right };
        if use_left { st.left = side } else { st.right = side }
    }
    if vert > 0.0 {
        let room_below = area.y + area.h - (core.y + core.height);
        let room_above = core.y - area.y;
        let use_top = if old.top > 0.0 { true } else if old.bottom > 0.0 { false } else { room_below < vert && room_above > room_below };
        if use_top { st.top = vert } else { st.bottom = vert }
    }
    st
}

// ---------- custom right-click menu ----------
// A small Toon-styled window (renderer/menu.html) instead of the native OS menu. Main builds
// the items and keeps the actions; the page only renders.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuContext {
    editable: bool,
    selection: bool,
}

fn build_menu(note: &Note, ctx: &MenuContext, can_paste: bool) -> (Value, HashMap<String, Action>) {
    let m = if cfg!(target_os = "macos") { "\u{2318}" } else { "Ctrl+" };
    let mut items = Vec::new();
    let mut actions = HashMap::new();
    let mut add = |item: Value, action: Option<Action>| {
        if let (Some(a), Some(id)) = (action, item.get("id").and_then(Value::as_str)) {
            actions.insert(id.to_string(), a);
        }
        items.push(item);
    };
    let sep = || json!({ "type": "separator" });
    if ctx.editable {
        add(json!({ "id": "cut", "label": "Cut", "icon": "cut", "hint": format!("{m}X"), "enabled": ctx.selection }), Some(Action::Edit("cut")));
        add(json!({ "id": "copy", "label": "Copy", "icon": "copy", "hint": format!("{m}C"), "enabled": ctx.selection }), Some(Action::Edit("copy")));
        add(json!({ "id": "paste", "label": "Paste", "icon": "paste", "hint": format!("{m}V"), "enabled": can_paste }), Some(Action::Edit("paste")));
        add(json!({ "id": "selectAll", "label": "Select all", "icon": "select", "hint": format!("{m}A") }), Some(Action::Edit("selectAll")));
        add(sep(), None);
    } else if ctx.selection {
        add(json!({ "id": "copy", "label": "Copy", "icon": "copy", "hint": format!("{m}C") }), Some(Action::Edit("copy")));
        add(sep(), None);
    }
    let colors: Vec<Value> = TOON_COLORS.iter().map(|(v, l, c)| json!({ "value": v, "label": l, "color": c })).collect();
    add(json!({ "id": "color", "type": "swatches", "label": "Color", "value": note.color, "options": colors }), Some(Action::Color));
    let tilts: Vec<Value> = TILTS.iter().map(|(l, v)| json!({ "value": v, "label": l })).collect();
    add(json!({ "id": "tilt", "type": "segments", "label": "Tilt", "value": note.tilt, "options": tilts }), Some(Action::Tilt));
    add(sep(), None);
    add(json!({ "id": "pin", "label": "Keep on top", "icon": "pin", "toggle": true, "checked": note.pinned }), Some(Action::Pin));
    add(json!({ "id": "clearInk", "label": "Clear drawing", "icon": "trash", "enabled": !note.strokes.is_empty() }), Some(Action::ClearInk));
    add(json!({ "id": "save", "label": "Save to library", "icon": "bookmark", "hint": format!("{m}S") }), Some(Action::Save));
    add(sep(), None);
    add(json!({ "id": "update", "label": "Check for updates…", "icon": "refresh" }), Some(Action::Update));
    add(sep(), None);
    add(json!({ "id": "new", "label": "New note", "icon": "plus", "hint": format!("{m}N") }), Some(Action::New));
    add(json!({ "id": "close", "label": "Close note", "icon": "x", "hint": format!("{m}W"), "danger": true }), Some(Action::Close));
    let accent = TOON_COLORS.iter().find(|(v, _, _)| *v == note.color).map_or("#FFD84D", |(_, _, c)| c);
    (json!({ "items": items, "accent": accent }), actions)
}

fn ensure_menu_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(MENU_LABEL) {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, MENU_LABEL, WebviewUrl::App("menu.html".into()))
        .title("Menu")
        .inner_size(260.0, 320.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
        .ok()
        .inspect(|w| set_all_spaces(w, true))
}

fn hide_menu(app: &AppHandle) {
    state(app).lock().menu = None;
    if let Some(w) = app.get_webview_window(MENU_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        }
    }
}

// ---------- tray ----------

fn describe(note: &Note) -> String {
    let snippet = note.text.split_whitespace().collect::<Vec<_>>().join(" ");
    let body = if snippet.is_empty() {
        "(drawing)".to_string()
    } else if snippet.chars().count() > 32 {
        format!("{}…", snippet.chars().take(32).collect::<String>())
    } else {
        snippet
    };
    format!("{} — {}", note.title, body)
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let trash: Vec<(String, String)> = state(app)
        .lock()
        .store
        .trash()
        .iter()
        .take(10)
        .map(|n| (format!("restore:{}", n.id), describe(n)))
        .collect();
    let mut recent: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    if trash.is_empty() {
        recent.push(Box::new(MenuItem::with_id(app, "none", "Nothing here", false, None::<&str>)?));
    } else {
        for (id, label) in &trash {
            recent.push(Box::new(MenuItem::with_id(app, id.as_str(), label, true, None::<&str>)?));
        }
        recent.push(Box::new(PredefinedMenuItem::separator(app)?));
        recent.push(Box::new(MenuItem::with_id(app, "clear-trash", "Clear list", true, None::<&str>)?));
    }
    let recent_refs: Vec<&dyn IsMenuItem<Wry>> = recent.iter().map(|b| b.as_ref()).collect();
    let library: Vec<(String, String)> = state(app).lock().store.library().iter().map(|n| (n.id.clone(), describe(n))).collect();
    let mut saved: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    if library.is_empty() {
        saved.push(Box::new(MenuItem::with_id(app, "none", "Right-click a note → Save to library", false, None::<&str>)?));
    } else {
        for (id, label) in &library {
            saved.push(Box::new(MenuItem::with_id(app, format!("open:{id}"), label, true, None::<&str>)?));
        }
        let mut remove: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
        for (id, label) in &library {
            remove.push(Box::new(MenuItem::with_id(app, format!("unsave:{id}"), label, true, None::<&str>)?));
        }
        let remove_refs: Vec<&dyn IsMenuItem<Wry>> = remove.iter().map(|b| b.as_ref()).collect();
        saved.push(Box::new(PredefinedMenuItem::separator(app)?));
        saved.push(Box::new(Submenu::with_items(app, "Remove from library", true, &remove_refs)?));
    }
    let saved_refs: Vec<&dyn IsMenuItem<Wry>> = saved.iter().map(|b| b.as_ref()).collect();
    let toggle_label = if any_visible(app) { "Hide all notes" } else { "Show all notes" };
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "new", "New note", true, Some("CmdOrCtrl+Alt+N"))?,
            &MenuItem::with_id(app, "toggle", toggle_label, true, Some("CmdOrCtrl+Alt+H"))?,
            &PredefinedMenuItem::separator(app)?,
            &Submenu::with_items(app, "Saved notes", true, &saved_refs)?,
            &Submenu::with_items(app, "Recently closed", true, &recent_refs)?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "autostart", "Open at login", true, autostart, None::<&str>)?,
            &MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", format!("Quit {APP_NAME}"), true, None::<&str>)?,
        ],
    )
}

fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    if let Ok(menu) = tray_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => create_note(app, None, ""),
        "toggle" => toggle_all(app),
        "clear-trash" => {
            state(app).lock().store.empty_trash();
            state(app).touch();
            refresh_tray(app);
        }
        "autostart" => {
            let al = app.autolaunch();
            let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
            refresh_tray(app);
        }
        "update" => check_for_updates(app, true),
        "quit" => app.exit(0),
        other => {
            if let Some(nid) = other.strip_prefix("restore:") {
                restore_note(app, nid);
            } else if let Some(sid) = other.strip_prefix("open:") {
                open_saved(app, sid);
            } else if let Some(sid) = other.strip_prefix("unsave:") {
                state(app).lock().store.remove_from_library(sid);
                state(app).touch();
                refresh_tray(app);
            }
        }
    }
}

// ---------- commands: note page ----------

fn note_id(win: &WebviewWindow) -> Option<String> {
    id_for(win.label()).map(str::to_string)
}

#[tauri::command]
fn note_init(window: WebviewWindow, st: State<'_, AppState>) -> Value {
    let note = note_id(&window).and_then(|id| st.lock().store.get(&id).cloned());
    let platform = if cfg!(target_os = "windows") { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    json!({ "note": note, "platform": platform, "theme": "toon" })
}

/// The page has laid out: show the window (and focus it for a brand-new note).
#[tauri::command]
fn note_ready(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>) {
    let (focus, hidden, pinned) = {
        let mut inner = st.lock();
        let focus = inner.focus_pending.remove(window.label());
        let pinned = note_id(&window).and_then(|id| inner.store.get(&id).map(|n| n.pinned)).unwrap_or(false);
        (focus, inner.notes_hidden, pinned)
    };
    if focus {
        let _ = window.show();
        raise(&window, pinned);
        let _ = window.set_focus();
        let _ = app.emit_to(window.label(), "note:focus", ());
    } else if !hidden {
        let _ = window.show();
    }
}

// Async so saves while typing never wait on the UI thread.
#[tauri::command]
async fn note_update(window: WebviewWindow, app: AppHandle, patch: Value) {
    let st = state(&app);
    let Some(id) = note_id(&window) else { return };
    let applied = {
        let mut inner = st.lock();
        let Some(n) = inner.store.get_mut(&id) else { return };
        let applied = n.apply_patch(&patch);
        n.updated_at = store::now_ms();
        applied
    };
    st.touch();
    if let Some(p) = applied.get("pinned").and_then(Value::as_bool) {
        set_on_top(&window, p);
        // Echo the state so the pin icon (filled = on top) never drifts from the window.
        let _ = app.emit_to(window.label(), "note:changed", json!({ "pinned": p }));
    }
    if let Some(t) = applied.get("title").and_then(Value::as_str) {
        let _ = window.set_title(t);
    }
    // No tray refresh: the tray lists only closed notes, and rebuilding the native menu on
    // every keystroke save made typing stutter.
}

#[tauri::command]
async fn note_close(window: WebviewWindow, app: AppHandle) {
    if let Some(id) = note_id(&window) {
        close_note(&app, &id);
    }
}

// Window-creating commands are async: building a window from a sync command can deadlock
// on Windows.
#[tauri::command]
async fn note_new(window: WebviewWindow, app: AppHandle) {
    create_note(&app, Some(&window), "");
}

/// Resize from any edge or corner, following the OS cursor (like the drag, because page
/// screen coordinates differ between WebView2 and WebKit). `dx`/`dy` pick the edge: -1, 0, 1.
#[tauri::command]
fn note_resize_start(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>, dx: i8, dy: i8) {
    let (Ok(c), Ok(p), Ok(z), Ok(s)) = (app.cursor_position(), window.outer_position(), window.outer_size(), window.scale_factor()) else {
        return;
    };
    let mut inner = st.lock();
    let g = inner.stages.get(window.label()).copied().unwrap_or_default();
    let min = ((MIN_SIZE.0 + g.left + g.right) * s, (MIN_SIZE.1 + g.top + g.bottom) * s);
    let r = Resize { cursor: (c.x, c.y), pos: (p.x, p.y), size: (z.width as f64, z.height as f64), edge: (dx.signum(), dy.signum()), min };
    inner.resizes.insert(window.label().to_string(), r);
}

#[tauri::command]
fn note_resize_move(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>) {
    let Ok(c) = app.cursor_position() else { return };
    let (pos, size) = {
        let inner = st.lock();
        let Some(r) = inner.resizes.get(window.label()) else { return };
        // One axis: the new length, and how far the window's origin moves for a left/top edge.
        let axis = |edge: i8, delta: f64, len: f64, min: f64| -> (f64, f64) {
            let l = (len + delta * edge as f64).max(min).round();
            (l, if edge < 0 { len - l } else { 0.0 })
        };
        let (w, sx) = axis(r.edge.0, c.x - r.cursor.0, r.size.0, r.min.0);
        let (h, sy) = axis(r.edge.1, c.y - r.cursor.1, r.size.1, r.min.1);
        (PhysicalPosition::new(r.pos.0 + sx as i32, r.pos.1 + sy as i32), tauri::PhysicalSize::new(w as u32, h as u32))
    };
    let _ = window.set_size(size);
    let _ = window.set_position(pos);
}

#[tauri::command]
fn note_resize_end(window: WebviewWindow, st: State<'_, AppState>) {
    st.lock().resizes.remove(window.label());
}

#[tauri::command]
async fn note_save(window: WebviewWindow, app: AppHandle) {
    if let Some(id) = note_id(&window) {
        save_note(&app, &id);
    }
}

/// Resize around the window's center (rotating keeps the card in place).
#[tauri::command]
fn note_resize_centered(window: WebviewWindow, st: State<'_, AppState>, width: f64, height: f64) {
    if !width.is_finite() || !height.is_finite() {
        return;
    }
    let Some(b) = win_bounds(&window) else { return };
    let s = st.lock().stages.get(window.label()).copied().unwrap_or_default();
    let w = width.round().max(MIN_SIZE.0 + s.left + s.right);
    let h = height.round().max(MIN_SIZE.1 + s.top + s.bottom);
    set_win_bounds(&window, Bounds { x: b.x + (b.width - w) / 2.0, y: b.y + (b.height - h) / 2.0, width: w, height: h });
}

/// Manual window drag (keeps the drag sway animation on rotated notes). Done here from the
/// OS cursor because page screen coordinates differ between WebView2 and WebKit (macOS).
#[tauri::command]
fn note_drag_start(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>) {
    let (Ok(c), Ok(p)) = (app.cursor_position(), window.outer_position()) else { return };
    let drag = Drag { cursor: (c.x, c.y), win: (p.x, p.y), last_x: c.x };
    st.lock().drags.insert(window.label().to_string(), drag);
}

/// Follow the cursor; returns its sideways step since the last call (CSS px) for the sway.
#[tauri::command]
fn note_drag_move(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>) -> f64 {
    let Ok(c) = app.cursor_position() else { return 0.0 };
    let (pos, step) = {
        let mut inner = st.lock();
        let Some(d) = inner.drags.get_mut(window.label()) else { return 0.0 };
        let pos = PhysicalPosition::new(
            d.win.0 + (c.x - d.cursor.0).round() as i32,
            d.win.1 + (c.y - d.cursor.1).round() as i32,
        );
        let step = c.x - d.last_x;
        d.last_x = c.x;
        (pos, step)
    };
    let _ = window.set_position(pos);
    step / window.scale_factor().unwrap_or(1.0)
}

#[tauri::command]
fn note_drag_end(window: WebviewWindow, st: State<'_, AppState>) {
    st.lock().drags.remove(window.label());
}

#[derive(Deserialize)]
struct StageReq {
    side: f64,
    vert: f64,
}

/// Reply with the planned stage first, then resize: the page needs the new insets before
/// the resize event arrives so its layout never uses a mismatched pair.
#[tauri::command]
fn note_stage(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>, req: StageReq) -> Stage {
    let old = st.lock().stages.get(window.label()).copied().unwrap_or_default();
    let Some(core) = core_bounds(&window, old) else { return old };
    let new = plan_stage(&app, core, old, req.side, req.vert);
    st.lock().stages.insert(window.label().to_string(), new);
    let w = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(16));
        set_win_bounds(&w, Bounds {
            x: core.x - new.left,
            y: core.y - new.top,
            width: core.width + new.left + new.right,
            height: core.height + new.top + new.bottom,
        });
    });
    new
}

#[tauri::command]
fn note_passthrough(window: WebviewWindow, ignore: bool) {
    let _ = window.set_ignore_cursor_events(ignore);
}

#[tauri::command]
async fn note_menu(window: WebviewWindow, app: AppHandle, ctx: MenuContext) {
    let Some(id) = note_id(&window) else { return };
    let can_paste = ctx.editable
        && arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_or(false, |t| !t.is_empty());
    let Some(note) = state(&app).lock().store.get(&id).cloned() else { return };
    let (spec, actions) = build_menu(&note, &ctx, can_paste);
    let at = app.cursor_position().map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0));
    state(&app).lock().menu = Some(MenuState { owner: window.label().to_string(), actions, at, spec: spec.clone() });
    // A fresh menu window asks for its spec on load (menu_pending); an existing one gets an event.
    if app.get_webview_window(MENU_LABEL).is_some() {
        let _ = app.emit_to(MENU_LABEL, "menu:show", spec);
    } else {
        ensure_menu_window(&app);
    }
}

#[tauri::command]
fn set_theme() {} // Toonii ships one style

// ---------- commands: menu page ----------

#[tauri::command]
fn menu_pending(st: State<'_, AppState>) -> Option<Value> {
    st.lock().menu.as_ref().map(|m| m.spec.clone())
}

/// The page measured itself: place the window at the cursor, flipped to stay on screen.
#[tauri::command]
fn menu_ready(window: WebviewWindow, app: AppHandle, st: State<'_, AppState>, width: f64, height: f64) {
    let Some((px, py)) = st.lock().menu.as_ref().map(|m| m.at) else { return };
    if !width.is_finite() || !height.is_finite() {
        return;
    }
    let mon = app.monitor_from_point(px, py).ok().flatten();
    let scale = mon.as_ref().map_or(1.0, |m| m.scale_factor());
    let area = mon.as_ref().map(monitor_area).unwrap_or(Area { x: 0.0, y: 0.0, w: 1e5, h: 1e5 });
    let (ax, ay) = (px / scale, py / scale);
    let w = width.round() + MENU_PAD * 2.0;
    let h = height.round() + MENU_PAD * 2.0;
    let mut x = ax - MENU_PAD;
    let mut y = ay - MENU_PAD;
    if x + w > area.x + area.w {
        x = ax - w + MENU_PAD;
    }
    if y + h > area.y + area.h {
        y = ay - h + MENU_PAD;
    }
    x = clamp(x, area.x - MENU_PAD, area.x + area.w - w + MENU_PAD);
    y = clamp(y, area.y - MENU_PAD, area.y + area.h - h + MENU_PAD);
    set_win_bounds(&window, Bounds { x, y, width: w, height: h });
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
}

#[tauri::command]
async fn menu_pick(app: AppHandle, id: String, value: Option<Value>) {
    let picked = {
        let st = state(&app);
        let mut inner = st.lock();
        inner.menu.take().and_then(|m| m.actions.get(&id).cloned().map(|a| (m.owner, a)))
    };
    hide_menu(&app);
    let Some((owner, action)) = picked else { return };
    let Some(win) = app.get_webview_window(&owner) else { return };
    let Some(nid) = id_for(&owner).map(str::to_string) else { return };
    match action {
        Action::Edit(cmd) => {
            // Edit commands run in the note page; give it focus back first.
            let _ = win.set_focus();
            let text = if cmd == "paste" { arboard::Clipboard::new().and_then(|mut c| c.get_text()).ok() } else { None };
            let _ = app.emit_to(owner.as_str(), "menu:edit", json!({ "cmd": cmd, "text": text }));
        }
        Action::Color => {
            if let Some(c) = value.as_ref().and_then(Value::as_str).filter(|c| COLOR_IDS.contains(c)) {
                set_note_props(&app, &nid, json!({ "color": c }));
            }
        }
        Action::Tilt => {
            if let Some(t) = value.as_ref().and_then(Value::as_f64).filter(|t| TILTS.iter().any(|(_, v)| v == t)) {
                set_note_props(&app, &nid, json!({ "tilt": t }));
            }
        }
        Action::Pin => {
            let pinned = state(&app).lock().store.get(&nid).map_or(false, |n| n.pinned);
            set_note_props(&app, &nid, json!({ "pinned": !pinned }));
        }
        Action::ClearInk => set_note_props(&app, &nid, json!({ "strokes": [] })),
        Action::Save => save_note(&app, &nid),
        Action::Update => check_for_updates(&app, true),
        Action::New => create_note(&app, Some(&win), ""),
        Action::Close => close_note(&app, &nid),
    }
}

#[tauri::command]
fn menu_close(app: AppHandle) {
    hide_menu(&app);
}

// ---------- background loops ----------

/// Writes notes.json at most every 250 ms while something changed.
fn spawn_saver(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let st = state(&app);
        if st.dirty.swap(false, Ordering::Relaxed) {
            // Only the snapshot holds the lock; the disk write must not stall drags or typing.
            let snap = st.lock().store.snapshot();
            if let Some((file, json)) = snap {
                store::write_atomic(&file, &json);
            }
        }
    });
}

/// Googly eyes follow the mouse anywhere on screen: stream the cursor to visible notes in
/// each window's own coordinates. The page also uses it to take clicks back after a
/// click-through stretch, since a click-through window gets no mouse events.
fn spawn_cursor_feed(app: AppHandle) {
    thread::spawn(move || {
        let mut last = (f64::NAN, f64::NAN);
        loop {
            thread::sleep(Duration::from_millis(40));
            let Ok(p) = app.cursor_position() else { continue };
            if p.x == last.0 && p.y == last.1 {
                continue;
            }
            last = (p.x, p.y);
            for w in note_windows(&app) {
                if !w.is_visible().unwrap_or(false) {
                    continue;
                }
                let (Ok(pos), Ok(s)) = (w.outer_position(), w.scale_factor()) else { continue };
                let cx = (p.x - pos.x as f64) / s;
                let cy = (p.y - pos.y as f64) / s;
                let _ = app.emit_to(w.label(), "app:cursor", (cx, cy));
            }
        }
    });
}

// ---------- setup ----------

/// The app used to be called Stickynotee, so its notes may live in that folder. Copy them
/// over once; the old folder is left untouched as a backup.
fn migrate_legacy(base: &std::path::Path, dir: &std::path::Path) {
    let target = dir.join("notes.json");
    if target.exists() {
        return;
    }
    for name in LEGACY_DATA_DIRS {
        let old = base.join(name).join("notes.json");
        if old.exists() && old.to_string_lossy().to_lowercase() != target.to_string_lossy().to_lowercase() {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::copy(&old, &target);
            return;
        }
    }
}

fn main() {
    // Ctrl+Alt on Windows, Cmd+Option on macOS (matches the tray's CmdOrCtrl+Alt hints).
    let mods = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::ALT } else { Modifiers::CONTROL | Modifiers::ALT };
    let new_shortcut = Shortcut::new(Some(mods), Code::KeyN);
    let toggle_shortcut = Shortcut::new(Some(mods), Code::KeyH);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_all(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &new_shortcut {
                        create_note(app, None, "");
                    } else if shortcut == &toggle_shortcut {
                        toggle_all(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // A tray app like on Windows: no Dock icon, no app menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            let base = app.path().data_dir()?;
            // TOONII_DATA_DIR points a test run at throwaway notes.
            let dir = std::env::var_os("TOONII_DATA_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| base.join(DATA_DIR));
            migrate_legacy(&base, &dir);
            app.manage(AppState {
                inner: Mutex::new(Inner {
                    store: Store::load(&dir),
                    stages: HashMap::new(),
                    focus_pending: HashSet::new(),
                    drags: HashMap::new(),
                    resizes: HashMap::new(),
                    notes_hidden: false,
                    menu: None,
                }),
                dirty: AtomicBool::new(false),
            });

            for sc in [new_shortcut, toggle_shortcut] {
                if app.global_shortcut().register(sc).is_err() {
                    eprintln!("Shortcut {sc:?} is taken by another app");
                }
            }

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip(APP_NAME)
                .menu(&tray_menu(&handle)?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| on_tray_menu(app, event.id().as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_all(tray.app_handle());
                    }
                })
                .build(app)?;

            spawn_saver(handle.clone());
            spawn_cursor_feed(handle.clone());
            spawn_update_checks(handle.clone());

            let notes: Vec<Note> = state(&handle).lock().store.all().to_vec();
            if notes.is_empty() {
                let hint = if cfg!(target_os = "macos") { "\u{2318}\u{2325}N" } else { "Ctrl+Alt+N" };
                create_note(&handle, None, &format!("Hi! Drag me by the top bar.\n{hint} makes a new note."));
            } else {
                for n in &notes {
                    open_window(&handle, n, false);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let label = window.label().to_string();
            if label == MENU_LABEL {
                // Only a shown menu closes on blur: the hidden window can lose focus while it
                // is being created, before its page has read the pending menu.
                if let WindowEvent::Focused(false) = event {
                    if window.is_visible().unwrap_or(false) {
                        hide_menu(app);
                    }
                }
                return;
            }
            let Some(id) = id_for(&label).map(str::to_string) else { return };
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    let Some(win) = app.get_webview_window(&label) else { return };
                    let st = state(app);
                    let stage = st.lock().stages.get(&label).copied().unwrap_or_default();
                    if let Some(b) = core_bounds(&win, stage) {
                        if let Some(n) = st.lock().store.get_mut(&id) {
                            n.bounds = Some(b);
                        }
                        st.touch();
                    }
                }
                WindowEvent::Destroyed => {
                    let st = state(app);
                    let mut inner = st.lock();
                    inner.stages.remove(&label);
                    inner.focus_pending.remove(&label);
                    inner.drags.remove(&label);
                    inner.resizes.remove(&label);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            note_init,
            note_ready,
            note_update,
            note_close,
            note_new,
            note_resize_start,
            note_resize_move,
            note_resize_end,
            note_resize_centered,
            note_save,
            note_drag_start,
            note_drag_move,
            note_drag_end,
            note_stage,
            note_passthrough,
            note_menu,
            set_theme,
            menu_pending,
            menu_ready,
            menu_pick,
            menu_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building Toonii");

    app.run(|app, event| match event {
        // Notes live in the tray: closing every window must not quit the app.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(st) = app.try_state::<AppState>() {
                st.lock().store.save_now();
            }
        }
        _ => {}
    });
}

