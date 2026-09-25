/* Дүкен Касса — клиент для Supabase */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r3 = n => Math.round(n * 1000) / 1000;
const money = n => (Math.round(+n) || 0).toLocaleString('ru-RU') + ' ₸';
const qf = (q, u) => (q = +q, u === 'кг' ? q.toFixed(3).replace('.', ',') + ' кг' : r3(q) + ' шт');
const pad = n => String(n).padStart(2, '0');
const dayOf = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const timeOf = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dtOf = t => { const d = new Date(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + timeOf(t); };
const rno = n => String(n).padStart(6, '0');
const METHODS = { cash: 'Наличные', card: 'Карта', qr: 'Kaspi QR' };
const CFG = window.DUKEN_CONFIG || {};

const S = { products: {}, receipts: [], moves: [], cart: [], cat: 'Все', tab: 'pos', inLines: [], online: false, me: null };
let sb = null;

/* ---------- ошибки Supabase → понятный текст ---------- */
function errText(e) {
  if (!e) return 'Неизвестная ошибка';
  const m = e.message || String(e);
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Нет связи с сервером. Проверьте интернет и повторите';
  if (e.code === '23505') return /plu/i.test(m) ? 'Такой PLU уже есть у другого товара' : 'Такой штрихкод уже есть у другого товара';
  if (e.code === '42501' && !/[А-Яа-я]/.test(m)) return 'Недостаточно прав для этого действия';
  if (/JWT|session/i.test(m)) return 'Сессия истекла. Войдите заново';
  return m;
}
const num = v => (v == null ? v : +v);
const normProduct = p => ({ ...p, cost: num(p.cost), price: num(p.price), stock: num(p.stock), min_stock: num(p.min_stock) });

/* ---------- toast & modal ---------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200);
}
function openModal(html, { wide = false, onMount, kind = '' } = {}) {
  const box = $('#modal-box'); box.className = 'modal' + (wide ? ' wide' : ''); box.dataset.kind = kind; box.innerHTML = html;
  $('#modal').hidden = false;
  box.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  onMount && onMount(box);
}
function closeModal() {
  $('#modal').hidden = true; $('#modal-box').innerHTML = '';
  if (S.tab === 'pos') setTimeout(() => $('#pos-q').focus(), 0);
}
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
const modalHead = t => `<div class="modal-h"><h3>${t}</h3><button class="x" data-close aria-label="Закрыть">×</button></div>`;
const isOwner = () => S.me && S.me.role === 'owner';

/* ---------- запуск и вход ---------- */
async function start() {
  document.title = (CFG.shopName || 'Дүкен') + ' Касса';
  $('#brand-name').textContent = CFG.shopName || 'Дүкен';
  $('#login-title').textContent = CFG.shopName || 'Дүкен';
  if (!CFG.url || !CFG.anonKey || !window.supabase) {
    $('#setup').hidden = false;
    $('#setup').innerHTML = !window.supabase
      ? '<h2>Не загрузилась библиотека Supabase</h2><p>Проверьте подключение к интернету и обновите страницу.</p>'
      : '<h2>Касса ещё не подключена к базе</h2><p>Откройте файл <code>config.js</code> и впишите <code>url</code> и <code>anonKey</code> вашего проекта Supabase (Project Settings → API). Подробности — в README.</p>';
    return;
  }
  sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(); else showLogin();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') showLogin(); });
}
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  setTimeout(() => $('#l-email').focus(), 0);
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#l-email').value.trim(), password = $('#l-pass').value;
  if (!email || !password) return $('#l-err').textContent = 'Введите email и пароль';
  $('#l-btn').disabled = true; $('#l-err').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $('#l-btn').disabled = false;
  if (error) { $('#l-err').textContent = /Invalid login/i.test(error.message) ? 'Неверный email или пароль' : errText(error); return; }
  $('#l-pass').value = '';
  await enter();
});
async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin();
  const { data: prof, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error || !prof) {
    $('#l-err').textContent = error ? errText(error) : 'Для этой учётной записи нет профиля сотрудника. Запустите schema.sql ещё раз.';
    await sb.auth.signOut(); return;
  }
  S.me = prof;
  document.body.dataset.role = prof.role;
  $('#login').hidden = true; $('#app').hidden = false;
  const h = location.hash.slice(1);
  setTab(['pos', 'products', 'stock', 'sales'].includes(h) ? h : 'pos');
  await loadProducts();
  subscribeProducts();
}

/* ---------- загрузка данных ---------- */
async function loadProducts() {
  const all = []; let from = 0;
  for (;;) { // Supabase отдаёт до 1000 строк за раз
    const { data, error } = await sb.from('products').select('*').eq('archived', false).order('name').range(from, from + 999);
    if (error) { setOnline(false); toast(errText(error)); return; }
    all.push(...data); if (data.length < 1000) break; from += 1000;
  }
  S.products = {}; all.forEach(p => S.products[p.id] = normProduct(p));
  setOnline(true); refresh();
}
let subscribed = false;
function subscribeProducts() {
  if (subscribed) return; subscribed = true;
  sb.channel('products-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
      const p = payload.new && payload.new.id ? normProduct(payload.new) : null;
      if (payload.eventType === 'DELETE' || (p && p.archived)) delete S.products[(payload.old && payload.old.id) || p.id];
      else if (p) S.products[p.id] = p;
      S.cart.forEach(l => { const x = S.products[l.pid]; if (x) l.price = x.price; });
      refresh();
    })
    .subscribe();
  // Запасной вариант, если живое обновление недоступно: перечитываем каталог раз в 5 минут
  setInterval(() => { if (document.visibilityState === 'visible') loadProducts(); }, 5 * 60 * 1000);
}
window.addEventListener('online', () => { loadProducts(); });
window.addEventListener('offline', () => setOnline(false));
function setOnline(v) { S.online = v; setStatus(); }
function setStatus() {
  const el = $('#status');
  el.className = 'status' + (S.online ? ' ok' : '');
  el.querySelector('span').textContent = S.online ? 'Сервер на связи' : 'Нет связи';
  if (S.me) $('#cashier-btn').textContent = (S.me.full_name || 'Сотрудник') + (isOwner() ? ' · владелец' : ' · кассир');
  $('#banner').innerHTML = !S.online && S.me ? '<div class="banner">Нет связи с сервером. Продажи не проводятся, пока связь не восстановится — корзина сохранится.</div>' : '';
}

