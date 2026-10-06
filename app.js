// スイッチセレクター
// data/switches.json を読み込み、左サイドバーの条件で絞り込んで表示する。
// 1型番＝1カード（ポート数そのものが絞り込み条件なので、型番ごとに並べる）。

// ---------------------------------------------------------------------------
// 表示用の定義
// ---------------------------------------------------------------------------

const SPEED_LABEL = { "100M": "100Mbps", "1G": "1Gbps", "2.5G": "2.5Gbps", "10G": "10Gbps" };
const SPEED_ORDER = ["100M", "1G", "2.5G", "10G"];

const MANAGEMENT_OPTIONS = [
  { value: "アンマネージ", title: "アンマネージ", note: "つなぐだけで使える。設定は不要" },
  { value: "ライトマネージ", title: "ライトマネージ", note: "本体のスイッチ切替でループ防止・VLANなどが使える（設定画面なし）" },
  { value: "L2インテリジェント", title: "L2インテリジェント", note: "Web画面からVLAN・認証・監視などを細かく設定できる" },
  { value: "L3", title: "L3スイッチ", note: "異なるネットワーク同士をつなぐルーティング機能を持つ" }
];

const FEATURE_OPTIONS = [
  { value: "ループ検知・防止", note: "ケーブルのつなぎ間違いによる社内ネットワークの停止を防ぐ" },
  { value: "VLAN", note: "部署や用途ごとにネットワークを分ける" },
  { value: "QoS", note: "通話・映像など大事な通信を優先して流す" },
  { value: "リンクアグリゲーション", note: "複数のケーブルを束ねて高速化・断線対策" },
  { value: "IGMPスヌーピング", note: "映像配信などの一斉配信を効率よく流す" },
  { value: "IEEE802.1X認証", note: "許可した端末だけを社内LANにつなげる" },
  { value: "ポートミラーリング", note: "通信を複製して、監視・トラブル調査に使う" },
  { value: "SNMP監視", note: "監視ツールから稼働状態をチェックできる" },
  { value: "ジャンボフレーム", note: "NASとの大容量ファイル転送を効率化" },
  { value: "省電力（EEE）", note: "通信していない間の消費電力を抑える" }
];

const INSTALL_OPTIONS = [
  { value: "ラックマウント", note: "19インチラックに取り付けられる" },
  { value: "マグネット", note: "スチール製の棚や分電盤に貼り付けられる" },
  { value: "壁掛け", note: "背面のフックホールで壁に掛けられる" }
];

const POE_TOTAL_STEPS = [
  { value: null, label: "指定なし" },
  { value: 60, label: "60W以上" },
  { value: 90, label: "90W以上" },
  { value: 120, label: "120W以上" }
];

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

let allProducts = [];
const uiState = {}; // 型番ごとの「比較」チェック

function emptyFilters() {
  return {
    ports: new Set(),
    speedMin: null, // 「〜以上」で絞り込む（1つだけ選ぶ）
    sfp: false,
    usage: new Set(),
    management: new Set(),
    poe: false,
    poePlus: false,
    poeTotalMin: null,
    features: new Set(),
    tempRanges: new Set(),
    fanless: false,
    internalPower: false,
    metal: false,
    install: new Set(),
    warranty: new Set()
  };
}
let filters = emptyFilters();

// 折りたたみの開閉状態（絞り込みを解除しても、開いている場所は変えない）
const openSections = { basic: true, management: true, poe: true, features: false, environment: false, other: false };

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

async function init() {
  const res = await fetch("data/switches.json", { cache: "no-cache" });
  const data = await res.json();
  allProducts = data.switches || [];
  allProducts.forEach(p => { uiState[p.id] = { checked: false }; });

  if (data.updatedAt) {
    const d = new Date(data.updatedAt);
    const formatted = d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
    const daysSince = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    const updatedEl = document.getElementById("updated-at");
    if (daysSince > 40) {
      updatedEl.textContent = "データ最終更新日：" + formatted + "（" + daysSince + "日前 - 更新が止まっている可能性があります）";
      updatedEl.classList.add("disclaimer__updated--warning");
    } else {
      updatedEl.textContent = "データ最終更新日：" + formatted;
    }
  }

  // 共有されたURL（?port=8&poe=1&cmp=… など）から、絞り込み条件・比較の選択を復元する
  const openCompareFromUrl = applyStateFromUrl();

  buildFilterPanel();
  render();

  document.getElementById("show-discontinued").addEventListener("change", render);
  document.getElementById("share-btn").addEventListener("click", () => {
    copyShareUrl(buildShareUrl(false), "share-feedback", "share-fallback", "share-fallback-input");
  });
  document.getElementById("compare-share-btn").addEventListener("click", () => {
    copyShareUrl(buildShareUrl(true), "compare-share-feedback", "compare-share-fallback", "compare-share-fallback-input");
  });
  if (openCompareFromUrl && allProducts.filter(p => uiState[p.id].checked).length >= 2) openCompare();
  document.getElementById("compare-close").addEventListener("click", () => {
    document.getElementById("compare-modal").hidden = true;
  });
  document.getElementById("compare-modal").addEventListener("click", e => {
    if (e.target.id === "compare-modal") document.getElementById("compare-modal").hidden = true;
  });
  document.getElementById("tray-btn").addEventListener("click", openCompare);
}

