// Popup: quick run. Settings live on the options page; the job runs in background.js,
// so closing the popup doesn't stop it.

const $ = (id) => document.getElementById(id);
const call = async (type, extra = {}) => {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || "no answer");
  return r.value;
};
let cfg;

function addLog(text, cls) {
  const line = document.createElement("div");
  line.textContent = text;
  if (cls) line.className = cls;
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}
const setRunning = (running) => { $("go").disabled = running; $("go").textContent = running ? "Working…" : "Download"; };
const openOptions = (hash = "") => chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + hash });

async function saveRun() {
  cfg.run.roster = $("roster").checked;
  cfg.run.grades = $("grades").checked;
  cfg.run.post = $("post").checked;
  cfg.run.week = $("week").value.trim();
  for (const box of document.querySelectorAll("[data-addon]")) {
    const id = box.dataset.addon, key = box.dataset.output;
    const list = new Set(cfg.run.outputs[id] || []);
    box.checked ? list.add(key) : list.delete(key);
    cfg.run.outputs[id] = [...list];
  }
  await call("setConfig", { cfg });
}

function dot(el, labelEl, ready, text) {
  el.className = "dot " + (ready ? "on" : "off");
  labelEl.textContent = text;
}

async function load() {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  cfg = await call("getConfig");
  if (!cfg.site) { $("setup").hidden = false; return; }
  $("main").hidden = false;

  $("roster").checked = cfg.run.roster;
  $("grades").checked = cfg.run.grades;
  $("post").checked = cfg.run.post;
  $("week").value = cfg.run.week || "";

  // Brightspace status + which courses the rules select
  call("siteStatus").then(async (s) => {
    dot($("d2lDot"), $("d2lStatus"), s.tab, s.tab ? "tab open" : `open ${new URL(cfg.site).host}`);
    if (!s.tab) { $("courses").textContent = "Courses are listed once a Brightspace tab is open."; return; }
    try {
      const sel = Config.selectCourses(cfg, await call("courses"));
      $("courses").textContent = sel.selected.length
        ? `Courses: ${sel.selected.map((c) => c.code || c.name).join(", ")}`
        : "No courses selected — check Courses in Settings.";
      if (sel.errors.length) $("courses").textContent += " (" + sel.errors.join("; ") + ")";
    } catch (e) { $("courses").textContent = e.message; }
  });

  // One section per approved add-on
  const pending = [];
  for (const [id, a] of Object.entries(cfg.addons)) {
    if (!a.approved) { pending.push(a.info.name); continue; }
    const sec = document.createElement("section");
    sec.innerHTML = `<div class="src"><h2></h2><span class="status"><span class="dot"></span><span>checking…</span></span></div><div class="checks"></div>`;
    sec.querySelector("h2").textContent = a.info.name;
    for (const o of a.info.outputs) {
      const l = document.createElement("label"); l.className = "cb";
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: (cfg.run.outputs[id] || []).includes(o.key) });
      box.dataset.addon = id; box.dataset.output = o.key;
      box.addEventListener("change", saveRun);
      l.append(box, " " + o.label);
      sec.querySelector(".checks").appendChild(l);
    }
    $("addons").appendChild(sec);
    const [d, t] = sec.querySelectorAll(".status > span");
    call("addonStatus", { id }).then((s) => dot(d, t, s.ready, s.message || (s.ready ? "ready" : "not ready")), (e) => dot(d, t, false, e.message));
  }
  if (pending.length) {
    $("pending").hidden = false;
    $("pending").innerHTML = `${pending.length} add-on(s) waiting for your approval in <button class="link" id="approve">Settings</button>.`;
    $("approve").onclick = () => openOptions("#addons");
  }

  const { log = [], running = false } = await chrome.storage.session.get(["log", "running"]);
  log.forEach((l) => addLog(l.text, l.cls));
  setRunning(running);
}

["roster", "grades", "post"].forEach((k) => $(k).addEventListener("change", saveRun));
$("week").addEventListener("change", saveRun);
$("settings").onclick = () => openOptions();
$("setupBtn").onclick = () => openOptions("#site");
$("change").onclick = () => openOptions("#post");
$("go").onclick = async () => {
  await saveRun();
  $("log").textContent = "";
  try { await call("run"); } catch (e) { addLog(e.message, "err"); }
};
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "log") addLog(m.text, m.cls);
  if (m?.type === "state") setRunning(m.running);
});
load().catch((e) => addLog(e.message, "err"));