/* ---------- helpers ---------- */
const prodList = () => Object.values(S.products).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const cats = () => [...new Set(prodList().map(p => p.category || 'Без категории'))].sort((a, b) => a.localeCompare(b, 'ru'));
const isLow = p => (+p.stock || 0) <= (+p.min_stock || 0);
function stockPill(p) {
  const s = +p.stock || 0;
  if (s <= 0) return `<span class="pill bad">нет · ${qf(s, p.unit)}</span>`;
  if (isLow(p)) return `<span class="pill warn">мало · ${qf(s, p.unit)}</span>`;
  return `<span class="pill mute">${qf(s, p.unit)}</span>`;
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + t);
  refresh();
  if (t === 'stock') loadMoves();
  if (t === 'sales') loadSales();
  if (t === 'pos') $('#pos-q').focus();
  try { history.replaceState(null, '', '#' + t); } catch (e) {}
}
function refresh() {
  setStatus();
  if (S.tab === 'pos') { renderCats(); renderGrid(); renderCart(); }
  if (S.tab === 'products') renderProducts();
  if (S.tab === 'stock') renderStock();
  if (S.tab === 'sales') renderSales();
}

/* ---------- касса ---------- */
function renderCats() {
  const list = ['Все', ...cats()];
  if (!list.includes(S.cat)) S.cat = 'Все';
  $('#pos-cats').innerHTML = list.map(c => `<button class="cat" data-c="${esc(c)}" aria-pressed="${c === S.cat}">${esc(c)}</button>`).join('');
}
$('#pos-cats').onclick = e => { const b = e.target.closest('.cat'); if (!b) return; S.cat = b.dataset.c; renderCats(); renderGrid(); };
function filtered() {
  const q = $('#pos-q').value.trim().toLowerCase();
  return prodList().filter(p => (S.cat === 'Все' || (p.category || 'Без категории') === S.cat) &&
    (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.plu && p.plu === q)));
}
function renderGrid() {
  const list = filtered();
  $('#pos-grid').innerHTML = list.length ? list.map(p => `
    <button class="tile" data-id="${esc(p.id)}">
      <span class="nm">${esc(p.name)}</span>
      <span class="pr">${money(p.price)}${p.unit === 'кг' ? '<span class="muted" style="font-weight:500;font-size:12px"> /кг</span>' : ''}</span>
      <span class="meta">${p.unit === 'кг' ? `<span class="pill info">весовой${p.plu ? ' · ' + esc(p.plu) : ''}</span>` : '<span></span>'}${stockPill(p)}</span>
    </button>`).join('')
    : `<div class="empty" style="grid-column:1/-1">${Object.keys(S.products).length ? 'Ничего не найдено' : 'Каталог пуст. Отсканируйте первый товар — программа предложит его создать.'}</div>`;
}
$('#pos-q').addEventListener('input', renderGrid);
$('#pos-q').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim(); if (!q) return;
  const hit = findByCode(q);
  if (hit) { addToCart(hit.p, hit.w); if (hit.w) toast(`${hit.p.name}: ${qf(hit.w, 'кг')}`); return clearQ(); }
  const f = filtered();
  if (f.length === 1) { addToCart(f[0]); return clearQ(); }
  if (!f.length && /^\d{6,14}$/.test(q)) { clearQ(); return unknownCode(q, 'pos'); }
  toast(f.length ? 'Найдено несколько товаров — выберите нужный' : 'Товар не найден');
});
function clearQ() { $('#pos-q').value = ''; renderGrid(); }
$('#pos-grid').onclick = e => { const t = e.target.closest('.tile'); if (!t) return; const p = S.products[t.dataset.id]; if (p) addToCart(p); };

function findByCode(code) {
  const list = prodList();
  let p = list.find(x => x.barcode && x.barcode === code);
  if (p) return { p };
  // весовой штрихкод EAN-13: 2X PPPPP WWWWW C — код PLU и вес в граммах
  if (/^2\d{12}$/.test(code)) {
    const plu = String(+code.slice(2, 7)), w = +code.slice(7, 12) / 1000;
    p = list.find(x => x.unit === 'кг' && x.plu && String(+x.plu) === plu);
    if (p && w > 0) return { p, w };
  }
  return null;
}
function unknownCode(code, ctx) {
  openModal(`${modalHead('Товар не найден')}
    <div class="modal-b"><div>Штрихкод <b class="num">${esc(code)}</b> ещё не заведён в каталог.</div>
    <div class="muted" style="font-size:14px">Создайте карточку — штрихкод уже будет в ней. После сохранения товар ${ctx === 'pos' ? 'сразу попадёт в чек' : ctx === 'stock' ? 'добавится в накладную' : 'появится в списке'}.</div></div>
    <div class="modal-f"><button class="btn" data-close>Отмена</button><button class="btn primary" id="uc-new">Создать товар <kbd>Enter</kbd></button></div>`,
  { onMount: box => { const b = box.querySelector('#uc-new'); setTimeout(() => b.focus(), 0);
      b.onclick = () => editProduct(null, { barcode: code, onSaved: p => {
        if (ctx === 'pos') { setTab('pos'); addToCart(p); }
        if (ctx === 'stock') pickForIncoming(p);
      } }); } });
}
/* Сканер штрихкода работает как клавиатура: быстро вводит символы и Enter.
   Ловим такой ввод в любом месте страницы, даже когда курсор не в поле. */
