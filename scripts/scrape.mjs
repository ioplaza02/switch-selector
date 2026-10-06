// スイッチセレクターのデータを取得するスクレイパー。
//
// 使い方：
//   node scripts/scrape.mjs
//
// 処理の流れ：
// 1. 一覧ページ（スイッチングハブ／スイッチ／PoE）から、シリーズのページと
//    そのシリーズに含まれる型番、見出し（「10Gigabit対応」「ライトマネージ」など）、
//    価格、生産終了アイコンを拾う
// 2. シリーズごとに index.htm（商品ページ本文）と spec.htm（仕様表）を取得する
// 3. 仕様表を「型番ごとの列」に分解して、絞り込みに使う項目を型番ごとに取り出す
// 4. data/switches.json に書き出す
//
// NASセレクターでの教訓を反映している点：
// - 文字列一致は表記ゆれに弱いので、比較用の文字列は NFKC 正規化
//   （全角英数字→半角、「～」「／」などの揺れを吸収）してから照合する
// - 同じ文言が複数回出ることがあるので「最初の出現だけ」で判定しない
// - ページ上部のナビゲーション文言を誤って拾わないよう、
//   本文全体ではなく「仕様表の行」を優先して判定し、本文はあくまで補助に使う
//
// 実行の最後に、型番ごとの取得結果の一覧と「取れなかった項目」を表示する。
// うまく取れていない項目があれば、その表示をそのまま共有してください。

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = "https://www.iodata.jp";

const LIST_PAGES = [
  "https://www.iodata.jp/product/lan/hub/",
  "https://www.iodata.jp/product/lan/switch/",
  "https://www.iodata.jp/product/lan/poe/"
];

// スイッチではない商品（PoEインジェクターなど）は対象外にする
const EXCLUDE_SLUG_PATTERNS = [/^binj-/];

// 一覧ページの見出し → 判定のヒント
// （見出しは公式が付けている分類なので、本文から推測するより確実）
const HEADING_HINTS = [
  { re: /10\s*Gigabit/i, speed: "10G" },
  { re: /2\.5\s*Gigabit/i, speed: "2.5G" },
  { re: /(?<![\d.])Gigabit対応/i, speed: "1G" },
  { re: /100BASE-TX/i, speed: "100M" },
  { re: /L2インテリジェント/, management: "L2インテリジェント" },
  { re: /ライトマネージ/, management: "ライトマネージ" },
  { re: /^インテリジェントスイッチ$/, management: "L2インテリジェント" },
  { re: /^アンマネージスイッチ$/, management: "アンマネージ" }
];
const HEADING_TEXTS = [
  "10Gigabit対応", "2.5Gigabit対応", "Gigabit対応", "100BASE-TX",
  "L2インテリジェントスイッチ", "ライトマネージ", "PoE対応スイッチ",
  "インテリジェントスイッチ", "アンマネージスイッチ", "インジェクター"
];

// 実行時に表示する版の名前（どの版のスクレイパーが動いたかを確認するため）
const SCRAPER_VERSION = "2026-10-06b 使用温度範囲の下限に対応";

const OUTPUT_PATH = new URL("../data/switches.json", import.meta.url);
const REQUEST_INTERVAL_MS = 2000;
const USER_AGENT =
  "SwitchSelectorBot/1.0 (+https://github.com/ioplaza02; " +
  "daily price/spec check for internal comparison tool)";

// 絞り込みに使う「高機能」の一覧。表示名と、仕様表の文言の照合パターン。
export const FEATURE_DEFS = [
  { key: "ループ検知・防止", re: /ループ(?:検知|防止)/ },
  { key: "VLAN", re: /VLAN/i },
  { key: "QoS", re: /QoS/i },
  { key: "リンクアグリゲーション", re: /リンクアグリゲーション|リンク・アグリゲーション/ },
  { key: "IGMPスヌーピング", re: /IGMP/i },
  { key: "IEEE802.1X認証", re: /802\.1X/i, extra: s => /認証/.test(s) && !/透過/.test(s) },
  { key: "ポートミラーリング", re: /ミラーリング/ },
  { key: "SNMP監視", re: /SNMP/i },
  { key: "ジャンボフレーム", re: /ジャンボフレーム/ },
  // 「IEEE」の一部の「EEE」を誤って拾わないよう、直前がIでないことを条件にする
  { key: "省電力（EEE）", re: /(?<!I)EEE(?![A-Z])|省電力機能/ }
];

// ---------------------------------------------------------------------------
// 共通の小道具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.text();
}

// 照合用の正規化：全角英数字・記号を半角に、ゼロ幅スペースを除去、空白をまとめる
export function nk(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[〜～]/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}

