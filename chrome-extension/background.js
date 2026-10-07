// Background worker: runs a pull job so it keeps going even if the popup closes.
// 1. finds your open Brightspace and CompTIA tabs
// 2. runs core.js / comptia.js inside them (your existing logins, nothing copied)
// 3. saves the CSVs into the chosen folder under Downloads
// 4. optionally asks the Windows helper to run convert.py on them

const NATIVE_HOST = "com.mnaught.d2lpull";
const DEFAULT_SETTINGS = {
  d2lHost: "https://d2l.pcc.edu",
  folder: "!Fall 26/cis140l/script/CompTIA-D2L-Gradebook-Converter/Data",
  roster: false, grades: true, labs: true, quizzes: true, convert: false,
  week: "",                         // blank = completed weeks since the CompTIA class started
  roleMatch: "Instructor", termMatch: "", studentMatch: "Student",
  itemMatch: "comptia.*(lab|quiz)|(lab|quiz).*comptia",
  zeroMissing: false, quizReportMatch: "quiz",
};

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---- progress log (popup shows it live; kept in session storage for reopening) ----
let logLines = [];
async function log(text, cls = "") {
  logLines.push({ text, cls });
  await chrome.storage.session.set({ log: logLines });
  chrome.runtime.sendMessage({ type: "log", text, cls }).catch(() => {});
}
async function setRunning(running) {
  await chrome.storage.session.set({ running });
  chrome.runtime.sendMessage({ type: "state", running }).catch(() => {});
}

// ---- helpers ------------------------------------------------------------------------
async function findTab(urlPattern) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function runInTab(tabId, file, fnName, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [fnName, opts],
    func: async (fnName, opts) => {
      try {
        const log = (m) => chrome.runtime.sendMessage({ type: "tablog", text: m }).catch(() => {});
        return { ok: true, ...(await globalThis[fnName](opts, { log })) };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
  });
  if (!result) throw new Error("No response from the page — reload that tab and try again.");
  if (!result.ok) throw new Error(result.error);
  return result;
}

function cleanFolder(folder) {
  return String(folder || "").replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..").join("/");
}

function download(folder, name, csv) {
  return new Promise((resolve, reject) => {
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const filename = (folder ? folder + "/" : "") + name;
    chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) return reject(new Error(chrome.runtime.lastError?.message || "download failed"));
      const done = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete") {
          chrome.downloads.onChanged.removeListener(done);
          chrome.downloads.search({ id }, ([item]) => resolve(item.filename));
        } else if (delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(done);
          reject(new Error("download interrupted"));
        }
      };
      chrome.downloads.onChanged.addListener(done);
    });
  });
}

function sendNative(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: "no reply from helper" });
    });
  });
}

// ---- the job ------------------------------------------------------------------------
async function runJob(s) {
  logLines = [];
  await setRunning(true);
  const folder = cleanFolder(s.folder);
  const saved = [];          // { kind, path }
  let comptiaClasses = [];

  try {
    // Brightspace
    if (s.roster || s.grades) {
      await log("Brightspace (D2L)", "h");
      const host = s.d2lHost.replace(/\/+$/, "");
      const tab = await findTab(host + "/*");
      if (!tab) {
        await log(`No Brightspace tab open — open ${host} and log in, then retry.`, "err");
      } else {
        try {
          const r = await runInTab(tab.id, "core.js", "d2lPull", {
            roster: s.roster, grades: s.grades, roleMatch: s.roleMatch, termMatch: s.termMatch,
            studentMatch: s.studentMatch, itemMatch: s.itemMatch, zeroMissing: s.zeroMissing,
          });
          if (!r.courses.length) await log("No current-term courses where you're an instructor.", "err");
          for (const f of r.files) {
            const path = await download(folder, f.path, f.csv);
            saved.push({ kind: f.kind, path });
            await log(`saved ${f.path}`, "ok");
          }
        } catch (e) { await log(e.message, "err"); }
      }
    }

    // CompTIA
    if (s.labs || s.quizzes) {
      await log("CompTIA CertMaster", "h");
      const tab = await findTab("https://platform.comptia.org/*");
      if (!tab) {
        await log("No CompTIA tab open — open platform.comptia.org and log in, then retry.", "err");
      } else {
        try {
          const r = await runInTab(tab.id, "comptia.js", "comptiaPull", {
            labs: s.labs, quizzes: s.quizzes, quizReportMatch: s.quizReportMatch,
          });
          comptiaClasses = r.classes;
          if (!r.classes.length) await log("No current CompTIA classes you teach.", "err");
          for (const f of r.files) {
            const path = await download(folder, f.path, f.csv);
            saved.push({ kind: f.kind, path });
            await log(`saved ${f.path}`, "ok");
          }
        } catch (e) { await log(e.message, "err"); }
      }
    }

    if (saved.length) await log(`Files are in Downloads/${folder || ""}`, "ok");

    // Converter
    if (s.convert) {
      await log("Converter", "h");
      const labs = saved.filter((f) => f.kind === "labs");
      const quizzes = saved.filter((f) => f.kind === "quizzes");
      const d2l = saved.filter((f) => f.kind === "grades");
      if (labs.length !== 1) {
        await log(labs.length ? "Skipped: more than one CompTIA class — run convert.py by hand for each." :
                                "Skipped: the converter needs the CompTIA Labs download.", "err");
      } else if (d2l.length > 1) {
        await log("Skipped: more than one D2L course — run convert.py by hand for each.", "err");
      } else {
        let week = parseInt(s.week, 10);
        if (!(week > 0)) {
          const start = comptiaClasses[0]?.start;
          week = start ? Math.max(1, Math.floor((Date.now() - Date.parse(start)) / (7 * 864e5))) : 1;
          await log(`Week ${week} (completed weeks since class start; set Week to override)`);
        }
        const resp = await sendNative({
          action: "convert",
          labs: labs[0].path,
          quizzes: quizzes[0]?.path || null,
          d2l: d2l[0]?.path || null,        // helper falls back to d2l.csv next to the labs file
          week,
        });
        if (resp.ok) await log(`Converter started in a new window (${resp.dir}). Answer any student-match questions there; it writes d2l_import.csv.`, "ok");
        else if (/not found|forbidden|Specified native messaging host/i.test(resp.error || ""))
          await log("The Windows helper isn't installed yet — run native\\install.cmd once (see README).", "err");
        else await log("Converter: " + resp.error, "err");
      }
    }
    await log("Done.", "ok");
  } catch (e) {
    await log(e.message || String(e), "err");
  } finally {
    await setRunning(false);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "run") {
    chrome.storage.session.get("running").then(({ running }) => {
      if (running) return reply({ ok: false, error: "Already running" });
      getSettings().then(runJob);
      reply({ ok: true });
    });
    return true;
  }
  if (msg?.type === "tablog") log("  " + msg.text);
  if (msg?.type === "defaults") { reply(DEFAULT_SETTINGS); return false; }
});

// A crashed/stopped worker must not leave the popup stuck on "running".
chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ running: false }));
chrome.runtime.onInstalled.addListener(() => chrome.storage.session.set({ running: false }));