// ---------------------------------------------------------------------------
// サイドバー（絞り込み条件）
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// 折りたたみ式のセクション。見出しの右に「選択中の条件数」を表示する。
function section(key, title, countFn) {
  const details = el("details", "filter-section-acc");
  details.open = !!openSections[key];
  details.addEventListener("toggle", () => { openSections[key] = details.open; });
  const summary = el("summary", "filter-group__label");
  summary.appendChild(document.createTextNode(title));
  const badge = el("span", "filter-count");
  badge.dataset.countFor = key;
  summary.appendChild(badge);
  details.appendChild(summary);
  details._countFn = countFn;
  return details;
}

function subTitle(text, hint) {
  const wrap = el("div", "filter-sub");
  wrap.appendChild(el("p", "filter-sub__title", text));
  if (hint) wrap.appendChild(el("p", "filter-sub__hint", hint));
  return wrap;
}

// 丸いボタンを並べた複数選択（ポート数・速度など、短い選択肢向け）
function pillGroup(values, set, labelFn) {
  const row = el("div", "pill-row");
  values.forEach(v => {
    const btn = el("button", "pill" + (set.has(v) ? " pill--on" : ""), labelFn ? labelFn(v) : String(v));
    btn.type = "button";
    btn.setAttribute("aria-pressed", set.has(v) ? "true" : "false");
    btn.addEventListener("click", () => {
      if (set.has(v)) set.delete(v); else set.add(v);
      btn.classList.toggle("pill--on", set.has(v));
      btn.setAttribute("aria-pressed", set.has(v) ? "true" : "false");
      render();
    });
    row.appendChild(btn);
  });
  return row;
}

// 1つだけ選ぶ丸ボタン（総給電量など）
function pillSingle(options, getValue, setValue) {
  const row = el("div", "pill-row");
  const buttons = [];
  options.forEach(opt => {
    const btn = el("button", "pill", opt.label);
    btn.type = "button";
    buttons.push({ btn, opt });
    btn.addEventListener("click", () => {
      setValue(opt.value);
      buttons.forEach(b => b.btn.classList.toggle("pill--on", b.opt.value === getValue()));
      render();
    });
    row.appendChild(btn);
  });
  buttons.forEach(b => b.btn.classList.toggle("pill--on", b.opt.value === getValue()));
  return row;
}

// 説明付きのチェックボックス
function checkOption(title, note, checked, onChange) {
  const label = el("label", "check-option");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => { onChange(cb.checked); render(); });
  const textWrap = el("span", "check-option__text");
  textWrap.appendChild(el("span", "check-option__title", title));
  if (note) textWrap.appendChild(el("span", "check-option__note", note));
  label.appendChild(cb);
  label.appendChild(textWrap);
  return label;
}

function setCheck(set, value) {
  return checked => { if (checked) set.add(value); else set.delete(value); };
}

