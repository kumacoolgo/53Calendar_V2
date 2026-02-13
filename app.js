// ==== カラーパレット ====
const COLOR_PALETTE = [
  { bgColor: "#fee2e2", textColor: "#991b1b", color: "#ef4444" },
  { bgColor: "#fef3c7", textColor: "#92400e", color: "#f59e0b" },
  { bgColor: "#dbeafe", textColor: "#1d4ed8", color: "#3b82f6" },
  { bgColor: "#dcfce7", textColor: "#166534", color: "#22c55e" },
  { bgColor: "#e0e7ff", textColor: "#3730a3", color: "#6366f1" },
  { bgColor: "#fae8ff", textColor: "#86198f", color: "#e879f9" },
  { bgColor: "#f3e8ff", textColor: "#6b21a8", color: "#a855f7" },
  { bgColor: "#e0f2fe", textColor: "#075985", color: "#0ea5e9" }
];

const DEFAULT_TYPES = [
  { id: "burnable",    label: "燃やすごみ",       color: "#ef4444", bgColor: "#fee2e2", textColor: "#991b1b", icon: "fa-fire" },
  { id: "nonburnable", label: "燃やさないごみ",   color: "#374151", bgColor: "#f3f4f6", textColor: "#374151", icon: "fa-battery-full" },
  { id: "plastic",     label: "プラスチック",     color: "#1d4ed8", bgColor: "#dbeafe", textColor: "#1e40af", icon: "fa-bottle-water" },
  { id: "paper",       label: "古紙・びん・缶",   color: "#a16207", bgColor: "#fef9c3", textColor: "#854d0e", icon: "fa-newspaper" },
  { id: "pet",         label: "ペットボトル",     color: "#15803d", bgColor: "#dcfce7", textColor: "#166534", icon: "fa-recycle" },
  { id: "tray",        label: "食品トレイ",       color: "#4338ca", bgColor: "#e0e7ff", textColor: "#3730a3", icon: "fa-utensils" },
  { id: "cloth",       label: "古布",             color: "#a21caf", bgColor: "#fae8ff", textColor: "#86198f", icon: "fa-shirt" }
];

const DEFAULT_RULES = {
  burnable:    { mode: "weekly", weekdays: [3, 6], nth: [] },
  nonburnable: { mode: "nth",    weekdays: [1],    nth: [1, 3] },
  plastic:     { mode: "weekly", weekdays: [2],    nth: [] },
  paper:       { mode: "nth",    weekdays: [2],    nth: [2, 4] },
  pet:         { mode: "weekly", weekdays: [5],    nth: [] },
  tray:        { mode: "weekly", weekdays: [5],    nth: [] },
  cloth:       { mode: "weekly", weekdays: [5],    nth: [] }
};

const STORAGE_KEY = "gomi-app-v5";

// 日本の祝日 API（公式系オープンデータミラー）
const HOLIDAY_API_URL = "https://holidays-jp.github.io/api/v1/date.json";

let types = [];
let rules = {};
let currentDate = new Date();
let renderTimer = null;
let isExporting = false;

// 祝日データ
let holidaysMap = null;
let holidaysLoaded = false;

// === 日付ユーティリティ ===
function getToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getTomorrow() {
  const t = getToday();
  t.setDate(t.getDate() + 1);
  return t;
}

function waitForNextFrame() {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve());
  });
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function captureElementCanvas(target) {
  if (typeof window.html2canvas === "function") {
    const canvas = await withTimeout(
      window.html2canvas(target, {
        scale: 1,
        useCORS: true,
        imageTimeout: 5000,
        backgroundColor: "#ffffff",
        logging: false
      }),
      30000,
      "html2canvas direct"
    );
    return canvas;
  }

  const worker = html2pdf()
    .set({
      html2canvas: { scale: 1, useCORS: true, imageTimeout: 5000, logging: false }
    })
    .from(target)
    .toCanvas();
  await withTimeout(worker, 30000, "toCanvas worker");
  const canvas = await withTimeout(worker.get("canvas"), 5000, "toCanvas get(canvas)");
  return canvas;
}