const scan = { buf: '', last: 0 };
document.addEventListener('keydown', e => {
  if ($('#app').hidden) return;
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (typing) { scan.buf = ''; return; }
  const now = Date.now();
  if (now - scan.last > 80) scan.buf = '';
  scan.last = now;
  if (e.key === 'Enter' && scan.buf.length >= 6) { e.preventDefault(); const c = scan.buf; scan.buf = ''; handleScan(c); return; }
  if (/^[0-9A-Za-z]$/.test(e.key)) scan.buf += e.key;
}, true);
function handleScan(code) {
  if (!$('#modal').hidden) { if ($('#modal-box').dataset.kind === 'fresh') closeModal(); else return; }
  const hit = findByCode(code);
  if (S.tab === 'pos') {
    if (hit) { addToCart(hit.p, hit.w); if (hit.w) toast(`${hit.p.name}: ${qf(hit.w, 'кг')}`); }
    else unknownCode(code, 'pos');
  } else if (S.tab === 'products') {
    if (hit) editProduct(hit.p); else unknownCode(code, 'products');
  } else if (S.tab === 'stock') {
    if (hit) pickForIncoming(hit.p, hit.w); else unknownCode(code, 'stock');
  } else { setTab('pos'); handleScan(code); }
}

function addToCart(p, qty) {
  if (p.unit === 'кг' && qty == null) return askQty(p, null);
  const line = S.cart.find(l => l.pid === p.id);
  if (line && p.unit !== 'кг') line.qty += 1;
  else if (line && qty != null) line.qty = r3(line.qty + qty);
  else S.cart.push({ pid: p.id, name: p.name, unit: p.unit, price: +p.price, qty: qty ?? 1 });
  renderCart();
}
function askQty(p, line) {
  const kg = p.unit === 'кг';
  openModal(`${modalHead(esc(p.name))}
    <div class="modal-b">
      <div class="field"><label for="q-in">${kg ? 'Вес, кг' : 'Количество, шт'}</label>
        <input class="inp num" id="q-in" type="number" inputmode="decimal" min="0" step="${kg ? '0.001' : '1'}" value="${line ? line.qty : ''}" style="font-size:22px"></div>
      <div class="muted">Цена: ${money(p.price)}${kg ? ' за кг' : ''} · Сумма: <b class="num" id="q-sum">—</b></div>
      <div class="err" id="q-err"></div>
    </div>
    <div class="modal-f"><button class="btn" data-close>Отмена</button><button class="btn primary" id="q-ok">${line ? 'Сохранить' : 'В чек'}</button></div>`,
  { onMount: box => {
      const inp = box.querySelector('#q-in');
      const val = () => parseFloat(String(inp.value).replace(',', '.'));
      const upd = () => { const v = val(); box.querySelector('#q-sum').textContent = v > 0 ? money(v * p.price) : '—'; };
      const ok = () => {
        let v = val();
        if (!(v > 0)) { box.querySelector('#q-err').textContent = kg ? 'Введите вес больше нуля, например 0,450' : 'Введите количество больше нуля'; return; }
        v = kg ? r3(v) : Math.round(v);
        if (line) line.qty = v; else S.cart.push({ pid: p.id, name: p.name, unit: p.unit, price: +p.price, qty: v });
        closeModal(); renderCart();
      };
      inp.oninput = upd; upd(); inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      box.querySelector('#q-ok').onclick = ok; setTimeout(() => inp.focus(), 0);
  } });
}
const lineSum = l => Math.round(l.price * l.qty);
const cartTotal = () => S.cart.reduce((s, l) => s + lineSum(l), 0);
function plural(n, a, b, c) { return n % 10 === 1 && n % 100 !== 11 ? a : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? b : c; }
function renderCart() {
  const n = S.cart.length;
  $('#cart-count').textContent = n + ' ' + plural(n, 'позиция', 'позиции', 'позиций');
  $('#cart-lines').innerHTML = n ? S.cart.map((l, i) => `
    <div class="line">
      <div><div class="ln">${esc(l.name)}</div><div class="lp num">${money(l.price)}${l.unit === 'кг' ? '/кг' : ''}</div></div>
      <div class="ls">${money(lineSum(l))}</div>
      <div class="qty">
        ${l.unit === 'кг' ? '' : `<button class="qbtn" data-a="dec" data-i="${i}" aria-label="Меньше">−</button>`}
        <button class="qval" data-a="edit" data-i="${i}">${qf(l.qty, l.unit)}</button>
        ${l.unit === 'кг' ? '' : `<button class="qbtn" data-a="inc" data-i="${i}" aria-label="Больше">+</button>`}
      </div>
      <div style="text-align:right"><button class="rm" data-a="rm" data-i="${i}">Убрать</button></div>
    </div>`).join('')
    : '<div class="empty">Отсканируйте штрихкод или нажмите на товар</div>';
  $('#cart-total').textContent = money(cartTotal());
  $('#pay-btn').disabled = !n; $('#clear-btn').disabled = !n;
}
$('#cart-lines').onclick = e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const i = +b.dataset.i, l = S.cart[i]; if (!l) return;
  if (b.dataset.a === 'inc') l.qty += 1;
  if (b.dataset.a === 'dec') { l.qty -= 1; if (l.qty <= 0) S.cart.splice(i, 1); }
  if (b.dataset.a === 'rm') S.cart.splice(i, 1);
  if (b.dataset.a === 'edit') return askQty(S.products[l.pid] || l, l);
  renderCart();
};
$('#clear-btn').onclick = () => {
  const b = $('#clear-btn');
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Нажмите ещё раз, чтобы очистить'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Очистить чек'; }, 2500); return; }
  b.classList.remove('armed'); b.textContent = 'Очистить чек'; S.cart = []; renderCart(); $('#pos-q').focus();
};
$('#pay-btn').onclick = openPay;