// 表示用：タグを外して空白を整えるだけ（全角などはそのまま残す）
export function cleanText(html) {
  return decodeEntities(String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ページ本文のテキスト（script/style/ヘッダー/ナビ/フッターを除いたもの）
export function bodyText(html) {
  const stripped = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  return cleanText(stripped);
}

function absUrl(src) {
  let s = String(src || "").trim();
  if (!s) return null;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return BASE + s;
  if (/^https?:/i.test(s)) return s;
  return null;
}

// 型番らしい文字列。先頭が英大文字3〜4文字（＋数字1つまで）、ハイフンの後に数字を含む。
// 「RJ-45」「EAP-MD5」などを型番と誤認しないための条件。
const SKU_RE = /(?<![A-Z0-9\-])([A-Z]{3,4}\d?-[A-Z0-9]*\d[A-Z0-9]*(?:\/[A-Z0-9]+)?)(?![A-Z0-9])/g;
const NOT_SKU_PREFIX = /^(EAP|IEEE|VCCI|PEAP|CHAP|PoE)/i;

// 型番らしい文字列の直後が「シリーズ」なら、それは型番ではなくシリーズ名
function isSeriesName(text, endIndex) {
  return /^\s*シリーズ/.test(text.slice(endIndex, endIndex + 8));
}

// シリーズのページ名（URLの etx-esh08c の部分）とまったく同じ文字列の「型番」は、
// 実際にはシリーズ名（ETX-ESH08Cシリーズ）なので、ほかに本物の型番がある場合は外す。
// 1機種だけのシリーズ（例：bsh-gp08mb → BSH-GP08MB）はページ名＝型番なので残す。
export function dropSeriesNameSku(slug, skus) {
  const slugUpper = String(slug).toUpperCase();
  const others = skus.filter(s => s.toUpperCase() !== slugUpper);
  return others.length > 0 ? others : skus;
}

function skuRegex(sku) {
  const esc = sku.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  return new RegExp("(?<![A-Z0-9\\-])" + esc + "(?![A-Z0-9/])", "g");
}

// ---------------------------------------------------------------------------
// 表（table）を、結合セル（colspan/rowspan）を展開した格子に変換する
// ---------------------------------------------------------------------------

export function parseTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    tables.push(parseTableGrid(m[1]));
  }
  return tables;
}

