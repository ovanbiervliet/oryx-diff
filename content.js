/* Oryx Diff v0.1.17
 * Runs in the page's own context so it can reuse the GraphQL requests Oryx already makes
 * (same endpoint, same auth headers). Nothing leaves your browser except calls to Oryx itself.
 */
(() => {
  'use strict';

  const VERSION = '0.1.17'; // keep in sync with manifest.json (chrome.runtime isn't available in the page's context)
  const DEFAULT_ENDPOINT = 'https://oryx.zsa.io/graphql';
  const GEOMETRIES = ['voyager', 'moonlander', 'ergodox-ez', 'planck-ez', 'glow'];
  const captures = []; // {url, headers, operationName, query, variables, data}
  const log = [];
  const dbg = (...a) => { log.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (log.length > 200) log.shift(); };

  /* ---------- 1. Passive capture of Oryx's own GraphQL traffic ---------- */
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    let url = '', headers = {}, bodyText = null;
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (/graphql/i.test(url)) {
        const h = (init && init.headers) || (input && input.headers);
        if (h) headers = h instanceof Headers ? Object.fromEntries(h.entries()) : { ...h };
        if (init && typeof init.body === 'string') bodyText = init.body;
        else if (input instanceof Request) bodyText = await input.clone().text();
      }
    } catch (e) { /* ignore */ }
    const res = await origFetch.apply(this, arguments);
    try {
      if (bodyText && /graphql/i.test(url)) {
        const req = JSON.parse(bodyText);
        const reqs = Array.isArray(req) ? req : [req];
        const data = await res.clone().json();
        reqs.forEach((r, i) => captures.push({
          url, headers, operationName: r.operationName, query: r.query,
          variables: r.variables || {}, data: Array.isArray(data) ? data[i] : data,
        }));
        if (captures.length > 60) captures.splice(0, captures.length - 60);
      }
    } catch (e) { /* ignore non-JSON */ }
    return res;
  };

  /* ---------- 2. Helpers ---------- */
  const layoutHash = () => (location.pathname.match(/\/(?:my-layouts|layouts?)\/([A-Za-z0-9]+)/) || [])[1] || null;
  // Revision shown in the layout view: /<geometry>/layouts/<layout>/<revision>/<layer>. null on pages without one, or for "latest".
  const urlRevision = () => {
    const r = (location.pathname.match(/\/layouts\/[A-Za-z0-9]+\/([A-Za-z0-9]+)/) || [])[1] || null;
    return r === 'latest' ? null : r;
  };
  const endpoint = () => {
    const c = [...captures].reverse().find(x => x.variables && x.variables.hashId) || captures[captures.length - 1];
    return c ? c.url : DEFAULT_ENDPOINT;
  };
  // Reuse the exact headers Oryx itself sent (auth token etc.), minus ones the browser must set.
  const authHeaders = () => {
    const c = [...captures].reverse().find(x => x.variables && x.variables.hashId && x.headers && Object.keys(x.headers).length)
      || [...captures].reverse().find(x => x.headers && Object.keys(x.headers).length);
    const out = {};
    Object.entries((c && c.headers) || {}).forEach(([k, v]) => {
      if (!/^(content-length|host|origin|referer|cookie)$/i.test(k)) out[k.toLowerCase()] = v;
    });
    return out;
  };
  const gql = async (query, variables, operationName) => {
    const url = endpoint();
    let res;
    try {
      res = await origFetch(url, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables, operationName }),
      });
    } catch (e) {
      dbg('network error', url, 'headers:', Object.keys(authHeaders()).join(','), e.message);
      throw e;
    }
    const json = await res.json();
    if (json.errors && !json.data) throw new Error(json.errors.map(e => e.message).join('; '));
    return json.data;
  };
  const deepFind = (obj, pred, out = [], depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 12) return out;
    if (pred(obj)) out.push(obj);
    for (const v of Object.values(obj)) deepFind(v, pred, out, depth + 1);
    return out;
  };
  // Layout objects (e.g. items of `myLayouts`) look like {hashId, geometry, revisions:[...]}. Pick the one for this URL.
  const currentLayoutObjects = () => {
    const hash = layoutHash();
    const out = [];
    captures.forEach(c => deepFind(c.data, o => hash && o.hashId === hash && (Array.isArray(o.revisions) || typeof o.geometry === 'string')).forEach(o => out.push(o)));
    return out;
  };
  const geometryHint = () => {
    const fromLayout = currentLayoutObjects().find(o => typeof o.geometry === 'string');
    if (fromLayout) return fromLayout.geometry;
    for (let i = captures.length - 1; i >= 0; i--) {
      const g = captures[i].variables && captures[i].variables.geometry;
      if (g) return g;
    }
    return null;
  };

  /* ---------- 3. Revisions ---------- */
  const looksLikeRevisionList = o => Array.isArray(o) && o.length > 0 &&
    o.every(x => x && typeof x === 'object' && x.hashId && x.createdAt);
  const harvestRevisions = () => {
    const map = new Map();
    const add = r => map.set(r.hashId, { hashId: r.hashId, title: r.title || '', createdAt: r.createdAt });
    // Only revisions that belong to the layout in the URL (the page's data holds ALL your layouts).
    currentLayoutObjects().forEach(l => { if (looksLikeRevisionList(l.revisions)) l.revisions.forEach(add); });
    // plus anything returned by queries that were explicitly about this layout (editor page, history view)
    const hash = layoutHash();
    captures.forEach(c => {
      if (!(c.query && c.query.includes(hash)) && !(c.variables && c.variables.hashId === hash)) return;
      deepFind(c.data, o => o.hashId && o.createdAt && o.layers).forEach(add);
      (function walk(o, d) {
        if (!o || typeof o !== 'object' || d > 12) return;
        if (looksLikeRevisionList(o)) o.forEach(add);
        Object.values(o).forEach(v => walk(v, d + 1));
      })(c.data, 0);
    });
    return [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  };

  const fetchRevisionList = async () => {
    if (!layoutHash()) throw new Error('Open a layout first (URL should contain the layout hash).');
    let revs = harvestRevisions();
    if (!revs.length) {
      try {
        const q = '{myLayouts{hashId title geometry revisions{hashId title createdAt}}}';
        const data = await gql(q, {});
        captures.push({ url: endpoint(), headers: {}, operationName: 'myLayouts', query: q, variables: {}, data: { data } });
        dbg('revision list fetched via myLayouts');
        revs = harvestRevisions();
      } catch (e) { dbg('myLayouts fallback failed', e.message); }
    }
    if (!revs.length) throw new Error('No revisions seen yet. Open the layout\'s History in Oryx once, then press the refresh button here.');
    return revs;
  };

  /* ---------- 4. Revision content ---------- */
  const cache = new Map();
  const extractLayers = data => {
    const holders = deepFind(data, o => Array.isArray(o.layers) && o.layers.length && o.layers.every(l => l && typeof l === 'object' && 'keys' in l));
    if (!holders.length) return null;
    const layers = holders[0].layers.map((l, i) => {
      let keys = l.keys;
      if (typeof keys === 'string') { try { keys = JSON.parse(keys); } catch (e) { keys = []; } }
      return { title: l.title || `Layer ${i}`, position: l.position ?? i, keys: Array.isArray(keys) ? keys : Object.values(keys || {}) };
    });
    const g = deepFind(data, o => typeof o.geometry === 'string')[0];
    layers.meta = { geometry: (g && g.geometry) || holders[0].geometry || null };
    return layers;
  };
  const probeSchema = async () => {
    try {
      const d = await gql('{a:__type(name:"Layout"){fields{name}} b:__type(name:"Revision"){fields{name}} c:__type(name:"Layer"){fields{name}}}', {});
      dbg('schema', JSON.stringify(d, (k, v) => (v && v.fields ? v.fields.map(f => f.name).join(',') : v)));
    } catch (e) { dbg('schema probe failed', e.message); }
  };
  const fetchRevision = async hashId => {
    const hash = layoutHash();
    const ck = hash + ':' + hashId;
    if (cache.has(ck)) return cache.get(ck);
    const geos = [geometryHint(), ...GEOMETRIES].filter((g, i, a) => g && a.indexOf(g) === i);
    let layers = null, lastErr = null;

    // a) reuse the exact query Oryx itself uses to load this layout, swapping in the revision id.
    //    Oryx inlines its arguments in the query text, so patch the text (or variables if present).
    const tpls = [...captures].reverse().filter(c => c.query && /revisionId/.test(c.query + JSON.stringify(c.variables || {})) &&
      (c.query.includes(hash) || (c.variables && c.variables.hashId === hash)));
    for (const tpl of tpls) {
      try {
        const vars = { ...(tpl.variables || {}) };
        let query = tpl.query;
        if ('revisionId' in vars) vars.revisionId = hashId;
        else query = query.replace(/revisionId\s*:\s*"[^"]*"/, 'revisionId:"' + hashId + '"');
        const data = await gql(query, vars, tpl.operationName);
        layers = extractLayers(data);
        if (layers) { dbg('revision', hashId, 'loaded via captured query'); break; }
      } catch (e) { lastErr = e; dbg('template fetch failed', e.message); }
    }
    // b) fall back to our own query (field names corrected: `layout`, `revision`)
    if (!layers) {
      const q = 'query($hashId:String!,$geometry:String,$revisionId:String!){layout(hashId:$hashId,geometry:$geometry,revisionId:$revisionId){hashId revision{hashId title createdAt layers{title position keys}}}}';
      for (const geometry of geos) {
        try {
          layers = extractLayers(await gql(q, { hashId: hash, geometry, revisionId: hashId }));
          if (layers) { dbg('revision', hashId, 'loaded via own query, geometry', geometry); break; }
        } catch (e) { lastErr = e; dbg('own query failed', geometry, e.message); }
      }
    }
    if (!layers) {
      await probeSchema();
      throw new Error('Could not load revision ' + hashId + (lastErr ? ': ' + lastErr.message : ''));
    }
    cache.set(ck, layers);
    return layers;
  };

  /* ---------- 5. Diff ---------- */
  const stable = v => {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && v[k] !== null).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  };
  const act = a => (a && typeof a === 'object' ? (a.code || a.macro || (a.layer != null ? 'layer ' + a.layer : '') || stable(a)) : a);
  const label = k => {
    if (k == null) return '—';
    if (typeof k !== 'object') return String(k);
    const parts = [];
    [['tap', ''], ['hold', 'hold '], ['doubleTap', '2× '], ['tapHold', 'tap-hold ']].forEach(([f, p]) => { if (k[f]) parts.push(p + act(k[f])); });
    if (k.customLabel) parts.push('“' + k.customLabel + '”');
    if (!parts.length && k.code) parts.push(act(k));
    return parts.join(' / ') || (stable(k).length > 40 ? stable(k).slice(0, 40) + '…' : stable(k));
  };
  const changedProps = (a, b) => {
    a = a || {}; b = b || {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => stable(a[p]) !== stable(b[p]));
  };
  const diffLayers = (A, B) => {
    const n = Math.max(A.length, B.length), out = [];
    for (let i = 0; i < n; i++) {
      const a = A[i], b = B[i];
      if (!a || !b) { out.push({ i, title: (a || b).title, status: a ? 'removed' : 'added', changes: [] }); continue; }
      const changes = [], m = Math.max(a.keys.length, b.keys.length);
      for (let k = 0; k < m; k++) {
        if (stable(a.keys[k]) !== stable(b.keys[k])) {
          changes.push({ idx: k, from: label(a.keys[k]), to: label(b.keys[k]), props: changedProps(a.keys[k], b.keys[k]) });
        }
      }
      out.push({ i, title: b.title, oldTitle: a.title !== b.title ? a.title : null, status: changes.length || a.title !== b.title ? 'changed' : 'same', changes, total: m });
    }
    return out;
  };


  /* ---------- 6. UI (shadow DOM so Oryx's CSS can't touch it) ---------- */
  const fmt = d => new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
  #fab{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483647;background:#4f46e5;color:#fff;border:0;border-radius:999px;padding:10px 16px;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
  #panel{position:fixed;left:50%;transform:translateX(-50%);bottom:64px;z-index:2147483647;width:520px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px;display:none}
  #panel.open{display:block}
  .title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
  h3{margin:0;font-size:14px}
  .s.q{width:24px;height:24px;padding:0;border-radius:50%;font-size:12px;color:#9ca3af}
  .s.q.on{background:#4f46e5;border-color:#4f46e5;color:#fff}
  #panel.nohelp .info,#panel.nohelp .help,#panel.nohelp details,#panel.nohelp .ver{display:none}
  .row{display:flex;gap:8px;margin-bottom:8px;align-items:center}
  label{width:62px;color:#9ca3af;font-size:12px}
  select{flex:1;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:6px;font-size:12px;min-width:0}
  .s{box-sizing:border-box;height:30px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;width:34px;flex:none;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:5px 9px;font-size:12px;cursor:pointer}
  .layer{border-top:1px solid #374151;padding:8px 0}
  .lh{font-weight:600;margin-bottom:6px}
  .badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;margin-left:6px;background:#78350f;color:#fde68a}
  .badge.added{background:#14532d;color:#bbf7d0}.badge.removed{background:#7f1d1d;color:#fecaca}
  .chg{display:flex;gap:8px;align-items:baseline;padding:3px 6px;margin:2px 0;border-radius:5px;background:#3b2f0b}
  .idx{color:#fbbf24;font-variant-numeric:tabular-nums;min-width:34px}
  .old{color:#fca5a5;text-decoration:line-through}.new{color:#86efac}.arrow{color:#9ca3af}
  .props{color:#9ca3af;font-size:11px;margin-left:auto}
  .warn{background:#78350f;color:#fde68a;padding:6px 8px;border-radius:6px;margin-bottom:8px;font-size:12px}
  .s.wide{width:auto;padding:0 10px}
  a.s:not([href]){opacity:.35;pointer-events:none}
  .info{color:#9ca3af;font-size:11px;margin:-2px 0 8px 42px;min-height:14px}
  .muted{color:#9ca3af}.err{color:#fca5a5;white-space:pre-wrap}
  details{margin-top:10px;color:#9ca3af;font-size:11px}
  pre{white-space:pre-wrap;max-height:160px;overflow:auto;background:#0b1220;padding:6px;border-radius:6px}
  `;

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <button id="fab">Diff revisions</button>
    <div id="panel">
      <div class="title"><h3>Oryx Diff <span class="ver">v${VERSION} </span><span id="lname" class="muted" style="font-weight:400"></span></h3>
        <button class="s q" id="help" title="Show or hide details">?</button></div>
      <div class="row"><button class="s" id="refresh" title="Reload revisions">↻</button><select id="to"></select><a class="s" id="eto" title="Open this revision in the layout view">✎</a></div>
      <div class="info" id="ito"></div>
      <div class="row"><button class="s" id="swap" title="Swap the two selections">⇅</button><select id="from"></select><a class="s" id="efrom" title="Open this revision in the layout view">✎</a></div>
      <div class="info" id="ifrom"></div>
      <div id="out" class="muted">Loading…</div>
      <details><summary>Debug</summary><pre id="dbg"></pre><button class="s wide" id="copy">Copy debug</button></details>
    </div>`;
  const $ = id => root.getElementById(id);
  const mount = () => { if (!host.isConnected && document.body) document.body.appendChild(host); };
  document.addEventListener('DOMContentLoaded', mount);
  new MutationObserver(mount).observe(document, { childList: true, subtree: true });

  let revs = [], loadedHash = null;
  // The revision loaded in the layout view counts as current; fall back to the newest one.
  const currentIdx = () => { const r = urlRevision(), i = r ? revs.findIndex(x => x.hashId === r) : -1; return i >= 0 ? i : 0; };
  const optionHtml = (r, i) => `<option value="${esc(r.hashId)}">${esc(fmt(r.createdAt))} · ${esc(r.title || r.hashId.slice(0, 6))}${i === currentIdx() ? ' (current)' : ''} [${esc(r.hashId)}]</option>`;
  // Re-label the options in place so the user's current selections are kept.
  const relabel = () => ['from', 'to'].forEach(id => {
    const sel = $(id), v = sel.value;
    sel.innerHTML = revs.map(optionHtml).join('');
    sel.value = v;
  });

  const run = async () => {
    const out = $('out');
    const a = $('from').value, b = $('to').value;
    if (!a || !b) return;
    out.className = 'muted'; out.textContent = 'Comparing…'; $('ito').innerHTML = ''; $('ifrom').innerHTML = ''; $('eto').removeAttribute('href'); $('efrom').removeAttribute('href');
    try {
      const [A, B] = await Promise.all([fetchRevision(a), fetchRevision(b)]);
      const d = diffLayers(A, B);
      const geo = geometryHint(), lh = layoutHash();
      const layerIdx = (location.pathname.match(/\/layouts\/[^/]+\/[^/]+\/(\d+)/) || [])[1] || '0';
      const info = L => {
        const counts = [...new Set(L.map(l => l.keys.length))];
        const keys = counts.length === 1 ? counts[0] + ' keys/layer' : 'keys/layer ' + L.map(l => l.keys.length).join(',');
        return `${L.length} layers · ${keys}`;
      };
      const setEdit = (el, id) => {
        if (geo && lh) { el.href = `/${geo}/layouts/${lh}/${id}/${layerIdx}`; el.title = 'Open revision ' + id + ' in the layout view'; }
        else el.removeAttribute('href');
      };
      $('ito').textContent = info(B);
      $('ifrom').textContent = info(A);
      setEdit($('eto'), b);
      setEdit($('efrom'), a);
      const sum = (L, id) => `${id.slice(0, 6)}: ${(L.meta && L.meta.geometry) || 'geometry ?'} · ${L.length} layers · keys/layer ${L.map(l => l.keys.length).join(',')}`;
      const mismatch = (A.meta.geometry && B.meta.geometry && A.meta.geometry !== B.meta.geometry) ||
        A.length !== B.length || A.some((l, i) => B[i] && B[i].keys.length !== l.keys.length);
      [[A, a], [B, b]].forEach(([L, id]) => dbg(sum(L, id), '| layer0 sample:', JSON.stringify(L[0] && L[0].keys.slice(0, 2))));
      const changedLayers = d.filter(l => l.status !== 'same');
      const total = d.reduce((s, l) => s + l.changes.length, 0);
      let html = `<div class="muted help" style="font-size:11px;margin-bottom:6px">Arrows show the lower selection → the upper one.</div>` +
        (mismatch ? '<div class="warn">These revisions have a different key layout (geometry or key count), so a key-by-key diff is not reliable.</div>' : '') +
        `<div style="margin-bottom:6px"><b>${total}</b> key${total === 1 ? '' : 's'} changed across <b>${changedLayers.length}</b> of ${d.length} layers.</div>`;
      changedLayers.forEach(l => {
        html += `<div class="layer"><div class="lh">${l.i}: ${esc(l.title)}${l.oldTitle ? ` <span class="muted">(was “${esc(l.oldTitle)}”)</span>` : ''}` +
          `${l.status === 'added' || l.status === 'removed' ? `<span class="badge ${l.status}">${l.status}</span>` : `<span class="badge">${l.changes.length}</span>`}</div>`;
        l.changes.forEach(c => {
          html += `<div class="chg"><span class="idx">#${c.idx}</span><span class="old">${esc(c.from)}</span><span class="arrow">→</span><span class="new">${esc(c.to)}</span>` +
            `${c.props.length ? `<span class="props">${esc(c.props.join(', '))}</span>` : ''}</div>`;
        });
        html += '</div>';
      });
      if (!changedLayers.length) html += '<div class="muted">These two revisions are identical.</div>';
      out.className = ''; out.innerHTML = html;
    } catch (e) { out.className = 'err'; out.textContent = e.message; dbg('diff failed', e.message); }
    $('dbg').textContent = log.join('\n') + '\n\ncaptured: ' + captures.map(c => (c.operationName || '?') + ' @ ' + c.url + ' hdrs[' + Object.keys(c.headers || {}).join(',') + '] vars[' + Object.keys(c.variables || {}).join(',') + '] q=' + (c.query || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n');
  };

  const load = async () => {
    const out = $('out');
    out.className = 'muted'; out.textContent = 'Loading revisions…';
    try {
      revs = await fetchRevisionList();
      loadedHash = layoutHash();
      const lo = currentLayoutObjects().find(o => o.title);
      $('lname').textContent = '· ' + ((lo && lo.title) || loadedHash) + (geometryHint() ? ' [' + geometryHint() + ']' : '');
      $('from').innerHTML = revs.map(optionHtml).join('');
      $('to').innerHTML = revs.map(optionHtml).join('');
      const cur = currentIdx();
      $('to').selectedIndex = cur;                      // current
      $('from').selectedIndex = cur + 1 < revs.length ? cur + 1 : Math.max(cur - 1, 0); // previous (or next, if current is the oldest)
      await run();
    } catch (e) { out.className = 'err'; out.textContent = e.message; $('dbg').textContent = log.join('\n') + '\n\ncaptured: ' + captures.map(c => (c.operationName || '?') + ' @ ' + c.url + ' hdrs[' + Object.keys(c.headers || {}).join(',') + '] vars[' + Object.keys(c.variables || {}).join(',') + '] q=' + (c.query || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n'); }
  };

  $('fab').onclick = () => { const p = $('panel'); p.classList.toggle('open'); if (p.classList.contains('open') && (!revs.length || loadedHash !== layoutHash())) load(); };
  $('from').onchange = run; $('to').onchange = run;
  $('refresh').onclick = () => { cache.clear(); load(); };
  $('swap').onclick = () => { const f = $('from').selectedIndex; $('from').selectedIndex = $('to').selectedIndex; $('to').selectedIndex = f; run(); };
  let helpOn = false;
  try { helpOn = localStorage.getItem('oryxdiff.help2') === '1'; } catch (e) { /* storage blocked: default off */ }
  const applyHelp = () => { $('panel').classList.toggle('nohelp', !helpOn); $('help').classList.toggle('on', helpOn); };
  $('help').onclick = () => { helpOn = !helpOn; try { localStorage.setItem('oryxdiff.help2', helpOn ? '1' : '0'); } catch (e) { /* ignore */ } applyHelp(); };
  applyHelp();
  $('copy').onclick = () => navigator.clipboard.writeText($('dbg').textContent);

  // Oryx is a single-page app: switching layout changes the URL without a page load. Follow it.
  let lastHash = layoutHash(), lastRev = urlRevision();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const loadSoon = async () => {
    const mine = layoutHash();
    $('out').className = 'muted'; $('out').textContent = 'Switching layout…';
    for (let i = 0; i < 8 && layoutHash() === mine; i++) {   // wait until Oryx has delivered this layout's data
      if (harvestRevisions().length) break;
      await sleep(700);
    }
    if (layoutHash() === mine) load();
  };
  const onNav = () => {
    const h = layoutHash(), r = urlRevision();
    if (h === lastHash) {
      // Same layout, other revision opened: move the (current) mark.
      if (r !== lastRev) { lastRev = r; if (revs.length) relabel(); }
      return;
    }
    lastHash = h; lastRev = r;
    revs = [];                                   // forces a reload next time the panel opens
    if ($('panel').classList.contains('open')) loadSoon();
  };
  ['pushState', 'replaceState'].forEach(m => {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); setTimeout(onNav, 0); return r; };
  });
  window.addEventListener('popstate', onNav);
  setInterval(onNav, 1000);                      // safety net for navigation that bypasses the History API

  // Test hook for node-based checks of the pure logic
  window.__oryxDiff = { diffLayers, label, stable, extractLayers };
})();