function buildFilterPanel() {
  const panel = document.getElementById("filter-panel");
  panel.innerHTML = "";

  const head = el("div", "filter-panel__head");
  head.appendChild(el("p", "filter-panel__title", "条件で絞り込む"));
  const resetBtn = el("button", "filter-reset-top", "すべて解除");
  resetBtn.type = "button";
  resetBtn.addEventListener("click", resetFilters);
  head.appendChild(resetBtn);
  panel.appendChild(head);

  // ① 基本スペック
  const basic = section("basic", "基本スペック", () =>
    filters.ports.size + (filters.speedMin ? 1 : 0) + (filters.sfp ? 1 : 0) + filters.usage.size);
  const portValues = [...new Set(allProducts.map(p => p.ports).filter(v => v != null))].sort((a, b) => a - b);
  basic.appendChild(subTitle("ポート数", "LANケーブルを挿せる口の数（複数選択可）"));
  basic.appendChild(pillGroup(portValues, filters.ports, v => v + "ポート"));
  const speedValues = SPEED_ORDER.filter(s => allProducts.some(p => p.speed === s));
  basic.appendChild(subTitle("通信速度", "選んだ速度以上の機種が出ます（速い機種は遅い速度にも対応）。NASなど大容量データを速く扱いたいなら2.5G以上"));
  // 速い機種は遅い速度にも対応しているので「〜以上」で選ぶ。
  // 一番遅い速度（全機種が当てはまる）は絞り込みにならないので選択肢から外し、「指定なし」を先頭に置く。
  const speedOptions = [{ value: null, label: "指定なし" }].concat(
    speedValues.slice(1).map((v, i, arr) => ({
      value: v,
      label: (SPEED_LABEL[v] || v) + (i < arr.length - 1 ? "以上" : "")
    }))
  );
  basic.appendChild(pillSingle(speedOptions, () => filters.speedMin, v => { filters.speedMin = v; }));
  basic.appendChild(subTitle("光ファイバー・アップリンク"));
  basic.appendChild(checkOption("SFP / SFP+ポートあり", "光ファイバーや上位スイッチとの高速接続用", filters.sfp, v => { filters.sfp = v; }));
  basic.appendChild(subTitle("用途"));
  basic.appendChild(checkOption("家庭・SOHO向け", "住宅でも使える規格（VCCI Class B）の機種", filters.usage.has("家庭・SOHO向け"), setCheck(filters.usage, "家庭・SOHO向け")));
  basic.appendChild(checkOption("法人向け", "オフィス・業務用の規格（VCCI Class A）の機種", filters.usage.has("法人向け"), setCheck(filters.usage, "法人向け")));
  panel.appendChild(basic);

  // ② 管理機能（L2 / L3）
  const mgmt = section("management", "管理機能（L2 / L3）", () => filters.management.size);
  mgmt.appendChild(subTitle("管理機能のレベル", "複数選択可"));
  MANAGEMENT_OPTIONS.forEach(opt => {
    mgmt.appendChild(checkOption(opt.title, opt.note, filters.management.has(opt.value), setCheck(filters.management, opt.value)));
  });
  panel.appendChild(mgmt);

  // ③ PoE（給電）
  const poe = section("poe", "PoE（給電）", () =>
    (filters.poe ? 1 : 0) + (filters.poePlus ? 1 : 0) + (filters.poeTotalMin ? 1 : 0));
  // 「PoE給電あり」を選んだときだけ、その先の条件（PoE+・総給電量）を出す。
  // PoEを外したら、その先の条件も一緒に解除する（見えない条件が残らないように）。
  poe.appendChild(checkOption("PoE給電あり", "LANケーブル1本で、カメラや無線アクセスポイントに電気も送れる", filters.poe, v => {
    filters.poe = v;
    if (!v) { filters.poePlus = false; filters.poeTotalMin = null; }
    buildFilterPanel();
  }));
  if (filters.poe) {
    const poeSub = el("div", "filter-nested");
    poeSub.appendChild(checkOption("PoE+（1ポート最大30W）対応", "消費電力の大きいカメラ・アクセスポイント向け（IEEE802.3at）", filters.poePlus, v => { filters.poePlus = v; }));
    poeSub.appendChild(subTitle("総給電量", "つなぐ機器の消費電力の合計で選ぶ"));
    poeSub.appendChild(pillSingle(POE_TOTAL_STEPS, () => filters.poeTotalMin, v => { filters.poeTotalMin = v; }));
    poe.appendChild(poeSub);
  }
  panel.appendChild(poe);

  // ④ 高機能
  const feat = section("features", "高機能", () => filters.features.size);
  feat.appendChild(subTitle("必要な機能", "チェックしたものを「すべて」備えた機種に絞ります"));
  FEATURE_OPTIONS.forEach(opt => {
    feat.appendChild(checkOption(opt.value, opt.note, filters.features.has(opt.value), setCheck(filters.features, opt.value)));
  });
  panel.appendChild(feat);

  // ⑤ 設置・環境
  const env = section("environment", "設置・環境", () =>
    filters.tempRanges.size + (filters.fanless ? 1 : 0) + (filters.internalPower ? 1 : 0) + (filters.metal ? 1 : 0) + filters.install.size);
  // 使用温度範囲は、実データにある範囲（例：0〜40℃、0〜50℃）をそのまま選択肢にする
  const tempKeys = [...new Set(allProducts.map(tempKey).filter(Boolean))]
    .sort((a, b) => tempMax(a) - tempMax(b) || tempMin(a) - tempMin(b));
  env.appendChild(subTitle("使用温度範囲", "倉庫・工場・夏場に閉め切る部屋など、暑くなる場所なら上限50℃の機種を（複数選択可）"));
  env.appendChild(pillGroup(tempKeys, filters.tempRanges, k => tempMin(k) + "〜" + tempMax(k) + "℃"));
  env.appendChild(subTitle("本体の特長"));
  env.appendChild(checkOption("ファンレス（静音）", "冷却ファンが無く、音が静かでホコリにも強い", filters.fanless, v => { filters.fanless = v; }));
  env.appendChild(checkOption("電源内蔵", "ACアダプター不要。コンセント周りがすっきり", filters.internalPower, v => { filters.internalPower = v; }));
  env.appendChild(checkOption("金属筐体", "放熱性・耐久性が高い", filters.metal, v => { filters.metal = v; }));
  env.appendChild(subTitle("設置方法", "いずれかに対応していればOK（複数選択可）"));
  INSTALL_OPTIONS.forEach(opt => {
    env.appendChild(checkOption(opt.value, opt.note, filters.install.has(opt.value), setCheck(filters.install, opt.value)));
  });
  panel.appendChild(env);

  // ⑥ その他（保証）
  const other = section("other", "保証", () => filters.warranty.size);
  const warrantyValues = [...new Set(allProducts.map(p => p.warrantyYears).filter(v => v != null))].sort((a, b) => a - b);
  other.appendChild(subTitle("保証期間", "複数選択可"));
  other.appendChild(pillGroup(warrantyValues, filters.warranty, v => v + "年保証"));
  panel.appendChild(other);

  const resetBottom = el("button", "filter-reset", "絞り込みを解除する");
  resetBottom.type = "button";
  resetBottom.addEventListener("click", resetFilters);
  panel.appendChild(resetBottom);

  updateSectionCounts();
}