function drawCanvasToPdfPage(pdf, canvas, marginMm) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const maxWidth = pageWidth - marginMm * 2;
  const maxHeight = pageHeight - marginMm * 2;
  const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
  const drawWidth = canvas.width * ratio;
  const drawHeight = canvas.height * ratio;
  const offsetX = (pageWidth - drawWidth) / 2;
  const offsetY = (pageHeight - drawHeight) / 2;
  const imgData = canvas.toDataURL("image/jpeg", 0.98);
  pdf.addImage(imgData, "JPEG", offsetX, offsetY, drawWidth, drawHeight);
}

async function getJsPdfCtorFromHtml2pdf() {
  const seed = document.createElement("canvas");
  seed.width = 1;
  seed.height = 1;
  const worker = html2pdf()
    .set({
      margin: 0,
      image: { type: "jpeg", quality: 0.1 },
      jsPDF: { unit: "mm", format: "a4", orientation: "landscape" }
    })
    .from(seed, "canvas")
    .toPdf();
  await withTimeout(worker, 30000, "probe toPdf worker");
  const pdf = await withTimeout(worker.get("pdf"), 5000, "probe get(pdf)");
  return pdf && pdf.constructor ? pdf.constructor : null;
}

function createPdfSnapshotNode() {
  const source = document.getElementById("pdfArea");
  if (!source) return null;

  const snapshot = source.cloneNode(true);
  snapshot.id = "pdfAreaSnapshot";
  snapshot.classList.add("export-snapshot");
  snapshot.style.width = `${Math.ceil(source.getBoundingClientRect().width)}px`;

  snapshot.querySelectorAll(".btn-icon, .btn-settings").forEach(el => el.remove());
  const banner = snapshot.querySelector("#bannerContainer");
  if (banner) banner.remove();

  const wrapper = document.createElement("div");
  wrapper.className = "export-snapshot-wrap";
  wrapper.appendChild(snapshot);
  return { wrapper, snapshot };
}

async function capturePdfAreaCanvas() {
  const snapObj = createPdfSnapshotNode();
  if (!snapObj) throw new Error("pdfArea snapshot unavailable");

  document.body.appendChild(snapObj.wrapper);
  try {
    await waitForNextFrame();
    await waitForNextFrame();
    return await captureElementCanvas(snapObj.snapshot);
  } finally {
    snapObj.wrapper.remove();
  }
}

// === 状態管理 ===
function createDefaultState() {
  return {
    types: JSON.parse(JSON.stringify(DEFAULT_TYPES)),
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES))
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    const parsed = JSON.parse(raw);

    let loadedTypes = Array.isArray(parsed.types) && parsed.types.length
      ? parsed.types
      : DEFAULT_TYPES;
    loadedTypes = JSON.parse(JSON.stringify(loadedTypes));

    let loadedRules = parsed.rules && typeof parsed.rules === "object"
      ? parsed.rules
      : DEFAULT_RULES;
    loadedRules = JSON.parse(JSON.stringify(loadedRules));

    loadedTypes.forEach(t => {
      if (!loadedRules[t.id]) {
        loadedRules[t.id] = { mode: "off", weekdays: [], nth: [] };
      }
    });

    return { types: loadedTypes, rules: loadedRules };
  } catch {
    return createDefaultState();
  }
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ types, rules }));
}

// === ごみ種別判定 ===
function checkRule(date, rule) {
  if (!rule || rule.mode === "off") return false;
  const w = date.getDay();
  if (!rule.weekdays.includes(w)) return false;

  if (rule.mode === "weekly") return true;

  if (rule.mode === "nth") {
    const nth = Math.floor((date.getDate() - 1) / 7) + 1;
    return rule.nth.includes(nth);
  }
  return false;
}

function getGarbageList(date) {
  return types.filter(t => checkRule(date, rules[t.id]));
}

// === 祝日処理 ===
function fetchHolidays() {
  fetch(HOLIDAY_API_URL)
    .then(res => res.json())
    .then(data => {
      holidaysMap = data;    // { "2025-01-01": "元日", ... }
      holidaysLoaded = true;
      // 祝日情報を反映するため再描画
      renderCalendar();
    })
    .catch(err => {
      console.error("祝日データ取得エラー:", err);
      holidaysLoaded = false;
    });
}

