/* ============================================================================
 * 4月始まり（年度）カレンダー PWA  —  端末間で即時同期
 *
 * データは GitHub Contents API 上の JSON に保存する。
 * 書き込みには GitHub のトークンが必要で、URL のフラグメントで渡す:
 *     https://<owner>.github.io/<repo>/#t=github_pat_xxxxxxxx
 * 一度渡すと localStorage に保存され、以降その端末では自動で使われる。
 * トークンが無い場合は閲覧のみ（公開リポジトリなら閲覧可、非公開なら要トークン）。
 * ========================================================================== */

(() => {
  'use strict';

  /* ---------- 設定（owner / repo は github.io から自動判定、必要なら上書き）---- */
  const CONFIG = {
    owner: 'vocabuki-io',
    repo: 'Calendar',
    dataPath: 'data.json',
    // データも main に保存し、ブランチは main の一本に統一する。
    // 丸の付け外し（data.json だけの更新）では Pages を再ビルドしないよう、
    // deploy.yml の push トリガーで data.json を paths-ignore している。
    dataBranch: 'main',
  };
  (function autodetect() {
    const host = location.hostname;
    if (host.endsWith('github.io')) {
      CONFIG.owner = host.split('.')[0] || CONFIG.owner;
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg) CONFIG.repo = seg;
    }
  })();

  const API = 'https://api.github.com';
  const TOKEN_KEY = 'cal.token';
  const CACHE_KEY = 'cal.cache'; // オフライン/初期描画用のローカルキャッシュ

  /* ---------- トークン取り出し（URL フラグメント優先）---------------------- */
  function extractToken() {
    const clean = (raw) => (raw || '').trim();
    // #t=... / #token=... / ?t=...
    let token = '';
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    const hp = new URLSearchParams(hash);
    token = clean(hp.get('t') || hp.get('token'));
    if (!token) {
      const qp = new URLSearchParams(location.search);
      token = clean(qp.get('t') || qp.get('token'));
    }
    if (token) {
      // トークンは URL に残したまま端末にも保存する。
      // （リンクをブックマーク/共有すればどの端末でもそのまま編集できるようにするため。
      //   ※URL バー・履歴・ブラウザ同期に書き込みトークンが残る点は許容している）
      try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {}
    }
    if (!token) {
      try { token = clean(localStorage.getItem(TOKEN_KEY)); } catch (_) {}
    }
    return token;
  }
  let TOKEN = extractToken();
  const hasToken = () => !!TOKEN;

  /* ---------- 日付ユーティリティ ---------------------------------------- */
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m は 0始まり
  const todayKey = (() => { const t = new Date(); return keyOf(t.getFullYear(), t.getMonth(), t.getDate()); })();

  // 年度（4月始まり）の開始年を求める
  function fiscalStartYear(date = new Date()) {
    return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  }
  const FY_START = fiscalStartYear();          // 例: 2026
  const FY_MONTHS = [];                          // {y, m} を4月→翌3月で12個
  for (let i = 0; i < 12; i++) {
    const m = (3 + i) % 12;
    const y = FY_START + (3 + i >= 12 ? 1 : 0);
    FY_MONTHS.push({ y, m });
  }
  const FY_FIRST_KEY = keyOf(FY_START, 3, 1);
  const FY_LAST_KEY = keyOf(FY_START + 1, 2, 31);
  const inFiscalYear = (k) => k >= FY_FIRST_KEY && k <= FY_LAST_KEY;

  const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];

  /* ---------- 状態 ------------------------------------------------------ */
  let circles = new Set();     // "YYYY-MM-DD" の集合
  let sha = null;              // data.json の現在 SHA（無ければ null）
  let viewIndex = clampView(); // FY_MONTHS 内の表示中インデックス

  function clampView() {
    const now = new Date();
    for (let i = 0; i < FY_MONTHS.length; i++) {
      if (FY_MONTHS[i].y === now.getFullYear() && FY_MONTHS[i].m === now.getMonth()) return i;
    }
    return 0; // 年度外なら4月を表示
  }

  /* ---------- DOM ------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    fyLabel: $('fyLabel'), monthLabel: $('monthLabel'),
    prev: $('prevBtn'), next: $('nextBtn'),
    grid: $('grid'), dowCards: $('dowCards'), summaryRange: $('summaryRange'),
    syncDot: $('syncDot'), banner: $('banner'), toast: $('toast'),
  };

  function setSync(state) {
    el.syncDot.className = 'dot dot--' + state;
  }
  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
  }
  function showBanner(html, isErr) {
    el.banner.innerHTML = html;
    el.banner.classList.toggle('banner--err', !!isErr);
    el.banner.hidden = false;
  }
  function hideBanner() { el.banner.hidden = true; }

  /* ---------- GitHub API 層 --------------------------------------------- */
  function ghHeaders(extra) {
    const h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
    return Object.assign(h, extra || {});
  }
  const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decode = (str) => decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));

  async function apiGetDefaultBranch() {
    const r = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}`, { headers: ghHeaders() });
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    return j.default_branch || 'main';
  }

  // データ用ブランチが無ければ default ブランチから作成
  async function ensureDataBranch() {
    const ref = `${API}/repos/${CONFIG.owner}/${CONFIG.repo}/git/ref/heads/${CONFIG.dataBranch}`;
    const r = await fetch(ref, { headers: ghHeaders() });
    if (r.ok) return;
    if (r.status !== 404) throw httpError(r);
    const base = await apiGetDefaultBranch();
    const br = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}/git/ref/heads/${base}`, { headers: ghHeaders() });
    if (!br.ok) throw httpError(br);
    const baseSha = (await br.json()).object.sha;
    const cr = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}/git/refs`, {
      method: 'POST', headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: `refs/heads/${CONFIG.dataBranch}`, sha: baseSha }),
    });
    if (!cr.ok && cr.status !== 422) throw httpError(cr); // 422 = 既に存在
  }

  // data.json を読む → {circles:Set, sha}
  async function readData() {
    const url = `${API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(CONFIG.dataPath)}?ref=${encodeURIComponent(CONFIG.dataBranch)}&_=${Date.now()}`;
    const r = await fetch(url, { headers: ghHeaders({ 'Cache-Control': 'no-cache' }) });
    if (r.status === 404) return { set: new Set(), sha: null };
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    let parsed = { circles: [] };
    try { parsed = JSON.parse(b64decode(j.content)); } catch (_) {}
    const set = new Set(Array.isArray(parsed.circles) ? parsed.circles : []);
    return { set, sha: j.sha };
  }

  // 1件の変更を安全に反映（毎回最新を読み直してから書く＝端末間の取りこぼし防止）
  async function commitChange(dateKey, shouldExist) {
    if (!hasToken()) throw new Error('NO_TOKEN');
    let branchReady = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await readData();
      if (!branchReady && latest.sha === null) {
        // ファイルが無い → ブランチを用意（初回のみ）
        try { await ensureDataBranch(); } catch (e) { /* main 直下に作る場合もあるので握りつぶし */ }
        branchReady = true;
      }
      const set = latest.set;
      if (shouldExist) set.add(dateKey); else set.delete(dateKey);
      const body = {
        message: `${shouldExist ? 'add' : 'remove'} ${dateKey}`,
        content: b64encode(JSON.stringify({
          circles: [...set].sort(),
          updatedAt: new Date().toISOString(),
        }, null, 0)),
        branch: CONFIG.dataBranch,
      };
      if (latest.sha) body.sha = latest.sha;
      const r = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(CONFIG.dataPath)}`, {
        method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const j = await r.json();
        sha = j.content && j.content.sha;
        circles = set;
        saveCache();
        return;
      }
      if (r.status === 409 || r.status === 422) continue; // SHA 競合 → 読み直して再試行
      throw httpError(r);
    }
    throw new Error('CONFLICT_RETRY_EXHAUSTED');
  }

  function httpError(r) {
    const e = new Error('HTTP ' + r.status);
    e.status = r.status;
    return e;
  }

  /* ---------- ローカルキャッシュ ---------------------------------------- */
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ circles: [...circles] })); } catch (_) {}
  }
  function loadCache() {
    try {
      const j = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      if (Array.isArray(j.circles)) circles = new Set(j.circles);
    } catch (_) {}
  }

  /* ---------- 描画 ------------------------------------------------------ */
  function render() {
    const { y, m } = FY_MONTHS[viewIndex];
    el.fyLabel.textContent = `${FY_START}`;
    el.monthLabel.textContent = `${y}年 ${m + 1}月`;
    el.prev.disabled = viewIndex === 0;
    el.next.disabled = viewIndex === FY_MONTHS.length - 1;
    el.summaryRange.textContent = `${FY_START}年4月〜${FY_START + 1}年3月`;

    // グリッド
    const first = new Date(y, m, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const frag = document.createDocumentFragment();

    for (let i = 0; i < startDow; i++) {
      const b = document.createElement('div');
      b.className = 'cell cell--empty';
      frag.appendChild(b);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const k = keyOf(y, m, d);
      const dow = new Date(y, m, d).getDay();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      if (dow === 0) btn.classList.add('cell--sun');
      if (dow === 6) btn.classList.add('cell--sat');
      if (k === todayKey) btn.classList.add('cell--today');
      if (circles.has(k)) btn.classList.add('cell--on');
      btn.dataset.key = k;
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `${m + 1}月${d}日${circles.has(k) ? ' 〇あり' : ''}`);
      btn.innerHTML = `<span class="cell__ring"></span><span class="cell__num">${d}</span>`;
      attachCell(btn, k);
      frag.appendChild(btn);
    }
    el.grid.replaceChildren(frag);
    renderSummary();
  }

  function renderSummary() {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const k of circles) {
      if (!inFiscalYear(k)) continue;
      const [yy, mm, dd] = k.split('-').map(Number);
      counts[new Date(yy, mm - 1, dd).getDay()]++;
    }
    const frag = document.createDocumentFragment();
    for (let dw = 0; dw < 7; dw++) {
      const card = document.createElement('div');
      card.className = 'dowcard' + (dw === 0 ? ' dowcard--sun' : dw === 6 ? ' dowcard--sat' : '');
      card.innerHTML = `
        <div class="dowcard__dow">${DOW_JP[dw]}</div>
        <div class="dowcard__count${counts[dw] === 0 ? ' is-zero' : ''}">${counts[dw]}</div>
        <div class="dowcard__unit">個</div>`;
      frag.appendChild(card);
    }
    el.dowCards.replaceChildren(frag);
  }

  // 部分更新（1マスだけ丸の見た目を切り替え）
  function paintCell(k) {
    const btn = el.grid.querySelector(`[data-key="${k}"]`);
    if (btn) btn.classList.toggle('cell--on', circles.has(k));
    renderSummary();
  }

  /* ---------- 入力（タップ=付ける / 長押し=消す）------------------------- */
  const LONG_MS = 500;
  function attachCell(btn, k) {
    let timer = null, longFired = false, startX = 0, startY = 0;

    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } btn.classList.remove('cell--pressing'); };

    btn.addEventListener('pointerdown', (e) => {
      longFired = false;
      startX = e.clientX; startY = e.clientY;
      if (circles.has(k)) {
        btn.classList.add('cell--pressing');
        timer = setTimeout(() => {
          longFired = true;
          clearTimer();
          onRemove(k);
        }, LONG_MS);
      }
    });
    btn.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) clearTimer();
    });
    btn.addEventListener('pointerup', clearTimer);
    btn.addEventListener('pointercancel', clearTimer);
    btn.addEventListener('pointerleave', clearTimer);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (longFired) { longFired = false; return; }
      if (!circles.has(k)) onAdd(k);
      // 既に丸がある状態でのタップは何もしない（削除は長押し）
    });
  }

  async function onAdd(k) {
    if (guardEdit()) return;
    circles.add(k); paintCell(k); saveCache();   // 楽観的に即反映
    await pushChange(k, true);
  }
  async function onRemove(k) {
    if (guardEdit()) return;
    circles.delete(k); paintCell(k); saveCache();
    await pushChange(k, false);
  }
  function guardEdit() {
    if (!hasToken()) {
      showBanner(needTokenHtml(), false);
      toast('編集にはトークンが必要です');
      return true;
    }
    return false;
  }

  async function pushChange(k, shouldExist) {
    setSync('busy');
    try {
      await commitChange(k, shouldExist);
      setSync('ok');
      hideBanner();
    } catch (e) {
      // 失敗したら楽観更新を取り消す
      if (shouldExist) circles.delete(k); else circles.add(k);
      paintCell(k); saveCache();
      setSync('err');
      if (e && (e.status === 401 || e.status === 403)) {
        showBanner('トークンが無効か権限がありません。<code>contents:write</code> 権限のトークンを URL に付け直してください。', true);
        toast('保存に失敗（権限エラー）');
      } else if (e && e.message === 'NO_TOKEN') {
        showBanner(needTokenHtml(), false);
      } else {
        toast('保存に失敗しました。通信を確認してください');
      }
    }
  }

  /* ---------- 初期ロード & ポーリング ----------------------------------- */
  async function refresh(initial) {
    if (!initial) setSync('busy');
    try {
      const latest = await readData();
      circles = latest.set;
      sha = latest.sha;
      saveCache();
      setSync(hasToken() ? 'ok' : 'ro');
      if (hasToken()) hideBanner();
      else showBanner(readonlyHtml(), false);
      paintAll();
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
        setSync(hasToken() ? 'err' : 'ro');
        if (!hasToken()) showBanner(needTokenHtml(), false);
        else showBanner('データを読み込めません。トークンの権限またはリポジトリ設定を確認してください。', true);
      } else {
        setSync('err');
      }
    }
  }
  function paintAll() {
    // 表示中の月に丸状態を反映（グリッド全体を再構築）
    render();
  }

  function needTokenHtml() {
    return `このカレンダーを操作するにはトークンが必要です。URL の末尾に ` +
      `<code>#t=あなたのトークン</code> を付けてアクセスしてください。`;
  }
  function readonlyHtml() {
    return `閲覧モードです（トークン未設定）。編集するには URL に ` +
      `<code>#t=あなたのトークン</code> を付けてください。`;
  }

  /* ---------- イベント配線 ---------------------------------------------- */
  el.prev.addEventListener('click', () => { if (viewIndex > 0) { viewIndex--; render(); } });
  el.next.addEventListener('click', () => { if (viewIndex < FY_MONTHS.length - 1) { viewIndex++; render(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') el.prev.click();
    if (e.key === 'ArrowRight') el.next.click();
  });
  // 拡大・縮小（ズーム）を無効化。iOS Safari は user-scalable=no を無視するため、
  // ピンチ（複数指ジェスチャ）を JS でも抑止する。ダブルタップ拡大は CSS の
  // touch-action: manipulation で無効化しており、タップ操作には干渉しない。
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // 他端末の変更を拾う：復帰時＆定期ポーリング
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  window.addEventListener('focus', () => refresh(false));
  setInterval(() => { if (!document.hidden) refresh(false); }, 20000);

  /* ---------- 起動 ------------------------------------------------------ */
  loadCache();
  setSync(hasToken() ? 'busy' : 'ro');
  render();               // まずキャッシュで即描画
  refresh(true);          // その後リモートと同期

  // Service Worker 登録（PWA）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
