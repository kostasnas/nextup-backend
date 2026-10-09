// Client for /tools/release-cards: loads upcoming releases and draws each one
// as a 1080x1350 card on a <canvas>, so the PNG is made on the person's own
// device (no server-side image rendering, no fonts to install).
(function () {
  "use strict";
  var W = 1080, H = 1350;
  var ACCENT = "#E8A33D";
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  var grid = document.getElementById("grid");
  var statusEl = document.getElementById("status");
  var filtersEl = document.getElementById("filters");
  var kindsEl = document.getElementById("kinds");
  var daysEl = document.getElementById("days");
  var activeCategory = "all";
  var activeKind = "all";
  var sortKey = "popularity";
  var data = null;
  var langEl = document.getElementById("lang");
  var ui = null; // card text for the current language, sent by the server with the data
  try { var savedLang = localStorage.getItem("rc_lang"); if (savedLang === "en" || savedLang === "pt") langEl.value = savedLang; } catch (e) { /* storage blocked: default stays */ }
  var qEl = document.getElementById("q");
  var searchItems = null; // null = showing the release list; an array = showing title-search results
  langEl.addEventListener("change", function () {
    try { localStorage.setItem("rc_lang", langEl.value); } catch (e) { /* ignore */ }
    if (searchItems !== null) doSearch(); else load();
  });
  document.getElementById("searchBtn").addEventListener("click", doSearch);
  qEl.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });

  // Search any title (even one that is not in the release list, e.g. something already out).
  function doSearch() {
    var q = qEl.value.trim();
    if (q.length < 2) { searchItems = null; if (data) { renderFilters(); render(); } else load(); return; }
    statusEl.textContent = "Αναζήτηση…";
    statusEl.style.display = "block";
    grid.innerHTML = "";
    fetch("/tools/release-cards-search.json?q=" + encodeURIComponent(q) + "&lang=" + encodeURIComponent(langEl.value))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Σφάλμα"); return j; }); })
      .then(function (j) { searchItems = j.items; ui = j.ui; renderFilters(); render(); })
      .catch(function (e) { statusEl.textContent = "Δεν φορτώθηκε: " + e.message; });
  }

  document.getElementById("reload").addEventListener("click", function () { searchItems = null; qEl.value = ""; load(); });
  daysEl.addEventListener("change", load);
  document.getElementById("sort").addEventListener("change", function (e) { sortKey = e.target.value; if (data) render(); });

  function load() {
    statusEl.textContent = "Φόρτωση…";
    statusEl.style.display = "block";
    grid.innerHTML = "";
    fetch("/tools/release-cards.json?days=" + encodeURIComponent(daysEl.value) + "&lang=" + encodeURIComponent(langEl.value))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Σφάλμα"); return j; }); })
      .then(function (j) { data = j; ui = j.ui; renderFilters(); render(); })
      .catch(function (e) { statusEl.textContent = "Δεν φορτώθηκε: " + e.message; });
  }

  var KIND_CHIPS = [["all", "Όλα"], ["premiere", "Πρεμιέρες"], ["season", "Νέες σεζόν"], ["episode", "Νέα επεισόδια"]];

  function renderFilters() {
    var searching = searchItems !== null;
    kindsEl.style.display = searching ? "none" : "flex";
    filtersEl.style.display = searching ? "none" : "flex";
    if (searching || !data) return;
    kindsEl.innerHTML = "";
    KIND_CHIPS.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "chip" + (c[0] === activeKind ? " on" : "");
      b.textContent = c[1];
      b.addEventListener("click", function () { activeKind = c[0]; renderFilters(); render(); });
      kindsEl.appendChild(b);
    });

    var cats = [["all", "Όλα"]];
    var seen = {};
    data.items.forEach(function (it) { if (!seen[it.category]) { seen[it.category] = 1; cats.push([it.category, it.categoryLabel]); } });
    filtersEl.innerHTML = "";
    cats.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "chip" + (c[0] === activeCategory ? " on" : "");
      b.textContent = c[1];
      b.addEventListener("click", function () { activeCategory = c[0]; renderFilters(); render(); });
      filtersEl.appendChild(b);
    });
  }

  function render() {
    grid.innerHTML = "";
    var searching = searchItems !== null;
    var items = (searching ? searchItems : data.items).filter(function (it) {
      return searching || ((activeCategory === "all" || it.category === activeCategory) && (activeKind === "all" || it.kind === activeKind));
    });
    if (!searching) items.sort(function (a, b) {
      if (sortKey === "rating") return (b.rating || 0) - (a.rating || 0) || b.popularity - a.popularity;
      if (sortKey === "date") return a.date.localeCompare(b.date) || b.popularity - a.popularity;
      return b.popularity - a.popularity;
    });
    if (!items.length) { statusEl.textContent = searching ? "Δεν βρέθηκε τίτλος με αυτό το όνομα." : "Δεν βρέθηκαν τίτλοι σε αυτό το διάστημα."; statusEl.style.display = "block"; return; }
    statusEl.style.display = "none";
    items.forEach(function (it) { grid.appendChild(buildCard(it)); });
  }

  // ---- card UI ----------------------------------------------------------

  function buildCard(item) {
    var el = document.createElement("div");
    el.className = "card";

    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    el.appendChild(canvas);
    drawCard(canvas, item);

    var meta = document.createElement("div");
    meta.className = "meta";
    var score = item.rating !== null ? "★ " + item.rating + " (" + item.votes + " ψήφοι)" : "χωρίς βαθμολογία ακόμα";
    meta.textContent = item.categoryLabel + " · " + item.dateLong + " · " + score + " · δημοφιλία " + item.popularity;
    el.appendChild(meta);

    // One tap to see where it streams in Brazil, instead of typing the title.
    var g = document.createElement("a");
    g.href = "https://www.google.com/search?q=" + encodeURIComponent(item.title + " " + ui.googleWhere) + "&gl=" + ui.gl + "&hl=" + ui.hl; // results as seen from the audience's country
    g.target = "_blank"; g.rel = "noopener";
    g.className = "gsearch";
    g.textContent = "Αναζήτηση στο Google ↗";
    el.appendChild(g);

    item.warnings.forEach(function (w) {
      var d = document.createElement("div"); d.className = "warn"; d.textContent = "⚠ " + w; el.appendChild(d);
    });

    // TMDB often doesn't know the platform yet. Type it here (after checking Google) and the
    // card and the caption update.
    var plat = document.createElement("input");
    plat.type = "text";
    plat.placeholder = "Πλατφόρμα (π.χ. Netflix)";
    plat.value = item.platforms.join(", ");
    plat.className = "plat";
    el.appendChild(plat);

    var ta = document.createElement("textarea");
    ta.value = item.caption;
    el.appendChild(ta);

    var curWhere = item.platforms.length ? ui.whereCaption + item.platforms.join(", ") + "." : "";
    plat.addEventListener("input", function () {
      var v = plat.value.trim();
      item.platforms = v ? v.split(/\s*,\s*/).filter(Boolean) : [];
      redraw(canvas, item);
      var newWhere = item.platforms.length ? ui.whereCaption + item.platforms.join(", ") + "." : "";
      var c = ta.value;
      var at = item.captionHead ? c.indexOf(item.captionHead) : -1;
      if (at === 0) {
        var rest = c.slice(item.captionHead.length);
        if (curWhere && rest.indexOf(curWhere) === 0) rest = rest.slice(curWhere.length);
        ta.value = item.captionHead + newWhere + rest;
        curWhere = newWhere;
      }
      updateCount();
    });

    // The synopsis comes from TMDB and is not always a good hook, so it is off by default.
    if (item.synopsis) {
      var synLabel = document.createElement("label");
      synLabel.className = "meta";
      var syn = document.createElement("input");
      syn.type = "checkbox";
      syn.style.marginInlineEnd = "6px";
      syn.addEventListener("change", function () {
        var c = ta.value;
        if (c.indexOf(item.captionHead) !== 0) return; // caption was rewritten by hand: leave it alone
        var rest = c.slice(item.captionHead.length);
        if (curWhere && rest.indexOf(curWhere) === 0) rest = rest.slice(curWhere.length);
        var add = " " + item.synopsis;
        if (syn.checked) { if (rest.indexOf(add) !== 0) rest = add + rest; }
        else if (rest.indexOf(add) === 0) rest = rest.slice(add.length);
        ta.value = item.captionHead + curWhere + rest;
        updateCount();
      });
      synLabel.appendChild(syn);
      synLabel.appendChild(document.createTextNode("Προσθήκη περίληψης στο caption"));
      el.appendChild(synLabel);
    }

    var count = document.createElement("div");
    count.className = "count";
    function updateCount() { count.textContent = countTweet(ta.value) + " / 280"; }
    ta.addEventListener("input", updateCount); updateCount();
    el.appendChild(count);

    var row = document.createElement("div"); row.className = "row";
    var copy = document.createElement("button"); copy.textContent = "Αντιγραφή caption";
    copy.addEventListener("click", function () { copyText(ta, copy); });
    var save = document.createElement("button"); save.className = "primary"; save.textContent = "Εικόνα (κοινοποίηση / λήψη)";
    save.addEventListener("click", function () { saveImage(canvas, item, ta.value, save); });
    row.appendChild(copy); row.appendChild(save);
    el.appendChild(row);
    return el;
  }

  function countTweet(s) {
    var n = 0;
    for (var ch of s) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
    return n;
  }

  function flash(btn, text) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1600);
  }

  function copyText(ta, btn) {
    var done = function () { flash(btn, "Αντιγράφηκε ✓"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand("copy"); done(); });
    } else { ta.select(); document.execCommand("copy"); done(); }
  }

  function saveImage(canvas, item, caption, btn) {
    canvas.toBlob(function (blob) {
      if (!blob) { flash(btn, "Δεν δημιουργήθηκε"); return; }
      var name = "scenera-" + item.id + ".png";
      var file = new File([blob], name, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], text: caption }).catch(function () {});
        return;
      }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      flash(btn, "Κατέβηκε ✓");
    }, "image/png");
  }

  // ---- canvas drawing ------------------------------------------------------

  function loadImage(url) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var img = new Image();
      img.crossOrigin = "anonymous"; // keeps the canvas exportable; if CORS fails we draw without the poster
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapLines(ctx, text, maxWidth) {
    var words = text.split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      var test = line ? line + " " + w : w;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else { lines.push(line); line = w; }
    });
    if (line) lines.push(line);
    return lines;
  }

  // Largest font size (from `start` down to `min`) at which the title fits in `maxLines`.
  function fitTitle(ctx, text, maxWidth, maxLines, start, min) {
    for (var size = start; size >= min; size -= 4) {
      ctx.font = "800 " + size + "px " + FONT;
      var lines = wrapLines(ctx, text, maxWidth);
      if (lines.length <= maxLines) return { size: size, lines: lines };
    }
    ctx.font = "800 " + min + "px " + FONT;
    var all = wrapLines(ctx, text, maxWidth).slice(0, maxLines);
    var last = all[all.length - 1];
    while (last.length > 1 && ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    all[all.length - 1] = last + "…";
    return { size: min, lines: all };
  }

  function drawCover(ctx, img, x, y, w, h) {
    var s = Math.max(w / img.width, h / img.height);
    var dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function infoRow(ctx, y, label, value) {
    var x = 90;
    ctx.textBaseline = "alphabetic";
    ctx.font = "700 26px " + FONT;
    ctx.fillStyle = ACCENT;
    ctx.fillText(label.toUpperCase(), x, y);
    var lw = ctx.measureText(label.toUpperCase()).width;
    ctx.font = "600 36px " + FONT;
    ctx.fillStyle = "#f4f4f7";
    var maxW = W - x - 90 - lw - 24;
    var v = value;
    while (v.length > 1 && ctx.measureText(v).width > maxW) v = v.slice(0, -1);
    if (v !== value) v = v.replace(/\s+$/, "") + "…";
    ctx.fillText(v, x + lw + 24, y);
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function drawCard(canvas, item) {
    var ctx = canvas.getContext("2d");
    // Paint something immediately, then redraw once the poster arrives.
    paint(ctx, item, null);
    loadImage(item.posterUrl).then(function (img) { if (img) { item._poster = img; paint(ctx, item, img); } });
  }

  function redraw(canvas, item) { paint(canvas.getContext("2d"), item, item._poster || null); }

  function paint(ctx, item, poster) {
    ctx.clearRect(0, 0, W, H);

    // background
    ctx.fillStyle = "#0e0f14";
    ctx.fillRect(0, 0, W, H);
    if (poster) {
      try {
        ctx.save();
        ctx.filter = "blur(36px) saturate(1.2)";
        drawCover(ctx, poster, -80, -80, W + 160, H + 160);
        ctx.restore();
      } catch (e) { /* ctx.filter unsupported: keep the plain background */ }
    }
    var shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, "rgba(14,15,20,0.70)");
    shade.addColorStop(0.55, "rgba(14,15,20,0.86)");
    shade.addColorStop(1, "rgba(14,15,20,0.97)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);

    // category chip + "estreia" label
    ctx.font = "800 28px " + FONT;
    var label = item.categoryLabel.toUpperCase();
    var cw = ctx.measureText(label).width + 48;
    ctx.fillStyle = ACCENT;
    roundRect(ctx, 90, 70, cw, 56, 28); ctx.fill();
    ctx.fillStyle = "#1a1405";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 114, 99);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "700 28px " + FONT;
    ctx.fillText((item.kindTag + " " + item.when.replace(/\s*\(.*\)/, "")).trim().toUpperCase(), W - 90, 99);
    ctx.textAlign = "left";

    // poster
    var px = (W - 450) / 2, py = 170, pw = 450, ph = 675;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 50; ctx.shadowOffsetY = 20;
    roundRect(ctx, px, py, pw, ph, 26);
    ctx.fillStyle = "#1c1e29"; ctx.fill();
    ctx.restore();
    if (poster) {
      ctx.save();
      roundRect(ctx, px, py, pw, ph, 26); ctx.clip();
      drawCover(ctx, poster, px, py, pw, ph);
      ctx.restore();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "600 30px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(ui.noPoster, W / 2, py + ph / 2); ctx.textAlign = "left";
    }

    // title
    var t = fitTitle(ctx, item.title, W - 180, 2, 76, 44);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "alphabetic";
    ctx.font = "800 " + t.size + "px " + FONT;
    var ty = 925;
    t.lines.forEach(function (ln, i) { ctx.fillText(ln, 90, ty + i * (t.size * 1.08)); });

    // info rows
    var iy = ty + (t.lines.length - 1) * t.size * 1.08 + 80;
    infoRow(ctx, iy, item.kindLabel, capitalize(item.dateLong));
    iy += 64;
    infoRow(ctx, iy, ui.whereLabel, item.platforms.length ? item.platforms.join(" · ") : ui.whereTbc);
    if (item.kind === "episode") { iy += 64; infoRow(ctx, iy, ui.episodeLabel, item.episode + " (" + ui.seasonOf + " " + item.season + ")"); }
    else if (item.kind === "season") { iy += 64; infoRow(ctx, iy, ui.seasonLabel, String(item.season)); }
    else if (item.episodes) { iy += 64; infoRow(ctx, iy, ui.episodesLabel, String(item.episodes)); }

    // footer
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(90, H - 112, W - 180, 2);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = ACCENT;
    ctx.font = "800 40px " + FONT;
    ctx.fillText("Scenera", 90, H - 56);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "600 28px " + FONT;
    ctx.fillText(ui.footer, W - 90, H - 58);
    ctx.font = "500 20px " + FONT;
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText(ui.credit, W - 90, H - 24);
    ctx.textAlign = "left";
  }

  load();
})();
