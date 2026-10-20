// CompTIA CertMaster add-on for D2L Pull (source add-on API v1, see docs/SOURCE_ADDONS.md).
// Reads lab gradebooks and quiz reports from the instructor's open, logged-in
// platform.comptia.org tab and hands them to D2L Pull as CSV text.

const D2L_PULL = "ilmegdpkffcmnhanlgciclmceidicbof";
const SITE = "https://platform.comptia.org/*";

const REGISTRATION = {
  type: "d2lpull/register",
  api: 1,
  key: "comptia",
  name: "CompTIA CertMaster",
  version: chrome.runtime.getManifest().version,
  site: { label: "platform.comptia.org", url: "https://platform.comptia.org/" },
  outputs: [
    { key: "labs", label: "Labs", filename: "comptia_labs.csv" },
    { key: "quizzes", label: "Quizzes", filename: "comptia_quizzes.csv" },
  ],
  settings: [
    { key: "quizReportMatch", label: "Quiz custom report name (regex)", type: "text", default: "quiz" },
  ],
};

function register() {
  chrome.runtime.sendMessage(D2L_PULL, REGISTRATION).catch(() => { /* D2L Pull not installed yet */ });
}
chrome.runtime.onInstalled.addListener(register);
chrome.runtime.onStartup.addListener(register);

async function findTab() {
  const tabs = await chrome.tabs.query({ url: SITE });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function runInTab(opts) {
  const tab = await findTab();
  if (!tab) throw new Error("No CompTIA tab open — open platform.comptia.org and log in.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["comptia.js"] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, args: [opts],
    func: async (opts) => {
      const log = [];
      try { return { ok: true, log, ...(await globalThis.comptiaPull(opts, { log: (m) => log.push(m) })) }; }
      catch (e) { return { ok: false, error: String(e?.message || e) }; }
    },
  });
  if (!result) throw new Error("No response from the CompTIA tab — reload it and try again.");
  if (!result.ok) throw new Error(result.error);
  return result;
}

const handlers = {
  "d2lpull/hello": async () => REGISTRATION,
  "d2lpull/status": async () => {
    const tab = await findTab();
    return tab ? { ready: true, message: "tab open" } : { ready: false, message: "open platform.comptia.org and log in" };
  },
  "d2lpull/classes": async (m) => {
    const r = await runInTab({ listOnly: true, quizReportMatch: m.settings?.quizReportMatch });
    return { ok: true, classes: r.classes };
  },
  "d2lpull/pull": async (m) => {
    const outs = new Set(m.outputs || []);
    const r = await runInTab({ labs: outs.has("labs"), quizzes: outs.has("quizzes"), classIds: m.classIds,
                               quizReportMatch: m.settings?.quizReportMatch || "quiz" });
    return { ok: true, log: r.log, files: r.files.map((f) => ({ classId: f.classId, output: f.kind, content: f.csv })) };
  },
};

chrome.runtime.onMessageExternal.addListener((m, sender, reply) => {
  if (sender.id !== D2L_PULL) return false;           // only D2L Pull may ask
  const h = handlers[m?.type];
  if (!h) return false;
  h(m).then(reply, (e) => reply({ ok: false, ready: false, error: String(e?.message || e), message: String(e?.message || e) }));
  return true;
});