function resetFilters() {
  filters = emptyFilters();
  buildFilterPanel();
  render();
}

function updateSectionCounts() {
  document.querySelectorAll("#filter-panel details").forEach(d => {
    const badge = d.querySelector(".filter-count");
    if (!badge || !d._countFn) return;
    const n = d._countFn();
    badge.textContent = n > 0 ? n + "件選択中" : "";
    badge.hidden = n === 0;
  });
}

// ---------------------------------------------------------------------------
// 絞り込み
// ---------------------------------------------------------------------------

function matchesFilters(p) {
  if (filters.ports.size && !filters.ports.has(p.ports)) return false;
  if (filters.speedMin && SPEED_ORDER.indexOf(p.speed) < SPEED_ORDER.indexOf(filters.speedMin)) return false;
  if (filters.sfp && !p.sfp) return false;
  if (filters.usage.size && !filters.usage.has(p.usage)) return false;
  // L3はI-O DATAに該当製品が無いため、どの機種の management とも一致しない
  if (filters.management.size && !filters.management.has(p.management)) return false;
  if (filters.poe && !p.poe) return false;
  if (filters.poePlus && !(p.poe && (p.poe.standards || []).includes("802.3at"))) return false;
  if (filters.poeTotalMin && !(p.poe && p.poe.totalW != null && p.poe.totalW >= filters.poeTotalMin)) return false;
  for (const f of filters.features) {
    if (!(p.features || []).includes(f)) return false;
  }
  if (filters.tempRanges.size && !filters.tempRanges.has(tempKey(p))) return false;
  if (filters.fanless && p.fanless !== true) return false;
  if (filters.internalPower && p.power !== "内蔵電源") return false;
  if (filters.metal && p.housing !== "金属") return false;
  if (filters.install.size && !(p.install || []).some(i => filters.install.has(i))) return false;
  if (filters.warranty.size && !filters.warranty.has(p.warrantyYears)) return false;
  return true;
}

function isCurrent(p) {
  return p.status === "現行";
}

function visibleProducts() {
  const showDiscontinued = document.getElementById("show-discontinued").checked;
  return allProducts.filter(p => (isCurrent(p) || showDiscontinued) && matchesFilters(p));
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

// 使用温度範囲。tempMinC（下限）が無い古いデータでも、公式表記の文字列（例「0～+40℃」）から読み取る
function productTempMin(p) {
  if (p.tempMinC != null) return p.tempMinC;
  const m = String(p.tempText || "").normalize("NFKC").match(/(-?\d+)\s*[~～〜]/);
  return m ? Number(m[1]) : null;
}
function tempKey(p) {
  const min = productTempMin(p);
  return (min != null && p.tempMaxC != null) ? min + "_" + p.tempMaxC : null;
}
function tempMin(key) { return Number(String(key).split("_")[0]); }
function tempMax(key) { return Number(String(key).split("_")[1]); }
function tempLabel(p) {
  const k = tempKey(p);
  return k ? tempMin(k) + "〜" + tempMax(k) + "℃" : (p.tempText || null);
}

function fmtPrice(p) {
  if (p.priceIncTax != null) return "¥" + p.priceIncTax.toLocaleString();
  return p.priceText || "オープン価格";
}

// 税抜価格。I-O DATA公式の表記「￥21,780（税抜￥19,800）」に合わせて、税込÷1.1で求める
// （公式の価格はすべて税込÷1.1で割り切れることを確認済み）。オープン価格のときは何も付けない
function fmtExTax(p) {
  if (p.priceIncTax == null) return "";
  return "（税抜 ¥" + Math.round(p.priceIncTax / 1.1).toLocaleString() + "）";
}

function poeSummary(p) {
  if (!p.poe) return null;
  const std = (p.poe.standards || []).includes("802.3at") ? "PoE+" : "PoE";
  return std + (p.poe.totalW != null ? " 計" + p.poe.totalW + "W" : "");
}

function render() {
  syncUrl();
  updateSectionCounts();
  const visible = visibleProducts();
  const showDiscontinued = document.getElementById("show-discontinued").checked;
  const hiddenDiscontinued = allProducts.filter(p => !isCurrent(p) && matchesFilters(p)).length;

  document.getElementById("result-count").innerHTML =
    "該当 <strong>" + visible.length + "</strong> 件" +
    (!showDiscontinued && hiddenDiscontinued > 0 ? "（生産終了品 " + hiddenDiscontinued + " 件を非表示）" : "");

  renderNotices(visible);

  const grid = document.getElementById("product-grid");
  grid.innerHTML = "";

  if (visible.length === 0 && !filters.management.has("L3")) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("p", "empty-state__title", "条件に合う機種がありません"));
    empty.appendChild(el("p", "empty-state__note", "条件をいくつか外してみてください。左上の「すべて解除」で最初からやり直せます。"));
    grid.appendChild(empty);
  }

  visible.forEach(p => grid.appendChild(productCard(p)));
  updateTray();
}