function openPay() {
  if (!S.cart.length) return;
  const total = cartTotal();
  let method = 'cash';
  const q = [total, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000, 5000, 10000, 20000].filter((v, i, a) => v >= total && a.indexOf(v) === i).slice(0, 5);
  openModal(`${modalHead('Оплата')}
    <div class="modal-b">
      <div class="due"><span class="muted">К оплате</span><b>${money(total)}</b></div>
      <div class="methods">
        <button class="method" data-m="cash" aria-pressed="true">Наличные<small>со сдачей</small></button>
        <button class="method" data-m="card" aria-pressed="false">Карта<small>POS-терминал</small></button>
        <button class="method" data-m="qr" aria-pressed="false">Kaspi QR<small>по QR-коду</small></button>
      </div>
      <div id="cash-box" class="stack" style="gap:10px">
        <div class="field"><label for="cash-in">Получено от покупателя, ₸</label><input class="inp num" id="cash-in" type="number" min="0" step="1" inputmode="numeric" style="font-size:20px" placeholder="${total}"></div>
        <div class="quick">${q.map(v => `<button data-v="${v}">${v.toLocaleString('ru-RU')}</button>`).join('')}</div>
        <div class="change"><span>Сдача</span><span class="num" id="change">—</span></div>
      </div>
      <div id="other-box" class="muted" hidden></div>
      <div class="err" id="pay-err"></div>
    </div>
    <div class="modal-f"><button class="btn" data-close>Назад</button><button class="btn primary" id="pay-ok">Провести оплату <kbd>Enter</kbd></button></div>`,
  { onMount: box => {
      const cin = box.querySelector('#cash-in'), okBtn = box.querySelector('#pay-ok'), err = box.querySelector('#pay-err');
      const upd = () => { const v = +cin.value; box.querySelector('#change').textContent = v >= total ? money(v - total) : v ? 'не хватает ' + money(total - v) : '—'; };
      box.querySelectorAll('.method').forEach(b => b.onclick = () => {
        method = b.dataset.m; box.querySelectorAll('.method').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        box.querySelector('#cash-box').hidden = method !== 'cash';
        const ob = box.querySelector('#other-box'); ob.hidden = method === 'cash';
        ob.textContent = method === 'card' ? 'Проведите оплату на терминале и нажмите «Провести оплату», когда терминал одобрит платёж.'
          : 'Покажите покупателю QR-код Kaspi. Подтвердите оплату после уведомления о поступлении.';
        err.textContent = '';
      });
      box.querySelector('.quick').onclick = e => { const b = e.target.closest('button'); if (b) { cin.value = b.dataset.v; upd(); } };
      cin.oninput = upd;
      const ok = async () => {
        let received = null;
        if (method === 'cash') { received = cin.value === '' ? total : +cin.value; if (received < total) { err.textContent = 'Полученная сумма меньше суммы чека'; return; } }
        okBtn.disabled = true; okBtn.textContent = 'Проводим…'; err.textContent = '';
        const { data, error } = await sb.rpc('create_sale', {
          p_method: method, p_received: received,
          p_lines: S.cart.map(l => ({ product_id: l.pid, qty: l.qty })),
        });
        if (error) { okBtn.disabled = false; okBtn.innerHTML = 'Провести оплату <kbd>Enter</kbd>'; err.textContent = errText(error); if (/связи/.test(errText(error))) setOnline(false); return; }
        setOnline(true);
        S.cart.forEach(l => { const p = S.products[l.pid]; if (p) p.stock = r3(p.stock - l.qty); });
        S.cart = []; renderCart(); renderGrid();
        showReceipt(data, true);
      };
      okBtn.onclick = ok;
      box.addEventListener('keydown', e => { if (e.key === 'Enter' && !okBtn.disabled) { e.preventDefault(); ok(); } });
      setTimeout(() => cin.focus(), 0);
  } });
}
function receiptHTML(r) {
  const lines = r.lines || r.receipt_lines || [];
  return `<div class="receipt">
    <div class="c"><b>${esc((CFG.shopName || 'Дүкен').toUpperCase())}</b><br>${esc(CFG.shopSubtitle || '')}<br>ТОВАРНЫЙ ЧЕК</div><hr>
    <div class="rr"><span>Чек № ${rno(r.no)}</span><span>${dtOf(r.created_at)}</span></div>
    <div>Кассир: ${esc(r.cashier_name)}</div><hr>
    ${lines.map(l => `<div class="it">${esc(l.name)}<div class="rr"><span>${qf(l.qty, l.unit)} × ${money(l.price)}</span><span>${money(l.sum)}</span></div></div>`).join('')}
    <hr><div class="rr tot"><span>ИТОГО</span><span>${money(r.total)}</span></div>
    <div class="rr"><span>${METHODS[r.method]}</span><span>${money(r.received)}</span></div>
    ${r.method === 'cash' ? `<div class="rr"><span>Сдача</span><span>${money(r.change)}</span></div>` : ''}
    <hr><div class="c muted" style="font-size:11px">Товарный чек, не фискальный<br>Спасибо за покупку!</div>
    ${r.returned_at ? `<div class="c"><span class="stamp">ВОЗВРАТ ${dtOf(r.returned_at)}</span></div>` : ''}
  </div>`;
}
function showReceipt(r, fresh) {
  openModal(`${modalHead(fresh ? 'Оплата прошла' : 'Чек № ' + rno(r.no))}
    <div class="modal-b">${fresh && r.method === 'cash' && +r.change > 0 ? `<div class="due"><span>Сдача покупателю</span><b>${money(r.change)}</b></div>` : ''}${receiptHTML(r)}</div>
    <div class="modal-f">
      ${!fresh && !r.returned_at ? `<button class="btn danger" id="ret-btn">Оформить возврат</button><span style="flex:1"></span>` : ''}
      <button class="btn ${fresh ? 'primary' : ''}" data-close id="rc-close">${fresh ? 'Новая продажа' : 'Закрыть'}</button>
    </div>`,
  { kind: fresh ? 'fresh' : '', onMount: box => {
      if (fresh) setTimeout(() => box.querySelector('#rc-close').focus(), 0);
      const rb = box.querySelector('#ret-btn');
      if (rb) rb.onclick = async () => {
        if (!rb.classList.contains('armed')) { rb.classList.add('armed'); rb.textContent = 'Подтвердить возврат ' + money(r.total); return; }
        rb.disabled = true;
        const { data, error } = await sb.rpc('return_receipt', { p_receipt: r.id });
        if (error) { rb.disabled = false; toast(errText(error)); return; }
        toast('Возврат оформлен, товар вернулся на склад');
        loadSales(); loadProducts(); showReceipt(data, false);
      };
  } });
}

