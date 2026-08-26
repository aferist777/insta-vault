/* Everything the app remembers lives here, in localStorage.
 *
 * The server only downloads files; this store is the archive index, the
 * settings, the panel layout and the editor projects. media/<shortcode>/meta.json
 * on disk is the backup copy — Vault → Rescan rebuilds this store from it.
 */
const KEY = "instavault:v1";

const DEFAULTS = () => ({
  version: 1,
  posts: {},          // shortcode -> record (+ tags, notes)
  assets: {},         // id -> asset record (E2)
  projects: {},       // id -> editor project (E1)
  lastProject: null,
  layouts: [],        // saved track layouts: {id, name, tracks:[{kind,name,height}]}
  lastLayout: "",
  trackNames: { video: [], audio: [], text: [] },   // global naming scheme, by position from the sash
  settings: {
    cookies_browser: "",
    ig_username: "",
    skip_existing: true,
    card_size: "s",
    sort: "saved_desc",
    kinds: [],          // the filter column's ticks, kept between sessions
    tags: [],
    preview_quality: "auto",
    canvas_w: 1080,
    canvas_h: 1920,
    canvas_fps: 30,
    speech_engine: "groq",      // groq by default; local takes over once installed and chosen
    speech_model: "small",      // tiny | base | small | medium | large-v3
    speech_device: "auto",      // auto | cpu | cuda
    speech_language: "",        // "" = detect
    sub_offset: 0,              // seconds a subtitle sits before (−) or after (+) its first word
    sub_wrap: 34,               // characters per line before it breaks
    sub_words: 0,               // words per card; 0 keeps the phrases as spoken
    sub_move_same: true,        // dragging one subtitle puts the rest in the same place
    sub_font: "Montserrat",     // the family subtitles are set in
    export_keys: false,         // keys stay out of the backup file unless asked
  },
  // Provider keys. They never touch the server's disk: the client sends the one
  // key a job needs along with that job, the same way cookies already travel.
  keys: { kie: "", replicate: "", openrouter: "", imgbb: "", groq: "", elevenlabs: "" },
  layout: {
    lib: 260,         // left pane width, px
    props: 300,       // middle pane width, px
    timeline: 260,    // timeline height, px
    audio: 110,       // audio zone height inside the timeline, px
    text: 60,         // text zone height, px
    head: 92,         // track head column width, px
    ai_left: 260,     // settings column in the AI tool popup, px
    scen_note: 180,   // how much of the character column the style's description takes
  },
});