// L3を選んだときの案内。L3だけを選んでいれば0件になり、他と一緒に選んでいれば
// 他の条件の結果の上に添える。
function renderNotices() {
  const area = document.getElementById("notice-area");
  area.innerHTML = "";
  if (!filters.management.has("L3")) return;
  const box = el("div", "l3-notice");
  box.appendChild(el("p", "l3-notice__title", "L3スイッチは、現在I-O DATAに該当製品がありません"));
  box.appendChild(el("p", "l3-notice__text",
    "L3スイッチは、部署ごとに分けたネットワーク同士をつなぐ（ルーティングする）機能を持つスイッチです。" +
    "I-O DATAのスイッチはすべてL2（同じネットワーク内の中継）です。"));
  box.appendChild(el("p", "l3-notice__text",
    "部署ごとにネットワークを分けたいだけなら、L2インテリジェントスイッチのVLAN機能で実現できます。" +
    "分けたネットワーク同士の通信が必要な場合は、ルーターやUTMと組み合わせる構成をご検討ください。"));
  const btn = el("button", "l3-notice__btn", "L2インテリジェントスイッチを見る →");
  btn.type = "button";
  btn.addEventListener("click", () => {
    filters.management = new Set(["L2インテリジェント"]);
    buildFilterPanel();
    render();
  });
  box.appendChild(btn);
  area.appendChild(box);
}

const PLACEHOLDER_SVG =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="20" width="56" height="24" rx="4" fill="#e9edf5" stroke="#9aa6bd" stroke-width="2"/>' +
    '<g fill="#6b7a99">' + [12, 21, 30, 39, 48].map(x => '<rect x="' + x + '" y="28" width="6" height="7" rx="1"/>').join("") + "</g></svg>"
  );

function productImage(p, className) {
  const img = el("img", className);
  img.alt = p.sku;
  img.loading = "lazy";
  img.src = p.imageUrl || PLACEHOLDER_SVG;
  img.addEventListener("error", () => {
    if (img.src !== PLACEHOLDER_SVG) img.src = PLACEHOLDER_SVG;
  }, { once: false });
  return img;
}

function productCard(p) {
  const s = uiState[p.id];
  const card = el("div", "product-card" + (s.checked ? " product-card--selected" : "") + (!isCurrent(p) ? " product-card--discontinued" : ""));

  const top = el("div", "product-card__top");
  const imgLink = el("a", "product-card__image-link");
  imgLink.href = p.sourceUrl;
  imgLink.target = "_blank";
  imgLink.rel = "noopener noreferrer";
  imgLink.title = "公式ページを見る";
  imgLink.appendChild(productImage(p, "product-card__image"));
  top.appendChild(imgLink);

  const compareLabel = el("label", "product-card__compare");
  const compareCb = el("input");
  compareCb.type = "checkbox";
  compareCb.checked = s.checked;
  compareCb.addEventListener("change", () => {
    s.checked = compareCb.checked;
    card.classList.toggle("product-card--selected", s.checked);
    updateTray();
    syncUrl();
  });
  compareLabel.appendChild(compareCb);
  compareLabel.appendChild(document.createTextNode("比較"));
  top.appendChild(compareLabel);
  card.appendChild(top);

  const skuRow = el("div", "product-card__sku-row");
  skuRow.appendChild(el("p", "product-card__sku", p.sku));
  if (!isCurrent(p)) skuRow.appendChild(el("span", "status-tag", p.status));
  card.appendChild(skuRow);
  card.appendChild(el("p", "product-card__name", p.name));

  const badgeRow = el("div", "badge-row");
  const badges = [
    p.ports != null ? { t: p.ports + "ポート" } : null,
    p.speed ? { t: SPEED_LABEL[p.speed] || p.speed, cls: "badge--speed-" + p.speed.replace(".", "_") } : null,
    p.sfp ? { t: p.sfp.type + "×" + p.sfp.count } : null,
    p.management ? { t: p.management, cls: "badge--mgmt" } : null,
    p.poe ? { t: poeSummary(p), cls: "badge--poe" } : null
  ].filter(Boolean);
  badges.forEach(b => badgeRow.appendChild(el("span", "badge" + (b.cls ? " " + b.cls : ""), b.t)));
  card.appendChild(badgeRow);

  if (p.speedNote) card.appendChild(el("p", "card-note", "※" + p.speedNote));

  const specLine = el("ul", "spec-line");
  [
    tempKey(p) ? "使用温度範囲 " + tempLabel(p) : null,
    p.fanless === true ? "ファンレス" : null,
    p.power,
    p.warrantyYears != null ? p.warrantyYears + "年保証" : null,
    p.usage
  ].filter(Boolean).forEach(t => specLine.appendChild(el("li", null, t)));
  card.appendChild(specLine);

  if (p.features && p.features.length > 0) {
    const featureRow = el("div", "feature-row");
    p.features.forEach(f => featureRow.appendChild(el("span", "feature-chip" + (filters.features.has(f) ? " feature-chip--hit" : ""), f)));
    card.appendChild(featureRow);
  }

  const priceRow = el("div", "price-row");
  const skuBlock = el("div");
  skuBlock.appendChild(el("p", "jan-line", p.jan ? "JAN: " + p.jan : ""));
  priceRow.appendChild(skuBlock);
  const priceWrap = el("div", "price-wrap");
  priceWrap.appendChild(el("p", "price" + (p.priceIncTax == null ? " price--open" : ""), fmtPrice(p)));
  if (p.priceIncTax != null) priceWrap.appendChild(el("p", "price-tax", fmtExTax(p)));
  priceRow.appendChild(priceWrap);
  card.appendChild(priceRow);

  const link = el("a", "official-link", "公式ページで詳しく見る →");
  link.href = p.sourceUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  card.appendChild(link);

  return card;
}