function parseTableGrid(tableHtml) {
  const grid = [];
  const pending = []; // rowspanで下の行に持ち越すセル: pending[col] = {cell, remaining}
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  let rowIdx = 0;
  while ((rm = rowRe.exec(tableHtml)) !== null) {
    const row = [];
    const cellRe = /<(t[dh])([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    let col = 0;
    const fillPending = () => {
      while (pending[col] && pending[col].remaining > 0) {
        row[col] = pending[col].cell;
        pending[col].remaining--;
        col++;
      }
    };
    fillPending();
    while ((cm = cellRe.exec(rm[1])) !== null) {
      fillPending();
      const attrs = cm[2];
      const colspan = Number((attrs.match(/colspan\s*=\s*["']?(\d+)/i) || [])[1] || 1);
      const rowspan = Number((attrs.match(/rowspan\s*=\s*["']?(\d+)/i) || [])[1] || 1);
      const cell = {
        isTh: cm[1].toLowerCase() === "th",
        text: cleanText(cm[3]),
        id: rowIdx + ":" + col
      };
      for (let k = 0; k < colspan; k++) {
        row[col] = cell;
        if (rowspan > 1) pending[col] = { cell, remaining: rowspan - 1 };
        col++;
      }
    }
    fillPending();
    // 行の末尾より右側に持ち越しセルが残っている場合も埋める
    for (let c = col; c < pending.length; c++) {
      if (pending[c] && pending[c].remaining > 0) {
        row[c] = pending[c].cell;
        pending[c].remaining--;
      }
    }
    grid.push(row.filter(Boolean).length > 0 ? row : []);
    rowIdx++;
  }
  return grid.filter(r => r.length > 0);
}

function tableText(grid) {
  return grid.map(r => r.map(c => c && c.text).join(" ")).join(" ");
}

// 仕様表以外の表（省エネ法の表示事項、PoEクラス表、推奨SFPモジュール表など）を見分ける
function isAuxTable(grid) {
  const t = tableText(grid);
  return /省エネ法|区分名|エネルギー消費効率|受電機器|変換先/.test(t);
}

// 表の中から「型番の見出し行」を探し、格子の列番号 → 型番 の対応を作る
function findModelColumns(grid, skus) {
  const normSkus = skus.map(s => ({ sku: s, n: nk(s).replace(/\s/g, "") }));
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const map = {};
    const seen = new Set();
    row.forEach((cell, c) => {
      if (!cell || seen.has(cell.id + "@" + c)) return;
      const t = nk(cell.text).replace(/\s/g, "");
      normSkus.forEach(({ sku, n }) => {
        // 「BSH-G08MB」と「BSH-G08M」のような前方一致の取り違えを防ぐため、境界付きで探す
        if (new RegExp("(?<![A-Z0-9\\-])" + n.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") + "(?![A-Z0-9/])").test(t)) {
          if (map[sku] === undefined) map[sku] = c;
        }
      });
    });
    if (Object.keys(map).length >= 1) {
      const firstLabel = nk(row[0] && row[0].text);
      if (Object.keys(map).length >= 2 || /型番|型名/.test(firstLabel)) {
        return { headerRow: r, map };
      }
    }
  }
  return null;
}

// 仕様表を型番ごとの「ラベル｜値」の行リストに分解する
export function specRowsByModel(specHtml, skus) {
  const result = {};
  skus.forEach(s => { result[s] = []; });
  const tables = parseTables(specHtml).filter(g => g.length >= 2 && !isAuxTable(g));
  let inherited = null;
  for (const grid of tables) {
    const found = findModelColumns(grid, skus);
    const mapping = found || (inherited && grid.some(r => r.length === inherited.width) ? inherited : null);
    if (found) inherited = { ...found, width: grid[found.headerRow].length };
    const modelCols = mapping ? Object.values(mapping.map) : [];
    const firstModelCol = modelCols.length ? Math.min(...modelCols) : null;

    grid.forEach((row, r) => {
      if (found && r === found.headerRow) return;
      if (row.length < 2) return;
      let labelCells;
      if (firstModelCol !== null && row.length > firstModelCol) {
        labelCells = row.slice(0, firstModelCol);
      } else {
        labelCells = row.slice(0, row.length - 1);
      }
      const labelParts = [];
      labelCells.forEach(c => { if (c && !labelParts.includes(c.text)) labelParts.push(c.text); });
      const label = labelParts.join(" ").trim();
      if (!label) return;
      skus.forEach(sku => {
        let cell;
        if (mapping && mapping.map[sku] !== undefined && row[mapping.map[sku]]) {
          cell = row[mapping.map[sku]];
        } else {
          cell = row[row.length - 1];
        }
        if (!cell || labelCells.includes(cell)) return;
        const value = cell.text;
        if (value) result[sku].push({ label, value });
      });
    });
  }
  return result;
}

function findRow(rows, labelRe) {
  return rows.find(r => labelRe.test(nk(r.label)));
}
function findRows(rows, labelRe) {
  return rows.filter(r => labelRe.test(nk(r.label)));
}

// ---------------------------------------------------------------------------
// 一覧ページの解析
// ---------------------------------------------------------------------------

const SERIES_LINK_RE = /\/product\/lan\/(hub|switch)\/([a-z0-9\-]+)\/(?:index\.htm)?(?=["'#?])/gi;

export function parseListPage(html) {
  // シリーズへのリンクの出現位置を全部集める
  const occ = [];
  let m;
  const re = new RegExp(SERIES_LINK_RE.source, "gi");
  while ((m = re.exec(html)) !== null) {
    const slug = m[2].toLowerCase();
    if (["index", "info"].includes(slug)) continue;
    occ.push({ slug, folder: m[1].toLowerCase(), pos: m.index });
  }

  // 見出し文言の出現位置（テキスト部分にあるものだけ）
  const headings = [];
  const textNodeRe = />([^<]+)</g;
  let tm;
  while ((tm = textNodeRe.exec(html)) !== null) {
    const t = nk(tm[1]);
    if (!t || t.length > 40) continue;
    for (const h of HEADING_TEXTS) {
      // 「100BASE-TX／10BASE-Te 対応」のような見出しは前方一致で拾うが、
      // 「Gigabit対応小型アンマネージスイッチングハブ」のような商品名を見出しと誤認しないよう、
      // 末尾が「対応」で終わるものに限る
      if (t === nk(h) || (t.startsWith(nk(h)) && /対応$/.test(t) && t.length <= nk(h).length + 16)) {
        headings.push({ text: t, pos: tm.index });
        break;
      }
    }
  }

  const series = {};
  occ.forEach((o, i) => {
    if (EXCLUDE_SLUG_PATTERNS.some(p => p.test(o.slug))) return;
    // 次に「別のシリーズ」へのリンクが出てくるまでを、このシリーズの範囲とする
    let end = html.length;
    for (let j = i + 1; j < occ.length; j++) {
      if (occ[j].slug !== o.slug) { end = occ[j].pos; break; }
    }
    const blockHtml = html.slice(o.pos, end);
    const s = series[o.slug] || (series[o.slug] = {
      slug: o.slug,
      folder: o.folder,
      url: `${BASE}/product/lan/${o.folder}/${o.slug}/index.htm`,
      blocks: [],
      headings: new Set(),
      imageCandidates: []
    });
    s.blocks.push(blockHtml);
    const prevHeading = headings.filter(h => h.pos < o.pos).pop();
    if (prevHeading) s.headings.add(prevHeading.text);
    // 商品画像はシリーズへのリンクの中（＝リンク位置より後ろ）にあるのが基本。
    // 見つからない場合だけ、リンクの少し手前（直前の別シリーズの範囲に入らない所まで）も探す。
    const pickImages = area => {
      const found = [];
      const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
      let im;
      while ((im = imgRe.exec(area)) !== null) {
        const src = im[1];
        if (/icon_|btn|button|common|logo|arrow|spacer|\.gif$/i.test(src)) continue;
        const u = absUrl(src);
        if (u) found.push(u);
      }
      return found;
    };
    let imgs = pickImages(html.slice(o.pos, Math.min(end, o.pos + 3000)));
    if (imgs.length === 0) {
      const prevEnd = i > 0 ? occ[i - 1].pos : 0;
      imgs = pickImages(html.slice(Math.max(prevEnd, o.pos - 400), o.pos));
    }
    s.imageCandidates.push(...imgs);
  });

  // シリーズごとに、範囲内の型番・価格・状態を拾う
  Object.values(series).forEach(s => {
    const blockHtml = s.blocks.join("\n");
    const prefix = s.slug.split("-")[0].toUpperCase();
    const text = nk(cleanText(blockHtml));
    const skus = new Set();
    let sm;
    const sre = new RegExp(SKU_RE.source, "g");
    while ((sm = sre.exec(text)) !== null) {
      const sku = sm[1];
      if (NOT_SKU_PREFIX.test(sku)) continue;
      if (sku.split("-")[0] !== prefix) continue;
      // 「ETX-ESH08Cシリーズ」のようなシリーズ名を型番と誤認しないよう、
      // 直後に「シリーズ」が続く出現は型番として数えない
      if (isSeriesName(text, sm.index + sm[0].length)) continue;
      skus.add(sku);
    }
    s.skus = dropSeriesNameSku(s.slug, [...skus]);
    s.models = {};
    s.skus.forEach(sku => {
      s.models[sku] = lookupListModelInfo(blockHtml, sku, s.skus);
    });
  });
  return series;
}

// 一覧ページ上の「型番｜ポート数｜価格」の小さな表から、その型番の情報を拾う。
// 型番の出現位置から、次の別型番の出現位置までを範囲にする。
function lookupListModelInfo(blockHtml, sku, allSkus) {
  const re = skuRegex(sku);
  const info = { found: false, status: null, priceIncTax: null, priceText: null, ports: null };
  let m;
  while ((m = re.exec(blockHtml)) !== null) {
    info.found = true;
    let end = Math.min(blockHtml.length, m.index + 700);
    for (const other of allSkus) {
      if (other === sku) continue;
      const ore = skuRegex(other);
      ore.lastIndex = m.index + sku.length;
      const om = ore.exec(blockHtml);
      if (om && om.index < end) end = om.index;
    }
    const windowHtml = blockHtml.slice(m.index, end);
    const windowText = nk(cleanText(windowHtml));
    if (/icon_close/i.test(windowHtml) || /生産終了/.test(windowText)) info.status = "生産終了";
    else if (!info.status && (/icon_limit/i.test(windowHtml) || /在庫限り/.test(windowText))) info.status = "在庫限り";
    const pm = windowText.match(/[¥\\]\s*([\d,]+)/);
    if (pm && info.priceIncTax == null) info.priceIncTax = Number(pm[1].replace(/,/g, ""));
    if (!info.priceText && /オープン価格/.test(windowText)) info.priceText = "オープン価格";
    const portM = windowText.match(/(\d+)\s*ポート/);
    if (portM && info.ports == null) info.ports = Number(portM[1]);
  }
  return info;
}

// ---------------------------------------------------------------------------
// 型番ごとの項目の取り出し
// ---------------------------------------------------------------------------

function speedRank(text) {
  const t = nk(text);
  if (/10GBASE-T|(?<![\d.])10\s*G(?![a-z\d])/i.test(t)) return "10G";
  if (/2\.5\s*G/i.test(t)) return "2.5G";
  if (/1000BASE-T|1000\s*M|(?<![\d.])1\s*G(?![\d])|Gigabit/i.test(t)) return "1G";
  if (/100BASE-TX|(?<![\d])100\s*M/i.test(t)) return "100M";
  return null;
}

// 値の文字列を「、」「,」「/」などで区切った各項目に、機能名が含まれるか。
// 「ループ防止：非対応」のような否定の書き方は除外する。
function valueHasFeature(value, def) {
  const segments = nk(value).split(/[、,]|\s{2,}/);
  return segments.some(seg => def.re.test(seg) && (!def.extra || def.extra(seg)) && !/非対応|未対応|なし$/.test(seg));
}

export function extractModel(ctx) {
  const { sku, rows, title, indexText, specPageText, listInfo, hints } = ctx;
  const warnings = [];
  const allRowText = rows.map(r => r.label + "：" + r.value).join("\n");
  const pageText = nk(indexText + " " + specPageText);

  // --- ポート数 ---
  let ports = null;
  const portRow = findRow(rows, /LAN\s*ポート|RJ-?45\s*ポート|ポート数/);
  if (portRow) {
    const v = nk(portRow.value);
    const pm = v.match(/[×x]\s*(\d+)/i) || v.match(/(\d+)\s*ポート/);
    if (pm) ports = Number(pm[1]);
  }
  if (ports == null && listInfo && listInfo.ports) ports = listInfo.ports;
  if (ports == null) {
    const tm = nk(title).match(/(\d+)\s*ポート/);
    if (tm) ports = Number(tm[1]);
  }
  if (ports == null) warnings.push("ポート数");

  // --- SFP / SFP+ ---
  let sfp = null;
  const sfpRow = findRow(rows, /SFP\+?\s*ポート/i);
  if (sfpRow) {
    const cm = nk(sfpRow.value).match(/(\d+)/);
    const isPlus = /SFP\+/i.test(nk(sfpRow.label));
    if (cm && Number(cm[1]) > 0) {
      sfp = { count: Number(cm[1]), type: isPlus ? "SFP+" : "SFP", speed: isPlus ? "10G" : "1G" };
    }
  }

  // --- 通信速度（RJ-45ポートの最大速度） ---
  let speed = hints.speed || null;
  let speedNote = null;
  if (/10\s*\/\s*100\s*Mbps/i.test(nk(title))) speed = "100M";
  if (!speed && portRow) speed = speedRank(portRow.value);
  if (!speed) {
    const ethRow = findRow(rows, /Ethernet\s*規格|対応規格/i);
    if (ethRow) {
      let v = nk(ethRow.value);
      // SFP+モジュール利用時のみ対応の10G規格は、RJ-45ポートの速度に含めない
      if (sfp) v = v.replace(/10GBASE-[A-Z]+[^,、]*?※\s*\d/gi, "").replace(/10GBASE-(SR|LR|ER)/gi, "");
      speed = speedRank(v);
    }
  }
  if (!speed) speed = speedRank(title);
  if (!speed) warnings.push("通信速度");
  if (speed === "100M" && /1000BASE-T/i.test(nk(allRowText))) {
    speedNote = "アップリンクポートのみ1Gbps対応";
  }

  // --- 管理機能のレベル ---
  let management = hints.management || null;
  const mgmtText = nk(title + " " + allRowText);
  let textMgmt = "アンマネージ";
  if (/L2インテリジェント|インテリジェントスイッチ|WEB設定画面|Web設定画面|SNMP/i.test(mgmtText)) textMgmt = "L2インテリジェント";
  else if (/ライトマネージ/.test(mgmtText)) textMgmt = "ライトマネージ";
  if (!management) management = textMgmt;
  else if (management !== textMgmt && !(management === "ライトマネージ" && textMgmt === "アンマネージ")) {
    warnings.push(`管理機能の判定が食い違い（一覧見出し:${management} / 仕様表:${textMgmt}）`);
  }

  // --- PoE ---
  let poe = null;
  const poeRows = rows.filter(r => /PoE|PSE|給電/i.test(nk(r.label)));
  const poeText = nk(poeRows.map(r => r.label + " " + r.value).join(" "));
  if (poeRows.length > 0 || (/PoE/i.test(nk(title)) && !/PoE非対応/.test(nk(title)))) {
    const src = poeText || nk(title);
    const standards = [];
    if (/802\.3af/i.test(src)) standards.push("802.3af");
    if (/802\.3at/i.test(src)) standards.push("802.3at");
    if (/802\.3bt/i.test(src)) standards.push("802.3bt");
    if (standards.length === 0 && /802\.3at/i.test(nk(title))) standards.push("802.3at");

    let poePorts = null;
    const rangeM = src.match(/(\d+)\s*~\s*(\d+)\s*ポート/);
    if (rangeM) poePorts = Number(rangeM[2]) - Number(rangeM[1]) + 1;
    if (poePorts == null) {
      const cntM = src.match(/(?:給電ポート数?|PoEポート数?)\s*[:：]?\s*(\d+)/);
      if (cntM) poePorts = Number(cntM[1]);
    }
    if (poePorts == null && /全ポート/.test(src)) poePorts = ports;

    let perPortW = null;
    const ppM = src.match(/(?:各ポート|1ポートあたり|1ポート当たり|1ポート)\s*(?:最大)?\s*(\d+(?:\.\d+)?)\s*W/i);
    if (ppM) perPortW = Number(ppM[1]);
    if (perPortW == null && standards.includes("802.3at")) perPortW = 30;
    if (perPortW == null && standards.includes("802.3af")) perPortW = 15.4;

    let totalW = null;
    const totM = src.match(/(?:最大供給電力|装置全体合計|全体合計|合計|総給電量?|総供給電力)\s*(?:最大)?\s*(\d+(?:\.\d+)?)\s*W/i)
      || nk(allRowText).match(/(?:最大供給電力|装置全体合計|総給電量?)\s*(?:最大)?\s*(\d+(?:\.\d+)?)\s*W/i);
    if (totM) totalW = Number(totM[1]);

    poe = { standards, ports: poePorts, perPortW, totalW };
    if (standards.length === 0) warnings.push("PoE規格");
    if (totalW == null) warnings.push("PoE総給電量");
    if (poePorts == null) warnings.push("PoE給電ポート数");
  }

  // --- 高機能 ---
  const features = [];
  FEATURE_DEFS.forEach(def => {
    let hit = false;
    for (const r of rows) {
      const label = nk(r.label);
      // Ethernet規格の「10BASE-Te（IEEE802.3az）」はEEEの判定に使わない
      if (def.key === "省電力（EEE）" && /Ethernet|規格/.test(label)) continue;
      if (def.key === "ジャンボフレーム") {
        if (/ジャンボフレーム/.test(label) && !/非対応|なし|-/.test(nk(r.value).slice(0, 3)) && /\d/.test(nk(r.value))) hit = true;
        else if (valueHasFeature(r.value, def) && /対応|\d/.test(nk(r.value))) hit = true;
        continue;
      }
      // ラベル自体が機能名の行（例：「VLAN｜ポートVLAN、タグVLAN」）
      if (def.re.test(label) && (!def.extra || def.extra(label + nk(r.value))) && !/非対応|未対応|^なし|^-$/.test(nk(r.value))) {
        hit = true;
      }
      if (valueHasFeature(r.value, def)) hit = true;
    }
    // 省電力（EEE）は商品ページ本文にだけ書かれていることがあるので補助的に見る
    if (!hit && def.key === "省電力（EEE）" && /(?<!I)EEE(?![A-Z])/.test(nk(indexText))) hit = true;
    if (hit) features.push(def.key);
  });

  // 同時に使えない機能の注意書き（例：「ループ検知・防止、ポートVLAN、リンクアグリゲーションは排他利用」）
  let featureNote = null;
  const exM = (specPageText + " " + indexText).match(/[^。※]{0,60}排他[^。]{0,20}/);
  if (exM) featureNote = exM[0].replace(/^\s*[※*\d]+\s*/, "").trim();

  // --- 動作温度 ---
  let tempText = null;
  let tempMaxC = null;
  let tempMinC = null;
  const tempRow = rows.find(r => /温度/.test(nk(r.label)) && !/湿度/.test(nk(r.label)) && /\d/.test(r.value));
  if (tempRow) {
    tempText = tempRow.value;
    const tm = nk(tempRow.value).match(/~\s*\+?\s*(\d+)\s*(?:°\s*C|℃|度)/);
    if (tm) tempMaxC = Number(tm[1]);
    const tmin = nk(tempRow.value).match(/(-?\d+)\s*(?:°\s*C|℃|度)?\s*~/);
    if (tmin) tempMinC = Number(tmin[1]);
  }
  if (tempMaxC == null) warnings.push("動作温度");

  // --- ファンレス ---
  let fanless = null;
  const fanRow = findRow(rows, /^ファン/);
  if (fanRow) {
    if (/なし|無し|非搭載|ファンレス/.test(nk(fanRow.value))) fanless = true;
    else if (/あり|有り|搭載|\d/.test(nk(fanRow.value))) fanless = false;
  }
  if (fanless == null && /ファンレス|ファンを排除|ファンを省|冷却ファンを省/.test(pageText)) fanless = true;

  // --- 電源 ---
  let power = null;
  const powerRow = rows.find(r => /^電源/.test(nk(r.label)));
  if (powerRow) {
    const v = nk(powerRow.value);
    if (/内蔵/.test(v)) power = "内蔵電源";
    else if (/ACアダプター|ACアダプタ/.test(v)) power = "ACアダプター";
  }
  if (!power) {
    const accText = nk(findRows(rows, /付属品|添付品|同梱品/).map(r => r.value).join(" "));
    if (/ACアダプター|ACアダプタ/.test(accText)) power = "ACアダプター";
    else if (/ACアダプター(?:が|は)?不要|電源内蔵|内蔵電源/.test(pageText)) power = "内蔵電源";
    else if (/ACアダプター/.test(pageText)) power = "ACアダプター";
  }
  if (!power) warnings.push("電源");

  // --- 保証期間 ---
  let warrantyYears = null;
  const warrantyRow = findRow(rows, /保証/);
  if (warrantyRow) {
    const wm = nk(warrantyRow.value).match(/(\d+)\s*年/);
    if (wm) warrantyYears = Number(wm[1]);
  }
  if (warrantyYears == null) {
    const wm = pageText.match(/(\d+)\s*年(?:間)?保証/);
    if (wm) warrantyYears = Number(wm[1]);
  }
  if (warrantyYears == null) warnings.push("保証期間");

  // --- VCCI（家庭向け・法人向けの判定に使う） ---
  let vcci = null;
  const vm = nk(allRowText + " " + specPageText).match(/VCCI\s*(?:Class|クラス)\s*([AB])/i);
  if (vm) vcci = vm[1].toUpperCase();
  if (!vcci) warnings.push("VCCI（用途判定）");

  // --- 筐体 ---
  const housing = /金属筐体|金属製筐体|メタルボディ|金属ケース|スチール筐体|金属製の筐体/.test(pageText) ? "金属" : null;

  // --- 詳細スペック（比較表用） ---
  const pick = re => { const r = findRow(rows, re); return r ? r.value : null; };
  const specDetails = {
    fabric: pick(/スイッチングファブリック|スイッチング容量/),
    macTable: pick(/MACアドレス/),
    buffer: pick(/バッファ/),
    powerConsumption: pick(/^消費電力/),
    dimensions: pick(/外形寸法/),
    weight: pick(/質量|重量/)
  };

  return {
    ports, speed, speedNote, sfp, management, poe, features, featureNote,
    tempText, tempMinC, tempMaxC, fanless, power, warrantyYears, vcci, housing, specDetails,
    warnings
  };
}

// 設置方法（ラックマウント／マグネット／壁掛け）は、仕様表の付属品の欄に
// 型番ごとの違いが書かれていることがある（例：8ポートだけマグネット付属、
// 16/24ポートだけラックマウントアダプター付属）。
// そのため、まず型番ごとの仕様表の行で判定し、シリーズの誰にも書かれていない
// 項目だけ、商品ページ本文の記述をシリーズ全体に当てはめる。
const INSTALL_DEFS = [
  { key: "ラックマウント", rowRe: /ラックマウント|19インチラック/, pageRe: /19インチラック|ラックマウントアダプター|ラックマウント対応|ラックマウントに対応/ },
  { key: "マグネット", rowRe: /マグネット/, pageRe: /マグネット/ },
  { key: "壁掛け", rowRe: /壁掛け|フックホール|壁面/, pageRe: /フックホール|壁掛け/ }
];

export function decideInstall(rowsBySku, pageText) {
  const result = {};
  Object.keys(rowsBySku).forEach(sku => { result[sku] = []; });
  const page = nk(pageText);
  INSTALL_DEFS.forEach(def => {
    const fromRows = {};
    let anyFromRows = false;
    Object.entries(rowsBySku).forEach(([sku, rows]) => {
      const hit = rows.some(r => {
        const label = nk(r.label);
        const value = nk(r.value);
        if (!/付属|添付|同梱|設置|マグネット|ラック|壁/.test(label)) return false;
        if (def.rowRe.test(label) && !/なし|非対応|不可|-/.test(value.slice(0, 4))) return true;
        return def.rowRe.test(value) && !/不可|非対応/.test(value);
      });
      fromRows[sku] = hit;
      if (hit) anyFromRows = true;
    });
    Object.keys(rowsBySku).forEach(sku => {
      if (anyFromRows ? fromRows[sku] : def.pageRe.test(page)) result[sku].push(def.key);
    });
  });
  return result;
}

// 商品ページ本文から、型番の近くにあるJANコードを拾う
export function lookupJan(text, sku) {
  const t = nk(text);
  const re = skuRegex(sku);
  let m;
  while ((m = re.exec(t)) !== null) {
    const after = t.slice(m.index, m.index + 300);
    const jm = after.match(/(?<!\d)(49\d{11})(?!\d)/);
    if (jm) return jm[1];
  }
  return null;
}

// 商品ページ本文に「2024/5/22生産終了」などと書かれていれば拾う
function lookupStatusInPage(text, sku) {
  const t = nk(text);
  const re = skuRegex(sku);
  let m;
  while ((m = re.exec(t)) !== null) {
    const after = t.slice(m.index, m.index + 120);
    // 次の型番が出てくる前までに「生産終了」があるか
    const cut = after.slice(sku.length).search(/[A-Z]{3,4}\d?-[A-Z0-9]*\d/);
    const win = cut === -1 ? after : after.slice(0, sku.length + cut);
    if (/生産終了|販売終了/.test(win)) return "生産終了";
    if (/在庫限り/.test(win)) return "在庫限り";
  }
  return null;
}

function extractTitle(indexHtml) {
  const h1 = indexHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let t = h1 ? cleanText(h1[1]) : "";
  if (!t) {
    const tt = indexHtml.match(/<title>([\s\S]*?)<\/title>/i);
    t = tt ? cleanText(tt[1]).split(/[|｜]/)[0] : "";
  }
  return t;
}

// 「内蔵電源＆ファンレス設計 10Gアンマネージスイッチングハブ BSH-XGシリーズ」から
// 末尾のシリーズ名・型番を取り除いて、キャッチコピー部分だけにする
function catchCopy(title) {
  return title
    .replace(/\s*[A-Z]{3,4}\d?-[A-Z0-9\/]+(?:\s*シリーズ)?\s*$/, "")
    .replace(/\s*[A-Z]{3,4}\d?-[A-Z0-9\/]+(?:\s*シリーズ)?\s*$/, "")
    .trim();
}

function extractOgImage(indexHtml) {
  const m = indexHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || indexHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? absUrl(m[1]) : null;
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  console.log(`スイッチセレクター スクレイパー（版：${SCRAPER_VERSION}）`);
  console.log("一覧ページを取得しています...");
  const allSeries = {};
  for (const url of LIST_PAGES) {
    const html = await fetchText(url);
    const parsed = parseListPage(html);
    Object.values(parsed).forEach(s => {
      const cur = allSeries[s.slug];
      if (!cur) { allSeries[s.slug] = s; return; }
      s.headings.forEach(h => cur.headings.add(h));
      s.skus.forEach(sku => {
        if (!cur.skus.includes(sku)) cur.skus.push(sku);
        const a = cur.models[sku];
        const b = s.models[sku];
        if (!a) cur.models[sku] = b;
        else {
          if (a.priceIncTax == null) a.priceIncTax = b.priceIncTax;
          if (!a.priceText) a.priceText = b.priceText;
          if (!a.status) a.status = b.status;
          if (a.ports == null) a.ports = b.ports;
        }
      });
      cur.imageCandidates.push(...s.imageCandidates);
    });
    console.log(`  ${url} … ${Object.keys(parsed).length}シリーズ`);
    await sleep(REQUEST_INTERVAL_MS);
  }

  const seriesList = Object.values(allSeries);
  // 複数の一覧ページを合わせた後にも、シリーズ名を型番と取り違えていないか念のため確認する
  seriesList.forEach(s => { s.skus = dropSeriesNameSku(s.slug, s.skus); });
  console.log(`合計 ${seriesList.length} シリーズを処理します。`);

  const switches = [];
  const report = [];

  for (const s of seriesList) {
    console.log(`\n[${s.slug}] 型番: ${s.skus.join(", ") || "（一覧から拾えず）"}`);
    let indexHtml = "";
    let specHtml = "";
    try {
      indexHtml = await fetchText(s.url);
    } catch (e) {
      console.warn("  商品ページの取得に失敗:", e.message);
    }
    await sleep(REQUEST_INTERVAL_MS);
    try {
      specHtml = await fetchText(s.url.replace(/index\.htm$/, "") + "spec.htm");
    } catch (e) {
      console.warn("  仕様ページの取得に失敗:", e.message);
    }
    await sleep(REQUEST_INTERVAL_MS);

    // 一覧から型番が拾えなかった場合は、仕様表の見出し行から拾う
    if (s.skus.length === 0) {
      const prefix = s.slug.split("-")[0].toUpperCase();
      const t = nk(cleanText(specHtml));
      const found = new Set();
      let m;
      const re = new RegExp(SKU_RE.source, "g");
      while ((m = re.exec(t)) !== null) {
        if (m[1].split("-")[0] === prefix && !NOT_SKU_PREFIX.test(m[1]) && !isSeriesName(t, m.index + m[0].length)) found.add(m[1]);
      }
      s.skus = [...found];
      s.skus.forEach(sku => { s.models[sku] = { found: false }; });
    }
    if (s.skus.length === 0) {
      console.warn("  型番が特定できなかったため、このシリーズは飛ばします。");
      continue;
    }

    const indexText = bodyText(indexHtml);
    const specPageText = bodyText(specHtml);
    const title = extractTitle(indexHtml);
    const rowsBySku = specRowsByModel(specHtml, s.skus);
    const installBySku = decideInstall(rowsBySku, indexText + " " + specPageText);

    // 見出しから判定のヒントを作る
    const hints = {};
    s.headings.forEach(h => {
      HEADING_HINTS.forEach(hh => {
        if (hh.re.test(h)) {
          if (hh.speed && !hints.speed) hints.speed = hh.speed;
          if (hh.management) {
            const order = ["アンマネージ", "ライトマネージ", "L2インテリジェント"];
            if (!hints.management || order.indexOf(hh.management) > order.indexOf(hints.management)) {
              hints.management = hh.management;
            }
          }
        }
      });
    });

    const imageUrl = s.imageCandidates.find(Boolean) || extractOgImage(indexHtml);

    for (const sku of s.skus) {
      const rows = rowsBySku[sku] || [];
      const listInfo = s.models[sku] || {};
      const ex = extractModel({ sku, rows, title, indexText, specPageText, listInfo, hints });
      if (rows.length === 0) ex.warnings.unshift("仕様表の行が0件");

      const status = listInfo.status || lookupStatusInPage(indexText, sku) || "現行";
      const jan = lookupJan(indexText, sku) || lookupJan(specPageText, sku);

      const item = {
        id: sku.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        sku,
        series: s.slug,
        name: catchCopy(title) || title || sku,
        sourceUrl: s.url,
        imageUrl,
        status,
        priceIncTax: listInfo.priceIncTax ?? null,
        priceText: listInfo.priceIncTax != null ? null : (listInfo.priceText || "オープン価格"),
        jan,
        ports: ex.ports,
        speed: ex.speed,
        speedNote: ex.speedNote,
        sfp: ex.sfp,
        management: ex.management,
        poe: ex.poe,
        features: ex.features,
        featureNote: ex.featureNote,
        tempText: ex.tempText,
        tempMinC: ex.tempMinC,
        tempMaxC: ex.tempMaxC,
        fanless: ex.fanless,
        power: ex.power,
        install: installBySku[sku] || [],
        housing: ex.housing,
        warrantyYears: ex.warrantyYears,
        vcci: ex.vcci,
        usage: ex.vcci === "A" ? "法人向け" : ex.vcci === "B" ? "家庭・SOHO向け" : null,
        specDetails: ex.specDetails
      };
      switches.push(item);
      report.push({ item, warnings: ex.warnings });
    }
  }

  // 型番順に並べる（同じシリーズがまとまり、ポート数の少ない順になる）
  const speedOrder = { "100M": 0, "1G": 1, "2.5G": 2, "10G": 3 };
  switches.sort((a, b) =>
    (speedOrder[a.speed] ?? 9) - (speedOrder[b.speed] ?? 9) ||
    a.series.localeCompare(b.series) ||
    (a.ports ?? 0) - (b.ports ?? 0) ||
    a.sku.localeCompare(b.sku)
  );

  const output = {
    updatedAt: new Date().toISOString(),
    source: LIST_PAGES,
    switches
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  // 取得結果の確認用一覧
  console.log("\n==================== 取得結果 ====================");
  report.forEach(({ item, warnings }) => {
    const poe = item.poe ? `PoE(${item.poe.standards.join("/")}) ${item.poe.ports ?? "?"}ポート 計${item.poe.totalW ?? "?"}W` : "PoEなし";
    console.log(
      `${item.sku.padEnd(13)} ${item.status} | ${item.ports ?? "?"}ポート ${item.speed ?? "?"}` +
      `${item.sfp ? " +" + item.sfp.type + "×" + item.sfp.count : ""} | ${item.management} | ${poe}` +
      ` | ${item.tempMinC ?? "?"}〜${item.tempMaxC ?? "?"}℃ | ${item.fanless === true ? "ファンレス" : item.fanless === false ? "ファンあり" : "ファン?"}` +
      ` | ${item.power ?? "電源?"} | ${item.install.join("・") || "設置-"} | 保証${item.warrantyYears ?? "?"}年 | VCCI ${item.vcci ?? "?"}` +
      ` | ${item.priceIncTax != null ? "¥" + item.priceIncTax.toLocaleString() : item.priceText} | JAN ${item.jan ?? "-"}`
    );
    console.log(`    機能: ${item.features.join(" / ") || "-"}`);
    if (warnings.length) console.log(`    ⚠ 取れなかった項目: ${warnings.join(", ")}`);
  });
  const warnCount = report.filter(r => r.warnings.length).length;
  console.log(`\n${switches.length} 型番を data/switches.json に保存しました。` +
    (warnCount ? `（${warnCount} 型番で取れなかった項目あり）` : "（すべて取得できました）"));
}

// テスト用に関数を読み込んだときは実行しない
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
