//! Notes persistence: one JSON file, same format as the Electron version so existing notes
//! carry over. Writes are debounced by the caller (`dirty` flag) and atomic (tmp + rename).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TRASH_LIMIT: usize = 20;
pub const NOTE_FONTS: [&str; 5] = ["sans", "serif", "mono", "hand", "marker"];
pub const COLOR_IDS: [&str; 6] = ["yellow", "blue", "green", "pink", "purple", "gray"];
pub const MAX_TILT: f64 = 15.0;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub color: String,
    pub mode: String,
    pub text: String,
    pub html: Option<String>, // None = legacy plain-text note
    pub tilt: f64,
    pub font_base: Option<f64>,   // frozen text size once sized by hand
    pub line_height: Option<f64>, // None = style default
    pub font: Option<String>,     // note-wide font; None = style default
    pub font_pinned: bool,        // user picked fontBase in the panel (auto-fit off)
    pub strokes: Vec<Value>,
    pub pinned: bool,
    pub bounds: Option<Bounds>,
    pub created_at: f64,
    pub updated_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<f64>,
}

impl Default for Note {
    fn default() -> Self {
        let now = now_ms();
        Note {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Note".into(),
            color: "yellow".into(),
            mode: "type".into(),
            text: String::new(),
            html: None,
            tilt: 0.0,
            font_base: None,
            line_height: None,
            font: None,
            font_pinned: false,
            strokes: Vec::new(),
            pinned: false,
            bounds: None,
            created_at: now,
            updated_at: now,
            closed_at: None,
        }
    }
}

impl Note {
    pub fn has_content(&self) -> bool {
        !self.text.trim().is_empty() || !self.strokes.is_empty()
    }

    /// Apply a patch from the page, keeping only valid fields. Returns the applied fields.
    pub fn apply_patch(&mut self, patch: &Value) -> Map<String, Value> {
        let mut out = Map::new();
        let Some(p) = patch.as_object() else { return out };
        let num = |k: &str| p.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
        let is_null = |k: &str| p.get(k).map_or(false, Value::is_null);

        if let Some(t) = p.get("title").and_then(Value::as_str) {
            self.title = t.chars().take(80).collect();
            out.insert("title".into(), self.title.clone().into());
        }
        if let Some(t) = p.get("text").and_then(Value::as_str) {
            self.text = t.chars().take(200_000).collect();
            out.insert("text".into(), Value::Null); // not echoed
        }
        if let Some(h) = p.get("html").and_then(Value::as_str) {
            if h.len() <= 1_000_000 {
                self.html = Some(h.to_string());
                out.insert("html".into(), Value::Null);
            }
        }
        if let Some(t) = num("tilt") {
            self.tilt = ((t * 2.0).round() / 2.0).clamp(-MAX_TILT, MAX_TILT);
            out.insert("tilt".into(), self.tilt.into());
        }
        if is_null("fontBase") {
            self.font_base = None;
            out.insert("fontBase".into(), Value::Null);
        } else if let Some(v) = num("fontBase").filter(|v| (8.0..=96.0).contains(v)) {
            self.font_base = Some(v);
            out.insert("fontBase".into(), v.into());
        }
        if is_null("lineHeight") {
            self.line_height = None;
            out.insert("lineHeight".into(), Value::Null);
        } else if let Some(v) = num("lineHeight").filter(|v| (0.9..=2.5).contains(v)) {
            self.line_height = Some(v);
            out.insert("lineHeight".into(), v.into());
        }
        if is_null("font") {
            self.font = None;
            out.insert("font".into(), Value::Null);
        } else if let Some(f) = p.get("font").and_then(Value::as_str).filter(|f| NOTE_FONTS.contains(f)) {
            self.font = Some(f.to_string());
            out.insert("font".into(), f.into());
        }
        if let Some(b) = p.get("fontPinned").and_then(Value::as_bool) {
            self.font_pinned = b;
            out.insert("fontPinned".into(), b.into());
        }
        if let Some(s) = p.get("strokes").and_then(Value::as_array) {
            self.strokes = s.iter().take(5000).cloned().collect();
            out.insert("strokes".into(), Value::Null);
        }
        if let Some(m) = p.get("mode").and_then(Value::as_str).filter(|m| *m == "type" || *m == "draw") {
            self.mode = m.to_string();
            out.insert("mode".into(), m.into());
        }
        if let Some(c) = p.get("color").and_then(Value::as_str).filter(|c| COLOR_IDS.contains(c)) {
            self.color = c.to_string();
            out.insert("color".into(), c.into());
        }
        if let Some(b) = p.get("pinned").and_then(Value::as_bool) {
            self.pinned = b;
            out.insert("pinned".into(), b.into());
        }
        out
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Data {
    version: u32,
    next_number: u64,
    notes: Vec<Note>,
    trash: Vec<Note>,
    settings: Map<String, Value>,
}

pub struct Store {
    file: PathBuf,
    data: Data,
}

// New notes get a playful two-word name ("Velvet Comet") instead of "Note 7".
const NAME_ADJECTIVES: &[&str] = &[
    "Velvet", "Cosmic", "Gilded", "Moonlit", "Fizzy", "Sunny", "Dreamy", "Crimson", "Misty",
    "Jolly", "Sparkly", "Breezy", "Lucky", "Wild", "Cozy", "Golden", "Silver", "Starry", "Bubbly",
    "Dapper", "Nimble", "Mellow", "Zesty", "Twinkly", "Peachy", "Frosty", "Radiant", "Sleepy",
    "Brave", "Witty", "Gentle", "Electric", "Secret", "Hidden", "Quiet", "Merry", "Plucky",
    "Lunar", "Solar", "Amber", "Ivory", "Emerald", "Sapphire", "Coral", "Rosy", "Minty",
];
const NAME_NOUNS: &[&str] = &[
    "Comet", "Pickle", "Lantern", "Nebula", "Muffin", "Otter", "Pebble", "Meadow", "Sprout",
    "Biscuit", "Firefly", "Marble", "Teacup", "Willow", "Falcon", "Mango", "Thimble", "Breeze",
    "Doodle", "Pancake", "Harbor", "Raven", "Clover", "Tulip", "Echo", "Penguin", "Saturn",
    "Waffle", "Orbit", "Badger", "Cupcake", "Riddle", "Bloom", "Ember", "Quill", "Galaxy",
    "Noodle", "Puffin", "Pinecone", "Rocket", "Sonnet", "Compass", "Koala", "Maple", "Jellybean",
];

fn pick(list: &[&str]) -> String {
    list[fastrand::usize(..list.len())].to_string()
}

impl Store {
    pub fn load(dir: &Path) -> Store {
        let file = dir.join("notes.json");
        let data = match fs::read_to_string(&file) {
            Ok(raw) => match serde_json::from_str::<Data>(&raw) {
                Ok(mut d) => {
                    d.version = 1;
                    if d.next_number == 0 {
                        d.next_number = 1;
                    }
                    d
                }
                Err(_) => {
                    // Keep the unreadable file so nothing is silently lost.
                    let _ = fs::copy(&file, dir.join(format!("notes.json.corrupt-{}", now_ms() as u64)));
                    Data { version: 1, next_number: 1, ..Default::default() }
                }
            },
            Err(_) => Data { version: 1, next_number: 1, ..Default::default() },
        };
        Store { file, data }
    }

    pub fn save_now(&self) {
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string(&self.data) {
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, &self.file);
            }
        }
    }

