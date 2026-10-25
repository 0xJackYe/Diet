import { MEALS, NUTRIENTS, today, estimate, nutritionTotal, dayTotal, validateDiary, validateDay, mergeDays } from './lib.mjs';
import { setupQuickEntry } from './quick-entry.js';
import { applyParsedMeals, undoParsedMeals } from './quick-merge.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, digits = 0) => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const dateObj = d => new Date(d + 'T12:00:00+08:00');
const dateLabel = d => dateObj(d).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
const shift = (d, n) => { const x = dateObj(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const storageKey = 'shiguang-drafts-v1';
let canonical, catalog, drafts = [], days = [], selected = today(), view = 'diary', editing = null, editingDate = null;
let calendarMonth = today().slice(0, 7), detailOpen = false, quickController;
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').classList.remove('show'); $('#toast').hidden = true; }, 4500); }
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, days: drafts })); }
  catch { toast('浏览器无法保存草稿，请立即导出备份；当前页面仍保留记录。'); }
  days = mergeDays(canonical.days, drafts);
}
function selectedDay() { return days.find(d => d.date === selected); }
function isDraft(id, date = selected) { return drafts.some(d => d.date === date && d.meals.some(m => m.id === id)); }
function weekDates() { const dow = dateObj(selected).getUTCDay(); const monday = shift(selected, -(dow === 0 ? 6 : dow - 1)); return Array.from({ length: 7 }, (_, i) => shift(monday, i)); }
function eatenDays(list) { return list.filter(d => d.meals.some(m => m.status === 'eaten')); }
function setDate(date) { selected = date; calendarMonth = date.slice(0, 7); detailOpen = true; render(); }
function switchView(next, { history = true, replace = false } = {}) {
  if (!['diary', 'trends', 'foods', 'record'].includes(next)) next = 'diary';
  if (view === 'record' && next !== 'record') quickController?.cancel();
  view = next;
  for (const v of ['diary', 'trends', 'foods', 'record']) $(`#view-${v}`).hidden = v !== view;
  document.body.classList.toggle('is-record-view', view === 'record');
  document.querySelector('.hero').hidden = view === 'record';
  if (history && location.hash !== `#${next}`) window.history[replace ? 'replaceState' : 'pushState']({ view: next }, '', `#${next}`);
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  render();
}
function setRecordMethod(method) {
  for (const mode of ['natural', 'form']) {
    $(`#record-${mode}-panel`).hidden = mode !== method;
    const button = $(`#record-method-${mode}`);
    button.classList.toggle('active', mode === method);
    button.setAttribute('aria-selected', String(mode === method));
    button.tabIndex = mode === method ? 0 : -1;
  }
}
function openRecord(method = 'natural') {
  prepareMealForm();
  const recordDate = detailOpen ? selected : today();
  $('#entry-date').value = recordDate;
  if (!$('#quick-text').value.trim()) {
    $('#quick-date').value = recordDate;
    $('#quick-date').dispatchEvent(new Event('input', { bubbles: true }));
  }
  setRecordMethod(method);
  switchView('record');
  $('#record-back').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function statsMarkup(day) {
  const total = dayTotal(day), planned = dayTotal(day, 'planned');
  const count = day?.meals.filter(m => m.status === 'eaten').length ?? 0;
  return [
    ['已记录热量', total.kcal, 'kcal', `${count ? `${count} 餐已吃` : '尚无已吃记录'}${planned.kcal ? ` · 计划另约 ${fmt(planned.kcal)} kcal` : ''}`],
    ['蛋白质', total.protein, 'g', '来自已吃的餐食'],
    ['碳水化合物', total.carbs, 'g', '按食材份量估算'],
    ['总脂肪', total.fat, 'g', '包括已记录的用油']
  ].map(([label, value, unit, detail]) => `<div class="stat-card"><div class="stat-label">${label}</div><div><span class="stat-value">${count ? fmt(value, unit === 'g' ? 1 : 0) : '—'}</span><span class="stat-unit">${unit}</span></div><div class="stat-detail">${detail}</div></div>`).join('');
}
function mealMarkup(meal) {
  const total = nutritionTotal(meal.items);
  const icons = { breakfast: '☀', lunch: '◒', dinner: '☾', snack: '◌' };
  return `<article class="meal-card"><div class="meal-heading"><div class="meal-icon ${esc(meal.type)}">${icons[meal.type]}</div><div class="meal-title-group"><div class="meal-type">${MEALS[meal.type]} <span class="badge ${meal.status === 'planned' ? 'planned' : ''}">${meal.status === 'planned' ? '计划 · 待确认' : '已吃'}</span>${isDraft(meal.id) ? ' <span class="badge local">本机草稿</span>' : ''}</div><h3 class="meal-title">${esc(meal.title)}</h3></div><div class="meal-kcal"><strong>${fmt(total.kcal)}</strong><span>约 kcal</span></div></div>
  <div class="food-table-wrap"><table class="food-table"><thead><tr><th>食材</th><th>份量与依据</th><th>热量</th></tr></thead><tbody>${meal.items.map(item => `<tr><td>${item.note ? `<details class="item-detail"><summary class="food-name">${esc(item.name)}</summary><p>${esc(item.note)}</p></details>` : `<span class="food-name">${esc(item.name)}</span>`}</td><td>${fmt(item.amount, 1)} ${esc(item.unit)} <span class="weight-basis">${esc(item.basis ?? '')}</span>${item.estimatedPortion ? '<span class="portion-estimate">份量估算</span>' : ''}</td><td>${fmt(item.nutrition.kcal)} <small>kcal</small></td></tr>`).join('')}</tbody></table></div>
  <div class="meal-footer"><span>蛋白质 ${fmt(total.protein, 1)}g <span class="footer-separator">·</span> 膳食纤维 ${fmt(total.fiber, 1)}g <span class="footer-separator">·</span> 饱和脂肪 ${fmt(total.saturatedFat, 1)}g</span><div class="meal-actions">${meal.status === 'planned' ? `<button data-confirm="${esc(meal.id)}">确认已吃</button>` : ''}<button data-edit="${esc(meal.id)}" aria-label="编辑${esc(meal.title)}">编辑</button></div></div>${meal.note ? `<p class="meal-note">${esc(meal.note)}</p>` : ''}</article>`;
}
function chartMarkup(dates) {
  const values = dates.map(date => { const d = days.find(d => d.date === date); return d?.meals.some(m => m.status === 'eaten') ? dayTotal(d).kcal : null; });
  const max = Math.max(1, ...values.filter(v => v != null));
  return `<div class="chart-bars">${dates.map((date, i) => `<button class="chart-column" data-date="${date}" aria-label="${date} ${values[i] == null ? '未记录' : `已吃约${fmt(values[i])}千卡`}"><span class="chart-value">${values[i] == null ? '—' : fmt(values[i])}</span><span class="chart-bar ${date === selected ? 'is-current' : ''} ${values[i] == null ? 'is-missing' : ''}" style="height:${values[i] == null ? 5 : Math.max(6, values[i] / max * 100)}%"></span><span class="chart-day">${['日', '一', '二', '三', '四', '五', '六'][dateObj(date).getUTCDay()]}</span></button>`).join('')}</div>`;
}
function render() {
  const day = selectedDay();
  $('#selected-date-title').textContent = dateLabel(selected);
  $('#selected-date-subtitle').textContent = day?.title || '每一餐，都值得好好记录';
  renderCalendar();
  $('#day-detail').hidden = !detailOpen;
  $('#daily-stats').innerHTML = statsMarkup(day);
  const query = $('#search-input').value.trim().toLowerCase();
  const order = Object.keys(MEALS);
  const matched = (day?.meals.filter(m => `${m.title} ${m.note ?? ''} ${m.items.map(i => i.name).join(' ')}`.toLowerCase().includes(query)) ?? []).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  $('#meal-list').innerHTML = matched.length ? matched.map(mealMarkup).join('') : `<div class="empty-state"><span>◡</span><h3>${query ? '没有找到这道食物' : '这一天还没有记录'}</h3><p>${query ? '试试其他食材名称。' : '记录吃过的一餐，食材和估算会出现在这里。'}</p>${query ? '' : '<button class="button button-primary" data-new-meal>＋ 记录饮食</button>'}</div>`;
  $('#day-note').textContent = day?.note || '今天吃了什么、用了多少份量，都可以在下一次对话里告诉我。';
  const total = day?.meals.some(m => m.status === 'eaten') ? dayTotal(day) : Object.fromEntries(NUTRIENTS.map(n => [n, null])), energy = total.kcal || 1;
  $('#daily-macros').innerHTML = [['蛋白质', total.protein, 4, 'protein'], ['碳水化合物', total.carbs, 4, 'carbs'], ['脂肪', total.fat, 9, 'fat']].map(([label, n, factor, cls]) => `<div class="macro-row"><span class="macro-label">${label}</span><span class="macro-track"><span class="${cls}" style="width:${Math.min(100, (n || 0) * factor / energy * 100)}%"></span></span><span class="macro-value">${fmt(n, 1)}g</span></div>`).join('') + `<div class="nutrition-extra"><span>膳食纤维 <strong>${fmt(total.fiber, 1)}g</strong></span><span>饱和脂肪 <strong>${fmt(total.saturatedFat, 1)}g</strong></span></div><p class="source-note">色条为估算供能占比；“—”表示数据不完整。</p>`;
  $('#weekly-chart').innerHTML = chartMarkup(weekDates());
  const count = eatenDays(days.filter(d => weekDates().includes(d.date))).length;
  $('#coverage-note').textContent = `本周 ${count} 天有已吃记录 · 空白日期不计入均值`;
  if (view === 'trends') renderTrends();
  if (view === 'foods') renderFoods();
}
function renderTrends() {
  const week = days.filter(d => weekDates().includes(d.date)), eaten = eatenDays(week);
  const avg = eaten.length ? eaten.reduce((s, d) => s + dayTotal(d).kcal, 0) / eaten.length : null;
  $('#trend-content').innerHTML = `<div class="trend-grid"><div class="trend-card"><span class="stat-label">本周已记录</span><div class="stat-value">${eaten.length}<small> 天</small></div><p>仅统计有已吃餐食的日期</p></div><div class="trend-card"><span class="stat-label">已记录日均热量</span><div class="stat-value">${fmt(avg)}<small> kcal</small></div><p>部分天尚未记全，均值仅作记录参考</p></div></div><div class="trend-card"><h3>这一周的记录</h3>${chartMarkup(weekDates())}</div><div class="history-list">${[...days].reverse().map(day => `<button class="history-day" data-history-date="${day.date}"><span>${dateLabel(day.date)}<small>${esc(day.title)}</small></span><span>${fmt(dayTotal(day).kcal)} kcal <small>已吃 ${day.meals.filter(m => m.status === 'eaten').length} 餐 · 计划 ${day.meals.filter(m => m.status === 'planned').length} 餐</small></span><span>↗</span></button>`).join('') || '<p class="empty-state">还没有饮食记录。</p>'}</div>`;
}
function renderFoods() {
  const query = $('#search-input').value.trim().toLowerCase();
  const filtered = catalog.foods.filter(f => `${f.name} ${f.basis}`.toLowerCase().includes(query));
  $('#food-reference').innerHTML = `<p class="source-note">每 100g 可食部的参考营养；牛奶按 1ml ≈ 1g 估算。包装食品以手中的标签为准，烹调用油单独计算。数值用于日记估算。</p><div class="reference-grid">${filtered.map(f => `<article class="reference-card"><div class="reference-heading"><h3>${esc(f.name)}</h3><strong>${fmt(f.per100.kcal)}<small> kcal / 100${esc(f.unit)}</small></strong></div><p>${esc(f.basis)}</p><div class="reference-nutrients">蛋白质 ${fmt(f.per100.protein, 1)}g · 碳水 ${fmt(f.per100.carbs, 1)}g · 脂肪 ${fmt(f.per100.fat, 1)}g</div><p class="source-note">${esc(f.note ?? '')}</p><a href="${esc(catalog.sources.find(s => s.id === f.sourceId)?.url || 'https://fdc.nal.usda.gov/download-datasets/')}" target="_blank" rel="noreferrer">${esc(catalog.sources.find(s => s.id === f.sourceId)?.name || '营养参考来源')} ↗</a></article>`).join('')}</div>`;
}
function saveDraft(day) {
  validateDay(day); drafts = mergeDays(drafts, [day]); persist(); render();
}
function commitQuickDrafts(next) {
  validateDiary({ schemaVersion: 1, days: next });
  try { localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, days: next })); }
  catch { throw new Error('浏览器没有成功保存，请先导出日记释放空间后重试。口述文字仍保留在输入框。'); }
  drafts = next;
  days = mergeDays(canonical.days, drafts);
}
function applyQuickEntry(incoming) {
  const result = applyParsedMeals(canonical.days, drafts, incoming);
  if (!result.alreadyApplied) commitQuickDrafts(result.drafts);
  selected = incoming.at(-1)?.date ?? selected;
  calendarMonth = selected.slice(0, 7); detailOpen = true;
  $('#search-input').value = '';
  $('#record-view-day').hidden = false;
  render();
  return result.alreadyApplied ? null : result.undoToken;
}
function undoQuickEntry(token) {
  const result = undoParsedMeals(canonical.days, drafts, token);
  if (result.preservedCount) throw new Error('这次记录里有餐食后来被编辑过，已保留这些修改。请直接在对应卡片里调整。');
  commitQuickDrafts(result.drafts);
  render();
}
function prepareMealForm(meal = null) {
  editing = meal;
  editingDate = meal ? selected : null;
  $('#meal-form').reset();
  $('#entry-date').value = selected;
  $('#entry-date').readOnly = !!meal;
  $('#entry-type').value = meal?.type ?? 'breakfast';
  $('#entry-status').value = meal?.status ?? 'eaten';
  $('#entry-title').value = meal?.title ?? '';
  $('#entry-note').value = meal?.note ?? '';
  $('#food-rows').replaceChildren();
  (meal?.items ?? [null]).forEach(addFoodRow);
  $('#meal-dialog-title').textContent = meal ? '编辑这顿饭' : '填写餐食';
}
function openMeal(meal = null) {
  prepareMealForm(meal);
  setRecordMethod('form');
  switchView('record');
  $('#entry-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function addFoodRow(item = null) {
  const row = document.createElement('div'); row.className = 'food-row';
  const food = catalog.foods.find(f => f.id === item?.foodId);
  row.innerHTML = `<div class="food-row-top"><label>参考食材<select class="row-food">${catalog.foods.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}<option value="custom">其他食物 · 手动估算</option></select></label><button class="remove-row" type="button" aria-label="移除此食材">×</button></div><div class="food-row-fields"><label>食材名称<input class="row-name" maxlength="100" required></label><label>份量<input class="row-amount" type="number" min="0.1" max="10000" step="0.1" required></label><label>单位<select class="row-unit"><option value="g">g</option><option value="ml">ml</option></select></label><label>本份热量 kcal<input class="row-kcal" type="number" min="0" max="100000" step="0.1" required></label></div><p class="row-estimate"></p>`;
  const get = s => row.querySelector(s);
  get('.row-food').value = item ? food?.id ?? 'custom' : catalog.foods[0].id;
  get('.row-name').value = item?.name ?? catalog.foods[0].name;
  get('.row-amount').value = item?.amount ?? 100;
  get('.row-unit').value = item?.unit ?? 'g';
  get('.row-kcal').value = item?.nutrition.kcal ?? catalog.foods[0].per100.kcal;
  const update = (resetName = false) => {
    const f = catalog.foods.find(f => f.id === get('.row-food').value);
    get('.row-kcal').readOnly = !!f;
    if (f) {
      if (resetName) { get('.row-name').value = f.name; get('.row-unit').value = f.unit; }
      get('.row-kcal').value = estimate(f, Number(get('.row-amount').value)).kcal;
    }
    get('.row-estimate').textContent = f ? `${f.basis}；${f.note ?? '按参考食材估算，实际以品牌与烹调方式为准。'}` : '填写这一份的总热量。其他营养素记为未知，不当作零。';
  };
  get('.row-food').addEventListener('change', () => update(true));
  get('.row-amount').addEventListener('input', () => update());
  get('.row-unit').addEventListener('change', () => update());
  get('.remove-row').addEventListener('click', () => { if ($('#food-rows').children.length > 1) row.remove(); else toast('每餐至少保留一种食材。'); });
  row.originalItem = item; update(); $('#food-rows').append(row);
}
function saveMeal(event) {
  event.preventDefault();
  try {
    const date = $('#entry-date').value;
    if (editing && date !== editingDate) { toast('编辑餐食时保留原日期；其他日期请新增餐食。'); return; }
    const latestMeal = editing && days.find(day => day.date === editingDate)?.meals.find(meal => meal.id === editing.id);
    if (editing && JSON.stringify(latestMeal) !== JSON.stringify(editing)) { toast('这餐已更新，请返回日历重新打开编辑，以保留最新食材。'); return; }
    const items = [...$('#food-rows').children].map((row, i) => {
      const get = s => row.querySelector(s).value;
      const food = catalog.foods.find(f => f.id === get('.row-food'));
      const amount = Number(get('.row-amount'));
      const old = row.originalItem;
      const sameFood = old && old.foodId === (food?.id ?? null);
      const sameQuantity = sameFood && old.amount === amount && old.unit === get('.row-unit');
      const conversionNote = food?.unit === 'g' && get('.row-unit') === 'ml' ? '体积暂按 1ml≈1g 估算。' : '';
      const note = sameQuantity ? old.note ?? '' : `${old && sameFood ? `网页更正为 ${amount}${get('.row-unit')}。原记录：${old.note ?? ''} ` : ''}${conversionNote}`;
      return { id: old?.id ?? `item-${crypto.randomUUID()}`, foodId: food?.id ?? null, name: get('.row-name').trim(), amount, unit: get('.row-unit'), basis: sameFood ? old.basis : food?.basis ?? '手动记录', estimatedPortion: sameQuantity ? old.estimatedPortion : true, nutrition: food ? estimate(food, amount) : { ...Object.fromEntries(NUTRIENTS.map(n => [n, null])), kcal: Number(get('.row-kcal')) }, note };
    });
    const confirmed = editing?.status === 'planned' && $('#entry-status').value === 'eaten';
    const meal = { ...editing, id: editing?.id ?? `meal-${crypto.randomUUID()}`, type: $('#entry-type').value, status: $('#entry-status').value, title: $('#entry-title').value.trim(), note: `${$('#entry-note').value.trim()}${confirmed ? '（后续已在网站确认吃过。）' : ''}`, modifiedAt: new Date().toISOString(), items };
    const previous = days.find(d => d.date === date);
    saveDraft({ date, title: previous?.title ?? '认真吃饭的一天', note: `${previous?.note ?? ''}${confirmed ? ` 补充：${MEALS[meal.type]}已在网站确认为吃过。` : ''}`, source: previous?.source ?? { label: '网站手动记录' }, meals: [meal] });
    selected = date; calendarMonth = date.slice(0, 7); detailOpen = true;
    switchView('diary', { replace: true }); showDayDetail(); toast('已保存到本机草稿。');
  } catch (error) { toast(error.message); }
}
function renderCalendar() {
  const month = calendarMonth;
  $('#calendar-month').value = month;
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const first = month + '-01', count = Number(shift(shift(first, 32).slice(0, 7) + '-01', -1).slice(-2));
  const pad = (dateObj(first).getUTCDay() + 6) % 7;
  $('#calendar-grid').innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map(x => `<span class="month-weekday">周${x}</span>`).join('') + '<span class="month-pad" aria-hidden="true"></span>'.repeat(pad) + Array.from({ length: count }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const day = days.find(d => d.date === date);
    const eaten = day?.meals.filter(m => m.status === 'eaten').length ?? 0;
    const planned = day?.meals.filter(m => m.status === 'planned').length ?? 0;
    const active = detailOpen && date === selected;
    const description = [eaten ? `${eaten}餐已吃` : '', planned ? `${planned}餐计划` : ''].filter(Boolean).join('，') || '未记录';
    return `<button type="button" class="month-day ${active ? 'is-selected' : ''} ${eaten || planned ? 'has-record' : ''} ${date === today() ? 'is-today' : ''}" data-calendar-date="${date}" aria-controls="day-detail" aria-expanded="${active}" aria-label="${date} ${description}"><span class="month-day-number">${i + 1}</span><span class="month-day-meta">${eaten ? `${eaten}餐已吃` : planned ? `${planned}餐计划` : ''}</span></button>`;
  }).join('');
}
function changeMonth(offset) {
  const date = dateObj(calendarMonth + '-01');
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = date.toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(next)) return;
  calendarMonth = next; detailOpen = false; render();
}
function showDayDetail() {
  $('#selected-date-title').setAttribute('tabindex', '-1');
  $('#selected-date-title').focus({ preventScroll: true });
  $('#day-detail').scrollIntoView({ block: 'start' });
}
function exportDiary() {
  const payload = { ...canonical, updatedAt: new Date().toISOString(), days };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `食光-饮食日记-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('日记已导出，包含仓库记录与本机草稿。');
}
async function importDiary(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('请导入 10MB 以内的日记文件。');
    const incoming = validateDiary(JSON.parse(await file.text()));
    drafts = mergeDays(drafts, incoming.days); persist(); setDate(days.at(-1)?.date ?? today()); switchView('diary'); toast(`已合并 ${incoming.days.length} 天到本机草稿，同 ID 餐食更新，其余保留。`);
  } catch (error) { toast(`导入未完成：${error.message}`); }
  event.target.value = '';
}
function wire() {
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#today-button').addEventListener('click', () => { switchView('diary'); setDate(today()); });
  $('#search-input').addEventListener('input', render);
  $('#add-meal-button').addEventListener('click', () => openRecord());
  $('#add-food-row').addEventListener('click', () => addFoodRow());
  $('#meal-form').addEventListener('submit', saveMeal);
  $('#cancel-meal').addEventListener('click', () => switchView('diary', { replace: true }));
  $('#record-back').addEventListener('click', () => switchView('diary', { replace: true }));
  $('#record-view-day').addEventListener('click', () => { switchView('diary', { replace: true }); showDayDetail(); });
  document.querySelectorAll('[data-record-method]').forEach(button => {
    button.addEventListener('click', () => setRecordMethod(button.dataset.recordMethod));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const method = event.key === 'Home' ? 'natural' : event.key === 'End' ? 'form' : button.dataset.recordMethod === 'natural' ? 'form' : 'natural';
      setRecordMethod(method); $(`#record-method-${method}`).focus();
    });
  });
  $('#calendar-prev').addEventListener('click', () => changeMonth(-1));
  $('#calendar-next').addEventListener('click', () => changeMonth(1));
  $('#calendar-month').addEventListener('change', event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) { calendarMonth = event.target.value; detailOpen = false; render(); } else event.target.value = calendarMonth; });
  $('#close-day-detail').addEventListener('click', () => { detailOpen = false; render(); $(`[data-calendar-date="${selected}"]`)?.focus({ preventScroll: true }); });
  window.addEventListener('popstate', () => switchView(location.hash.slice(1), { history: false }));
  $('#export-button').addEventListener('click', exportDiary);
  $('#import-input').addEventListener('change', importDiary);
  document.addEventListener('click', event => {
    const b = event.target.closest('button'); if (!b) return;
    if (b.dataset.date) { setDate(b.dataset.date); switchView('diary'); }
    if (b.dataset.historyDate) { setDate(b.dataset.historyDate); switchView('diary'); }
    if (b.dataset.calendarDate) { setDate(b.dataset.calendarDate); showDayDetail(); }
    if (b.hasAttribute('data-new-meal')) openRecord();
    if (b.dataset.edit) openMeal(selectedDay().meals.find(m => m.id === b.dataset.edit));
    if (b.dataset.confirm) {
      const day = selectedDay(), meal = day.meals.find(m => m.id === b.dataset.confirm);
      saveDraft({ ...day, note: `${day.note} 补充：${MEALS[meal.type]}已在网站确认为吃过。`, meals: [{ ...meal, status: 'eaten', note: `${meal.note ?? ''}（后续已在网站确认吃过。）`, modifiedAt: new Date().toISOString() }] });
      toast('这餐已在本机确认为吃过，已加入当日统计。');
    }
  });
}
async function init() {
  try {
    const responses = await Promise.all([fetch('./data/diary.json', { cache: 'no-cache' }), fetch('./data/foods.json', { cache: 'no-cache' })]);
    if (responses.some(r => !r.ok)) throw new Error('数据文件读取失败');
    canonical = validateDiary(await responses[0].json()); catalog = await responses[1].json();
    try { const saved = localStorage.getItem(storageKey); if (saved) drafts = validateDiary(JSON.parse(saved)).days; } catch { toast('已有本机草稿无法读取，请导出原备份后重新导入。'); }
    days = mergeDays(canonical.days, drafts); selected = today();
    wire(); render();
    quickController = setupQuickEntry({ apply: applyQuickEntry, undo: undoQuickEntry, onBusy: busy => document.querySelectorAll('[data-record-method]').forEach(button => { button.disabled = busy; }) });
    prepareMealForm(); setRecordMethod('natural');
    switchView(location.hash.slice(1) || 'diary', { history: false });
  } catch (error) { $('#day-detail').hidden = false; $('#meal-list').innerHTML = `<div class="empty-state"><h3>日记暂时没有打开</h3><p>${esc(error.message)}，请刷新重试。</p></div>`; }
}
init();