function getHolidayName(date) {
  if (!holidaysMap) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;
  return holidaysMap[key] || null;
}

// === 初期化 ===
(function initState() {
  const state = loadState();
  types = state.types;
  rules = state.rules;
})();

function init() {
  renderCalendar();
  renderLegend();
  renderSettingsUI();
  fetchHolidays(); // 祝日データ取得

  // ナビゲーション
  document.getElementById("prevMonth").onclick = () => changeMonth(-1);
  document.getElementById("nextMonth").onclick = () => changeMonth(1);

  document.getElementById("todayBtn").onclick = () => {
    currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    renderCalendar();
  };

  // Settings
  document.getElementById("openSettings").onclick = () => {
    renderSettingsUI();
    toggleModal("settingsModal", true);
  };
  document.getElementById("closeSettings").onclick = () => toggleModal("settingsModal", false);
  document.getElementById("saveSettings").onclick = () => {
    persistState();
    renderCalendar();
    renderLegend();
    toggleModal("settingsModal", false);
  };
  document.getElementById("resetSettings").onclick = resetAll;
  document.getElementById("addCategory").onclick = addCategory;

  // Detail modal
  document.getElementById("closeDetail").onclick = () => toggleModal("detailModal", false);
  document.getElementById("okDetail").onclick    = () => toggleModal("detailModal", false);

  // Print choice modal
  document.getElementById("closePrintChoice").onclick = () => toggleModal("printChoiceModal", false);
  document.getElementById("printMonthBtn").onclick = () => {
    toggleModal("printChoiceModal", false);
    exportCurrentMonthPdf();
  };
  document.getElementById("printYearBtn").onclick = () => {
    toggleModal("printChoiceModal", false);
    exportWholeYearPdf();
  };

  // Overlay click to close
  document.querySelectorAll(".modal-overlay").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target === el) toggleModal(el.id, false);
    });
  });

  // Esc to close
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      toggleModal("detailModal", false);
      toggleModal("settingsModal", false);
      toggleModal("printChoiceModal", false);
    }
  });

  // Print to PDF
  const printBtn = document.getElementById("printBtn");
  if (printBtn) {
    printBtn.onclick = () => {
      toggleModal("printChoiceModal", true);
    };
  }
}

// 月変更 + 軽い防抖
function changeMonth(delta) {
  currentDate.setMonth(currentDate.getMonth() + delta);
  currentDate.setHours(0, 0, 0, 0);
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => {
    renderCalendar();
  });
}

// === カレンダー描画 ===
function renderCalendar() {
  const y = currentDate.getFullYear();
  const m = currentDate.getMonth();
  document.getElementById("monthLabel").textContent = `${y}年 ${m + 1}月`;

  const firstDay = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);
  const startWeek = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const todayObj = getToday();

  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = "";

  // 前空白
  for (let i = 0; i < startWeek; i++) {
    const cell = document.createElement("div");
    cell.className = "day-cell other-month";
    grid.appendChild(cell);
  }

  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(y, m, d);
    date.setHours(0, 0, 0, 0);

    const cell = document.createElement("div");
    cell.className = "day-cell";

    const w = date.getDay();
    if (w === 0) cell.classList.add("sun");
    if (w === 6) cell.classList.add("sat");

    // 祝日判定
    const holidayName = getHolidayName(date);
    if (holidayName) {
      cell.classList.add("holiday");
    }

    // 今日
    if (date.getTime() === todayObj.getTime()) {
      cell.classList.add("today");
    }

    const num = document.createElement("div");
    num.className = "date-num";
    num.textContent = d;
    cell.appendChild(num);

    const container = document.createElement("div");
    container.className = "labels-container";

    const list = getGarbageList(date);
    list.forEach(g => {
      const label = document.createElement("div");
      label.className = "mini-label";
      label.textContent = g.label;
      label.style.background = g.bgColor;
      label.style.color = g.textColor;
      container.appendChild(label);
    });
    cell.appendChild(container);

    cell.addEventListener("click", () => openDetail(date, list, holidayName));
    grid.appendChild(cell);
  }

  const cellsSoFar = startWeek + totalDays;
  const remainder = cellsSoFar % 7;
  if (remainder !== 0) {
    const blanks = 7 - remainder;
    for (let i = 0; i < blanks; i++) {
      const cell = document.createElement("div");
      cell.className = "day-cell other-month";
      grid.appendChild(cell);
    }
  }

  renderTomorrowBanner();
}