    pub fn all(&self) -> &[Note] {
        &self.data.notes
    }
    pub fn trash(&self) -> &[Note] {
        &self.data.trash
    }
    pub fn get(&self, id: &str) -> Option<&Note> {
        self.data.notes.iter().find(|n| n.id == id)
    }
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Note> {
        self.data.notes.iter_mut().find(|n| n.id == id)
    }

    fn fancy_name(&self) -> String {
        for _ in 0..50 {
            let name = format!("{} {}", pick(NAME_ADJECTIVES), pick(NAME_NOUNS));
            if !self.data.notes.iter().any(|n| n.title == name) {
                return name;
            }
        }
        format!("{} {} {}", pick(NAME_ADJECTIVES), pick(NAME_NOUNS), self.data.next_number)
    }

    pub fn create(&mut self, mut note: Note) -> Note {
        note.title = self.fancy_name();
        self.data.next_number += 1;
        self.data.notes.push(note.clone());
        note
    }

    /// Remove a note. Notes with content go to "Recently closed"; empty ones vanish.
    pub fn discard(&mut self, id: &str) {
        if let Some(i) = self.data.notes.iter().position(|n| n.id == id) {
            let mut note = self.data.notes.remove(i);
            if note.has_content() {
                note.closed_at = Some(now_ms());
                self.data.trash.insert(0, note);
                self.data.trash.truncate(TRASH_LIMIT);
            }
        }
    }

    pub fn restore(&mut self, id: &str) -> Option<Note> {
        let i = self.data.trash.iter().position(|n| n.id == id)?;
        let mut note = self.data.trash.remove(i);
        note.closed_at = None;
        self.data.notes.push(note.clone());
        Some(note)
    }

    pub fn empty_trash(&mut self) {
        self.data.trash.clear();
    }
}
