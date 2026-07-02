// ── Times Tables Duel ────────────────────────────────────────
// Static front-end + Firebase Realtime Database.
// Two players join a room, agree on settings, play the SAME
// questions (shared seed → deterministic sequence), then both
// see combined stats.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, set, get, update, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

// ── Firebase init ────────────────────────────────────────────
let db;
try {
  db = getDatabase(initializeApp(firebaseConfig));
} catch (e) {
  document.body.innerHTML =
    '<p style="color:#f85149;font-family:sans-serif;padding:40px">' +
    'Firebase failed to initialise. Did you fill in <code>firebase-config.js</code>?<br>' + e + '</p>';
  throw e;
}

// Clock-skew correction so both players' timers agree.
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), s => { serverOffset = s.val() || 0; });
const serverNow = () => Date.now() + serverOffset;

const COUNTDOWN_MS = 3000;   // 3-2-1 before the round begins
const TIME_POOL = 1000;      // questions pre-generated for timed mode

// ── Local session state ──────────────────────────────────────
const me = {
  id: "p_" + Math.random().toString(36).slice(2, 10),
  name: "",
  code: null,
  isHost: false,
};
let roomRef = null;
let unsubRoom = null;
let phase = "home";          // home | lobby | playing | results

// game-run locals
let questions = [];
let qIndex = 0;
let correct = 0;
let attempted = 0;
let answers = [];            // { a, b, given, ok } per submitted question
let runStartAt = 0;          // serverTime the round actually begins (after countdown)
let runEndAt = 0;            // timed mode only
let tickTimer = null;
let currentSettings = null;  // settings for the active round (read by answer handler)

// ── Tiny DOM helpers ─────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(screen) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $("screen-" + screen).classList.add("active");
}
function setHostVisibility() {
  document.querySelectorAll(".host-only").forEach(el =>
    el.classList.toggle("hidden", !me.isHost));
}

// ── Deterministic RNG (mulberry32) → identical questions ─────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function buildQuestions(seed, count, maxA, maxB) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ a: 1 + Math.floor(rnd() * maxA), b: 1 + Math.floor(rnd() * maxB) });
  }
  return out;
}

// ── Room codes ───────────────────────────────────────────────
function makeCode() {
  const alph = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O/1/I
  let c = "";
  for (let i = 0; i < 4; i++) c += alph[Math.floor(Math.random() * alph.length)];
  return c;
}

// ── HOME: create / join ──────────────────────────────────────
$("btn-create").onclick = async () => {
  const name = $("home-name").value.trim();
  if (!name) return err("Enter your name first.");
  me.name = name; me.isHost = true;

  let code, exists = true;
  // avoid clobbering an existing room
  for (let tries = 0; tries < 5 && exists; tries++) {
    code = makeCode();
    exists = (await get(ref(db, "rooms/" + code))).exists();
  }
  me.code = code;

  await set(ref(db, "rooms/" + code), {
    host: me.id,
    status: "waiting",
    settings: { maxA: 12, maxB: 12, mode: "time", limit: 60, maxPlayers: 2 },
    players: {
      [me.id]: { name, ready: false, done: false, stats: null },
    },
  });
  enterRoom(code);
};

$("btn-join").onclick = async () => {
  const name = $("home-name").value.trim();
  const code = $("join-code").value.trim().toUpperCase();
  if (!name) return err("Enter your name first.");
  if (code.length !== 4) return err("Enter the 4-letter room code.");

  const snap = await get(ref(db, "rooms/" + code));
  if (!snap.exists()) return err("No room with that code.");
  const data = snap.val();
  const count = Object.keys(data.players || {}).length;
  const maxP = data.settings?.maxPlayers || 2;
  if (count >= maxP && !data.players[me.id]) return err(`That room is full (${maxP} players).`);
  if (data.status !== "waiting") return err("That game already started.");

  me.name = name; me.isHost = false; me.code = code;
  await update(ref(db, `rooms/${code}/players/${me.id}`),
    { name, ready: false, done: false, stats: null });
  enterRoom(code);
};

function err(msg) { $("home-error").textContent = msg; }

// ── Enter a room: attach the live listener ───────────────────
function enterRoom(code) {
  roomRef = ref(db, "rooms/" + code);
  // If we close the tab, drop out of the room.
  onDisconnect(ref(db, `rooms/${code}/players/${me.id}`)).remove();

  $("lobby-code").textContent = code;
  setHostVisibility();
  phase = "lobby";
  show("lobby");

  if (unsubRoom) unsubRoom();
  unsubRoom = onValue(roomRef, snap => handleRoom(snap.val()));
}