// 明日のごみ出しバナー表示
function renderTomorrowBanner() {
  const container = document.getElementById("bannerContainer");
  container.innerHTML = "";

  const tomorrow = getTomorrow();
  const list = getGarbageList(tomorrow);
  if (!list.length) return;

  const banner = document.createElement("div");
  banner.className = "tomorrow-banner";

  const labels = list.map(t => t.label).join("・");
  banner.innerHTML = `
      <i class="fa-solid fa-bell"></i>
      <div class="banner-content">
        <div>明日（${tomorrow.getMonth()+1}月${tomorrow.getDate()}日）は <strong>${labels}</strong> の日です。</div>
        <small>出し忘れにご注意ください</small>
      </div>
    `;

  container.appendChild(banner);
}

// Legend
function renderLegend() {
  const el = document.getElementById("legendContainer");
  el.innerHTML = types
    .map(
      t => `
      <div class="legend-item">
        <span
          class="legend-dot"
          style="background:${t.bgColor}; border:1px solid ${t.color};"
        ></span>
        ${t.label}
      </div>`
    )
    .join("");
}

// 詳細モーダル
function openDetail(date, list, holidayNameFromCell) {
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  document.getElementById("detailDateStr").textContent =
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 (${days[date.getDay()]})`;

  const nth = Math.floor((date.getDate() - 1) / 7) + 1;
  const holidayName = holidayNameFromCell || getHolidayName(date);

  let meta = `第${nth}週目`;
  if (holidayName) {
    meta += ` ／ 祝日：${holidayName}`;
  }
  document.getElementById("detailMetaStr").textContent = meta;

  const container = document.getElementById("detailList");
  if (!list.length) {
    container.innerHTML =
      `<div class="detail-empty"><i class="fa-regular fa-face-smile"></i><br>回収予定はありません</div>`;
  } else {
    container.innerHTML = list
      .map(
        g => `
        <div class="detail-item" style="border-left-color:${g.color}; border-left-width:4px;">
          <div class="detail-icon" style="background:${g.bgColor}; color:${g.textColor};">
            <i class="fa-solid ${g.icon}"></i>
          </div>
          <div class="detail-name">${g.label}</div>
        </div>`
      )
      .join("");
  }
  toggleModal("detailModal", true);
}

// === カテゴリ編集関連 ===
function slugify(name) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "cat"
  );
}

function addCategory() {
  const name = prompt("新しいごみ分類の名前を入力してください：");
  if (!name || !name.trim()) return;
  const trimmed = name.trim();

  let baseId = slugify(trimmed);
  let id = baseId;
  let idx = 1;
  while (types.some(t => t.id === id)) {
    id = `${baseId}-${idx++}`;
  }

  const palette = COLOR_PALETTE[types.length % COLOR_PALETTE.length];
  const newType = {
    id,
    label: trimmed,
    color: palette.color,
    bgColor: palette.bgColor,
    textColor: palette.textColor,
    icon: "fa-trash-can"
  };

  types.push(newType);
  rules[id] = { mode: "off", weekdays: [], nth: [] };
  persistState();
  renderSettingsUI();
  renderCalendar();
  renderLegend();
}

function deleteCategory(id) {
  if (types.length <= 1) {
    alert("少なくとも1つの分類が必要です。");
    return;
  }
  const t = types.find(x => x.id === id);
  const name = t ? t.label : id;
  if (!confirm(`「${name}」を削除しますか？`)) return;

  types = types.filter(x => x.id !== id);
  delete rules[id];
  persistState();
  renderSettingsUI();
  renderCalendar();
  renderLegend();
}

function resetAll() {
  if (!confirm("全ての分類と収集ルールを初期状態に戻しますか？")) return;
  const state = createDefaultState();
  types = state.types;
  rules = state.rules;
  localStorage.removeItem(STORAGE_KEY);
  renderSettingsUI();
  renderCalendar();
  renderLegend();
}

// Settings UI
function renderSettingsUI() {
  const container = document.getElementById("settingsList");
  container.innerHTML = "";

  const dayLabels = ["日", "月", "火", "水", "木", "金", "土"];

  types.forEach(type => {
    const rule = rules[type.id];
    const wrapper = document.createElement("div");
    wrapper.className = "setting-group";
    wrapper.dataset.id = type.id;

    const disabled =
      rule.mode === "off" ||
      rule.weekdays.length === 0 ||
      (rule.mode === "nth" && rule.nth.length === 0);

    const disabledBadge = disabled ? '<span class="badge-muted">無効</span>' : "";

    wrapper.innerHTML = `
        <div class="setting-header">
          <div class="setting-title">
            <div class="setting-indicator" style="background:${type.color}"></div>
            ${type.label}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            ${disabledBadge}
            <button class="delete-type-btn" type="button" title="削除" data-delete="${type.id}">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="mode-selector">
          <div class="mode-option ${rule.mode === "weekly" ? "active" : ""}" data-mode="weekly">毎週</div>
          <div class="mode-option ${rule.mode === "nth" ? "active" : ""}" data-mode="nth">隔週・指定週</div>
          <div class="mode-option ${rule.mode === "off" ? "active" : ""}" data-mode="off">なし</div>
        </div>
        <div class="options-container ${rule.mode === "off" ? "hidden" : ""}">
          <div style="font-size:12px;color:var(--text-sub);margin-bottom:4px;">曜日:</div>
          <div class="week-selector">
            ${[0,1,2,3,4,5,6].map(d => `
              <div class="toggle-btn ${rule.weekdays.includes(d) ? "active" : ""}" data-day="${d}">
                ${dayLabels[d]}
              </div>`).join("")}
          </div>
          <div class="nth-wrapper ${rule.mode !== "nth" ? "hidden" : ""}" style="margin-top:10px;">
            <div style="font-size:12px;color:var(--text-sub);margin-bottom:4px;">対象週:</div>
            <div class="nth-selector">
              ${[1,2,3,4,5].map(n => `
                <div class="toggle-btn ${rule.nth.includes(n) ? "active" : ""}" data-nth="${n}">
                  第${n}
                </div>`).join("")}
            </div>
          </div>
        </div>
      `;

    wrapper.querySelector("[data-delete]").addEventListener("click", () => deleteCategory(type.id));

    wrapper.querySelectorAll(".mode-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        rules[type.id].mode = mode;
        persistState();
        renderSettingsUI();
      });
    });

    wrapper.querySelectorAll("[data-day]").forEach(btn => {
      btn.addEventListener("click", () => {
        const day = Number(btn.dataset.day);
        const arr = rules[type.id].weekdays;
        const idx = arr.indexOf(day);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(day);
        persistState();
        renderSettingsUI();
      });
    });

    wrapper.querySelectorAll("[data-nth]").forEach(btn => {
      btn.addEventListener("click", () => {
        const n = Number(btn.dataset.nth);
        const arr = rules[type.id].nth;
        const idx = arr.indexOf(n);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(n);
        persistState();
        renderSettingsUI();
      });
    });

    container.appendChild(wrapper);
  });
}

// === モーダル表示切り替え ===
function toggleModal(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  if (show) el.classList.add("active");
  else el.classList.remove("active");
}

// === PDF 出力（A4 横向き） ===
async function exportCurrentMonthPdf() {
  if (isExporting) return;
  isExporting = true;
  const watchdog = setTimeout(() => {
    isExporting = false;
    alert("PDF出力がタイムアウトしました。もう一度お試しください。");
  }, 120000);

  if (typeof html2pdf === "undefined") {
    alert("PDF ライブラリの読み込みに失敗しました。ネットワークを確認してください。");
    clearTimeout(watchdog);
    isExporting = false;
    return;
  }

  const target = document.getElementById("pdfArea");
  if (!target) {
    clearTimeout(watchdog);
    isExporting = false;
    return;
  }

  const y = currentDate.getFullYear();
  const m = currentDate.getMonth() + 1;
  const filename = `gomi-calendar-${y}-${String(m).padStart(2, "0")}.pdf`;
  const marginMm = 4;
  const tempRoot = document.createElement("div");
  tempRoot.id = "singlePdfArea";

  try {
    document.body.classList.add("exporting-pdf");
    document.body.appendChild(tempRoot);

    const page = document.createElement("div");
    page.className = "yearly-print-page";
    const clone = target.cloneNode(true);
    clone.id = "pdfAreaSnapshot-single";
    clone.querySelectorAll(".btn-icon, .btn-settings").forEach(el => el.remove());
    const banner = clone.querySelector("#bannerContainer");
    if (banner) banner.remove();
    page.appendChild(clone);
    tempRoot.appendChild(page);

    await waitForNextFrame();
    await html2pdf()
      .set({
        margin: marginMm,
        filename,
        image: { type: "png", quality: 1 },
        html2canvas: {
          scale: 3,
          useCORS: true,
          imageTimeout: 15000,
          backgroundColor: "#ffffff",
          logging: false
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "landscape", compress: false },
        pagebreak: { mode: ["css"], avoid: [".yearly-print-page"] }
      })
      .from(tempRoot)
      .save();
  } catch (err) {
    console.error(err);
    alert(`PDF の生成中にエラーが発生しました。\n${err.message || err}`);
  } finally {
    tempRoot.remove();
    document.body.classList.remove("exporting-pdf");
    clearTimeout(watchdog);
    isExporting = false;
  }
}

// === PDF 出力（1年分: 12ページ） ===
async function exportWholeYearPdf() {
  if (isExporting) return;
  isExporting = true;
  const watchdog = setTimeout(() => {
    isExporting = false;
    alert("年間PDF出力がタイムアウトしました。もう一度お試しください。");
  }, 600000);

  if (typeof html2pdf === "undefined") {
    alert("PDF ライブラリの読み込みに失敗しました。ネットワークを確認してください。");
    clearTimeout(watchdog);
    isExporting = false;
    return;
  }

  const target = document.getElementById("pdfArea");
  if (!target) {
    clearTimeout(watchdog);
    isExporting = false;
    return;
  }

  const backupDate = new Date(currentDate);
  const year = backupDate.getFullYear();
  const filename = `gomi-calendar-${year}-12months.pdf`;
  const marginMm = 4;
  const tempRoot = document.createElement("div");
  tempRoot.id = "yearlyPdfArea";

  try {
    document.body.classList.add("exporting-pdf", "exporting-yearly-pdf");
    document.body.appendChild(tempRoot);

    for (let month = 0; month < 12; month++) {
      currentDate = new Date(year, month, 1);
      currentDate.setHours(0, 0, 0, 0);
      renderCalendar();
      await waitForNextFrame();
      await waitForNextFrame();

      const page = document.createElement("div");
      page.className = "yearly-print-page";
      const clone = target.cloneNode(true);
      clone.id = `pdfAreaSnapshot-${month + 1}`;
      clone.querySelectorAll(".btn-icon, .btn-settings").forEach(el => el.remove());
      const banner = clone.querySelector("#bannerContainer");
      if (banner) banner.remove();
      page.appendChild(clone);
      tempRoot.appendChild(page);
    }

    await html2pdf()
      .set({
        margin: marginMm,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          imageTimeout: 15000,
          backgroundColor: "#ffffff",
          logging: false
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
        pagebreak: { mode: ["css"], avoid: [".yearly-print-page"] }
      })
      .from(tempRoot)
      .save();
  } catch (err) {
    console.error(err);
    alert(`年間 PDF の生成中にエラーが発生しました。\n${err.message || err}`);
  } finally {
    tempRoot.remove();
    document.body.classList.remove("exporting-pdf", "exporting-yearly-pdf");
    clearTimeout(watchdog);
    currentDate = backupDate;
    renderCalendar();
    isExporting = false;
  }
}

// DOM 準備完了で初期化
document.addEventListener("DOMContentLoaded", init);
