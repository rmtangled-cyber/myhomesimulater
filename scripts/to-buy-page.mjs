// 買うものリスト（notes/to-buy.md）を Artifact 用のページにする: node scripts/to-buy-page.mjs
// 出力: dist-docs/to-buy.html
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** md の **太字** と URL だけを HTML にする */
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/https?:\/\/[^\s）)]+/g, (u) => `<a href="${u}">${new URL(u.replace(/&amp;/g, '&')).hostname.replace(/^www\d?\./, '')}</a>`);

const SECTION_NOTE = {
  '①': '工事の前に決める物',
  '②': '入居に合わせて買えばよい物',
  持: '新しく買わない物',
  要: '',
};

const lines = readFileSync('notes/to-buy.md', 'utf8').split(/\r?\n/);
const sections = [];
let cur = null;
for (const line of lines) {
  const h = line.match(/^## (.+)/);
  if (h) {
    cur = { title: h[1].replace(/^[①②]\s*/, ''), mark: h[1][0], rows: [], notes: [] };
    sections.push(cur);
  } else if (cur && line.startsWith('|') && !/^\|(\s*場所|---)/.test(line)) {
    cur.rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  } else if (cur && line.startsWith('- ')) {
    cur.notes.push(line.slice(2));
  }
}

/** チェックの保存先の ID。場所と物の名前から作る（商品名やメモを直してもチェックが消えない） */
const rowKey = (s) => {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return 'r' + h.toString(36);
};

const row = ([place, what, product, url, memo], mark) => {
  const undecided = /未定|要確認/.test(product);
  return `<li>
    <label class="own" title="持ってる"><input type="checkbox" data-key="${rowKey(`${place}|${what}`)}" data-default="${mark === '持' ? 1 : 0}"><span>持ってる</span></label>
    <div class="place">${inline(place)}</div>
    <div class="main">
      <div class="what">${inline(what)}${undecided ? ' <span class="chip">未定あり</span>' : ''}</div>
      ${product && product !== '—' ? `<div class="product">${inline(product)}</div>` : ''}
      ${memo ? `<div class="memo">${inline(memo)}</div>` : ''}
    </div>
    <div class="link">${url && url !== '—' ? inline(url) : ''}</div>
  </li>`;
};

const body = sections
  .map(
    (s) => `<section>
  <h2>${inline(s.title)}${s.rows.length ? ` <small>${s.rows.length} 点・持ってる <b class="count">0</b> 点</small>` : ''}</h2>
  ${SECTION_NOTE[s.mark] ? `<p class="note">${SECTION_NOTE[s.mark]}</p>` : ''}
  ${s.rows.length ? `<ul>${s.rows.map((r) => row(r, s.mark)).join('')}</ul>` : ''}
  ${s.notes.length ? `<div class="pending">${s.notes.map((n) => `<p>${inline(n)}</p>`).join('')}</div>` : ''}
</section>`,
  )
  .join('\n');

const date = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
const html = `<title>自分で買うものリスト</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&family=BIZ+UDPMincho:wght@700&display=swap">
<style>
/* ワンダーハウス確認リストと同じ体裁。場所・物・リンクを 1 行ずつ。スマホでは縦に積む */
:root {
  --bg: #f7f8f7; --paper: #ffffff; --ink: #1f2427; --muted: #5d676c; --line: #dde2e2; --accent: #2f5d7c;
  --chip: #a24f12; --chip-bg: #fbeee3;
  --f-body: 'BIZ UDPGothic', 'Yu Gothic', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
  --f-head: 'BIZ UDPMincho', 'Yu Mincho', 'Hiragino Mincho ProN', serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #15191b; --paper: #1d2326; --ink: #e6eaeb; --muted: #9aa6ab; --line: #30393d; --accent: #8cbbd9; --chip: #f1b07c; --chip-bg: #3a2a1d; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #15191b; --paper: #1d2326; --ink: #e6eaeb; --muted: #9aa6ab; --line: #30393d; --accent: #8cbbd9; --chip: #f1b07c; --chip-bg: #3a2a1d; color-scheme: dark; }
body { background: var(--bg); color: var(--ink); font-family: var(--f-body); font-size: 15px; line-height: 1.7; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 980px; margin: 0 auto; display: grid; gap: 32px; }
header { display: grid; gap: 8px; border-bottom: 2px solid var(--ink); padding-bottom: 16px; }
h1 { font-family: var(--f-head); font-size: clamp(26px, 5vw, 34px); line-height: 1.3; margin: 0; text-wrap: balance; }
.meta { color: var(--muted); font-size: 13px; }
section { display: grid; gap: 8px; }
h2 { font-family: var(--f-head); font-size: 20px; margin: 0; padding-bottom: 6px; border-bottom: 1px solid var(--line); text-wrap: balance; }
h2 small { font-family: var(--f-body); font-size: 12px; font-weight: 400; color: var(--muted); }
.note { margin: 0; color: var(--muted); font-size: 13px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: grid; grid-template-columns: 5.5em 11em minmax(0, 1fr) 8.5em; gap: 4px 16px; padding: 11px 0; border-bottom: 1px dashed var(--line); }
li:last-child { border-bottom: none; }
.own { display: inline-flex; align-items: flex-start; gap: 5px; font-size: 12px; color: var(--muted); cursor: pointer; line-height: 1.6; }
.own input { width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent); flex: none; }
li.owned .what, li.owned .product { color: var(--muted); }
.save-note { color: var(--chip); font-size: 13px; }
.place { color: var(--muted); font-size: 13px; min-width: 0; }
.main { min-width: 0; display: grid; gap: 2px; }
.what { font-weight: 700; }
.product { font-size: 14px; }
.memo { color: var(--muted); font-size: 13px; }
.link { font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
a { color: var(--accent); }
.chip { font-size: 11px; font-weight: 400; padding: 0 7px; border-radius: 9px; color: var(--chip); background: var(--chip-bg); white-space: nowrap; }
.pending { display: grid; gap: 6px; background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; font-size: 14px; overflow-wrap: anywhere; }
.pending p { margin: 0; }
@media (max-width: 640px) { li { grid-template-columns: minmax(0, 1fr); } }
</style>
<div class="wrap">
<header>
  <h1>自分で買うものリスト</h1>
  <div class="meta">${date} 時点・ワンダーハウスの見積もりに入っていない物</div>
  <div class="save-note" id="save-note" hidden></div>
</header>
${body}
</div>
<script>
// チェックは db に保存する（PC と iPad で同じ。ページを出し直しても消えない）。db が使えないときはこのブラウザの中だけ
(() => {
  const boxes = [...document.querySelectorAll('input[data-key]')];
  const state = new Map();
  const note = document.getElementById('save-note');
  const say = (t) => { note.textContent = t; note.hidden = !t; };
  const render = () => {
    for (const b of boxes) {
      const v = state.has(b.dataset.key) ? state.get(b.dataset.key) : b.dataset.default === '1';
      b.checked = v;
      b.closest('li').classList.toggle('owned', v);
    }
    for (const s of document.querySelectorAll('section')) {
      const c = s.querySelector('.count');
      if (c) c.textContent = s.querySelectorAll('input[data-key]:checked').length;
    }
  };
  const local = () => { try { return JSON.parse(localStorage.getItem('to-buy-owned') || '{}'); } catch { return {}; } };
  let col = null;
  for (const b of boxes) b.addEventListener('change', async () => {
    const key = b.dataset.key;
    state.set(key, b.checked);
    render();
    if (col) {
      try { await col.doc(key).set({ owned: b.checked }); say(''); }
      catch { say('保存できませんでした。この画面を開き直すと元に戻ります。'); }
    } else {
      try { localStorage.setItem('to-buy-owned', JSON.stringify(Object.fromEntries(state))); } catch {}
    }
  });
  for (const [k, v] of Object.entries(local())) state.set(k, v);
  render();
  (async () => {
    const db = window.claude ? await claude.use('db') : null;
    if (!db) { say('チェックはこのブラウザの中だけに保存されます。'); return; }
    col = db.collection('owned');
    state.clear();
    render();
    const late = setTimeout(() => say('チェックを読み込めていません。最新でない場合があります。'), 10000);
    col.onSnapshot((snap) => {
      if (!snap.metadata.fromCache) { clearTimeout(late); say(''); }
      state.clear();
      snap.docs.forEach((d) => state.set(d.id, !!d.data().owned));
      render();
    }, () => { clearTimeout(late); say('チェックを読み込めませんでした。'); });
  })();
})();
</script>
`;
mkdirSync('dist-docs', { recursive: true });
writeFileSync('dist-docs/to-buy.html', html);
console.log('dist-docs/to-buy.html', sections.map((s) => s.rows.length).join('+'));