// ── The single source of truth: react to room changes ────────
function handleRoom(data) {
  if (!data) {                      // room deleted
    if (phase !== "home") goHome("The room was closed.");
    return;
  }
  const players = data.players || {};
  const ids = Object.keys(players);

  // keep host flag honest
  me.isHost = data.host === me.id;
  setHostVisibility();

  if (data.status === "waiting") {
    if (phase !== "lobby") { phase = "lobby"; show("lobby"); }
    renderLobby(data, players, ids);
  }

  if (data.status === "playing") {
    if (phase === "lobby") startRound(data);       // begin locally, once
    // results: everyone present has finished
    if (phase === "playing" && ids.length > 0 && ids.every(id => players[id].done)) {
      showResults(players, ids, data.settings);
    }
    if (phase === "results") showResults(players, ids, data.settings);
  }
}

// ── LOBBY rendering ──────────────────────────────────────────
function renderLobby(data, players, ids) {
  // players list
  $("lobby-players").innerHTML = ids.map(id => {
    const p = players[id];
    const tags = [];
    if (id === data.host) tags.push('<span class="badge">host</span>');
    tags.push(p.ready ? '<span class="ready">✓ ready</span>' : '<span class="badge">not ready</span>');
    return `<div class="player-chip"><span>${escapeHtml(p.name)}${id === me.id ? " (you)" : ""}</span>
            <span>${tags.join(" ")}</span></div>`;
  }).join("");

  // settings — reflect DB values; host can edit, guest is read-only
  const s = data.settings;
  if (document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "SELECT") {
    $("set-maxA").value = s.maxA;
    $("set-maxB").value = s.maxB;
    $("set-mode").value = s.mode;
    $("set-limit").value = s.limit;
    $("set-players").value = s.maxPlayers || 2;
  }
  $("limit-label").textContent = s.mode === "time" ? "Seconds" : "# Questions";
  ["set-maxA", "set-maxB", "set-mode", "set-limit", "set-players"]
    .forEach(k => $(k).disabled = !me.isHost);

  const maxP = s.maxPlayers || 2;
  const meReady = !!players[me.id]?.ready;
  const readyCount = ids.filter(id => players[id].ready).length;
  const allReady = ids.length >= 2 && readyCount === ids.length;

  // ready button: label + green "on" state
  const btn = $("btn-ready");
  btn.textContent = meReady ? "✓ You're ready (tap to cancel)" : "I'm ready";
  btn.classList.toggle("ready-on", meReady);

  // one pill per player currently in the room
  $("ready-summary").innerHTML = ids.map(id =>
    pill(players[id].name + (id === me.id ? " (you)" : ""), players[id].ready)).join("");

  $("btn-start").disabled = !allReady;
  $("lobby-status").textContent =
      ids.length < 2 ? `Waiting for more players to join… (${ids.length}/${maxP})`
    : !meReady       ? "Tap “I'm ready” when you're set."
    : !allReady      ? `Waiting for others… (${readyCount}/${ids.length} ready)`
    : me.isHost      ? "Everyone's ready — press Start!"
                     : "Everyone's ready — waiting for the host to start…";
}

// a readiness pill
function pill(who, on) {
  return `<div class="ready-pill ${on ? "on" : ""}">
            <span class="who">${escapeHtml(who)}</span>${on ? "✓ ready" : "not ready"}</div>`;
}

// host edits settings → write to DB
["set-maxA", "set-maxB", "set-mode", "set-limit", "set-players"].forEach(k => {
  $(k).onchange = () => {
    if (!me.isHost) return;
    const settings = {
      maxA:       clamp(+$("set-maxA").value, 1, 20),
      maxB:       clamp(+$("set-maxB").value, 1, 20),
      mode:       $("set-mode").value,
      limit:      clamp(+$("set-limit").value, 5, 600),
      maxPlayers: clamp(+$("set-players").value, 2, 6),
    };
    update(ref(db, `rooms/${me.code}/settings`), settings);
  };
});

$("btn-ready").onclick = async () => {
  const snap = await get(ref(db, `rooms/${me.code}/players/${me.id}/ready`));
  update(ref(db, `rooms/${me.code}/players/${me.id}`), { ready: !snap.val() });
};

