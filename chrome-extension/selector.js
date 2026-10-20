// Pick / Pattern list. One component for roles, courses, students and grade items.
//
//   Selector.render(container, {
//     items: [{ id, name, text? }],           // text = what the pattern is tested on (default: name)
//     rule, onChange(rule),
//     columns: [{ title, cell(item) -> string | Node }],
//     groupBy?(item) -> heading, categoryOf?(item) -> category (for pattern suggestions),
//     noun: "items", emptyText
//   })
//
// Pick:    tick rows.  Pattern: a regex selects rows (highlighted); ticking/unticking a row
// adds an exception. Switching views keeps the current selection.

(function (root) {
  const h = (tag, props = {}, ...kids) => {
    const el = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  };

  function render(container, o) {
    let rule = JSON.parse(JSON.stringify(o.rule || Select.emptyRule()));
    let filter = "";
    const items = o.items || [];
    const set = (r) => { rule = r; draw(); o.onChange(rule); };

    function draw() {
      container.replaceChildren();
      const res = Select.apply(rule, items);
      const box = h("div", { className: "sel" });

      // toolbar
      const bar = h("div", { className: "bar" });
      const seg = h("span", { className: "seg" },
        h("button", { textContent: "Pick", className: rule.mode === "pick" ? "on" : "", onclick: () => set(Select.switchMode(rule, "pick", items)) }),
        h("button", { textContent: "Pattern", className: rule.mode === "pattern" ? "on" : "", onclick: () => set(Select.switchMode(rule, "pattern", items)) }));
      bar.append(seg);
      if (rule.mode === "pattern") {
        const pat = h("input", { type: "text", className: "pat", value: rule.pattern || "", placeholder: "regular expression, e.g. ^Week \\d+", spellcheck: false });
        pat.addEventListener("change", () => set({ ...rule, pattern: pat.value.trim() }));
        pat.addEventListener("keydown", (e) => { if (e.key === "Enter") pat.blur(); });
        bar.append(pat);
        const exc = (rule.include?.length || 0) + (rule.exclude?.length || 0);
        if (exc) bar.append(h("button", { textContent: `Clear ${exc} exception${exc > 1 ? "s" : ""}`, onclick: () => set({ ...rule, include: [], exclude: [] }) }));
      } else {
        const search = h("input", { type: "text", className: "pat", value: filter, placeholder: "filter the list…" });
        search.addEventListener("input", () => { filter = search.value; drawRows(); });
        bar.append(search,
          h("button", { textContent: "All", onclick: () => set({ ...rule, include: items.map((i) => ({ id: String(i.id), name: i.name })) }) }),
          h("button", { textContent: "None", onclick: () => set({ ...rule, include: [] }) }));
        if (res.selected.size)
          bar.append(h("button", { textContent: "Make a pattern from my picks", title: "Switch to Pattern with a regex that selects exactly these",
            onclick: () => { const p = Select.suggestPattern(items, res.selected, o.categoryOf); set({ mode: "pattern", pattern: p, include: [], exclude: [] }); } }));
      }
      bar.append(h("span", { className: "count", textContent: `${res.selected.size} of ${items.length} ${o.noun || "selected"}` }));
      box.append(bar);
      if (res.error) box.append(h("div", { className: "perr", textContent: res.error }));

      const scroll = h("div", { className: "scroll" });
      box.append(scroll);
      container.append(box);

      function drawRows() {
        scroll.replaceChildren();
        if (!items.length) { scroll.append(h("div", { className: "empty", textContent: o.emptyText || "Nothing to show yet." })); return; }
        const cols = o.columns || [];
        const table = h("table", {}, h("thead", {}, h("tr", {}, h("th", { style: "width:28px" }), h("th", { textContent: o.nameTitle || "Name" }), cols.map((c) => h("th", { textContent: c.title })))));
        const tb = h("tbody");
        let group = null;
        const f = filter.toLowerCase();
        for (const it of items) {
          if (rule.mode === "pick" && f && !((it.text ?? it.name).toLowerCase().includes(f))) continue;
          if (o.groupBy) {
            const g = o.groupBy(it);
            if (g !== group) { group = g; tb.append(h("tr", { className: "group" }, h("td", { colSpan: cols.length + 2, textContent: g || "(none)" }))); }
          }
          const id = String(it.id), on = res.selected.has(id), hit = res.matched.has(id);
          const cb = h("input", { type: "checkbox", checked: on });
          cb.addEventListener("change", () => set(Select.toggle(rule, it, cb.checked, items)));
          const name = h("td", {}, it.name);
          if (rule.mode === "pattern" && on !== hit) name.append(h("span", { className: "tag", textContent: on ? "added" : "excluded" }));
          if (res.byName.has(id)) name.append(h("span", { className: "tag warn", textContent: "matched by name", title: "Picked in another course with the same name — check it" }));
          tb.append(h("tr", { className: rule.mode === "pattern" && hit ? "hit" : "" }, h("td", {}, cb), name, cols.map((c) => h("td", {}, c.cell(it) ?? ""))));
        }
        table.append(tb);
        scroll.append(table);
      }
      drawRows();
    }
    draw();
  }

  root.Selector = { render, h };
})(window);
