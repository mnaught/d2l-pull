// Popup: edits settings and starts a job in the background worker (background.js),
// then shows its progress. Closing the popup does not stop the job.

const CHECKS = ["roster", "grades", "labs", "quizzes", "convert", "zeroMissing"];
const TEXTS = ["folder", "d2lHost", "roleMatch", "termMatch", "studentMatch", "itemMatch", "quizReportMatch", "quizDue", "week"];
const $ = (id) => document.getElementById(id);
const logEl = $("log");
let DEFAULTS = {};

function addLog(text, cls) {
  const line = document.createElement("div");
  line.textContent = text;
  if (cls) line.className = cls;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function load() {
  DEFAULTS = await chrome.runtime.sendMessage({ type: "defaults" });
  const { settings } = await chrome.storage.sync.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  CHECKS.forEach((k) => ($(k).checked = !!s[k]));
  TEXTS.forEach((k) => ($(k).value = s[k] ?? ""));
  syncConvert();
  checkTabs(s);
  const { log = [], running = false } = await chrome.storage.session.get(["log", "running"]);
  log.forEach((l) => addLog(l.text, l.cls));
  setRunning(running);
}

function read() {
  const s = { schema: 21 };
  CHECKS.forEach((k) => (s[k] = $(k).checked));
  TEXTS.forEach((k) => (s[k] = $(k).value.trim()));
  s.d2lHost = (s.d2lHost || DEFAULTS.d2lHost).replace(/\/+$/, "");
  if (!/^https:\/\//.test(s.d2lHost)) s.d2lHost = "https://" + s.d2lHost.replace(/^\w+:\/\//, "");
  return s;
}

async function save(quiet) {
  const s = read();
  // A Brightspace site other than the built-in one needs permission once.
  const origin = s.d2lHost + "/*";
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) { addLog(`Permission for ${s.d2lHost} was declined — keeping the old site.`, "err"); s.d2lHost = DEFAULTS.d2lHost; $("d2lHost").value = s.d2lHost; }
  }
  await chrome.storage.sync.set({ settings: s });
  if (!quiet) addLog("Settings saved.", "ok");
  checkTabs(s);
  return s;
}

// The converter needs the labs file, so it is only available with Labs ticked.
function syncConvert() {
  $("convert").disabled = !$("labs").checked;
  $("week").disabled = !($("grades").checked || $("convert").checked);
}

async function checkTabs(s) {
  const show = (dot, label, tabs, what) => {
    $(dot).className = "dot " + (tabs.length ? "on" : "off");
    $(label).textContent = tabs.length ? "tab open" : `open ${what} first`;
  };
  show("d2lDot", "d2lStatus", await chrome.tabs.query({ url: s.d2lHost + "/*" }).catch(() => []), new URL(s.d2lHost).host);
  show("ctDot", "ctStatus", await chrome.tabs.query({ url: "https://platform.comptia.org/*" }), "platform.comptia.org");
}

function setRunning(running) {
  $("go").disabled = running;
  $("go").textContent = running ? "Working…" : "Download";
}

// Checkboxes and week save as you click them.
CHECKS.forEach((k) => $(k).addEventListener("change", () => { syncConvert(); save(true); }));
$("week").addEventListener("change", () => save(true));
$("save").onclick = () => save(false);
$("reset").onclick = async () => {
  await chrome.storage.sync.remove("settings");
  logEl.textContent = "";
  await load();
  addLog("Defaults restored.", "ok");
};

$("go").onclick = async () => {
  const s = await save(true);
  if (!s.roster && !s.grades && !s.labs && !s.quizzes) return addLog("Tick at least one download.", "err");
  logEl.textContent = "";
  const r = await chrome.runtime.sendMessage({ type: "run" });
  if (!r?.ok) addLog(r?.error || "Could not start.", "err");
};

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "log") addLog(m.text, m.cls);
  if (m?.type === "state") setRunning(m.running);
});

$("ver").textContent = "v" + chrome.runtime.getManifest().version;
load();
