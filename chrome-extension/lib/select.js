// Pick / Pattern selection rules, shared by courses, roles, students, grade items
// (and the Python script implements the same rules).
//
// A rule is   { mode: "pick" | "pattern", pattern: "", include: [{id, name}], exclude: [{id, name}] }
//
//   pick    -> selected = include
//   pattern -> selected = (items whose text matches the regex, case-insensitive) + include - exclude
//
// include/exclude entries keep the item's name too: when an id isn't found (for example in
// next term's copy of a course, where D2L gives every item a new id) the entry falls back to
// an exact name match, and the item is reported in `byName` so the UI can flag it.

(function (root) {
  const emptyRule = (mode = "pattern", pattern = "") => ({ mode, pattern, include: [], exclude: [] });

  function compile(pattern) {
    if (!pattern) return null;
    try { return new RegExp(pattern, "i"); }
    catch (e) { const err = new Error(`Invalid pattern "${pattern}": ${e.message}`); err.badPattern = true; throw err; }
  }

  // Find which items an include/exclude list refers to: by id first, then by exact name.
  function resolveRefs(refs, items) {
    const ids = new Set(), byName = new Set();
    const idIndex = new Map(items.map((it) => [String(it.id), it]));
    for (const r of refs || []) {
      if (idIndex.has(String(r.id))) { ids.add(String(r.id)); continue; }
      const hit = items.find((it) => it.name === r.name);
      if (hit) { ids.add(String(hit.id)); byName.add(String(hit.id)); }
    }
    return { ids, byName };
  }

  // items: [{ id, name, text? }]  (text defaults to name; it's what the pattern is tested on)
  // returns { selected: Set<string id>, matched: Set (pattern hits), byName: Set, error? }
  function apply(rule, items) {
    rule = rule || emptyRule();
    const inc = resolveRefs(rule.include, items);
    if (rule.mode === "pick") return { selected: inc.ids, matched: new Set(), byName: inc.byName };
    let re;
    try { re = compile(rule.pattern); }
    catch (e) { return { selected: inc.ids, matched: new Set(), byName: inc.byName, error: e.message }; }
    const exc = resolveRefs(rule.exclude, items);
    const matched = new Set(re ? items.filter((it) => re.test(it.text ?? it.name)).map((it) => String(it.id)) : []);
    const selected = new Set([...matched, ...inc.ids].filter((id) => !exc.ids.has(id) || inc.ids.has(id)));
    for (const id of exc.ids) if (!inc.ids.has(id)) selected.delete(id);
    return { selected, matched, byName: new Set([...inc.byName, ...exc.byName]) };
  }

  const ref = (it) => ({ id: String(it.id), name: it.name });
  const without = (list, it) => (list || []).filter((r) => String(r.id) !== String(it.id) && r.name !== it.name);

  // Tick or untick one row; returns a new rule. In pattern mode this records an exception.
  function toggle(rule, item, checked, items) {
    const r = { ...emptyRule(), ...rule, include: [...(rule.include || [])], exclude: [...(rule.exclude || [])] };
    if (r.mode === "pick") {
      r.include = without(r.include, item);
      if (checked) r.include.push(ref(item));
      return r;
    }
    let matches = false;
    try { const re = compile(r.pattern); matches = !!re && re.test(item.text ?? item.name); } catch { /* bad pattern: nothing matches */ }
    r.include = without(r.include, item);
    r.exclude = without(r.exclude, item);
    if (checked && !matches) r.include.push(ref(item));
    if (!checked && matches) r.exclude.push(ref(item));
    return r;
  }

  // Switching views keeps exactly the current selection.
  function switchMode(rule, mode, items) {
    if (rule.mode === mode) return rule;
    if (mode === "pick") {
      const { selected } = apply(rule, items);
      return { ...rule, mode, include: items.filter((it) => selected.has(String(it.id))).map(ref), exclude: [] };
    }
    // pick -> pattern: keep the pattern, but exclude whatever it matches that isn't picked,
    // so the selection is unchanged until you edit the pattern.
    const picked = resolveRefs(rule.include, items).ids;
    let re = null;
    try { re = compile(rule.pattern); } catch { /* invalid pattern matches nothing */ }
    const exclude = re ? items.filter((it) => re.test(it.text ?? it.name) && !picked.has(String(it.id))).map(ref) : [];
    return { ...rule, mode, exclude };
  }

  // Propose a regex that selects exactly the picked items (checked against the same text
  // patterns are tested on; items flagged `inert` don't count either way). Candidates, simplest first:
  //   whole categories   -> ^(Cat A|Cat B)\b
  //   shared prefix      -> \bPrefix
  //   explicit list      -> (Name 1|Name 2|…)$
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function suggestPattern(items, selectedIds, categoryOf) {
    const sel = items.filter((it) => selectedIds.has(String(it.id)));
    if (!sel.length) return "";
    const exact = (p) => {
      try { const re = compile(p); return items.every((it) => it.inert || re.test(it.text ?? it.name) === selectedIds.has(String(it.id))); }
      catch { return false; }
    };
    const cands = [];
    if (categoryOf) {
      const cats = [...new Set(sel.map(categoryOf))].filter(Boolean);
      if (cats.length) cands.push(`^(${cats.map(esc).join("|")})\\b`);
    }
    let prefix = sel[0].name;
    for (const it of sel) while (prefix && !it.name.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.trim().length >= 3) cands.push("\\b" + esc(prefix.trimEnd()));
    cands.push(`(${sel.map((it) => esc(it.name)).join("|")})$`);
    return cands.find(exact) || cands[cands.length - 1];
  }

  const api = { emptyRule, apply, toggle, switchMode, suggestPattern, compile };
  root.Select = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
