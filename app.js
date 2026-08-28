/* =========================================================
   通帳家計簿 - アプリ本体
   すべてのデータはブラウザの localStorage にのみ保存され、
   外部サーバーへは一切送信されません。
   ========================================================= */
(function () {
  'use strict';

  const STORAGE_KEY = 'tsucho_kakeibo_data_v1';
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const CHART_COLORS = ['#B33A3A', '#C9A227', '#2A6F5E', '#1B2A4A', '#8B5E3C', '#6B6552', '#7A8B99', '#A85751', '#4C7A8C', '#8F6E9B'];

  /* ---------------------------------------------------------
     ユーティリティ
  --------------------------------------------------------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function daysInMonth(y, m) { // m: 0-indexed
    return new Date(y, m + 1, 0).getDate();
  }

  function parseDateStr(s) {
    const parts = s.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatYen(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  }

  function formatMonthLabel(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function formatDayLabel(v) {
    return v === 'last' ? '末日' : v + '日';
  }

  function formatOffsetLabel(v) {
    v = String(v);
    return v === '0' ? '当月' : v === '1' ? '翌月' : '翌々月';
  }

  function ymKey(y, m) { return `${y}-${m}`; }

  function sameMonth(dateA, y, m) {
    return dateA.getFullYear() === y && dateA.getMonth() === m;
  }

  /* ---------------------------------------------------------
     データストア
  --------------------------------------------------------- */
  function defaultData() {
    return {
      cards: [],
      categories: {
        expense: ['食費', '日用品', '美容', '交際費', '交通費', '家賃', '水道代', '電気代'],
        income: ['給与', 'その他収入']
      },
      transactions: [],
      fixedCosts: [],
      budget: 0
    };
  }

  let DATA = null;

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      const parsed = JSON.parse(raw);
      const d = defaultData();
      return Object.assign(d, parsed, {
        categories: Object.assign(d.categories, parsed.categories || {})
      });
    } catch (e) {
      console.error('データ読み込みに失敗しました', e);
      return defaultData();
    }
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
    } catch (e) {
      console.error('データ保存に失敗しました', e);
      showToast('保存に失敗しました（容量不足の可能性があります）');
    }
  }

  /* ---------------------------------------------------------
     カード：締め日・引き落とし日の判定ロジック
  --------------------------------------------------------- */
  function getEffectiveDay(dayValue, year, month) {
    const dim = daysInMonth(year, month);
    if (dayValue === 'last') return dim;
    const d = parseInt(dayValue, 10);
    return Math.min(d, dim);
  }

  // 利用日がどの締め月に属するかを判定する
  function computeClosingYM(purchaseDate, closingDayValue) {
    const y = purchaseDate.getFullYear();
    const m = purchaseDate.getMonth();
    const day = purchaseDate.getDate();
    const effClosing = getEffectiveDay(closingDayValue, y, m);
    if (day <= effClosing) {
      return { y, m };
    }
    let ny = y, nm = m + 1;
    if (nm > 11) { nm = 0; ny++; }
    return { y: ny, m: nm };
  }

  // 利用日 + カード設定 から実際の引き落とし日(Date)を計算する
  function computePaymentDate(purchaseDateStr, card) {
    const purchaseDate = parseDateStr(purchaseDateStr);
    const { y, m } = computeClosingYM(purchaseDate, card.closingDay);
    let py = y, pm = m + parseInt(card.paymentOffset, 10);
    while (pm > 11) { pm -= 12; py++; }
    const pd = getEffectiveDay(card.paymentDay, py, pm);
    return new Date(py, pm, pd);
  }

  function getCardById(id) {
    return DATA.cards.find((c) => c.id === id);
  }

  function isCardMethod(method) {
    return typeof method === 'string' && method.indexOf('card:') === 0;
  }

  function methodLabel(method) {
    if (method === 'cash') return '現金';
    if (method === 'bank') return '口座振替';
    if (isCardMethod(method)) {
      const card = getCardById(method.slice(5));
      return card ? card.name : '（削除済みカード）';
    }
    return method;
  }

  /* ---------------------------------------------------------
     固定費の自動計上
  --------------------------------------------------------- */
  function autoApplyFixedCosts() {
    const today = new Date();
    const curY = today.getFullYear(), curM = today.getMonth();
    let changed = false;

    DATA.fixedCosts.forEach((fc) => {
      if (!fc.active) return;

      let startY, startM;
      if (fc.lastAppliedYM) {
        const parts = fc.lastAppliedYM.split('-').map(Number);
        startY = parts[0]; startM = parts[1] + 1;
        if (startM > 11) { startM = 0; startY++; }
      } else {
        const created = fc.createdDate ? parseDateStr(fc.createdDate) : today;
        startY = created.getFullYear(); startM = created.getMonth();
      }

      let y = startY, m = startM;
      while (y < curY || (y === curY && m <= curM)) {
        const dim = daysInMonth(y, m);
        const day = fc.day === 'last' ? dim : Math.min(parseInt(fc.day, 10), dim);
        const isCurrentMonth = (y === curY && m === curM);

        if (!isCurrentMonth || today.getDate() >= day) {
          DATA.transactions.push({
            id: uid(),
            type: 'expense',
            amount: fc.amount,
            date: formatDateStr(new Date(y, m, day)),
            method: fc.method,
            category: fc.category,
            memo: `固定費：${fc.name}`,
            fixedCostId: fc.id,
            createdAt: Date.now()
          });
          fc.lastAppliedYM = ymKey(y, m);
          changed = true;
        }
        m++;
        if (m > 11) { m = 0; y++; }
      }
    });

    if (changed) saveData();
  }

  /* ---------------------------------------------------------
     集計ヘルパー
  --------------------------------------------------------- */
  function txForMonth(y, m) {
    return DATA.transactions.filter((t) => sameMonth(parseDateStr(t.date), y, m));
  }

  function monthSums(y, m) {
    const txs = txForMonth(y, m);
    let income = 0, expense = 0;
    txs.forEach((t) => {
      if (t.type === 'income') income += Number(t.amount);
      else expense += Number(t.amount);
    });
    return { income, expense };
  }

  // 指定の年月に引き落としが発生するカード決済取引を集計する
  function cardDuesForMonth(y, m) {
    const groups = {}; // key: cardId|dateStr -> {card, date, amount}
    DATA.transactions.forEach((t) => {
      if (t.type !== 'expense' || !isCardMethod(t.method)) return;
      const card = getCardById(t.method.slice(5));
      if (!card) return;
      const payDate = computePaymentDate(t.date, card);
      if (payDate.getFullYear() === y && payDate.getMonth() === m) {
        const key = card.id + '|' + formatDateStr(payDate);
        if (!groups[key]) groups[key] = { card, date: payDate, amount: 0, count: 0 };
        groups[key].amount += Number(t.amount);
        groups[key].count++;
      }
    });
    return Object.values(groups).sort((a, b) => a.date - b.date);
  }

  function cardDueTotalForMonth(y, m) {
    return cardDuesForMonth(y, m).reduce((sum, g) => sum + g.amount, 0);
  }

  function categoryBreakdown(y, m) {
    const txs = txForMonth(y, m).filter((t) => t.type === 'expense');
    const map = {};
    txs.forEach((t) => {
      map[t.category] = (map[t.category] || 0) + Number(t.amount);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }

  /* ---------------------------------------------------------
     UI: 共通
  --------------------------------------------------------- */
  let currentView = 'dashboard';
  let dashCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let calCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDate = formatDateStr(new Date());

  let editingTxId = null;
  let editingCardId = null;
  let editingFixedId = null;
  let txSelectedCategory = null;
  let fixedSelectedCategory = null;

  const $ = (id) => document.getElementById(id);

  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function switchView(name) {
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    const titles = { dashboard: '通帳', calendar: 'カレンダー', cards: 'カード・固定費', settings: '設定' };
    $('headerTitle').textContent = titles[name] || '通帳';
    renderCurrentView();
  }

  function renderCurrentView() {
    if (currentView === 'dashboard') renderDashboard();
    else if (currentView === 'calendar') renderCalendar();
    else if (currentView === 'cards') renderCardsView();
    else if (currentView === 'settings') renderSettingsView();
  }

  /* ---------------------------------------------------------
     ダッシュボード
  --------------------------------------------------------- */
  function renderDashboard() {
    const y = dashCursor.getFullYear(), m = dashCursor.getMonth();
    $('dashMonthLabel').textContent = formatMonthLabel(dashCursor);
    $('headerSub').textContent = formatMonthLabel(dashCursor);

    const { income, expense } = monthSums(y, m);
    const remaining = (Number(DATA.budget) || 0) - expense;

    $('sumIncome').textContent = formatYen(income);
    $('sumExpense').textContent = formatYen(expense);
    $('sumBudget').textContent = formatYen(Number(DATA.budget) || 0);

    const remEl = $('remainingAmount');
    remEl.textContent = formatYen(remaining);
    remEl.classList.toggle('negative', remaining < 0);

    let nextY = y, nextM = m + 1;
    if (nextM > 11) { nextM = 0; nextY++; }
    $('cardDueThis').textContent = formatYen(cardDueTotalForMonth(y, m));
    const dueNextEl = $('cardDueNext');
    dueNextEl.textContent = formatYen(cardDueTotalForMonth(nextY, nextM));

    // 引き落とし予定リスト（当月＋翌月）
    const dues = cardDuesForMonth(y, m).concat(cardDuesForMonth(nextY, nextM));
    const dueListEl = $('dueList');
    if (dues.length === 0) {
      dueListEl.innerHTML = '<div class="empty-note">引き落とし予定はありません</div>';
    } else {
      dueListEl.innerHTML = dues.map((g) => {
        const d = g.date;
        return `<div class="ledger-line">
          <div class="stamp">${d.getMonth() + 1}/${d.getDate()}</div>
          <div class="desc">
            <div class="cat">${escapeHtml(g.card.name)}　引き落とし予定</div>
            <div class="meta">${g.count}件の利用分</div>
          </div>
          <div class="amt expense">${formatYen(g.amount)}</div>
        </div>`;
      }).join('');
    }

    // カテゴリ内訳
    renderPieChart(categoryBreakdown(y, m));

    // 最近の記録
    const recent = txForMonth(y, m).slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 15);
    $('recentList').innerHTML = renderTxLines(recent);
    bindTxLineEvents($('recentList'));
  }

  function renderPieChart(breakdown) {
    const canvas = $('pieChart');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const total = breakdown.reduce((s, [, v]) => s + v, 0);
    const legend = $('pieLegend');

    if (total === 0) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#E3DCC9';
      ctx.lineWidth = 14;
      ctx.stroke();
      legend.innerHTML = '<div class="empty-note" style="padding:6px 0;">データがありません</div>';
      return;
    }

    let start = -Math.PI / 2;
    const cx = w / 2, cy = h / 2, r = w / 2 - 6;
    breakdown.forEach(([, val], i) => {
      const angle = (val / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = CHART_COLORS[i % CHART_COLORS.length];
      ctx.fill();
      start += angle;
    });
    // 中抜き（ドーナツ風）
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFDF7';
    ctx.fill();

    legend.innerHTML = breakdown.slice(0, 8).map(([cat, val], i) => `
      <div class="legend-row">
        <span class="dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
        <span class="lname">${escapeHtml(cat)}</span>
        <span class="lval">${formatYen(val)}</span>
      </div>
    `).join('');
  }

  function renderTxLines(txs) {
    if (txs.length === 0) return '<div class="empty-note">記録がありません</div>';
    return txs.map((t) => {
      const d = parseDateStr(t.date);
      const colorIdx = categoryColorIndex(t.category, t.type);
      return `<div class="ledger-line" data-id="${t.id}">
        <span class="cat-dot" style="background:${CHART_COLORS[colorIdx]}"></span>
        <div class="desc">
          <div class="cat">${escapeHtml(t.category)}${t.memo ? '　' + escapeHtml(t.memo) : ''}</div>
          <div class="meta">${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）・${escapeHtml(methodLabel(t.method))}</div>
        </div>
        <div class="amt ${t.type}">${t.type === 'expense' ? '-' : '+'}${formatYen(Math.abs(t.amount))}</div>
        <button class="del-btn" data-del="${t.id}">✕</button>
      </div>`;
    }).join('');
  }

  function categoryColorIndex(cat, type) {
    const list = DATA.categories[type] || [];
    const idx = list.indexOf(cat);
    return idx >= 0 ? idx % CHART_COLORS.length : (type === 'income' ? 2 : 0);
  }

  function bindTxLineEvents(container) {
    container.querySelectorAll('.ledger-line[data-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.del-btn')) return;
        openTxSheet(row.dataset.id);
      });
    });
    container.querySelectorAll('.del-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('この記録を削除しますか？')) {
          DATA.transactions = DATA.transactions.filter((t) => t.id !== btn.dataset.del);
          saveData();
          renderCurrentView();
          showToast('削除しました');
        }
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------------------------------------------------
     カレンダー
  --------------------------------------------------------- */
  function renderCalendar() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    $('calMonthLabel').textContent = formatMonthLabel(calCursor);
    $('headerSub').textContent = formatMonthLabel(calCursor);

    $('calDow').innerHTML = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');

    const dim = daysInMonth(y, m);
    const firstDow = new Date(y, m, 1).getDay();
    const todayStr = formatDateStr(new Date());

    // 日ごとの支出合計
    const dayTotals = {};
    txForMonth(y, m).forEach((t) => {
      if (t.type !== 'expense') return;
      dayTotals[t.date] = (dayTotals[t.date] || 0) + Number(t.amount);
    });

    // 日ごとの引き落とし予定有無
    const dueDays = new Set();
    cardDuesForMonth(y, m).forEach((g) => dueDays.add(formatDateStr(g.date)));

    let html = '';
    for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell empty"></div>';
    for (let day = 1; day <= dim; day++) {
      const dateStr = formatDateStr(new Date(y, m, day));
      const classes = ['cal-cell'];
      if (dateStr === todayStr) classes.push('today');
      if (dateStr === selectedDate) classes.push('selected');
      const total = dayTotals[dateStr];
      html += `<div class="${classes.join(' ')}" data-date="${dateStr}">
        ${dueDays.has(dateStr) ? '<span class="pay-dot"></span>' : ''}
        <div class="d">${day}</div>
        <div class="amt-line">${total ? '¥' + total.toLocaleString('ja-JP') : ''}</div>
      </div>`;
    }
    $('calGrid').innerHTML = html;

    $('calGrid').querySelectorAll('.cal-cell[data-date]').forEach((cell) => {
      cell.addEventListener('click', () => {
        selectedDate = cell.dataset.date;
        renderCalendar();
      });
    });

    renderDayDetail();
  }

  function renderDayDetail() {
    const d = parseDateStr(selectedDate);
    $('dayDetailTitle').textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）`;

    const txs = DATA.transactions.filter((t) => t.date === selectedDate)
      .slice().sort((a, b) => b.createdAt - a.createdAt);
    const dues = cardDuesForMonth(d.getFullYear(), d.getMonth())
      .filter((g) => formatDateStr(g.date) === selectedDate);

    let html = '';
    if (dues.length > 0) {
      html += dues.map((g) => `<div class="ledger-line">
        <div class="stamp">引落</div>
        <div class="desc">
          <div class="cat">${escapeHtml(g.card.name)}　引き落とし予定</div>
          <div class="meta">${g.count}件の利用分</div>
        </div>
        <div class="amt expense">${formatYen(g.amount)}</div>
      </div>`).join('');
    }
    html += renderTxLines(txs) === '<div class="empty-note">記録がありません</div>' && dues.length > 0 ? '' : renderTxLines(txs);

    $('dayDetailList').innerHTML = html || '<div class="empty-note">記録がありません</div>';
    bindTxLineEvents($('dayDetailList'));
  }

  /* ---------------------------------------------------------
     カード・固定費 画面
  --------------------------------------------------------- */
  function renderCardsView() {
    $('headerSub').textContent = '';
    const cardList = $('cardList');
    if (DATA.cards.length === 0) {
      cardList.innerHTML = '<div class="empty-note">カードが登録されていません</div>';
    } else {
      cardList.innerHTML = DATA.cards.map((c) => `
        <div class="card-tile" data-id="${c.id}">
          <div class="ct-body">
            <div class="ct-name">${escapeHtml(c.name)}</div>
            <div class="ct-rule">毎月${formatDayLabel(c.closingDay)}締め → ${formatOffsetLabel(c.paymentOffset)}${formatDayLabel(c.paymentDay)}払い</div>
          </div>
          <div class="ct-actions">
            <button data-edit="${c.id}">編集</button>
            <button data-delete="${c.id}">削除</button>
          </div>
        </div>
      `).join('');
      cardList.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openCardSheet(b.dataset.edit)));
      cardList.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => {
        if (confirm('このカードを削除しますか？\n過去の記録は残りますが、引き落とし予定の計算対象から外れます。')) {
          DATA.cards = DATA.cards.filter((c) => c.id !== b.dataset.delete);
          saveData();
          renderCardsView();
          showToast('削除しました');
        }
      }));
    }

    const fixedList = $('fixedList');
    if (DATA.fixedCosts.length === 0) {
      fixedList.innerHTML = '<div class="empty-note">固定費が登録されていません</div>';
    } else {
      fixedList.innerHTML = DATA.fixedCosts.map((f) => `
        <div class="card-tile" data-id="${f.id}" style="border-left-color:${f.active ? 'var(--gold)' : '#ccc'}; opacity:${f.active ? '1' : '0.55'};">
          <div class="ct-body">
            <div class="ct-name">${escapeHtml(f.name)}　<span style="font-family:var(--font-num); font-weight:400;">${formatYen(f.amount)}</span></div>
            <div class="ct-rule">毎月${formatDayLabel(f.day)}に計上・${escapeHtml(methodLabel(f.method))}・${escapeHtml(f.category)}</div>
          </div>
          <div class="ct-actions">
            <button data-toggle="${f.id}">${f.active ? '停止' : '再開'}</button>
            <button data-edit-fixed="${f.id}">編集</button>
            <button data-delete-fixed="${f.id}">削除</button>
          </div>
        </div>
      `).join('');
      fixedList.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
        const f = DATA.fixedCosts.find((x) => x.id === b.dataset.toggle);
        f.active = !f.active;
        saveData();
        renderCardsView();
      }));
      fixedList.querySelectorAll('[data-edit-fixed]').forEach((b) => b.addEventListener('click', () => openFixedSheet(b.dataset.editFixed)));
      fixedList.querySelectorAll('[data-delete-fixed]').forEach((b) => b.addEventListener('click', () => {
        if (confirm('この固定費を削除しますか？\n（過去に自動計上された記録は残ります）')) {
          DATA.fixedCosts = DATA.fixedCosts.filter((f) => f.id !== b.dataset.deleteFixed);
          saveData();
          renderCardsView();
          showToast('削除しました');
        }
      }));
    }
  }

  /* ---------------------------------------------------------
     設定画面
  --------------------------------------------------------- */
  function renderSettingsView() {
    $('headerSub').textContent = '';
    $('budgetInput').value = DATA.budget || '';
    renderCategoryChips('expense');
    renderCategoryChips('income');
  }

  function renderCategoryChips(type) {
    const el = $(type === 'expense' ? 'expenseCatChips' : 'incomeCatChips');
    el.innerHTML = DATA.categories[type].map((cat) => `
      <span class="chip" data-cat="${escapeHtml(cat)}" data-type="${type}" style="display:inline-flex; align-items:center; gap:6px;">
        ${escapeHtml(cat)}<button data-del-cat="${escapeHtml(cat)}" data-del-type="${type}" style="color:var(--ink-red); font-size:13px;">×</button>
      </span>
    `).join('');
    el.querySelectorAll('[data-del-cat]').forEach((b) => b.addEventListener('click', () => {
      const cat = b.dataset.delCat, t = b.dataset.delType;
      if (DATA.categories[t].length <= 1) { showToast('最低1つは必要です'); return; }
      if (confirm(`「${cat}」を削除しますか？`)) {
        DATA.categories[t] = DATA.categories[t].filter((c) => c !== cat);
        saveData();
        renderCategoryChips(t);
      }
    }));
  }

  /* ---------------------------------------------------------
     取引入力シート
  --------------------------------------------------------- */
  function populateMethodSelect(selectEl) {
    let html = '<option value="cash">現金</option><option value="bank">口座振替</option>';
    DATA.cards.forEach((c) => { html += `<option value="card:${c.id}">${escapeHtml(c.name)}</option>`; });
    selectEl.innerHTML = html;
  }

  function renderTxCatChips(type) {
    const el = $('txCatChips');
    const cats = DATA.categories[type];
    if (!txSelectedCategory || cats.indexOf(txSelectedCategory) === -1) txSelectedCategory = cats[0];
    el.innerHTML = cats.map((c) => `<button type="button" class="chip ${c === txSelectedCategory ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
    el.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
      txSelectedCategory = chip.dataset.cat;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    }));
  }

  function updateTxPaymentPreview() {
    const method = $('txMethod').value;
    const date = $('txDate').value;
    const preview = $('txPaymentPreview');
    if (isCardMethod(method) && date) {
      const card = getCardById(method.slice(5));
      if (card) {
        const pd = computePaymentDate(date, card);
        preview.textContent = `▶ 支払い予定日： ${pd.getFullYear()}年${pd.getMonth() + 1}月${pd.getDate()}日（${card.name}）`;
        return;
      }
    }
    preview.textContent = '';
  }

  function openTxSheet(txId, prefillDate) {
    editingTxId = txId || null;
    const tx = txId ? DATA.transactions.find((t) => t.id === txId) : null;

    $('txSheetTitle').textContent = tx ? '記録を編集' : '記録を追加';
    const type = tx ? tx.type : 'expense';
    $('txTypeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));

    $('txAmount').value = tx ? tx.amount : '';
    $('txDate').value = tx ? tx.date : (prefillDate || formatDateStr(new Date()));
    populateMethodSelect($('txMethod'));
    $('txMethod').value = tx ? tx.method : 'cash';
    $('txMemo').value = tx ? (tx.memo || '') : '';
    txSelectedCategory = tx ? tx.category : null;
    renderTxCatChips(type);
    updateTxPaymentPreview();

    $('txSheetOverlay').classList.add('active');
  }

  function closeTxSheet() {
    $('txSheetOverlay').classList.remove('active');
    editingTxId = null;
  }

  function saveTxFromSheet() {
    const type = $('txTypeSeg').querySelector('button.active').dataset.type;
    const amount = parseFloat($('txAmount').value);
    const date = $('txDate').value;
    const method = $('txMethod').value;
    const memo = $('txMemo').value.trim();

    if (!amount || amount <= 0) { showToast('金額を入力してください'); return; }
    if (!date) { showToast('日付を入力してください'); return; }
    if (!txSelectedCategory) { showToast('カテゴリを選択してください'); return; }

    if (editingTxId) {
      const tx = DATA.transactions.find((t) => t.id === editingTxId);
      Object.assign(tx, { type, amount, date, method, memo, category: txSelectedCategory });
    } else {
      DATA.transactions.push({
        id: uid(), type, amount, date, method, memo, category: txSelectedCategory, createdAt: Date.now()
      });
    }
    saveData();
    closeTxSheet();
    renderCurrentView();
    showToast('保存しました');
  }

  /* ---------------------------------------------------------
     カード登録シート
  --------------------------------------------------------- */
  function dayOptionsHtml() {
    let html = '';
    for (let i = 1; i <= 31; i++) html += `<option value="${i}">${i}日</option>`;
    html += '<option value="last">末日</option>';
    return html;
  }

  function updateCardRulePreview() {
    const closing = $('cardClosingDay').value;
    const offset = $('cardPayOffset').value;
    const payDay = $('cardPaymentDay').value;
    $('cardRulePreview').textContent = `例：毎月${formatDayLabel(closing)}締め → ${formatOffsetLabel(offset)}${formatDayLabel(payDay)}払い`;
  }

  function openCardSheet(cardId) {
    editingCardId = cardId || null;
    const card = cardId ? getCardById(cardId) : null;
    $('cardSheetTitle').textContent = card ? 'カードを編集' : 'カードを追加';
    $('cardClosingDay').innerHTML = dayOptionsHtml();
    $('cardPaymentDay').innerHTML = dayOptionsHtml();

    $('cardName').value = card ? card.name : '';
    $('cardClosingDay').value = card ? card.closingDay : '15';
    $('cardPayOffset').value = card ? card.paymentOffset : '1';
    $('cardPaymentDay').value = card ? card.paymentDay : '10';
    updateCardRulePreview();
    $('cardSheetOverlay').classList.add('active');
  }

  function closeCardSheet() {
    $('cardSheetOverlay').classList.remove('active');
    editingCardId = null;
  }

  function saveCardFromSheet() {
    const name = $('cardName').value.trim();
    if (!name) { showToast('カード名を入力してください'); return; }
    const closingDay = $('cardClosingDay').value;
    const paymentOffset = $('cardPayOffset').value;
    const paymentDay = $('cardPaymentDay').value;

    if (editingCardId) {
      const c = getCardById(editingCardId);
      Object.assign(c, { name, closingDay, paymentOffset, paymentDay });
    } else {
      DATA.cards.push({ id: uid(), name, closingDay, paymentOffset, paymentDay });
    }
    saveData();
    closeCardSheet();
    renderCardsView();
    showToast('保存しました');
  }

  /* ---------------------------------------------------------
     固定費登録シート
  --------------------------------------------------------- */
  function renderFixedCatChips() {
    const el = $('fixedCatChips');
    const cats = DATA.categories.expense;
    if (!fixedSelectedCategory || cats.indexOf(fixedSelectedCategory) === -1) fixedSelectedCategory = cats[0];
    el.innerHTML = cats.map((c) => `<button type="button" class="chip ${c === fixedSelectedCategory ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
    el.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
      fixedSelectedCategory = chip.dataset.cat;
      el.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    }));
  }

  function openFixedSheet(fixedId) {
    editingFixedId = fixedId || null;
    const f = fixedId ? DATA.fixedCosts.find((x) => x.id === fixedId) : null;
    $('fixedDay').innerHTML = dayOptionsHtml();
    populateMethodSelect($('fixedMethod'));

    $('fixedName').value = f ? f.name : '';
    $('fixedAmount').value = f ? f.amount : '';
    $('fixedDay').value = f ? f.day : '1';
    $('fixedMethod').value = f ? f.method : 'bank';
    fixedSelectedCategory = f ? f.category : null;
    renderFixedCatChips();

    $('fixedSheetOverlay').classList.add('active');
  }

  function closeFixedSheet() {
    $('fixedSheetOverlay').classList.remove('active');
    editingFixedId = null;
  }

  function saveFixedFromSheet() {
    const name = $('fixedName').value.trim();
    const amount = parseFloat($('fixedAmount').value);
    if (!name) { showToast('名称を入力してください'); return; }
    if (!amount || amount <= 0) { showToast('金額を入力してください'); return; }

    const day = $('fixedDay').value;
    const method = $('fixedMethod').value;

    if (editingFixedId) {
      const f = DATA.fixedCosts.find((x) => x.id === editingFixedId);
      Object.assign(f, { name, amount, day, method, category: fixedSelectedCategory });
    } else {
      DATA.fixedCosts.push({
        id: uid(), name, amount, day, method, category: fixedSelectedCategory,
        active: true, createdDate: formatDateStr(new Date()), lastAppliedYM: null
      });
    }
    saveData();
    autoApplyFixedCosts();
    closeFixedSheet();
    renderCardsView();
    showToast('保存しました');
  }

  /* ---------------------------------------------------------
     データ書き出し／読み込み／初期化
  --------------------------------------------------------- */
  function exportData() {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tsucho-kakeibo-${formatDateStr(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
        DATA = Object.assign(defaultData(), parsed);
        saveData();
        renderCurrentView();
        showToast('読み込みました');
      } catch (e) {
        showToast('ファイルの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------
     イベント初期化
  --------------------------------------------------------- */
  function initEvents() {
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });

    $('dashPrevMonth').addEventListener('click', () => { dashCursor.setMonth(dashCursor.getMonth() - 1); renderDashboard(); });
    $('dashNextMonth').addEventListener('click', () => { dashCursor.setMonth(dashCursor.getMonth() + 1); renderDashboard(); });
    $('calPrevMonth').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
    $('calNextMonth').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });

    $('fabAdd').addEventListener('click', () => openTxSheet(null, currentView === 'calendar' ? selectedDate : formatDateStr(new Date())));
    $('txCancelBtn').addEventListener('click', closeTxSheet);
    $('txSaveBtn').addEventListener('click', saveTxFromSheet);
    $('txSheetOverlay').addEventListener('click', (e) => { if (e.target === $('txSheetOverlay')) closeTxSheet(); });
    $('txTypeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      $('txTypeSeg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      txSelectedCategory = null;
      renderTxCatChips(b.dataset.type);
    }));
    $('txMethod').addEventListener('change', updateTxPaymentPreview);
    $('txDate').addEventListener('change', updateTxPaymentPreview);

    $('addCardBtn').addEventListener('click', () => openCardSheet(null));
    $('cardCancelBtn').addEventListener('click', closeCardSheet);
    $('cardSaveBtn').addEventListener('click', saveCardFromSheet);
    $('cardSheetOverlay').addEventListener('click', (e) => { if (e.target === $('cardSheetOverlay')) closeCardSheet(); });
    ['cardClosingDay', 'cardPayOffset', 'cardPaymentDay'].forEach((id) => $(id).addEventListener('change', updateCardRulePreview));

    $('addFixedBtn').addEventListener('click', () => openFixedSheet(null));
    $('fixedCancelBtn').addEventListener('click', closeFixedSheet);
    $('fixedSaveBtn').addEventListener('click', saveFixedFromSheet);
    $('fixedSheetOverlay').addEventListener('click', (e) => { if (e.target === $('fixedSheetOverlay')) closeFixedSheet(); });

    $('saveBudgetBtn').addEventListener('click', () => {
      DATA.budget = parseFloat($('budgetInput').value) || 0;
      saveData();
      showToast('予算を保存しました');
      renderDashboard();
    });

    $('addExpenseCatBtn').addEventListener('click', () => {
      const input = $('newExpenseCat');
      const v = input.value.trim();
      if (!v) return;
      if (DATA.categories.expense.includes(v)) { showToast('既に存在します'); return; }
      DATA.categories.expense.push(v);
      saveData();
      input.value = '';
      renderCategoryChips('expense');
    });
    $('addIncomeCatBtn').addEventListener('click', () => {
      const input = $('newIncomeCat');
      const v = input.value.trim();
      if (!v) return;
      if (DATA.categories.income.includes(v)) { showToast('既に存在します'); return; }
      DATA.categories.income.push(v);
      saveData();
      input.value = '';
      renderCategoryChips('income');
    });

    $('exportBtn').addEventListener('click', exportData);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('resetBtn').addEventListener('click', () => {
      if (confirm('本当にすべてのデータを削除しますか？この操作は取り消せません。')) {
        localStorage.removeItem(STORAGE_KEY);
        DATA = defaultData();
        renderCurrentView();
        showToast('初期化しました');
      }
    });
  }

  /* ---------------------------------------------------------
     初期化
  --------------------------------------------------------- */
  function init() {
    DATA = loadData();
    autoApplyFixedCosts();
    initEvents();
    switchView('dashboard');

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