$("btn-start").onclick = async () => {
  if (!me.isHost) return;
  const seed = Math.floor(Math.random() * 2 ** 31);
  const upd = {
    seed,
    status: "playing",
    startAt: serverTimestamp(),   // resolves to a number for everyone
  };
  // reset per-round player fields
  const snap = await get(ref(db, `rooms/${me.code}/players`));
  Object.keys(snap.val() || {}).forEach(id => {
    upd[`players/${id}/done`] = false;
    upd[`players/${id}/stats`] = null;
  });
  update(roomRef, upd);
};

$("btn-leave").onclick = () => leaveAndHome();

// ── START A ROUND ────────────────────────────────────────────
function startRound(data) {
  phase = "playing";
  const s = data.settings;
  currentSettings = s;
  const count = s.mode === "questions" ? s.limit : TIME_POOL;
  questions = buildQuestions(data.seed, count, s.maxA, s.maxB);
  qIndex = 0; correct = 0; attempted = 0; answers = [];

  runStartAt = data.startAt + COUNTDOWN_MS;
  runEndAt = s.mode === "time" ? runStartAt + s.limit * 1000 : Infinity;

  $("hud-progress-label").textContent = s.mode === "questions" ? "Question" : "Answered";
  $("hud-time-label").textContent = "Time";

  runCountdown(() => beginPlay(s));
}

function runCountdown(then) {
  show("countdown");
  const tick = () => {
    const remain = runStartAt - serverNow();
    if (remain <= 0) { then(); return; }
    $("countdown-num").textContent = Math.ceil(remain / 1000);
    requestAnimationFrame(tick);
  };
  tick();
}

function beginPlay(s) {
  show("play");
  $("play-area").hidden = false;
  $("finish-banner").hidden = true;
  renderQuestion();
  $("answer").disabled = false;
  $("answer").value = "";
  $("answer").focus();

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => updateHud(s), 100);
  updateHud(s);
}

function updateHud(s) {
  const now = serverNow();
  if (s.mode === "time") {
    const elapsed = Math.min(s.limit, Math.max(0, (now - runStartAt) / 1000));
    $("hud-time").textContent = `${elapsed.toFixed(1)} / ${s.limit}`;
    $("hud-progress").textContent = attempted;
    if (now >= runEndAt) finishRound();
  } else {
    $("hud-time").textContent = ((now - runStartAt) / 1000).toFixed(1);
    // the question you're currently ON, not how many you've finished
    $("hud-progress").textContent = `${Math.min(qIndex + 1, s.limit)} / ${s.limit}`;
  }
}

function renderQuestion() {
  const q = questions[qIndex];
  $("q-a").textContent = q.a;
  $("q-b").textContent = q.b;
}

// answer submission — no correct/wrong feedback during play (shown in results)
$("answer").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (phase !== "playing") return;         // locked once finished
  const val = $("answer").value.trim();
  if (val === "") return;
  const q = questions[qIndex];
  const right = +val === q.a * q.b;

  answers.push({ a: q.a, b: q.b, given: +val, ok: right });
  attempted++;
  if (right) correct++;
  $("answer").value = "";

  qIndex++;
  // questions-mode end condition
  const s = currentSettings;
  if (s && s.mode === "questions" && attempted >= s.limit) { finishRound(); return; }
  if (qIndex >= questions.length) { finishRound(); return; } // ran out of pool
  renderQuestion();
});

// ── FINISH ───────────────────────────────────────────────────
async function finishRound() {
  if (phase !== "playing") return;   // guard against double-fire
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  const timeMs = Math.max(0, Math.round(serverNow() - runStartAt));

  // lock all further input and show a big, clear "finished" banner
  $("answer").disabled = true;
  $("answer").blur();
  $("play-area").hidden = true;
  $("finish-big").textContent = currentSettings.mode === "time" ? "⏱ Time's up!" : "✓ All done!";
  $("finish-banner").hidden = false;

  await update(ref(db, `rooms/${me.code}/players/${me.id}`), {
    done: true,
    stats: { correct, attempted, timeMs, answers },
  });
  // showResults will fire from the room listener once both are done
}

