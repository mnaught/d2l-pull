// Popup: injects core.js into the active Brightspace tab, runs the pull there
// (so your session is used automatically), then saves the CSVs via chrome.downloads.

const FIELDS = ["roleMatch", "termMatch", "studentMatch", "itemMatch"];
const logEl = document.getElementById("log");

function log(msg, cls) {
  const line = document.createElement("div");
  line.textContent = msg;
  if (cls) line.className = cls;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(FIELDS);
  for (const f of FIELDS) document.getElementById(f).value = saved[f] ?? D2L_DEFAULTS[f];
}
function readSettings() {
  return Object.fromEntries(FIELDS.map((f) => [f, document.getElementById(f).value.trim()]));
}

document.getElementById("save").onclick = async () => {
  await chrome.storage.sync.set(readSettings());
  log("Settings saved.", "ok");
};
document.getElementById("reset").onclick = async () => {
  await chrome.storage.sync.remove(FIELDS);
  await loadSettings();
  log("Defaults restored.", "ok");
};

// Progress lines sent from the injected script
chrome.runtime.onMessage.addListener((m) => { if (m?.d2lLog) log(m.d2lLog); });

async function run(mode) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  logEl.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("http")) throw new Error("Open your Brightspace site in this tab first.");

    const opts = { ...readSettings(), mode };
    for (const k of Object.keys(opts)) if (opts[k] === "" && k !== "termMatch") delete opts[k];

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["core.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [opts],
      func: async (opts) => {
        try {
          const log = (m) => chrome.runtime.sendMessage({ d2lLog: m }).catch(() => {});
          return { ok: true, ...(await globalThis.d2lPull(opts, { log })) };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      },
    });
    if (!result.ok) throw new Error(result.error);

    const stamp = new Date().toISOString().slice(0, 10);
    for (const f of result.files) {
      const url = "data:text/csv;charset=utf-8," + encodeURIComponent(f.csv);
      await chrome.downloads.download({ url, filename: `d2l-pull/${stamp}/${f.path}`, conflictAction: "overwrite" });
    }
    log(`Done — ${result.files.length} file(s) saved to Downloads/d2l-pull/${stamp}/`, "ok");
  } catch (e) {
    log(e.message || String(e), "err");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => run(b.dataset.mode)));
loadSettings();