/* ---------- товары ---------- */
['#pr-q', '#pr-cat', '#pr-low'].forEach(s => $(s).addEventListener('input', renderProductTable));
function renderProducts() {
  const sel = $('#pr-cat'), cur = sel.value;
  sel.innerHTML = '<option value="">Все категории</option>' + cats().map(c => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
  renderProductTable();
}
function renderProductTable() {
  const q = $('#pr-q').value.trim().toLowerCase(), c = $('#pr-cat').value, low = $('#pr-low').checked;
  const list = prodList().filter(p => (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.plu || '') === q) && (!c || p.category === c) && (!low || isLow(p)));
  $('#pr-table').innerHTML = list.length ? `<table>
    <thead><tr><th>Товар</th><th>Штрихкод / PLU</th><th>Категория</th><th class="r">Закуп</th><th class="r">Цена</th><th class="r">Наценка</th><th class="r">Остаток</th></tr></thead>
    <tbody>${list.map(p => {
      const m = +p.cost ? Math.round((p.price - p.cost) / p.cost * 100) : null;
      return `<tr class="click" data-id="${esc(p.id)}"><td><b>${esc(p.name)}</b> <span class="muted">${p.unit === 'кг' ? '· кг' : ''}</span></td>
      <td class="num muted">${esc(p.barcode || (p.plu ? 'PLU ' + p.plu : '—'))}</td><td>${esc(p.category || '—')}</td>
      <td class="r num">${money(p.cost)}</td><td class="r num"><b>${money(p.price)}</b></td>
      <td class="r num muted">${m == null ? '—' : m + '%'}</td><td class="r">${stockPill(p)}</td></tr>`; }).join('')}</tbody></table>`
    : `<div class="empty">${Object.keys(S.products).length ? 'Товаров не найдено' : 'Каталог пуст. Отсканируйте упаковку или нажмите «Новый товар».'}</div>`;
}
$('#pr-q').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim(); if (!/^\d{6,14}$/.test(q)) return;
  e.target.value = ''; renderProductTable();
  const hit = findByCode(q); hit ? editProduct(hit.p) : unknownCode(q, 'products');
});
$('#pr-table').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) editProduct(S.products[tr.dataset.id]); };
$('#pr-add').onclick = () => editProduct(null);
function editProduct(p, opts = {}) {
  const n = p || { name: '', category: '', unit: 'шт', barcode: opts.barcode || '', plu: '', cost: '', price: '', stock: 0, min_stock: 5 };
  openModal(`${modalHead(p ? 'Карточка товара' : 'Новый товар')}
    <div class="modal-b">
      <div class="field"><label for="f-bc">Штрихкод${p ? '' : ' — отсканируйте упаковку'}</label><input class="inp num" id="f-bc" value="${esc(n.barcode)}" inputmode="numeric" placeholder="Поднесите товар к сканеру" style="font-size:18px"></div>
      <div class="field"><label for="f-name">Название</label><input class="inp" id="f-name" value="${esc(n.name)}" placeholder="Молоко 3,2% 1 л"></div>
      <div class="grid2">
        <div class="field"><label for="f-cat">Категория</label><input class="inp" id="f-cat" list="f-cats" value="${esc(n.category)}" placeholder="Молочные"><datalist id="f-cats">${cats().map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label for="f-unit">Единица</label><select class="inp" id="f-unit"><option value="шт"${n.unit === 'шт' ? ' selected' : ''}>штука</option><option value="кг"${n.unit === 'кг' ? ' selected' : ''}>килограмм (весовой, без штрихкода)</option></select></div>
        <div class="field" id="plu-f"><label for="f-plu">PLU (код на весах)</label><input class="inp num" id="f-plu" value="${esc(n.plu)}" inputmode="numeric" placeholder="10001"></div>
        <div class="field"><label for="f-cost">Закупочная цена, ₸</label><input class="inp num" id="f-cost" type="number" min="0" value="${esc(n.cost)}"></div>
        <div class="field"><label for="f-price">Цена продажи, ₸</label><input class="inp num" id="f-price" type="number" min="0" value="${esc(n.price)}"></div>
        <div class="field"><label for="f-stock">Остаток${p ? ' (меняется через «Склад»)' : ' на сейчас'}</label><input class="inp num" id="f-stock" type="number" step="0.001" value="${esc(n.stock)}" ${p ? 'disabled' : ''}></div>
        <div class="field"><label for="f-min">Мин. остаток</label><input class="inp num" id="f-min" type="number" min="0" step="0.001" value="${esc(n.min_stock)}"></div>
      </div>
      <div class="muted" id="f-margin" style="font-size:13px"></div>
      <div class="err" id="f-err"></div>
    </div>
    <div class="modal-f">${p && isOwner() ? '<button class="btn danger" id="f-del">Удалить</button><span style="flex:1"></span>' : ''}<button class="btn" data-close>Отмена</button><button class="btn primary" id="f-save">Сохранить</button></div>`,
  { onMount: box => {
      const g = id => box.querySelector('#' + id);
      const sync = () => {
        g('plu-f').hidden = g('f-unit').value !== 'кг';
        const c = +g('f-cost').value, pr = +g('f-price').value;
        g('f-margin').textContent = c && pr ? `Наценка ${Math.round((pr - c) / c * 100)}% · прибыль ${money(pr - c)} с ${g('f-unit').value === 'кг' ? 'кг' : 'единицы'}` : '';
      };
      ['f-unit', 'f-cost', 'f-price'].forEach(i => g(i).addEventListener('input', sync)); sync();
      g('f-bc').addEventListener('keydown', e => {
        if (e.key !== 'Enter') return; e.preventDefault();
        const bc = g('f-bc').value.trim(), dup = bc && prodList().find(x => x.barcode === bc && (!p || x.id !== p.id));
        g('f-err').textContent = dup ? `Этот штрихкод уже у товара «${dup.name}»` : '';
        if (!dup) g('f-name').focus();
      });
      setTimeout(() => (p || n.barcode ? g('f-name') : g('f-bc')).focus(), 0);
      g('f-save').onclick = async () => {
        const name = g('f-name').value.trim(), price = +g('f-price').value, bc = g('f-bc').value.trim();
        if (!name) return g('f-err').textContent = 'Укажите название товара';
        if (!(price > 0)) return g('f-err').textContent = 'Укажите цену продажи больше нуля';
        const dup = bc && prodList().find(x => x.barcode === bc && (!p || x.id !== p.id));
        if (dup) return g('f-err').textContent = `Штрихкод уже у товара «${dup.name}»`;
        const unit = g('f-unit').value;
        const fields = { name, category: g('f-cat').value.trim() || 'Без категории', unit, barcode: bc || null,
          plu: unit === 'кг' ? (g('f-plu').value.trim() || null) : null, cost: +g('f-cost').value || 0, price, min_stock: +g('f-min').value || 0 };
        g('f-save').disabled = true;
        const res = p
          ? await sb.from('products').update(fields).eq('id', p.id).select().single()
          : await sb.from('products').insert({ ...fields, stock: r3(+g('f-stock').value || 0) }).select().single();
        g('f-save').disabled = false;
        if (res.error) return g('f-err').textContent = errText(res.error);
        const rec = normProduct(res.data); S.products[rec.id] = rec;
        closeModal(); toast(p ? 'Товар сохранён' : 'Товар добавлен'); refresh();
        if (opts.onSaved) opts.onSaved(rec);
      };
      const del = g('f-del');
      if (del) del.onclick = async () => {
        if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Убрать из каталога?'; return; }
        const { error } = await sb.rpc('archive_product', { p_product: p.id });
        if (error) return g('f-err').textContent = errText(error);
        delete S.products[p.id]; closeModal(); toast('Товар убран из каталога. История продаж сохранена'); refresh();
      };
  } });
}