const Store = {
  data: DEFAULTS(),
  quotaWarned: false,

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = { ...DEFAULTS(), ...JSON.parse(raw) };
      this.data.settings = { ...DEFAULTS().settings, ...this.data.settings };
      this.data.layout = { ...DEFAULTS().layout, ...this.data.layout };
      this.data.keys = { ...DEFAULTS().keys, ...this.data.keys };
    } catch (e) {
      console.warn("Store: could not parse saved data, starting fresh", e);
      this.data = DEFAULTS();
    }
    return this.data;
  },

  _saveTimer: null,
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 60);
  },

  saveNow() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      if (!this.quotaWarned) {
        this.quotaWarned = true;
        alert(
          "Browser storage is full — the newest changes were not saved.\n" +
          "Delete some posts, or export the index from the Vault menu."
        );
      }
      console.error("Store: save failed", e);
    }
  },

  /* ---------------- settings & layout ---------------- */

  get settings() { return this.data.settings; },
  setSetting(key, value) { this.data.settings[key] = value; this.save(); },

  get layout() { return this.data.layout; },
  setLayout(key, value) { this.data.layout[key] = Math.round(value); this.save(); },

  get keys() { return this.data.keys; },
  setKey(provider, value) { this.data.keys[provider] = value.trim(); this.save(); },

  /* ---------------- posts ---------------- */

  upsertPost(rec) {
    const prev = this.data.posts[rec.shortcode] || {};
    this.data.posts[rec.shortcode] = {
      ...rec,
      tags: prev.tags || [],
      notes: prev.notes || "",
      saved_at: prev.saved_at || Math.floor(Date.now() / 1000),
    };
    this.save();
  },

  updatePost(shortcode, fields) {
    const post = this.data.posts[shortcode];
    if (!post) return null;
    Object.assign(post, fields);
    this.save();
    return post;
  },

  removePost(shortcode) { delete this.data.posts[shortcode]; this.save(); },

  getPost(shortcode) { return this.data.posts[shortcode] || null; },

  knownShortcodes() { return Object.keys(this.data.posts); },

  /* A shop's filter panel, in one function: several boxes may be ticked inside a
   * group and any of them will do, while a post has to satisfy every group that
   * has anything ticked at all. `kinds` are the app's own words for a shape —
   * "reel" and "photo" — because a carousel of pictures is a photo to anyone
   * looking for one, whatever Instagram calls it. */
  listPosts({ q = "", kinds = [], tags = [], sort = "saved_desc" } = {}) {
    const needle = q.trim().toLowerCase();
    let posts = Object.values(this.data.posts);
    if (needle) {
      posts = posts.filter((p) =>
        [p.caption, p.owner, p.notes, (p.hashtags || []).join(" "), (p.tags || []).join(" ")]
          .join(" ").toLowerCase().includes(needle));
    }
    if (kinds.length) posts = posts.filter((p) => kinds.includes(this.kindOf(p)));
    if (tags.length) posts = posts.filter((p) => (p.tags || []).some((t) => tags.includes(t)));
    const dir = sort.endsWith("_asc") ? 1 : -1;
    const field = sort.startsWith("taken") ? "taken_at" : "saved_at";
    return posts.sort((a, b) => ((a[field] || 0) - (b[field] || 0)) * dir);
  },

  kindOf(post) { return post.type === "video" ? "reel" : "photo"; },

  allTags() {
    const tags = new Set();
    Object.values(this.data.posts).forEach((p) => (p.tags || []).forEach((t) => tags.add(t)));
    return [...tags].sort();
  },

  stats() {
    const out = { total: 0 };
    Object.values(this.data.posts).forEach((p) => {
      out.total++;
      out[p.type] = (out[p.type] || 0) + 1;
    });
    return out;
  },

  /* ---------------- projects (editor) ---------------- */

  /** Name a track by its position, honouring the global scheme. */
  trackNameFor(kind, index) {
    const letter = kind === "video" ? "V" : kind === "text" ? "T" : "A";
    return (this.data.trackNames?.[kind] || [])[index] || letter + (index + 1);
  },

  setTrackName(kind, index, name) {
    if (!this.data.trackNames[kind]) this.data.trackNames[kind] = [];
    this.data.trackNames[kind][index] = name;
    this.save();
  },

  newProject(name = "Untitled") {
    const id = "p" + Date.now().toString(36);
    this.data.projects[id] = {
      id,
      name,
      created_at: Date.now(),
      updated_at: Date.now(),
      canvas: {
        w: this.data.settings.canvas_w || 1080,
        h: this.data.settings.canvas_h || 1920,
        fps: this.data.settings.canvas_fps || 30,
      },
      tracks: [
        { id: "v1", kind: "video", name: this.trackNameFor("video", 0), muted: false, locked: false, clips: [] },
        { id: "a1", kind: "audio", name: this.trackNameFor("audio", 0), muted: false, locked: false, clips: [] },
      ],
    };
    this.data.lastProject = id;
    this.save();
    return this.data.projects[id];
  },

  getProject(id) { return this.data.projects[id] || null; },
  listProjects() {
    return Object.values(this.data.projects).sort((a, b) => b.updated_at - a.updated_at);
  },
  touchProject(project) {
    project.updated_at = Date.now();
    this.data.projects[project.id] = project;
    this.data.lastProject = project.id;
    this.save();
  },
  removeProject(id) {
    delete this.data.projects[id];
    if (this.data.lastProject === id) this.data.lastProject = null;
    this.save();
  },

  /* ---------------- track layouts ---------------- */

  listLayouts() { return this.data.layouts || []; },

  saveLayout(id, tracks) {
    const found = (this.data.layouts || []).find((l) => l.id === id);
    if (!found) return null;
    found.tracks = tracks;
    this.save();
    return found;
  },

  addLayout(name, tracks) {
    const layout = { id: "ly" + Date.now().toString(36), name, tracks };
    this.data.layouts.push(layout);
    this.data.lastLayout = layout.id;
    this.save();
    return layout;
  },

  removeLayout(id) {
    this.data.layouts = (this.data.layouts || []).filter((l) => l.id !== id);
    if (this.data.lastLayout === id) this.data.lastLayout = "";
    this.save();
  },

  /* ---------------- assets (E2) ---------------- */

  upsertAsset(asset) { this.data.assets[asset.id] = asset; this.save(); },
  listAssets(kind = "") {
    const all = Object.values(this.data.assets);
    return kind ? all.filter((a) => a.kind === kind) : all;
  },
  removeAsset(id) { delete this.data.assets[id]; this.save(); },

  /* ---------------- backup ---------------- */

  /** A backup leaves the API keys behind unless the user asks for them —
   *  the file usually ends up somewhere far less private than this machine. */
  exportAll() {
    if (this.data.settings.export_keys) return JSON.stringify(this.data, null, 2);
    return JSON.stringify({ ...this.data, keys: DEFAULTS().keys }, null, 2);
  },

  importAll(json) {
    const kept = this.data.keys;
    this.data = { ...DEFAULTS(), ...JSON.parse(json) };
    // a backup normally carries no keys, and that must not wipe the ones here
    this.data.keys = { ...DEFAULTS().keys, ...this.data.keys };
    Object.entries(kept).forEach(([k, v]) => { if (v && !this.data.keys[k]) this.data.keys[k] = v; });
    this.saveNow();
  },
};

Store.load();