function updateTray() {
  const selected = allProducts.filter(p => uiState[p.id].checked);
  document.getElementById("tray-count").textContent = selected.length;
  document.getElementById("tray-btn").disabled = selected.length < 2;
}

// ---------------------------------------------------------------------------
// 比較ポップアップ
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openCompare() {
  const selected = allProducts.filter(p => uiState[p.id].checked);
  const yesNo = v => v ? "○" : "－";

  const basicRows = [
    ["価格", p => fmtPrice(p) + fmtExTax(p)],
    ["ポート数", p => p.ports != null ? p.ports + "ポート" : null],
    ["通信速度", p => (SPEED_LABEL[p.speed] || p.speed || "") + (p.speedNote ? "（" + p.speedNote + "）" : "")],
    ["SFP / SFP+", p => p.sfp ? p.sfp.type + "×" + p.sfp.count + "（" + p.sfp.speed + "）" : "なし"],
    ["管理機能", p => p.management],
    ["用途", p => p.usage]
  ];
  const poeRows = [
    ["PoE給電", p => p.poe ? ((p.poe.standards || []).includes("802.3at") ? "PoE+（802.3at）" : "PoE（802.3af）") : "なし"],
    ["給電ポート数", p => p.poe && p.poe.ports != null ? p.poe.ports + "ポート" : "－"],
    ["1ポート最大", p => p.poe && p.poe.perPortW != null ? p.poe.perPortW + "W" : "－"],
    ["総給電量", p => p.poe && p.poe.totalW != null ? p.poe.totalW + "W" : "－"]
  ];
  const featureRows = FEATURE_OPTIONS.map(f => [f.value, p => yesNo((p.features || []).includes(f.value))]);
  const envRows = [
    ["使用温度範囲", p => tempLabel(p)],
    ["ファン", p => p.fanless === true ? "ファンレス" : p.fanless === false ? "ファンあり" : "記載なし"],
    ["電源", p => p.power],
    ["設置方法", p => (p.install && p.install.length) ? p.install.join(" / ") : "記載なし"],
    ["筐体", p => p.housing || "－"],
    ["保証", p => p.warrantyYears != null ? p.warrantyYears + "年保証" : null]
  ];
  const detailRows = [
    ["スイッチングファブリック", p => p.specDetails && p.specDetails.fabric],
    ["MACアドレステーブル", p => p.specDetails && p.specDetails.macTable],
    ["バッファ容量", p => p.specDetails && p.specDetails.buffer],
    ["消費電力", p => p.specDetails && p.specDetails.powerConsumption],
    ["外形寸法", p => p.specDetails && p.specDetails.dimensions],
    ["質量", p => p.specDetails && p.specDetails.weight],
    ["JANコード", p => p.jan]
  ].filter(([, getter]) => selected.some(p => getter(p)));

  // 行ごとに、選んだ候補全体で値が同じか違うかを見て、違う行だけ目立たせる
  function rowHtml(label, getter) {
    const values = selected.map(p => { const v = getter(p); return v == null || v === "" ? "－" : String(v); });
    const allSame = values.every(v => v === values[0]);
    let out = '<tr class="' + (allSame ? "compare-table__row--same" : "compare-table__row--diff") + '"><th>' + escapeHtml(label) + "</th>";
    values.forEach(v => { out += "<td>" + escapeHtml(v) + "</td>"; });
    return out + "</tr>";
  }
  function sectionHtml(title, rows) {
    let out = '<tr class="compare-table__section-row"><th colspan="' + (selected.length + 1) + '">' + escapeHtml(title) + "</th></tr>";
    rows.forEach(([label, getter]) => { out += rowHtml(label, getter); });
    return out;
  }

  let html = '<table class="compare-table"><tr><th></th>';
  selected.forEach(p => {
    html += '<th class="compare-table__head"><span class="compare-table__sku">' + escapeHtml(p.sku) + "</span>"
      + (!isCurrent(p) ? ' <span class="status-tag">' + escapeHtml(p.status) + "</span>" : "")
      + '<br><span class="compare-table__name">' + escapeHtml(p.name) + "</span></th>";
  });
  html += "</tr><tr><th>画像</th>";
  selected.forEach(p => {
    html += '<td><a href="' + escapeHtml(p.sourceUrl) + '" target="_blank" rel="noopener noreferrer">'
      + '<img src="' + escapeHtml(p.imageUrl || PLACEHOLDER_SVG) + '" alt="' + escapeHtml(p.sku) + '" class="compare-table__image" '
      + "onerror=\"this.onerror=null;this.src='" + PLACEHOLDER_SVG + "'\"></a></td>";
  });
  html += "</tr>";
  html += sectionHtml("基本スペック", basicRows);
  html += sectionHtml("PoE（給電）", poeRows);
  html += sectionHtml("高機能", featureRows);
  html += sectionHtml("設置・環境", envRows);
  if (detailRows.length) html += sectionHtml("詳細スペック（商品ページより）", detailRows);
  html += "</table>";

  const notes = selected.filter(p => p.featureNote).map(p => "<li><strong>" + escapeHtml(p.sku) + "</strong>：" + escapeHtml(p.featureNote) + "</li>");
  if (notes.length) html += '<ul class="compare-footnote">' + notes.join("") + "</ul>";

  document.getElementById("compare-table-wrap").innerHTML = html;
  document.getElementById("compare-modal").hidden = false;
}

