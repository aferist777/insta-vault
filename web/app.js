const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
const post = (url, body) => api(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const state = {
  selected: new Set(),
  pickedKinds: new Set(),   // "reel" / "photo" — several may be on at once
  pickedTags: new Set(),
  current: null,      // post open in the viewer
  mediaIndex: 0,
  pollTimer: null,
  tickTimer: null,
  project: null,      // editor project
  libSource: "vault",
  pps: 60,            // timeline pixels per second
  playhead: 0,
  selectedClips: new Set(),
  selectedTrack: null,
  propGroup: { clip: "quick" },   // which group is open per inspector kind; a clip opens on its actions
  subStyleTab: "type",            // which handful of style settings is on screen
  fonts: null,        // font registry, read once per session
  leadDrag: false,    // the offset slider is being dragged: one undo step for the gesture
  styleDrag: false,   // same, for the style sliders that redraw as they move
  libAudio: null,     // library entry being listened to, if any
  previewAt: null,    // preview shows this moment instead of the playhead
  presetSpeed: "normal",  // how fast an animation preset runs
  presetCurve: "auto",    // "auto" keeps each preset's own easing
  paths: null,        // where the app keeps things on disk, for the Info group
  status: "",         // last applied change, echoed in the properties panel
  history: [],        // JSON snapshots for undo
  future: [],         // …and redo
  snap: true,
  dragPayload: null,  // library item being dragged onto the timeline
  clipboard: null,    // copied clips, pasted at the playhead
  playing: false,     // preview transport
  scrubbing: false,   // playhead being dragged — Auto quality drops while true
  raf: 0,
  frameQueued: false,
  frameTimer: null,   // the fallback that paints when no animation frame comes
  ai: null,           // the AI tool popup: which tool, which fragment, what to ask for
  trimPeek: null,     // where the playhead was before an edge borrowed it
  grab: null,         // a face or a character being taken out of the archive viewer
  faces: [],          // the face library, read from the server when a tool opens
  faceFilter: "all",  // all | random | uploaded
  characters: [],     // the character library — portraits, head to torso
  shelf: "faces",     // which shelf the Library tab is showing
  shelfBench: null,   // a candidate being framed there, when nothing is selected
  scenarios: [],      // the scripts shelf, read from the server
  looks: null,        // styles a character can be redrawn in, and what redraws them
  scen: null,         // the scenario popup: which step it is on and what it holds
  jobs: [],           // generations in flight, whoever is or is not watching
  imgView: null,      // a drawing being looked at full size
  shelfPick: null,    // and which entry on it is being looked at
};

/* ====================== views ====================== */

function setView(view) {
  if (view !== "editor" && state.playing) stopPlayback();
  document.body.dataset.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
  $("referencesView").classList.toggle("hidden", view !== "references");
  $("libraryView").classList.toggle("hidden", view !== "library");
  $("scenariosView").classList.toggle("hidden", view !== "scenarios");
  $("editorView").classList.toggle("hidden", view !== "editor");
  if (view === "editor") openEditor();
  if (view === "library") openShelves();
  if (view === "scenarios") loadScenarios().then(renderScenList);
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => setView(t.dataset.view)));

/* ====================== the library tab ======================
 *
 *  Faces and characters used to be reachable only with a clip selected and a
 *  tool open, which is backwards: a reference outlives any one fragment. Here
 *  they are the subject rather than an accessory — looked through, renamed and
 *  thrown out without an editor in sight. */

const SHELVES = {
  faces: { title: "Faces", api: "faces", key: "faces", load: () => loadFaces(),
           filters: true, one: "face" },
  characters: { title: "Characters", api: "characters", key: "characters",
                load: () => loadCharacters(), filters: false, one: "character" },
};

async function openShelves() {
  await Promise.all([loadFaces(), loadCharacters()]);
  renderShelf();
}

/** The scripts, if the server has any yet — the shelf is drawn either way. */
async function loadScenarios() {
  try { state.scenarios = (await api("/api/scenarios")).scenarios || []; }
  catch { state.scenarios = []; }
}

function shelfList() {
  const shelf = SHELVES[state.shelf] || SHELVES.faces;
  const all = state[shelf.key] || [];
  if (!shelf.filters || state.faceFilter === "all") return all;
  return all.filter((f) => f.source === state.faceFilter);
}

function renderShelf() {
  const shelf = SHELVES[state.shelf] || SHELVES.faces;
  const list = shelfList();
  const all = state[shelf.key] || [];
  document.querySelectorAll("#libraryView [data-shelf]").forEach((b) =>
    b.classList.toggle("on", b.dataset.shelf === state.shelf));
  $("libShelfFilter").innerHTML = shelf.filters
    ? AI_SOURCES.map(([v, t]) =>
      `<button class="chip${v === state.faceFilter ? " on" : ""}" data-src="${v}">${t}</button>`).join("")
    : "";
  $("libShelfCount").textContent = all.length
    ? `${list.length} of ${all.length}` : `no ${shelf.title.toLowerCase()} yet`;

  const grid = $("shelfGrid");
  grid.className = `grid ${state.shelf}`;
  // A script is not a picture, so it gets a line rather than a tile — and the way
  // to make a new one is the first line of that list, present even when the list
  // is not, which is exactly when it is needed most.
  grid.innerHTML = list.length ? list.map((f) => `
    <div class="shelf-card${state.shelfPick === f.id ? " on" : ""}" data-id="${f.id}">
      <img loading="lazy" src="${f.thumb_url}" alt="" />
      <b>${esc(f.name)}</b>
    </div>`).join("")
    : `<div class="shelf-empty">${all.length
      ? "Nothing matches this filter."
      : `The ${shelf.one} library is empty — add one on the right.`}</div>`;

  grid.querySelectorAll("[data-id]").forEach((el) =>
    el.addEventListener("click", () => {
      state.shelfPick = state.shelfPick === el.dataset.id ? null : el.dataset.id;
      state.shelfBench = null;              // a candidate belongs to an empty selection
      renderShelf();
    }));
  $("libShelfFilter").querySelectorAll("[data-src]").forEach((b) =>
    b.addEventListener("click", () => { state.faceFilter = b.dataset.src; renderShelf(); }));

  // With nothing selected the panel has nothing to show — so it becomes the way
  // to add something instead. Selecting an entry puts it back to showing that
  // entry; there is no third state and no button to toggle between them.
  const picked = list.find((f) => f.id === state.shelfPick) || null;
  if (!picked) return renderShelfBench();

  $("shelfSide").innerHTML = `
    <img src="${picked.url}" alt="" />
    <input type="text" id="shelfName" value="${esc(picked.name)}" maxlength="60" />
    <div class="rows">
      <div><span>Source</span><b>${esc(picked.source || "—")}</b></div>
      <div><span>Added</span><b>${new Date((picked.created_at || 0) * 1000)
        .toLocaleDateString()}</b></div>
      <div><span>Crop</span><b>${picked.crop
        ? `${picked.crop.size}×${picked.crop.height || picked.crop.size}` : "—"}</b></div>
      <div><span>Id</span><b>${esc(picked.id)}</b></div>
    </div>
    <div class="actions"><button class="danger mini" id="shelfDel">Delete</button></div>`;

  // the name is saved when the field is left or Enter is pressed — no Apply
  // button for something this small
  const name = $("shelfName");
  const keep = async () => {
    const value = name.value.trim();
    if (!value || value === picked.name) return;
    await api(`/api/${shelf.api}/${picked.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: value }),
    }).catch(() => {});
    await shelf.load();
    renderShelf();
  };
  name.addEventListener("blur", keep);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });

  $("shelfDel").addEventListener("click", async () => {
    await api(`/api/${shelf.api}/${picked.id}`, { method: "DELETE" }).catch(() => {});
    state.shelfPick = null;
    await shelf.load();
    renderShelf();
  });
}

/* ---- the panel as a bench: what an empty selection is good for ---- */

/** The crop shape the shelf being looked at asks for. */
const shelfTall = () => state.shelf === "characters";

function renderShelfBench() {
  const shelf = SHELVES[state.shelf] || SHELVES.faces;
  const b = state.shelfBench;
  const bench = b?.bench;
  const tall = shelfTall();
  const boxes = bench ? benchBoxes(bench, tall) : [];
  const stage = bench
    ? (bench.kind === "video"
      ? `<video id="shelfVideo" src="${bench.url}" preload="auto" muted playsinline></video>`
      : `<img id="shelfImg" src="${bench.url}" alt="" />`)
      + `<div class="ai-crop" id="shelfCrop"><i></i></div>`
    : b?.loading
      ? `<div class="ai-bench-note">${esc(b.loading.stage || "Preparing…")}
           <div class="ai-progress"><i style="width:${Math.round((b.loading.pct || 0) * 100)}%"></i></div></div>`
      : `<div class="ai-bench-note">Click to open a photo or a video, or drop one here.</div>`;

  $("shelfSide").innerHTML = `
    <div class="shelf-bench">
      <div class="shelf-stage${bench || b?.loading ? "" : " empty"}" id="shelfStage">${stage}</div>
      ${bench?.kind === "video" ? `<div class="row">
        <input type="range" id="shelfAt" min="0" max="${(bench.duration || 1).toFixed(2)}"
               step="0.04" value="${(bench.at || 0).toFixed(2)}" />
        <span class="at" id="shelfAtLabel">${(bench.at || 0).toFixed(1)}s</span></div>` : ""}
      <div class="row">
        <button class="ghost mini" id="shelfPickFile">Open…</button>
        ${shelf.filters ? `<button class="ghost mini" id="shelfRandom">Random</button>` : ""}
        ${boxes.length > 1 ? `<button class="ghost mini" data-shelf-flip="-1">‹</button>
          <button class="ghost mini" data-shelf-flip="1">›</button>` : ""}
        <span class="grow"></span>
        ${bench ? `<button class="ghost mini" id="shelfDrop">Cancel</button>` : ""}
        <button class="primary mini" id="shelfKeep" ${bench ? "" : "disabled"}>Save</button>
      </div>
      <div class="grab-note">${esc(b?.note || `Add a ${shelf.one}: open a file${
        shelf.filters ? ", take a random face" : ""} or drop a picture here.`)}</div>
    </div>`;
  wireShelfBench();
}

function shelfCropDraw() {
  const b = state.shelfBench;
  if (b?.bench) fitCrop($("shelfCrop"), $("shelfImg") || $("shelfVideo"), $("shelfStage"),
                        b.bench, b.crop);
}

function setShelfBench(data) {
  const tall = shelfTall();
  const found = benchBoxes(data, tall).length;
  state.shelfBench = { bench: data, at: 0, crop: cropFor(data, 0, tall),
                       note: data.kind === "video" && !found ? "find a frame"
                         : found > 1 ? `${found} found — ‹ › to leaf through` : "" };
  renderShelfBench();
}

async function shelfOpenFile(path) {
  try {
    const answer = await post("/api/faces/stage", { path });
    if (!answer.job_id) return setShelfBench(answer);      // a picture, already there
    state.shelfBench = { loading: { stage: "Preparing the video", pct: 0 } };
    renderShelfBench();
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      if (document.body.dataset.view !== "library") return;
      const job = await api(`/api/jobs/${answer.job_id}`);
      const item = job.items[0];
      state.shelfBench = { loading: { stage: item.stage || "Preparing the video", pct: item.pct ?? 0 } };
      renderShelfBench();
      if (!job.done) continue;
      if (item.status === "error") throw new Error(item.stage);
      setShelfBench(item.record);
      return;
    }
  } catch (e) {
    state.shelfBench = { note: "Could not open that file: " + e.message };
    renderShelfBench();
  }
}

function wireShelfBench() {
  const shelf = SHELVES[state.shelf] || SHELVES.faces;
  const b = state.shelfBench;

  const openOne = async () => {
    try {
      const { paths } = await api("/api/assets/pick");
      if (paths?.length) shelfOpenFile(paths[0]);
    } catch (e) {
      state.shelfBench = { note: "Could not open that file: " + e.message };
      renderShelfBench();
    }
  };
  $("shelfPickFile").addEventListener("click", openOne);
  // an empty frame is a button in its own right — clicking the void asks for a file
  if (!b?.bench && !b?.loading) $("shelfStage").addEventListener("click", openOne);

  $("shelfRandom")?.addEventListener("click", async () => {
    const btn = $("shelfRandom");
    btn.disabled = true; btn.textContent = "…";
    try { setShelfBench(await post("/api/faces/random", {})); }
    catch (e) { state.shelfBench = { note: "No face came back: " + e.message }; renderShelfBench(); }
  });

  $("shelfSide").querySelectorAll("[data-shelf-flip]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const tall = shelfTall(), n = benchBoxes(b.bench, tall).length;
      const at = (b.at + Number(btn.dataset.shelfFlip) + n) % n;
      state.shelfBench = { ...b, at, crop: cropFor(b.bench, at, tall), note: `${at + 1} of ${n}` };
      renderShelfBench();
    }));

  $("shelfDrop")?.addEventListener("click", () => { state.shelfBench = null; renderShelfBench(); });

  $("shelfKeep").addEventListener("click", async () => {
    if (!b?.bench) return;
    state.shelfBench = { ...b, note: "Saving…" };
    renderShelfBench();
    try {
      const saved = await post(`/api/${shelf.api}/save`, {
        token: b.bench.token, source: b.bench.source, ...b.crop,
      });
      state.shelfBench = null;
      await shelf.load();
      state.shelfPick = saved.id;             // kept, and now the thing being looked at
      renderShelf();
    } catch (e) {
      state.shelfBench = { ...b, note: "Could not keep it: " + e.message };
      renderShelfBench();
    }
  });

  const box = $("shelfCrop");
  if (box) {
    box.addEventListener("pointerdown", (e) => dragCrop(e, e.target.tagName === "I", {
      el: $("shelfImg") || $("shelfVideo"), bench: b.bench,
      get: () => state.shelfBench.crop, set: (c) => { state.shelfBench.crop = c; },
      redraw: shelfCropDraw,
    }));
    shelfCropDraw();
  }

  // a video is looked through in the page and only asked for a full frame once
  // the handle has been let go — the same bargain the tool's bench strikes
  const at = $("shelfAt");
  if (at) {
    const v = $("shelfVideo");
    if (v && b.bench.at != null) {
      const seek = () => { try { v.currentTime = b.bench.at; } catch { /* not ready */ } shelfCropDraw(); };
      if (v.readyState >= 1) seek(); else v.addEventListener("loadedmetadata", seek, { once: true });
    }
    const look = async (t) => {
      try {
        const data = await post("/api/faces/frame", { token: b.bench.token, at: t, look: true });
        if (state.shelfBench?.bench?.token !== data.token) return;
        const tall = shelfTall();
        const merged = { ...state.shelfBench.bench, at: data.at, faces: data.faces,
                         bodies: data.bodies, width: data.width, height: data.height };
        const found = benchBoxes(merged, tall).length;
        state.shelfBench = { bench: merged, at: 0, crop: cropFor(merged, 0, tall),
                             note: found > 1 ? `${found} found` : found ? "" : "nothing here — drag the frame" };
        renderShelfBench();
      } catch { /* the bench moved on */ }
    };
    at.addEventListener("input", (e) => {
      $("shelfAtLabel").textContent = Number(e.target.value).toFixed(1) + "s";
      const vid = $("shelfVideo");
      if (vid) { try { vid.currentTime = Number(e.target.value); } catch { /* not seekable */ } }
    });
    const settle = (e) => look(Number(e.target.value));
    at.addEventListener("change", settle);
    at.addEventListener("pointerup", settle);
  }

  const stage = $("shelfStage");
  stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dropping"); });
  stage.addEventListener("dragleave", () => stage.classList.remove("dropping"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("dropping");
    const f = e.dataTransfer?.files?.[0];
    if (f?.path) shelfOpenFile(f.path);
  });
}

document.querySelectorAll("#libraryView [data-shelf]").forEach((b) =>
  b.addEventListener("click", async () => {
    state.shelf = b.dataset.shelf;
    state.shelfPick = null;
    state.shelfBench = null;                          // a candidate belongs to its shelf
    renderShelf();                                    // the switch is instant…
    await (SHELVES[state.shelf] || SHELVES.faces).load();
    renderShelf();                                    // …and then it is true
  }));

/** The scenarios, as their own page: a row apiece and a way in at the top. */
function renderScenList() {
  const list = state.scenarios || [];
  $("scenList").innerHTML = `
    <div class="scen-row new" id="scenNew">+ New scenario</div>
    ${list.map((sc) => `
      <div class="scen-row" data-id="${sc.id}">
        <span class="name">${esc(sc.name || "Untitled")}</span>
        <span class="meta">${new Date((sc.updated_at || 0) * 1000).toLocaleDateString()}</span>
      </div>`).join("")}
    ${list.length ? "" : `<div class="shelf-empty">Nothing written yet.</div>`}`;
  $("scenNew").addEventListener("click", () => openScenTool());
  $("scenList").querySelectorAll("[data-id]").forEach((el) =>
    el.addEventListener("click", () => openScenTool(el.dataset.id)));
}

/* ====================== the scenario popup ======================
 *
 *  Step one, in three columns: the poem on the left, the character in the middle,
 *  and what the character becomes on the right.
 *
 *  The redraw happens in two moves, and the first is why the second works. The
 *  picture is read into words — every garment, every tattoo, nothing about the
 *  room — and those words, not the picture alone, are what the drawing model is
 *  held to. The description is shown and can be corrected, which is far cheaper
 *  than regenerating a picture to fix one detail. */

const SCEN_STEPS = ["poem", "character"];

async function openScenTool(id = "") {
  stopPlayback();
  state.scen = { id, rec: null, note: "", busy: "", gear: false, gearTimer: null };
  $("scenTool").classList.remove("hidden");
  renderScenTool();
  try {
    if (!state.looks) state.looks = await api("/api/looks");
    state.scen.rec = id ? await api(`/api/scenarios/${id}`)
                        : await post("/api/scenarios", { mode: "poem" });
    state.scen.id = state.scen.rec.id;
  } catch (e) {
    state.scen.note = "Could not open it: " + e.message;
  }
  renderScenTool();
}

function closeScenTool() {
  clearTimeout(state.scen?.gearTimer);
  state.scen = null;
  $("scenTool").classList.add("hidden");
  if (document.body.dataset.view === "scenarios") loadScenarios().then(renderScenList);
}

async function deleteScenario() {
  const s = state.scen;
  if (!s?.id) return closeScenTool();
  await api(`/api/scenarios/${s.id}`, { method: "DELETE" }).catch(() => {});
  closeScenTool();
}

/** Change some fields of the open scenario and keep what came back. */
async function scenPatch(fields) {
  const s = state.scen;
  s.rec = await api(`/api/scenarios/${s.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return s.rec;
}

/* A generation is paid for the moment it starts, so closing the window must not
 * abandon it. The watcher lives on `state` rather than inside the popup: it
 * keeps polling, writes the result into the scenario on the server's say-so, and
 * — if the popup happens to still be open on that scenario — refreshes it. When
 * it lands with nobody looking, a toast says so. */

function watchJob(jobId, { scenId, label, kind }) {
  const job = { id: jobId, scenId, label, kind, stage: "", done: false };
  state.jobs = [...(state.jobs || []), job];
  scenTick();

  (async () => {
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const said = await api(`/api/jobs/${jobId}`);
        const item = said.items[said.current] || said.items[0];
        job.stage = item.stage || "";
        if (state.scen?.id === scenId) scenTick();
        if (!said.done) continue;

        const bad = said.items.find((i) => i.status === "error");
        job.done = true;
        state.jobs = (state.jobs || []).filter((j) => j !== job);
        const rec = await api(`/api/scenarios/${scenId}`).catch(() => null);
        if (state.scen?.id === scenId) {
          if (rec) state.scen.rec = rec;
          state.scen.note = bad ? bad.stage : "";
          renderScenTool();
        }
        if (document.body.dataset.view === "scenarios") loadScenarios().then(renderScenList);
        // a toast only where it earns its keep: the popup that was watching
        // already showed the picture
        if (state.scen?.id !== scenId || document.hidden) {
          toast({
            title: bad ? `${label} failed` : `${label} finished`,
            body: rec?.name || "scenario",
            bad: !!bad,
            go: () => openScenarioFromAnywhere(scenId),
          });
        }
        return;
      }
    } catch (e) {
      job.done = true;
      state.jobs = (state.jobs || []).filter((j) => j !== job);
      toast({ title: `${label} failed`, body: e.message, bad: true,
              go: () => openScenarioFromAnywhere(scenId) });
    }
  })();
  return job;
}

/** Whatever the app is showing, put this scenario in front of it. */
function openScenarioFromAnywhere(scenId) {
  if (document.body.dataset.view !== "scenarios") setView("scenarios");
  if (state.scen?.id === scenId) return renderScenTool();
  openScenTool(scenId);
}

/** Is anything running for this scenario, and what does it say about itself. */
function busyOf(scenId) {
  const job = (state.jobs || []).find((j) => j.scenId === scenId && !j.done);
  return job ? `${job.label} · ${job.stage}` : "";
}

/* ---------------- toasts ---------------- */

/** A short chime, synthesised — a file to ship and load would be more trouble. */
function chime(bad = false) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = window._chimeCtx || (window._chimeCtx = new Ctx());
    const now = ctx.currentTime;
    (bad ? [420, 300] : [660, 990]).forEach((hz, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, now + i * 0.13);
      gain.gain.exponentialRampToValueAtTime(0.13, now + i * 0.13 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.13);
      osc.stop(now + i * 0.13 + 0.25);
    });
  } catch { /* no sound is not a failure */ }
}

function toast({ title, body, bad = false, go = null, seconds = 12 }) {
  const el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}${go ? " go" : ""}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body || "")}</span>
    <button class="x" title="Dismiss">✕</button>`;
  el.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); el.remove(); });
  if (go) el.addEventListener("click", () => { el.remove(); go(); });
  $("toasts").appendChild(el);
  chime(bad);
  setTimeout(() => el.remove(), seconds * 1000);
}

/* The model's settings outlive the project: they are a preference about how you
 * like to work, not part of any one poem. */
function modelParams(model) {
  const saved = (Store.settings.img_params || {})[model] || {};
  const fields = state.looks?.models?.[model]?.fields || [];
  const out = {};
  fields.forEach((f) => { out[f.key] = saved[f.key] !== undefined ? saved[f.key] : f.default; });
  return out;
}

function saveModelParams(model, params) {
  Store.settings.img_params = { ...(Store.settings.img_params || {}), [model]: params };
  Store.save();
}

/** What changes while something is being generated, and nothing else. */
function scenTick() {
  const s = state.scen;
  if (!s || !$("scenNote")) return;
  s.busy = busyOf(s.id);
  $("scenNote").textContent = s.busy || s.note || "Saved as you type.";
  const drawing = /Draw/i.test(s.busy), reading = /Read/i.test(s.busy);
  $("scenBody").querySelectorAll(".drop-card").forEach((card) => {
    const wants = card.classList.contains("result") ? drawing : reading;
    card.classList.toggle("working", wants);
    const spin = card.querySelector(".spinner");
    if (wants && !spin) card.insertAdjacentHTML("beforeend", `<div class="spinner"></div>`);
    if (!wants && spin) spin.remove();
  });
  const draw = $("scDraw"), read = $("scRead");
  if (draw) draw.disabled = !!s.busy || !((s.rec?.character || {}).description || "").trim();
  if (read) read.disabled = !!s.busy;
}

function renderScenTool() {
  const s = state.scen;
  if (!s) return;
  const rec = s.rec;
  $("scenTitle").textContent = rec?.name && rec.name !== "Untitled" ? rec.name : "New scenario";
  $("scenStep").textContent = rec ? "poem and character" : "";
  $("scenDel").classList.toggle("hidden", !rec);
  if (!rec) {
    $("scenBody").innerHTML = `<div class="shelf-empty">${esc(s.note || "Opening…")}</div>`;
    $("scenNote").textContent = "";
    return;
  }

  const char = rec.character || {};
  const styles = state.looks?.styles || [];
  const models = state.looks?.models || {};
  const styleId = rec.style_id || state.looks?.default_style || "";
  const model = Store.settings.img_model || state.looks?.default_model || "gpt_image_2";
  const params = modelParams(model);
  const fields = models[model]?.fields || [];
  s.busy = busyOf(s.id);
  const drawing = /Draw/i.test(s.busy);
  const reading = /Read/i.test(s.busy);

  $("scenBody").innerHTML = `
    <div class="scen-four">
      <label class="field scen-one">
        <span>The poem — its first line names the project</span>
        <textarea id="scPoem" class="scen-poem" spellcheck="false"
          placeholder="Paste the poem here — one line per line, blank lines between stanzas."
        >${esc((rec.poem || {}).text || "")}</textarea>
      </label>

      <div class="scen-col">
        <div class="scen-pick">
          <select id="scStyle">${styles.map((st) =>
            `<option value="${st.id}" ${st.id === styleId ? "selected" : ""}>${esc(st.name)}</option>`).join("")}</select>
        </div>
        <div class="style-note" id="scNote"
             style="flex: 0 0 ${Store.layout.scen_note || 180}px">${
          esc(styles.find((x) => x.id === styleId)?.look || "")}</div>
        <div class="sash h" id="scNoteSash" title="Drag to give the picture more room"></div>
        <div class="drop-card${char.file ? " full" : ""}" id="scDrop" title="Click or drop a picture">
          ${char.file
            ? `<img src="/api/scenarios/${s.id}/character/source?t=${rec.updated_at || 0}" alt="" />`
            : `<div class="hint">Click to open a picture of the character,<br />or drop one here.</div>`}
          ${reading ? `<div class="spinner"></div>` : ""}
        </div>
      </div>

      <div class="scen-col">
        <div class="scen-pick">
          <span class="col-head">What the picture says</span>
          ${char.file ? `<button class="gear" id="scRead" title="${
            char.description ? "Read the picture again" : "Try reading it again"}"
            ${s.busy ? "disabled" : ""}>⟳</button>` : ""}
        </div>
        <textarea id="scWho" class="scen-who tall"
          placeholder="${char.file
            ? (reading ? "Reading the picture…" : "Nothing read yet — press ⟳ to try again.")
            : "Load a picture and it will be read by itself."}"
          ${char.file ? "" : "disabled"}>${esc(char.description || "")}</textarea>
      </div>

      <div class="scen-col">
        <div class="scen-pick">
          <select id="scModel">${Object.entries(models).map(([k, m]) =>
            `<option value="${k}" ${k === model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
          <button class="gear" id="scGear" title="Settings">⚙</button>
          <button class="gear" id="scFolder" title="Open the folder with every drawing">🗀</button>
          ${s.gear ? `<div class="gear-pop" id="scGearPop">
            ${fields.length ? fields.map((f) => `
              <label class="row">
                <span>${esc(f.label)}</span>
                ${f.kind === "choice"
                  ? `<select data-param="${f.key}">${f.options.map((o) =>
                      `<option value="${o}" ${String(params[f.key]) === String(o) ? "selected" : ""}
                        >${esc((f.labels || {})[o] || o)}</option>`).join("")}</select>`
                  : f.kind === "flag"
                    ? `<input type="checkbox" data-param="${f.key}" ${params[f.key] ? "checked" : ""} />`
                    : `<input type="number" data-param="${f.key}" value="${params[f.key] ?? 0}" />`}
              </label>`).join("")
              : `<div class="stamp-note">This one has nothing to set.</div>`}
            <button class="primary mini" id="scGearSave">Save</button>
          </div>` : ""}
        </div>
        <div class="drop-card result tall${drawing ? " working" : ""}"
             ${char.result ? `id="scResult" title="Click to see it full size"` : ""}>
          ${char.result
            ? `<img src="/api/scenarios/${s.id}/character/result?t=${rec.updated_at || 0}" alt="" />`
            : `<div class="hint">${drawing ? "" : "The character, redrawn in the chosen style — full length, on white."}</div>`}
          ${drawing ? `<div class="spinner"></div>` : ""}
        </div>
        <button class="primary mini" id="scDraw"
          ${s.busy || !(char.description || "").trim() ? "disabled" : ""}>
          ${char.result ? "Draw again" : "Draw the character"}</button>
      </div>
    </div>`;
  $("scenNote").textContent = s.busy || s.note || "Saved as you type.";
  wireScenTool();
}

function wireScenTool() {
  const s = state.scen, rec = s.rec;

  const poem = $("scPoem");
  poem.addEventListener("change", async () => {
    try {
      await scenPatch({ poem: { text: poem.value }, name: firstLine(poem.value) });
      s.note = "Saved.";
    } catch (e) { s.note = "Not saved: " + e.message; }
    renderScenTool();
  });

  $("scStyle").addEventListener("change", async (e) => {
    await scenPatch({ style_id: e.target.value });
    renderScenTool();
  });

  // A picture that has just been loaded is going to be read anyway — waiting for
  // a press only adds a step. The retry beside the description is what turns a
  // failure back into a button.
  const readCharacter = async () => {
    const scenId = s.id;
    const answer = await post(`/api/scenarios/${scenId}/character/read`,
                              { key: Store.keys.kie || "" })
      .catch((e) => { s.note = e.message; return null; });
    if (!answer) return renderScenTool();
    watchJob(answer.job_id, { scenId, label: "Reading", kind: "read" });
    renderScenTool();
  };

  const openPicture = async () => {
    try {
      const { paths } = await api("/api/assets/pick");
      if (!paths?.length) return;
      s.busy = "Uploading the picture";
      renderScenTool();
      s.rec = await post(`/api/scenarios/${s.id}/character`,
                         { path: paths[0], imgbb: Store.keys.imgbb || "" });
      s.busy = "";
      await readCharacter();
      return;
    } catch (e) { s.note = e.message; }
    s.busy = "";
    renderScenTool();
  };
  const drop = $("scDrop");
  drop.addEventListener("click", openPicture);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (!f?.path) return;
    s.busy = "Uploading the picture";
    renderScenTool();
    try {
      s.rec = await post(`/api/scenarios/${s.id}/character`,
                         { path: f.path, imgbb: Store.keys.imgbb || "" });
      s.busy = "";
      await readCharacter();
      return;
    } catch (err) { s.note = err.message; }
    s.busy = "";
    renderScenTool();
  });

  $("scRead")?.addEventListener("click", () => readCharacter());

  // the description is the thing the drawing is held to, so it is text you can fix
  $("scWho")?.addEventListener("change", async (e) => {
    s.rec = await scenPatch({ character: { ...(rec.character || {}), description: e.target.value } });
    s.note = "Description saved.";
    renderScenTool();
  });

  $("scModel").addEventListener("change", (e) => {
    Store.settings.img_model = e.target.value;
    Store.save();
    renderScenTool();
  });

  // the gear opens on hover and closes a second after the pointer leaves it —
  // or the moment its Save is pressed
  const gear = $("scGear"), pop = $("scGearPop");
  const hold = () => clearTimeout(s.gearTimer);
  const leave = () => {
    clearTimeout(s.gearTimer);
    s.gearTimer = setTimeout(() => { s.gear = false; renderScenTool(); }, 1000);
  };
  gear.addEventListener("pointerenter", () => {
    hold();
    if (!s.gear) { s.gear = true; renderScenTool(); }
  });
  gear.addEventListener("pointerleave", leave);
  if (pop) {
    pop.addEventListener("pointerenter", hold);
    pop.addEventListener("pointerleave", leave);
    $("scGearSave").addEventListener("click", () => {
      const model = Store.settings.img_model || state.looks?.default_model;
      const params = {};
      pop.querySelectorAll("[data-param]").forEach((el) => {
        params[el.dataset.param] = el.type === "checkbox" ? el.checked
          : el.type === "number" ? Number(el.value) : el.value;
      });
      saveModelParams(model, params);
      clearTimeout(s.gearTimer);
      s.gear = false;
      s.note = "Settings saved.";
      renderScenTool();
    });
  }

  // the description and the picture share the column; the sash says who gets what
  $("scNoteSash").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const note = $("scNote");
    const start = { y: e.clientY, h: note.getBoundingClientRect().height };
    const move = (ev) => {
      const h = clamp(start.h + (ev.clientY - start.y), 40, 520);
      note.style.flex = `0 0 ${Math.round(h)}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      Store.setLayout("scen_note", note.getBoundingClientRect().height);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  $("scResult")?.addEventListener("click", () =>
    openImgView(`/api/scenarios/${s.id}/character/result?t=${rec.updated_at || 0}`));
  // nothing drawn is thrown away, so there has to be a way to go and look at it
  $("scFolder").addEventListener("click", () =>
    post(`/api/scenarios/${s.id}/reveal`, {}).catch(() => {}));

  $("scDraw").addEventListener("click", async () => {
    const model = Store.settings.img_model || state.looks?.default_model;
    const scenId = s.id;
    const answer = await post(`/api/scenarios/${scenId}/character/draw`, {
      key: Store.keys.kie || "", imgbb: Store.keys.imgbb || "",
      model, params: modelParams(model),
    }).catch((e) => { s.note = e.message; return null; });
    if (!answer) return renderScenTool();
    // the popup may be closed a second from now; the work carries on regardless
    watchJob(answer.job_id, { scenId, label: "Drawing", kind: "draw" });
    renderScenTool();
  });
}

/* A drawing is worth looking at closely: the viewer opens on click, zooms with
 * the wheel or the buttons, and is dragged around when it does not fit. */
function openImgView(src) {
  state.imgView = { src, zoom: 0, x: 0, y: 0 };
  $("imgViewPic").src = src;
  $("imgView").classList.remove("hidden");
  fitImgView();
}

function fitImgView() {
  const v = state.imgView;
  if (!v) return;
  const pic = $("imgViewPic");
  pic.style.transform = v.zoom
    ? `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
    : "";
  pic.classList.toggle("fitted", !v.zoom);
  $("imgZoom").textContent = v.zoom ? `${Math.round(v.zoom * 100)}%` : "fit";
}

function zoomImgView(step) {
  const v = state.imgView;
  if (!v) return;
  if (!step) { v.zoom = 0; v.x = v.y = 0; }
  else v.zoom = clamp((v.zoom || 1) * (step > 0 ? 1.25 : 0.8), 0.2, 8);
  fitImgView();
}

function closeImgView() {
  state.imgView = null;
  $("imgView").classList.add("hidden");
  $("imgViewPic").removeAttribute("src");
}

$("imgClose").addEventListener("click", closeImgView);
$("imgView").addEventListener("click", (e) => { if (e.target.id === "imgView") closeImgView(); });
$("imgView").querySelectorAll("[data-zoom]").forEach((b) =>
  b.addEventListener("click", () => zoomImgView(Number(b.dataset.zoom))));
$("imgStage").addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomImgView(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
$("imgStage").addEventListener("pointerdown", (e) => {
  const v = state.imgView;
  if (!v?.zoom) return;
  const from = { x: e.clientX, y: e.clientY, ox: v.x, oy: v.y };
  const move = (ev) => {
    v.x = from.ox + (ev.clientX - from.x);
    v.y = from.oy + (ev.clientY - from.y);
    fitImgView();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

/** The first line with words in it — the poem's title, and the project's name. */
function firstLine(text) {
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 60);
  }
  return "Untitled";
}

$("scenDel").addEventListener("click", deleteScenario);
$("scenTool").addEventListener("click", (e) => { if (e.target.id === "scenTool") closeScenTool(); });

/* ====================== archive (localStorage) ====================== */

function renderArchive() {
  const posts = Store.listPosts({
    q: $("search").value,
    kinds: [...state.pickedKinds],
    tags: [...state.pickedTags],
    sort: Store.settings.sort,
  });
  renderStats(Store.stats());
  renderFacets();
  renderGrid(posts);
  syncBulkBar();
  // what the viewer steps through is what the grid is showing — the same search,
  // the same filter, the same order, so the arrows never take you somewhere the
  // page behind them does not contain
  state.shown = posts.map((p) => p.shortcode);
}

function renderStats(s) {
  const parts = [`${s.total || 0} saved`];
  if (s.image) parts.push(`${s.image} photo`);
  if (s.video) parts.push(`${s.video} reel`);
  if (s.carousel) parts.push(`${s.carousel} carousel`);
  $("stats").textContent = parts.join(" · ");
}

/* ---------------- the filter column ----------------
 *
 *  Counts are what make a filter panel worth having, and they are counted the
 *  way a shop counts them: each row says how many posts you would be left with
 *  if you ticked it *now*, with every other group's choices still in force. So a
 *  row reading zero is a row not worth pressing — and it says so rather than
 *  vanishing, because a list that reshuffles itself as you use it is worse than
 *  one with a few grey rows in it. */

const KINDS = [["reel", "Reels"], ["photo", "Photos"]];

function facetCount(group, value) {
  const q = $("search").value;
  const kinds = group === "kind"
    ? (state.pickedKinds.has(value) ? [...state.pickedKinds] : [...state.pickedKinds, value])
    : [...state.pickedKinds];
  const tags = group === "tag"
    ? (state.pickedTags.has(value) ? [...state.pickedTags] : [...state.pickedTags, value])
    : [...state.pickedTags];
  return Store.listPosts({ q, kinds, tags, sort: Store.settings.sort }).length;
}

function facetRow(group, value, label) {
  const picked = group === "kind" ? state.pickedKinds : state.pickedTags;
  const on = picked.has(value);
  const n = facetCount(group, value);
  return `<button class="facet${on ? " on" : ""}${!n && !on ? " none" : ""}"
    data-facet="${group}" data-value="${esc(value)}">
    <span class="box"></span><span class="name">${esc(label)}</span><span class="n">${n}</span>
  </button>`;
}

function renderFacets() {
  const tags = Store.allTags();
  const anyKind = state.pickedKinds.size, anyTag = state.pickedTags.size;
  $("facets").innerHTML = `
    <div class="facet-group">
      <div class="facet-head"><span>Kind</span>${anyKind
        ? `<button data-clear="kind">clear</button>` : ""}</div>
      ${KINDS.map(([v, label]) => facetRow("kind", v, label)).join("")}
    </div>
    <div class="facet-group">
      <div class="facet-head"><span>Tags</span>${anyTag
        ? `<button data-clear="tag">clear</button>` : ""}</div>
      ${tags.length ? tags.map((t) => facetRow("tag", t, t)).join("")
        : `<div class="facet-empty">No tags yet.</div>`}
    </div>`;

  $("facets").querySelectorAll("[data-facet]").forEach((b) =>
    b.addEventListener("click", () => {
      const set = b.dataset.facet === "kind" ? state.pickedKinds : state.pickedTags;
      const v = b.dataset.value;
      if (set.has(v)) set.delete(v); else set.add(v);
      saveFacets();
      renderArchive();
    }));
  $("facets").querySelectorAll("[data-clear]").forEach((b) =>
    b.addEventListener("click", () => {
      (b.dataset.clear === "kind" ? state.pickedKinds : state.pickedTags).clear();
      saveFacets();
      renderArchive();
    }));
}

/** The panel's state outlives the session, like every other setting here. */
function saveFacets() {
  Store.settings.kinds = [...state.pickedKinds];
  Store.settings.tags = [...state.pickedTags];
  Store.save();
}

const TYPE_BADGE = { image: "▣", video: "▶ reel", carousel: "❏" };

function renderGrid(posts) {
  $("empty").classList.toggle("hidden", posts.length > 0);
  $("grid").innerHTML = posts.map((p) => {
    const badge = p.type === "carousel" ? `❏ ${p.media_count}` : TYPE_BADGE[p.type] || p.type;
    const date = p.taken_at
      ? new Date(p.taken_at * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }) : "";
    return `<article class="card ${state.selected.has(p.shortcode) ? "selected" : ""}" data-sc="${p.shortcode}">
      <div class="thumb">
        ${p.thumb ? `<img loading="lazy" src="/media/${p.thumb}" alt="" />` : ""}
        <span class="badge">${badge}</span>
        <label class="pick"><input type="checkbox" ${state.selected.has(p.shortcode) ? "checked" : ""} /></label>
      </div>
      <div class="card-body">
        <div class="card-owner">@${esc(p.owner || "unknown")}<span class="dt">${date}</span></div>
        <input class="card-tags" value="${esc((p.tags || []).join(", "))}" placeholder="+ tags" />
      </div>
    </article>`;
  }).join("");

  $("grid").querySelectorAll(".card").forEach((card) => {
    const sc = card.dataset.sc;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".pick") || e.target.closest(".card-tags")) return;
      openPost(sc);
    });
    card.querySelector(".pick input").addEventListener("change", (e) => {
      e.target.checked ? state.selected.add(sc) : state.selected.delete(sc);
      card.classList.toggle("selected", e.target.checked);
      syncBulkBar();
    });
    const input = card.querySelector(".card-tags");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("change", () => {
      Store.updatePost(sc, { tags: input.value.split(",").map((t) => t.trim()).filter(Boolean) });
      renderFacets();                       // a new tag is a new row, with its own count
    });
  });
}

/* ---------- selection ---------- */

function syncBulkBar() {
  const n = state.selected.size;
  $("bulk").classList.toggle("hidden", n === 0);
  $("selCount").textContent = `${n} selected`;
}
function clearSelection() {
  state.selected.clear();
  document.querySelectorAll(".card.selected").forEach((c) => {
    c.classList.remove("selected");
    c.querySelector(".pick input").checked = false;
  });
  syncBulkBar();
}
function selectAll() {
  document.querySelectorAll(".card").forEach((c) => {
    state.selected.add(c.dataset.sc);
    c.classList.add("selected");
    c.querySelector(".pick input").checked = true;
  });
  syncBulkBar();
}

/* ====================== download queue ====================== */

function setLocked(locked) {
  ["links", "saveBtn", "skipExisting", "search"].forEach((id) => ($(id).disabled = locked));
  $("composer").classList.toggle("locked", locked);
}

async function startSave() {
  const urls = $("links").value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return;
  setLocked(true);
  $("queue").classList.remove("hidden");
  $("queueClose").hidden = true;
  try {
    const { job_id } = await post("/api/save", {
      urls,
      skip_existing: $("skipExisting").checked,
      known: Store.knownShortcodes(),
      cookies_browser: Store.settings.cookies_browser,
      ig_username: Store.settings.ig_username,
    });
    pollJob(job_id);
  } catch (e) {
    setLocked(false);
    $("queueItems").innerHTML = `<div class="qstage dot-err">${esc(e.message)}</div>`;
    $("queueClose").hidden = false;
  }
}

function pollJob(jobId) {
  const started = Date.now();
  state.tickTimer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("queueTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  const tick = async () => {
    const job = await api(`/api/jobs/${jobId}`);
    renderQueue(job);
    job.items.forEach((i) => { if (i.record) { Store.upsertPost(i.record); delete i.record; } });
    if (job.done) {
      clearInterval(state.pollTimer);
      clearInterval(state.tickTimer);
      setLocked(false);
      $("queueClose").hidden = false;
      const ok = job.items.filter((i) => i.status === "done").length;
      $("queueTitle").textContent = `Finished — ${ok}/${job.items.length} saved`;
      if (ok) $("links").value = "";
      renderArchive();
    }
  };
  state.pollTimer = setInterval(tick, 500);
  tick();
}

function renderQueue(job) {
  if (!job.done) $("queueTitle").textContent = `Downloading ${job.current + 1}/${job.items.length}…`;
  $("queueItems").innerHTML = job.items.map((i) => {
    const mark =
      i.status === "done" ? '<span class="dot-ok">✓</span>' :
      i.status === "error" ? '<span class="dot-err">✕</span>' :
      i.status === "skipped" ? '<span class="muted">–</span>' :
      i.status === "working" ? '<span class="spinner"></span>' : '<span class="muted">·</span>';
    const pct = i.pct != null ? Math.round(i.pct * 100) : i.status === "working" ? 8 : 0;
    const bar = i.status === "working" ? `<div class="qbar"><i style="width:${pct}%"></i></div>` : "";
    return `<div class="qitem">${mark}
        <div class="qurl">${esc(i.url)}</div>
        <div class="qstage ${i.status === "error" ? "dot-err" : "muted"}">${esc(i.stage || "")}</div>
      </div>${bar}`;
  }).join("");
}

/* ====================== post viewer ====================== */

function openPost(shortcode) {
  const p = Store.getPost(shortcode);
  if (!p) return;
  state.current = p;
  state.mediaIndex = 0;
  $("mOwner").textContent = "@" + (p.owner || "unknown");
  $("mDate").textContent = p.taken_at ? new Date(p.taken_at * 1000).toLocaleDateString() : "";
  const m = [];
  if (p.likes != null) m.push(`♥ ${fmt(p.likes)}`);
  if (p.comments != null) m.push(`💬 ${fmt(p.comments)}`);
  if (p.views != null) m.push(`👁 ${fmt(p.views)}`);
  m.push(`${p.media_count} file(s)`, `via ${p.source}`);
  $("mMetrics").textContent = m.join("   ");
  $("mCaption").textContent = p.caption || "— no caption —";
  $("mTags").value = (p.tags || []).join(", ");
  $("mNotes").value = p.notes || "";
  $("openIg").href = p.url;
  state.grab = null;
  renderFilmstrip();
  renderMedia();
  syncPostFlips();
  $("modal").classList.remove("hidden");
}

function renderMedia() {
  const p = state.current;
  const item = p.media[state.mediaIndex];
  const src = `/media/${p.folder}/${item.filename}`;
  const multi = p.media.length > 1;
  const media = item.kind === "video"
    ? `<video src="${src}" controls autoplay loop></video>`
    : `<img src="${src}" alt="" />`;
  const zones = multi
    ? `<div class="zones">
         <div class="zone left" data-step="-1"><span>‹</span></div>
         <div class="zone right" data-step="1"><span>›</span></div>
       </div>
       <div class="counter">${state.mediaIndex + 1} / ${p.media.length}</div>` : "";
  const stage = $("stage");
  stage.className = "stage" + (item.kind === "video" ? " video-mode" : "");
  stage.innerHTML = media + zones + `<div id="grabLayer"></div>`;
  stage.querySelectorAll(".zone").forEach((z) =>
    z.addEventListener("click", () => step(Number(z.dataset.step))));
  renderGrab();
  $("filmstrip").querySelectorAll(".fs").forEach((t, i) => t.classList.toggle("on", i === state.mediaIndex));
}

/* ====================== grabbing a reference from the archive ======================
 *
 *  Two presses. The first takes the picture as it stands — the photo, or the
 *  frame a video is paused on — finds what is in it and draws the frame that
 *  would be cut. The second, on the same button, keeps it. Pressing the other
 *  button in between changes the shape rather than starting again, because it is
 *  the same picture either way. */

const GRAB_KIND = { face: { label: "Save Face", one: "face", api: "faces", tall: false },
                    character: { label: "Save Character", one: "character", api: "characters", tall: true } };

/** The bar and the frame, drawn over the picture without touching the picture.
 *
 *  A video keeps playing — or keeps standing where it was paused — because this
 *  never rebuilds the <video>. Rewriting the stage would rewind it, and the
 *  frame the user chose is the whole point. */
function renderGrab() {
  const layer = $("grabLayer");
  if (!layer) return;
  const g = state.grab;
  const armed = !!g?.bench;
  const many = armed ? benchBoxes(g.bench, GRAB_KIND[g.mode].tall).length : 0;
  layer.innerHTML = `
    ${armed ? `<div class="ai-crop" id="grabCrop"><i></i></div>` : ""}
    <div class="grab-bar${armed ? " armed" : ""}">
      ${Object.entries(GRAB_KIND).map(([k, v]) =>
        `<button class="ghost mini${g?.mode === k ? " on" : ""}" data-grab="${k}">
           ${armed && g.mode === k ? `Keep this ${v.one}` : v.label}</button>`).join("")}
      ${many > 1 ? `<button class="ghost mini" data-grab-flip="-1">‹</button>
        <button class="ghost mini" data-grab-flip="1">›</button>` : ""}
      ${armed ? `<button class="ghost mini" data-grab-off="1">Cancel</button>` : ""}
      <span class="grab-note">${esc(g?.note || "")}</span>
    </div>`;
  wireGrab();
  grabCropDraw();
}

function grabCropDraw() {
  const g = state.grab;
  if (g?.bench) fitCrop($("grabCrop"), $("stage").querySelector("img, video"), $("stage"),
                        g.bench, g.crop);
}

/** What the note under the buttons says about what was found. */
function grabNote(bench, tall) {
  const n = benchBoxes(bench, tall).length;
  return n > 1 ? `${n} found` : n ? "" : "nothing found — drag the frame";
}

/** Ask the server what is in the picture on screen, and draw the first candidate. */
async function grabArm(mode) {
  const p = state.current, item = p?.media[state.mediaIndex];
  if (!item) return;
  const video = $("stage").querySelector("video");
  state.grab = { mode, note: "Looking…" };
  renderGrab();
  try {
    const bench = await post("/api/faces/stage-media", {
      shortcode: p.folder, filename: item.filename, at: video ? video.currentTime : 0,
    });
    const tall = GRAB_KIND[mode].tall;
    state.grab = { mode, bench, at: 0, crop: cropFor(bench, 0, tall), note: grabNote(bench, tall) };
  } catch (e) {
    state.grab = { mode: null, note: "Could not read that frame: " + e.message };
  }
  renderGrab();
}

async function grabKeep() {
  const g = state.grab;
  if (!g?.bench) return;
  const kind = GRAB_KIND[g.mode];
  state.grab = { ...g, note: "Saving…" };
  renderGrab();
  try {
    const saved = await post(`/api/${kind.api}/save`, {
      token: g.bench.token, source: "uploaded", ...g.crop,
    });
    state.grab = { mode: null, note: `Kept as ${saved.name}` };
    await (kind.tall ? loadCharacters() : loadFaces());
    if (document.body.dataset.view === "library") renderShelf();
  } catch (e) {
    state.grab = { ...g, note: "Could not keep it: " + e.message };
  }
  renderGrab();
}

function wireGrab() {
  const layer = $("grabLayer");
  if (!layer) return;
  layer.querySelectorAll("[data-grab]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.grab, mode = b.dataset.grab;
      if (!g?.bench) return grabArm(mode);                  // first press: look
      if (g.mode === mode) return grabKeep();               // second press: keep
      // the other shape of the same picture — no need to fetch it again
      const tall = GRAB_KIND[mode].tall;
      state.grab = { ...g, mode, at: 0, crop: cropFor(g.bench, 0, tall),
                     note: grabNote(g.bench, tall) };
      renderGrab();
    }));
  layer.querySelectorAll("[data-grab-flip]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = state.grab, tall = GRAB_KIND[g.mode].tall;
      const n = benchBoxes(g.bench, tall).length;
      const at = (g.at + Number(b.dataset.grabFlip) + n) % n;
      state.grab = { ...g, at, crop: cropFor(g.bench, at, tall),
                     note: `${at + 1} of ${n}` };
      renderGrab();
    }));
  layer.querySelector("[data-grab-off]")?.addEventListener("click", () => {
    state.grab = null;
    renderGrab();
  });
  const box = $("grabCrop");
  if (box) box.addEventListener("pointerdown", (e) => dragCrop(e, e.target.tagName === "I", {
    el: $("stage").querySelector("img, video"), bench: state.grab.bench,
    get: () => state.grab.crop, set: (c) => { state.grab.crop = c; }, redraw: grabCropDraw,
  }));
}

function renderFilmstrip() {
  const p = state.current;
  const strip = $("filmstrip");
  if (p.media.length < 2) { strip.innerHTML = ""; return; }
  strip.innerHTML = p.media.map((m, i) => {
    const src = `/media/${p.folder}/${m.filename}`;
    const inner = m.kind === "video"
      ? `<video src="${src}#t=0.1" muted preload="metadata"></video><span class="play">▶</span>`
      : `<img loading="lazy" src="${src}" alt="" />`;
    return `<div class="fs ${i === state.mediaIndex ? "on" : ""}" data-i="${i}">${inner}</div>`;
  }).join("");
  strip.querySelectorAll(".fs").forEach((t) =>
    t.addEventListener("click", () => {
      if (Number(t.dataset.i) === state.mediaIndex) return;
      state.mediaIndex = Number(t.dataset.i);
      state.grab = null;              // a frame belongs to the picture it was found in
      renderMedia();
    }));
}

function step(delta) {
  const n = state.current.media.length;
  state.mediaIndex = (state.mediaIndex + delta + n) % n;
  state.grab = null;                    // a frame belongs to the picture it was found in
  renderMedia();
}

/** Move to the next saved post without leaving the viewer. */
function flipPost(delta) {
  const list = state.shown || [];
  const here = list.indexOf(state.current?.shortcode);
  if (here < 0 || list.length < 2) return;
  openPost(list[(here + delta + list.length) % list.length]);
}

function syncPostFlips() {
  const many = (state.shown || []).length > 1;
  $("postPrev").classList.toggle("hidden", !many);
  $("postNext").classList.toggle("hidden", !many);
}

function closeModal() {
  $("modal").classList.add("hidden");
  state.grab = null;               // the frame was drawn on a picture that is gone
  $("stage").innerHTML = "";
  $("filmstrip").innerHTML = "";
  state.current = null;
}

/* ====================== menu bar ====================== */

function closeMenus() { document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")); }

document.querySelectorAll(".menu").forEach((menu) => {
  menu.querySelector(".menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains("open");
    closeMenus();
    if (!wasOpen) menu.classList.add("open");
  });
  menu.addEventListener("mouseenter", () => {
    if (document.querySelector(".menu.open")) { closeMenus(); menu.classList.add("open"); }
  });
});
document.addEventListener("click", closeMenus);

function syncMenuTicks() {
  document.querySelectorAll('.dropdown button[data-act="card"]').forEach((b) =>
    b.classList.toggle("on", b.dataset.val === Store.settings.card_size));
  document.querySelectorAll('.dropdown button[data-act="sort"]').forEach((b) =>
    b.classList.toggle("on", b.dataset.val === Store.settings.sort));
}

document.querySelectorAll(".dropdown button").forEach((b) =>
  b.addEventListener("click", async () => {
    closeMenus();
    const { act, val } = b.dataset;
    if (act === "refresh") renderArchive();
    if (act === "reveal-vault") post("/api/reveal", {});
    if (act === "rescan") rescan();
    if (act === "export") exportAll();
    if (act === "import") $("importFile").click();
    if (act === "card") { document.body.dataset.card = val; Store.setSetting("card_size", val); syncMenuTicks(); }
    if (act === "sort") { Store.setSetting("sort", val); syncMenuTicks(); renderArchive(); }
    if (act === "settings") openPrefs();
    if (act === "select-all") selectAll();
    if (act === "clear-sel") clearSelection();
  }));

async function rescan() {
  const { records, broken } = await api("/api/rescan");
  const before = Store.stats().total;
  records.forEach((r) => Store.upsertPost(r));
  renderArchive();
  const added = Store.stats().total - before;
  alert(
    `Rescan finished.\n\n${records.length} post(s) found on disk, ${added} new added to the index.` +
    (broken.length ? `\n${broken.length} folder(s) skipped (no readable meta.json).` : "")
  );
}

function exportAll() {
  const blob = new Blob([Store.exportAll()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `insta-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm("Import will replace everything currently stored. Continue?")) return;
  try {
    Store.importAll(await file.text());
    location.reload();
  } catch (err) {
    alert("Could not import this file: " + err.message);
  }
});

/* ====================== preferences ====================== */

/* Edits go into a draft so Cancel really cancels; Save writes it to the store. */
const prefs = { group: "download", draft: null, keyTests: {}, speech: null, note: "" };

const PROVIDERS = [
  { id: "kie", label: "kie.ai", hint: "Seedance, Veo, Nano Banana and the rest of the aggregator's models.",
    where: "kie.ai → API keys" },
  { id: "replicate", label: "Replicate", hint: "Face swap, upscaling, interpolation, background removal.",
    where: "replicate.com → account → API tokens" },
  { id: "openrouter", label: "OpenRouter", hint: "Text models: names for fragments, tags, translation, prompts.",
    where: "openrouter.ai → keys" },
  { id: "imgbb", label: "imgbb", hint: "Public image hosting — some models can only be handed a URL, not a file. Images only, not video.",
    where: "api.imgbb.com" },
  { id: "groq", label: "Groq", hint: "Whisper transcription in the cloud: about $0.04 an hour of audio and 200× faster than real time.",
    where: "console.groq.com → keys" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Voices: speech from text, dubbing, sound effects. Billed by characters.",
    where: "elevenlabs.io → profile → API key" },
];

async function openPrefs() {
  prefs.draft = { settings: { ...Store.settings }, keys: { ...Store.keys } };
  prefs.keyTests = {};
  prefs.speech = null;
  $("prefs").classList.remove("hidden");
  renderPrefs();
  try {
    state.paths = await api("/api/paths");
  } catch { /* offline */ }
  loadSpeechStatus();
  renderPrefs();
}

async function loadSpeechStatus() {
  try {
    prefs.speech = await api("/api/speech/status");
  } catch {
    prefs.speech = { error: true };
  }
  if (prefs.draft) renderPrefs();
}

function renderPrefs() {
  const d = prefs.draft;
  const set = (key, v) => { d.settings[key] = v; };
  const field = (label, inner, note = "") =>
    `<label class="field"><span>${label}${note ? ` <em>${note}</em>` : ""}</span>${inner}</label>`;
  const opts = (list, cur) => list.map(([v, t]) =>
    `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${esc(t)}</option>`).join("");

  const groups = [
    {
      id: "download", label: "Downloading",
      tip: "How posts are fetched from Instagram.",
      html: () => `
        ${field("Cookies from browser", `<select id="pCookies">${opts([["", "None — anonymous"],
          ["chrome", "Chrome"], ["edge", "Edge"], ["firefox", "Firefox"], ["brave", "Brave"],
          ["opera", "Opera"], ["vivaldi", "Vivaldi"]], d.settings.cookies_browser)}</select>`,
          "(for rate limits / private posts)")}
        ${field("Instagram username", `<input id="pUser" type="text" placeholder="optional"
          value="${esc(d.settings.ig_username || "")}" />`, "(session file in data/ig_session)")}
        <label class="check"><input type="checkbox" id="pSkip"
          ${d.settings.skip_existing ? "checked" : ""} /> Skip already saved posts by default</label>`,
      wire: () => {
        $("pCookies").addEventListener("change", (e) => set("cookies_browser", e.target.value));
        $("pUser").addEventListener("input", (e) => set("ig_username", e.target.value.trim()));
        $("pSkip").addEventListener("change", (e) => set("skip_existing", e.target.checked));
      },
    },
    {
      id: "storage", label: "Storage",
      tip: "Where things live and how to move them.",
      html: () => {
        const bytes = new Blob([Store.exportAll()]).size;
        const p = state.paths || {};
        return `
          ${field("Media folder", `<input type="text" readonly value="${esc(p.media_dir || "…")}" />`)}
          ${field("Editor assets", `<input type="text" readonly value="${esc(p.assets_dir || "…")}" />`)}
          ${field("Renders", `<input type="text" readonly value="${esc(p.renders_dir || "…")}" />`)}
          <div class="storage-note">The index, settings, layout and projects live in this window's local
            storage — currently ${(bytes / 1024).toFixed(1)} KB. Media files stay in the folders above,
            and Rescan rebuilds the index from them.</div>
          <div class="actions">
            <button class="ghost mini" id="pReveal">Open media folder</button>
            <button class="ghost mini" id="pExport">Export backup</button>
            <button class="ghost mini" id="pImport">Import backup…</button>
          </div>`;
      },
      wire: () => {
        $("pReveal").addEventListener("click", () => post("/api/reveal", {}));
        $("pExport").addEventListener("click", exportAll);
        $("pImport").addEventListener("click", () => $("importFile").click());
      },
    },
    {
      id: "editor", label: "Editor",
      tip: "Defaults for new projects and for the preview.",
      html: () => `
        ${field("Preview quality", `<select id="pQual">${opts([["auto", "Auto"], ["full", "Full · 1080p"],
          ["high", "High · 720p"], ["medium", "Medium · 540p"], ["draft", "Draft · 270p"]],
          d.settings.preview_quality)}</select>`)}
        ${field("Canvas for new projects", `<select id="pCanvas">${opts([
          ["1080x1920", "9:16 · 1080×1920"], ["1080x1350", "4:5 · 1080×1350"],
          ["1080x1080", "1:1 · 1080×1080"], ["1920x1080", "16:9 · 1920×1080"]],
          `${d.settings.canvas_w}x${d.settings.canvas_h}`)}</select>`)}
        ${field("Frame rate", `<select id="pFps">${opts([[24, "24"], [25, "25"], [30, "30"], [50, "50"], [60, "60"]],
          d.settings.canvas_fps)}</select>`)}`,
      wire: () => {
        $("pQual").addEventListener("change", (e) => set("preview_quality", e.target.value));
        $("pCanvas").addEventListener("change", (e) => {
          const [w, h] = e.target.value.split("x").map(Number);
          set("canvas_w", w); set("canvas_h", h);
        });
        $("pFps").addEventListener("change", (e) => set("canvas_fps", Number(e.target.value)));
      },
    },
    {
      id: "keys", label: "AI API keys",
      tip: "Keys for the paid services. Stored on this machine and sent only with the job that needs them.",
      html: () => `
        <div class="hint-box">Keys stay in this window's storage and travel with the job that needs
          them — the server never writes them down. Keep them out of chats and screenshots.</div>
        ${PROVIDERS.map((p) => {
          const t = prefs.keyTests[p.id];
          const dot = t ? `<i class="key-dot ${t.pending ? "wait" : t.ok ? "ok" : "bad"}"></i>` : "";
          return `<div class="key-row">
              <div class="key-head"><span data-tip="${esc(p.hint + " Get it at " + p.where + ".")}">${esc(p.label)}</span>${dot}
                <span class="key-note">${esc(t ? (t.pending ? "checking…" : t.detail || "") : "")}</span></div>
              <div class="key-input">
                <input id="k-${p.id}" type="password" autocomplete="off" spellcheck="false"
                  placeholder="not set" value="${esc(d.keys[p.id] || "")}" />
                <button class="ghost mini" data-eye="${p.id}" title="Show or hide">👁</button>
                <button class="ghost mini" data-test="${p.id}">Test</button>
              </div>
            </div>`;
        }).join("")}
        <label class="check"><input type="checkbox" id="pExpKeys"
          ${d.settings.export_keys ? "checked" : ""} /> Include keys in exported backups</label>`,
      wire: () => {
        PROVIDERS.forEach((p) => {
          $(`k-${p.id}`).addEventListener("input", (e) => { d.keys[p.id] = e.target.value.trim(); });
        });
        $("prefsBody").querySelectorAll("[data-eye]").forEach((b) =>
          b.addEventListener("click", () => {
            const el = $(`k-${b.dataset.eye}`);
            el.type = el.type === "password" ? "text" : "password";
          }));
        $("prefsBody").querySelectorAll("[data-test]").forEach((b) =>
          b.addEventListener("click", () => testKey(b.dataset.test)));
        $("pExpKeys").addEventListener("change", (e) => set("export_keys", e.target.checked));
      },
    },
    {
      id: "speech", label: "Speech",
      tip: "Turning what is said in a clip into text: on this machine, or through Groq.",
      html: () => {
        const st = prefs.speech;
        const local = d.settings.speech_engine === "local";
        const models = st?.models_available || [["small", "Small"]].map(([id, label]) => ({ id, label }));
        const state_line = !st ? "checking what is installed…"
          : st.error ? "could not ask the server"
          : st.installed
            ? `faster-whisper is installed${st.cuda ? " · your graphics card can be used" : " · processor only"}` +
              (st.models?.length ? ` · downloaded: ${st.models.join(", ")}` : " · no model downloaded yet")
            : "faster-whisper is not installed yet";
        return `
          ${field("Engine", `<select id="pSpEngine">${opts([["groq", "Groq — whisper-large-v3-turbo"],
            ["local", "Local — faster-whisper" + (st?.installed ? "" : " (not installed)")]],
            d.settings.speech_engine)}</select>`, "(Groq unless you install the local one and pick it)")}
          ${local ? `
            ${field("Model", `<select id="pSpModel">${models.map((m) =>
              `<option value="${m.id}" ${m.id === d.settings.speech_model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>`,
              "(downloaded on first use)")}
            ${field("Run on", `<select id="pSpDevice">${opts([["auto", "Auto"], ["cpu", "Processor"],
              ["cuda", "Graphics card"]], d.settings.speech_device)}</select>`)}` : `
            <div class="hint-box">About $0.04 per hour of audio, roughly 200× faster than real time.
              Needs the Groq key above.${d.keys.groq ? "" : " <b>No Groq key set yet.</b>"}</div>`}
          ${field("Language", `<input id="pSpLang" type="text" placeholder="detect automatically"
            value="${esc(d.settings.speech_language || "")}" />`, "(ru, en, … — empty means detect)")}
          <div class="stamp-note">${esc(state_line)}</div>
          ${local && st && !st.error && !st.installed
            ? `<div class="actions"><button class="primary mini" id="pSpInstall">Install faster-whisper</button></div>`
            : ""}`;
      },
      wire: () => {
        $("pSpEngine").addEventListener("change", (e) => { set("speech_engine", e.target.value); renderPrefs(); });
        $("pSpModel")?.addEventListener("change", (e) => set("speech_model", e.target.value));
        $("pSpDevice")?.addEventListener("change", (e) => set("speech_device", e.target.value));
        $("pSpLang").addEventListener("input", (e) => set("speech_language", e.target.value.trim()));
        $("pSpInstall")?.addEventListener("click", installSpeech);
      },
    },
    {
      id: "about", label: "About",
      tip: "What this app is running on.",
      html: () => {
        const st = prefs.speech;
        return `
          <div class="prop-row"><span>Server</span><b>localhost:8765</b></div>
          <div class="prop-row"><span>Posts in the index</span><b>${Store.stats().total}</b></div>
          <div class="prop-row"><span>Editor assets</span><b>${Store.listAssets().length}</b></div>
          <div class="prop-row"><span>Projects</span><b>${Store.listProjects().length}</b></div>
          <div class="prop-row"><span>Local speech</span><b>${st?.installed ? "installed" : "not installed"}</b></div>
          <div class="stamp-note">Media never leaves this machine unless an AI action is run on it.</div>`;
      },
    },
  ];

  const shown = groupPanel($("prefsBody"), groups, prefs.group, {
    statusId: "prefsStatus",
    status: prefs.note,
    pick: (id) => { prefs.group = id; renderPrefs(); },
  });
  prefs.group = shown.id;
  if (shown.id === "keys") testAllKeys();
}

async function testKey(provider) {
  const key = prefs.draft.keys[provider] || "";
  prefs.keyTests[provider] = { pending: true, key };
  renderPrefs();
  let result;
  try {
    result = await post("/api/keys/test", { provider, key });
  } catch (e) {
    result = { ok: false, detail: "check failed: " + e.message };
  }
  // the field may have been edited while the provider was thinking
  if (prefs.draft && prefs.draft.keys[provider] === key) {
    prefs.keyTests[provider] = { ...result, key };
    renderPrefs();
  }
}

/** Opening the tab checks every key that is set, so the dots are honest before
 *  anything is clicked. A key already checked at its current value is skipped. */
function testAllKeys() {
  PROVIDERS.forEach((p) => {
    const key = prefs.draft?.keys[p.id] || "";
    const seen = prefs.keyTests[p.id];
    if (!key || (seen && seen.key === key)) return;
    testKey(p.id);
  });
}

async function installSpeech() {
  prefs.note = "Installing faster-whisper — this downloads about 50 MB…";
  renderPrefs();
  try {
    const { job_id } = await post("/api/speech/install", {});
    for (;;) {
      await new Promise((r) => setTimeout(r, 900));
      const job = await api(`/api/jobs/${job_id}`);
      const item = job.items[0];
      prefs.note = item.stage;
      const st = $("prefsStatus");
      if (st) st.textContent = item.stage;
      if (job.done) {
        if (item.status === "error") prefs.note = "Install failed: " + item.stage;
        break;
      }
    }
  } catch (e) {
    prefs.note = "Install failed: " + e.message;
  }
  await loadSpeechStatus();
  renderPrefs();
}

function closePrefs() {
  prefs.draft = null;
  prefs.note = "";
  $("prefs").classList.add("hidden");
}

$("prefsSave").addEventListener("click", () => {
  const d = prefs.draft;
  Object.entries(d.settings).forEach(([k, v]) => Store.setSetting(k, v));
  Object.entries(d.keys).forEach(([k, v]) => Store.setKey(k, v));
  $("skipExisting").checked = !!d.settings.skip_existing;
  const q = $("pvQuality");
  if (q && q.value !== d.settings.preview_quality) {
    q.value = d.settings.preview_quality;
    q.dispatchEvent(new Event("change"));
  }
  closePrefs();
});
$("prefsCancel").addEventListener("click", closePrefs);
$("prefsClose").addEventListener("click", closePrefs);

/* ====================== editor ====================== */

function applyLayout() {
  const l = Store.layout;
  // the popup's own divider: one variable drives its header and its body, so the
  // column and the title above it never drift apart
  $("aiTool").style.setProperty("--ai-left", (l.ai_left || 260) + "px");
  $("edLib").style.width = l.lib + "px";
  $("edProps").style.width = l.props + "px";
  $("edTimeline").style.height = l.timeline + "px";
  // min-height, not height: extra tracks make the zone grow and the timeline
  // scroll instead of hiding them
  $("tlAudio").style.minHeight = l.audio + "px";
  // the text zone is content-sized: it simply follows the audio rows down
}

function initSashes() {
  document.querySelectorAll(".sash").forEach((sash) => {
    sash.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const kind = sash.dataset.sash;
      const vertical = sash.classList.contains("v");
      const startPos = vertical ? e.clientX : e.clientY;
      const start = Store.layout[kind];
      try { sash.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      sash.classList.add("dragging");
      document.body.classList.add("sashing");
      document.body.classList.toggle("row", !vertical);

      const move = (ev) => {
        const delta = (vertical ? ev.clientX : ev.clientY) - startPos;
        // timeline and audio zones grow upwards, so their delta is inverted
        const invert = kind === "timeline" || kind === "audio" || kind === "text";
        const value = clamp(start + (invert ? -delta : delta),
                            kind === "ai_left" ? 200 : 60, vertical ? 620 : 560);
        Store.layout[kind] = Math.round(value);
        applyLayout();
        if (kind === "timeline" || kind === "audio") renderTimeline();
        if (kind === "ai_left") refreshAiTrack();     // the run bar changed width
      };
      const up = () => {
        sash.removeEventListener("pointermove", move);
        sash.removeEventListener("pointerup", up);
        sash.classList.remove("dragging");
        document.body.classList.remove("sashing", "row");
        Store.setLayout(kind, Store.layout[kind]);
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", up);
    });
  });
}

async function openEditor() {
  if (!state.paths) api("/api/paths").then((p) => { state.paths = p; }).catch(() => {});
  // the registry is cached on the server, so this is a read, not a scan
  if (!state.fonts) loadFonts().then(() => renderPreview());
  if (!state.project) {
    const id = Store.data.lastProject;
    state.project = (id && Store.getProject(id)) || Store.listProjects()[0] || Store.newProject("Project 1");
  }
  renderProjectSelect();
  renderLibrary();
  renderTimeline();
  renderPreview();
  renderProps();
  await syncAssets();
  renderLibrary();
  renderTimeline();
  renderPreview();          // the sync may have changed which file a clip plays
}

function renderProjectSelect() {
  const sel = $("projectSelect");
  sel.innerHTML = Store.listProjects()
    .map((p) => `<option value="${p.id}" ${p.id === state.project.id ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
}

function switchProject(project) {
  stopPlayback();
  releasePool();
  state.project = project;
  state.selectedClips.clear();
  state.history.length = 0;
  state.future.length = 0;
  state.playhead = 0;
  Store.data.lastProject = project.id;
  Store.save();
  renderTimeline();
  renderPreview();
  renderProps();
}

$("projectSelect").addEventListener("change", (e) => switchProject(Store.getProject(e.target.value)));
$("projectNew").addEventListener("click", () => {
  const name = prompt("Project name", `Project ${Store.listProjects().length + 1}`);
  if (!name) return;
  switchProject(Store.newProject(name));
  renderProjectSelect();
});
$("projectRename").addEventListener("click", () => {
  const name = prompt("Project name", state.project.name);
  if (!name) return;
  state.project.name = name;
  Store.touchProject(state.project);
  renderProjectSelect();
});

/* ---------- library ---------- */

document.querySelectorAll(".src").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".src").forEach((x) => x.classList.toggle("on", x === b));
    state.libSource = b.dataset.src;
    $("libType").classList.toggle("hidden", state.libSource !== "vault");
    renderLibrary();
  }));

$("libSearch").addEventListener("input", debounce(renderLibrary, 200));
$("libType").addEventListener("change", renderLibrary);

/** Pull the asset list from disk and bring the store back in line with it.
 *
 *  It used to add only what the store had never seen, which meant a record kept
 *  whatever it was born with for ever: a file could be deleted underneath it and
 *  the library would go on offering the asset as if nothing had happened. Disk
 *  is the authority on the file; the store keeps what the app itself learned
 *  about the asset, a transcript above all, so the two are merged rather than
 *  one replacing the other.
 */
async function syncAssets() {
  try {
    const { assets } = await api("/api/assets");
    const seen = new Set();
    assets.forEach((a) => {
      seen.add(a.id);
      const known = Store.data.assets[a.id];
      Store.upsertAsset(known ? { ...known, ...a } : a);
    });
    // disk has already thrown out what it could not find, so the store follows:
    // a record for a file that does not exist is litter here too. The clips that
    // stood on it stay put and say so — removing someone's footage from their
    // timeline is the one thing that still waits to be asked for.
    Object.keys(Store.data.assets).forEach((id) => { if (!seen.has(id)) Store.removeAsset(id); });
  } catch { /* server offline — keep what we have */ }
}

const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "—");

/* ---------- listening to a library entry ---------- */

/** One sound at a time: a second entry, or the timeline starting to play,
 *  stops whatever was sounding. */
function stopLibAudio() {
  if (!state.libAudio) return;
  try { state.libAudio.el.pause(); } catch { /* already gone */ }
  state.libAudio = null;
}

function toggleLibAudio(id) {
  const asset = Store.data.assets[id];
  if (!asset) return;
  if (state.libAudio?.id === id) { stopLibAudio(); renderLibrary(); return; }
  stopLibAudio();
  if (state.playing) stopPlayback();
  const el = new Audio(assetUrl(asset, false));
  el.addEventListener("timeupdate", paintLibProgress);
  el.addEventListener("ended", () => { stopLibAudio(); renderLibrary(); });
  state.libAudio = { id, el };
  el.play().catch(() => { stopLibAudio(); renderLibrary(); });
  renderLibrary();
}

/** The bar under the row, updated without redrawing the list. */
function paintLibProgress() {
  const sounding = state.libAudio;
  if (!sounding) return;
  const row = document.querySelector(`.lib-row[data-asset="${sounding.id}"] .rprogress`);
  if (!row) return;
  const el = sounding.el;
  const pct = el.duration ? (el.currentTime / el.duration) * 100 : 0;
  row.style.width = pct + "%";
}

function renderLibrary() {
  const list = $("libList");
  const q = $("libSearch").value.trim().toLowerCase();
  list.classList.toggle("rows", state.libSource !== "vault");

  if (state.libSource !== "vault") {
    let items = state.libSource === "audio"
      ? Store.listAssets("audio")
      : Store.listAssets().filter((a) => a.kind !== "audio" && a.origin === "local");
    if (q) items = items.filter((a) => (a.name || "").toLowerCase().includes(q));
    items.sort((a, b) => b.created_at - a.created_at);

    list.innerHTML = items.length ? items.map((a) => {
      const playing = state.libAudio?.id === a.id && !state.libAudio.el.paused;
      const thumb = a.kind === "audio"
        ? `<button class="rplay ${playing ? "on" : ""}" data-play="${a.id}"
             title="${playing ? "Stop" : "Listen"}">${playing ? "⏸" : "▶"}</button>`
        : a.poster ? `<img loading="lazy" draggable="false" src="/assets/${a.poster}" alt="" />` : "▣";
      const wave = a.peaks ? `<svg class="wave" data-peaks="/assets/${a.peaks}" preserveAspectRatio="none"></svg>` : "";
      const origin = a.origin === "extracted" ? "from reel" : a.origin;
      // a record whose file is gone still shows — it may be under someone's
      // timeline — but it says so instead of quietly handing back a black frame
      const gone = a.missing
        ? `<i class="rgone" title="${a.has_proxy ? "The original is gone; the preview plays the proxy copy."
            : "This file is no longer on disk."}">${a.has_proxy ? "proxy only" : "file gone"}</i>` : "";
      return `<div class="lib-row ${playing ? "sounding" : ""}${a.missing ? " gone" : ""}"
                   draggable="true" data-asset="${a.id}"
                   title="${esc(a.name || "")}">
          <span class="rprogress"></span>
          <div class="rthumb">${thumb}</div>
          <div class="rmain">
            <div class="rname">${esc(a.name || a.id)} ${gone}</div>
            ${wave || `<div class="rmeta">${esc(origin)} · ${a.width ? a.width + "×" + a.height : ""}</div>`}
            <div class="rmeta">${dur(a.duration)} · ${esc(origin)}</div>
          </div>
          <button class="rdel" data-del="${a.id}" title="Delete asset">✕</button>
        </div>`;
    }).join("")
      : `<div class="lib-empty">No ${state.libSource === "audio" ? "audio" : "imported"} assets yet.<br />
         ${state.libSource === "audio" ? "Extract audio from a reel in the Vault tab, or import files with +."
                                       : "Use + to import files from disk."}</div>`;

    list.querySelectorAll(".wave").forEach(drawWave);
    list.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this asset and its files?")) return;
        await api(`/api/assets/${b.dataset.del}`, { method: "DELETE" }).catch(() => {});
        Store.removeAsset(b.dataset.del);
        renderLibrary();
      }));
    list.querySelectorAll("[data-play]").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); toggleLibAudio(b.dataset.play); }));
    list.querySelectorAll(".lib-row").forEach((el) =>
      setDragPayload(el, { asset: el.dataset.asset }));
    if (state.libAudio) paintLibProgress();
    return;
  }

  const posts = Store.listPosts({ q, type: $("libType").value, sort: "saved_desc" });
  list.innerHTML = posts.length
    ? posts.map((p) => {
      const hasVideo = (p.media || []).some((m) => m.kind === "video");
      const prepared = Store.listAssets().filter((a) => a.from_post === p.shortcode);
      const marks = (prepared.some((a) => a.kind !== "audio") ? " ✓" : "")
        + (prepared.some((a) => a.kind === "audio") ? " ♪" : "");
      return `<div class="lib-item" draggable="true" data-sc="${p.shortcode}" title="@${esc(p.owner || "")}">
        ${p.thumb ? `<img loading="lazy" draggable="false" src="/media/${p.thumb}" alt="" />` : ""}
        <span class="lb">${p.type === "carousel" ? "❏ " + p.media_count : p.type === "video" ? "▶" : "▣"}${marks}</span>
        <span class="acts">
          <button data-add="${p.shortcode}" title="Add to assets">+</button>
          ${hasVideo ? `<button data-audio="${p.shortcode}" title="Extract audio">♪</button>` : ""}
        </span>
      </div>`;
    }).join("")
    : `<div class="lib-empty">Nothing in the vault matches.</div>`;

  list.querySelectorAll(".lib-item").forEach((el) =>
    setDragPayload(el, { shortcode: el.dataset.sc }));
  list.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); addVaultAsset(b.dataset.add, "media"); }));
  list.querySelectorAll("[data-audio]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); addVaultAsset(b.dataset.audio, "audio"); }));
}

async function drawWave(svg) {
  try {
    const peaks = await (await fetch(svg.dataset.peaks)).json();
    const n = peaks.length;
    const pts = peaks.map((v, i) => `${(i / (n - 1)) * 100},${50 - v / 2.2} ${(i / (n - 1)) * 100},${50 + v / 2.2}`).join(" ");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.innerHTML = `<polyline points="${pts}" />`;
  } catch { /* peaks missing */ }
}

/* ---------- asset jobs ---------- */

function lockLibrary(locked) {
  ["libImport", "libSearch", "libType"].forEach((id) => ($(id).disabled = locked));
  document.querySelectorAll(".src").forEach((b) => (b.disabled = locked));
  $("libList").classList.toggle("locked", locked);
}

/** Runs an asset job with visible progress; resolves with the produced assets. */
function watchAssetJob(jobId) {
  return new Promise((resolve) => {
    const started = Date.now();
    const produced = [];
    $("libJob").classList.remove("hidden");
    lockLibrary(true);
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $("libJobTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);

    const tick = async () => {
      const job = await api(`/api/jobs/${jobId}`);
      $("libJobTitle").textContent = job.done
        ? `Done — ${job.items.filter((i) => i.status === "done").length}/${job.items.length}`
        : `Preparing ${job.current + 1}/${job.items.length}…`;
      $("libJobItems").innerHTML = job.items.map((i) => {
        const mark = i.status === "done" ? '<span class="dot-ok">✓</span>'
          : i.status === "error" ? '<span class="dot-err">✕</span>'
          : i.status === "working" ? '<span class="spinner"></span>' : '<span class="muted">·</span>';
        const pct = i.pct != null ? Math.round(i.pct * 100) : i.status === "working" ? 6 : 0;
        const bar = i.status === "working" ? `<div class="qbar"><i style="width:${pct}%"></i></div>` : "";
        return `<div class="qitem">${mark}<div class="qstage ${i.status === "error" ? "dot-err" : "muted"}">
            ${esc(i.url)} — ${esc(i.stage || "")}</div></div>${bar}`;
      }).join("");
      job.items.forEach((i) => {
        if (i.record) { Store.upsertAsset(i.record); produced.push(i.record); delete i.record; }
      });
      if (job.done) {
        clearInterval(poll);
        clearInterval(timer);
        lockLibrary(false);
        renderLibrary();
        setTimeout(() => $("libJob").classList.add("hidden"), 2500);
        resolve(produced);
      }
    };
    const poll = setInterval(tick, 400);
    tick();
  });
}

async function addVaultAsset(shortcode, mode) {
  const p = Store.getPost(shortcode);
  if (!p) return;
  const file = mode === "audio"
    ? (p.media.find((m) => m.kind === "video") || {}).filename
    : p.media[0].filename;
  if (!file) return;
  const { job_id } = await post("/api/assets/from-vault", {
    shortcode, filename: file, mode,
    name: mode === "audio" ? `${p.owner || shortcode} · audio` : `${p.owner || shortcode} · ${file}`,
  });
  if (mode === "audio") {
    document.querySelector('.src[data-src="audio"]').click();
  }
  watchAssetJob(job_id);
}

$("libImport").addEventListener("click", async () => {
  let paths = [];
  try {
    paths = (await api("/api/assets/pick")).paths;
  } catch (e) {
    alert(`${e.message}\n\nTip: run the app through run.bat — the file picker needs the native window.`);
    return;
  }
  if (!paths.length) return;
  const { job_id } = await post("/api/assets/import", { paths });
  watchAssetJob(job_id);
});

/* ---------- timeline: model helpers ---------- */

const IMAGE_LEN = 4;            // default length of a still on the timeline, seconds
const EDGE_GRAB = 5;            // px around a clip edge that grabs it for trimming
const MIN_TRACK_H = 22;
const MAX_TRACK_H = 200;

/** Width of the track head column — the lane's zero point. Resizable, persisted. */
const headW = () => Store.layout.head || 92;
// new tracks start at the smallest height; anything taller is the user's choice
const trackH = (t) => t.height || MIN_TRACK_H;
/* ---------- variants ----------
 * A clip keeps its original file for good. What an AI action returns is added
 * as a variant, and the clip points at one of them. Everything that needs the
 * media — the timeline, the preview, the render — asks here, so switching is
 * one field and never a copy.
 */
const clipVariant = (clip) => (clip?.variant
  ? (clip.variants || []).find((v) => v.id === clip.variant) || null : null);
const clipAssetId = (clip) => clipVariant(clip)?.asset_id || clip?.asset_id;
const clipAsset = (clip) => Store.data.assets[clipAssetId(clip)] || null;
const onAi = (clip) => !!clipVariant(clip);

const isStill = (clip) => (clipAsset(clip) || {}).kind === "image";

const clipLen = (c) => (c.out - c.in) / (c.params?.speed || 1);
const allClips = () => state.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
const findClip = (id) => allClips().find((x) => x.clip.id === id);

/* Tracks mirror around the sash: video stacks upwards from it, audio downwards,
 * and the i-th track of each kind form a pair (V1↔A1, V2↔A2 …). Pairing goes by
 * position, never by name, so renaming can't break it. */
const tracksOf = (kind) => state.project.tracks.filter((t) => t.kind === kind);
const pairIndex = (track) => tracksOf(track.kind).indexOf(track);

function pairedTrack(track, create = false) {
  if (track.kind === "text") return null;          // titles pair with nothing
  const otherKind = track.kind === "video" ? "audio" : "video";
  const i = pairIndex(track);
  const list = tracksOf(otherKind);
  if (list[i]) return list[i];
  if (!create) return null;
  while (tracksOf(otherKind).length <= i) addTrack(otherKind, true);
  return tracksOf(otherKind)[i];
}

/** Clips tied to this one (video ↔ its extracted audio). */
const partnersOf = (clip) => (clip.link_id
  ? allClips().filter((x) => x.clip.link_id === clip.link_id && x.clip.id !== clip.id)
  : []);

function projectDuration() {
  let end = 0;
  state.project.tracks.forEach((t) => t.clips.forEach((c) => { end = Math.max(end, c.start + clipLen(c)); }));
  return end;
}

/* ---------- keyframes ---------- */

// parameters that can be animated, with their neutral value
const ANIMATABLE = {
  opacity: 1, scale: 1, x: 0, y: 0, rotate: 0,
  brightness: 0, contrast: 1, saturation: 1, volume: 1,
};

/* Easing curves. The same maths lives in render.py — a curve that only exists
 * here would make the preview lie about the finished video. */
const EASINGS = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  in: (u) => u * u,
  out: (u) => u * (2 - u),
  inout: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  back: (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2),
  elastic: (u) => (u <= 0 ? 0 : u >= 1 ? 1
    : Math.pow(2, -10 * u) * Math.sin((10 * u - 0.75) * 2.0943951) + 1),
  bounce: (u) => {
    const n = 7.5625, d = 2.75;
    if (u < 1 / d) return n * u * u;
    if (u < 2 / d) { const x = u - 1.5 / d; return n * x * x + 0.75; }
    if (u < 2.5 / d) { const x = u - 2.25 / d; return n * x * x + 0.9375; }
    const x = u - 2.625 / d;
    return n * x * x + 0.984375;
  },
};

const CURVE_LABELS = {
  linear: "Linear", smooth: "Smooth", in: "Ease in", out: "Ease out",
  inout: "Ease in-out", back: "Overshoot", elastic: "Elastic", bounce: "Bounce",
};

const easeAt = (u, mode) => (EASINGS[mode] || EASINGS.linear)(u);

const keysOf = (clip) => Object.keys(clip.keyframes || {}).filter((k) => clip.keyframes[k]?.length);
const hasKeys = (clip, key) => !!clip.keyframes?.[key]?.length;

/** Value of a parameter inside a clip, `tRel` seconds after the clip starts. */
function paramAt(clip, key, tRel) {
  const kfs = clip.keyframes?.[key];
  const still = clip.params?.[key] ?? ANIMATABLE[key] ?? 0;
  if (!kfs || !kfs.length) return still;
  if (kfs.length === 1 || tRel <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (tRel >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (tRel >= a.t && tRel <= b.t) {
      const span = b.t - a.t || 1e-6;
      return a.v + (b.v - a.v) * easeAt((tRel - a.t) / span, b.ease || a.ease);
    }
  }
  return last.v;
}

/** Every animatable value of a clip at a moment — what the preview draws. */
function paramsAt(clip, t) {
  const tRel = t - clip.start;
  const out = { ...(clip.params || {}) };
  keysOf(clip).forEach((k) => { out[k] = paramAt(clip, k, tRel); });
  return out;
}

function setKeyframe(clip, key, tRel, value, ease = "smooth") {
  const list = (clip.keyframes[key] ||= []);
  const at = list.find((k) => Math.abs(k.t - tRel) < 0.02);
  if (at) { at.v = value; at.ease = ease; }
  else list.push({ t: +tRel.toFixed(3), v: value, ease });
  list.sort((a, b) => a.t - b.t);
}

function clearKeyframes(clip, key, keepValueAt) {
  if (keepValueAt != null && hasKeys(clip, key)) {
    clip.params[key] = paramAt(clip, key, keepValueAt);
  }
  delete clip.keyframes[key];
}

/* ---------- animation presets ---------- */

/* Ready-made moves, written as ordinary keyframes on the parameters we already
 * render. Nothing here is a special effect the ffmpeg graph doesn't know about,
 * so a preset looks the same in the preview and in the finished file. */

const PRESET_TIME = { slow: 1.8, normal: 1, fast: 0.55 };   // stretches entrances/exits
const PRESET_GAIN = { slow: 0.6, normal: 1, fast: 1.6 };    // deepens the movement itself

const kfAt = (t, v, ease = "smooth") => ({ t: +t.toFixed(3), v: +v.toFixed(4), ease });

/** Deterministic jitter — a fixed shake beats one that changes on every click. */
const wobble = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

const PRESETS = [
  { id: "zoom_in", row: "Move", label: "Zoom in",
    tip: "Slow push into the frame across the whole clip.",
    build: ({ len, a }) => ({ keys: { scale: [kfAt(0, 1, "linear"), kfAt(len, 1 + 0.18 * a, "linear")] } }) },
  { id: "zoom_out", row: "Move", label: "Zoom out",
    tip: "Slow pull back across the whole clip.",
    build: ({ len, a }) => ({ keys: { scale: [kfAt(0, 1 + 0.18 * a, "linear"), kfAt(len, 1, "linear")] } }) },
  { id: "ken_burns", row: "Move", label: "Ken Burns",
    tip: "The slideshow classic: a slow push with a diagonal drift. Best on photos.",
    build: ({ len, a }) => ({ keys: {
      scale: [kfAt(0, 1.04, "linear"), kfAt(len, 1.04 + 0.2 * a, "linear")],
      x: [kfAt(0, 0.05 * a, "linear"), kfAt(len, -0.05 * a, "linear")],
      y: [kfAt(0, 0.03 * a, "linear"), kfAt(len, -0.03 * a, "linear")] } }) },
  { id: "breathe", row: "Move", label: "Breathe",
    tip: "A gentle zoom in and back out. Calm enough to sit under text.",
    build: ({ len, a }) => ({ keys: { scale: [kfAt(0, 1), kfAt(len / 2, 1 + 0.06 * a), kfAt(len, 1)] } }) },

  { id: "drift_left", row: "Drift", label: "←", icon: true,
    tip: "The picture drifts left over the whole clip, zoomed slightly so no edge creeps in.",
    build: ({ len, a }) => ({ params: { scale: 1.12 },
      keys: { x: [kfAt(0, 0.06 * a, "linear"), kfAt(len, -0.06 * a, "linear")] } }) },
  { id: "drift_right", row: "Drift", label: "→", icon: true,
    tip: "The picture drifts right over the whole clip.",
    build: ({ len, a }) => ({ params: { scale: 1.12 },
      keys: { x: [kfAt(0, -0.06 * a, "linear"), kfAt(len, 0.06 * a, "linear")] } }) },
  { id: "drift_up", row: "Drift", label: "↑", icon: true,
    tip: "The picture drifts upwards over the whole clip.",
    build: ({ len, a }) => ({ params: { scale: 1.12 },
      keys: { y: [kfAt(0, 0.06 * a, "linear"), kfAt(len, -0.06 * a, "linear")] } }) },
  { id: "drift_down", row: "Drift", label: "↓", icon: true,
    tip: "The picture drifts downwards over the whole clip.",
    build: ({ len, a }) => ({ params: { scale: 1.12 },
      keys: { y: [kfAt(0, -0.06 * a, "linear"), kfAt(len, 0.06 * a, "linear")] } }) },

  { id: "fade_in", row: "In", label: "Fade",
    tip: "Opacity climbs from nothing at the clip's start.",
    build: ({ d }) => ({ keys: { opacity: [kfAt(0, 0, "out"), kfAt(d, 1, "out")] } }) },
  { id: "pop_in", row: "In", label: "Pop",
    tip: "Springs up from smaller than full size and overshoots a little before settling.",
    build: ({ d }) => ({ keys: {
      scale: [kfAt(0, 0.72, "back"), kfAt(d, 1, "back")],
      opacity: [kfAt(0, 0, "out"), kfAt(d * 0.5, 1, "out")] } }) },
  { id: "slide_in_left", row: "In", label: "←", icon: true,
    tip: "Flies in from the right edge and settles in place, travelling left.",
    build: ({ d }) => ({ keys: { x: [kfAt(0, 1.1, "out"), kfAt(d, 0, "out")] } }) },
  { id: "slide_in_right", row: "In", label: "→", icon: true,
    tip: "Flies in from the left edge, travelling right.",
    build: ({ d }) => ({ keys: { x: [kfAt(0, -1.1, "out"), kfAt(d, 0, "out")] } }) },
  { id: "slide_in_up", row: "In", label: "↑", icon: true,
    tip: "Rises into place from below the frame.",
    build: ({ d }) => ({ keys: { y: [kfAt(0, 1.1, "out"), kfAt(d, 0, "out")] } }) },
  { id: "slide_in_down", row: "In", label: "↓", icon: true,
    tip: "Drops into place from above the frame.",
    build: ({ d }) => ({ keys: { y: [kfAt(0, -1.1, "out"), kfAt(d, 0, "out")] } }) },

  { id: "fade_out", row: "Out", label: "Fade",
    tip: "Opacity falls away over the clip's last moments.",
    build: ({ len, d }) => ({ keys: { opacity: [kfAt(len - d, 1, "in"), kfAt(len, 0, "in")] } }) },
  { id: "slide_out_left", row: "Out", label: "←", icon: true,
    tip: "Leaves through the left edge at the end of the clip.",
    build: ({ len, d }) => ({ keys: { x: [kfAt(len - d, 0, "in"), kfAt(len, -1.1, "in")] } }) },
  { id: "slide_out_right", row: "Out", label: "→", icon: true,
    tip: "Leaves through the right edge at the end of the clip.",
    build: ({ len, d }) => ({ keys: { x: [kfAt(len - d, 0, "in"), kfAt(len, 1.1, "in")] } }) },
  { id: "slide_out_up", row: "Out", label: "↑", icon: true,
    tip: "Leaves upwards, out of the top of the frame.",
    build: ({ len, d }) => ({ keys: { y: [kfAt(len - d, 0, "in"), kfAt(len, -1.1, "in")] } }) },
  { id: "slide_out_down", row: "Out", label: "↓", icon: true,
    tip: "Leaves downwards, out of the bottom of the frame.",
    build: ({ len, d }) => ({ keys: { y: [kfAt(len - d, 0, "in"), kfAt(len, 1.1, "in")] } }) },

  { id: "punch", row: "Accent", label: "Punch",
    tip: "A quick hit of scale that snaps back — put it on the beat.",
    build: ({ len, d, a }) => { const w = Math.min(d, len / 2);
      return { keys: { scale: [kfAt(0, 1, "out"), kfAt(w * 0.45, 1 + 0.12 * a, "out"), kfAt(w, 1, "in")] } }; } },
  { id: "flash", row: "Accent", label: "Flash",
    tip: "A short burst of brightness at the clip's start, like a camera flash.",
    build: ({ len, d, a }) => { const w = Math.min(d * 0.5, len / 2);
      return { keys: { brightness: [kfAt(0, 0, "out"), kfAt(w * 0.35, 0.5 * a, "out"), kfAt(w, 0, "in")] } }; } },
  { id: "shake", row: "Accent", label: "Shake",
    tip: "Handheld camera wobble for the whole clip, zoomed a touch so the edges stay covered.",
    build: ({ len, a }) => {
      const n = clamp(Math.round(len * 7), 6, 48), amp = 0.012 * a, step = len / n;
      const xs = [], ys = [];
      for (let i = 0; i <= n; i++) {
        xs.push(kfAt(i * step, i === 0 || i === n ? 0 : wobble(i) * amp, "linear"));
        ys.push(kfAt(i * step, i === 0 || i === n ? 0 : wobble(i + 97) * amp, "linear"));
      }
      return { params: { scale: 1.05 }, keys: { x: xs, y: ys } };
    } },
];

const PRESET_ROWS = ["Move", "Drift", "In", "Out", "Accent"];
const ROW_TIPS = {
  Move: "Movement that lasts the whole clip.",
  Drift: "A slow slide in one direction, the whole clip long.",
  In: "How the clip arrives, in its first moments.",
  Out: "How the clip leaves, in its last moments.",
  Accent: "Short hits and camera feel.",
};

/** Timings for one clip: how long it is, how long an entrance gets, how deep the move goes. */
function presetContext(clip) {
  const len = Math.max(0.2, clipLen(clip));
  return {
    len,
    d: Math.min(len * 0.45, 0.6 * PRESET_TIME[state.presetSpeed]),
    a: PRESET_GAIN[state.presetSpeed],
  };
}

/** Write a preset onto one clip. Keyframes inside the preset's own span are
 *  replaced, anything outside it survives — so a fade in and a fade out stack. */
function applyPresetTo(clip, preset) {
  const built = preset.build(presetContext(clip));
  clip.keyframes = clip.keyframes || {};
  clip.params = clip.params || {};
  Object.entries(built.params || {}).forEach(([key, v]) => { clip.params[key] = v; });
  Object.entries(built.keys || {}).forEach(([key, list]) => {
    const fresh = list.map((kf) => (state.presetCurve === "auto" ? kf : { ...kf, ease: state.presetCurve }));
    const t0 = Math.min(...fresh.map((kf) => kf.t));
    const t1 = Math.max(...fresh.map((kf) => kf.t));
    const kept = (clip.keyframes[key] || []).filter((kf) => kf.t < t0 - 0.01 || kf.t > t1 + 0.01);
    clip.keyframes[key] = [...kept, ...fresh].sort((a, b) => a.t - b.t);
  });
}

/* ---------- undo / redo ---------- */

function snapshot() {
  state.history.push(JSON.stringify(state.project));
  if (state.history.length > 60) state.history.shift();
  state.future.length = 0;
}

function commit() {
  Store.touchProject(state.project);
  renderTimeline();
  renderPreview();
}

function restore(json) {
  state.project = JSON.parse(json);
  Store.data.projects[state.project.id] = state.project;
  Store.save();
  state.selectedClips.clear();
  renderTimeline();
  renderPreview();
  renderProps();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify(state.project));
  restore(state.history.pop());
}

function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify(state.project));
  restore(state.future.pop());
}

/* ---------- snapping ---------- */

function snapTime(t, ignoreIds = []) {
  if (!state.snap) return Math.max(0, t);
  const threshold = 8 / state.pps;
  const marks = [0, state.playhead];
  allClips().forEach(({ clip }) => {
    if (ignoreIds.includes(clip.id)) return;
    marks.push(clip.start, clip.start + clipLen(clip));
  });
  let best = t, bestDelta = threshold;
  marks.forEach((m) => {
    const d = Math.abs(m - t);
    if (d < bestDelta) { bestDelta = d; best = m; }
  });
  return Math.max(0, best);
}

/* ---------- rendering ---------- */

/** Diamonds along the bottom of a clip, one per keyframe moment. */
function keyframeMarks(clip) {
  const keys = keysOf(clip);
  if (!keys.length) return "";
  const times = new Set();
  keys.forEach((k) => clip.keyframes[k].forEach((kf) => times.add(+kf.t.toFixed(3))));
  const len = clipLen(clip);
  return `<span class="kf-strip">` + [...times]
    .filter((t) => t >= 0 && t <= len)
    .map((t) => `<i style="left:${t * state.pps}px" title="${t.toFixed(2)}s"></i>`)
    .join("") + `</span>`;
}

/** Where a scene scan would cut this clip, drawn before anything is committed.
 *  Each mark can be dragged to a better moment, or double-clicked to drop it. */
function cutMarks(c) {
  const scan = state.sceneScan;
  if (!scan || scan.stage !== "review") return "";
  const marks = scanOf(scan, c)?.marks || [];
  if (!marks.length) return "";
  return `<span class="cut-strip">` + marks.map((m, i) =>
    `<i class="${m.custom ? "moved" : ""} ${scan.selected === i && scan.selectedClip === c.id ? "picked" : ""}"
        data-mark="${i}" data-of="${c.id}" style="left:${m.at * state.pps}px"
        title="${m.at.toFixed(2)}s${m.custom ? " · moved by hand" : ` · score ${(m.score ?? 0).toFixed(2)}`
        } — drag to adjust, click to select, double-click to remove"></i>`).join("") + `</span>`;
}

/** The quiet stretches a silence pass would cut, shaded on the clip. */
function silenceMarks(c) {
  const sil = state.silence;
  if (!sil || sil.stage !== "review" || !sil.byClip?.[c.id]) return "";
  const gaps = silenceGaps(sil, c);
  if (!gaps.length) return "";
  return `<span class="cut-strip">` + gaps.map((g) =>
    `<u style="left:${g.from * state.pps}px;width:${(g.to - g.from) * state.pps}px"
        title="${(g.to - g.from).toFixed(2)}s of quiet"></u>`).join("") + `</span>`;
}

/** Nudging one mark. The timeline is not redrawn while the pointer is down —
 *  that would delete the very element being dragged. The preview follows the
 *  mark so the frame you are cutting on is on screen. */
function startMarkDrag(el, e) {
  const scan = state.sceneScan;
  const found = findClip(el.dataset.of || scan.clipId);
  if (!found) return;
  const clip = found.clip;
  const i = Number(el.dataset.mark);
  const marks = scanOf(scan, clip)?.marks;
  if (!marks) return;
  const len = clipLen(clip);
  const startX = e.clientX;
  const startAt = marks[i].at;
  const low = (marks[i - 1]?.at ?? 0) + 0.05;
  const high = (marks[i + 1]?.at ?? len) - 0.05;
  let at = startAt;
  let dragged = false;

  scan.selected = i;
  scan.selectedClip = clip.id;
  document.querySelectorAll(".cut-strip i.picked").forEach((n) => n.classList.remove("picked"));
  el.classList.add("picked");

  const showFrame = () => {
    state.previewAt = clip.start + at;
    state.scrubbing = true;            // Auto quality drops while the mark moves
    seekActive();
    scheduleFrame();
  };
  const move = (ev) => {
    at = clamp(startAt + (ev.clientX - startX) / state.pps, Math.max(0.05, low), Math.min(len - 0.05, high));
    if (Math.abs(ev.clientX - startX) > 2) dragged = true;
    el.style.left = at * state.pps + "px";
    el.title = `${at.toFixed(2)}s · moved by hand`;
    if (dragged) { el.classList.add("moved"); showFrame(); }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    state.previewAt = null;            // back to whatever the playhead is on
    state.scrubbing = false;
    if (dragged && Math.abs(at - startAt) > 1e-3) {
      marks[i] = { at: +at.toFixed(3), score: marks[i].score, custom: true };
      state.status = `Cut moved to ${at.toFixed(2)}s`;
    } else {
      state.status = `Cut at ${marks[i].at.toFixed(2)}s selected — Del removes it`;
    }
    renderTimeline();
    renderProps();
    renderPreview();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function removeMark(index, ofClip = null) {
  const scan = state.sceneScan;
  const own = scanOf(scan, findClip(ofClip || scan?.selectedClip || scan?.clipId)?.clip);
  const i = Number(index);
  if (!own?.marks || !(i in own.marks)) return;
  own.marks.splice(i, 1);
  scan.selected = null;
  scan.selectedClip = null;
  state.status = "Cut removed";
  renderTimeline();
  renderProps();
}

/** A cut wherever the playhead is — the answer to "the detector missed it". */
function addMarkAtPlayhead(fallback) {
  const scan = state.sceneScan;
  if (!scan) return;
  // with several fragments in play, the cut belongs to the one under the playhead
  const clip = scan.targets.map((id) => findClip(id)?.clip).filter(Boolean)
    .find((c) => state.playhead >= c.start && state.playhead < c.start + clipLen(c)) || fallback;
  const own = scanOf(scan, clip) || (scan.byClip[clip.id] = { cuts: [], scanned: 0, marks: [] });
  const at = state.playhead - clip.start;
  const len = clipLen(clip);
  if (at < 0.05 || at > len - 0.05) {
    state.status = "Put the playhead inside this clip first";
    renderProps();
    return;
  }
  if ((own.marks || []).some((m) => Math.abs(m.at - at) < 0.05)) {
    state.status = "There is already a cut there";
    renderProps();
    return;
  }
  own.marks = [...(own.marks || []), { at: +at.toFixed(3), score: null, custom: true }]
    .sort((a, b) => a.at - b.at);
  scan.selected = own.marks.findIndex((m) => Math.abs(m.at - at) < 1e-6);
  scan.selectedClip = clip.id;
  if (scan.stage === "settings") scan.stage = "review";   // hand-made cuts need no scan
  state.status = `Cut added at ${at.toFixed(2)}s`;
  renderTimeline();
  renderProps();
}

/** Rebuild the marks after a slider moves: automatic ones follow the sliders,
 *  anything the user placed by hand stays exactly where they put it. */
function refreshMarks(scan) {
  scan.targets.forEach((id) => {
    const clip = findClip(id)?.clip;
    const own = scanOf(scan, clip);
    if (!clip || !own) return;
    const custom = (own.marks || []).filter((m) => m.custom);
    const auto = keptCuts(scan, clip)
      .filter((c) => custom.every((m) => Math.abs(m.at - c.at) >= scan.minLen))
      .map((c) => ({ ...c, custom: false }));
    own.marks = [...custom, ...auto].sort((a, b) => a.at - b.at);
  });
}

function clipVisual(c) {
  if (c.kind === "text") return `<span class="clip-text">${esc(c.text || "")}</span>`;
  const asset = clipAsset(c);
  if (!asset) return "";
  const pps = state.pps;
  if (c.kind === "audio" || (asset.kind === "audio")) {
    return asset.peaks
      ? `<svg class="clip-wave" data-peaks="/assets/${asset.peaks}" data-in="${c.in}"
              data-dur="${asset.duration}" preserveAspectRatio="none"></svg>` : "";
  }
  if (asset.strip && asset.duration) {
    const full = asset.duration * pps / (c.params?.speed || 1);
    return `<div class="clip-strip" style="background-image:url(/assets/${asset.strip});
              background-size:${full}px 100%;background-position:${-c.in * pps}px 0"></div>`;
  }
  if (asset.poster) {
    return `<div class="clip-strip" style="background-image:url(/assets/${asset.poster});
              background-size:cover;background-position:center"></div>`;
  }
  return "";
}

function renderTimeline() {
  const dur = Math.max(projectDuration(), 10);
  const width = dur * state.pps + 240;
  $("edTimeline").style.setProperty("--head-w", headW() + "px");
  $("tlDuration").textContent = mmss(projectDuration());
  $("tlSnap").classList.toggle("on", state.snap);

  const stepSec = state.pps < 25 ? 10 : state.pps < 60 ? 5 : 1;
  let ticks = "";
  for (let s = 0; s <= dur + stepSec; s += stepSec) {
    ticks += `<i style="left:${headW() + s * state.pps}px">${mmss(s)}</i>`;
  }
  // the corner above the track heads holds the track-layout presets
  $("tlRuler").innerHTML = `<div class="tl-corner" id="tlCorner">
      <select id="tlLayout" title="Track layout"></select>
      <button class="mini-icon" id="tlLayoutSave" title="Save the current tracks into this layout">💾</button>
      <button class="mini-icon" id="tlLayoutDel" title="Delete this layout">🗑</button>
      <button class="mini-icon" id="tlLayoutNew" title="Save the current tracks as a new layout">+</button>
      <span class="head-edge"></span>
    </div>${ticks}`;
  $("tlRuler").style.width = width + "px";

  const renderZone = (kind, host) => {
    // video is drawn bottom-up so V1 hugs the sash and higher tracks sit on top
    const tracks = kind === "video" ? [...tracksOf("video")].reverse() : tracksOf(kind);
    host.innerHTML = tracks.map((t) => `
      <div class="tl-track ${kind} ${state.selectedTrack === t.id ? "track-selected" : ""}"
           data-track="${t.id}" style="height:${trackH(t)}px">
        <div class="tl-head">
          <button class="tsel" data-tact="select" title="Select whole track and open its settings">▤</button>
          <span class="tname" data-tact="rename" title="Double-click to rename">${esc(t.name)}</span>
          <span class="tpair" title="Paired with ${esc(pairedTrack(t)?.name || "—")}">${pairIndex(t) + 1}</span>
          ${t.kind === "audio"
            ? `<button data-tact="mute" title="Mute this audio track">${t.muted ? "🔇" : "🔊"}</button>`
            : `<button data-tact="hide" title="Hide this ${t.kind} track">${t.hidden ? "🚫" : "👁"}</button>`}
          <button data-tact="del" title="Remove track">✕</button>
          <span class="head-edge"></span>
        </div>
        <div class="tl-lane ${t.locked ? "locked" : ""} ${t.kind === "audio" && t.muted ? "muted-lane" : ""}"
             data-track="${t.id}" style="width:${width}px">
          ${t.clips.map((c) => `
            <div class="tl-clip ${state.selectedClips.has(c.id) ? "selected" : ""}
                 ${c.link_id && c.kind === "audio" ? "linked-ghost" : ""} ${c.link_id ? "linked" : ""}
                 ${onAi(c) ? "on-ai" : ""}"
                 data-clip="${c.id}" style="left:${c.start * state.pps}px;width:${clipLen(c) * state.pps}px">
              ${clipVisual(c)}
              ${onAi(c) ? `<span class="ai-badge" title="Playing the AI version: ${esc(clipVariant(c).label)}">AI</span>` : ""}
              ${cutMarks(c)}
              ${silenceMarks(c)}
              ${c.transition_in ? `<span class="trans-mark in" style="width:${(c.transition_in.dur || 0.5) * state.pps}px"></span>` : ""}
              ${c.transition_out ? `<span class="trans-mark out" style="width:${(c.transition_out.dur || 0.5) * state.pps}px"></span>` : ""}
              <span class="clip-name">${c.link_id ? "🔗 " : ""}${esc(c.name || "")}</span>
              ${keyframeMarks(c)}
            </div>`).join("")}
          <div class="edge-hint hidden"></div>
        </div>
        <div class="track-resize ${kind === "video" ? "top" : ""}"
             title="Drag ${kind === "video" ? "up" : "down"} to change track height"></div>
      </div>`).join("") || `<div class="lib-empty">No ${kind} tracks.</div>`;

    host.querySelectorAll(".tl-track").forEach((row) => {
      const track = state.project.tracks.find((t) => t.id === row.dataset.track);
      if (!track) return;
      row.querySelectorAll("button[data-tact]").forEach((btn) =>
        btn.addEventListener("click", () => trackAction(track, btn.dataset.tact)));
      row.querySelector(".tname").addEventListener("dblclick", (e) => startRename(e.target, track));
      row.querySelector(".tl-head").addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openTrackMenu(track, e.clientX, e.clientY);
      });
      wireTrackResize(row.querySelector(".track-resize"), track);
    });
    host.querySelectorAll(".head-edge").forEach(wireHeadResize);
    host.querySelectorAll(".tl-lane").forEach(wireLane);
  };

  renderZone("video", $("tlVideo"));
  renderZone("audio", $("tlAudio"));
  renderZone("text", $("tlText"));
  wireHeadResize($("tlCorner").querySelector(".head-edge"));
  renderLayoutPicker();
  document.querySelectorAll(".clip-wave").forEach(drawClipWave);
  $("playhead").style.left = headW() + state.playhead * state.pps + "px";
  $("pvTime").textContent = `${state.playhead.toFixed(1)}s / ${mmss(projectDuration())}`;
}

/* ---------- track layouts ---------- */

const BUILTIN_LAYOUTS = [
  { id: "bi-default", name: "Default", builtin: true, tracks: [
    { kind: "video", name: "V1" }, { kind: "audio", name: "A1" }] },
  { id: "bi-reel", name: "Reel", builtin: true, tracks: [
    { kind: "video", name: "Main" }, { kind: "video", name: "Overlay" },
    { kind: "audio", name: "Voice" }, { kind: "audio", name: "Music" }] },
  { id: "bi-talking", name: "Talking head", builtin: true, tracks: [
    { kind: "video", name: "Talk" }, { kind: "video", name: "B-roll" }, { kind: "video", name: "Titles" },
    { kind: "audio", name: "Voice" }, { kind: "audio", name: "SFX" }, { kind: "audio", name: "Music" }] },
];

const allLayouts = () => [...BUILTIN_LAYOUTS, ...Store.listLayouts()];

/** The layout the current project actually has right now. */
const currentLayout = () => state.project.tracks.map((t) => ({
  kind: t.kind, name: t.name, height: trackH(t),
}));

function renderLayoutPicker() {
  const sel = $("tlLayout");
  if (!sel) return;
  sel.innerHTML = `<option value="">Current</option>` + allLayouts().map((l) =>
    `<option value="${l.id}" ${l.id === Store.data.lastLayout ? "selected" : ""}>${esc(l.name)}${l.builtin ? "" : " ·"}</option>`).join("");
  sel.onchange = () => applyLayoutPreset(sel.value);
  $("tlLayoutSave").onclick = () => saveCurrentLayout();
  $("tlLayoutDel").onclick = () => deleteCurrentLayout();
  $("tlLayoutNew").onclick = () => {
    const name = prompt("Name for this track layout", "Layout " + (Store.listLayouts().length + 1));
    if (!name) return;
    const l = Store.addLayout(name.trim(), currentLayout());
    state.status = `Saved layout “${l.name}”`;
    renderTimeline();
  };
}

function saveCurrentLayout() {
  const id = $("tlLayout").value;
  const layout = Store.listLayouts().find((l) => l.id === id);
  if (!layout) {
    alert("Pick one of your own layouts to overwrite, or press + to save a new one.\n" +
          "Built-in layouts can't be changed.");
    return;
  }
  Store.saveLayout(id, currentLayout());
  state.status = `Layout “${layout.name}” updated`;
  renderTimeline();
}

function deleteCurrentLayout() {
  const id = $("tlLayout").value;
  const layout = Store.listLayouts().find((l) => l.id === id);
  if (!layout) {
    alert("Pick one of your own layouts to delete — built-in ones stay.");
    return;
  }
  if (!confirm(`Delete the layout “${layout.name}”? The tracks on the timeline stay as they are.`)) return;
  Store.removeLayout(id);
  state.status = `Layout “${layout.name}” deleted`;
  renderTimeline();
  renderProps();
}

/** Apply a layout: rename/add tracks, drop only the surplus EMPTY ones. */
function applyLayoutPreset(id) {
  const layout = allLayouts().find((l) => l.id === id);
  if (!layout) return;
  snapshot();
  let kept = 0;
  ["video", "audio"].forEach((kind) => {
    const wanted = layout.tracks.filter((t) => t.kind === kind);
    wanted.forEach((w, i) => {
      let track = tracksOf(kind)[i];
      if (!track) { addTrack(kind, true); track = tracksOf(kind)[i]; }
      track.name = w.name;
      if (w.height) track.height = w.height;
      Store.setTrackName(kind, i, w.name);
    });
    // surplus tracks go only if nothing lives on them
    tracksOf(kind).slice(wanted.length).forEach((t) => {
      if (t.clips.length) { kept++; return; }
      state.project.tracks = state.project.tracks.filter((x) => x !== t);
    });
  });
  Store.data.lastLayout = id;
  Store.save();
  state.status = `Layout “${layout.name}” applied` + (kept ? ` · ${kept} track(s) kept, they have clips` : "");
  commit();
  renderProps();
}

/* ---------- track head: actions, rename, resizing ---------- */

function trackAction(track, act) {
  if (act === "select") { selectTrack(track.id); return; }
  snapshot();
  if (act === "mute") track.muted = !track.muted;
  if (act === "hide") track.hidden = !track.hidden;
  if (act === "del") {
    if (track.clips.length && !confirm(`Remove ${track.name} with its clips?`)) {
      state.history.pop();
      return;
    }
    state.project.tracks = state.project.tracks.filter((t) => t !== track);
    if (state.selectedTrack === track.id) state.selectedTrack = null;
  }
  commit();
  renderProps();
}

function selectTrack(trackId) {
  const track = state.project.tracks.find((t) => t.id === trackId);
  if (!track) return;
  state.selectedTrack = trackId;
  state.selectedClips.clear();
  track.clips.forEach((c) => state.selectedClips.add(c.id));
  renderTimeline();
  renderProps();
}

function openTrackMenu(track, x, y) {
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.innerHTML = `
    <button data-act="select">Select all clips</button>
    <button data-act="rename">Rename…</button>
    <button data-act="duplicate">Duplicate track</button>
    <div class="sep"></div>
    <button data-act="clear">Remove all clips</button>
    <button data-act="del">Delete track</button>`;
  document.body.appendChild(menu);

  const close = () => { menu.remove(); document.removeEventListener("pointerdown", close, true); };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);

  menu.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const act = b.dataset.act;
    close();
    if (act === "select") return selectTrack(track.id);
    if (act === "rename") {
      const span = document.querySelector(`.tl-track[data-track="${track.id}"] .tname`);
      if (span) startRename(span, track);
      return;
    }
    if (act === "duplicate") {
      snapshot();
      const copy = JSON.parse(JSON.stringify(track));
      copy.id = (track.kind === "video" ? "v" : "a") + Date.now().toString(36);
      copy.name = track.name + " copy";
      copy.clips.forEach((c, i) => { c.id = "c" + Date.now().toString(36) + i.toString(36); });
      state.project.tracks.splice(state.project.tracks.indexOf(track) + 1, 0, copy);
      commit();
      return;
    }
    if (act === "clear") {
      if (!track.clips.length) return;
      if (!confirm(`Remove all ${track.clips.length} clip(s) from ${track.name}?`)) return;
      snapshot();
      track.clips = [];
      commit();
      renderProps();
      return;
    }
    if (act === "del") trackAction(track, "del");
  }));
}

function startRename(span, track) {
  const input = document.createElement("input");
  input.className = "tname-input";
  input.value = track.name;
  span.replaceWith(input);
  input.focus();
  input.select();
  const finish = (save) => {
    const name = input.value.trim();
    if (save && name && name !== track.name) {
      snapshot();
      track.name = name;
      // names are global by position: new projects start with this scheme
      Store.setTrackName(track.kind, pairIndex(track), name);
      Store.touchProject(state.project);
      state.status = `Track name “${name}” saved for new projects`;
    }
    renderTimeline();
    renderProps();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function wireTrackResize(grip, track) {
  if (!grip) return;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = trackH(track);
    const row = grip.closest(".tl-track");
    // the grip on a video row sits on top, so dragging up must make it taller
    const dir = grip.classList.contains("top") ? -1 : 1;
    const move = (ev) => {
      track.height = clamp(Math.round(startH + dir * (ev.clientY - startY)), MIN_TRACK_H, MAX_TRACK_H);
      row.style.height = track.height + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      Store.touchProject(state.project);
      renderTimeline();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function wireHeadResize(edge) {
  if (!edge) return;
  edge.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = headW();
    document.body.classList.add("sashing");
    const move = (ev) => {
      Store.layout.head = clamp(Math.round(startW + ev.clientX - startX), 60, 320);
      $("edTimeline").style.setProperty("--head-w", Store.layout.head + "px");
      $("playhead").style.left = Store.layout.head + state.playhead * state.pps + "px";
      $("tlRuler").querySelectorAll("i").forEach((tick, i) => {
        const stepSec = state.pps < 25 ? 10 : state.pps < 60 ? 5 : 1;
        tick.style.left = Store.layout.head + i * stepSec * state.pps + "px";
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("sashing");
      Store.setLayout("head", Store.layout.head);
      renderTimeline();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

const peaksCache = new Map();          // url -> peaks array, so re-renders don't re-fetch

async function loadPeaks(url) {
  if (peaksCache.has(url)) return peaksCache.get(url);
  const data = await (await fetch(url)).json();
  peaksCache.set(url, data);
  return data;
}

async function drawClipWave(svg) {
  try {
    const peaks = await loadPeaks(svg.dataset.peaks);
    const total = Number(svg.dataset.dur) || 1;
    const inSec = Number(svg.dataset.in) || 0;
    const rect = svg.getBoundingClientRect();
    const visible = rect.width / state.pps;                 // seconds shown by this clip
    const from = Math.floor((inSec / total) * peaks.length);
    const to = Math.max(from + 2, Math.ceil(((inSec + visible) / total) * peaks.length));
    const slice = peaks.slice(from, to);
    const n = slice.length;
    const pts = slice.map((v, i) =>
      `${(i / (n - 1)) * 100},${50 - v / 2.1} ${(i / (n - 1)) * 100},${50 + v / 2.1}`).join(" ");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.innerHTML = `<polyline points="${pts}" />`;
  } catch { /* peaks unavailable */ }
}

/* ---------- selection & properties ---------- */

function selectClip(id, additive) {
  // a half-finished scan belongs to the clip you were looking at, not the next one
  if (id && !state.selectedClips.has(id)) closeSubPanels();
  if (!additive) { state.selectedClips.clear(); state.selectedTrack = null; }
  if (id) state.selectedClips.has(id) && additive ? state.selectedClips.delete(id) : state.selectedClips.add(id);
  renderTimeline();
  renderProps();
}

function renderProps() {
  if (state.selectedTrack) { renderTrackProps(); return; }
  const entries = [...state.selectedClips].map((id) => findClip(id)).filter(Boolean);
  if (!entries.length) { renderProjectProps(); return; }
  renderClipProps(entries);
}

/* ---------- project settings (shown when nothing is selected) ---------- */

const CANVAS_PRESETS = [
  { id: "9:16", name: "9:16 · Reels, Shorts, TikTok", w: 1080, h: 1920 },
  { id: "4:5", name: "4:5 · Instagram feed", w: 1080, h: 1350 },
  { id: "1:1", name: "1:1 · Square", w: 1080, h: 1080 },
  { id: "16:9", name: "16:9 · YouTube, landscape", w: 1920, h: 1080 },
  { id: "custom", name: "Custom", w: 0, h: 0 },
];

function currentPreset() {
  const { w, h } = state.project.canvas;
  return (CANVAS_PRESETS.find((p) => p.w === w && p.h === h) || CANVAS_PRESETS.at(-1)).id;
}

function renderProjectProps() {
  const { w, h, fps } = state.project.canvas;
  const applyCanvas = (nw, nh, nfps) => {
    snapshot();
    state.project.canvas = { w: Math.max(64, Math.round(nw)), h: Math.max(64, Math.round(nh)), fps: nfps };
    commit();
    state.status = `Canvas ${state.project.canvas.w}×${state.project.canvas.h} · ${nfps} fps`;
    renderProps();
  };

  inspector("project", [
    {
      id: "info", label: "Info",
      html: () => `
        <label class="field"><span>Name</span>
          <input id="prName" type="text" value="${esc(state.project.name)}" /></label>
        <div class="prop-row"><span>Canvas</span><b>${w}×${h} · ${(w / h).toFixed(3)}</b></div>
        <div class="prop-row"><span>Content</span><b>${allClips().length} clip(s) · ${mmss(projectDuration())}</b></div>
        <div class="prop-row"><span>Tracks</span><b>${tracksOf("video").length} video · ${tracksOf("audio").length} audio · ${tracksOf("text").length} text</b></div>
        <div class="prop-row"><span>Media</span><b class="path">${esc(state.paths?.media_dir || "…")}</b></div>
        <div class="prop-row"><span>Assets</span><b class="path">${esc(state.paths?.assets_dir || "…")}</b></div>
        <div class="prop-row"><span>Renders</span><b class="path">${esc(state.paths?.renders_dir || "…")}</b></div>
        <div class="actions"><button class="ghost mini" id="prReveal">Open renders folder</button></div>`,
      wire: () => {
        $("prName").addEventListener("change", (e) => {
          const name = e.target.value.trim();
          if (!name) return;
          state.project.name = name;
          Store.touchProject(state.project);
          renderProjectSelect();
          renderProps();
        });
        $("prReveal").addEventListener("click", () => post("/api/reveal", { renders: true }));
      },
    },
    {
      id: "canvas", label: "Canvas",
      html: () => `
        <label class="field"><span${tipAttr("canvas")}>Format</span>
          <select id="prPreset">${CANVAS_PRESETS.map((p) =>
            `<option value="${p.id}" ${p.id === currentPreset() ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <div class="num-grid">
          <label><span>Width</span><input id="prW" type="number" min="64" step="2" value="${w}" /></label>
          <label><span>Height</span><input id="prH" type="number" min="64" step="2" value="${h}" /></label>
        </div>
        <div class="stamp-row">
          <span class="stamp-label"${tipAttr("fps")}>Frame rate</span>
          <select id="prFps">${[24, 25, 30, 50, 60].map((f) =>
            `<option value="${f}" ${f === fps ? "selected" : ""}>${f} fps</option>`).join("")}</select>
          ${resetBtn("prFps", () => applyCanvas(w, h, 30), "Back to 30 fps")}
        </div>
        <div class="hint-box">Clips are fitted inside the frame, so switching format re-frames the
          whole project without touching a clip. Use Zoom on a clip to fill the frame.</div>`,
      wire: () => {
        $("prPreset").addEventListener("change", (e) => {
          const preset = CANVAS_PRESETS.find((p) => p.id === e.target.value);
          if (!preset || preset.id === "custom") return;
          applyCanvas(preset.w, preset.h, fps);
        });
        const dims = () => applyCanvas(Number($("prW").value) || w, Number($("prH").value) || h, fps);
        $("prW").addEventListener("change", dims);
        $("prH").addEventListener("change", dims);
        $("prFps").addEventListener("change", (e) => applyCanvas(w, h, Number(e.target.value)));
      },
      reset: () => applyCanvas(1080, 1920, 30),
    },
  ]);
}

/** Where a clip's media actually sits on disk. */
function assetLocation(asset) {
  const p = state.paths;
  if (!p || !asset) return null;
  const sep = p.sep || "\\";
  const fix = (s) => String(s).split("/").join(sep);
  if (asset.media_url) return p.media_dir + sep + fix(asset.media_url);
  if (asset.src) return p.assets_dir + sep + fix(asset.src);
  return null;
}

/** Shared transition group for any clip kind. */
function transitionGroup(clip, write) {
  const setTrans = (edge, patch, label) => {
    const key = edge === "in" ? "transition_in" : "transition_out";
    write((c) => {
      c[key] = { type: "dissolve", dur: 0.5, ...(c[key] || {}), ...patch };
      if (c[key].type === "none") delete c[key];
    }, label);
    renderProps();
  };
  return {
    id: "transitions", label: "Transitions",
    html: () => `
      <div class="stamp-row with-rs">
        <span class="stamp-label"${tipAttr("trans_in")}>In</span>
        <select id="clTransIn">${TRANSITIONS.map((m) =>
          `<option value="${m}" ${m === (clip.transition_in?.type || "none") ? "selected" : ""}>${m}</option>`).join("")}</select>
        ${resetBtn("clTransIn", () => setTrans("in", { type: "none" }, "Transition in removed"))}
      </div>
      ${sliderRow("clTransInDur", "In length", 0.1, 3, 0.1, clip.transition_in?.dur ?? 0.5,
        (clip.transition_in?.dur ?? 0.5).toFixed(1) + "s",
        { tip: "trans_dur", reset: () => setTrans("in", { dur: 0.5 }, "In 0.5s") })}
      <div class="stamp-row with-rs">
        <span class="stamp-label"${tipAttr("trans_out")}>Out</span>
        <select id="clTransOut">${TRANSITIONS.map((m) =>
          `<option value="${m}" ${m === (clip.transition_out?.type || "none") ? "selected" : ""}>${m}</option>`).join("")}</select>
        ${resetBtn("clTransOut", () => setTrans("out", { type: "none" }, "Transition out removed"))}
      </div>
      ${sliderRow("clTransOutDur", "Out length", 0.1, 3, 0.1, clip.transition_out?.dur ?? 0.5,
        (clip.transition_out?.dur ?? 0.5).toFixed(1) + "s",
        { tip: "trans_dur", reset: () => setTrans("out", { dur: 0.5 }, "Out 0.5s") })}
      <div class="hint-box">Over black a dissolve reads as a fade-in; overlap two clips and it
        becomes a cross-dissolve.</div>`,
    wire: () => {
      $("clTransIn").addEventListener("change", (e) => setTrans("in", { type: e.target.value }, `Transition in: ${e.target.value}`));
      $("clTransOut").addEventListener("change", (e) => setTrans("out", { type: e.target.value }, `Transition out: ${e.target.value}`));
      liveSlider("clTransInDur", (v) => v.toFixed(1) + "s", null, (v) => setTrans("in", { dur: v }, `In ${v.toFixed(1)}s`));
      liveSlider("clTransOutDur", (v) => v.toFixed(1) + "s", null, (v) => setTrans("out", { dur: v }, `Out ${v.toFixed(1)}s`));
    },
    reset: () => {
      write((c) => { delete c.transition_in; delete c.transition_out; }, "Transitions cleared");
      renderProps();
    },
  };
}

/** Title clips get their own panel: the words matter more than the pixels. */
function renderTextProps(clip, track) {
  const p = { ...TEXT_DEFAULTS(), ...(clip.params || {}) };
  const d = TEXT_DEFAULTS();

  const write = (fn, label) => {
    snapshot();
    fn(clip);
    commit();
    state.status = label;
    const st = $("clipStatus");
    if (st) st.textContent = label;
  };
  const setP = (key, v, label) => write((c) => { c.params[key] = v; }, label);

  inspector("text", [
    {
      id: "info", label: "Info",
      html: () => `
        <div class="prop-row"><span>Track</span><b>${esc(track.name)}</b></div>
        <div class="prop-row"><span>Kind</span><b>title</b></div>
        <div class="num-grid">
          <label><span${tipAttr("start")}>Start</span>
            <input id="txStart" type="number" step="0.01" min="0" value="${clip.start.toFixed(2)}" /></label>
          <label><span${tipAttr("length")}>Length</span>
            <input id="txLen" type="number" step="0.01" min="0.1" value="${clipLen(clip).toFixed(2)}" /></label>
        </div>
        <div class="hint-box">Titles are drawn by the app, so there is no file behind them —
          they live inside the project.</div>`,
      wire: () => {
        $("txStart").addEventListener("change", (e) => {
          write((c) => { c.start = Math.max(0, Number(e.target.value) || 0); }, "Start updated");
          renderProps();
        });
        $("txLen").addEventListener("change", (e) => {
          write((c) => { c.out = c.in + Math.max(0.1, Number(e.target.value) || 1); }, "Length updated");
          renderProps();
        });
      },
    },
    {
      id: "text", label: "Text",
      html: () => `
        <label class="field"><span>Words <em>(Enter makes a new line)</em></span>
          <textarea id="txContent" rows="4">${esc(clip.text || "")}</textarea></label>
        <div class="stamp-row with-rs">
          <span class="stamp-label"${tipAttr("text_align")}>Align</span>
          <select id="txAlign">${["left", "center", "right"].map((a) =>
            `<option value="${a}" ${a === p.align ? "selected" : ""}>${a}</option>`).join("")}</select>
          ${resetBtn("txAlign", () => { setP("align", d.align, "Align centre"); renderProps(); })}
        </div>`,
      wire: () => {
        $("txContent").addEventListener("change", (e) => {
          write((c) => { c.text = e.target.value; c.name = e.target.value.slice(0, 24); }, "Text updated");
          renderTimeline();
        });
        $("txAlign").addEventListener("change", (e) => setP("align", e.target.value, `Align ${e.target.value}`));
      },
    },
    {
      id: "look", label: "Look",
      html: () => `
        ${sliderRow("txSize", "Size", 20, 200, 2, p.size, p.size + " px",
          { tip: "text_size", reset: () => { setP("size", d.size, `Size ${d.size} px`); renderProps(); } })}
        ${sliderRow("txY", "Position", 0, 1, 0.01, p.y, Math.round(p.y * 100) + "%",
          { tip: "text_y", reset: () => { setP("y", d.y, "Position 50%"); renderProps(); } })}
        <div class="stamp-row with-rs">
          <span class="stamp-label">Colour</span>
          <input type="color" id="txColor" value="${p.color}" />
          <b class="stamp-val">${esc(p.color)}</b>
          ${resetBtn("txColor", () => { setP("color", d.color, "Colour reset"); renderProps(); })}
        </div>
        <label class="check"><input type="checkbox" id="txBox" ${p.box ? "checked" : ""} /> Plate behind the text</label>
        ${sliderRow("txBoxOpacity", "Plate", 0, 1, 0.05, p.box_opacity, Math.round(p.box_opacity * 100) + "%",
          { tip: "text_box", reset: () => { setP("box_opacity", d.box_opacity, "Plate reset"); renderProps(); } })}`,
      wire: () => {
        liveSlider("txSize", (v) => v + " px", null, (v) => setP("size", v, `Size ${v} px`));
        liveSlider("txY", (v) => Math.round(v * 100) + "%", null, (v) => setP("y", v, `Position ${Math.round(v * 100)}%`));
        liveSlider("txBoxOpacity", (v) => Math.round(v * 100) + "%", null,
          (v) => setP("box_opacity", v, `Plate ${Math.round(v * 100)}%`));
        $("txColor").addEventListener("change", (e) => { setP("color", e.target.value, "Colour updated"); renderProps(); });
        $("txBox").addEventListener("change", (e) => setP("box", e.target.checked, e.target.checked ? "Plate on" : "Plate off"));
      },
      reset: () => {
        write((c) => { c.params = { ...c.params, ...TEXT_DEFAULTS() }; }, "Look reset to defaults");
        renderProps();
      },
    },
    transitionGroup(clip, write),
  ]);
}

/** Per-clip settings — same parameters as the track, but for this clip only.
 *  With several clips selected every change lands on all of them. */
function renderClipProps(entries) {
  const multi = entries.length > 1;
  const { clip, track } = entries[0];
  if (!multi && clip.kind === "text") { renderTextProps(clip, track); return; }
  const p = clip.params || {};
  const asset = clipAsset(clip) || {};
  const mate = partnersOf(clip)[0];
  const s = trackStamp(track);
  const hasVideo = entries.some((e) => e.clip.kind === "video");
  const still = isStill(clip);
  const db = gainToDb(p.volume ?? 1);

  // a dot marks values this clip sets away from the normal ones
  const mark = (val, def) => (Math.abs((val ?? def) - def) > 1e-6 ? ' <i class="ovr" title="not the default value">•</i>' : "");
  const markStr = (val, def) => ((val ?? def) !== def ? ' <i class="ovr" title="not the default value">•</i>' : "");

  // keyframes are per clip, so the stopwatch only shows for a single selection
  const tRel = clamp(state.playhead - clip.start, 0, clipLen(clip));
  const kf = (key) => (multi ? null : { on: hasKeys(clip, key), count: clip.keyframes?.[key]?.length || 0 });
  const live = (key) => (hasKeys(clip, key) ? paramAt(clip, key, tRel) : (p[key] ?? ANIMATABLE[key]));

  /* ---- writing values ---- */

  const applyAll = (fn, label) => {
    snapshot();
    entries.forEach(({ clip: c }) => {
      fn(c);
      partnersOf(c).forEach(({ clip: m }) => fn(m));   // keep a linked pair identical
    });
    state.project.tracks.forEach((t) => t.clips.sort((a, b) => a.start - b.start));
    commit();
    state.status = `${label}${multi ? ` → ${entries.length} clips` : ""}`;
    const st = $("clipStatus");
    if (st) st.textContent = state.status;
  };

  const param = (key, value, label) => applyAll((c) => { c.params[key] = value; }, label);

  /** Animated parameters write a keyframe at the playhead; the rest stay static. */
  const anim = (key, value, label) => {
    if (multi || !hasKeys(clip, key)) { param(key, value, label); return; }
    snapshot();
    setKeyframe(clip, key, tRel, value);
    partnersOf(clip).forEach(({ clip: m }) => setKeyframe(m, key, tRel, value));
    commit();
    state.status = `${label} @ ${state.playhead.toFixed(2)}s`;
    const st = $("clipStatus");
    if (st) st.textContent = state.status;
  };

  /** Stopwatch: switch a parameter between static and animated. */
  const watch = (id, key, label) => $(`${id}-kf`)?.addEventListener("click", () => {
    snapshot();
    const targets = [clip, ...partnersOf(clip).map((x) => x.clip)];
    if (hasKeys(clip, key)) {
      targets.forEach((c) => clearKeyframes(c, key, tRel));
      state.status = `${label} is static again, value taken at ${state.playhead.toFixed(2)}s`;
    } else {
      const v = live(key);
      targets.forEach((c) => setKeyframe(c, key, tRel, v));
      state.status = `${label} animated — move the playhead and change it to add keyframes`;
    }
    commit();
    renderProps();
  });

  /* reset means the normal value, not whatever the track happens to remember */
  const defaults = neutralParams();
  const toDefault = (keys, label) => {
    applyAll((c) => {
      keys.forEach((k) => {
        c.params[k] = defaults[k];
        if (c.keyframes) delete c.keyframes[k];
      });
    }, label);
    renderProps();
  };

  const location = assetLocation(asset);
  const groups = [
    {
      id: "info", label: "Info",
      html: () => `
        ${multi ? `<div class="hint-box">${entries.length} clips selected — changes land on all of them.</div>` : `
          <label class="field"><span${tipAttr("name")}>Name</span>
            <input id="clName" type="text" value="${esc(clip.name || "")}" /></label>
          <div class="prop-row"><span>Track</span><b>${esc(track.name)}</b></div>
          <div class="prop-row"><span>Source</span><b>${esc(asset.origin || "—")} · ${esc(asset.kind || "")}
            ${asset.duration ? "· " + asset.duration.toFixed(1) + "s" : ""}</b></div>
          <div class="prop-row"><span>Frame</span><b>${asset.width ? asset.width + "×" + asset.height : "—"}</b></div>
          <div class="prop-row"><span${tipAttr("link")}>Linked</span><b>${mate ? "🔗 " + esc(mate.track.name) : "—"}</b></div>
          <div class="prop-row"><span${tipAttr("file")}>File</span><b class="path" title="${esc(location || "")}">${esc(location || "—")}</b></div>
          ${asset.src_path ? `<div class="prop-row"><span>Imported from</span><b class="path" title="${esc(asset.src_path)}">${esc(asset.src_path)}</b></div>` : ""}
          <div class="num-grid">
            <label><span${tipAttr("start")}>Start</span>
              <input id="clStart" type="number" step="0.01" min="0" value="${clip.start.toFixed(2)}" /></label>
            <label><span${tipAttr("length")}>Length</span>
              <input id="clLen" type="number" step="0.01" min="0.1" value="${clipLen(clip).toFixed(2)}" /></label>
            <label><span${tipAttr("inout")}>In</span>
              <input id="clIn" type="number" step="0.01" min="0" value="${clip.in.toFixed(2)}" ${still ? "disabled" : ""} /></label>
            <label><span${tipAttr("inout")}>Out</span>
              <input id="clOut" type="number" step="0.01" min="0.1" value="${clip.out.toFixed(2)}" ${still ? "disabled" : ""} /></label>
          </div>
          <div class="actions">
            <button class="ghost mini" id="clShow">Show file</button>
            ${mate ? `<button class="ghost mini" id="clUnlink">Unlink</button>`
                   : (clip.kind === "video" && asset.has_audio
                      ? `<button class="ghost mini" id="clExtract">Extract audio</button>` : "")}
          </div>`}`,
      wire: () => {
        if (multi) return;
        $("clName").addEventListener("change", (e) => {
          const v = e.target.value.trim();
          if (!v) return;
          snapshot();
          clip.name = v;
          commit();
          renderProps();
        });
        const num = (id, fn) => $(id).addEventListener("change", (e) => {
          const v = Number(e.target.value);
          if (Number.isNaN(v)) return;
          applyAll(fn(v), "Updated");
          renderProps();
        });
        num("clStart", (v) => (c) => { c.start = Math.max(0, v); });
        num("clLen", (v) => (c) => { c.out = c.in + Math.max(0.1, v) * (c.params.speed || 1); });
        num("clIn", (v) => (c) => { c.in = clamp(v, 0, c.out - 0.1); });
        num("clOut", (v) => (c) => {
          const maxOut = isStill(c) ? Infinity : ((clipAsset(c) || {}).duration || Infinity);
          c.out = clamp(v, c.in + 0.1, maxOut);
        });
        $("clShow")?.addEventListener("click", () => {
          if (asset.from_post && asset.media_url) post("/api/reveal", { shortcode: asset.from_post });
          else post("/api/reveal", { asset: asset.id });
        });
        $("clUnlink")?.addEventListener("click", () => {
          snapshot();
          const link = clip.link_id;
          allClips().forEach(({ clip: c }) => { if (c.link_id === link) delete c.link_id; });
          commit();
          renderProps();
        });
        $("clExtract")?.addEventListener("click", () => {
          snapshot();
          const m = makeLinkedAudio(clip, track, asset);
          commit();
          if (m) state.selectedClips.add(m.id);
          renderTimeline();
          renderProps();
        });
      },
    },
    {
      id: "audio", label: "Audio",
      html: () => `
        ${sliderRow("clVol", "Volume" + mark(db, s.volume_db), -60, 12, 1, gainToDb(live("volume")),
          gainToDb(live("volume")) + " dB", { tip: "volume", kf: kf("volume"), reset: () => toDefault(["volume"], "Volume back to 0 dB") })}
        ${sliderRow("clFadeIn", "Fade in" + mark(p.fade_in, s.fade_in), 0, 5, 0.1, p.fade_in ?? 0,
          (p.fade_in ?? 0).toFixed(1) + "s", { tip: "fade_in", reset: () => toDefault(["fade_in"], "Fade in cleared") })}
        ${sliderRow("clFadeOut", "Fade out" + mark(p.fade_out, s.fade_out), 0, 5, 0.1, p.fade_out ?? 0,
          (p.fade_out ?? 0).toFixed(1) + "s", { tip: "fade_out", reset: () => toDefault(["fade_out"], "Fade out cleared") })}`,
      wire: () => {
        liveSlider("clVol", (v) => v + " dB", null, (v) => anim("volume", dbToGain(v), `Volume ${v} dB`));
        liveSlider("clFadeIn", (v) => v.toFixed(1) + "s", null, (v) => param("fade_in", v, `Fade in ${v.toFixed(1)}s`));
        liveSlider("clFadeOut", (v) => v.toFixed(1) + "s", null, (v) => param("fade_out", v, `Fade out ${v.toFixed(1)}s`));
        watch("clVol", "volume", "Volume");
      },
      reset: () => toDefault(["volume", "fade_in", "fade_out"], "Audio reset to defaults"),
    },
    {
      id: "timing", label: "Timing",
      html: () => `
        ${sliderRow("clSpeed", "Speed" + mark(p.speed, s.speed), 0.25, 4, 0.05, p.speed ?? 1,
          (p.speed ?? 1).toFixed(2) + "×", { tip: "speed", reset: () => toDefault(["speed"], "Speed back to 1.00x") })}
        <div class="stamp-note">${still ? "A still: length is free, the source has no duration."
          : `Source ${(asset.duration || 0).toFixed(1)}s · using ${clipLen(clip).toFixed(2)}s`}</div>`,
      wire: () => {
        liveSlider("clSpeed", (v) => v.toFixed(2) + "×", null,
          (v) => { param("speed", v, `Speed ${v.toFixed(2)}×`); renderProps(); });
      },
      reset: () => toDefault(["speed"], "Timing reset to defaults"),
    },
  ];

  if (hasVideo) {
    groups.push(
      {
        id: "look", label: "Look",
        html: () => `
          ${sliderRow("clBri", "Brightness" + mark(p.brightness, s.brightness), -0.5, 0.5, 0.02,
            live("brightness"), live("brightness").toFixed(2),
            { tip: "brightness", kf: kf("brightness"), reset: () => toDefault(["brightness"], "Brightness back to 0") })}
          ${sliderRow("clCon", "Contrast" + mark(p.contrast, s.contrast), 0.5, 1.5, 0.05,
            live("contrast"), live("contrast").toFixed(2),
            { tip: "contrast", kf: kf("contrast"), reset: () => toDefault(["contrast"], "Contrast back to 1") })}
          ${sliderRow("clSat", "Saturation" + mark(p.saturation, s.saturation), 0, 2, 0.05,
            live("saturation"), live("saturation").toFixed(2),
            { tip: "saturation", kf: kf("saturation"), reset: () => toDefault(["saturation"], "Saturation back to 1") })}
          ${sliderRow("clOpa", "Opacity" + mark(p.opacity, s.opacity), 0, 1, 0.05,
            live("opacity"), Math.round(live("opacity") * 100) + "%",
            { tip: "opacity", kf: kf("opacity"), reset: () => toDefault(["opacity"], "Opacity back to 100%") })}
          <div class="stamp-row with-rs">
            <span class="stamp-label"${tipAttr("blend")}>Blend${markStr(p.blend, s.blend)}</span>
            <select id="clBlend">${BLEND_MODES.map((m) =>
              `<option value="${m}" ${m === (p.blend || "normal") ? "selected" : ""}>${m}</option>`).join("")}</select>
            ${resetBtn("clBlend", () => toDefault(["blend"], "Blend back to normal"))}
          </div>`,
        wire: () => {
          liveSlider("clBri", (v) => v.toFixed(2), null, (v) => anim("brightness", v, `Brightness ${v.toFixed(2)}`));
          liveSlider("clCon", (v) => v.toFixed(2), null, (v) => anim("contrast", v, `Contrast ${v.toFixed(2)}`));
          liveSlider("clSat", (v) => v.toFixed(2), null, (v) => anim("saturation", v, `Saturation ${v.toFixed(2)}`));
          liveSlider("clOpa", (v) => Math.round(v * 100) + "%", null, (v) => anim("opacity", v, `Opacity ${Math.round(v * 100)}%`));
          ["clBri:brightness:Brightness", "clCon:contrast:Contrast", "clSat:saturation:Saturation",
           "clOpa:opacity:Opacity"].forEach((spec) => {
            const [id, key, label] = spec.split(":");
            watch(id, key, label);
          });
          $("clBlend").addEventListener("change", (e) => param("blend", e.target.value, `Blend ${e.target.value}`));
        },
        reset: () => toDefault(["brightness", "contrast", "saturation", "opacity", "blend"], "Look reset to defaults"),
      },
      {
        id: "frame", label: "Animations",
        html: () => `
          ${presetGrid()}
          ${sliderRow("clScale", "Zoom", 0.2, 4, 0.05, live("scale"), live("scale").toFixed(2) + "×",
            { tip: "zoom", kf: kf("scale"), reset: () => { param("scale", 1, "Zoom 1.00×"); renderProps(); } })}
          ${sliderRow("clX", "Shift X", -1, 1, 0.01, live("x"), Math.round(live("x") * 100) + "%",
            { tip: "shift", kf: kf("x"), reset: () => { param("x", 0, "Shift X 0%"); renderProps(); } })}
          ${sliderRow("clY", "Shift Y", -1, 1, 0.01, live("y"), Math.round(live("y") * 100) + "%",
            { tip: "shift", kf: kf("y"), reset: () => { param("y", 0, "Shift Y 0%"); renderProps(); } })}
          ${multi ? "" : `<div class="stamp-note kf-note">${keysOf(clip).length
            ? `animated: ${keysOf(clip).map((k) => `${k} (${clip.keyframes[k].length})`).join(", ")}
               <button class="ghost mini" id="clKfClear">clear all keyframes</button>`
            : "no keyframes yet — press ⏱ next to a parameter"}</div>`}`,
        wire: () => {
          wirePresets((preset) => {
            applyAll((c) => applyPresetTo(c, preset), `${presetName(preset)} applied`);
            renderProps();
          });
          liveSlider("clScale", (v) => v.toFixed(2) + "×", null, (v) => anim("scale", v, `Zoom ${v.toFixed(2)}×`));
          liveSlider("clX", (v) => Math.round(v * 100) + "%", null, (v) => anim("x", v, `Shift X ${Math.round(v * 100)}%`));
          liveSlider("clY", (v) => Math.round(v * 100) + "%", null, (v) => anim("y", v, `Shift Y ${Math.round(v * 100)}%`));
          ["clScale:scale:Zoom", "clX:x:Shift X", "clY:y:Shift Y"].forEach((spec) => {
            const [id, key, label] = spec.split(":");
            watch(id, key, label);
          });
          $("clKfClear")?.addEventListener("click", () => {
            snapshot();
            [clip, ...partnersOf(clip).map((x) => x.clip)].forEach((c) => {
              keysOf(c).forEach((k) => clearKeyframes(c, k, tRel));
            });
            state.status = "All keyframes cleared";
            commit();
            renderProps();
          });
        },
        reset: () => {
          applyAll((c) => {
            c.params.scale = 1; c.params.x = 0; c.params.y = 0;
            ["scale", "x", "y"].forEach((k) => { if (c.keyframes) delete c.keyframes[k]; });
          }, "Framing reset");
          renderProps();
        },
      },
      transitionGroup(clip, (fn, label) => applyAll(fn, label)),
    );
  }

  // video only for now; stills and audio get their own actions later
  if (hasVideo) groups.splice(1, 0, quickActions(clip, multi, applyAll));

  inspector("clip", groups);
}

/* ---------- track inspector (stamp model) ---------- */

// dB is what mixers speak; the clips keep a linear gain
const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
const gainToDb = (g) => (!g ? -60 : clamp(Math.round(20 * Math.log10(g)), -60, 12));

const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity"];

const TRACK_DEFAULTS = () => ({
  volume_db: 0, fade_in: 0, fade_out: 0, speed: 1, still_len: IMAGE_LEN,
  brightness: 0, contrast: 1, saturation: 1, opacity: 1, blend: "normal",
});

const trackStamp = (t) => ({ ...TRACK_DEFAULTS(), ...(t.stamp || {}) });

/** Plain-language help for every parameter, shown on hover. */
const TIPS = {
  height: "How tall this track is drawn. Video grows upwards from the sash, audio downwards.",
  pair: "Tracks mirror around the sash: the 1st video track pairs with the 1st audio track, and so on. A video's sound lands on its pair.",
  mute: "Silences this audio track completely.",
  solo: "Plays only the soloed tracks — everything else goes quiet until you switch it off.",
  visible: "Hides this video track from the picture without deleting anything.",
  lock: "Protects the track: its clips can't be moved, trimmed or deleted by accident.",
  volume: "Loudness in decibels. 0 dB is the original level, −6 dB is about half as loud, −60 dB is silence.",
  fade_in: "Seconds of silence-to-full at the clip's start, so the sound doesn't slam in.",
  fade_out: "Seconds of full-to-silence at the clip's end.",
  speed: "Playback rate. 2× runs twice as fast and makes the clip half as long; 0.5× is slow motion.",
  still_len: "Default length of a photo on the timeline — stills have no duration of their own.",
  brightness: "Lifts or drops the whole picture. 0 leaves it alone.",
  contrast: "Distance between darks and lights. 1 leaves it alone, above 1 is punchier.",
  saturation: "Colour intensity. 0 is black and white, 1 is untouched, 2 is heavily saturated.",
  opacity: "How solid the clip is over the tracks below it. 100% hides them, 50% blends half-and-half.",
  blend: "How this clip mixes with what's underneath. 'screen' drops black (light leaks, smoke), 'multiply' drops white (shadows, textures), 'overlay' adds contrast for grading.",
  name: "Your label for this clip — it only shows on the timeline.",
  start: "Where the clip begins on the timeline, in seconds.",
  inout: "Which part of the source file is used: the in-point and out-point, in source seconds.",
  length: "How long the clip lasts on the timeline (source length divided by speed).",
  link: "A video and the sound extracted from it. Linked clips move, trim, split and delete together.",
  zoom: "Scale of the picture inside the frame. 1× fills the canvas; animate it with ⏱ for a slow push-in.",
  trans_in: "How the clip appears: dissolve fades it up, wipes reveal it from a side. Over black it reads as a fade-in; over another clip it becomes a cross-dissolve.",
  trans_out: "How the clip leaves at its end — the same set of effects in reverse.",
  trans_dur: "How long the transition lasts, in seconds.",
  text_size: "Font size in canvas pixels — the same number the render uses, so what you see is what you get.",
  text_y: "Vertical position of the text: 0% is the top of the frame, 100% the bottom.",
  text_align: "Where the text sits horizontally and which edge it grows from.",
  text_box: "Opacity of the plate drawn behind the text so it stays readable over busy footage.",
  canvas: "Shape of the finished video. Clips are fitted inside it, so switching format re-frames the whole project without changing a single clip.",
  fps: "Frames per second of the render. 30 is the safe default for Reels and Shorts.",
  shift: "Moves the picture inside the frame, in percent of the canvas. Animate it with ⏱ to pan across a photo.",
  scan_threshold: "How different two frames must be to count as a cut. Lower finds more, including camera moves and flashes; higher keeps only hard cuts.",
  scan_min: "Cuts closer together than this are ignored, so a busy moment doesn't shatter into slivers.",
  speech_lang: "Leave empty and the engine works the language out itself. Naming it (ru, en, …) helps on noisy or short clips.",
  sub_wrap: "How many characters fit on one line before the phrase wraps. Narrow lines read faster on a phone.",
  sil_noise: "Everything under this level counts as quiet. −30 dB suits a spoken clip; go lower on a noisy one, or it will hear the room as speech.",
  sil_before: "How much of the quiet in front of a phrase stays, so it doesn't start on top of you.",
  sil_after: "How much of the quiet after a phrase stays, so the sentence has room to land.",
  sil_min: "Gaps shorter than this are left alone — cutting every breath makes speech sound chopped.",
  sub_outline: "A hard edge around the letters. The one thing that keeps white text readable over a bright, busy shot.",
  sub_move: "When you drag one subtitle in the preview: leave it on and the rest land in the same place; turn it off and they shift by the same amount, keeping any offsets you made by hand.",
  sub_font: "The family the subtitles are set in. Grouped by what each font can actually write — read from the font files themselves, not guessed from their names. “+” takes your own files.",
  sub_offset: "Where the lines sit against the speech. Zero puts each one on its first word, which is where they are generated; drag left to show them earlier, right to show them later. The length of each line does not change.",
  sub_group: "Which part of the look you are setting. The rest is one click away — the settings are all here, just not all at once. “asslib” holds everything about behaviour: how the lines are cut, where they sit, how they arrive and how the spoken word is marked.",
  sub_words: "How many words stand on one line. Three or four is the short-form look — the card changes often and the eye never has to read ahead. “Whole phrase” gives back the sentences the transcription heard. Re-cut from the words already on the track, not from the audio again.",
  sub_weight: "Bold and italic are separate font files, not a thickened outline: the render can only set what the family actually ships, so a cut that is missing is greyed out rather than faked.",
  sub_shadow: "How far the shadow sits from the letters. ffmpeg copies the text and offsets it — there is no blur to soften it, so small numbers read best.",
  sub_enter: "How a line comes on screen. Only movement and fading survive the trip to the render: drawtext can animate where the text is and how solid it is, never how big it is.",
  sub_enter_len: "How long the arrival takes. Every line also fades out over the last 0.15s so it does not vanish mid-word.",
  sub_hl: "Marks the word being spoken as it is spoken, from the timings the transcription gave each word. Lines typed by hand carry no timings and stay plain.",
  sub_hl_mode: "Colour repaints the word, Plate puts a block of colour behind it, Grow makes it a little bigger. The word never moves — the line keeps its place either way.",
  scan_auto: "If the chosen sensitivity finds nothing, it is lowered until at least one cut appears — and the panel says by how much.",
  preset_speed: "How fast a preset runs: Slow stretches the move and softens it, Fast shortens it and pushes it further.",
  preset_curve: "The shape of the movement in time. “Preset's own” lets each preset keep the curve it was designed with; Overshoot and Bounce land past the target and settle back.",
  ai_fragment: "Everything about the piece being sent: how long it is, what it costs and what must survive the change. Set once, then out of the way — the summary on the right of this bar is the short version.",
  ai_far: "How much licence the model is given. These two go into the prompt as instructions, not as numbers.",
  ai_strength: "Subtle keeps as much of the original as it can, Full commits to the change. Balanced is the one to start with.",
  ai_shot: "Whether the framing stays as shot or moves in or out. The model reframes by generating, not by cropping, so anything but “as in the original” means a new picture.",
  ai_media: "What travels with the prompt, in the order it is sent. The tokens are what the text points at — @Image 1 is the face, @Video 1 is the fragment.",
  ai_notes: "Anything the switches cannot say. Write it in whatever language you think in — it is translated into the prompt, not pasted into it.",
  ai_prompt: "What is actually sent. “From the settings” rebuilds it plainly, “Polish” has a language model write it. Either way it is yours to edit, and the reference tokens are checked before anything leaves.",
  ai_model: "Which model does the work. Kling Motion Control is built for this errand — it takes the movement from the fragment and the person from a still, and the still is edited with your chosen face before it goes. Seedance is the general one, and in testing it carried a face across once in five tries.",
  ai_orientation: "Which way the person faces in the result: as they do in the fragment, or as they do in the edited still. Following the fragment allows a longer clip.",
  ai_background: "Where the scene behind the person comes from: the fragment's own surroundings, or the ones in the edited still. Keeping the fragment's background is what makes the result cut back into the timeline.",
  ai_duration: "How many seconds to ask the model for. It works in whole seconds from 4 to 15, so a shorter fragment is asked for at the minimum and trimmed back, and a longer one is generated in parts.",
  ai_quality: "480p costs half of what 720p costs and is what every test should run at. The price beside the title follows this and the length.",
  ai_audio: "The generated picture arrives without sound, so the fragment keeps the audio it already has. Generating a new soundtrack is a decision for later.",
  reset: "Drops this clip's own values and takes the track's settings again.",
  file: "Where this clip's media sits on disk. “Show file” opens that folder.",
};

const tipAttr = (key) => (TIPS[key] ? ` data-tip="${esc(TIPS[key])}"` : "");

/* Reset buttons collected while a panel is being built, bound after render. */
let pendingResets = [];

function resetBtn(id, fn, title = "Back to the default") {
  if (typeof fn !== "function") return "";
  pendingResets.push({ id: `${id}-rs`, fn });
  return `<button class="rs-btn" id="${id}-rs" title="${esc(title)}">↺</button>`;
}

/** One slider row: drags live (label only), commits on release.
 *  opts: { tip, kf, reset } — stopwatch turns the parameter into an animated one,
 *  reset puts it back to its default. */
function sliderRow(id, label, min, max, step, value, fmt, opts = {}) {
  const { tip, kf, reset } = typeof opts === "string" ? { tip: opts } : opts;
  const watch = kf
    ? `<button class="kf-btn ${kf.on ? "on" : ""}" id="${id}-kf"
         title="${kf.on ? `Animated · ${kf.count} keyframe(s) · click to bake the current value`
                        : "Animate this parameter over time"}">⏱</button>`
    : "";
  return `<div class="stamp-row ${kf ? "with-kf" : ""} ${reset ? "with-rs" : ""}">
      <span class="stamp-label"${tipAttr(tip)}>${label}</span>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" />
      <b class="stamp-val" id="${id}-val">${fmt}</b>
      ${watch}
      ${resetBtn(id, reset)}
    </div>`;
}

/* ---------- quick actions ---------- */

/* What each button will do once it is switched on. Everything here works on the
 * selected fragment only, leaves the original alone and comes back as a variant.
 * `soon` marks what is designed but not wired yet. */
const QUICK_ACTIONS = [
  { id: "split_scenes", row: "Cut", label: "Split by scenes", run: openSplit,
    tip: "Find where the picture changes and cut the clip into separate fragments on the timeline. Runs on this machine, costs nothing." },
  { id: "transcribe", row: "Cut", label: "Transcribe", run: openTranscribe,
    tip: "Turn the speech in this fragment into subtitles on a text track. Through Groq by default, or locally once that engine is installed." },

  { id: "remove_silence", row: "Cut", label: "Remove silence", run: openSilence,
    tip: "Cut out the quiet between phrases and close the gaps. The speech itself sets the boundaries, so the cuts land around what is said, not around whatever happens to be loud." },

  { id: "extract_audio", row: "Audio", label: "Extract audio", run: extractAudio,
    tip: "Lift this fragment's sound into the library as an entry of its own — it stays there even if the post it came from is deleted." },

  { id: "faceswap", row: "People", label: "Face swap", ai: true,
    run: (clip) => openAiTool("faceswap", clip),
    tip: "Put another face on the person in this fragment, from a reference photo." },
  { id: "replace_character", row: "People", label: "Replace character", ai: true,
    run: (clip) => openAiTool("replace_character", clip),
    tip: "Edit the first frame — a different person, different clothes — then bring the fragment back to life from it." },

  { id: "restyle", row: "Look", label: "Restyle", soon: true, ai: true,
    tip: "Repaint the whole fragment in another style, keeping the movement." },
  { id: "scene_style", row: "Look", label: "Change scene", soon: true, ai: true,
    tip: "Swap the surroundings or the mood of the scene through the first frame." },
  { id: "remove_bg", row: "Look", label: "Remove background", soon: true, ai: true,
    tip: "Cut the subject out and hand back a fragment with transparency, ready to sit over another track." },

  { id: "upscale", row: "Repair", label: "Upscale", soon: true, ai: true,
    tip: "Raise the resolution of a small or heavily compressed source." },
  { id: "slowmo", row: "Repair", label: "Slow motion", soon: true, ai: true,
    tip: "Invent the frames in between instead of stretching the ones you have." },
  { id: "stabilize", row: "Repair", label: "Stabilize", soon: true,
    tip: "Take the shake out of handheld footage. Runs on this machine." },
];

const QA_ROWS = ["Cut", "Audio", "People", "Look", "Repair"];
const QA_ROW_TIPS = {
  Cut: "Working with the fragment itself.",
  Audio: "The sound of this fragment.",
  People: "Who is in the frame.",
  Look: "How the frame looks.",
  Repair: "Fixing what the source lacks.",
};

/* ---------- scene detection ---------- */

/* The split runs in three states: `settings` while nothing has been looked at,
 * `scanning` while ffmpeg reads the clip, `review` once there are candidates to
 * judge. Only in `review` do the marks appear and the button say Approve. */
const SCAN_FLOOR = 0.02;

/** Candidate cuts that survive a sensitivity and the minimum length, as
 *  clip-relative timeline seconds. Filtering happens here, on the list we
 *  already have — the file is read once and never again while sliders move. */
function scanOf(scan, clip) {
  return scan?.byClip?.[clip?.id] || null;
}

function keptCuts(scan, clip, threshold = null) {
  const own = scanOf(scan, clip);
  if (!own) return [];
  const level = threshold ?? scan.threshold;
  const speed = clip.params?.speed || 1;
  const len = clipLen(clip);
  const out = [];
  let last = 0;
  own.cuts
    .filter((c) => c.score >= level)
    .forEach((c) => {
      const at = c.t / speed;                       // clip-relative timeline seconds
      if (at - last < scan.minLen) return;          // too close to the previous cut
      if (len - at < scan.minLen) return;           // would leave a sliver at the end
      last = at;
      out.push({ at, score: c.score });
    });
  return out;
}

/** The highest sensitivity that still yields a cut — used when the chosen one
 *  finds nothing and the user asked for a cut regardless. */
function bestThreshold(scan, clip) {
  for (let level = scan.threshold; level >= SCAN_FLOOR - 1e-9; level -= 0.02) {
    if (keptCuts(scan, clip, level).length) return +level.toFixed(2);
  }
  return null;
}

/* ---------- removing the quiet between phrases ---------- */

/** Stretches worth cutting, in the clip's own seconds.
 *
 *  By subtitles: everything outside the lines, with a pad around each.
 *  By loudness: what ffmpeg heard as quiet, trimmed by the same pads so the
 *  speech never loses its edges.
 */
function silenceGaps(sil, clip) {
  const own = sil?.byClip?.[clip?.id];
  if (!own) return [];
  const len = clipLen(clip);
  const speed = clip.params?.speed || 1;

  if (sil.mode === "loud") {
    // the threshold judges the pause itself; the pads then give back its edges,
    // so a 0.6s pause with 0.6s of padding simply leaves nothing to cut
    return (own.gaps || [])
      .filter((g) => (g.to - g.from) / speed >= sil.minGap)
      .map((g) => ({ from: Math.min(len, g.from / speed + sil.padAfter),
                     to: Math.max(0, g.to / speed - sil.padBefore) }))
      .filter((g) => g.to - g.from >= 0.05);
  }

  const keep = (own.phrases || [])
    .map((p) => ({ from: Math.max(0, p.start / speed - sil.padBefore),
                   to: Math.min(len, p.end / speed + sil.padAfter) }))
    .sort((a, b) => a.from - b.from);
  // phrases that now touch become one
  const merged = [];
  keep.forEach((r) => {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  });

  const gaps = [];
  let at = 0;
  merged.forEach((r) => {
    if (r.from - at >= sil.minGap) gaps.push({ from: at, to: r.from });
    at = Math.max(at, r.to);
  });
  if (len - at >= sil.minGap) gaps.push({ from: at, to: len });
  return gaps.filter((g) => g.to - g.from >= sil.minGap);
}

async function openSilence(clip) {
  const asset = clipAsset(clip);
  if (!asset || !asset.has_audio) {
    state.status = "This clip has no sound, so there is no silence to find";
    renderProps();
    return;
  }
  await ensureSpeechStatus();
  const targets = actionTargets(clip).filter((c) => (clipAsset(c) || {}).has_audio);
  if (!targets.length) {
    state.status = "Nothing selected has sound";
    renderProps();
    return;
  }
  closeSubPanels();
  state.silence = {
    clipId: clip.id, targets: targets.map((c) => c.id), byClip: {},
    stage: "settings", mode: "speech", note: "",
    padBefore: 0.25, padAfter: 0.35, minGap: 0.5, noiseDb: -30,
  };
  targets.forEach((c) => loadSpeechRanges(c));
  renderTimeline();
  renderProps();
}

/** Phrase boundaries we already have: the fragment's own subtitles first — they
 *  may have been edited by hand — then whatever the transcript remembers. */
function loadSpeechRanges(clip) {
  const sil = state.silence;
  const speed = clip.params?.speed || 1;
  const subs = subtitlesOf(clip).map(({ clip: c }) => ({
    start: (c.start - clip.start) * speed,
    end: (c.start - clip.start + clipLen(c)) * speed,
  })).sort((a, b) => a.start - b.start);
  // the words were timed against the fragment they were taken from; shift them
  // into this clip's own seconds before they mean anything here
  const said = clipAsset(clip)?.transcript;
  const shift = (said?.from ?? 0) - clip.in;
  const stored = (said?.segments || [])
    .map((x) => ({ start: x.start + shift, end: x.end + shift }))
    .filter((x) => x.end > 0 && x.start < clipLen(clip) * (clip.params?.speed || 1));
  const reuse = subs.length ? subs : stored;
  const own = sil.byClip[clip.id] || (sil.byClip[clip.id] = { phrases: [], gaps: [] });
  if (!reuse.length) return false;
  own.phrases = reuse;
  own.source = subs.length ? "subtitles" : "transcript";
  sil.stage = "review";
  sil.note = subs.length
    ? "Using the subtitles already on these fragments — nothing was sent anywhere."
    : "Using phrases these fragments already know — nothing was sent anywhere.";
  return true;
}

function closeSilence() {
  state.silence = null;
  renderTimeline();
  renderProps();
}

/** Quiet by level: ffmpeg listens, no speech model and no key involved. */
async function findQuiet() {
  const sil = state.silence;
  const targets = sil.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  sil.stage = "listening";
  renderProps();
  try {
    for (let i = 0; i < targets.length; i++) {
      const clip = targets[i];
      const many = targets.length > 1 ? ` (${i + 1} of ${targets.length})` : "";
      sil.note = `Listening for quiet${many}…`;
      renderProps();
      const { job_id } = await post("/api/silence", {
        asset_id: clipAssetId(clip), start: clip.in, end: clip.out,
        noise_db: sil.noiseDb, min_len: 0.15,   // collect them all; the slider filters
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const job = await api(`/api/jobs/${job_id}`);
        const item = job.items[0];
        sil.note = item.stage + many;
        const bar = $("silStage");
        if (bar) bar.textContent = sil.note;
        if (!job.done) continue;
        if (item.status === "error") throw new Error(item.stage);
        const own = sil.byClip[clip.id] || (sil.byClip[clip.id] = { phrases: [], gaps: [] });
        own.gaps = item.record.gaps || [];
        break;
      }
    }
    sil.stage = "review";
    sil.note = targets.some((c) => (sil.byClip[c.id]?.gaps || []).length)
      ? "" : "Nothing under that level — try a higher threshold.";
  } catch (e) {
    sil.stage = "settings";
    sil.note = "Failed: " + e.message;
  }
  renderTimeline();
  renderProps();
}

async function findSilence() {
  const sil = state.silence;
  const targets = sil.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  const engine = speechEngine();
  sil.stage = "listening";
  renderProps();
  try {
    for (let i = 0; i < targets.length; i++) {
      const clip = targets[i];
      const many = targets.length > 1 ? ` (${i + 1} of ${targets.length})` : "";
      sil.note = (engine === "groq" ? "Sending the audio to Groq" : "Listening on this machine") + many + "…";
      renderProps();
      const { job_id } = await post("/api/transcribe", {
        asset_id: clipAssetId(clip), start: clip.in, end: clip.out,
        engine, key: engine === "groq" ? Store.keys.groq : "",
        model: Store.settings.speech_model || "small",
        device: Store.settings.speech_device || "auto",
        language: Store.settings.speech_language || "",
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const job = await api(`/api/jobs/${job_id}`);
        const item = job.items[0];
        sil.note = item.stage + many;
        const bar = $("silStage");
        if (bar) bar.textContent = sil.note;
        if (!job.done) continue;
        if (item.status === "error") throw new Error(item.stage);
        const own = sil.byClip[clip.id] || (sil.byClip[clip.id] = { phrases: [], gaps: [] });
        own.phrases = (item.record.segments || []).map((x) => ({ start: x.start, end: x.end }));
        own.source = "speech";
        // keep the words for next time — this is the same transcript, paid once
        const asset = clipAsset(clip);
        if (asset && !asset.transcript) {
          // `from` is what makes these times mean anything to another clip
          Store.upsertAsset({ ...asset, transcript: { at: Date.now(), from: clip.in, segments: own.phrases } });
        }
        break;
      }
    }
    sil.stage = "review";
    sil.note = "";
  } catch (e) {
    sil.stage = "settings";
    sil.note = "Failed: " + e.message;
  }
  renderTimeline();
  renderProps();
}

/** Cut the quiet out and close up the hole it leaves. */
function applySilence() {
  const sil = state.silence;
  const targets = sil.targets.map((id) => findClip(id)?.clip).filter(Boolean)
    .sort((a, b) => b.start - a.start);       // from the end back: earlier times stay valid
  if (!targets.some((c) => silenceGaps(sil, c).length)) return;

  snapshot();
  let cutCount = 0, savedAll = 0, droppedAll = 0;

  targets.forEach((clip) => {
    const gaps = silenceGaps(sil, clip);
    const track = findClip(clip.id)?.track;
    if (!gaps.length || !track) return;
    cutCount += gaps.length;

    // cut at every boundary the gaps introduce
    const bounds = [...new Set(gaps.flatMap((g) => [g.from, g.to]))]
      .filter((t) => t > 0.02 && t < clipLen(clip) - 0.02)
      .sort((a, b) => a - b);
    const only = new Set([clip.id]);
    let current = clip;
    bounds.forEach((at) => {
      const t = clip.start + at;
      const made = cutAt(t, cuttableAt(t, only));
      const next = made.find((m) => m.clip.kind === current.kind && Math.abs(m.clip.start - t) < 1e-6);
      if (next) { only.delete(current.id); only.add(next.clip.id); current = next.clip; }
    });

    // whatever now sits inside a gap goes, and everything after it slides left
    const doomed = new Set();
    gaps.forEach((g) => {
      const from = clip.start + g.from, to = clip.start + g.to;
      track.clips.forEach((c) => {
        if (c.start >= from - 1e-3 && c.start + clipLen(c) <= to + 1e-3) {
          doomed.add(c.id);
          partnersOf(c).forEach(({ clip: p }) => doomed.add(p.id));
        }
      });
    });

    // where the footage stands before anything moves: the holes are measured in
    // these coordinates, and the subtitles are anchored to these pieces
    const spans = track.clips.map((c) => ({
      id: c.id, from: c.start, to: c.start + clipLen(c), doomed: doomed.has(c.id),
    })).sort((a, b) => a.from - b.from);
    const holes = spans.filter((s) => s.doomed).map((s) => ({ at: s.from, len: s.to - s.from }));
    const saved = holes.reduce((s, h) => s + h.len, 0);

    // Every survivor travels by the total length cut out to its left, measured
    // against those untouched positions. Sliding piece by piece instead left the
    // later pieces referring to times that no longer existed, so the second hole
    // never closed and a gap stayed in the middle of the timeline (measured).
    const moved = new Map();
    state.project.tracks.forEach((t) => {
      if (!t.clips.some((c) => doomed.has(c.id))) return;
      t.clips = t.clips.filter((c) => !doomed.has(c.id));
      t.clips.forEach((c) => {
        const delta = -holeShift(holes, c.start);
        if (t === track) moved.set(c.id, delta);
        c.start = Math.max(0, c.start + delta);
      });
    });

    droppedAll += anchorTextTracks(holes, spans, moved);
    savedAll += saved;
  });

  state.silence = null;
  state.qaBack = true;
  commit();
  state.status = `Removed ${cutCount} quiet stretch(es) — ${savedAll.toFixed(1)}s shorter`
    + (droppedAll ? ` · ${droppedAll} subtitle(s) went with them` : "");
  renderProps();
}

/** How far left something standing at `t` travels once the holes close up. */
const holeShift = (holes, t) =>
  holes.reduce((s, h) => s + (h.at + h.len <= t + 1e-3 ? h.len : 0), 0);

/** The longest part of [from,to] the cut did not take, or null if none is left. */
function longestSurvivor(from, to, holes) {
  let parts = [{ from, to }];
  holes.forEach(({ at, len }) => {
    const hTo = at + len;
    parts = parts.flatMap((p) => {
      if (hTo <= p.from + 1e-3 || at >= p.to - 1e-3) return [p];
      const out = [];
      if (at - p.from > 1e-3) out.push({ from: p.from, to: at });
      if (p.to - hTo > 1e-3) out.push({ from: hTo, to: p.to });
      return out;
    });
  });
  const best = parts.sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  return best && best.to - best.from >= 0.15 ? best : null;
}

/** Keep the words with the picture they belong to.
 *
 *  A subtitle belongs to a piece of footage, not to a moment on the ruler: it
 *  travels exactly as far as that piece travelled and stays where it is when the
 *  piece stays. Whatever of it was spoken inside the cut is gone, a line with
 *  nothing left to caption goes with it, and a line over empty space falls back
 *  to the plain ripple. Anchors move too, so the offset slider still works.
 */
function anchorTextTracks(holes, spans, moved) {
  if (!holes.length) return 0;
  let dropped = 0;
  const live = spans.filter((s) => !s.doomed);
  tracksOf("text").forEach((track) => {
    const kept = [];
    track.clips.forEach((c) => {
      const speed = c.params?.speed || 1;
      const end = c.start + clipLen(c);
      const seg = longestSurvivor(c.start, end, holes);
      if (!seg) { dropped++; return; }                    // its words were cut out
      if (seg.from > c.start + 1e-3 || seg.to < end - 1e-3) {
        c.in += (seg.from - c.start) * speed;
        c.out = c.in + (seg.to - seg.from) * speed;
        c.start = seg.from;
        if (c.cue_base != null) c.cue_base = Math.max(c.cue_base, seg.from);
      }
      // the piece of footage it sits over decides how far it goes
      let host = null, best = 0;
      live.forEach((s) => {
        const over = Math.min(seg.to, s.to) - Math.max(seg.from, s.from);
        if (over > best) { best = over; host = s; }
      });
      const delta = host ? (moved.get(host.id) ?? 0) : -holeShift(holes, c.start);
      c.start = Math.max(0, c.start + delta);
      if (c.cue_base != null) c.cue_base = Math.max(0, c.cue_base + delta);
      kept.push(c);
    });
    track.clips = kept.sort((a, b) => a.start - b.start);
  });
  return dropped;
}

/* ---------- speech into subtitles ---------- */

/* ---------- fonts ----------
 * The registry is read once from the server (which itself only reads the font
 * files when the folders change) and kept in memory for the session. Fonts that
 * are not installed system-wide — ours and the user's — are declared to the page
 * with @font-face so the picker can show every name in its own typeface.
 */
const CAPTION_FAVOURITES = ["Montserrat", "Inter", "Oswald", "Bebas Neue", "Poppins",
  "Roboto", "Open Sans", "Arial", "Anton", "Archivo Black", "Noto Sans", "Lato"];

async function loadFonts(rescan = false) {
  try {
    state.fonts = await api(`/api/fonts${rescan ? "?rescan=1" : ""}`);
  } catch {
    state.fonts = { families: [] };
  }
  declareFonts();
  return state.fonts;
}

/** Make non-system fonts usable by name in the page. */
function declareFonts() {
  const list = (state.fonts?.families || []).filter((f) => f.origin !== "system");
  if (!list.length) return;
  let style = $("fontFaces");
  if (!style) {
    style = document.createElement("style");
    style.id = "fontFaces";
    document.head.appendChild(style);
  }
  // one face per weight the family actually ships: the canvas must not fake a
  // bold the render cannot draw
  const FACES = { bold: [700, "normal"], italic: [400, "italic"], bold_italic: [700, "italic"] };
  style.textContent = list.map((f) => {
    const url = (s) => `/api/fonts/file/${encodeURIComponent(f.family)}${s ? `?style=${s}` : ""}`;
    const faces = [`@font-face{font-family:"${f.family}";src:url("${url("")}");font-display:block;}`];
    Object.entries(f.faces || {}).forEach(([slot, _file]) => {
      const [weight, slant] = FACES[slot] || [];
      if (weight) faces.push(`@font-face{font-family:"${f.family}";src:url("${url(slot)}");`
        + `font-weight:${weight};font-style:${slant};font-display:block;}`);
    });
    return faces.join("");
  }).join("");
}

/** Grouped by what the font can actually set, favourites first. */
function fontOptions(current) {
  const all = state.fonts?.families || [];
  const seen = new Set();
  const option = (f) => {
    seen.add(f.family);
    return `<option value="${esc(f.family)}" ${f.family === current ? "selected" : ""}
      style="font-family:'${esc(f.family)}'">${esc(f.family)}</option>`;
  };
  const group = (label, items) => (items.length
    ? `<optgroup label="${label}">${items.map(option).join("")}</optgroup>` : "");

  const favourites = CAPTION_FAVOURITES
    .map((name) => all.find((f) => f.family.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  const rest = all.filter((f) => !favourites.includes(f));
  return group("Popular for captions", favourites)
    + group("Cyrillic + Latin", rest.filter((f) => f.cyrillic && f.latin))
    + group("Latin only", rest.filter((f) => f.latin && !f.cyrillic))
    + group("Cyrillic only", rest.filter((f) => f.cyrillic && !f.latin));
}

/** Let the user bring their own font files in. */
async function addFontFiles() {
  try {
    const { paths } = await api("/api/fonts/pick");
    if (!paths?.length) return null;
    const result = await post("/api/fonts/add", { paths });
    state.fonts = result;
    declareFonts();
    state.status = result.added.length
      ? `Added ${result.added.join(", ")}`
      : "Nothing added — those files are not readable fonts";
    return result.added[0] || null;
  } catch (e) {
    state.status = "Could not add fonts: " + e.message;
    return null;
  }
}

/* What Whisper answers to, by ISO 639-1 code. Naming the language beats letting
 * it guess on short or noisy clips — a Russian reel can come back as Ukrainian. */
const SPEECH_LANGUAGES = [
  ["", "Detect automatically"],
  ["ru", "Russian · ru"], ["en", "English · en"], ["uk", "Ukrainian · uk"],
  ["be", "Belarusian · be"], ["kk", "Kazakh · kk"], ["de", "German · de"],
  ["fr", "French · fr"], ["es", "Spanish · es"], ["it", "Italian · it"],
  ["pt", "Portuguese · pt"], ["pl", "Polish · pl"], ["nl", "Dutch · nl"],
  ["tr", "Turkish · tr"], ["ar", "Arabic · ar"], ["he", "Hebrew · he"],
  ["fa", "Persian · fa"], ["hi", "Hindi · hi"], ["id", "Indonesian · id"],
  ["vi", "Vietnamese · vi"], ["th", "Thai · th"], ["zh", "Chinese · zh"],
  ["ja", "Japanese · ja"], ["ko", "Korean · ko"], ["cs", "Czech · cs"],
  ["sk", "Slovak · sk"], ["sr", "Serbian · sr"], ["hr", "Croatian · hr"],
  ["bg", "Bulgarian · bg"], ["ro", "Romanian · ro"], ["hu", "Hungarian · hu"],
  ["el", "Greek · el"], ["sv", "Swedish · sv"], ["no", "Norwegian · no"],
  ["da", "Danish · da"], ["fi", "Finnish · fi"], ["lt", "Lithuanian · lt"],
  ["lv", "Latvian · lv"], ["et", "Estonian · et"], ["hy", "Armenian · hy"],
  ["ka", "Georgian · ka"], ["az", "Azerbaijani · az"], ["uz", "Uzbek · uz"],
];

/* A subtitle is not a title card: smaller, low in the frame, and narrow enough
 * that the line actually fits — at 84px a 34-character line ran off both edges
 * of a 1080px canvas. */
const SUB_SIZE = 52;

/** How many characters of this size fit across the canvas, with a margin.
 *  A rough guide for the slider label only — the real limit is measured. */
function charsThatFit(size) {
  const w = state.project?.canvas?.w || 1080;
  return Math.max(12, Math.floor((w * 0.88) / (size * 0.52)));
}

/* Measuring beats counting: capital letters are wider than lower-case ones, and
 * a font swap changes everything. Counting characters put ALL CAPS lines off the
 * edge of the frame; this asks the same engine that draws them how wide they are. */
const _ruler = document.createElement("canvas").getContext("2d");

/** The one font string every part of the app measures and draws captions with.
 *
 *  Weight 400 on purpose. ffmpeg draws the font file exactly as it is, and the
 *  files we ship are Regular; asking the canvas for 600 made Chromium fake a
 *  bold and measure a line 3% wider than the render draws it (measured on
 *  Montserrat: 792px against 767px), which threw off the wrapping and would
 *  throw off every word position. */
const captionFont = (size, family, p = null) =>
  `${p?.italic ? "italic " : ""}${p?.bold ? 700 : 400} ${size}px `
  + `${family ? `"${family}", ` : ""}"Segoe UI", system-ui, sans-serif`;

function textWidth(text, style) {
  _ruler.font = captionFont(style.size, style.font, style);
  return _ruler.measureText(text).width;
}

/** Whether this family really ships the cut being asked for. */
const fontFace = (family, slot) =>
  !!(state.fonts?.families || []).find((f) => f.family === family)?.faces?.[slot];

/** Break a phrase into lines the frame can hold, by width and by character count. */
function wrapPhrase(text, maxChars, style = null) {
  const words = String(text).trim().split(/\s+/);
  const canvasW = state.project?.canvas?.w || 1080;
  // the outline grows the glyphs on both sides, so it eats into the margin
  const limitPx = style ? canvasW * 0.9 - (style.outline || 0) * 2 : Infinity;
  const fits = (line) => {
    const shown = style?.case === "upper" ? line.toUpperCase() : line;
    return line.length <= maxChars && (!style || textWidth(shown, style) <= limitPx);
  };

  const lines = [];
  let line = "";
  words.forEach((w) => {
    if (!line) line = w;
    else if (fits(line + " " + w)) line += " " + w;
    else { lines.push(line); line = w; }
  });
  if (line) lines.push(line);
  return lines.join("\n");
}

/* ---------- word by word ----------
 *
 * Highlighting needs to know where every word sits inside its line, and the
 * preview and the render have to agree on that to the pixel. They cannot both
 * work it out for themselves: ffmpeg lays a line out about 2.5% narrower than
 * the canvas does (measured — the same sentence spans 733px there and 751px
 * here), so a highlight placed from canvas numbers over an ffmpeg-centred line
 * drifts by up to 12px. So the canvas measures once, and the render is told the
 * answer: absolute x per word, and the baseline the whole line sits on.
 */

/** When each word of a line is spoken, on the timeline.
 *
 *  Times are kept relative to the first word, which is what `cue_base` marks:
 *  the line then survives being moved by the offset slider or by a cut without
 *  its words losing the picture. */
/** When this line's first word is spoken, on the timeline.
 *
 *  Lines made before the anchor was written down at generation carry no
 *  `cue_base`; rather than skip them, it is worked out the same way the offset
 *  slider works it out — from the fragment they came off, or failing that from
 *  where the line sits now, which is always current. */
function cueBase(clip) {
  if (clip.cue_base != null) return clip.cue_base;
  const words = clip.words || [];
  const speed = clip.cue_speed || 1;
  if (words.length && clip.cue_origin != null) return clip.cue_origin + words[0].start / speed;
  return clip.start - (clip.offset ?? 0);
}

function wordTimes(clip) {
  const words = clip.words || [];
  if (!words.length) return null;
  const base = cueBase(clip);
  const speed = clip.cue_speed || 1;
  const zero = words[0].start;
  return words.map((w) => ({
    text: String(w.text || "").trim(),
    t0: base + (w.start - zero) / speed,
    t1: base + ((w.end ?? w.start) - zero) / speed,
  }));
}

/** Every word of every line, in project pixels: where it starts and when.
 *
 *  Returns null when the words and the wrapped text disagree — an edited line,
 *  a phrase with no timings — and the caller then draws the plain way. */
function textLayout(clip, p) {
  const times = wordTimes(clip);
  if (!times) return null;
  const size = p.size ?? 84;
  const upper = p.case === "upper";
  _ruler.font = captionFont(size, p.font, p);
  const space = _ruler.measureText(" ").width;
  const canvasW = state.project?.canvas?.w || 1080;
  const canvasH = state.project?.canvas?.h || 1920;
  // where the baseline of a line drawn with textBaseline="middle" lands: the
  // ink bottom of a letter that has no descender is the baseline itself
  _ruler.textBaseline = "middle";
  const drop = _ruler.measureText("H").actualBoundingBoxDescent;
  _ruler.textBaseline = "alphabetic";

  const lines = String(clip.text || "").split("\n");
  const lineH = size * 1.25;
  const yMid = canvasH * (p.y ?? 0.5);
  const top = yMid - ((lines.length - 1) * lineH) / 2;
  const anchor = (p.align === "left" ? canvasW * 0.08 : p.align === "right" ? canvasW * 0.92
    : canvasW / 2) + (p.x || 0) * canvasW;

  let k = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const tokens = lines[i].split(/\s+/).filter(Boolean);
    const words = [];
    let off = 0;
    tokens.forEach((tok) => {
      const shown = upper ? tok.toUpperCase() : tok;
      const w = _ruler.measureText(shown).width;
      const t = times[k++];
      words.push({ text: shown, off: +off.toFixed(2), width: +w.toFixed(2),
                   t0: t ? +t.t0.toFixed(3) : null, t1: t ? +t.t1.toFixed(3) : null });
      off += w + space;
    });
    const width = Math.max(0, off - space);
    const left = p.align === "left" ? anchor : p.align === "right" ? anchor - width : anchor - width / 2;
    out.push({ width: +width.toFixed(2), left: +left.toFixed(2),
               baseline: +(top + i * lineH + drop).toFixed(2), words });
  }
  // more words than the line has room for, or fewer: do not guess
  return k === times.length ? out : null;
}

const hlActive = (word, t) => word.t0 != null && t >= word.t0 && t < word.t1;
const HL_GROW = 1.12;                    // how much "Grow" enlarges the spoken word

/* ---------- how a line arrives ----------
 *
 * drawtext animates what it can put an expression on: x, y and alpha. Scale and
 * rotation are not among them — fontsize is fixed for the life of the filter —
 * so the presets here are the ones that survive the trip to the render intact.
 * Each one names how far the line travels, in ems, and along which axis.
 */
const ENTRANCES = {
  none:  null,
  fade:  { dx: 0, dy: 0 },
  up:    { dx: 0, dy: 1.2 },
  down:  { dx: 0, dy: -1.2 },
  left:  { dx: -1.6, dy: 0 },
  right: { dx: 1.6, dy: 0 },
  drop:  { dx: 0, dy: -2.2, ease: "bounce" },
  swing: { dx: -2.2, dy: 0, ease: "back" },
};
const ENTRANCE_LIST = [["none", "None"], ["fade", "Fade"], ["up", "Slide up"],
  ["down", "Slide down"], ["left", "Slide from left"], ["right", "Slide from right"],
  ["drop", "Drop in"], ["swing", "Swing in"]];
const ENTER_OUT = 0.15;                  // every arrival gets a short fade at the end

/** Where a line stands and how solid it is, this many seconds into its life. */
function entranceAt(clip, p, t) {
  const spec = ENTRANCES[p.enter || "none"];
  if (!spec) return null;
  const len = Math.max(0.05, p.enter_len ?? 0.3);
  const size = p.size ?? 84;
  const start = clip.start, end = clip.start + clipLen(clip);
  const u = clamp((t - start) / len, 0, 1);
  const e = easeAt(u, spec.ease || "out");
  const outU = clamp((end - t) / ENTER_OUT, 0, 1);
  return { dx: spec.dx * size * (1 - e), dy: spec.dy * size * (1 - e), alpha: Math.min(u, outU) };
}

/** Which engine actually runs. Local only wins once it is really installed —
 *  a setting left over from before the install would otherwise fail every job. */
function speechEngine() {
  const picked = Store.settings.speech_engine || "groq";
  if (picked !== "local") return "groq";
  return state.speechStatus?.installed ? "local" : "groq";
}

async function ensureSpeechStatus() {
  if (state.speechStatus) return state.speechStatus;
  try { state.speechStatus = await api("/api/speech/status"); }
  catch { state.speechStatus = { installed: false, error: true }; }
  return state.speechStatus;
}

/** Subtitles already made from this fragment, wherever they ended up. */
function subtitlesOf(clip) {
  const out = [];
  tracksOf("text").forEach((track) => track.clips.forEach((c) => {
    if (c.from_clip === clip.id) out.push({ clip: c, track });
  }));
  return out;
}

async function openTranscribe(clip) {
  const asset = clipAsset(clip);
  if (!asset || !asset.has_audio) {
    state.status = "This clip has no sound to transcribe";
    renderProps();
    return;
  }
  await ensureSpeechStatus();
  const targets = actionTargets(clip).filter((c) => (clipAsset(c) || {}).has_audio);
  const made = subtitlesOf(clip);
  closeSubPanels();
  if (made.length && targets.length === 1) {
    state.transcribe = { clipId: clip.id, stage: "existing", segments: [], note: "",
      language: Store.settings.speech_language || "", maxChars: Store.settings.sub_wrap ?? 34,
      minGap: 0.12, lead: 0, font: Store.settings.sub_font || "Montserrat" };
    renderProps();
    return;
  }
  if (!state.fonts) await loadFonts();
  state.transcribe = {
    clipId: clip.id, targets: targets.map((c) => c.id), byClip: {},
    stage: "settings", segments: [], note: "",  // panels were cleared above
    language: Store.settings.speech_language || "",
    maxChars: 34, minGap: 0.12,
    lead: 0,          // generation lands on the spoken word; shifting is done later
    font: Store.settings.sub_font || "Montserrat",
  };
  renderProps();
}

function closeTranscribe() {
  state.transcribe = null;
  renderProps();
}

async function runTranscribe() {
  const tr = state.transcribe;
  const targets = tr.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  const engine = speechEngine();
  tr.stage = "working";
  tr.byClip = {};
  renderProps();
  try {
    for (let i = 0; i < targets.length; i++) {
      const clip = targets[i];
      const many = targets.length > 1 ? ` (${i + 1} of ${targets.length})` : "";
      tr.note = (engine === "groq" ? "Sending the audio to Groq" : "Listening on this machine") + many + "…";
      renderProps();
      const { job_id } = await post("/api/transcribe", {
        asset_id: clipAssetId(clip), start: clip.in, end: clip.out,
        engine,
        key: engine === "groq" ? Store.keys.groq : "",
        model: Store.settings.speech_model || "small",
        device: Store.settings.speech_device || "auto",
        language: tr.language,
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const job = await api(`/api/jobs/${job_id}`);
        const item = job.items[0];
        tr.note = item.stage + many;
        const bar = $("trStage");
        if (bar) bar.textContent = tr.note;
        if (!job.done) continue;
        if (item.status === "error") throw new Error(item.stage);
        tr.byClip[clip.id] = (item.record.segments || [])
          .map((x, n) => ({ ...x, id: `${clip.id}:${n}`, keep: true }));
        tr.engineUsed = item.record.engine;
        break;
      }
      // keep the words with the asset: the next action can reuse them for free
      const asset = clipAsset(clip);
      if (asset) {
        Store.upsertAsset({ ...asset, transcript: { at: Date.now(), from: clip.in,
          segments: tr.byClip[clip.id].map(({ start, end, text }) => ({ start, end, text })) } });
      }
    }
    tr.stage = "review";
    tr.note = "";
  } catch (e) {
    tr.stage = "settings";
    tr.note = "Failed: " + e.message;
  }
  renderProps();
}

/** Whisper's sentences cut into cards of N words — the short-form look.
 *
 *  The words already carry their own timings, so a card is honest about when it
 *  starts and ends; a phrase with no word timings is left whole rather than
 *  chopped on a guess. */
function cardsOf(phrases, per) {
  const out = [];
  phrases.forEach((s, i) => {
    // which sentence a card came from, so it can be put back together later
    const seg = s.seg ?? `s${i}`;
    const words = (s.words || []).filter((w) => String(w.text || "").trim());
    if (words.length <= per) { out.push({ ...s, seg }); return; }
    for (let k = 0; k < words.length; k += per) {
      const chunk = words.slice(k, k + per);
      out.push({ ...s, seg, text: chunk.map((w) => w.text).join(" "),
                 start: chunk[0].start, end: chunk[chunk.length - 1].end, words: chunk });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

/** Cue times after the lead-in is applied: each line comes up early by `lead`,
 *  but never before the previous one has left. */
function cueTimes(tr, clipId = null) {
  const list = clipId ? (tr.byClip?.[clipId] || []) : Object.values(tr.byClip || {}).flat();
  let kept = list.filter((s) => s.keep && s.text.trim());
  const per = Store.settings.sub_words | 0;
  if (per > 0) kept = cardsOf(kept, per);
  let prevEnd = 0;
  return kept.map((s) => {
    const start = Math.max(prevEnd, Math.max(0, s.start - tr.lead));
    const end = Math.max(start + 0.3, s.end);
    prevEnd = end;
    return { ...s, cueStart: start, cueEnd: end };
  });
}

/** Lay the kept phrases onto a text track, one title each. */
function applySubtitles() {
  const tr = state.transcribe;
  const targets = tr.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  if (!targets.some((c) => cueTimes(tr, c.id).length)) return;
  let track = tracksOf("text")[0];
  snapshot();
  let placed = 0;
  // a second pass over the same fragment replaces its old lines
  if (tr.replaces?.length) {
    const gone = new Set(tr.replaces);
    tracksOf("text").forEach((t) => { t.clips = t.clips.filter((c) => !gone.has(c.id)); });
  }
  if (!track) { addTrack("text", true); track = tracksOf("text")[0]; }
  const wrapAt = tr.maxChars;
  const subParams = { ...TEXT_DEFAULTS(), size: SUB_SIZE, font: tr.font, case: "none", outline: 0 };

  targets.forEach((clip) => {
  const kept = cueTimes(tr, clip.id);
  const speed = clip.params?.speed || 1;
  const len = clipLen(clip);
  placed += kept.length;
  kept.forEach((s, i) => {
    const from = clamp(clip.start + s.cueStart / speed, clip.start, clip.start + len);
    const to = clamp(clip.start + s.cueEnd / speed, from + 0.3, clip.start + len);
    track.clips.push({
      id: "c" + Date.now().toString(36) + i.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      kind: "text",
      name: s.text.slice(0, 24),
      text: wrapPhrase(s.text, wrapAt, subParams),
      in: 0,
      out: to - from - (i < kept.length - 1 ? tr.minGap : 0),   // a breath between cards
      start: from,
      params: { ...TEXT_DEFAULTS(), size: SUB_SIZE, font: tr.font, speed: 1, opacity: 1, y: 0.82,
                ...(tr.style || {}) },
      keyframes: {},
      // where these words came from, and when each one is spoken — the panel
      // reopens on them instead of transcribing again, the lead-in can re-time
      // them later, and word highlighting will read the same list
      from_clip: clip.id,
      words: (s.words || []).map((w) => ({ ...w })),
      raw: s.text,                 // unwrapped, so the width can change any time
      cue_origin: clip.start,      // where the fragment sits on the timeline
      cue_speed: speed,
      offset: 0,                   // generated straight onto the spoken word
      // the moment the first word is heard, written down now rather than worked
      // out later: everything that re-times or re-cuts a line hangs off it, and
      // when it was left for the offset slider to fill in, a line that had never
      // been offset simply had no anchor and was skipped in silence
      cue_base: from,
      cue_seg: `${clip.id}#${s.seg ?? i}`,   // the sentence it was cut out of
    });
  });
  });
  track.clips.sort((a, b) => a.start - b.start);
  state.transcribe = null;
  state.qaBack = true;
  commit();
  state.status = targets.length > 1
    ? `${placed} subtitle(s) added across ${targets.length} fragments`
    : `${placed} subtitle(s) added`;
  renderProps();
}

/* ---------- AI tools ----------
 *
 * One popup serves every tool: what to ask for on the left, what is being worked
 * on in the middle, what to work from on the right. The numbers below are the
 * ones measured against the live model — see docs/kie-seedance.md — because the
 * length the tool may ask for and the price it quotes both follow from them.
 */
const SEEDANCE = {
  min: 4, max: 15,                 // output seconds the model accepts, whole numbers
  input_floor: 5,                  // a shorter input is still billed as five seconds
  rate: { "480p": 6, "720p": 12.5 },   // credits per second, with a video input
  credit: 0.005,                   // dollars
};

/* Where the work can be sent. The two behave nothing alike — one is a general
 * video model asked to change a face, the other is built to take movement from a
 * video and a person from a picture — so each brings its own settings, and the
 * panel shows only the ones that mean something for the model chosen. */
const AI_MODELS = {
  kling_mc: {
    label: "Kling 3.0 Motion Control",
    note: "Made for this: it takes the movement from the fragment and the person "
        + "from a still, which is edited with the chosen face first.",
    qualities: ["720p", "1080p"],
    rate: { "720p": 12, "1080p": 21 },      // credits per second of the fragment
    duration: null,                          // the fragment decides
    floor: 10,                               // a 4s run was billed as ten seconds
    clip: [3, 30],
    orientation: true,
    background: true,
    frame: true,
  },
  seedance: {
    label: "Seedance 2.0 Mini",
    note: "Cheaper and general-purpose. In testing it carried a face across once "
        + "in five tries, so it is here for everything that is not a face swap.",
    qualities: ["480p", "720p"],
    rate: { "480p": 6, "720p": 12.5 },
    duration: [4, 15],
    orientation: false,
    frame: false,
  },
};
const AI_ORIENTATION = [["video", "Follow the fragment"], ["image", "Follow the still"]];
const AI_BACKGROUND = [["input_video", "From the fragment"], ["input_image", "From the still"]];
const AI_LEAD = 2;                 // seconds of the untouched original around the fragment

const AI_TOOLS = {
  faceswap: {
    title: "Face swap",
    assets: { label: "Faces", one: "face", note: "Pick the face to put on the person in the fragment." },
    // the motion model has already been handed a still of this fragment with the
    // new face on it, so it is asked to hold that person, not to perform a swap
    line: (p) => (AI_MODELS[p.model]?.frame
      ? "The person in the reference image performs the movement in the video, "
        + "keeping that face, that hair and those clothes, in the same shot and "
        + "the same surroundings."
      : "Replace the face of the person in the video with the face from the "
        + "reference image, changing only the face — the clothing, the body and the hair "
        + "stay as they are."),
  },
  replace_character: {
    title: "Replace character",
    assets: { label: "Characters", one: "character", note: "Pick the character to put in the fragment." },
    line: () => "Replace the person in the video with the character in the reference "
      + "image, keeping the same shot and the same motion.",
  },
};

const AI_STRENGTH = [["subtle", "Subtle"], ["balanced", "Balanced"], ["full", "Full"]];
const AI_SHOT = [["same", "As in the original"], ["closer", "Closer"], ["wider", "Wider"]];

/** How the fragment has to be cut up for the model, and what that costs.
 *
 *  The model takes 4–15 whole seconds, so a longer fragment goes in pieces and
 *  each piece starts on the last frame of the one before it; a shorter one is
 *  asked for at the minimum and trimmed back afterwards. */
function aiPlan(len, quality, asked = null, model = "kling_mc") {
  const spec = AI_MODELS[model] || AI_MODELS.kling_mc;
  const longest = spec.duration ? spec.duration[1] : (spec.clip ? spec.clip[1] : 15);
  const parts = Math.max(1, Math.ceil(len / longest));
  const each = len / parts;
  const rate = spec.rate[quality] ?? Object.values(spec.rate)[0];
  if (!spec.duration) {
    // Charged by the second, but a 4s run was billed 120 credits — ten seconds'
    // worth at 12/s. Whether that is a minimum charge or a higher rate one
    // measurement cannot say, so the estimate takes the pessimistic reading.
    const credits = rate * Math.max(spec.floor || 0, len);
    return { parts, each, fit: each, ask: each, credits, dollars: credits * SEEDANCE.credit };
  }
  const fit = clamp(Math.ceil(each - 1e-6), spec.duration[0], spec.duration[1]);
  const ask = asked ?? fit;                  // what will actually be requested
  const credits = parts * rate * (Math.max(SEEDANCE.input_floor, each) + ask);
  return { parts, each, fit, ask, credits, dollars: credits * SEEDANCE.credit };
}

/* Lettering burnt into the source is part of the picture being regenerated, and
 * it comes out the other side as garbled nonsense unless it is asked for plainly.
 * Asked for in the wrong words, though, it is refused outright: naming watermarks
 * and logos had the model answer "the output video may be related to copyright
 * restrictions" (measured). So the ask is about lettering, not about ownership. */
const CLEAN_PLATE = "The finished shot has no lettering anywhere in the frame — "
  + "no captions and no subtitles — and wherever the source shows text, the scene "
  + "behind it is shown instead.";

function aiPrompt(tool, p, assetName) {
  const bits = [AI_TOOLS[tool].line(p, assetName)];
  bits.push({ subtle: "Change as little as possible.",
              balanced: "Blend the change naturally into the shot.",
              full: "Commit to the change fully." }[p.strength] || "");
  if (p.shot === "closer") bits.push("Frame the shot a little closer.");
  if (p.shot === "wider") bits.push("Frame the shot a little wider.");
  bits.push("Do not change the background or the camera motion.");
  bits.push(CLEAN_PLATE);
  if (p.notes?.trim()) bits.push(p.notes.trim());
  return bits.filter(Boolean).join(" ");
}

/** What actually travels with the prompt, in the order the model is told about it.
 *
 *  The numbering here is the numbering in the request: `reference_video_urls` and
 *  `reference_image_urls` are handed over in this order, and the tokens in the
 *  prompt point at these positions. Showing it in the panel means the numbers in
 *  the text are never a mystery. */
function aiRefs(ai) {
  const found = findClip(ai.clipId);
  const clip = found?.clip;
  const out = [];
  if (clip) {
    // the range is settled when the clip loads; before that the fragment is all of it
    const from = ai.range?.in ?? clip.in, to = ai.range?.out ?? clip.out;
    out.push({ token: "@Video1", kind: "video", thumb: null,
               name: clip.name || "this fragment",
               sub: `${from.toFixed(2)}s – ${to.toFixed(2)}s of the source` });
  }
  if (ai.picked) {
    // what the picture *is* depends on the model. Seedance is handed the face
    // itself; the motion model is handed a still from this very fragment with
    // the face already changed, so calling it "the face to put on" would send
    // the prompt chasing a swap that has already happened.
    const swapped = AI_MODELS[ai.params.model]?.frame;
    const chars = ai.tool === "replace_character";
    out.push({ token: "@Image1", kind: "face", thumb: ai.picked.thumb_url,
               name: ai.picked.name,
               sub: chars
                 ? "the character to put in the fragment"
                 : swapped
                   ? "a frame of this fragment with the new face already on it — the person to keep"
                   : "the face to put on the person" });
  }
  return out;
}

/** Everything the language model needs to know, in the words of the panel.
 *
 *  The face's name is deliberately absent: seedance has never heard of "June
 *  Rhodes", and a name in the text invites it to invent a person instead of
 *  copying the one in the picture. The name is a label for the human. */
function aiFacts(ai) {
  const p = ai.params;
  if (AI_MODELS[p.model]?.frame) {
    return {
      "Change only": "nothing about the person in the picture — the shot keeps that "
        + "face, that hair and those clothes, and follows the movement, framing and "
        + "background of the video",
      "How far to go": AI_STRENGTH.find(([v]) => v === p.strength)?.[1],
      "Framing": AI_SHOT.find(([v]) => v === p.shot)?.[1],
      "Sound": p.audio === "original" ? "keep the original audio" : "",
      "The user's own words": p.notes?.trim() || "",
    };
  }
  return {
    "Change only": ai.tool === "replace_character"
      ? "the person — the shot, the motion and the surroundings stay as they are"
      : "the face — clothing, body, hair and background stay as they are",
    "How far to go": AI_STRENGTH.find(([v]) => v === p.strength)?.[1],
    "Framing": AI_SHOT.find(([v]) => v === p.shot)?.[1],
    "Sound": p.audio === "original" ? "keep the original audio" : "",
    "The user's own words": p.notes?.trim() || "",
  };
}

function aiDefaults(clip) {
  return {
    strength: "balanced", shot: "same", notes: "",
    model: "kling_mc", quality: "720p", orientation: "video",
    background: "input_video", audio: "original",
    duration: null,          // null = follow the fragment
    prompt: "", touched: false,
  };
}

/** Open a tool on one fragment. Nothing is sent yet — this is the workbench. */
function openAiTool(id, clip) {
  const asset = clipAsset(clip);
  if (!asset || asset.kind === "image") {
    state.status = "This tool needs a video fragment";
    renderProps();
    return;
  }
  // one player at a time: the timeline keeps running behind the popup otherwise,
  // and two pictures play at once with the sound of the one you cannot see
  stopPlayback();
  state.ai = { tool: id, clipId: clip.id, view: "orig", params: aiDefaults(clip),
               result: null, picked: null, picks: {}, bench: null, benchOpen: false,
               faceAt: 0, crop: null, range: null, foldOpen: false };
  $("aiTool").classList.remove("hidden");
  $("aiTitle").textContent = AI_TOOLS[id].title;
  renderAiTool();
  loadAiClip();
  // both shelves are loaded, because the spine can be pressed at any moment and
  // the count on it has to be true before it is
  Promise.all([loadFaces(), loadCharacters()]).then(renderAiAssets);
}

function closeAiTool() {
  const v = $("aiVideo");
  try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* already gone */ }
  clearTimeout(state.ai?.frameTimer);
  hidePeek();
  state.ai = null;
  $("aiTool").classList.add("hidden");
}

/** The fragment plus a couple of seconds of the original on either side.
 *
 *  It plays the asset itself, never the timeline: subtitles, titles and anything
 *  else the editor draws are not part of what the model will be given, so they
 *  have no business being in the picture the choice is made from. */
function loadAiClip() {
  const ai = state.ai;
  const found = findClip(ai.clipId);
  if (!found) return closeAiTool();
  const clip = found.clip;
  const asset = clipAsset(clip);
  const v = $("aiVideo");
  ai.run = {
    from: Math.max(0, clip.in - AI_LEAD),
    to: Math.min(asset.duration || clip.out + AI_LEAD, clip.out + AI_LEAD),
    in: clip.in, out: clip.out,
  };
  // what actually gets sent starts as the fragment itself and can then be
  // narrowed by dragging the ends of the marked span
  if (!ai.range) ai.range = { in: clip.in, out: clip.out };
  v.src = assetUrl(asset, true) || assetUrl(asset, false);
  v.muted = false;
  v.currentTime = ai.run.from;
  v.onloadedmetadata = () => { v.currentTime = ai.run.from; refreshAiTrack(); };
  v.ontimeupdate = () => {
    const { from, to } = state.ai?.run || {};
    if (to != null && v.currentTime >= to - 0.02) {
      if ($("aiLoop").checked) { v.currentTime = from; }
      else { v.pause(); $("aiPlay").textContent = "▶"; }
    }
    refreshAiTrack();
  };
}

function refreshAiTrack() {
  const ai = state.ai;
  if (!ai?.run) return;
  const { from, to } = ai.run;
  const fin = ai.range.in, out = ai.range.out;
  const span = Math.max(0.01, to - from);
  const pct = (t) => `${clamp((t - from) / span, 0, 1) * 100}%`;
  const el = $("aiSpan");
  el.style.left = pct(fin);
  el.style.width = `${clamp((out - fin) / span, 0, 1) * 100}%`;
  const v = $("aiVideo");
  const at = v.currentTime || from;
  $("aiMark").style.left = pct(at);
  // counted from the fragment, so the run-up reads as a negative number instead
  // of sitting at zero and looking stuck
  const rel = at - fin;
  $("aiTime").textContent = `${rel < 0 ? "−" : ""}${Math.abs(rel).toFixed(1)}s`;
  $("aiSpanIn").style.left = pct(fin);
  $("aiSpanOut").style.left = pct(out);
}

function renderAiTool() {
  const ai = state.ai;
  if (!ai) return;
  const found = findClip(ai.clipId);
  if (!found) return closeAiTool();
  const clip = found.clip;
  const tool = AI_TOOLS[ai.tool];
  const p = ai.params;
  // what will be sent is the marked span, not necessarily the whole fragment
  const len = ai.range ? Math.max(0.1, ai.range.out - ai.range.in) : clipLen(clip);
  const spec = AI_MODELS[p.model] || AI_MODELS.kling_mc;
  const plan = aiPlan(len, p.quality, p.duration, p.model);
  const asked = plan.ask;
  pendingResets = [];

  const refs = aiRefs(ai);
  $("aiParams").innerHTML = `
    <button class="ai-fold${ai.foldOpen ? " open" : ""}" id="aiFold"${tipAttr("ai_fragment")}>
      <span>Fragment</span><b>${len.toFixed(2)}s · ${p.quality} · ${esc(spec.label.split(" ")[0])}</b><i>${ai.foldOpen ? "▾" : "▸"}</i>
    </button>
    ${ai.foldOpen ? `<div class="ai-folded">
      <div class="prop-row"><span>Selected</span><b>${len.toFixed(2)}s</b></div>
      <div class="prop-row"><span>Whole clip</span><b>${clipLen(clip).toFixed(2)}s</b></div>
      ${spec.duration ? `
      <div class="stamp-row with-rs">
        <span class="stamp-label"${tipAttr("ai_duration")}>Generate</span>
        <input id="aiDur" type="number" min="${spec.duration[0]}" max="${spec.duration[1]}" step="1" value="${asked}" />
        ${resetBtn("aiDur", () => { p.duration = null; renderAiTool(); })}
      </div>` : `
      <div class="prop-row"><span>Generate</span><b>${len.toFixed(2)}s — the fragment's own length</b></div>`}
      <div class="stamp-row with-rs">
        <span class="stamp-label"${tipAttr("ai_model")}>Model</span>
        <select id="aiModel">${Object.entries(AI_MODELS).map(([k, m]) =>
          `<option value="${k}" ${k === p.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
        ${resetBtn("aiModel", () => { p.model = "kling_mc"; p.quality = "720p"; renderAiTool(); })}
      </div>
      <div class="stamp-note">${esc(spec.note)}</div>
      <div class="stamp-row with-rs">
        <span class="stamp-label"${tipAttr("ai_quality")}>Quality</span>
        <select id="aiQuality">${spec.qualities.map((q) =>
          `<option value="${q}" ${q === p.quality ? "selected" : ""}>${q}</option>`).join("")}</select>
        ${resetBtn("aiQuality", () => { p.quality = spec.qualities[0]; renderAiTool(); })}
      </div>
      ${spec.orientation ? `
      <div class="stamp-row">
        <span class="stamp-label"${tipAttr("ai_orientation")}>Facing</span>
        <select id="aiOrient">${AI_ORIENTATION.map(([v, t]) =>
          `<option value="${v}" ${v === p.orientation ? "selected" : ""}>${t}</option>`).join("")}</select>
      </div>` : ""}
      ${spec.background ? `
      <div class="stamp-row">
        <span class="stamp-label"${tipAttr("ai_background")}>Background</span>
        <select id="aiBg">${AI_BACKGROUND.map(([v, t]) =>
          `<option value="${v}" ${v === p.background ? "selected" : ""}>${t}</option>`).join("")}</select>
      </div>` : ""}
      <div class="stamp-note">${spec.duration
        ? (plan.parts > 1
          ? `Longer than ${spec.duration[1]}s — it goes in ${plan.parts} parts of ${plan.each.toFixed(1)}s.`
          : `Whole seconds from ${spec.duration[0]} to ${spec.duration[1]}; the result is trimmed back to ${len.toFixed(2)}s.`)
        + (p.duration != null && p.duration > plan.fit
          ? `<br />Asking for more than the fragment holds — the model invents the rest.` : "")
        : `The fragment must be between ${spec.clip[0]} and ${spec.clip[1]}s${
            len < spec.clip[0] ? " — this one is too short." : "."}`}</div>
      <div class="stamp-row">
        <span class="stamp-label"${tipAttr("ai_audio")}>Sound</span>
        <select id="aiAudio">
          <option value="original" ${p.audio === "original" ? "selected" : ""}>Keep the original</option>
          <option value="generated" disabled>Generate (later)</option>
        </select>
      </div>
    </div>` : ""}

    <div class="sub-part"${tipAttr("ai_far")}>How far to go</div>
    <div class="stamp-row">
      <span class="stamp-label"${tipAttr("ai_strength")}>Strength</span>
      <select id="aiStrength">${AI_STRENGTH.map(([v, t]) =>
        `<option value="${v}" ${v === p.strength ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="stamp-row">
      <span class="stamp-label"${tipAttr("ai_shot")}>Shot</span>
      <select id="aiShot">${AI_SHOT.map(([v, t]) =>
        `<option value="${v}" ${v === p.shot ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>

    <div class="sub-part"${tipAttr("ai_media")}>Media in this generation</div>
    ${refs.length ? refs.map((r) => `
      <div class="ai-ref">
        ${r.thumb ? `<img src="${r.thumb}" alt="" />` : `<span class="ai-ref-kind">${r.kind}</span>`}
        <div class="ai-ref-main">
          <div class="ai-ref-name">${esc(r.name)}</div>
          <div class="ai-ref-sub">${esc(r.sub)}</div>
        </div>
        <b class="ai-ref-token">${r.token}</b>
      </div>`).join("")
      : `<div class="stamp-note">Pick a face on the right — nothing can be swapped in without one.</div>`}

    <div class="sub-part"${tipAttr("ai_notes")}>Anything else</div>
    <label class="field">
      <textarea id="aiNotes" rows="2" placeholder="in your own words, any language">${esc(p.notes)}</textarea></label>

    <div class="sub-part"${tipAttr("ai_prompt")}>Prompt</div>
    <label class="field"><textarea id="aiPromptBox" rows="6">${esc(p.touched ? p.prompt : aiPrompt(ai.tool, p, aiPickedName()))}</textarea></label>
    <div class="actions">
      <button class="ghost mini" id="aiRebuild">From the settings</button>
      <button class="ghost mini" id="aiPolish" ${ai.polishing ? "disabled" : ""}>
        ${ai.polishing ? "Writing…" : "Polish ✦"}</button>
    </div>
    <div class="stamp-note">${ai.polishNote
      || "“Polish” hands the settings to a language model and puts its paragraph here; edit it freely afterwards."}</div>`;

  renderAiAssets();

  $("aiCost").textContent = `≈ ${Math.round(plan.credits)} credits · $${plan.dollars.toFixed(2)}`;
  $("aiHint").textContent = `${AI_LEAD}s of the original on either side`;

  const busy = !!ai.job;
  const why = busy ? "" : !ai.picked ? "Pick a face on the right first."
    : !(p.touched ? p.prompt : "").trim() && !aiPrompt(ai.tool, p, "").trim() ? "The prompt is empty."
    : "";
  $("aiNote").textContent = busy ? (ai.job.stage || "Working…")
    : why || `${plan.parts > 1 ? `${plan.parts} parts · ` : ""}about ${plan.parts * 5} minutes.`;
  $("aiRun").disabled = busy || !!why;
  $("aiRun").textContent = busy ? "Working…" : "Generate";
  // nothing may be fiddled with while a job is out: the settings it was sent
  // with are the settings it will come back for
  $("aiParams").querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = busy; });
  $("aiStage").classList.toggle("working", busy);
  $("aiProgress").classList.toggle("hidden", !busy);
  if (busy) {
    $("aiProgressBar").style.width = `${Math.round((ai.job.pct ?? 0) * 100)}%`;
    $("aiProgressText").textContent = ai.job.stage || "Working…";
  }
  wireAiTool();
}

const aiPickedName = () => state.ai?.picked?.name || "";

/** Send the fragment to the model and wait, out loud.
 *
 *  Nothing on the timeline moves: what comes back is a new asset attached to the
 *  clip as a variant, and the clip goes on playing whichever version is chosen.
 */
async function runAiTool() {
  const ai = state.ai;
  const found = findClip(ai.clipId);
  if (!found || ai.job) return;
  const clip = found.clip;
  const asset = clipAsset(clip);
  const p = ai.params;
  const len = Math.max(0.1, ai.range.out - ai.range.in);
  const plan = aiPlan(len, p.quality, p.duration);
  const prompt = (p.touched ? p.prompt : aiPrompt(ai.tool, p, aiPickedName())).trim();

  ai.job = { stage: "Starting", pct: 0, started: Date.now() };
  ai.view = "orig";
  renderAiTool();
  try {
    const { job_id } = await post("/api/ai/generate", {
      key: Store.keys.kie || "",
      asset_id: clipAssetId(clip),
      start: ai.range.in, length: len,
      seconds: Math.round(plan.ask), quality: p.quality, prompt,
      model: p.model, orientation: p.orientation, background: p.background,
      face_id: ai.picked?.id || "",
      label: `${AI_TOOLS[ai.tool].title} · ${ai.picked?.name || clip.name || "fragment"}`,
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!state.ai || state.ai !== ai) return;        // the popup was closed
      const job = await api(`/api/jobs/${job_id}`);
      const item = job.items[0];
      ai.job = { ...ai.job, stage: item.stage, pct: item.pct ?? ai.job.pct };
      renderAiTool();
      if (!job.done) continue;
      if (item.status === "error") throw new Error(item.stage);
      await finishAiRun(item.record);
      return;
    }
  } catch (e) {
    ai.job = null;
    state.status = "Generation failed: " + e.message;
    ai.polishNote = "Generation failed: " + e.message;
    renderAiTool();
    renderProps();
  }
}

/** What came back becomes a variant of the clip, and the popup shows it. */
async function finishAiRun(made) {
  const ai = state.ai;
  const found = findClip(ai.clipId);
  ai.job = null;
  if (!made || !found) { renderAiTool(); return; }
  Store.upsertAsset(made);
  await syncAssets();

  const variant = {
    id: "v" + Date.now().toString(36),
    label: AI_TOOLS[ai.tool].title,
    asset_id: made.id,
    action: `${AI_TOOLS[ai.tool].title}${ai.picked ? ` · ${ai.picked.name}` : ""}`,
    created_at: Date.now(),
  };
  snapshot();
  const clip = found.clip;
  clip.variants = [...(clip.variants || []), variant];
  clip.variant = variant.id;                    // show the new one straight away
  partnersOf(clip).forEach(({ clip: mate }) => {
    mate.variants = [...(mate.variants || []), { ...variant }];
  });
  commit();

  ai.result = made;
  ai.view = "ai";
  $("aiView").querySelectorAll("[data-view]").forEach((b) => {
    b.disabled = false;
    b.classList.toggle("on", b.dataset.view === "ai");
  });
  state.status = `${AI_TOOLS[ai.tool].title} done — the clip is on the AI version`;
  renderAiTool();
  showAiSide();
  renderProps();
}

/** Which file the middle column plays: the source fragment, or what came back. */
function showAiSide() {
  const ai = state.ai;
  const v = $("aiVideo");
  const onAi = ai.view === "ai" && ai.result;
  $("aiEmpty").classList.toggle("hidden", !(ai.view === "ai" && !ai.result));
  v.classList.toggle("hidden", ai.view === "ai" && !ai.result);
  const url = onAi ? assetUrl(ai.result, true) : assetUrl(clipAsset(findClip(ai.clipId)?.clip || {}), true);
  if (url && v.dataset.side !== ai.view) {
    v.dataset.side = ai.view;
    v.src = url;
    v.currentTime = onAi ? 0 : ai.run.from;
  }
}

/* ---------- the face library and the bench under it ----------
 *
 * Two rooms, one above the other: what has been kept, and what is being
 * considered. A candidate arrives from disk or from thispersondoesnotexist, the
 * detector marks the faces in it, and only the square the user settles on is
 * kept — that square is exactly what the model is handed later, so what is on
 * the bench is what will be sent.
 */
const AI_SOURCES = [["all", "All"], ["random", "Random"], ["uploaded", "Uploaded"]];
const AI_DWELL = 700;          // ms a frame must stand still before it is examined

/** The enlarged look at a library face, anchored beside its thumbnail. */
function showPeek(thumb) {
  const room = state.ai ? aiRoom(state.ai) : { list: state.faces || [], chars: false };
  const face = room.list.find((f) => f.id === thumb.dataset.face);
  if (!face) return;
  const peek = $("aiPeek");
  $("aiPeekImg").src = face.url;
  $("aiPeekName").textContent = face.name;
  peek.classList.toggle("tall", room.chars);
  peek.classList.remove("hidden");
  const r = thumb.getBoundingClientRect(), box = peek.getBoundingClientRect();
  const left = r.left - box.width - 10 < 8 ? r.right + 10 : r.left - box.width - 10;
  peek.style.left = `${clamp(left, 8, innerWidth - box.width - 8)}px`;
  peek.style.top = `${clamp(r.top + r.height / 2 - box.height / 2, 8, innerHeight - box.height - 8)}px`;
}

const hidePeek = () => $("aiPeek").classList.add("hidden");

async function loadFaces() {
  try { state.faces = (await api("/api/faces")).faces || []; }
  catch { state.faces = []; }
}

/** The characters, if there are any yet — the shelf is drawn either way. */
async function loadCharacters() {
  try { state.characters = (await api("/api/characters")).characters || []; }
  catch { state.characters = []; }
}

/** The library of the room that is open, and the one folded into the spine.
 *
 *  The mode *is* the tool: pressing the spine changes what is being asked for,
 *  not merely what is on show, so the title, the prompt and the reference all
 *  follow along without a second piece of state to keep in step. */
function aiRoom(ai) {
  const chars = ai.tool === "replace_character";
  return {
    chars,
    list: chars ? (state.characters || []) : (state.faces || []),
    other: chars ? "faceswap" : "replace_character",
    otherLabel: chars ? "Faces" : "Characters",
    otherCount: chars ? (state.faces || []).length : (state.characters || []).length,
  };
}

function renderAiAssets() {
  const ai = state.ai;
  if (!ai) return;
  const tool = AI_TOOLS[ai.tool];
  const room = aiRoom(ai);
  // one of the two is open and the other is the strip you press to swap them
  const benchOpen = !!ai.benchOpen;
  $("aiRight").classList.toggle("bench-open", benchOpen);
  $("aiAssets").classList.toggle("shut", benchOpen);
  $("aiBench").classList.toggle("shut", !benchOpen);

  const filter = state.faceFilter || "all";
  const list = room.chars ? room.list
    : room.list.filter((f) => filter === "all" || f.source === filter);
  const spine = `<button class="ai-spine" id="aiSwapRoom" title="Switch to ${room.otherLabel.toLowerCase()}">
      ${room.otherLabel}${room.otherCount ? ` <b>${room.otherCount}</b>` : ""}</button>`;
  const shelf = `<div class="ai-col">
      <div class="sub-part">${tool.assets.label}</div>
      ${room.chars ? "" : `<div class="ai-filter">${AI_SOURCES.map(([v, t]) =>
        `<button class="ghost mini${v === filter ? " on" : ""}" data-src="${v}">${t}</button>`).join("")}</div>`}
      ${list.length ? `<div class="ai-grid${room.chars ? " tall" : ""}">${list.map((f) => `
        <div class="ai-thumb${ai.picked?.id === f.id ? " on" : ""}" data-face="${f.id}" title="${esc(f.name)}">
          <img loading="lazy" src="${f.thumb_url}" alt="" />
          <span class="fname">${esc(f.name)}</span>
          <button class="fdel" data-face-del="${f.id}" title="Remove from the library">✕</button>
        </div>`).join("")}</div>`
        : `<div class="ai-drop">${room.chars
          ? "No characters yet — the library that fills this arrives next."
          : "Nothing here yet — add a face below."}</div>`}
    </div>`;
  $("aiAssets").innerHTML = benchOpen
    ? `<div class="ai-shut" id="aiShowFaces">${tool.assets.label} <b>${room.list.length}</b></div>`
    : shelf + spine;

  const bench = ai.bench;
  const loading = ai.loading;
  // A video is looked through in the page itself, off the small copy the server
  // made — seeking that costs nothing, while asking for a frame per twitch of
  // the handle meant an ffmpeg run per twitch and the popup crawled (measured).
  const stageInner = loading
    ? `<div class="ai-bench-note">${esc(loading.stage || "Preparing…")}
         <div class="ai-progress"><i style="width:${Math.round((loading.pct || 0) * 100)}%"></i></div></div>`
    : bench?.kind === "video"
      ? `<video id="aiBenchVideo" src="${bench.url}" preload="auto" muted playsinline></video>`
      : bench
        ? `<img id="aiBenchImg" src="${bench.url}" alt="" />`
        : `<div class="ai-bench-note">Click to open a photo or a video, drop one
             here${room.chars ? "" : ", or take a random face"}.</div>`;

  $("aiBench").innerHTML = !benchOpen
    ? `<div class="ai-shut" id="aiShowBench">+ New ${room.chars ? "character" : "face"}</div>`
    : `<div class="ai-bench-stage${bench || loading ? "" : " empty"}" id="aiBenchStage">
        ${stageInner}
        ${bench && bench.width && !loading ? `<div class="ai-crop" id="aiCrop"><i></i></div>` : ""}
        ${bench && benchBoxes(bench, room.chars).length > 1 ? `<div class="ai-flip">
          <div class="zone left" data-flip="-1"><span>‹</span></div>
          <div class="zone right" data-flip="1"><span>›</span></div></div>` : ""}
      </div>
      ${bench?.kind === "video" ? `<div class="ai-scrub">
        <input type="range" id="aiFrameAt" min="0" max="${(bench.duration || 1).toFixed(2)}"
               step="0.04" value="${(bench.at || 0).toFixed(2)}" />
        <span class="at" id="aiFrameTime">${(bench.at || 0).toFixed(1)}s</span></div>` : ""}
      <div class="ai-bench-row">
        <button class="ghost mini" id="aiPick">Open…</button>
        ${room.chars ? "" : `<button class="ghost mini" id="aiRandom">Random</button>`}
        <button class="primary mini" id="aiSave"
          ${bench && !loading && (bench.kind !== "video" || bench.at != null) ? "" : "disabled"}>Save</button>
        <span class="ai-face-count" id="aiFaceCount">${benchCount(ai)}</span>
      </div>`;
  wireAiAssets();
  placeCrop();
}

/** The rectangles this mode leafs through: squares for faces, portraits for people.
 *
 *  Both come back with the same candidate, worked out in one pass on the server,
 *  so pressing the spine changes which list is used and asks for nothing. */
function benchBoxes(bench, chars) {
  if (!bench) return [];
  return (chars ? bench.bodies : bench.faces) || [];
}

/** What the bench has to say about itself, in three words. */
function benchCount(ai) {
  if (ai.loading) return "preparing…";
  const b = ai.bench;
  if (!b) return "";
  const chars = ai.tool === "replace_character";
  const boxes = benchBoxes(b, chars);
  const one = chars ? "person" : "face", many = chars ? "people" : "faces";
  if (b.kind === "video" && !boxes.length) return ai.looking ? "looking…" : "find a frame";
  if (boxes.length > 1) return `${one} ${(ai.faceAt || 0) + 1} of ${boxes.length}`;
  return boxes.length ? `1 ${one}` : `drag the ${chars ? "frame" : "square"}`;
}

/** Put a file on the bench: a picture arrives at once, a video is copied small
 *  first and says how far along that is. */
async function benchOpenFile(path) {
  const ai = state.ai;
  try {
    const answer = await post("/api/faces/stage", { path });
    if (!answer.job_id) return setBench(answer);        // a picture, already there
    ai.loading = { stage: "Preparing the video", pct: 0 };
    ai.bench = null;
    renderAiAssets();
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      if (!state.ai || state.ai !== ai) return;         // the tool was closed
      const job = await api(`/api/jobs/${answer.job_id}`);
      const item = job.items[0];
      ai.loading = { stage: item.stage || "Preparing the video", pct: item.pct ?? 0 };
      renderAiAssets();
      if (!job.done) continue;
      ai.loading = null;
      if (item.status === "error") throw new Error(item.stage);
      setBench(item.record);
      return;
    }
  } catch (e) {
    ai.loading = null;
    state.status = "Could not open that file: " + e.message;
    renderAiAssets();
    renderProps();
  }
}

/** Whatever the bench is showing right now — a still or the small video copy. */
const benchShown = () => $("aiBenchImg") || $("aiBenchVideo");

/** Lay a crop box over a picture, in the picture's own pixels.
 *
 *  The tool's bench and the archive viewer both draw the same rectangle over the
 *  same kind of thing, so the arithmetic — the scale between stored pixels and
 *  shown ones, the offset of a letterboxed picture inside its stage — lives here
 *  once. `crop.size` is the width and `crop.tall` says whether the height is one
 *  of those or one and a half. */
function fitCrop(box, el, stageEl, bench, crop) {
  if (!box || !el || !stageEl || !bench || !crop) return;
  const draw = () => {
    const r = el.getBoundingClientRect(), stage = stageEl.getBoundingClientRect();
    if (!r.width) return;
    const k = r.width / bench.width;
    box.style.left = `${r.left - stage.left + crop.x * k}px`;
    box.style.top = `${r.top - stage.top + crop.y * k}px`;
    box.style.width = `${crop.size * k}px`;
    box.style.height = `${crop.size * (crop.tall ? 1.5 : 1) * k}px`;
  };
  // both this and any seek beside it wait on the same event, and assigning
  // onloadedmetadata means the second one quietly replaces the first
  if (el.tagName === "VIDEO") {
    if (el.readyState >= 1) draw(); else el.addEventListener("loadedmetadata", draw, { once: true });
  } else if (el.tagName === "IMG" && !el.complete) el.addEventListener("load", draw, { once: true });
  else draw();
}

/** Move or resize a crop box by hand, keeping its shape and staying in frame.
 *
 *  `ctx` says what is being dragged and what to do afterwards: the picture
 *  element, the candidate it belongs to, where the crop lives and how to redraw. */
function dragCrop(e, resizing, ctx) {
  e.preventDefault();
  const { el, bench, get, set, redraw } = ctx;
  if (!bench || !el) return;
  const k = el.getBoundingClientRect().width / bench.width;   // screen px per image px
  // the pointer and the crop both have an x and a y, and they are not the same
  // thing: keeping them under one name made a 30px drag jump a thousand pixels
  const c0 = get();
  const start = { px: e.clientX, py: e.clientY, ...c0 };
  const ratio = start.tall ? 1.5 : 1;
  const move = (ev) => {
    const dx = (ev.clientX - start.px) / k, dy = (ev.clientY - start.py) / k;
    if (resizing) {
      // the corner grows the frame from its top-left, keeping its shape, and it
      // may not run off the edge of the picture — a crop that does cannot be cut
      const room = Math.min(bench.width - start.x, (bench.height - start.y) / ratio);
      set({ ...c0, size: Math.round(clamp(start.size + Math.max(dx, dy), 32, room)) });
    } else {
      set({
        ...c0,
        x: Math.round(clamp(start.x + dx, 0, bench.width - start.size)),
        y: Math.round(clamp(start.y + dy, 0, bench.height - start.size * ratio)),
      });
    }
    redraw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Put the crop box where the chosen face is, in the picture's own pixels. */
function placeCrop() {
  const ai = state.ai;
  if (ai) fitCrop($("aiCrop"), benchShown(), $("aiBenchStage"), ai.bench, ai.crop);
}

/** The rectangle for candidate `i`, or a sensible middle when nothing was found.
 *
 *  `size` is the width in both modes and `tall` says what the height is made of,
 *  so one crop, one drag and one placement serve a square and a portrait alike. */
function cropFor(bench, i, chars) {
  // A random face arrives already cropped to a square by the site that made it,
  // with the face filling the frame. Handing it to the detector and taking that
  // smaller box back would crop an inch off a picture that was cut to measure,
  // so the whole frame is the starting point and the detector is only there if
  // the frame needs tightening by hand.
  if (bench.source === "random" && !chars) return wholeFrame(bench, false);
  const found = benchBoxes(bench, chars)[i];
  if (found) return { ...found };
  return wholeFrame(bench, chars, 0.7);
}

/** The biggest rectangle of the asked-for shape that the picture can hold. */
function wholeFrame(bench, chars, scale = 1) {
  const ratio = chars ? 1.5 : 1;
  const w = Math.round(Math.min(bench.width, bench.height / ratio) * scale);
  return { x: Math.round((bench.width - w) / 2),
           y: Math.round((bench.height - w * ratio) / 2), size: w, tall: !!chars };
}

function setBench(data) {
  const ai = state.ai;
  ai.bench = data;
  ai.faceAt = 0;
  ai.crop = cropFor(data, 0, ai.tool === "replace_character");
  renderAiAssets();
}

function wireAiAssets() {
  const ai = state.ai;
  const room = aiRoom(ai);
  const swap = (open) => { ai.benchOpen = open; hidePeek(); renderAiAssets(); };
  $("aiShowBench")?.addEventListener("click", () => swap(true));
  $("aiShowFaces")?.addEventListener("click", () => swap(false));
  // pressing the spine changes the tool itself; each tool keeps whichever
  // reference was chosen in it, so switching back and forth loses nothing
  $("aiSwapRoom")?.addEventListener("click", () => {
    ai.picks = ai.picks || {};
    ai.picks[ai.tool] = ai.picked;
    ai.tool = room.other;
    ai.picked = ai.picks[ai.tool] || null;
    // whatever is on the bench stays there; only the frame drawn over it changes
    // shape, and it has to be redrawn before the other mode sees it
    if (ai.bench) {
      ai.faceAt = 0;
      ai.crop = cropFor(ai.bench, 0, ai.tool === "replace_character");
    }
    hidePeek();
    $("aiTitle").textContent = AI_TOOLS[ai.tool].title;
    renderAiTool();
    renderAiAssets();
  });

  $("aiAssets").querySelectorAll("[data-src]").forEach((b) =>
    b.addEventListener("click", () => { state.faceFilter = b.dataset.src; renderAiAssets(); }));
  $("aiAssets").querySelectorAll("[data-face]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.faceDel) return;
      const face = room.list.find((f) => f.id === el.dataset.face);
      ai.picked = ai.picked?.id === face?.id ? null : face;      // click again to drop it
      renderAiTool();
      renderAiAssets();
    });
    // a bigger look while the pointer is on it, gone the moment it leaves —
    // a preview that outstays its welcome is a preview that covers the next one
    el.addEventListener("pointerenter", () => showPeek(el));
    el.addEventListener("pointerleave", hidePeek);
  });
  $("aiAssets").querySelectorAll("[data-face-del]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = b.dataset.faceDel;
      await api(`/api/${room.chars ? "characters" : "faces"}/${id}`,
                { method: "DELETE" }).catch(() => {});
      if (ai.picked?.id === id) ai.picked = null;
      await (room.chars ? loadCharacters() : loadFaces());
      renderAiTool();
      renderAiAssets();
    }));

  const openOne = async () => {
    try {
      const { paths } = await api("/api/assets/pick");
      if (paths?.length) benchOpenFile(paths[0]);
    } catch (e) { state.status = "Could not open that file: " + e.message; renderProps(); }
  };
  $("aiPick")?.addEventListener("click", openOne);
  // an empty bench is a button in its own right — clicking the void asks for a file
  if (!ai.bench && !ai.loading) $("aiBenchStage")?.addEventListener("click", openOne);
  $("aiRandom")?.addEventListener("click", async () => {
    const btn = $("aiRandom");
    btn.disabled = true; btn.textContent = "…";
    try { setBench(await post("/api/faces/random", {})); }
    catch (e) { state.status = "No face came back: " + e.message; renderProps(); }
    finally { const b = $("aiRandom"); if (b) { b.disabled = false; b.textContent = "Random"; } }
  });
  $("aiSave")?.addEventListener("click", async () => {
    if (!ai.bench) return;
    const saved = await post(room.chars ? "/api/characters/save" : "/api/faces/save", {
      token: ai.bench.token, source: ai.bench.source, ...ai.crop,
    }).catch((e) => { state.status = "Could not keep it: " + e.message; return null; });
    if (!saved) return renderProps();
    ai.bench = null;                         // the bench is clear for the next one
    ai.benchOpen = false;                    // and the library comes back…
    ai.picked = saved;                       // …with what was just kept already chosen
    await (room.chars ? loadCharacters() : loadFaces());
    renderAiTool();
    renderAiAssets();
  });

  // Scrubbing a video asks nothing of the machine: while the handle is down only
  // the clock moves. Pulling a frame means running ffmpeg, and doing that on
  // every pixel of movement made the whole popup crawl — so the frame is fetched
  // when the handle is let go, and the faces are looked for once that frame has
  // stood still for a moment.
  const at = $("aiFrameAt");
  if (at) {
    const look = async (t) => {
      if (ai.frameBusy) return;
      ai.frameBusy = true;
      try {
        const data = await post("/api/faces/frame", { token: ai.bench.token, at: t, look: true });
        if (!state.ai || state.ai.bench?.token !== data.token) return;
        ai.bench = { ...ai.bench, at: data.at, faces: data.faces, bodies: data.bodies,
                     width: data.width, height: data.height };
        ai.faceAt = 0;
        ai.crop = cropFor(ai.bench, 0, room.chars);
        ai.looking = false;
        renderAiAssets();
      } catch { /* the bench moved on */ }
      finally { ai.frameBusy = false; }
    };
    at.addEventListener("input", (e) => {
      // the picture follows the handle here in the page, off the small copy
      const t = Number(e.target.value);
      clearTimeout(ai.frameTimer);
      ai.looking = false;
      $("aiFrameTime").textContent = t.toFixed(1) + "s";
      const v = $("aiBenchVideo");
      if (v) { try { v.currentTime = t; } catch { /* not seekable yet */ } }
    });
    const settle = (e) => {
      const t = Number(e.target.value);
      clearTimeout(ai.frameTimer);
      ai.looking = true;
      $("aiFaceCount").textContent = benchCount(ai);
      // the full-size frame is pulled from the original only once the handle has
      // been let go and the picture has stood still
      ai.frameTimer = setTimeout(() => look(t), AI_DWELL);
    };
    at.addEventListener("change", settle);
    at.addEventListener("pointerup", settle);   // some builds only give us this one
  }

  $("aiBench").querySelectorAll("[data-flip]").forEach((z) =>
    z.addEventListener("click", () => {
      const n = benchBoxes(ai.bench, room.chars).length;
      if (!n) return;
      ai.faceAt = (ai.faceAt + Number(z.dataset.flip) + n) % n;
      ai.crop = cropFor(ai.bench, ai.faceAt, room.chars);
      renderAiAssets();
    }));

  const stage = $("aiBenchStage");
  if (stage) {
    stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dropping"); });
    stage.addEventListener("dragleave", () => stage.classList.remove("dropping"));
    stage.addEventListener("drop", async (e) => {
      e.preventDefault();
      stage.classList.remove("dropping");
      const file = e.dataTransfer?.files?.[0];
      if (file?.path) benchOpenFile(file.path);  // the desktop shell hands us a real path
    });
  }
  const box = $("aiCrop");
  if (box) box.addEventListener("pointerdown", (e) => startCropDrag(e, e.target.tagName === "I"));

  // a redraw builds a fresh <video>, which starts at zero — put it back where the
  // handle left it, or the picture jumps to the top of the clip after every look
  const vid = $("aiBenchVideo");
  if (vid && ai.bench?.at != null) {
    const seek = () => {
      try { vid.currentTime = ai.bench.at; } catch { /* not ready */ }
      placeCrop();
    };
    if (vid.readyState >= 1) seek(); else vid.addEventListener("loadedmetadata", seek, { once: true });
  }
}

/** Move or resize the square by hand — the way out when the detector finds nothing. */
function startCropDrag(e, resizing) {
  const ai = state.ai;
  dragCrop(e, resizing, {
    el: $("aiBenchImg"), bench: ai.bench,
    get: () => ai.crop, set: (c) => { ai.crop = c; }, redraw: placeCrop,
  });
}

function wireAiTool() {
  const ai = state.ai, p = ai.params;
  const redraw = () => { p.touched = false; renderAiTool(); };
  // this panel writes its own markup, so it also binds its own reset arrows —
  // the inspector's collector never sees them
  pendingResets.forEach(({ id, fn }) => $(id)?.addEventListener("click", fn));
  pendingResets = [];
  $("aiDur")?.addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    p.duration = Number.isFinite(v) ? clamp(v, SEEDANCE.min, SEEDANCE.max) : null;
    renderAiTool();
  });
  $("aiModel")?.addEventListener("change", (e) => {
    p.model = e.target.value;
    const spec = AI_MODELS[p.model];
    if (!spec.qualities.includes(p.quality)) p.quality = spec.qualities[0];
    if (!spec.duration) p.duration = null;
    renderAiTool();
  });
  $("aiQuality")?.addEventListener("change", (e) => { p.quality = e.target.value; renderAiTool(); });
  $("aiOrient")?.addEventListener("change", (e) => { p.orientation = e.target.value; });
  $("aiBg")?.addEventListener("change", (e) => { p.background = e.target.value; });
  $("aiAudio")?.addEventListener("change", (e) => { p.audio = e.target.value; });
  $("aiStrength")?.addEventListener("change", (e) => { p.strength = e.target.value; redraw(); });
  $("aiShot")?.addEventListener("change", (e) => { p.shot = e.target.value; redraw(); });
  $("aiNotes")?.addEventListener("change", (e) => { p.notes = e.target.value; redraw(); });
  $("aiPromptBox").addEventListener("input", (e) => { p.prompt = e.target.value; p.touched = true; });
  $("aiFold").addEventListener("click", () => { ai.foldOpen = !ai.foldOpen; renderAiTool(); });
  $("aiRebuild").addEventListener("click", () => { ai.polishNote = ""; redraw(); });
  $("aiPolish").addEventListener("click", async () => {
    // the switches say what to change; the model says it the way the video model
    // wants to hear it, and folds in whatever was typed by hand, in any language
    ai.polishing = true;
    ai.polishNote = "";
    renderAiTool();
    try {
      const refs = aiRefs(ai);
      const { prompt, note } = await post("/api/prompt/beautify", {
        key: Store.keys.kie || "",
        tool: AI_TOOLS[ai.tool].title,
        facts: aiFacts(ai),
        refs: refs.map((r) => ({ token: r.token, what: r.sub })),
      });
      p.prompt = prompt;
      p.touched = true;                 // it is the user's text now, not the recipe's
      ai.polishNote = note
        ? `Written by the model, but ${note}.`
        : "Written by the model — edit it as you like.";
    } catch (e) {
      ai.polishNote = "Could not write it: " + e.message;
    } finally {
      ai.polishing = false;
      renderAiTool();
    }
  });
}

/** Lift the fragment's sound into the library, on its own two feet. */
async function extractAudio(clip) {
  const asset = clipAsset(clip);
  if (!asset || !asset.has_audio) {
    state.status = "This clip has no sound to take";
    renderProps();
    return;
  }
  state.status = "Extracting audio…";
  renderProps();
  try {
    const { job_id } = await post("/api/assets/extract-audio", {
      asset_id: clipAssetId(clip), start: clip.in, end: clip.out,
      name: `${clip.name || asset.name} · audio`,
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const job = await api(`/api/jobs/${job_id}`);
      const item = job.items[0];
      state.status = item.stage;
      const st = $("clipStatus");
      if (st) st.textContent = item.stage;
      if (!job.done) continue;
      if (item.status === "error") throw new Error(item.stage);
      Store.upsertAsset(item.record);
      state.status = `Saved to the library: ${item.record.name}`;
      break;
    }
  } catch (e) {
    state.status = "Extraction failed: " + e.message;
  }
  renderLibrary();
  renderProps();
}

function closeSubPanels() {
  state.sceneScan = null;
  state.transcribe = null;
  state.silence = null;
}

/** Every selected fragment an action can work on, in timeline order. */
function actionTargets(clip, kinds = ["video"]) {
  const chosen = allClips()
    .filter(({ clip: c }) => state.selectedClips.has(c.id) && kinds.includes(c.kind))
    .map(({ clip: c }) => c)
    .sort((a, b) => a.start - b.start);
  return chosen.length ? chosen : [clip];
}

function openSplit(clip) {
  const targets = actionTargets(clip).filter((c) => (clipAsset(c) || {}).kind !== "image");
  if (!targets.length) {
    state.status = "Nothing to split — a still has no scenes";
    renderProps();
    return;
  }
  closeSubPanels();
  state.sceneScan = {
    clipId: clip.id, targets: targets.map((c) => c.id), byClip: {},
    stage: "settings", threshold: 0.35, minLen: 0.8, autoLower: true, lowered: null, note: "",
  };
  renderTimeline();
  renderProps();
}

function closeSplit() {
  state.sceneScan = null;
  renderTimeline();
  renderProps();
}

async function runScan() {
  const scan = state.sceneScan;
  const targets = scan.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  scan.stage = "scanning";
  scan.byClip = {};
  renderTimeline();
  renderProps();
  try {
    for (let i = 0; i < targets.length; i++) {
      const clip = targets[i];
      const many = targets.length > 1 ? ` (${i + 1} of ${targets.length})` : "";
      scan.note = `Reading “${(clip.name || "clip").slice(0, 18)}”${many}…`;
      renderProps();
      const { job_id } = await post("/api/scenes", {
        asset_id: clipAssetId(clip), start: clip.in, end: clip.out,
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const job = await api(`/api/jobs/${job_id}`);
        const item = job.items[0];
        scan.note = item.stage + many;
        const bar = $("scanStage");
        if (bar) bar.textContent = scan.note;
        if (!job.done) continue;
        if (item.status === "error") throw new Error(item.stage);
        scan.byClip[clip.id] = { cuts: item.record.cuts || [], scanned: item.record.scanned || 0, marks: [] };
        break;
      }
    }
    scan.stage = "review";
    scan.note = "";
    // asked for a cut no matter what: drop the sensitivity until one appears
    if (scan.autoLower && !targets.some((c) => keptCuts(scan, c).length)) {
      let found = null;
      for (let level = scan.threshold; level >= SCAN_FLOOR - 1e-9 && found == null; level -= 0.02) {
        if (targets.some((c) => keptCuts(scan, c, level).length)) found = +level.toFixed(2);
      }
      if (found != null) {
        scan.lowered = { from: scan.threshold, to: found };
        scan.threshold = found;
      }
    }
    targets.forEach((c) => {
      const own = scanOf(scan, c);
      if (own) own.marks = keptCuts(scan, c).map((x) => ({ ...x, custom: false }));
    });
  } catch (e) {
    scan.stage = "settings";
    scan.note = "Scan failed: " + e.message;
  }
  renderTimeline();
  renderProps();
}

/** Turn the surviving candidates into real cuts — one undo step for all of them. */
function applySceneCuts() {
  const scan = state.sceneScan;
  const targets = scan.targets.map((id) => findClip(id)?.clip).filter(Boolean);
  if (!targets.some((c) => (scanOf(scan, c)?.marks || []).length)) return;

  snapshot();
  let total = 0;
  targets.forEach((clip) => {
    const cuts = [...(scanOf(scan, clip)?.marks || [])].sort((a, b) => a.at - b.at);
    if (!cuts.length) { total += 1; return; }      // untouched, but still a fragment
    const base = (clip.name || "clip").replace(/\s+\d+$/, "");
    const only = new Set([clip.id]);
    let current = clip;
    const pieces = [current];
    cuts.forEach(({ at }) => {
      const t = clip.start + at;          // candidates are measured from where the clip began
      const wanted = cuttableAt(t, only);
      if (!wanted.length) return;
      const made = cutAt(t, wanted);
      // keep cutting the right-hand piece of the clip we started from
      const next = made.find((m) => m.clip.kind === current.kind && m.clip.start === t);
      if (next) {
        only.delete(current.id);
        only.add(next.clip.id);
        current = next.clip;
        pieces.push(current);
      }
    });
    pieces.forEach((c, i) => { c.name = `${base} ${i + 1}`; });
    total += pieces.length;
  });

  state.sceneScan = null;
  state.qaBack = true;                       // the panel slides back to the action list
  commit();
  state.status = targets.length > 1
    ? `${targets.length} fragment(s) → ${total} pieces`
    : `Split into ${total} fragment(s)`;
  renderProps();
}

/** Switch a clip between its original file and one of its AI variants.
 *
 *  An AI result rarely comes back exactly as long as what went in, so the clip's
 *  length on the timeline is kept whenever the new file can hold it — the window
 *  slides back rather than collapsing. Only a genuinely shorter file shortens the
 *  clip, and then it says so instead of quietly eating seconds.
 */
function setVariant(clip, variantId, write) {
  const target = variantId ? (clip.variants || []).find((v) => v.id === variantId) : null;
  const asset = Store.data.assets[target ? target.asset_id : clip.asset_id];
  const wanted = clipLen(clip) * (clip.params?.speed || 1);   // in source seconds
  const dur = asset?.duration || 0;
  const short = dur > 0 && dur < wanted - 1e-3;
  let note = target ? `Playing “${target.label}”` : "Back to the original";
  if (short) note += ` · shorter source, clip trimmed to ${(dur / (clip.params?.speed || 1)).toFixed(2)}s`;

  write((c) => {
    // the write reaches linked partners too, and an extracted audio clip has no
    // versions of its own — leave it pointing at its own file
    const owns = variantId ? (c.variants || []).some((v) => v.id === variantId) : !!c.variant;
    if (!owns) return;
    c.variant = variantId || null;
    if (!dur || isStill(c)) return;
    if (dur >= wanted) {
      c.in = clamp(c.in, 0, dur - wanted);
      c.out = c.in + wanted;
    } else {
      c.in = 0;
      c.out = dur;
    }
  }, note);
}

function quickActions(clip, multi, write) {
  const variants = clip.variants || [];
  const rows = QA_ROWS.map((row) => {
    const items = QUICK_ACTIONS.filter((a) => a.row === row);
    return `<div class="preset-row">
        <span class="preset-cap" data-tip="${esc(QA_ROW_TIPS[row] || "")}">${esc(row)}</span>
        <div class="preset-btns">${items.map((a) => `<button class="preset qa${a.run ? " live" : ""}"
            ${a.run ? `data-qa="${a.id}"` : "disabled"}
            data-tip="${esc(a.tip + (a.ai ? " Runs on kie.ai and costs credits." : "")
              + (a.run ? "" : a.soon === "next" ? " — arriving in the next step." : " — in development."))}">${esc(a.label)}
            ${a.ai ? `<i class="ai">AI</i>` : ""}
            ${a.run ? "" : `<i class="soon">${a.soon === "next" ? "soon" : "dev"}</i>`}</button>`).join("")}</div>
      </div>`;
  }).join("");

  const chips = `<div class="var-switch">
      <button class="var ${clip.variant ? "" : "on"}" data-var=""
        data-tip="The file as it was downloaded or imported. Always kept.">Original</button>
      ${variants.map((v) => `<button class="var ${clip.variant === v.id ? "on" : ""}" data-var="${v.id}"
        data-tip="${esc(v.action ? `${v.action} · ${new Date(v.created_at).toLocaleString()}` : "")}">${esc(v.label)}</button>`).join("")}
    </div>`;

  const owns = (panel) => panel && (panel.targets ? panel.targets.includes(clip.id)
    : panel.clipId === clip.id);
  const scan = owns(state.sceneScan) ? state.sceneScan : null;

  /** The split lives in its own panel: settings first, cuts second, nothing
   *  touched until Approve. */
  const splitPanel = () => {
    const targets = scan.targets.map((id) => findClip(id)?.clip).filter(Boolean);
    const marks = targets.flatMap((c) => scanOf(scan, c)?.marks || []);
    const scanned = targets.reduce((n, c) => n + (scanOf(scan, c)?.scanned || 0), 0);
    const moved = marks.filter((m) => m.custom).length;
    const scanning = scan.stage === "scanning";
    const reviewing = scan.stage === "review";
    const many = targets.length > 1 ? ` across ${targets.length} fragments` : "";

    return `<div class="sub-panel" data-anim="in">
        <div class="sub-head">
          <button class="ghost mini back" id="splitBack" title="Back to the actions">←</button>
          <span>Split by scenes</span>
        </div>

        ${sliderRow("scanTh", "Sensitivity", SCAN_FLOOR, 0.9, 0.02, scan.threshold, scan.threshold.toFixed(2),
          { tip: "scan_threshold" })}
        ${sliderRow("scanMin", "Shortest piece", 0.2, 5, 0.1, scan.minLen, scan.minLen.toFixed(1) + "s",
          { tip: "scan_min" })}
        <label class="check"${tipAttr("scan_auto")}><input type="checkbox" id="scanAuto"
          ${scan.autoLower ? "checked" : ""} /> Always find at least one cut</label>

        ${scanning ? `<div class="scan-bar"><i></i></div>` : ""}
        ${reviewing ? `<div class="scan-head">${marks.length
            ? `${marks.length} cut(s)${many} → ${marks.length + targets.length} fragments`
            : "nothing to cut at this sensitivity"}
            <em>· scanned ${scanned.toFixed(1)}s${moved ? `, ${moved} moved by hand` : ""}</em></div>` : ""}

        <div class="stamp-note" id="scanStage">${esc(
          scanning ? scan.note || "" :
          reviewing
            ? (scan.lowered
                ? `Nothing at ${scan.lowered.from.toFixed(2)} — sensitivity lowered to ${scan.lowered.to.toFixed(2)}.`
                : marks.length
                  ? "Drag a mark on the clip to move the cut, double-click it to drop it."
                  : "Try a lower sensitivity, or cut at the playhead with S.")
            : scan.note || "Nothing is cut until you approve it.")}</div>

        <div class="actions">
          <button class="ghost mini" id="splitAdd" ${scanning ? "disabled" : ""}
            data-tip="Put a cut wherever the playhead stands — for the moments the detector missed.">+ Add cut</button>
          ${scan.selected != null && scan.selectedClip
            ? `<button class="ghost mini danger" id="splitDrop"
                 data-tip="Remove the selected cut. Del does the same.">Remove cut</button>` : ""}
        </div>

        <div class="actions">
          ${reviewing
            ? `<button class="primary mini" id="splitApprove" ${marks.length ? "" : "disabled"}>Approve</button>
               <button class="ghost mini" id="splitAgain">Scan again</button>`
            : `<button class="primary mini" id="splitRun" ${scanning ? "disabled" : ""}>Split</button>`}
        </div>
      </div>`;
  };

  const tr = owns(state.transcribe) ? state.transcribe : null;
  const sil = owns(state.silence) ? state.silence : null;
  // exactly one of them is on screen, and everything below agrees on which
  const open = scan ? "split" : tr ? "transcribe" : sil ? "silence" : null;

  const silencePanel = () => {
    const listening = sil.stage === "listening";
    const reviewing = sil.stage === "review";
    const targets = sil.targets.map((id) => findClip(id)?.clip).filter(Boolean);
    const gaps = reviewing ? targets.flatMap((c) => silenceGaps(sil, c)) : [];
    const saved = gaps.reduce((s, g) => s + (g.to - g.from), 0);
    const subs = targets.reduce((n, c) => n + subtitlesOf(c).length, 0);
    const many = targets.length > 1 ? ` across ${targets.length} fragments` : "";
    const phrases = targets.reduce((n, c) => n + (sil.byClip[c.id]?.phrases || []).length, 0);

    const bySpeech = sil.mode !== "loud";
    // pauses long enough to bother with, before the padding gives their edges back
    const heardEnough = bySpeech ? 0
      : targets.reduce((n, c) => n + (sil.byClip[c.id]?.gaps || [])
          .filter((g) => g.to - g.from >= sil.minGap).length, 0);
    return `<div class="sub-panel" data-anim="in">
        <div class="sub-head">
          <button class="ghost mini back" id="silBack" title="Back to the actions">←</button>
          <span>Remove silence</span>
        </div>
        <div class="var-switch">
          <button class="var ${bySpeech ? "on" : ""}" data-sil="speech"
            data-tip="Keep what is said and drop the rest. Boundaries come from this fragment's subtitles, or from a transcript.">By subtitles</button>
          <button class="var ${bySpeech ? "" : "on"}" data-sil="loud"
            data-tip="Keep what is loud enough. ffmpeg measures the level — it also catches breaths and room tone that no transcript mentions.">By loudness</button>
        </div>
        ${bySpeech ? "" : sliderRow("silNoise", "Quiet under", -60, -10, 1, sil.noiseDb,
          sil.noiseDb + " dB", { tip: "sil_noise" })}
        ${sliderRow("silBefore", "Keep before", 0.1, 1, 0.05, sil.padBefore, sil.padBefore.toFixed(2) + "s",
          { tip: "sil_before" })}
        ${sliderRow("silAfter", "Keep after", 0.1, 1, 0.05, sil.padAfter, sil.padAfter.toFixed(2) + "s",
          { tip: "sil_after" })}
        ${sliderRow("silMin", "Shortest gap", 0.2, 3, 0.1, sil.minGap, sil.minGap.toFixed(1) + "s",
          { tip: "sil_min" })}
        ${listening ? `<div class="scan-bar"><i></i></div>` : ""}
        ${reviewing ? `<div class="scan-head">${gaps.length
            ? `${gaps.length} quiet stretch(es)${many} → ${saved.toFixed(1)}s shorter`
            : heardEnough
              ? `${heardEnough} pause(s) found, but the padding leaves nothing of them`
              : "nothing quiet enough to cut"}
            <em>· ${bySpeech ? `${phrases} phrase(s) from ${esc(sil.byClip[targets[0]?.id]?.source || "speech")}`
                              : `heard under ${sil.noiseDb} dB`}</em></div>` : ""}
        ${reviewing && subs ? `<div class="hint-box">${subs} subtitle(s) sit on this material. They travel
          with the picture: lines inside a cut go, the rest slide up with it.</div>` : ""}
        <div class="stamp-note" id="silStage">${esc(sil.note
          || (reviewing ? "The shaded stretches go; everything after slides up to close the hole."
                        : "Nothing is cut until you approve it."))}</div>
        <div class="actions">
          ${reviewing
            ? `<button class="primary mini" id="silApply" ${gaps.length ? "" : "disabled"}>Approve</button>
               <button class="ghost mini" id="silAgain">${bySpeech ? "Listen again" : "Measure again"}</button>`
            : `<button class="primary mini" id="silRun" ${listening ? "disabled" : ""}>${
                 bySpeech ? "Find speech" : "Find quiet"}</button>`}
        </div>
      </div>`;
  };

  const transcribePanel = () => {
    const working = tr.stage === "working";
    const reviewing = tr.stage === "review";
    if (tr.stage === "existing") {
      const made = subtitlesOf(clip);
      const track = made[0].track;
      return `<div class="sub-panel" data-anim="in">
          <div class="sub-head">
            <button class="ghost mini back" id="trBack" title="Back to the actions">←</button>
            <span>Transcribe</span>
          </div>
          <div class="hint-box">This fragment already has <b>${made.length}</b> subtitle(s) on
            “${esc(track.name)}”. Their words, look and timing are edited there.</div>
          <div class="actions">
            <button class="primary mini" id="trOpen">Open the subtitle track</button>
          </div>
          <div class="actions">
            <button class="ghost mini danger" id="trRedo">Transcribe again</button>
          </div>
          <div class="stamp-note">Listening again replaces those lines — the look you set is kept.</div>
        </div>`;
    }
    const targets = (tr.targets || []).map((id) => findClip(id)?.clip).filter(Boolean);
    const kept = reviewing ? cueTimes(tr) : [];
    const many = targets.length > 1 ? ` across ${targets.length} fragments` : "";
    const engine = speechEngine();
    const fellBack = engine === "groq" && (Store.settings.speech_engine === "local");
    const noKey = engine === "groq" && !Store.keys.groq;

    return `<div class="sub-panel" data-anim="in">
        <div class="sub-head">
          <button class="ghost mini back" id="trBack" title="Back to the actions">←</button>
          <span>Transcribe</span>
        </div>

        <div class="prop-row"><span>Engine</span><b>${engine === "groq"
          ? "Groq · whisper-large-v3-turbo" : "Local · faster-whisper"}</b></div>
        ${fellBack ? `<div class="hint-box">Preferences ask for the local engine, but it is not installed —
          this runs on Groq. Install it in Preferences to switch over.</div>` : ""}
        ${noKey ? `<div class="hint-box">No Groq key set — add one in Preferences, or install the local engine there.</div>` : ""}

        ${reviewing ? "" : `
          <label class="field"><span${tipAttr("speech_lang")}>Language</span>
            <select id="trLang">${SPEECH_LANGUAGES.map(([v, t]) =>
              `<option value="${v}" ${v === tr.language ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`}
        <div class="stamp-note">Look, wording and timing are set on the subtitle track once the
          lines are placed — this step only listens.</div>

        ${working ? `<div class="scan-bar"><i></i></div>` : ""}
        ${reviewing ? `<div class="scan-head">${kept.length} phrase(s)${many}
            <em>· ${esc(tr.engineUsed === "local" ? "local" : "groq")}</em></div>
          <div class="phrase-list">${targets.map((c) => {
            const own = tr.byClip[c.id] || [];
            const cues = cueTimes(tr, c.id);
            const header = targets.length > 1
              ? `<div class="phrase-head">${esc((c.name || "fragment").slice(0, 26))}</div>` : "";
            return header + own.map((s) => {
              const cue = cues.find((k) => k.id === s.id);
              return `<div class="phrase ${s.keep ? "" : "off"}">
                <button class="ph-keep" data-keep="${s.id}" title="${s.keep ? "Skip this one" : "Bring it back"}">${s.keep ? "✓" : "○"}</button>
                <button class="ph-go" data-go="${s.id}" data-of="${c.id}" title="Jump to the middle of this phrase">▸</button>
                <span class="ph-time" title="${s.keep ? `spoken at ${s.start.toFixed(2)}s` : ""}">${
                  (cue ? cue.cueStart : s.start).toFixed(1)}s</span>
                <input class="ph-text" data-text="${s.id}" value="${esc(s.text)}" />
              </div>`; }).join("");
          }).join("")}</div>` : ""}

        <div class="stamp-note" id="trStage">${esc(working ? tr.note || ""
          : reviewing ? "Edit the words, untick what you don't want, then place them."
          : tr.note || "Nothing is added until you approve it.")}</div>

        <div class="actions">
          ${reviewing
            ? `<button class="primary mini" id="trApply" ${kept.length ? "" : "disabled"}>Add subtitles</button>
               <button class="ghost mini" id="trAgain">Listen again</button>`
            : `<button class="primary mini" id="trRun" ${working || noKey ? "disabled" : ""}>Transcribe</button>`}
        </div>
      </div>`;
  };

  const actionList = () => `<div class="sub-panel" data-anim="${state.qaBack ? "back" : ""}">
      ${multi ? `<div class="hint-box">Several clips selected — actions will run on each of them.</div>` : `
        <div class="stamp-head">Playing<em> · ${variants.length ? `${variants.length + 1} version(s)` : "no AI version yet"}</em></div>
        ${chips}`}
      <div class="preset-wrap qa-wrap">${rows}</div>
      <div class="stamp-note">Nothing here overwrites the original: a result arrives as another version
        of this clip, and this switch decides which one plays and renders.</div>
    </div>`;

  return {
    id: "quick", label: "Quick actions",
    tip: "Cutting, speech and the AI passes — and the switch between the original and what they returned.",
    // one decision about what is on screen, used by both halves: they disagreed
    // once, and the wiring then ran against a panel that was not there — which
    // killed every handler on it, the way out included
    html: () => (open === "split" ? splitPanel() : open === "transcribe" ? transcribePanel()
      : open === "silence" ? silencePanel() : actionList()),
    wire: () => {
      state.qaBack = false;
      if (open === "silence") {
        $("silBack").addEventListener("click", () => { state.qaBack = true; closeSilence(); });
        const run = () => (sil.mode === "loud" ? findQuiet() : findSilence());
        $("propsBody").querySelectorAll("[data-sil]").forEach((b) =>
          b.addEventListener("click", () => {
            if (sil.mode === b.dataset.sil) return;
            sil.mode = b.dataset.sil;
            sil.stage = "settings";
            sil.note = "";
            if (sil.mode === "speech") {
              sil.padBefore = 0.25; sil.padAfter = 0.35;   // room around a whole phrase
              sil.targets.forEach((id) => { const c = findClip(id)?.clip; if (c) loadSpeechRanges(c); });
            } else {
              // a pause between words is short; big pads would swallow it whole
              sil.padBefore = 0.1; sil.padAfter = 0.1;
              if (Object.values(sil.byClip).some((v) => (v.gaps || []).length)) sil.stage = "review";
            }
            renderTimeline();
            renderProps();
          }));
        const live = (id, key, fmt) => liveSlider(id, fmt,
          (v) => { sil[key] = v; renderTimeline(); }, () => renderProps());
        live("silBefore", "padBefore", (v) => v.toFixed(2) + "s");
        live("silAfter", "padAfter", (v) => v.toFixed(2) + "s");
        live("silMin", "minGap", (v) => v.toFixed(1) + "s");
        liveSlider("silNoise", (v) => v + " dB", null, (v) => { sil.noiseDb = v; renderProps(); });
        $("silRun")?.addEventListener("click", run);
        $("silAgain")?.addEventListener("click", run);
        $("silApply")?.addEventListener("click", () => applySilence());
        return;
      }
      if (open === "transcribe") {
        $("trBack").addEventListener("click", () => { state.qaBack = true; closeTranscribe(); });
        $("trOpen")?.addEventListener("click", () => {
          const made = subtitlesOf(clip);
          state.transcribe = null;
          state.selectedClips.clear();
          state.selectedTrack = made[0].track.id;
          state.propGroup.track = "text";
          if (made[0].clip) jumpToClip(made[0].clip);
          renderTimeline();
          renderProps();
        });
        $("trRedo")?.addEventListener("click", () => {
          // keep the look that was already chosen for this fragment
          const made = subtitlesOf(clip);
          tr.style = { ...(made[0]?.clip.params || {}) };
          tr.stage = "settings";
          tr.replaces = made.map((m) => m.clip.id);
          renderProps();
        });
        $("trLang")?.addEventListener("change", (e) => {
          tr.language = e.target.value;
          Store.setSetting("speech_language", tr.language);   // remembered for next time
        });

        const phraseById = (id) => Object.values(tr.byClip || {}).flat().find((x) => x.id === id);
        $("propsBody").querySelectorAll("[data-keep]").forEach((b) =>
          b.addEventListener("click", () => {
            const s = phraseById(b.dataset.keep);
            if (s) s.keep = !s.keep;
            renderProps();
          }));
        $("propsBody").querySelectorAll("[data-text]").forEach((inp) =>
          inp.addEventListener("input", (e) => {
            const s = phraseById(inp.dataset.text);
            if (s) s.text = e.target.value;
          }));
        $("propsBody").querySelectorAll("[data-go]").forEach((b) =>
          b.addEventListener("click", () => {
            // the phrase is not on the timeline yet — aim at the middle of where it will be
            const host = findClip(b.dataset.of)?.clip || clip;
            const s = cueTimes(tr, host.id).find((k) => k.id === b.dataset.go) || phraseById(b.dataset.go);
            if (!s) return;
            const speed = host.params?.speed || 1;
            const from = host.start + (s.cueStart ?? s.start) / speed;
            const to = host.start + (s.cueEnd ?? s.end) / speed;
            movePlayhead((from + to) / 2);
            renderPreview();
          }));
        $("trRun")?.addEventListener("click", () => runTranscribe());
        $("trAgain")?.addEventListener("click", () => runTranscribe());
        $("trApply")?.addEventListener("click", () => applySubtitles());
        return;
      }
      if (open !== "split") {
        $("propsBody").querySelectorAll(".var").forEach((b) =>
          b.addEventListener("click", () => {
            if ((clip.variant || "") === b.dataset.var) return;
            setVariant(clip, b.dataset.var || null, write);
            renderProps();
          }));
        $("propsBody").querySelectorAll("[data-qa]").forEach((b) =>
          b.addEventListener("click", () => {
            const action = QUICK_ACTIONS.find((a) => a.id === b.dataset.qa);
            action?.run?.(clip);
          }));
        return;
      }

      $("splitBack").addEventListener("click", () => { state.qaBack = true; closeSplit(); });
      // the marks follow the slider while it moves — only the timeline is redrawn,
      // never the panel the slider lives in
      liveSlider("scanTh", (v) => v.toFixed(2),
        (v) => { scan.threshold = v; scan.lowered = null; refreshMarks(scan); renderTimeline(); },
        () => renderProps());
      liveSlider("scanMin", (v) => v.toFixed(1) + "s",
        (v) => { scan.minLen = v; refreshMarks(scan); renderTimeline(); },
        () => renderProps());
      $("scanAuto").addEventListener("change", (e) => { scan.autoLower = e.target.checked; });
      $("splitAdd").addEventListener("click", () => addMarkAtPlayhead(clip));
      $("splitDrop")?.addEventListener("click", () => removeMark(scan.selected, scan.selectedClip));
      $("splitRun")?.addEventListener("click", () => runScan());
      $("splitAgain")?.addEventListener("click", () => runScan());
      $("splitApprove")?.addEventListener("click", () => applySceneCuts());
    },
  };
}

/* ---------- animation preset grid ---------- */

const ROW_NAMES = { Drift: "Drift", In: "Slide in", Out: "Slide out" };
const presetName = (p) => (p.icon ? `${ROW_NAMES[p.row] || p.row} ${p.label}` : p.label);

/** Preset buttons, plus how fast they run and which curve they ride. */
function presetGrid() {
  const rows = PRESET_ROWS.map((row) => {
    const items = PRESETS.filter((p) => p.row === row);
    return `<div class="preset-row">
        <span class="preset-cap" data-tip="${esc(ROW_TIPS[row] || "")}">${esc(row)}</span>
        <div class="preset-btns">${items.map((p) =>
          `<button class="preset${p.icon ? " ico" : ""}" data-p="${p.id}"
             data-tip="${esc(presetName(p) + " — " + p.tip)}">${esc(p.label)}</button>`).join("")}</div>
      </div>`;
  }).join("");

  const opts = (list, cur) => list.map(([v, t]) =>
    `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");

  return `<div class="preset-wrap">${rows}</div>
    <div class="stamp-row">
      <span class="stamp-label"${tipAttr("preset_speed")}>Speed</span>
      <select id="anSpeed">${opts([["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]], state.presetSpeed)}</select>
    </div>
    <div class="stamp-row">
      <span class="stamp-label"${tipAttr("preset_curve")}>Curve</span>
      <select id="anCurve">${opts([["auto", "Preset's own"],
        ...Object.entries(CURVE_LABELS)], state.presetCurve)}</select>
    </div>`;
}

function wirePresets(onPick) {
  $("propsBody").querySelectorAll(".preset").forEach((b) =>
    b.addEventListener("click", () => {
      const preset = PRESETS.find((p) => p.id === b.dataset.p);
      if (preset) onPick(preset);
    }));
  $("anSpeed")?.addEventListener("change", (e) => { state.presetSpeed = e.target.value; });
  $("anCurve")?.addEventListener("change", (e) => { state.presetCurve = e.target.value; });
}

/* ---------- grouped inspector shell ---------- */

const GROUP_TIPS = {
  info: "What this is and where it lives: names, timings and the file on disk.",
  audio: "Loudness and fades — everything you hear from this clip.",
  timing: "Speed and how long things last on the timeline.",
  look: "Colour, opacity and how the picture mixes with the layers below.",
  frame: "Ready-made moves — zooms, drifts, entrances and hits — plus the zoom and position they are built from.",
  transitions: "How the clip appears and leaves — dissolves and wipes.",
  text: "The words themselves and how they are set.",
  flags: "Switches for the whole track: mute, solo, visibility, lock.",
  canvas: "Shape and frame rate of the finished video.",
};

/** Two columns: group buttons on the left, that group's parameters on the right.
 *  Used by the clip/track inspector and by Preferences, so the two panels can
 *  never drift apart. `opts.pick` gets the id of a newly chosen group. */
function groupPanel(host, groups, currentId, opts = {}) {
  pendingResets = [];
  const chosen = groups.find((g) => g.id === currentId) || groups[0];
  const statusId = opts.statusId || "clipStatus";

  host.innerHTML = `
    <div class="props-grid">
      <div class="prop-groups">
        ${groups.map((g) => `<button class="pg ${g === chosen ? "on" : ""}" data-g="${g.id}"
            data-tip="${esc(g.tip || GROUP_TIPS[g.id] || "")}">${esc(g.label)}</button>`).join("")}
      </div>
      <div class="prop-pane">
        <div class="pane-title-row">
          <span class="prop-head">${esc(chosen.label)}</span>
          ${chosen.reset ? `<button class="rs-btn" id="groupReset"
              title="Reset everything in this group">↺ all</button>` : ""}
        </div>
        ${chosen.html()}
        <div class="stamp-status" id="${statusId}">${esc(opts.status || "")}</div>
      </div>
    </div>`;

  host.querySelectorAll(".pg").forEach((b) =>
    b.addEventListener("click", () => opts.pick?.(b.dataset.g)));
  chosen.wire?.();
  pendingResets.forEach(({ id, fn }) => $(id)?.addEventListener("click", fn));
  $("groupReset")?.addEventListener("click", () => chosen.reset());
  return chosen;
}

function inspector(kind, groups) {
  const chosen = groupPanel($("propsBody"), groups, state.propGroup[kind], {
    status: state.status,
    pick: (id) => {
      // walking away from Quick actions puts its sub-panels away, so coming back
      // always starts at the list of things you can do
      if (kind === "clip" && id !== "quick") closeSubPanels();
      state.propGroup[kind] = id;
      renderProps();
    },
  });
  state.propGroup[kind] = chosen.id;
}

/* ---------- tooltips ---------- */

let tipTimer = null;
function initTooltips() {
  const tip = document.createElement("div");
  tip.className = "tip hidden";
  tip.id = "tip";
  document.body.appendChild(tip);

  document.addEventListener("pointerover", (e) => {
    const host = e.target.closest?.("[data-tip]");
    if (!host) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      tip.textContent = host.dataset.tip;
      tip.classList.remove("hidden");
      const r = host.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + "px";
      const above = r.top > tip.offsetHeight + 12;
      tip.style.top = (above ? r.top - tip.offsetHeight - 6 : r.bottom + 6) + "px";
    }, 400);
  });
  document.addEventListener("pointerout", (e) => {
    if (!e.target.closest?.("[data-tip]")) return;
    clearTimeout(tipTimer);
    tip.classList.add("hidden");
  });
  document.addEventListener("pointerdown", () => {
    clearTimeout(tipTimer);
    tip.classList.add("hidden");
  }, true);
}

/* ---------- the subtitle track ----------
 * A text track has no volume, no speed and no stamp to carry, so none of that is
 * shown. What it does have is a look shared by every line, and the lines
 * themselves — which is exactly what these three groups are.
 */
const SUB_STYLE_KEYS = ["font", "size", "color", "align", "y", "box", "box_color",
  "box_opacity", "outline", "outline_color", "shadow", "case"];

const subStyle = (track) => ({
  ...TEXT_DEFAULTS(), size: SUB_SIZE, font: Store.settings.sub_font || "Montserrat",
  outline: 0, outline_color: "#000000", shadow: false, case: "none",
  shadow_color: "#000000", shadow_dist: 3, bold: false, italic: false,
  enter: "none", enter_len: 0.3,
  hl: false, hl_color: "#ffe066", hl_mode: "color",
  ...(track.clips[0]?.params || {}),
});

/** A change you cannot see is a change you cannot judge.
 *
 *  Every setting here lands in the picture at once, which is worth nothing when
 *  the playhead is parked where this track has no line: the panel then looks
 *  broken, because it is doing exactly what was asked and nothing shows. So the
 *  playhead comes to the nearest line first — and only when there is nothing on
 *  screen to look at, never when there already is. */
function ensureLineVisible(track) {
  const t = state.playhead;
  if (!track.clips.length) return false;
  if (track.clips.some((c) => t >= c.start && t < c.start + clipLen(c))) return false;
  const near = track.clips.reduce((best, c) =>
    (!best || Math.abs(c.start - t) < Math.abs(best.start - t) ? c : best), null);
  movePlayhead(near.start + clipLen(near) / 2);
  return true;
}

/** "on the word" reads better than "0.00s". */
const offsetLabel = (v) => (Math.abs(v) < 0.001 ? "on the word"
  : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}s`);

/* Style has more knobs than fit in one breath, so it is split — the dropdown
 * under the heading picks which handful is on screen. */
const SUB_STYLE_TABS = [
  ["type", "Typeface"],
  ["colour", "Colour & edge"],
  ["asslib", "asslib"],
];

/** One style change, written into every line on the track in a single step. */
function stampSubStyle(track, patch, label) {
  snapshot();
  track.clips.forEach((c) => { c.params = { ...c.params, ...patch }; });
  rewrapTrack(track, Store.settings.sub_wrap ?? 34);   // case, size and font all change the fit
  commit();
  ensureLineVisible(track);              // the change has to be on screen to be judged
  state.status = `${label} → ${track.clips.length} subtitle(s)`;
  renderProps();
}

/** Re-flow every line to the current width, from the words as they were said. */
function rewrapTrack(track, chars) {
  track.clips.forEach((c) => {
    const raw = c.raw || String(c.text || "").replace(/\n+/g, " ");
    c.raw = raw;
    c.text = wrapPhrase(raw, chars, c.params);
  });
}

/** Rebuild every line on the track into cards of N words.
 *
 *  The words and their timings are already on the clips, so this is a re-cut of
 *  what is there rather than another pass over the audio — and it works the
 *  same in both directions: a smaller number splits the cards, a bigger one
 *  pools the words back together. Lines with no timings are left where they are.
 */
function regroupTrack(track, per) {
  const offset = Store.settings.sub_offset ?? 0;
  const wrap = Store.settings.sub_wrap ?? 34;
  const stay = [];
  // one pool per sentence, not per fragment: cards must not straddle the end of
  // one phrase and the start of the next, and "whole phrase" has to give back
  // the sentences the transcription actually heard
  const groups = new Map();
  track.clips.forEach((c) => {
    const times = wordTimes(c);
    if (!times) { stay.push(c); return; }
    const key = `${c.from_clip || "loose"}#${c.cue_seg ?? c.id}`;
    const g = groups.get(key) || { src: c, seg: c.cue_seg ?? c.id, items: [] };
    times.forEach((w, i) => g.items.push({ t0: w.t0, t1: w.t1, word: c.words[i] }));
    groups.set(key, g);
  });

  const made = [];
  groups.forEach(({ src, seg, items }) => {
    items.sort((a, b) => a.t0 - b.t0);
    for (let i = 0; i < items.length; i += per) {
      const chunk = items.slice(i, i + per);
      const raw = chunk.map((x) => String(x.word.text).trim()).join(" ");
      const base = chunk[0].t0;
      made.push({
        ...JSON.parse(JSON.stringify(src)),
        id: "c" + Date.now().toString(36) + made.length.toString(36)
            + Math.floor(Math.random() * 1e4).toString(36),
        name: raw.slice(0, 24), raw, text: wrapPhrase(raw, wrap, src.params),
        in: 0, out: Math.max(0.3, chunk[chunk.length - 1].t1 - base),
        start: Math.max(0, base + offset), cue_base: base, cue_seg: seg, offset,
        words: chunk.map((x) => ({ ...x.word })),
      });
    }
  });
  track.clips = [...stay, ...made].sort((a, b) => a.start - b.start);
  return made.length;
}

/** Put the playhead in the middle of a line, where the whole phrase is on screen. */
function jumpToClip(clip) {
  movePlayhead(clip.start + clipLen(clip) / 2);
  renderPreview();
}

function renderTrackProps() {
  const track = state.project.tracks.find((t) => t.id === state.selectedTrack);
  if (!track) { state.selectedTrack = null; renderProps(); return; }
  if (track.kind === "text") { renderSubtitleTrackProps(track); return; }
  const s = trackStamp(track);
  const d = TRACK_DEFAULTS();
  const total = track.clips.reduce((c, x) => c + clipLen(x), 0);
  const isAudio = track.kind === "audio";
  // what this track still remembers from earlier stamps
  const stampDiffers = Object.keys(d)
    .filter((k) => s[k] !== d[k])
    .map((k) => `${k} ${typeof s[k] === "number" ? +s[k].toFixed(2) : s[k]}`)
    .join(", ");

  /* one stamp = one history step, written into every clip on the track */
  const stamp = (field, value, apply, label) => {
    snapshot();
    track.stamp = { ...trackStamp(track), [field]: value };
    track.clips.forEach(apply);
    track.clips.sort((a, b) => a.start - b.start);
    commit();
    state.status = `${label} → ${track.clips.length} clip(s)`;
    const st = $("clipStatus");
    if (st) st.textContent = state.status;
  };
  const stampers = {
    volume_db: (v) => stamp("volume_db", v, (c) => { c.params.volume = dbToGain(v); }, `Volume ${v} dB`),
    fade_in: (v) => stamp("fade_in", v, (c) => { c.params.fade_in = v; }, `Fade in ${v.toFixed(1)}s`),
    fade_out: (v) => stamp("fade_out", v, (c) => { c.params.fade_out = v; }, `Fade out ${v.toFixed(1)}s`),
    speed: (v) => stamp("speed", v, (c) => { c.params.speed = v; }, `Speed ${v.toFixed(2)}×`),
    still_len: (v) => stamp("still_len", v, (c) => {
      if (isStill(c)) { c.in = 0; c.out = v * (c.params.speed || 1); }
    }, `Still length ${v.toFixed(1)}s`),
    brightness: (v) => stamp("brightness", v, (c) => { c.params.brightness = v; }, `Brightness ${v.toFixed(2)}`),
    contrast: (v) => stamp("contrast", v, (c) => { c.params.contrast = v; }, `Contrast ${v.toFixed(2)}`),
    saturation: (v) => stamp("saturation", v, (c) => { c.params.saturation = v; }, `Saturation ${v.toFixed(2)}`),
    opacity: (v) => stamp("opacity", v, (c) => { c.params.opacity = v; }, `Opacity ${Math.round(v * 100)}%`),
    blend: (v) => stamp("blend", v, (c) => { c.params.blend = v; }, `Blend ${v}`),
  };
  const resetGroup = (keys) => {
    snapshot();
    const next = { ...trackStamp(track) };
    keys.forEach((k) => { next[k] = d[k]; });
    track.stamp = next;
    track.clips.forEach((c) => {
      keys.forEach((k) => {
        if (k === "volume_db") c.params.volume = dbToGain(d.volume_db);
        else if (k === "still_len") { if (isStill(c)) { c.in = 0; c.out = d.still_len * (c.params.speed || 1); } }
        else c.params[k] = d[k];
      });
    });
    commit();
    state.status = "Group reset to defaults";
    renderProps();
  };

  const groups = [
    {
      id: "info", label: "Info",
      html: () => `
        <label class="field"><span>Name</span>
          <input id="trkName" type="text" value="${esc(track.name)}" /></label>
        ${sliderRow("trkHeight", "Height", MIN_TRACK_H, MAX_TRACK_H, 1, trackH(track), trackH(track) + " px",
          { tip: "height", reset: () => { snapshot(); track.height = MIN_TRACK_H; commit(); renderProps(); } })}
        <div class="prop-row"><span>Kind</span><b>${track.kind}</b></div>
        <div class="prop-row"><span>Content</span><b>${track.clips.length} clip(s) · ${total.toFixed(1)}s</b></div>
        <div class="prop-row"><span${tipAttr("pair")}>Pair</span><b>#${pairIndex(track) + 1} · ${esc(pairedTrack(track)?.name || "—")}</b></div>
        ${stampDiffers ? `
          <div class="stamp-note">This track carries stamped values: ${esc(stampDiffers)}.
            New clips ignore them — they always start neutral.</div>
          <div class="actions"><button class="ghost mini" id="trkClearStamp">Forget stamped values</button></div>` : ""}`,
      wire: () => {
        $("trkName").addEventListener("change", (e) => {
          const name = e.target.value.trim();
          if (!name || name === track.name) return;
          snapshot();
          track.name = name;
          Store.setTrackName(track.kind, pairIndex(track), name);
          state.status = `Track name “${name}” saved for new projects`;
          commit();
          renderProps();
        });
        liveSlider("trkHeight", (v) => v + " px", (v) => {
          track.height = clamp(Math.round(v), MIN_TRACK_H, MAX_TRACK_H);
          renderTimeline();
        }, () => Store.touchProject(state.project));
        $("trkClearStamp")?.addEventListener("click", () => {
          snapshot();
          delete track.stamp;               // clips keep their own values
          commit();
          state.status = "Track defaults cleared";
          renderProps();
        });
      },
    },
    {
      id: "flags", label: "Switches",
      html: () => `
        <div class="actions">
          ${isAudio
            ? `<button class="ghost mini ${track.muted ? "on" : ""}" id="trkMute"${tipAttr("mute")}>${track.muted ? "🔇" : "🔊"} Mute</button>
               <button class="ghost mini ${track.solo ? "on" : ""}" id="trkSolo"${tipAttr("solo")}>S Solo</button>`
            : `<button class="ghost mini ${track.hidden ? "on" : ""}" id="trkHide"${tipAttr("visible")}>${track.hidden ? "🚫" : "👁"} Visible</button>`}
          <button class="ghost mini ${track.locked ? "on" : ""}" id="trkLock"${tipAttr("lock")}>${track.locked ? "🔒" : "🔓"} Lock</button>
        </div>
        <div class="hint-box">Mute silences the track, Solo plays only soloed tracks, Lock protects
          its clips from being moved or trimmed.</div>`,
      wire: () => {
        const flag = (id, key) => $(id)?.addEventListener("click", () => {
          snapshot();
          track[key] = !track[key];
          commit();
          renderProps();
        });
        if (isAudio) { flag("trkMute", "muted"); flag("trkSolo", "solo"); } else flag("trkHide", "hidden");
        flag("trkLock", "locked");
      },
      reset: () => {
        snapshot();
        track.muted = track.solo = track.hidden = track.locked = false;
        commit();
        state.status = "Switches reset";
        renderProps();
      },
    },
    {
      id: "audio", label: "Audio",
      html: () => `
        <div class="stamp-note">Stamped into all ${track.clips.length} clip(s) on this track.</div>
        ${sliderRow("stVol", "Volume", -60, 12, 1, s.volume_db, s.volume_db + " dB",
          { tip: "volume", reset: () => stampers.volume_db(d.volume_db) })}
        ${sliderRow("stFadeIn", "Fade in", 0, 5, 0.1, s.fade_in, s.fade_in.toFixed(1) + "s",
          { tip: "fade_in", reset: () => stampers.fade_in(d.fade_in) })}
        ${sliderRow("stFadeOut", "Fade out", 0, 5, 0.1, s.fade_out, s.fade_out.toFixed(1) + "s",
          { tip: "fade_out", reset: () => stampers.fade_out(d.fade_out) })}`,
      wire: () => {
        liveSlider("stVol", (v) => v + " dB", null, stampers.volume_db);
        liveSlider("stFadeIn", (v) => v.toFixed(1) + "s", null, stampers.fade_in);
        liveSlider("stFadeOut", (v) => v.toFixed(1) + "s", null, stampers.fade_out);
      },
      reset: () => resetGroup(["volume_db", "fade_in", "fade_out"]),
    },
    {
      id: "timing", label: "Timing",
      html: () => `
        ${sliderRow("stSpeed", "Speed", 0.25, 4, 0.05, s.speed, s.speed.toFixed(2) + "×",
          { tip: "speed", reset: () => stampers.speed(d.speed) })}
        ${sliderRow("stStill", "Still length", 0.5, 20, 0.5, s.still_len, s.still_len.toFixed(1) + "s",
          { tip: "still_len", reset: () => stampers.still_len(d.still_len) })}
        <div class="stamp-note">${track.clips.filter(isStill).length} still(s) on this track</div>`,
      wire: () => {
        liveSlider("stSpeed", (v) => v.toFixed(2) + "×", null, stampers.speed);
        liveSlider("stStill", (v) => v.toFixed(1) + "s", null, stampers.still_len);
      },
      reset: () => resetGroup(["speed", "still_len"]),
    },
  ];

  if (!isAudio) {
    groups.push({
      id: "look", label: "Look",
      html: () => `
        ${sliderRow("stBri", "Brightness", -0.5, 0.5, 0.02, s.brightness, s.brightness.toFixed(2),
          { tip: "brightness", reset: () => stampers.brightness(d.brightness) })}
        ${sliderRow("stCon", "Contrast", 0.5, 1.5, 0.05, s.contrast, s.contrast.toFixed(2),
          { tip: "contrast", reset: () => stampers.contrast(d.contrast) })}
        ${sliderRow("stSat", "Saturation", 0, 2, 0.05, s.saturation, s.saturation.toFixed(2),
          { tip: "saturation", reset: () => stampers.saturation(d.saturation) })}
        ${sliderRow("stOpa", "Opacity", 0, 1, 0.05, s.opacity, Math.round(s.opacity * 100) + "%",
          { tip: "opacity", reset: () => stampers.opacity(d.opacity) })}
        <div class="stamp-row with-rs">
          <span class="stamp-label"${tipAttr("blend")}>Blend</span>
          <select id="stBlend">${BLEND_MODES.map((m) =>
            `<option value="${m}" ${m === s.blend ? "selected" : ""}>${m}</option>`).join("")}</select>
          ${resetBtn("stBlend", () => stampers.blend(d.blend))}
        </div>`,
      wire: () => {
        liveSlider("stBri", (v) => v.toFixed(2), null, stampers.brightness);
        liveSlider("stCon", (v) => v.toFixed(2), null, stampers.contrast);
        liveSlider("stSat", (v) => v.toFixed(2), null, stampers.saturation);
        liveSlider("stOpa", (v) => Math.round(v * 100) + "%", null, stampers.opacity);
        $("stBlend").addEventListener("change", (e) => stampers.blend(e.target.value));
      },
      reset: () => resetGroup(["brightness", "contrast", "saturation", "opacity", "blend"]),
    });
  }

  inspector("track", groups);
}

/** Info · Style · Text — everything a line of subtitles actually has. */
function renderSubtitleTrackProps(track) {
  const st = subStyle(track);
  const lines = track.clips.length;
  const total = track.clips.reduce((c, x) => c + clipLen(x), 0);
  const sources = [...new Set(track.clips.map((c) => c.from_clip).filter(Boolean))]
    .map((id) => findClip(id)?.clip?.name)
    .filter(Boolean);
  const put = (patch, label) => stampSubStyle(track, patch, label);

  const groups = [
    {
      id: "info", label: "Info",
      tip: "What is on this track and where it came from.",
      html: () => `
        <label class="field"><span>Name</span>
          <input id="trkName" type="text" value="${esc(track.name)}" /></label>
        ${sliderRow("trkHeight", "Height", MIN_TRACK_H, MAX_TRACK_H, 1, trackH(track), trackH(track) + " px",
          { tip: "height", reset: () => { snapshot(); track.height = MIN_TRACK_H; commit(); renderProps(); } })}
        <div class="prop-row"><span>Content</span><b>${lines} subtitle(s) · ${total.toFixed(1)}s</b></div>
        <div class="prop-row"><span>From</span><b>${sources.length ? esc(sources.join(", ")) : "—"}</b></div>
        <div class="stamp-note">Visibility and removal live on the track itself, in the timeline.</div>`,
      wire: () => {
        $("trkName").addEventListener("change", (e) => {
          const name = e.target.value.trim();
          if (!name || name === track.name) return;
          snapshot();
          track.name = name;
          Store.setTrackName(track.kind, pairIndex(track), name);
          commit();
          renderProps();
        });
        liveSlider("trkHeight", (v) => v + " px", (v) => {
          track.height = clamp(Math.round(v), MIN_TRACK_H, MAX_TRACK_H);
          renderTimeline();
        }, () => Store.touchProject(state.project));
      },
    },
    {
      id: "style", label: "Style",
      tip: "How every line on this track looks. Changes land on all of them at once.",
      html: () => {
        const tab = state.subStyleTab || "type";
        // settings you cannot see are settings you cannot judge
        const showing = track.clips.some((c) =>
          state.playhead >= c.start && state.playhead < c.start + clipLen(c));
        const blind = showing || !track.clips.length ? "" : `
          <div class="stamp-note">The playhead is not over a line — nothing to look at while you adjust.</div>
          <div class="actions"><button class="ghost mini" id="stJump">Show me a line</button></div>`;
        // the picker chooses what the rest of the panel is about, so it reads as
        // a heading rather than as the first of the settings under it
        const picker = `<div class="stamp-row group-picker">
            <span class="stamp-label"${tipAttr("sub_group")}>Group</span>
            <select id="stTab">${SUB_STYLE_TABS.map(([v, t]) =>
              `<option value="${v}" ${v === tab ? "selected" : ""}>${t}</option>`).join("")}</select>
          </div>`;

        if (tab === "type") {
          // a cut the family does not ship cannot be rendered, so it is not offered
          const hasBold = fontFace(st.font, "bold") || fontFace(st.font, "bold_italic");
          const hasItalic = fontFace(st.font, "italic") || fontFace(st.font, "bold_italic");
          return picker + `
            <div class="stamp-row with-rs">
              <span class="stamp-label"${tipAttr("sub_font")}>Font</span>
              <select id="stFont" style="font-family:'${esc(st.font)}'">${fontOptions(st.font)}</select>
              <button class="rs-btn" id="stFontAdd" title="Add your own font files">+</button>
            </div>
            ${sliderRow("stSize", "Size", 24, 140, 2, st.size, st.size + " px", { tip: "text_size" })}
            <div class="check-row"${tipAttr("sub_weight")}>
              <label class="check"><input type="checkbox" id="stBold" ${st.bold ? "checked" : ""}
                ${hasBold ? "" : "disabled"} /> Bold</label>
              <label class="check"><input type="checkbox" id="stItalic" ${st.italic ? "checked" : ""}
                ${hasItalic ? "" : "disabled"} /> Italic</label>
            </div>
            ${hasBold && hasItalic ? "" : `<div class="stamp-note">${esc(st.font)} ships
              ${!hasBold && !hasItalic ? "neither a bold nor an italic cut" : !hasBold ? "no bold cut" : "no italic cut"}
              on this machine — the render can only draw a file that exists.</div>`}
            <label class="check"><input type="checkbox" id="stUpper" ${st.case === "upper" ? "checked" : ""} /> ALL CAPS</label>
            ${blind}`;
        }
        if (tab === "colour") {
          return picker + `
            <div class="stamp-row">
              <span class="stamp-label">Text</span>
              <input id="stColor" type="color" value="${esc(st.color)}" />
            </div>
            ${sliderRow("stOutline", "Outline", 0, 8, 1, st.outline, st.outline ? st.outline + " px" : "off",
              { tip: "sub_outline" })}
            <div class="stamp-row">
              <span class="stamp-label">Outline colour</span>
              <input id="stOutlineColor" type="color" value="${esc(st.outline_color)}" />
            </div>
            <label class="check"><input type="checkbox" id="stShadow" ${st.shadow ? "checked" : ""} /> Drop shadow</label>
            ${st.shadow ? `
              <div class="stamp-row">
                <span class="stamp-label">Shadow colour</span>
                <input id="stShadowColor" type="color" value="${esc(st.shadow_color)}" />
              </div>
              ${sliderRow("stShadowDist", "Distance", 1, 12, 1, st.shadow_dist, st.shadow_dist + " px",
                { tip: "sub_shadow" })}` : ""}
            <label class="check"><input type="checkbox" id="stBox" ${st.box ? "checked" : ""} /> Plate behind the text</label>
            ${st.box ? `
              <div class="stamp-row">
                <span class="stamp-label">Plate colour</span>
                <input id="stBoxColor" type="color" value="${esc(st.box_color)}" />
              </div>
              ${sliderRow("stBoxOpacity", "Plate", 0, 1, 0.05, st.box_opacity,
                Math.round(st.box_opacity * 100) + "%", { tip: "text_box" })}` : ""}
            ${blind}`;
        }
        // everything that decides how a line is cut, where it sits and how it
        // arrives — the whole subtitle behaviour in one place, with the pure
        // look (typeface, colour) left in its own groups
        const timed = track.clips.filter((c) => (c.words || []).length).length;
        const modes = [["color", "Colour"], ["plate", "Plate"], ["grow", "Grow"]];
        const per = Store.settings.sub_words | 0;
        // the highlight is tried on before it is worn: the draft shows in the
        // preview, and only Apply writes it into the lines
        const d = st;
        return picker + `
          <div class="sub-part">Lines</div>
          <div class="stamp-row with-rs">
            <span class="stamp-label"${tipAttr("sub_words")}>Words / line</span>
            <select id="stWords" ${timed ? "" : "disabled"}>
              <option value="0" ${per ? "" : "selected"}>Whole phrase</option>
              ${[2, 3, 4, 5, 6, 7, 8].map((n) =>
                `<option value="${n}" ${n === per ? "selected" : ""}>${n}</option>`).join("")}</select>
            ${resetBtn("stWords", () => { Store.setSetting("sub_words", 0); renderProps(); })}
          </div>
          ${sliderRow("stWrap", "Line length", 12, 48, 1, Store.settings.sub_wrap ?? 34,
            (Store.settings.sub_wrap ?? 34) + " chars", { tip: "sub_wrap" })}

          <div class="sub-part">Placement</div>
          ${sliderRow("stY", "Vertical", 0.05, 0.95, 0.01, st.y, Math.round(st.y * 100) + "%", { tip: "text_y" })}
          <div class="stamp-row with-rs">
            <span class="stamp-label"${tipAttr("text_align")}>Align</span>
            <select id="stAlign">${["left", "center", "right"].map((a) =>
              `<option value="${a}" ${a === st.align ? "selected" : ""}>${a}</option>`).join("")}</select>
            ${resetBtn("stAlign", () => put({ align: "center" }, "Align centre"))}
          </div>
          <label class="check"${tipAttr("sub_move")}><input type="checkbox" id="stMoveAll"
            ${Store.settings.sub_move_same !== false ? "checked" : ""} /> Dragging one moves the rest to the same place</label>

          <div class="sub-part">Arrival</div>
          <div class="stamp-row with-rs">
            <span class="stamp-label"${tipAttr("sub_enter")}>Arrives</span>
            <select id="stEnter">${ENTRANCE_LIST.map(([v, t]) =>
              `<option value="${v}" ${v === st.enter ? "selected" : ""}>${t}</option>`).join("")}</select>
            ${resetBtn("stEnter", () => put({ enter: "none" }, "Arrival off"))}
          </div>
          ${st.enter && st.enter !== "none"
            ? sliderRow("stEnterLen", "Takes", 0.1, 0.8, 0.05, st.enter_len,
                st.enter_len.toFixed(2) + "s", { tip: "sub_enter_len" })
            : `<div class="stamp-note">Lines simply appear on their first word.</div>`}

          <div class="sub-part">Spoken word</div>
          <label class="check"${tipAttr("sub_hl")}><input type="checkbox" id="stHl"
            ${d.hl ? "checked" : ""} ${timed ? "" : "disabled"} /> Pick out the word being spoken</label>
          ${timed ? "" : `<div class="stamp-note">No line on this track carries word timings —
            transcribe it again to get them.</div>`}
          ${d.hl ? `
            <div class="stamp-row with-rs">
              <span class="stamp-label"${tipAttr("sub_hl_mode")}>How</span>
              <select id="stHlMode">${modes.map(([v, t]) =>
                `<option value="${v}" ${v === d.hl_mode ? "selected" : ""}>${t}</option>`).join("")}</select>
              ${resetBtn("stHlMode", () => put({ hl_mode: "color" }, "Highlight by colour"))}
            </div>
            <div class="stamp-row">
              <span class="stamp-label">${d.hl_mode === "plate" ? "Plate" : "Word"} colour</span>
              <input id="stHlColor" type="color" value="${esc(d.hl_color)}" />
            </div>
            ${timed < lines ? `<div class="stamp-note">${lines - timed} line(s) have no word timings and
              stay as they are.</div>` : ""}` : ""}
          <div class="stamp-note">Every change in this group lands on all ${lines} line(s) at once.</div>
          ${blind}`;
      },
      wire: () => {
        $("stTab").addEventListener("change", (e) => { state.subStyleTab = e.target.value; renderProps(); });
        $("stFont")?.addEventListener("change", (e) => {
          Store.setSetting("sub_font", e.target.value);
          put({ font: e.target.value }, `Font ${e.target.value}`);
        });
        $("stFontAdd")?.addEventListener("click", async () => {
          const added = await addFontFiles();
          if (added) { Store.setSetting("sub_font", added); put({ font: added }, `Font ${added}`); }
          else renderProps();
        });
        // these show their work: the picture follows the slider, the panel waits
        // for the release (rebuilding it mid-drag would take the slider away)
        const liveStyle = (id, key, fmt, label) => liveSlider(id, fmt,
          (v) => {
            if (!state.styleDrag) { snapshot(); state.styleDrag = true; ensureLineVisible(track); }
            track.clips.forEach((c) => { c.params = { ...c.params, [key]: v }; });
            Store.touchProject(state.project);
            renderPreview();
          },
          (v) => {
            state.styleDrag = false;
            track.clips.forEach((c) => { c.params = { ...c.params, [key]: v }; });
            if (key === "size") rewrapTrack(track, Store.settings.sub_wrap ?? 34);
            commit();
            state.status = `${label(v)} → ${track.clips.length} subtitle(s)`;
            renderProps();
          });

        $("stJump")?.addEventListener("click", () => {
          const near = track.clips.reduce((best, c) =>
            (!best || Math.abs(c.start - state.playhead) < Math.abs(best.start - state.playhead) ? c : best), null);
          if (near) jumpToClip(near);
          renderProps();
        });
        liveStyle("stSize", "size", (v) => v + " px", (v) => `Size ${v}px`);
        liveStyle("stY", "y", (v) => Math.round(v * 100) + "%", (v) => `Vertical ${Math.round(v * 100)}%`);
        liveStyle("stOutline", "outline", (v) => (v ? v + " px" : "off"), (v) => `Outline ${v}px`);
        $("stColor")?.addEventListener("change", (e) => put({ color: e.target.value }, "Colour changed"));
        $("stOutlineColor")?.addEventListener("change", (e) => put({ outline_color: e.target.value }, "Outline colour"));
        $("stAlign")?.addEventListener("change", (e) => put({ align: e.target.value }, `Align ${e.target.value}`));
        $("stShadow")?.addEventListener("change", (e) => put({ shadow: e.target.checked }, e.target.checked ? "Shadow on" : "Shadow off"));
        $("stShadowColor")?.addEventListener("change", (e) => put({ shadow_color: e.target.value }, "Shadow colour"));
        liveStyle("stShadowDist", "shadow_dist", (v) => v + " px", (v) => `Shadow ${v}px`);
        $("stBold")?.addEventListener("change", (e) => put({ bold: e.target.checked },
          e.target.checked ? "Bold" : "Regular weight"));
        $("stItalic")?.addEventListener("change", (e) => put({ italic: e.target.checked },
          e.target.checked ? "Italic" : "Upright"));
        $("stEnter")?.addEventListener("change", (e) => put({ enter: e.target.value },
          `Arrival ${e.target.value}`));
        $("stWords")?.addEventListener("change", (e) => {
          const n = Number(e.target.value) | 0;
          Store.setSetting("sub_words", n);
          snapshot();
          const made = regroupTrack(track, n > 0 ? n : 999);
          commit();
          ensureLineVisible(track);
          state.status = n ? `${made} card(s) of up to ${n} word(s)` : `${made} whole phrase(s)`;
          renderProps();
        });
        liveStyle("stEnterLen", "enter_len", (v) => v.toFixed(2) + "s", (v) => `Arrival ${v.toFixed(2)}s`);
        $("stBox")?.addEventListener("change", (e) => put({ box: e.target.checked }, e.target.checked ? "Plate on" : "Plate off"));
        $("stBoxColor")?.addEventListener("change", (e) => put({ box_color: e.target.value }, "Plate colour"));
        liveStyle("stBoxOpacity", "box_opacity", (v) => Math.round(v * 100) + "%",
          (v) => `Plate ${Math.round(v * 100)}%`);
        $("stUpper")?.addEventListener("change", (e) => put({ case: e.target.checked ? "upper" : "none" },
          e.target.checked ? "ALL CAPS" : "Normal case"));
        $("stHl")?.addEventListener("change", (e) => put({ hl: e.target.checked },
          e.target.checked ? "Spoken word picked out" : "Highlight off"));
        $("stHlMode")?.addEventListener("change", (e) => put({ hl_mode: e.target.value },
          `Highlight by ${e.target.value}`));
        $("stHlColor")?.addEventListener("change", (e) => put({ hl_color: e.target.value }, "Highlight colour"));
        liveSlider("stWrap", (v) => v + " chars", null, (v) => {
          Store.setSetting("sub_wrap", v);
          snapshot();
          rewrapTrack(track, v);
          commit();
          ensureLineVisible(track);
          state.status = `Lines re-flowed to ${v} characters`;
          renderProps();
        });
        $("stMoveAll")?.addEventListener("change", (e) => Store.setSetting("sub_move_same", e.target.checked));
      },
      reset: () => put({ ...TEXT_DEFAULTS(), size: SUB_SIZE, outline: 0, outline_color: "#000000",
        shadow: false, shadow_color: "#000000", shadow_dist: 3, case: "none", y: 0.82,
        bold: false, italic: false, enter: "none", enter_len: 0.3,
        hl: false, hl_color: "#ffe066", hl_mode: "color" }, "Style reset"),
    },
    {
      id: "text", label: "Text",
      tip: "The lines themselves: the words, when each one shows, and how early they come up.",
      html: () => {
        if (!lines) return `<div class="hint-box">No subtitles on this track yet.</div>`;
        const withWords = track.clips.filter((c) => (c.words || []).length).length;
        return `
          ${sliderRow("stLead", "Offset", -1, 1, 0.05, Store.settings.sub_offset ?? 0,
            offsetLabel(Store.settings.sub_offset ?? 0), { tip: "sub_offset" })}
          <div class="stamp-note">${withWords === lines
            ? "Every line remembers when its first word was spoken — the lead-in works from that."
            : `${lines - withWords} line(s) carry no word timings; the lead-in moves them from where they sit.`}</div>
          <div class="phrase-list">${track.clips.map((c, i) => `
            <div class="phrase">
              <button class="ph-keep" data-jump="${i}" title="Jump to the middle of this line">▸</button>
              <span class="ph-time">${c.start.toFixed(1)}s</span>
              <input class="ph-text" data-line="${i}" value="${esc(c.raw || String(c.text || "").replace(/\n+/g, " "))}" />
              <button class="ph-del" data-drop="${i}" title="Remove this line">✕</button>
            </div>`).join("")}</div>`;
      },
      wire: () => {
        // the lines move under the pointer; the panel is left alone until release,
        // or the slider being dragged would be rebuilt out from under it
        liveSlider("stLead", offsetLabel,
          (v) => {
            if (!state.leadDrag) { snapshot(); state.leadDrag = true; }
            retimeTrack(track, v, { commitStep: false });
          },
          (v) => {
            state.leadDrag = false;
            Store.setSetting("sub_offset", v);
            retimeTrack(track, v);
            renderProps();
          });
        $("propsBody").querySelectorAll("[data-jump]").forEach((b) =>
          b.addEventListener("click", () => jumpToClip(track.clips[Number(b.dataset.jump)])));
        $("propsBody").querySelectorAll("[data-line]").forEach((inp) =>
          inp.addEventListener("change", () => {
            const clip = track.clips[Number(inp.dataset.line)];
            snapshot();
            clip.raw = inp.value;
            clip.text = wrapPhrase(inp.value, Store.settings.sub_wrap ?? 34, clip.params);
            clip.name = inp.value.slice(0, 24);
            commit();
            state.status = "Line updated";
          }));
        $("propsBody").querySelectorAll("[data-drop]").forEach((b) =>
          b.addEventListener("click", () => {
            const clip = track.clips[Number(b.dataset.drop)];
            snapshot();
            track.clips = track.clips.filter((c) => c !== clip);
            commit();
            state.status = "Line removed";
            renderProps();
          }));
      },
    },
  ];

  inspector("track", groups);
}

/** Slide the whole track earlier or later.
 *
 *  Each line is anchored to `cue_base` — the moment its first word is spoken,
 *  which is where generation puts it. The offset then **moves** the line, keeping
 *  its length: negative shows it before the word, positive after. Lines with no
 *  word timings anchor to where they already sit, so they travel too.
 */
function retimeTrack(track, offset, { commitStep = true } = {}) {
  if (!track.clips.length) return;
  track.clips.forEach((c) => {
    if (c.cue_base == null) {
      c.cue_base = cueBase(c);
      c.cue_len = clipLen(c);           // the length is the line's own, and stays
    }
    c.start = +Math.max(0, c.cue_base + offset).toFixed(3);
    c.offset = offset;
  });
  track.clips.sort((a, b) => a.start - b.start);
  state.status = offset
    ? `Subtitles ${offset > 0 ? "after" : "before"} the word by ${Math.abs(offset).toFixed(2)}s`
    : "Subtitles sit exactly on the spoken word";
  if (commitStep) commit();
  else { Store.touchProject(state.project); renderTimeline(); renderPreview(); }
}

/** Slider that updates its readout (and optionally the view) while dragging and
 *  only commits on release — the pattern that keeps long tracks responsive. */
function liveSlider(id, fmt, onDrag, onCommit) {
  const el = $(id);
  if (!el) return;
  const out = $(id + "-val");
  el.addEventListener("input", () => {
    const v = Number(el.value);
    if (out) out.textContent = fmt(v);
    if (onDrag) onDrag(v);
  });
  el.addEventListener("change", () => { if (onCommit) onCommit(Number(el.value)); });
}

/* ---------- adding clips ---------- */

async function ensureVaultAsset(shortcode) {
  const existing = Store.listAssets().find((a) => a.from_post === shortcode && a.kind !== "audio");
  if (existing) return existing;
  const p = Store.getPost(shortcode);
  if (!p) return null;
  const media = p.media.find((m) => m.kind === "video") || p.media[0];
  const { job_id } = await post("/api/assets/from-vault", {
    shortcode, filename: media.filename, mode: "media",
    name: `${p.owner || shortcode} · ${media.filename}`,
  });
  const [asset] = await watchAssetJob(job_id);
  return asset || null;
}

function trackFor(asset, preferredId) {
  const kind = asset.kind === "audio" ? "audio" : "video";
  const preferred = state.project.tracks.find((t) => t.id === preferredId && t.kind === kind && !t.locked);
  if (preferred) return preferred;
  const any = state.project.tracks.find((t) => t.kind === kind && !t.locked);
  if (any) return any;
  addTrack(kind);
  return state.project.tracks[state.project.tracks.length - 1];
}

/** Every new clip starts neutral. Track stamps are an explicit action, never an
 *  ambient default — otherwise one stray slider poisons every future clip. */
function neutralParams() {
  const d = TRACK_DEFAULTS();
  return {
    speed: d.speed, volume: dbToGain(d.volume_db),
    fade_in: d.fade_in, fade_out: d.fade_out,
    brightness: d.brightness, contrast: d.contrast, saturation: d.saturation,
    opacity: d.opacity, blend: d.blend,
    scale: 1, x: 0, y: 0, rotate: 0,
  };
}

function placeClip(asset, trackId, atSeconds) {
  const track = trackFor(asset, trackId);
  const length = asset.kind === "image" ? IMAGE_LEN : (asset.duration || IMAGE_LEN);
  const clip = {
    id: "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
    asset_id: asset.id,          // the original, never overwritten
    variants: [],                // what AI actions returned, if anything
    variant: null,               // null = play the original
    kind: asset.kind === "audio" ? "audio" : "video",
    name: asset.name || asset.id,
    in: 0,
    out: length,
    start: Math.max(0, snapTime(atSeconds)),
    params: neutralParams(),
    keyframes: {},
  };
  snapshot();
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  state.selectedClips.clear();
  state.selectedClips.add(clip.id);

  // a video that carries sound also lands on the paired audio track, linked
  if (clip.kind === "video" && asset.kind === "video" && asset.has_audio) {
    const mate = makeLinkedAudio(clip, track, asset);
    if (mate) state.selectedClips.add(mate.id);
  }

  commit();
  renderProps();
  return clip;
}

/* ---------- text clips ---------- */

const TEXT_DEFAULTS = () => ({
  size: 84, color: "#ffffff", align: "center", y: 0.5,
  box: true, box_color: "#000000", box_opacity: 0.45,
});

function addTitle(text = "Your text", atSeconds = null) {
  let track = tracksOf("text")[0];
  if (!track) { addTrack("text", true); track = tracksOf("text")[0]; }
  const start = Math.max(0, atSeconds ?? state.playhead);
  const clip = {
    id: "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
    kind: "text",
    name: text.slice(0, 24),
    text,
    in: 0,
    out: 3,
    start,
    params: { ...TEXT_DEFAULTS(), speed: 1, opacity: 1 },
    keyframes: {},
  };
  snapshot();
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  state.selectedClips.clear();
  state.selectedClips.add(clip.id);
  state.selectedTrack = null;
  commit();
  renderProps();
  return clip;
}

/** Draw a title onto the preview canvas, honouring transitions and opacity. */
function drawText(ctx, clip, cw, ch, t) {
  const p = keysOf(clip).length ? paramsAt(clip, t) : (clip.params || {});
  const trans = transitionAt(clip, t);
  const scale = cw / (state.project.canvas.w || 1080);
  const size = Math.max(8, (p.size ?? 84) * scale);
  const raw = String(clip.text || "");
  const lines = (p.case === "upper" ? raw.toUpperCase() : raw).split("\n");

  ctx.save();
  let alpha = clamp(p.opacity ?? 1, 0, 1);
  if (trans) {
    if (trans.type === "dissolve") alpha *= trans.p;
    else applyWipe(ctx, trans.type, trans.p, cw, ch);
  }
  // the arrival: a shift and a fade, both of which the render can reproduce
  const enter = entranceAt(clip, p, t);
  if (enter) alpha *= enter.alpha;
  ctx.globalAlpha = alpha;
  ctx.font = captionFont(size, p.font, p);
  ctx.textAlign = p.align || "center";
  ctx.textBaseline = "middle";

  const lineH = size * 1.25;
  // `x` is a nudge away from where the alignment puts the text — that is what
  // dragging a subtitle in the preview writes
  const x = (p.align === "left" ? cw * 0.08 : p.align === "right" ? cw * 0.92 : cw / 2)
    + (p.x || 0) * cw + (enter ? enter.dx * scale : 0);
  const yMid = ch * (p.y ?? 0.5) + (enter ? enter.dy * scale : 0);
  const top = yMid - ((lines.length - 1) * lineH) / 2;

  const lay = p.hl ? textLayout(clip, p) : null;
  if (lay) {
    drawWords(ctx, lay, p, t, alpha, cw / (state.project.canvas.w || 1080), size,
              enter ? { dx: enter.dx * scale, dy: enter.dy * scale } : null);
    ctx.restore();
    return true;
  }

  // a plate per line, not one around the block: ffmpeg draws each line on its own
  // and this is the only way the two stay identical
  if (p.box) {
    const padX = size * 0.4, padY = size * 0.22;
    ctx.globalAlpha = alpha * (p.box_opacity ?? 0.45);
    ctx.fillStyle = p.box_color || "#000000";
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width + padX * 2;
      const bx = p.align === "left" ? x - padX : p.align === "right" ? x - w + padX : x - w / 2;
      ctx.fillRect(bx, top + i * lineH - size / 2 - padY, w, size + padY * 2);
    });
    ctx.globalAlpha = alpha;
  }

  // the shadow belongs to whatever is painted first — the outline when there is
  // one, the letters themselves when there is not. Hanging it on the stroke
  // alone left every shadow invisible until an outline was switched on, while
  // the render drew it all along (measured: 5313 red pixels there, none here).
  applyShadow(ctx, p, scale);
  if (p.outline) {
    // the outline is drawn under the fill, twice as wide: half of a stroke sits
    // outside the glyph, which is what ffmpeg's borderw measures
    ctx.lineWidth = (p.outline || 0) * scale * 2;
    ctx.strokeStyle = p.outline_color || "#000000";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    lines.forEach((line, i) => ctx.strokeText(line, x, top + i * lineH));
    ctx.shadowColor = "transparent";
  }
  ctx.fillStyle = p.color || "#ffffff";
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineH));
  ctx.shadowColor = "transparent";
  ctx.restore();
  return true;
}

/** The drop shadow, drawn the way ffmpeg draws it: a hard copy, not a blur.
 *
 *  drawtext offsets the text and paints it again — there is no blur to be had,
 *  so the preview stopped pretending there was one. */
function applyShadow(ctx, p, scale) {
  if (!p.shadow) { ctx.shadowColor = "transparent"; return; }
  const off = (p.shadow_dist ?? 3) * scale;
  ctx.shadowColor = p.shadow_color || "#000000";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = off;
  ctx.shadowOffsetY = off;
}

/** A line drawn one word at a time, with the spoken one picked out.
 *
 *  Every position comes from the layout, in project pixels, scaled here for the
 *  preview and used as-is by the render — that is what keeps the highlight on
 *  the same glyphs in both. */
function drawWords(ctx, lay, p, t, alpha, scale, size, shift = null) {
  const hlColor = p.hl_color || "#ffe066";
  const mode = p.hl_mode || "color";
  const padX = size * 0.4, padY = size * 0.22;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  lay.forEach((line) => {
    const left = line.left * scale + (shift ? shift.dx : 0);
    const base = line.baseline * scale + (shift ? shift.dy : 0);
    if (p.box) {
      ctx.globalAlpha = alpha * (p.box_opacity ?? 0.45);
      ctx.fillStyle = p.box_color || "#000000";
      ctx.fillRect(left - padX, base - size * 0.72 - padY,
                   line.width * scale + padX * 2, size + padY * 2);
      ctx.globalAlpha = alpha;
    }
    line.words.forEach((w) => {
      const wx = left + w.off * scale;
      const on = hlActive(w, t);
      if (on && mode === "plate") {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hlColor;
        ctx.fillRect(wx - padX * 0.4, base - size * 0.72 - padY * 0.6,
                     w.width * scale + padX * 0.8, size + padY * 1.2);
      }
      const grown = on && mode === "grow";
      if (grown) ctx.font = captionFont(size * HL_GROW, p.font, p);
      // the grown word keeps its middle where the plain one had it
      const gx = grown ? wx - (w.width * scale * (HL_GROW - 1)) / 2 : wx;
      applyShadow(ctx, p, scale);
      if (p.outline) {
        ctx.lineWidth = (p.outline || 0) * scale * 2;
        ctx.strokeStyle = p.outline_color || "#000000";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(w.text, gx, base);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = on && mode !== "plate" ? hlColor : (p.color || "#ffffff");
      ctx.fillText(w.text, gx, base);
      ctx.shadowColor = "transparent";
      if (grown) ctx.font = captionFont(size, p.font, p);
    });
  });
}

/** Build the audio half of a linked pair and drop it on the paired track. */
function makeLinkedAudio(clip, videoTrack, asset) {
  const audioTrack = pairedTrack(videoTrack, true);
  if (!audioTrack) return null;
  const linkId = clip.link_id || ("l" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36));
  clip.link_id = linkId;
  const mate = {
    ...JSON.parse(JSON.stringify(clip)),
    id: "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    kind: "audio",
    name: (asset.name || clip.name) + " · audio",
    link_id: linkId,
  };
  audioTrack.clips.push(mate);
  audioTrack.clips.sort((a, b) => a.start - b.start);
  return mate;
}

function laneTime(lane, clientX) {
  const rect = lane.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / state.pps);
}

/** Drag payload read back on drop.
 *  dataTransfer alone is unreliable here: dragging a thumbnail makes Chromium
 *  start a native image drag whose text/plain is the image URL, so we keep our
 *  own copy and fall back to it. */
function readDragPayload(e) {
  const raw = e.dataTransfer.getData("application/x-vault") || e.dataTransfer.getData("text/plain");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.asset || parsed.shortcode)) return parsed;
  } catch { /* not ours */ }
  return state.dragPayload;
}

function setDragPayload(el, payload) {
  el.addEventListener("dragstart", (e) => {
    state.dragPayload = payload;
    const json = JSON.stringify(payload);
    try {
      e.dataTransfer.setData("application/x-vault", json);
      e.dataTransfer.setData("text/plain", json);
      e.dataTransfer.effectAllowed = "copy";
    } catch { /* payload still lives in state.dragPayload */ }
  });
  el.addEventListener("dragend", () => { state.dragPayload = null; });
}

async function dropPayload(payload, trackId, at) {
  if (!payload) return;
  const asset = payload.asset
    ? Store.data.assets[payload.asset]
    : await ensureVaultAsset(payload.shortcode);
  if (!asset) return;
  placeClip(asset, trackId, at);
}

function wireLane(lane) {
  lane.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    lane.classList.add("drop");
  });
  lane.addEventListener("dragleave", () => lane.classList.remove("drop"));
  lane.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    lane.classList.remove("drop");
    await dropPayload(readDragPayload(e), lane.dataset.track, laneTime(lane, e.clientX));
  });
  wireLanePointer(lane);
}

/** Dropping anywhere in a zone (gaps between rows, track heads) still works:
 *  the clip lands on the nearest lane of that zone. */
function wireZone(host, kind) {
  host.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  host.addEventListener("drop", async (e) => {
    e.preventDefault();
    const lanes = [...host.querySelectorAll(".tl-lane")];
    if (!lanes.length) {                       // no track of this kind yet — make one
      addTrack(kind);
      const payload = readDragPayload(e);
      const fresh = host.querySelector(".tl-lane");
      await dropPayload(payload, fresh?.dataset.track, fresh ? laneTime(fresh, e.clientX) : 0);
      return;
    }
    const nearest = lanes.reduce((best, lane) => {
      const r = lane.getBoundingClientRect();
      const d = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      return d < best.d ? { lane, d } : best;
    }, { lane: lanes[0], d: Infinity }).lane;
    await dropPayload(readDragPayload(e), nearest.dataset.track, laneTime(nearest, e.clientX));
  });
}

/* ---------- clip interaction ---------- */

/** Live-update a clip's box without re-rendering the timeline.
 *  Re-rendering mid-drag would replace the element under the cursor and the
 *  drag would die after the first move. */
function styleClip(el, clip) {
  if (!el) return;
  el.style.left = clip.start * state.pps + "px";
  el.style.width = clipLen(clip) * state.pps + "px";
  const strip = el.querySelector(".clip-strip");
  const asset = clipAsset(clip);
  if (strip && asset?.strip && asset.duration) {
    const full = asset.duration * state.pps / (clip.params?.speed || 1);
    strip.style.backgroundSize = `${full}px 100%`;
    strip.style.backgroundPosition = `${-clip.in * state.pps}px 0`;
  }
}

/** What sits under the cursor in this lane: a clip edge to trim, a body to move,
 *  or nothing. Edges win over bodies and the nearest edge wins over the rest, so
 *  two clips that touch never fight over the same pixel. */
function resolveTarget(track, lane, clientX) {
  const x = clientX - lane.getBoundingClientRect().left;
  const pps = state.pps;
  // Two touching clips share one pixel, so distance alone ties. The side the
  // cursor is on breaks it: left of the seam grabs the left clip's tail, right
  // of it grabs the next clip's head.
  const SIDE_PENALTY = 1.5;
  let best = null;
  const offer = (clip, mode, edgeX, onSide) => {
    const dist = Math.abs(x - edgeX);
    if (dist > EDGE_GRAB) return;
    const score = dist + (onSide ? 0 : SIDE_PENALTY);
    if (!best || score < best.score) best = { clip, mode, dist, score, at: edgeX };
  };
  track.clips.forEach((clip) => {
    const l = clip.start * pps;
    const r = (clip.start + clipLen(clip)) * pps;
    offer(clip, "left", l, x >= l);      // the clip lies to the right of its left edge
    offer(clip, "right", r, x <= r);     // …and to the left of its right edge
  });
  if (best) return best;
  // edges already had priority, so whatever is left inside a clip moves it —
  // on a very narrow clip that leftover may be a couple of pixels, or nothing.
  // Search backwards: later clips are drawn on top, so they take the click.
  for (let i = track.clips.length - 1; i >= 0; i--) {
    const clip = track.clips[i];
    const l = clip.start * pps;
    const r = (clip.start + clipLen(clip)) * pps;
    if (x >= l && x <= r) return { clip, mode: "move", dist: 0 };
  }
  return null;
}

function wireLanePointer(lane) {
  const track = () => state.project.tracks.find((t) => t.id === lane.dataset.track);

  // hover: cursor + a marker on the edge that will actually be grabbed
  lane.addEventListener("pointermove", (e) => {
    if (e.buttons) return;
    const t = track();
    if (!t || t.locked) return;
    const hit = resolveTarget(t, lane, e.clientX);
    const hint = lane.querySelector(".edge-hint");
    lane.style.cursor = !hit ? "" : hit.mode === "move" ? "grab" : "ew-resize";
    if (hint) {
      hint.classList.toggle("hidden", !hit || hit.mode === "move");
      if (hit && hit.mode !== "move") hint.style.left = hit.at - 1 + "px";
    }
    lane.querySelectorAll(".tl-clip").forEach((el) =>
      el.classList.toggle("edge-target", !!hit && hit.mode !== "move" && el.dataset.clip === hit.clip.id));
  });
  lane.addEventListener("pointerleave", () => {
    lane.querySelector(".edge-hint")?.classList.add("hidden");
    lane.querySelectorAll(".edge-target").forEach((el) => el.classList.remove("edge-target"));
  });

  lane.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // a pending cut mark takes the pointer before the clip underneath it does
    const markEl = e.target.closest?.(".cut-strip i");
    if (markEl) {
      e.preventDefault();
      e.stopPropagation();
      startMarkDrag(markEl, e);
      return;
    }
    const t = track();
    if (!t || t.locked) return;
    const hit = resolveTarget(t, lane, e.clientX);
    if (!hit) return;
    e.preventDefault();
    // clips have no pointer-events of their own, so the "empty space" handler on
    // the scroll area would otherwise clear the selection we just made
    e.stopPropagation();
    startClipDrag(hit, e);
  });

  lane.addEventListener("dblclick", (e) => {
    const markEl = e.target.closest?.(".cut-strip i");
    if (!markEl) return;
    e.preventDefault();
    e.stopPropagation();
    removeMark(markEl.dataset.mark, markEl.dataset.of);
  });

  lane.addEventListener("contextmenu", (e) => {
    const t = track();
    if (!t) return;
    const hit = resolveTarget(t, lane, e.clientX);
    if (!hit) return;
    e.preventDefault();
    if (!state.selectedClips.has(hit.clip.id)) selectClip(hit.clip.id, false);
    openClipMenu(hit.clip, t, e.clientX, e.clientY);
  });
}

function openClipMenu(clip, track, x, y) {
  document.querySelector(".ctx-menu")?.remove();
  const asset = clipAsset(clip) || {};
  const canExtract = clip.kind === "video" && asset.has_audio && !clip.link_id;
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.innerHTML = `
    ${clip.link_id ? `<button data-act="unlink">Unlink audio</button>` : ""}
    ${canExtract ? `<button data-act="extract">Extract audio</button>` : ""}
    ${clip.link_id ? `<button data-act="selectlink">Select the pair</button>` : ""}
    ${clip.link_id || canExtract ? `<div class="sep"></div>` : ""}
    <button data-act="split">Split at playhead</button>
    <button data-act="delete">Delete</button>
    <button data-act="ripple">Ripple delete</button>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", close, true); };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);

  menu.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const act = b.dataset.act;
    close();
    if (act === "unlink") {
      snapshot();
      const link = clip.link_id;
      allClips().forEach(({ clip: c }) => { if (c.link_id === link) delete c.link_id; });
      commit();
      renderProps();
    }
    if (act === "extract") {
      snapshot();
      const mate = makeLinkedAudio(clip, track, asset);
      commit();
      if (mate) { state.selectedClips.add(mate.id); renderTimeline(); }
      renderProps();
    }
    if (act === "selectlink") {
      state.selectedClips.clear();
      state.selectedClips.add(clip.id);
      partnersOf(clip).forEach(({ clip: p }) => state.selectedClips.add(p.id));
      renderTimeline();
      renderProps();
    }
    if (act === "split") splitAtPlayhead();
    if (act === "delete") deleteSelected(false);
    if (act === "ripple") deleteSelected(true);
  }));
}

function startClipDrag({ clip, mode }, e) {
  const id = clip.id;
  const found = findClip(id);
  if (!found) return;

  const additive = e.ctrlKey || e.shiftKey;
  const wasTrackSelection = !!state.selectedTrack;
  state.selectedTrack = null;
  if (!state.selectedClips.has(id)) selectClip(id, additive);
  else if (additive) selectClip(id, true);
  else if (wasTrackSelection) selectClip(id, false);   // leaving a whole-track selection

  const self = () => document.querySelector(`.tl-clip[data-clip="${id}"]`);
  const startX = e.clientX;
  const speed = clip.params?.speed || 1;
  const orig = { start: clip.start, in: clip.in, out: clip.out, len: clipLen(clip) };
  const still = isStill(clip);
  const asset = clipAsset(clip) || {};
  const maxOut = still ? Infinity : (asset.duration || Infinity);
  // clips that travel with this drag: the rest of the selection, plus every
  // linked partner (a video and its extracted audio always move together)
  const travelling = new Map();
  const addTravelling = (c) => { if (c.id !== id) travelling.set(c.id, c); };
  [...state.selectedClips].filter((x) => x !== id).forEach((x) => {
    const f = findClip(x);
    if (!f) return;
    addTravelling(f.clip);
    partnersOf(f.clip).forEach(({ clip: p }) => addTravelling(p));
  });
  const mates = partnersOf(clip).map(({ clip: p }) => p);
  mates.forEach(addTravelling);
  const others = [...travelling.values()]
    .map((c) => ({ c, start: c.start, el: document.querySelector(`.tl-clip[data-clip="${c.id}"]`) }));
  let moved = false;
  let targetTrack = found.track;                 // where the clip will land vertically
  const el = self();

  /** The lane under the pointer, if it can host this clip. */
  const laneUnder = (ev) => {
    const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".tl-lane");
    if (!lane) return null;
    const t = state.project.tracks.find((x) => x.id === lane.dataset.track);
    if (!t || t.locked || t.kind !== clip.kind) return null;
    return { lane, track: t };
  };

  const move = (ev) => {
    const dt = (ev.clientX - startX) / state.pps;
    if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
    if (!moved) { snapshot(); moved = true; el?.classList.add("dragging"); }

    // vertical: hop the clip into another track of the same kind
    if (mode === "move") {
      const under = laneUnder(ev);
      if (under && under.track !== targetTrack) {
        targetTrack = under.track;
        document.querySelectorAll(".tl-lane.drop-target").forEach((l) => l.classList.remove("drop-target"));
        if (targetTrack !== found.track) under.lane.classList.add("drop-target");
        const node = self();
        if (node) under.lane.appendChild(node);    // lanes share one coordinate system
      }
    }

    if (mode === "left") {
      const start = snapTime(orig.start + dt, [id]);
      if (still) {
        // a still has no source limit: the left edge just stretches it, floor is 0
        const end = orig.start + orig.len;
        const s = clamp(start, 0, end - 0.1);
        clip.start = s;
        clip.in = 0;
        clip.out = (end - s) * speed;
      } else {
        const shift = clamp(start - orig.start, -orig.in, orig.len - 0.1);
        clip.in = orig.in + shift * speed;
        clip.start = Math.max(0, orig.start + shift);
      }
    } else if (mode === "right") {
      const end = snapTime(orig.start + orig.len + dt, [id]);
      let len = Math.max(0.1, end - clip.start);
      if (!still) len = Math.min(len, (maxOut - clip.in) / speed);
      clip.out = clip.in + len * speed;
    } else {
      const target = snapTime(orig.start + dt, [id]);
      const delta = target - orig.start;
      clip.start = Math.max(0, target);
      others.forEach((o) => {
        o.c.start = Math.max(0, o.start + delta);
        styleClip(o.el, o.c);
      });
    }
    // a trim on one half of a linked pair mirrors onto the other half
    if (mode !== "move") {
      mates.forEach((m) => {
        m.start = clip.start;
        m.in = clip.in;
        m.out = clip.out;
        styleClip(document.querySelector(`.tl-clip[data-clip="${m.id}"]`), m);
      });
    }
    styleClip(self(), clip);
    $("tlDuration").textContent = mmss(projectDuration());
    // trimming is a decision about a frame, so show the frame being decided on:
    // the preview follows the edge under the pointer and comes back afterwards
    if (mode === "left" || mode === "right") {
      if (state.trimPeek == null) state.trimPeek = state.playhead;
      state.playhead = mode === "left" ? clip.start : clip.start + clipLen(clip) - 1e-3;
      $("playhead").style.left = headW() + state.playhead * state.pps + "px";
      renderPreview();
    }
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    self()?.classList.remove("dragging");
    document.querySelectorAll(".tl-lane.drop-target").forEach((l) => l.classList.remove("drop-target"));
    if (state.trimPeek != null) {          // the playhead was only lent to the edge
      state.playhead = state.trimPeek;
      state.trimPeek = null;
      $("playhead").style.left = headW() + state.playhead * state.pps + "px";
      renderPreview();
    }
    if (moved) {
      if (mode === "move" && targetTrack !== found.track) moveToTrack(clip, found.track, targetTrack, others);
      state.project.tracks.forEach((t) => t.clips.sort((a, b) => a.start - b.start));
      commit();
      renderProps();
      return;
    }
    // a plain click inside a bigger selection collapses it to just this clip
    if (!additive && state.selectedClips.size > 1) selectClip(id, false);
  };

  // listeners live on the window: the clip element may be re-rendered away
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Re-home a clip on another track. Linked partners follow onto the paired
 *  track (V2's sound belongs on A2), and the rest of the selection shifts by
 *  the same number of tracks where such a track exists. */
function moveToTrack(clip, fromTrack, toTrack, travelling) {
  const shift = pairIndex(toTrack) - pairIndex(fromTrack);
  const relocate = (c, from, to) => {
    if (!to || to === from || to.locked) return;
    from.clips = from.clips.filter((x) => x !== c);
    to.clips.push(c);
  };

  // a linked pair must land together: if the partner's destination is locked,
  // nothing moves at all instead of tearing the pair apart
  const mates = partnersOf(clip);
  if (mates.length) {
    const dest = pairedTrack(toTrack, true);
    if (dest?.locked) {
      state.status = `“${dest.name}” is locked — the pair stayed where it was`;
      return;
    }
  }

  relocate(clip, fromTrack, toTrack);

  // the linked half goes to the pair of the new track, made on the spot if needed
  mates.forEach(({ clip: mate, track: mateTrack }) => {
    const dest = pairedTrack(toTrack, true);
    relocate(mate, mateTrack, dest);
    // a silent destination is the classic "my audio disappeared" trap
    const anySolo = tracksOf("audio").some((t) => t.solo);
    if (dest && (dest.muted || (anySolo && !dest.solo))) {
      state.status = `Sound moved onto “${dest.name}”, which is ${dest.muted ? "muted" : "silenced by solo"}`;
    }
  });

  // everything else that was dragged along keeps its relative track offset
  (travelling || []).forEach(({ c }) => {
    if (c === clip) return;
    const home = allClips().find((x) => x.clip === c)?.track;
    if (!home || partnersOf(clip).some((p) => p.clip === c)) return;
    const list = tracksOf(home.kind);
    const dest = list[clamp(list.indexOf(home) + shift, 0, list.length - 1)];
    relocate(c, home, dest);
    partnersOf(c).forEach(({ clip: mate, track: mateTrack }) => {
      relocate(mate, mateTrack, pairedTrack(dest, true));
    });
  });
}

/* ---------- editing commands ---------- */

const newLinkId = () => "l" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

/** One cut across every clip that the moment falls inside. No snapshot, no
 *  commit — the caller decides how many cuts make up a single undo step. */
function cutAt(t, wanted) {
  if (!wanted.length) return [];
  // a linked pair is cut in one go, and each half stays a pair of its own
  const targets = new Map();
  wanted.forEach((x) => {
    targets.set(x.clip.id, x);
    partnersOf(x.clip).forEach((p) => targets.set(p.clip.id, p));
  });
  const newLinks = new Map();
  const made = [];

  [...targets.values()].forEach(({ clip, track }) => {
    const offset = (t - clip.start) * (clip.params?.speed || 1);
    const right = JSON.parse(JSON.stringify(clip));
    right.id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    right.in = clip.in + offset;
    right.start = t;
    clip.out = clip.in + offset;
    if (clip.link_id) {
      // several cuts inside one millisecond used to mint the same link id, which
      // silently glued unrelated pieces into one "pair" and cut them to pieces
      if (!newLinks.has(clip.link_id)) newLinks.set(clip.link_id, newLinkId());
      right.link_id = newLinks.get(clip.link_id);
    }
    track.clips.push(right);
    track.clips.sort((a, b) => a.start - b.start);
    made.push({ clip: right, track });
  });
  return made;
}

const cuttableAt = (t, only) => allClips().filter(({ clip, track }) =>
  !track.locked && t > clip.start + 0.05 && t < clip.start + clipLen(clip) - 0.05 &&
  (only ? only.has(clip.id) : true));

function splitAtPlayhead() {
  const t = state.playhead;
  const wanted = cuttableAt(t, state.selectedClips.size ? state.selectedClips : null);
  if (!wanted.length) return;
  snapshot();
  cutAt(t, wanted);
  commit();
}

function deleteSelected(ripple) {
  if (!state.selectedClips.size) return;
  const doomed = new Set(state.selectedClips);
  state.selectedClips.forEach((id) => {
    const f = findClip(id);
    if (f) partnersOf(f.clip).forEach(({ clip: p }) => doomed.add(p.id));
  });
  snapshot();
  state.project.tracks.forEach((track) => {
    const removed = track.clips.filter((c) => doomed.has(c.id));
    if (!removed.length) return;
    track.clips = track.clips.filter((c) => !doomed.has(c.id));
    if (!ripple) return;
    // measured against where everything stood before the delete, for the same
    // reason as in applySilence: a shifted clip no longer matches a stale start
    const holes = removed.map((r) => ({ at: r.start, len: clipLen(r) }));
    track.clips.forEach((c) => { c.start = Math.max(0, c.start - holeShift(holes, c.start)); });
  });
  state.selectedClips.clear();
  // a deleted clip's player has nothing left to play: keeping it in the pool
  // leaves it decoding in the background and holding the file open
  doomed.forEach((id) => {
    const el = pool.get(id);
    if (!el) return;
    try { el.pause?.(); el.removeAttribute?.("src"); el.load?.(); } catch { /* an image */ }
    pool.delete(id);
  });
  commit();
  renderProps();
}

/* ---------- tracks, playhead, zoom ---------- */

function addTrack(kind, silent = false) {
  const n = tracksOf(kind).length + 1;
  state.project.tracks.push({
    id: (kind === "video" ? "v" : kind === "text" ? "x" : "a") + Date.now().toString(36) + n,
    kind, name: Store.trackNameFor(kind, n - 1),
    muted: false, hidden: false, locked: false, clips: [],
  });
  if (silent) return;
  Store.touchProject(state.project);
  renderTimeline();
}

/* ---------- zoom, navigation, clipboard ---------- */

function setZoom(pps) {
  state.pps = clamp(pps, 2, 240);
  $("tlZoom").value = Math.round(state.pps);
  renderTimeline();
}

/** Fit the whole project into the visible part of the timeline. */
function zoomToFit() {
  const width = $("tlScroll").clientWidth - headW() - 40;
  const dur = Math.max(projectDuration(), 1);
  setZoom(width / dur);
  $("tlScroll").scrollLeft = 0;
  state.status = `Zoom to fit · ${mmss(projectDuration())}`;
}

/** Every edge on the timeline, used by ↑ / ↓ to hop the playhead. */
function snapPoints() {
  const marks = new Set([0]);
  allClips().forEach(({ clip }) => {
    marks.add(+clip.start.toFixed(4));
    marks.add(+(clip.start + clipLen(clip)).toFixed(4));
  });
  return [...marks].sort((a, b) => a - b);
}

function jumpSnap(dir) {
  const pts = snapPoints();
  const t = state.playhead;
  const next = dir > 0 ? pts.find((p) => p > t + 1e-4) : [...pts].reverse().find((p) => p < t - 1e-4);
  movePlayhead(next ?? (dir > 0 ? projectDuration() : 0));
}

function copySelection(cut) {
  const entries = [...state.selectedClips].map((id) => findClip(id)).filter(Boolean);
  if (!entries.length) return;
  // partners come along so a linked pair survives the round trip
  const all = new Map();
  entries.forEach(({ clip, track }) => {
    all.set(clip.id, { clip, track });
    partnersOf(clip).forEach((p) => all.set(p.clip.id, p));
  });
  const items = [...all.values()];
  const base = Math.min(...items.map(({ clip }) => clip.start));
  state.clipboard = items.map(({ clip, track }) => ({
    clip: JSON.parse(JSON.stringify(clip)),
    kind: track.kind,
    index: pairIndex(track),
    offset: clip.start - base,
  }));
  state.status = `${cut ? "Cut" : "Copied"} ${items.length} clip(s)`;
  if (cut) deleteSelected(false);
  else renderProps();
}

function pasteClipboard() {
  if (!state.clipboard?.length) return;
  snapshot();
  const links = new Map();
  const fresh = [];
  state.clipboard.forEach(({ clip, kind, index, offset }) => {
    const list = tracksOf(kind);
    while (tracksOf(kind).length <= index) addTrack(kind, true);
    const track = tracksOf(kind)[Math.min(index, tracksOf(kind).length - 1)] || list[0];
    const copy = JSON.parse(JSON.stringify(clip));
    copy.id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
    copy.start = state.playhead + offset;
    if (clip.link_id) {
      if (!links.has(clip.link_id)) links.set(clip.link_id, newLinkId());
      copy.link_id = links.get(clip.link_id);
    }
    track.clips.push(copy);
    fresh.push(copy.id);
  });
  state.selectedClips = new Set(fresh);
  state.selectedTrack = null;
  state.status = `Pasted ${fresh.length} clip(s) at ${state.playhead.toFixed(2)}s`;
  commit();
  renderProps();
}

/** Move the playhead without rebuilding the timeline — a full re-render per
 *  mouse move is what made the playhead feel stuck. */
function movePlayhead(t) {
  state.playhead = Math.max(0, t);
  $("playhead").style.left = headW() + state.playhead * state.pps + "px";
  $("pvTime").textContent = `${state.playhead.toFixed(1)}s / ${mmss(projectDuration())}`;
  renderPreview();
}

function scrubFrom(e) {
  const rect = $("tlRuler").getBoundingClientRect();
  movePlayhead((e.clientX - rect.left - headW()) / state.pps);
}

$("tlRuler").addEventListener("pointerdown", (e) => {
  if (e.target.closest(".tl-corner")) return;      // the layout picker lives there
  state.scrubbing = true;
  scrubFrom(e);
  const move = (ev) => scrubFrom(ev);
  const up = () => {
    $("tlRuler").removeEventListener("pointermove", move);
    $("tlRuler").removeEventListener("pointerup", up);
    state.scrubbing = false;
    renderTimeline();                               // one full redraw at the end
    renderPreview();                                // back to full quality on release
  };
  try { $("tlRuler").setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  $("tlRuler").addEventListener("pointermove", move);
  $("tlRuler").addEventListener("pointerup", up);
});

$("tlAddVideo").addEventListener("click", () => addTrack("video"));
$("tlAddAudio").addEventListener("click", () => addTrack("audio"));
$("tlAddText").addEventListener("click", () => addTrack("text"));
$("tlAddTitle").addEventListener("click", () => {
  const text = prompt("Title text", "Your text");
  if (text != null && text.trim()) addTitle(text.trim());
});
$("tlZoom").addEventListener("input", (e) => { state.pps = Number(e.target.value); renderTimeline(); });
$("tlFit").addEventListener("click", zoomToFit);
$("tlSnap").addEventListener("click", () => { state.snap = !state.snap; renderTimeline(); });
$("tlSplit").addEventListener("click", splitAtPlayhead);
$("tlUndo").addEventListener("click", undo);
$("tlRedo").addEventListener("click", redo);

/* clicking empty timeline space clears the selection */
/* ---------- picking several clips with a rectangle ----------
 * Like dragging a box over icons on a desktop. A clip counts as caught only when
 * the box touches its **middle third** — brushing an edge while reaching for
 * something else should not drag half the timeline into the selection.
 */
function clipMiddleBox(el, scroll) {
  const box = el.getBoundingClientRect();
  const third = box.width / 3;
  return { left: box.left + third, right: box.right - third, top: box.top, bottom: box.bottom };
}

function startBoxSelect(e) {
  const scroll = $("tlScroll");
  const marquee = document.createElement("div");
  marquee.className = "marquee";
  scroll.appendChild(marquee);
  const from = { x: e.clientX, y: e.clientY };
  const additive = e.ctrlKey || e.shiftKey;
  const before = new Set(state.selectedClips);
  let moved = false;

  const shape = (ev) => ({
    left: Math.min(from.x, ev.clientX), right: Math.max(from.x, ev.clientX),
    top: Math.min(from.y, ev.clientY), bottom: Math.max(from.y, ev.clientY),
  });

  const move = (ev) => {
    const r = shape(ev);
    if (!moved && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 4) return;
    moved = true;
    const host = scroll.getBoundingClientRect();
    marquee.style.left = (r.left - host.left + scroll.scrollLeft) + "px";
    marquee.style.top = (r.top - host.top + scroll.scrollTop) + "px";
    marquee.style.width = (r.right - r.left) + "px";
    marquee.style.height = (r.bottom - r.top) + "px";

    const caught = new Set(additive ? before : []);
    scroll.querySelectorAll(".tl-clip").forEach((el) => {
      const m = clipMiddleBox(el, scroll);
      if (m.right >= r.left && m.left <= r.right && m.bottom >= r.top && m.top <= r.bottom) {
        caught.add(el.dataset.clip);
      }
    });
    // repaint the outlines without rebuilding the timeline mid-drag
    scroll.querySelectorAll(".tl-clip").forEach((el) =>
      el.classList.toggle("selected", caught.has(el.dataset.clip)));
    state.selectedClips = caught;
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    marquee.remove();
    if (!moved) {
      if (!additive && state.selectedClips.size) selectClip(null, false);
      return;
    }
    state.selectedTrack = null;
    state.status = state.selectedClips.size
      ? `${state.selectedClips.size} clip(s) selected` : "Selection cleared";
    renderTimeline();
    renderProps();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

$("tlScroll").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".tl-clip") || e.target.closest(".tl-head") || e.target.closest(".tl-ruler")) return;
  e.preventDefault();
  startBoxSelect(e);
});

/* ---------- preview ---------- */

// scale drives the canvas only; the source file is chosen once by useProxySource()
const QUALITY = {
  auto: { scale: 1, effects: true },      // recalculated while playing
  full: { scale: 1, effects: true },
  high: { scale: 0.666, effects: true },
  medium: { scale: 0.5, effects: true },
  draft: { scale: 0.25, effects: false }, // skip colour work, just get frames out
};

/** Auto drops to 540p while the timeline is moving and returns to full on pause. */
function quality() {
  const chosen = Store.settings.preview_quality || "auto";
  if (chosen !== "auto") return QUALITY[chosen] || QUALITY.full;
  return state.playing || state.scrubbing ? QUALITY.medium : QUALITY.full;
}

/* ---------- media pool ---------- */

const pool = new Map();            // clip.id -> HTMLMediaElement / HTMLImageElement

function assetUrl(asset, useProxy) {
  if (!asset) return null;
  const proxy = asset.proxy ? `/assets/${asset.proxy}` : null;
  const own = asset.src ? `/assets/${asset.src}`
    : asset.media_url ? `/media/${asset.media_url}` : null;
  // The proxy is a lighter copy for smooth scrubbing, never a stand-in for a
  // file that is gone: showing it would quietly promise footage that cannot be
  // rendered. A missing original is said out loud instead.
  if (asset.missing) return null;
  if (useProxy && proxy) return proxy;
  return own || (asset.poster ? `/assets/${asset.poster}` : null);
}

/** Which file a clip plays from. This must NOT follow Auto's live quality
 *  switching: swapping src mid-session restarts the decoder and blanks the
 *  picture. Only an explicit "Full" keeps the untouched original. */
const useProxySource = () => (Store.settings.preview_quality || "auto") !== "full";

function mediaFor(clip) {
  if (clip.kind === "text") return null;          // titles are drawn, not played
  const asset = clipAsset(clip);
  if (!asset) return null;
  const url = assetUrl(asset, useProxySource());
  if (!url) return null;

  let el = pool.get(clip.id);
  // switching variants can swap a video for a still — the pooled element type
  // has to follow, or the picture silently stops arriving
  if (el && el.dataset?.kind && el.dataset.kind !== asset.kind) {
    try { el.pause?.(); el.src = ""; } catch { /* image */ }
    pool.delete(clip.id);
    el = null;
  }
  if (!el) {
    if (asset.kind === "image") {
      el = new Image();
      el.onload = scheduleFrame;
    } else {
      el = document.createElement(clip.kind === "audio" ? "audio" : "video");
      el.preload = "auto";
      el.muted = clip.kind !== "audio";   // sound comes from audio clips only
      el.playsInline = true;
      el.crossOrigin = "anonymous";
      if (clip.kind !== "audio") el.addEventListener("loadeddata", scheduleFrame);
      // the flags from disk can be a moment behind; a file answering 404 is the
      // plainest evidence there is, so the asset is marked and the frame redrawn
      // to say so rather than staying black
      el.addEventListener("error", () => {
        const a = clipAsset(clip);
        if (a && !a.missing) Store.upsertAsset({ ...a, missing: true });
        scheduleFrame();
      });
    }
    if (el.dataset) el.dataset.kind = asset.kind;
    pool.set(clip.id, el);
  }
  if (el.dataset?.url !== url) {
    el.src = url;
    if (el.dataset) el.dataset.url = url;
  }
  return el;
}

function releasePool() {
  pool.forEach((el) => { try { el.pause?.(); el.src = ""; } catch { /* image */ } });
  pool.clear();
}

/* ---------- what plays at a given moment ---------- */

const clipAt = (track, t) => track.clips.find((c) => t >= c.start && t < c.start + clipLen(c) - 1e-4);
const sourceTime = (clip, t) => clip.in + (t - clip.start) * (clip.params?.speed || 1);

/** Only what the playhead actually touches — never the whole project.
 *  Loading and seeking every clip is what made scrubbing feel stuck. */
function activeAt(t, lookahead = 0.8) {
  const out = [];
  state.project.tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      const end = clip.start + clipLen(clip);
      if (t >= clip.start - lookahead && t < end) out.push({ clip, track, live: t >= clip.start });
    });
  });
  return out;
}

/** Fade envelope + track flags folded into one gain. */
function gainAt(clip, track, t) {
  const anySolo = tracksOf("audio").some((x) => x.solo);
  if (track.muted || (anySolo && !track.solo)) return 0;
  let g = hasKeys(clip, "volume") ? paramAt(clip, "volume", t - clip.start) : (clip.params?.volume ?? 1);
  const len = clipLen(clip);
  const into = t - clip.start;
  const fi = clip.params?.fade_in || 0;
  const fo = clip.params?.fade_out || 0;
  if (fi > 0 && into < fi) g *= into / fi;
  if (fo > 0 && into > len - fo) g *= Math.max(0, (len - into) / fo);
  return clamp(g, 0, 1);
}

/* ---------- compositing ---------- */

function setupCanvas() {
  const { w, h } = state.project.canvas;
  const q = quality();
  const canvas = $("pvCanvas");
  const cw = Math.max(2, Math.round(w * q.scale));
  const ch = Math.max(2, Math.round(h * q.scale));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  fitCanvasToStage(canvas, w / h);
  $("pvRes").textContent = `${cw}×${ch}`;
  return canvas;
}

/** Give the canvas a CSS size that always fits the pane, whatever the layout does. */
function fitCanvasToStage(canvas, aspect) {
  const stage = $("pvStage");
  if (!stage) return;
  const box = stage.getBoundingClientRect();
  const availW = Math.max(20, box.width - 16);
  const availH = Math.max(20, box.height - 16);
  let dw = availW;
  let dh = dw / aspect;
  if (dh > availH) { dh = availH; dw = dh * aspect; }
  canvas.style.width = Math.floor(dw) + "px";
  canvas.style.height = Math.floor(dh) + "px";
}

window.addEventListener("resize", () => { if (document.body.dataset.view === "editor") scheduleFrame(); });

/* ---------- transitions ---------- */

const TRANSITIONS = ["none", "dissolve", "wipe-left", "wipe-right", "wipe-up", "wipe-down"];

/** How far into a transition we are at `t`: 1 means fully in, null means none. */
function transitionAt(clip, t) {
  const len = clipLen(clip);
  const tin = clip.transition_in;
  const tout = clip.transition_out;
  if (tin?.type && tin.type !== "none" && tin.dur > 0) {
    const p = (t - clip.start) / tin.dur;
    if (p < 1) return { type: tin.type, p: clamp(p, 0, 1), edge: "in" };
  }
  if (tout?.type && tout.type !== "none" && tout.dur > 0) {
    const p = (clip.start + len - t) / tout.dur;
    if (p < 1) return { type: tout.type, p: clamp(p, 0, 1), edge: "out" };
  }
  return null;
}

/** Clip the canvas to the part a wipe has already revealed. */
function applyWipe(ctx, type, p, cw, ch) {
  ctx.beginPath();
  if (type === "wipe-left") ctx.rect(0, 0, cw * p, ch);
  else if (type === "wipe-right") ctx.rect(cw * (1 - p), 0, cw * p, ch);
  else if (type === "wipe-up") ctx.rect(0, 0, cw, ch * p);
  else if (type === "wipe-down") ctx.rect(0, ch * (1 - p), cw, ch * p);
  else ctx.rect(0, 0, cw, ch);
  ctx.clip();
}

/** The SVG filter set to exactly what ffmpeg's eq would do:
 *  out = (in − 0.5)·contrast + 0.5 + brightness, then saturation. */
function colourFilter(bri, con, sat) {
  const intercept = 0.5 - 0.5 * con + bri;
  ["R", "G", "B"].forEach((ch) => {
    const f = $(`pvFunc${ch}`);
    f.setAttribute("slope", con);
    f.setAttribute("intercept", intercept);
  });
  $("pvFxSat").setAttribute("values", sat);
  return "url(#pvFx)";
}

function drawSource(ctx, el, clip, cw, ch, t) {
  const natW = el.videoWidth || el.naturalWidth || 0;
  const natH = el.videoHeight || el.naturalHeight || 0;
  if (!natW || !natH) return false;
  const p = keysOf(clip).length ? paramsAt(clip, t) : (clip.params || {});
  // fit the whole frame inside the canvas — nothing gets cropped away; zoom in
  // deliberately with the Zoom parameter if you want it to fill
  const fit = Math.min(cw / natW, ch / natH) * (p.scale || 1);
  const dw = natW * fit;
  const dh = natH * fit;

  ctx.save();
  const trans = transitionAt(clip, t);
  let alpha = clamp(p.opacity ?? 1, 0, 1);
  if (trans) {
    if (trans.type === "dissolve") alpha *= trans.p;
    else applyWipe(ctx, trans.type, trans.p, cw, ch);
  }
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = !p.blend || p.blend === "normal" ? "source-over" : p.blend;
  // ctx.filter is the most expensive call in the whole composite — only pay for
  // it when the clip actually asks for colour work
  const neutral = !(p.brightness || 0) && (p.contrast ?? 1) === 1 && (p.saturation ?? 1) === 1;
  if (quality().effects && !neutral) {
    ctx.filter = colourFilter(p.brightness || 0, p.contrast ?? 1, p.saturation ?? 1);
  }
  ctx.translate(cw / 2 + (p.x || 0) * cw, ch / 2 + (p.y || 0) * ch);
  if (p.rotate) ctx.rotate((p.rotate * Math.PI) / 180);
  try { ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh); } catch { /* not decodable yet */ }
  ctx.restore();
  return true;
}

/* Normally the preview shows the playhead. While a cut mark is being dragged it
 * shows that mark instead, so you see the frame you are about to cut on — the
 * playhead itself never moves. */
const previewTime = () => (state.previewAt ?? state.playhead);

/* ---------- dragging a subtitle in the preview ---------- */

/** The box a line occupies on the canvas, in canvas pixels. */
function textBounds(clip, cw, ch) {
  const p = clip.params || {};
  const scale = cw / (state.project.canvas.w || 1080);
  const size = Math.max(8, (p.size ?? 84) * scale);
  const raw = String(clip.text || "");
  const lines = (p.case === "upper" ? raw.toUpperCase() : raw).split("\n");
  _ruler.font = captionFont(size, p.font, p);
  const widest = Math.max(...lines.map((l) => _ruler.measureText(l).width));
  const lineH = size * 1.25;
  const x = (p.align === "left" ? cw * 0.08 : p.align === "right" ? cw * 0.92 : cw / 2)
    + (p.x || 0) * cw;
  const top = ch * (p.y ?? 0.5) - ((lines.length - 1) * lineH) / 2;
  const left = p.align === "left" ? x : p.align === "right" ? x - widest : x - widest / 2;
  return { left, top: top - size * 0.7, width: widest, height: lines.length * lineH + size * 0.4 };
}

/** Which subtitle the pointer is on, if any — topmost text track wins. */
function textUnderPointer(cx, cy) {
  const t = previewTime();
  const canvas = $("pvCanvas");
  const cw = canvas.width, ch = canvas.height;
  const hits = [];
  tracksOf("text").forEach((track) => {
    if (track.hidden) return;
    track.clips.forEach((clip) => {
      if (t < clip.start || t >= clip.start + clipLen(clip) - 1e-4) return;
      const b = textBounds(clip, cw, ch);
      if (cx >= b.left - 8 && cx <= b.left + b.width + 8 && cy >= b.top && cy <= b.top + b.height) {
        hits.push({ clip, track });
      }
    });
  });
  return hits[hits.length - 1] || null;
}

/** Canvas coordinates from a pointer event over the preview. */
function canvasPoint(e) {
  const canvas = $("pvCanvas");
  const box = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - box.left) * (canvas.width / box.width),
    y: (e.clientY - box.top) * (canvas.height / box.height),
  };
}

function startSubtitleDrag(hit, e) {
  const { clip, track } = hit;
  const canvas = $("pvCanvas");
  const cw = canvas.width, ch = canvas.height;
  const from = canvasPoint(e);
  const x0 = clip.params.x || 0;
  const y0 = clip.params.y ?? 0.5;
  let moved = false;

  const move = (ev) => {
    const at = canvasPoint(ev);
    if (!moved && Math.hypot(at.x - from.x, at.y - from.y) < 3) return;
    if (!moved) { snapshot(); moved = true; }
    clip.params.x = +(x0 + (at.x - from.x) / cw).toFixed(4);
    clip.params.y = +clamp(y0 + (at.y - from.y) / ch, 0.03, 0.97).toFixed(4);
    // only this one is redrawn while the pointer is down; the rest catch up later
    scheduleFrame();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    canvas.classList.remove("grabbing");
    if (!moved) return;
    const whole = state.selectedTrack === track.id;
    if (whole) {
      const same = Store.settings.sub_move_same !== false;
      const dx = clip.params.x - x0, dy = clip.params.y - y0;
      track.clips.forEach((c) => {
        if (c === clip) return;
        c.params.x = same ? clip.params.x : +((c.params.x || 0) + dx).toFixed(4);
        c.params.y = same ? clip.params.y : +clamp((c.params.y ?? 0.5) + dy, 0.03, 0.97).toFixed(4);
      });
    }
    commit();
    state.status = whole
      ? `Moved ${track.clips.length} subtitle(s)`
      : `Moved “${(clip.raw || clip.text || "").slice(0, 20)}”`;
    renderProps();
  };
  canvas.classList.add("grabbing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

$("pvCanvas").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || state.playing) return;
  const at = canvasPoint(e);
  const hit = textUnderPointer(at.x, at.y);
  if (!hit) return;
  e.preventDefault();
  startSubtitleDrag(hit, e);
});

$("pvCanvas").addEventListener("pointermove", (e) => {
  if (state.playing) return;
  const at = canvasPoint(e);
  $("pvCanvas").classList.toggle("over-text", !!textUnderPointer(at.x, at.y));
});

function renderFrame() {
  const canvas = setupCanvas();
  const ctx = canvas.getContext("2d");
  const cw = canvas.width, ch = canvas.height;
  const t = previewTime();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  let drawn = 0;
  // V1 sits at the sash and is the bottom layer; higher tracks paint over it
  tracksOf("video").forEach((track) => {
    if (track.hidden) return;
    // overlapping clips are all drawn, later ones on top — that is what turns a
    // fade-in into a real cross-dissolve when two clips overlap
    track.clips.forEach((clip) => {
      if (t < clip.start || t >= clip.start + clipLen(clip) - 1e-4) return;
      const el = mediaFor(clip);
      if (!el) return;
      if (drawSource(ctx, el, clip, cw, ch, t)) drawn++;
    });
  });

  // titles sit above every picture layer
  tracksOf("text").forEach((track) => {
    if (track.hidden) return;
    track.clips.forEach((clip) => {
      if (t < clip.start || t >= clip.start + clipLen(clip) - 1e-4) return;
      if (drawText(ctx, clip, cw, ch, t)) drawn++;
    });
  });

  // there is a difference between an empty moment and a clip whose file is gone,
  // and the second one used to look exactly like the first
  const broken = drawn ? [] : activeAt(t)
    .filter(({ clip }) => clip.kind !== "audio")
    .filter(({ clip }) => !clipAsset(clip) || clipAsset(clip).missing || pool.get(clip.id)?.error);
  $("pvGone").classList.toggle("hidden", !broken.length);
  if (broken.length) {
    state.goneClip = broken[0].clip.id;
    $("pvGoneName").textContent = broken[0].clip.name || "this clip";
  } else if (!drawn) {
    ctx.fillStyle = "#39405260";
    ctx.textAlign = "center";
    ctx.font = `${Math.round(ch / 40)}px "Segoe UI", sans-serif`;
    ctx.fillText(projectDuration() ? "no clip at the playhead" : "drop a clip on the timeline",
      cw / 2, ch / 2);
  }
  $("pvTime").textContent = `${t.toFixed(1)}s / ${mmss(projectDuration())}`;
}

/** Park the clips under the playhead on the right frame (scrub / paused state). */
function seekActive() {
  const t = previewTime();
  const live = new Set();
  activeAt(t).forEach(({ clip }) => {
    live.add(clip.id);
    const el = mediaFor(clip);
    if (!el || !el.pause) return;
    if (!el.paused) el.pause();
    const want = sourceTime(clip, t);
    if (Number.isFinite(want) && want >= 0 && Math.abs((el.currentTime || 0) - want) > 0.04) {
      el.onseeked = () => { el.onseeked = null; scheduleFrame(); };
      try { el.currentTime = want; } catch { /* not seekable yet */ }
    }
  });
  pool.forEach((el, id) => { if (!live.has(id) && el.pause && !el.paused) el.pause(); });
}

/** Coalesce redraws: many scrub events collapse into one frame.
 *
 *  The flag has to be cleared by whichever of the two fires first. A window that
 *  is hidden, minimised or merely covered gets no animation frames at all
 *  (measured: rAF never ran while the pane was not composited) — and since the
 *  flag used to be cleared only inside that callback, one missed frame latched
 *  it on for good and every later redraw was dropped in silence. The timer is
 *  the way out: a frame that the browser will not schedule is painted anyway. */
function scheduleFrame() {
  if (state.frameQueued) return;
  state.frameQueued = true;
  const paint = () => {
    if (!state.frameQueued) return;              // the other one got there first
    state.frameQueued = false;
    clearTimeout(state.frameTimer);
    renderFrame();
  };
  requestAnimationFrame(paint);
  state.frameTimer = setTimeout(paint, 120);
}

function renderPreview() {
  scheduleFrame();
  if (!state.playing) seekActive();
}

/* ---------- playback ---------- */

function syncPlayback() {
  const t = state.playhead;
  const live = new Set();
  // touch only the clips around the playhead; the next one gets pre-rolled
  activeAt(t).forEach(({ clip, track, live: playing }) => {
    const el = mediaFor(clip);
    if (!el || !el.play) return;
    live.add(clip.id);
    const want = sourceTime(clip, t);
    const speed = clip.params?.speed || 1;

    if (!playing) {                                  // upcoming: park it, don't play yet
      if (!el.paused) el.pause();
      if (Math.abs((el.currentTime || 0) - clip.in) > 0.2) {
        try { el.currentTime = clip.in; } catch { /* not ready */ }
      }
      return;
    }
    if (el.playbackRate !== speed) { try { el.playbackRate = speed; } catch { /* out of range */ } }
    if (track.kind === "audio") {
      const g = gainAt(clip, track, t);
      if (Math.abs(el.volume - g) > 0.01) el.volume = g;
    }
    if (el.paused) {
      try { el.currentTime = want; } catch { /* not ready */ }
      el.play().catch(() => { /* autoplay guard */ });
    } else if (Math.abs(el.currentTime - want) > 0.25) {
      // only a real drift is worth a seek: seeking mid-playback is what stutters
      try { el.currentTime = want; } catch { /* seeking */ }
    }
  });
  pool.forEach((el, id) => { if (!live.has(id) && el.pause && !el.paused) el.pause(); });
}

function playPause() {
  state.playing ? stopPlayback() : startPlayback();
}

function startPlayback() {
  if (state.playing) return;
  const total = projectDuration();
  if (!total) return;
  if (state.libAudio) { stopLibAudio(); renderLibrary(); }   // never two sounds at once
  if (state.playhead >= total - 0.05) state.playhead = 0;
  state.playing = true;
  $("pvPlay").textContent = "⏸";
  let last = performance.now();
  let frames = 0, fpsAt = last, lastRender = 0;
  // the clock runs on every rAF, but compositing is capped at the project's fps:
  // repainting 165 times a second is what made playback stutter
  const frameMs = 1000 / (state.project.canvas.fps || 30);

  const tick = (now) => {
    if (!state.playing) return;
    state.playhead += (now - last) / 1000;
    last = now;
    if (state.playhead >= total) { state.playhead = total; stopPlayback(); return; }

    if (now - lastRender >= frameMs) {
      lastRender = now;
      syncPlayback();
      renderFrame();
      $("playhead").style.left = headW() + state.playhead * state.pps + "px";
      frames++;
      if (now - fpsAt >= 1000) {
        $("pvFps").textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps`;
        frames = 0;
        fpsAt = now;
      }
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(state.raf);
  $("pvPlay").textContent = "▶";
  $("pvFps").textContent = "– fps";
  pool.forEach((el) => { if (el.pause && !el.paused) el.pause(); });
  renderTimeline();
  seekActive();
  renderFrame();      // straight away, so Auto shows the full-resolution frame again
}

$("pvPlay").addEventListener("click", playPause);

/* ---------- render ---------- */

/** The project as the render should see it: word boxes measured here.
 *
 *  Only the canvas can measure text, so a line that wants its spoken word picked
 *  out travels with the answer attached — the render places words instead of
 *  laying them out. */
function withTextLayout(project) {
  const copy = JSON.parse(JSON.stringify(project));
  copy.tracks.forEach((track) => {
    if (track.kind !== "text") return;
    track.clips.forEach((clip) => {
      if (!clip.params?.hl) return;
      const lay = textLayout(clip, clip.params);
      if (lay) clip.layout = lay;
    });
  });
  return copy;
}

async function startRender() {
  if (!projectDuration()) { alert("The timeline is empty — nothing to render."); return; }
  stopPlayback();
  $("btnRender").disabled = true;
  $("renderBar").classList.remove("hidden");
  $("renderReveal").classList.add("hidden");
  $("renderClose").classList.add("hidden");
  $("renderMark").innerHTML = '<span class="spinner"></span>';
  $("renderStage").textContent = "Preparing…";
  $("renderProgress").style.width = "0%";

  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $("renderTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);

  let jobId;
  try {
    ({ job_id: jobId } = await post("/api/render", { project: withTextLayout(state.project) }));
  } catch (e) {
    clearInterval(timer);
    $("btnRender").disabled = false;
    $("renderMark").innerHTML = '<span class="dot-err">✕</span>';
    $("renderStage").textContent = e.message;
    $("renderClose").classList.remove("hidden");
    return;
  }

  const tick = async () => {
    const job = await api(`/api/jobs/${jobId}`);
    const item = job.items[0];
    $("renderStage").textContent = item.stage || "Rendering…";
    if (item.pct != null) $("renderProgress").style.width = `${Math.round(item.pct * 100)}%`;
    if (!job.done) return;

    clearInterval(poll);
    clearInterval(timer);
    $("btnRender").disabled = false;
    $("renderClose").classList.remove("hidden");
    if (item.status === "error") {
      $("renderMark").innerHTML = '<span class="dot-err">✕</span>';
      return;
    }
    const rec = item.record || {};
    $("renderMark").innerHTML = '<span class="dot-ok">✓</span>';
    $("renderProgress").style.width = "100%";
    $("renderStage").textContent =
      `${rec.file} · ${(rec.size / 1e6).toFixed(1)} MB · ${rec.duration}s`
      + (rec.notes?.length ? ` · ${rec.notes.join("; ")}` : "");
    $("renderReveal").classList.remove("hidden");
    state.lastRender = rec;
  };
  const poll = setInterval(tick, 500);
  tick();
}

$("btnRender").addEventListener("click", startRender);
$("renderReveal").addEventListener("click", () => post("/api/reveal", { renders: true }));
$("renderClose").addEventListener("click", () => $("renderBar").classList.add("hidden"));

$("pvQuality").addEventListener("change", (e) => {
  Store.setSetting("preview_quality", e.target.value);
  releasePool();
  renderPreview();
});

/* ====================== wiring ====================== */

$("saveBtn").addEventListener("click", startSave);
$("links").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startSave(); }
});
$("queueClose").addEventListener("click", () => $("queue").classList.add("hidden"));
$("search").addEventListener("input", debounce(renderArchive, 200));

$("bulkClear").addEventListener("click", clearSelection);
$("bulkApply").addEventListener("click", () => {
  const tags = $("bulkTag").value.split(",").map((t) => t.trim()).filter(Boolean);
  if (!tags.length || !state.selected.size) return;
  state.selected.forEach((sc) => {
    const p = Store.getPost(sc);
    if (p) Store.updatePost(sc, { tags: [...new Set([...(p.tags || []), ...tags])] });
  });
  $("bulkTag").value = "";
  renderArchive();
});
$("bulkDelete").addEventListener("click", async () => {
  if (!state.selected.size) return;
  const list = [...state.selected];
  if (!confirm(deletionWarning(list))) return;
  const gone = await deletePosts(list);
  state.selected.clear();
  renderArchive();
  $("tabNote").textContent = `Deleted ${list.length} post(s)` +
    (gone.assets ? `, ${gone.assets} asset(s)` : "") +
    (gone.clips ? ` and ${gone.clips} clip(s)` : "");
  setTimeout(() => ($("tabNote").textContent = ""), 6000);
});

$("modalClose").addEventListener("click", closeModal);
// the backdrop closes; the lane the arrows live in is part of the backdrop
$("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal" || e.target.classList.contains("modal-shell")) closeModal();
});
document.querySelectorAll(".post-flip").forEach((b) =>
  b.addEventListener("click", () => flipPost(Number(b.dataset.step))));

/* the clip under the playhead has no file: take it off the timeline, and every
   other clip standing on the same lost asset with it */
$("pvGoneDrop").addEventListener("click", () => {
  const found = findClip(state.goneClip);
  if (!found) return;
  const assetId = clipAssetId(found.clip);
  snapshot();
  let gone = 0;
  state.project.tracks.forEach((t) => {
    const keep = t.clips.filter((c) => clipAssetId(c) !== assetId);
    gone += t.clips.length - keep.length;
    t.clips = keep;
  });
  state.selectedClips.clear();
  commit();
  state.status = `Removed ${gone} clip(s) whose file is gone`;
  renderProps();
});

/* the AI workbench: its own popup, wired once */
$("aiClose").addEventListener("click", closeAiTool);
$("aiCancel").addEventListener("click", closeAiTool);
$("aiTool").addEventListener("click", (e) => { if (e.target.id === "aiTool") closeAiTool(); });
$("aiPlay").addEventListener("click", () => {
  const v = $("aiVideo");
  if (v.paused) { v.play().catch(() => {}); $("aiPlay").textContent = "⏸"; }
  else { v.pause(); $("aiPlay").textContent = "▶"; }
});
/* scrubbing the run: the picture follows the pointer, not just the click —
   seeking happens in the page, so dragging costs nothing */
$("aiTrack").addEventListener("pointerdown", (e) => {
  const run = state.ai?.run;
  if (!run || e.target.classList.contains("ai-grip")) return;
  e.preventDefault();
  const track = e.currentTarget.getBoundingClientRect();
  const v = $("aiVideo");
  const seek = (ev) => {
    const t = run.from + clamp((ev.clientX - track.left) / track.width, 0, 1) * (run.to - run.from);
    try { v.currentTime = t; } catch { /* not seekable yet */ }
    refreshAiTrack();
  };
  seek(e);
  const up = () => {
    window.removeEventListener("pointermove", seek);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", seek);
  window.addEventListener("pointerup", up);
});

/* the ends of the span decide what is sent — and what it costs */
["aiSpanIn", "aiSpanOut"].forEach((id) => $(id).addEventListener("pointerdown", (e) => {
  const ai = state.ai;
  if (!ai?.run) return;
  e.preventDefault();
  const grip = $(id), which = id === "aiSpanIn" ? "in" : "out";
  const track = $("aiTrack").getBoundingClientRect();
  const { from, to } = ai.run;
  grip.classList.add("dragging");
  const move = (ev) => {
    const t = from + ((ev.clientX - track.left) / track.width) * (to - from);
    // at least a second between the ends, and never outside the run on screen
    if (which === "in") ai.range.in = clamp(t, from, ai.range.out - 1);
    else ai.range.out = clamp(t, ai.range.in + 1, to);
    $("aiVideo").currentTime = ai.range[which];
    refreshAiTrack();
    renderAiTool();                     // length and price follow the handle
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    grip.classList.remove("dragging");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}));
$("aiView").querySelectorAll("[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.disabled || !state.ai) return;
    state.ai.view = b.dataset.view;
    $("aiView").querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x === b));
    showAiSide();
  }));
$("aiRun").addEventListener("click", runAiTool);

document.addEventListener("keydown", (e) => {
  if (!$("prefs").classList.contains("hidden") && e.key === "Escape") $("prefs").classList.add("hidden");
  if (!$("scenTool").classList.contains("hidden")) {
    if (e.key === "Escape") closeScenTool();
    return;
  }
  // while the workbench is open it owns the keyboard: Escape closes it, Space
  // plays the fragment in it, and nothing reaches the timeline behind
  if (!$("aiTool").classList.contains("hidden")) {
    if (e.key === "Escape") { closeAiTool(); return; }
    const el = e.target;
    const typing = el.tagName === "TEXTAREA"
      || (el.tagName === "INPUT" && !/^(range|checkbox|radio|button|color|submit)$/.test(el.type));
    if (!typing && (e.key === " " || e.code === "Space")) { e.preventDefault(); $("aiPlay").click(); }
    return;
  }
  if (e.key === "F5") { e.preventDefault(); renderArchive(); }

  // editor shortcuts — only when the editor is open and we are not typing
  // A slider keeps focus after you let it go, and it swallowed every shortcut —
  // Ctrl+Z after moving one did nothing. Only fields that actually take text count
  // as typing.
  const el = e.target;
  const typing = el.tagName === "TEXTAREA"
    || (el.tagName === "INPUT" && !/^(range|checkbox|radio|button|color|submit)$/.test(el.type));
  if (document.body.dataset.view === "editor" && !typing && $("modal").classList.contains("hidden")) {
    const key = e.key.toLowerCase();
    if (e.key === " " || e.code === "Space") { e.preventDefault(); playPause(); }
    if (key === "s" && !e.ctrlKey) { e.preventDefault(); splitAtPlayhead(); }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // a picked cut mark takes Delete first — losing a whole clip because a
      // pending cut was selected would be a nasty surprise
      const picked = state.sceneScan?.selected;
      if (picked != null) removeMark(picked);
      else deleteSelected(e.shiftKey || e.ctrlKey);      // Shift+Del or Ctrl+Del ripples
    }
    if (key === "z" && e.ctrlKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (key === "y" && e.ctrlKey) { e.preventDefault(); redo(); }
    if (key === "a" && e.ctrlKey) {
      e.preventDefault();
      allClips().forEach(({ clip }) => state.selectedClips.add(clip.id));
      renderTimeline(); renderProps();
    }
    if (key === "c" && e.ctrlKey) { e.preventDefault(); copySelection(false); }
    if (key === "x" && e.ctrlKey) { e.preventDefault(); copySelection(true); }
    if (key === "v" && e.ctrlKey) { e.preventDefault(); pasteClipboard(); }

    if (e.key === "\\") { e.preventDefault(); zoomToFit(); }
    if (e.ctrlKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(state.pps * 1.3); }
    if (e.ctrlKey && e.key === "-") { e.preventDefault(); setZoom(state.pps / 1.3); }
    if (e.ctrlKey && e.key === "0") { e.preventDefault(); setZoom(60); }

    if (e.key === "Home") { e.preventDefault(); movePlayhead(0); }
    if (e.key === "End") { e.preventDefault(); movePlayhead(projectDuration()); }
    if (e.key === "ArrowUp") { e.preventDefault(); jumpSnap(-1); }
    if (e.key === "ArrowDown") { e.preventDefault(); jumpSnap(1); }

    if (e.key === "Escape" && state.selectedClips.size) selectClip(null, false);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const stepSec = e.shiftKey ? 1 : 1 / (state.project.canvas.fps || 30);
      movePlayhead(state.playhead + (e.key === "ArrowRight" ? stepSec : -stepSec));
    }
  }

  if ($("modal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeModal();
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const delta = e.key === "ArrowLeft" ? -1 : 1;
  // a carousel owns the plain arrows; holding shift always means the post, and
  // on a single-file post there is no carousel to argue with
  if (!e.shiftKey && state.current?.media.length > 1) step(delta);
  else flipPost(delta);
});

$("copyCaption").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.current?.caption || "");
  $("copyCaption").textContent = "Copied";
  setTimeout(() => ($("copyCaption").textContent = "Copy"), 1200);
});

$("saveMeta").addEventListener("click", () => {
  Store.updatePost(state.current.shortcode, {
    tags: $("mTags").value.split(",").map((t) => t.trim()).filter(Boolean),
    notes: $("mNotes").value,
  });
  $("saveMeta").textContent = "Saved";
  setTimeout(() => ($("saveMeta").textContent = "Save"), 1200);
  renderArchive();
});

$("openFolder").addEventListener("click", () => post("/api/reveal", { shortcode: state.current.shortcode }));

/* ---------- deleting a post, and everything it grew into ---------- */

/** What a post drags down with it: the assets made from it and the clips that
 *  play them. Renders are left alone — they are finished work, not source. */
function traceUses(shortcodes) {
  const assetIds = Store.listAssets()
    .filter((a) => shortcodes.includes(a.from_post))
    .map((a) => a.id);
  const clips = [];
  Store.listProjects().forEach((p) => {
    p.tracks.forEach((t) => t.clips.forEach((c) => {
      const used = [c.asset_id, ...(c.variants || []).map((v) => v.asset_id)];
      if (used.some((id) => assetIds.includes(id))) clips.push({ project: p, track: t, clip: c });
    }));
  });
  return { assetIds, clips, projects: [...new Set(clips.map((c) => c.project.id))] };
}

function purgeUses(shortcodes) {
  const { assetIds, clips, projects } = traceUses(shortcodes);
  const doomed = new Set(clips.map((c) => c.clip.id));
  // a linked pair goes together, or a lone half of it is left playing nothing
  clips.forEach(({ project, clip }) => {
    if (!clip.link_id) return;
    project.tracks.forEach((t) => t.clips.forEach((c) => {
      if (c.link_id === clip.link_id) doomed.add(c.id);
    }));
  });
  Store.listProjects().forEach((p) => {
    let touched = false;
    p.tracks.forEach((t) => {
      const left = t.clips.filter((c) => !doomed.has(c.id));
      if (left.length !== t.clips.length) { t.clips = left; touched = true; }
    });
    if (touched) Store.touchProject(p);
  });
  assetIds.forEach((id) => Store.removeAsset(id));
  shortcodes.forEach((sc) => Store.removePost(sc));
  Store.saveNow();
  return { assets: assetIds.length, clips: doomed.size, projects: projects.length };
}

/** One sentence about what is about to disappear, so nobody deletes blind. */
function deletionWarning(shortcodes) {
  const { assetIds, clips, projects } = traceUses(shortcodes);
  const bits = [`${shortcodes.length} post(s) and their files`];
  if (assetIds.length) bits.push(`${assetIds.length} editor asset(s)`);
  if (clips.length) bits.push(`${clips.length} clip(s) in ${projects.length} project(s)`);
  return `This deletes ${bits.join(", ")}.\nRendered videos are kept. Continue?`;
}

async function deletePosts(shortcodes) {
  for (const sc of shortcodes) {
    await api(`/api/media/${sc}`, { method: "DELETE" }).catch(() => {});
  }
  const gone = purgeUses(shortcodes);
  if (state.project) {
    state.project = Store.getProject(state.project.id) || Store.listProjects()[0] || null;
    if (document.body.dataset.view === "editor") { renderTimeline(); renderPreview(); renderLibrary(); }
  }
  return gone;
}

$("deletePost").addEventListener("click", async () => {
  const sc = state.current.shortcode;
  if (!confirm(deletionWarning([sc]))) return;
  await deletePosts([sc]);
  closeModal();
  renderArchive();
});

/* ====================== boot ====================== */

// the filter column comes back the way it was left
(Store.settings.kinds || []).forEach((k) => state.pickedKinds.add(k));
(Store.settings.tags || []).forEach((t) => state.pickedTags.add(t));

document.body.dataset.card = Store.settings.card_size || "s";
$("skipExisting").checked = !!Store.settings.skip_existing;
$("pvQuality").value = Store.settings.preview_quality || "auto";
syncMenuTicks();
applyLayout();
initSashes();
initTooltips();
wireZone($("tlVideo"), "video");
wireZone($("tlAudio"), "audio");
renderArchive();

/* A fresh window (or a cleared storage) starts with an empty index while the
 * media is still on disk — rebuild it silently instead of showing an empty grid. */
(async () => {
  if (Store.stats().total) return;
  $("tabNote").textContent = "index empty — checking the media folder…";
  try {
    const { records } = await api("/api/rescan");
    records.forEach((r) => Store.upsertPost(r));
    renderArchive();
    $("tabNote").textContent = records.length
      ? `restored ${records.length} post(s) from disk`
      : "";
    setTimeout(() => ($("tabNote").textContent = ""), 6000);
  } catch {
    $("tabNote").textContent = "index empty — Vault → Rescan media folder rebuilds it from disk";
  }
})();