// ── RESULTS ──────────────────────────────────────────────────
function showResults(players, ids, settings) {
  phase = "results";
  show("results");
  setHostVisibility();

  const rows = ids.map(id => ({ id, name: players[id].name, ...players[id].stats }))
                  .filter(r => r.correct !== undefined);

  // winner: most correct, tiebreak by faster time
  let best = null;
  rows.forEach(r => {
    if (!best || r.correct > best.correct ||
       (r.correct === best.correct && r.timeMs < best.timeMs)) best = r;
  });
  const tie = rows.filter(r => best && r.correct === best.correct && r.timeMs === best.timeMs).length > 1;

  $("results-title").textContent =
    rows.length < 2 ? "Your results" : tie ? "It's a tie!" : `${escapeHtml(best.name)} wins! 🏆`;

  // ── Overall summary cards (top) ──
  const cards = rows.map(r => {
    const acc = r.attempted ? Math.round(100 * r.correct / r.attempted) : 0;
    const isWinner = !tie && rows.length > 1 && best && r.id === best.id;
    return `<div class="result-card ${isWinner ? "winner" : ""}">
      <h3>${escapeHtml(r.name)}${r.id === me.id ? " (you)" : ""}
        ${isWinner ? '<span class="crown">winner</span>' : ""}</h3>
      <div class="stat-grid">
        <div class="stat"><div class="n">${r.correct}/${r.attempted}</div><div class="l">Correct</div></div>
        <div class="stat"><div class="n">${acc}%</div><div class="l">Accuracy</div></div>
        <div class="stat"><div class="n">${(r.timeMs / 1000).toFixed(1)}s</div><div class="l">Time</div></div>
      </div>
    </div>`;
  }).join("");

  // ── Per-question breakdown (one column per player) ──
  let breakdown = "";
  if (rows.length) {
    const cols = rows;                                        // a column per player
    const n = Math.max(0, ...cols.map(r => r.answers?.length || 0));
    const cell = ans => {
      if (!ans) return `<td class="miss">—</td>`;
      if (ans.ok) return `<td class="ok">${ans.given}</td>`;
      return `<td class="no">${ans.given}<span class="corr">${ans.a * ans.b}</span></td>`;
    };
    let body = "";
    for (let i = 0; i < n; i++) {
      const q = cols.map(r => r.answers?.[i]).find(Boolean);  // same seed → same question
      body += `<tr><td class="qnum">${i + 1}</td><td class="q">${q.a} × ${q.b}</td>` +
              cols.map(r => cell(r.answers?.[i])).join("") + `</tr>`;
    }
    const head = `<tr><th>#</th><th>Question</th>` +
                 cols.map(r => `<th>${escapeHtml(r.name)}</th>`).join("") + `</tr>`;
    const foot = `<tr class="total-row"><td></td><td class="q">Total correct</td>` +
                 cols.map(r => `<td class="tot">${r.correct}/${r.attempted}</td>`).join("") + `</tr>`;
    breakdown = n === 0 ? "" : `
      <h3 class="breakdown-title">Question by question</h3>
      <div class="qtable-wrap">
        <table class="qtable">
          <thead>${head}</thead>
          <tbody>${body}</tbody>
          <tfoot>${foot}</tfoot>
        </table>
      </div>`;
  }

  $("results-table").innerHTML = cards + breakdown;
  $("results-status").textContent =
    rows.length < 2 ? "Waiting for your opponent to finish…" : "";
}

// host: play again → back to lobby, cleared
$("btn-again").onclick = async () => {
  if (!me.isHost) return;
  const snap = await get(ref(db, `rooms/${me.code}/players`));
  const upd = { status: "waiting", seed: null, startAt: null };
  Object.keys(snap.val() || {}).forEach(id => {
    upd[`players/${id}/ready`] = false;
    upd[`players/${id}/done`] = false;
    upd[`players/${id}/stats`] = null;
  });
  update(roomRef, upd);
};

$("btn-home").onclick = () => leaveAndHome();

// ── Leaving / cleanup ────────────────────────────────────────
async function leaveAndHome() {
  try {
    if (me.code) {
      await set(ref(db, `rooms/${me.code}/players/${me.id}`), null);
      // if the room is now empty, delete it
      const snap = await get(ref(db, `rooms/${me.code}/players`));
      if (!snap.exists()) await set(ref(db, "rooms/" + me.code), null);
    }
  } catch (_) {}
  goHome();
}

function goHome(message) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  me.code = null; me.isHost = false;
  phase = "home";
  $("home-error").textContent = message || "";
  $("join-code").value = "";
  show("home");
}

// small utils
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n || lo)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

show("home");