// ---------------------------------------------------------------------------
// 共有用URL
// 選んだ条件をURLの「?」以降に入れておき、そのURLを開くと同じ絞り込み・比較の状態が再現される。
//   port=8              ポート数（複数可）
//   speed=2.5G          通信速度（〜以上）
//   sfp=1               SFP / SFP+ポートあり
//   usage=home|biz      家庭・SOHO向け／法人向け（複数可）
//   mgmt=unmanaged|light|l2|l3   管理機能（複数可）
//   poe=1 poeplus=1 poew=60      PoE給電あり／PoE+対応／総給電量
//   feature=vlan など    高機能（複数可）
//   temp=0_50           使用温度範囲（複数可）
//   fanless=1 inpower=1 metal=1  ファンレス／電源内蔵／金属筐体
//   install=rack|magnet|wall     設置方法（複数可）
//   warranty=5          保証年数（複数可）
//   disc=1              生産終了品（在庫限り）を含める
//   cmp=型番ID          比較に選んだ機種（複数可）
//   view=compare        開いたときに比較表を表示する
// ---------------------------------------------------------------------------

// URLが日本語だらけで長くならないよう、選択肢は短い英字の記号に置き換える
const USAGE_CODE = { "家庭・SOHO向け": "home", "法人向け": "biz" };
const MGMT_CODE = { "アンマネージ": "unmanaged", "ライトマネージ": "light", "L2インテリジェント": "l2", "L3": "l3" };
const FEATURE_CODE = {
  "ループ検知・防止": "loop", "VLAN": "vlan", "QoS": "qos", "リンクアグリゲーション": "lag",
  "IGMPスヌーピング": "igmp", "IEEE802.1X認証": "8021x", "ポートミラーリング": "mirror",
  "SNMP監視": "snmp", "ジャンボフレーム": "jumbo", "省電力（EEE）": "eee"
};
const INSTALL_CODE = { "ラックマウント": "rack", "マグネット": "magnet", "壁掛け": "wall" };

function codesOf(set, table) {
  return [...set].map(v => table[v]).filter(Boolean);
}
function valuesFromCodes(codes, table) {
  return Object.keys(table).filter(v => codes.includes(table[v]));
}

function buildShareUrl(withCompareView) {
  const params = new URLSearchParams();
  [...filters.ports].sort((a, b) => a - b).forEach(v => params.append("port", String(v)));
  if (filters.speedMin) params.set("speed", filters.speedMin);
  if (filters.sfp) params.set("sfp", "1");
  codesOf(filters.usage, USAGE_CODE).forEach(c => params.append("usage", c));
  codesOf(filters.management, MGMT_CODE).forEach(c => params.append("mgmt", c));
  if (filters.poe) params.set("poe", "1");
  if (filters.poePlus) params.set("poeplus", "1");
  if (filters.poeTotalMin) params.set("poew", String(filters.poeTotalMin));
  codesOf(filters.features, FEATURE_CODE).forEach(c => params.append("feature", c));
  [...filters.tempRanges].forEach(k => params.append("temp", k));
  if (filters.fanless) params.set("fanless", "1");
  if (filters.internalPower) params.set("inpower", "1");
  if (filters.metal) params.set("metal", "1");
  codesOf(filters.install, INSTALL_CODE).forEach(c => params.append("install", c));
  [...filters.warranty].sort((a, b) => a - b).forEach(v => params.append("warranty", String(v)));
  const disc = document.getElementById("show-discontinued");
  if (disc && disc.checked) params.set("disc", "1");
  allProducts.forEach(p => { if (uiState[p.id] && uiState[p.id].checked) params.append("cmp", p.id); });
  if (withCompareView) params.set("view", "compare");
  const query = params.toString();
  return location.origin + location.pathname + (query ? "?" + query : "");
}

// アドレス欄のURLも、いまの絞り込み条件に合わせて更新しておく（そのままコピーしても共有できる）
function syncUrl() {
  try {
    history.replaceState(null, "", buildShareUrl(false));
  } catch (err) {
    console.warn("URLの更新に失敗しました:", err);
  }
}