/* ---------- склад ---------- */
function productOptions(sel) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">— выберите товар —</option>' + prodList().map(p => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)} (${qf(+p.stock || 0, p.unit)})</option>`).join('');
}
function renderStock() {
  ['#in-p', '#wo-p', '#iv-p'].forEach(s => productOptions($(s)));
  renderInLines(); ivBook(); renderMoves();
}
function pickForIncoming(p, w) {
  if (S.tab !== 'stock') setTab('stock');
  const same = S.inLines.find(l => l.pid === p.id);
  if (same && p.unit !== 'кг') { same.qty += 1; renderInLines(); toast(`${p.name}: ${same.qty} шт в накладной`); $('#in-scan').focus(); return; }
  productOptions($('#in-p')); $('#in-p').value = p.id; $('#in-c').value = p.cost || '';
  $('#in-q').value = w || (p.unit === 'кг' ? '' : 1); $('#in-q').focus(); $('#in-q').select();
}
$('#in-scan').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return; e.preventDefault();
  const q = e.target.value.trim(); if (!q) return; e.target.value = '';
  const hit = findByCode(q);
  if (hit) return pickForIncoming(hit.p, hit.w);
  const byName = prodList().filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  if (byName.length === 1) return pickForIncoming(byName[0]);
  /^\d{6,14}$/.test(q) ? unknownCode(q, 'stock') : toast('Не нашёл товар — уточните название');
});
['#in-q', '#in-c'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#in-addline').click(); } }));
$('#in-p').onchange = () => { const p = S.products[$('#in-p').value]; if (p) { $('#in-c').value = p.cost || ''; $('#in-q').focus(); } };
$('#in-addline').onclick = () => {
  const p = S.products[$('#in-p').value], q = +$('#in-q').value, c = +$('#in-c').value;
  if (!p) return $('#in-err').textContent = 'Выберите товар';
  if (!(q > 0)) return $('#in-err').textContent = 'Укажите количество больше нуля';
  if (p.unit === 'шт' && q !== Math.round(q)) return $('#in-err').textContent = 'Штучный товар — целое количество';
  $('#in-err').textContent = '';
  S.inLines.push({ pid: p.id, name: p.name, unit: p.unit, qty: p.unit === 'кг' ? r3(q) : q, cost: c || 0 });
  $('#in-p').value = ''; $('#in-q').value = ''; $('#in-c').value = ''; renderInLines(); $('#in-scan').focus();
};
function renderInLines() {
  const L = S.inLines;
  $('#in-lines').innerHTML = L.length ? `<table><thead><tr><th>Товар</th><th class="r">Кол-во</th><th class="r">Закуп</th><th class="r">Сумма</th><th></th></tr></thead><tbody>
    ${L.map((l, i) => `<tr><td>${esc(l.name)}</td><td class="r num">${qf(l.qty, l.unit)}</td><td class="r num">${money(l.cost)}</td><td class="r num">${money(l.qty * l.cost)}</td><td class="r"><button class="rm" data-i="${i}">Убрать</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="muted" style="font-size:14px">Сканируйте товары из накладной по одному. Повторный скан штучного товара добавляет +1.</div>';
  $('#in-sum').textContent = money(L.reduce((s, l) => s + l.qty * l.cost, 0));
  $('#in-post').disabled = !L.length;
}
$('#in-lines').onclick = e => { const b = e.target.closest('.rm'); if (b) { S.inLines.splice(+b.dataset.i, 1); renderInLines(); } };
$('#in-post').onclick = async () => {
  const L = S.inLines.slice(); if (!L.length) return;
  $('#in-post').disabled = true;
  const { error } = await sb.rpc('post_incoming', { p_supplier: $('#in-sup').value.trim(), p_doc: $('#in-doc').value.trim(),
    p_lines: L.map(l => ({ product_id: l.pid, qty: l.qty, cost: l.cost })) });
  if (error) { $('#in-post').disabled = false; $('#in-err').textContent = errText(error); return; }
  S.inLines = []; $('#in-sup').value = ''; $('#in-doc').value = '';
  toast('Приход проведён'); await loadProducts(); loadMoves();
};
$('#wo-post').onclick = async () => {
  const p = S.products[$('#wo-p').value], q = +$('#wo-q').value;
  if (!p) return $('#wo-err').textContent = 'Выберите товар';
  if (!(q > 0)) return $('#wo-err').textContent = 'Укажите количество больше нуля';
  $('#wo-err').textContent = '';
  const { error } = await sb.rpc('write_off', { p_product: p.id, p_qty: q, p_reason: $('#wo-r').value });
  if (error) return $('#wo-err').textContent = errText(error);
  $('#wo-q').value = ''; $('#wo-p').value = ''; toast('Списано: ' + p.name); await loadProducts(); loadMoves();
};
function ivBook() { const p = S.products[$('#iv-p').value]; $('#iv-book').textContent = p ? qf(+p.stock || 0, p.unit) : '—'; }
$('#iv-p').onchange = ivBook;
$('#iv-post').onclick = async () => {
  const p = S.products[$('#iv-p').value], v = $('#iv-q').value;
  if (!p) return $('#iv-err').textContent = 'Выберите товар';
  if (v === '' || +v < 0) return $('#iv-err').textContent = 'Введите фактический остаток';
  $('#iv-err').textContent = '';
  const { data, error } = await sb.rpc('set_actual_stock', { p_product: p.id, p_fact: +v });
  if (error) return $('#iv-err').textContent = errText(error);
  $('#iv-q').value = '';
  toast(+data === 0 ? 'Остаток совпадает с учётом' : 'Остаток исправлен: ' + qf(+v, p.unit)); await loadProducts(); loadMoves();
};
async function loadMoves() {
  const { data, error } = await sb.from('stock_moves').select('*, stock_move_lines(*)').order('created_at', { ascending: false }).limit(100);
  if (error) { toast(errText(error)); return; }
  S.moves = data; if (S.tab === 'stock') renderMoves();
}
const MV = { in: ['Приход', 'ok'], writeoff: ['Списание', 'bad'], inventory: ['Инвентаризация', 'info'], return: ['Возврат', 'warn'] };
function renderMoves() {
  const M = S.moves;
  $('#mv-history').innerHTML = M.length ? `<table><thead><tr><th>Дата</th><th>Операция</th><th>Товары</th><th>Кто</th><th class="r">Сумма</th></tr></thead><tbody>
    ${M.map(m => { const t = MV[m.type] || [m.type, 'mute']; const L = m.stock_move_lines || [];
      const sum = L.reduce((s, l) => s + Math.abs(+l.qty) * (+l.cost || 0), 0);
      return `<tr><td class="num muted" style="white-space:nowrap">${dtOf(m.created_at)}</td><td><span class="pill ${t[1]}">${t[0]}</span>${m.note ? `<div class="muted" style="font-size:12px;margin-top:3px">${esc(m.note)}</div>` : ''}</td>
      <td style="font-size:14px">${L.slice(0, 3).map(l => `${esc(l.name)} <span class="num muted">${+l.qty > 0 && m.type === 'inventory' ? '+' : ''}${qf(l.qty, l.unit)}</span>`).join('<br>')}${L.length > 3 ? `<br><span class="muted">и ещё ${L.length - 3}</span>` : ''}</td>
      <td class="muted" style="font-size:14px">${esc(m.user_name)}</td><td class="r num">${money(sum)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">Операций пока нет</div>';
}

/* ---------- продажи ---------- */
$('#sl-date').value = dayOf(Date.now());
$('#sl-date').addEventListener('input', loadSales);
$('#sl-today').onclick = () => { $('#sl-date').value = dayOf(Date.now()); loadSales(); };
async function loadSales() {
  const [y, m, d] = ($('#sl-date').value || dayOf(Date.now())).split('-').map(Number);
  const from = new Date(y, m - 1, d), to = new Date(y, m - 1, d + 1);
  const { data, error } = await sb.from('receipts').select('*, receipt_lines(*)')
    .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('created_at', { ascending: false }).limit(1000);
  if (error) { toast(errText(error)); return; }
  S.receipts = data; if (S.tab === 'sales') renderSales();
}
function renderSales() {
  const all = S.receipts, ok = all.filter(r => !r.returned_at);
  const rev = ok.reduce((s, r) => s + +r.total, 0), prof = ok.reduce((s, r) => s + +r.total - (+r.cost_total || 0), 0);
  const by = { cash: 0, card: 0, qr: 0 }; ok.forEach(r => by[r.method] = (by[r.method] || 0) + +r.total);
  const maxM = Math.max(1, ...Object.values(by));
  const top = {}; ok.forEach(r => (r.receipt_lines || []).forEach(l => { const t = top[l.name] = top[l.name] || { sum: 0, qty: 0, unit: l.unit }; t.sum += +l.sum; t.qty = r3(t.qty + +l.qty); }));
  const topL = Object.entries(top).sort((a, b) => b[1].sum - a[1].sum).slice(0, 6);
  const ret = all.filter(r => r.returned_at);
  $('#sl-body').innerHTML = `
    ${isOwner() ? '' : '<div class="banner" style="background:var(--info-soft);color:var(--info)">Вы видите только свои чеки. Отчёт по всему магазину доступен владельцу.</div>'}
    <div class="kpis">
      <div class="kpi"><div class="k">Выручка</div><div class="v">${money(rev)}</div></div>
      <div class="kpi"><div class="k">Чеков</div><div class="v">${ok.length}</div></div>
      <div class="kpi"><div class="k">Средний чек</div><div class="v">${money(ok.length ? rev / ok.length : 0)}</div></div>
      <div class="kpi owner-only"><div class="k">Валовая прибыль</div><div class="v">${money(prof)}</div></div>
    </div>
    <div class="sales-grid">
      <div class="panel"><div class="panel-h"><h2>Чеки за день</h2>${ret.length ? `<span class="pill warn">возвратов: ${ret.length} · ${money(ret.reduce((s, r) => s + +r.total, 0))}</span>` : ''}</div>
        <div class="tbl-wrap">${all.length ? `<table><thead><tr><th>Время</th><th>№ чека</th><th>Кассир</th><th>Оплата</th><th class="r">Сумма</th></tr></thead><tbody>
          ${all.map(r => `<tr class="click" data-id="${esc(r.id)}"><td class="num">${timeOf(r.created_at)}</td><td class="num muted">${rno(r.no)}</td><td>${esc(r.cashier_name)}</td>
          <td>${METHODS[r.method]}${r.returned_at ? ' <span class="pill bad">возврат</span>' : ''}</td><td class="r num"><b>${money(r.total)}</b></td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">За этот день продаж нет</div>'}</div></div>
      <div class="stack">
        <div class="panel"><div class="panel-h"><h2>По способу оплаты</h2></div><div class="panel-b">
          ${Object.entries(METHODS).map(([k, n]) => `<div class="bar"><span>${n}</span><span class="track"><span class="fill" style="display:block;width:${by[k] / maxM * 100}%"></span></span><span class="num">${money(by[k])}</span></div>`).join('')}
        </div></div>
        <div class="panel"><div class="panel-h"><h2>Лидеры продаж</h2></div>
          ${topL.length ? `<table><tbody>${topL.map(([n, v]) => `<tr><td>${esc(n)}<div class="muted num" style="font-size:12px">${qf(v.qty, v.unit)}</div></td><td class="r num">${money(v.sum)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Нет данных</div>'}
        </div>
      </div>
    </div>`;
}
$('#sl-body').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (!tr) return; const r = S.receipts.find(x => x.id === tr.dataset.id); if (r) showReceipt(r, false); };

/* ---------- профиль ---------- */
$('#cashier-btn').onclick = () => openModal(`${modalHead('Профиль')}
  <div class="modal-b"><div class="field"><label for="c-name">Имя в чеке</label><input class="inp" id="c-name" value="${esc(S.me.full_name)}"></div>
  <div class="muted" style="font-size:13px">Роль: ${isOwner() ? 'владелец — полный доступ' : 'кассир — продажи, возвраты своих чеков, приход товара'}.</div><div class="err" id="c-err"></div></div>
  <div class="modal-f"><button class="btn danger" id="c-out">Выйти</button><span style="flex:1"></span><button class="btn" data-close>Отмена</button><button class="btn primary" id="c-ok">Сохранить</button></div>`,
  { onMount: box => {
      const inp = box.querySelector('#c-name'); setTimeout(() => inp.select(), 0);
      const ok = async () => {
        const full_name = inp.value.trim(); if (!full_name) return box.querySelector('#c-err').textContent = 'Введите имя';
        const { error } = await sb.from('profiles').update({ full_name }).eq('id', S.me.id);
        if (error) return box.querySelector('#c-err').textContent = errText(error);
        S.me.full_name = full_name; closeModal(); setStatus();
      };
      box.querySelector('#c-ok').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      box.querySelector('#c-out').onclick = async () => {
        if (S.cart.length) return box.querySelector('#c-err').textContent = 'Сначала проведите или очистите текущий чек';
        await sb.auth.signOut(); closeModal(); S.me = null; S.products = {}; showLogin();
      };
  } });

/* ---------- горячие клавиши ---------- */
document.addEventListener('keydown', e => {
  if ($('#app').hidden) return;
  if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); return; }
  if (!$('#modal').hidden) return;
  if (e.key === 'F2') { e.preventDefault(); setTab('pos'); $('#pos-q').focus(); }
  if (e.key === 'F9' && S.tab === 'pos') { e.preventDefault(); openPay(); }
});

start();
})();