// 共有URLの条件を画面の状態に反映する。比較表を開くよう指定されていれば true を返す。
// 実際のデータに無い値（古いURLや手で書き換えたURL）は無視する。
function applyStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const portValues = new Set(allProducts.map(p => p.ports));
  params.getAll("port").map(Number).forEach(n => { if (portValues.has(n)) filters.ports.add(n); });
  const speed = params.get("speed");
  if (speed && SPEED_ORDER.includes(speed)) filters.speedMin = speed;
  filters.sfp = params.get("sfp") === "1";
  valuesFromCodes(params.getAll("usage"), USAGE_CODE).forEach(v => filters.usage.add(v));
  valuesFromCodes(params.getAll("mgmt"), MGMT_CODE).forEach(v => filters.management.add(v));
  // PoE+・総給電量は「PoE給電あり」を選んだときだけ有効（画面と同じ決まり）
  filters.poe = params.get("poe") === "1";
  if (filters.poe) {
    filters.poePlus = params.get("poeplus") === "1";
    const w = Number(params.get("poew"));
    if (POE_TOTAL_STEPS.some(s => s.value === w)) filters.poeTotalMin = w;
  }
  valuesFromCodes(params.getAll("feature"), FEATURE_CODE).forEach(v => filters.features.add(v));
  const tempKeys = new Set(allProducts.map(tempKey).filter(Boolean));
  params.getAll("temp").forEach(k => { if (tempKeys.has(k)) filters.tempRanges.add(k); });
  filters.fanless = params.get("fanless") === "1";
  filters.internalPower = params.get("inpower") === "1";
  filters.metal = params.get("metal") === "1";
  valuesFromCodes(params.getAll("install"), INSTALL_CODE).forEach(v => filters.install.add(v));
  const warrantyValues = new Set(allProducts.map(p => p.warrantyYears));
  params.getAll("warranty").map(Number).forEach(n => { if (warrantyValues.has(n)) filters.warranty.add(n); });
  if (params.get("disc") === "1") document.getElementById("show-discontinued").checked = true;
  params.getAll("cmp").forEach(id => { if (uiState[id]) uiState[id].checked = true; });

  // 普段は閉じている欄（高機能・設置環境・保証）に条件が入っていたら、開いた状態で見せる
  if (filters.features.size) openSections.features = true;
  if (filters.tempRanges.size || filters.fanless || filters.internalPower || filters.metal || filters.install.size) openSections.environment = true;
  if (filters.warranty.size) openSections.other = true;

  return params.get("view") === "compare";
}

async function copyShareUrl(url, feedbackId, fallbackId, fallbackInputId) {
  const feedback = document.getElementById(feedbackId);
  const fallback = document.getElementById(fallbackId);
  const fallbackInput = document.getElementById(fallbackInputId);
  try {
    await navigator.clipboard.writeText(url);
    fallback.hidden = true;
    feedback.textContent = "URLをコピーしました";
    feedback.hidden = false;
    setTimeout(() => { feedback.hidden = true; }, 2500);
  } catch (err) {
    // クリップボードが使えない環境では、確認ウィンドウ（prompt）は使わずに、画面上にURLを表示して手でコピーしてもらう
    fallbackInput.value = url;
    fallback.hidden = false;
    fallbackInput.focus();
    fallbackInput.select();
  }
}

// ---------------------------------------------------------------------------
// 簡易パスワードゲート（試作版の関係者限定用）
// GitHub Pagesは静的配信のみのため、本当の意味でのサーバー側認証ではなく、
// このJavaScriptのチェックを通らないと中身を表示しない、という簡易的な鍵です。
// ---------------------------------------------------------------------------

const SITE_PASSWORD = "switch2026";
const UNLOCK_KEY = "switch-selector-unlocked";

// 日本語入力がオンのまま打つと全角になってしまうことがあるため、半角に揃えてから比較する
function normalizeInput(str) {
  return str
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function showApp() {
  document.getElementById("password-gate").hidden = true;
  document.getElementById("app-root").hidden = false;
  init();
}

let alreadyUnlocked = false;
try {
  alreadyUnlocked = sessionStorage.getItem(UNLOCK_KEY) === "1";
} catch (err) {
  console.warn("sessionStorageの読み込みに失敗しました:", err);
}

if (alreadyUnlocked) {
  showApp();
} else {
  const passwordInput = document.getElementById("password-input");
  const toggleBtn = document.getElementById("password-toggle");
  const errorEl = document.getElementById("password-error");

  toggleBtn.addEventListener("click", () => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    toggleBtn.textContent = showing ? "👁" : "🙈";
  });

  document.getElementById("password-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = normalizeInput(passwordInput.value);
    if (input === SITE_PASSWORD) {
      try {
        sessionStorage.setItem(UNLOCK_KEY, "1");
      } catch (err) {
        console.warn("sessionStorageへの保存に失敗しましたが、表示は続行します:", err);
      }
      showApp();
    } else {
      errorEl.textContent = "パスワードが違います";
      errorEl.hidden = false;
    }
  });
}
