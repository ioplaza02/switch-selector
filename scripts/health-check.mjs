// スクレイピング結果の健全性チェック
//
// 次の2点を確認する。
// 1. 「前回のdata/switches.jsonの型番数」と「今回スクレイピングした直後の型番数」を
//    比較して、大きく減っていないか（＝スクレイパーが壊れている兆候ではないか）
// 2. 型番数は同じでも、ポート数・通信速度・動作温度といった基本項目が
//    多くの型番で空になっていないか（＝ページ構造が変わって中身が取れなくなった兆候）
//
// 問題が無ければ終了コード0（正常終了）、
// 問題があれば終了コード1（異常終了）を返す。
// ワークフロー側はこの終了コードを見て、自動反映するかPRを作るかを分岐する。

import fs from "node:fs";

const OLD_PATH = "data/switches.previous.json";
const NEW_PATH = "data/switches.json";

// 「前回より何割減ったら異常とみなすか」の閾値。まずは1割に設定。
// スイッチは機種数が少ないため、2機種以上まとめて消えたら知らせる程度の感度になります。
const DROP_THRESHOLD = 0.1;

// 基本項目が空の型番が、全体の何割を超えたら異常とみなすか
const MISSING_THRESHOLD = 0.3;
const REQUIRED_FIELDS = ["ports", "speed", "tempMaxC", "warrantyYears"];

function loadSwitches(path) {
  if (!fs.existsSync(path)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(path, "utf8"));
    return Array.isArray(json.switches) ? json.switches : null;
  } catch (e) {
    return null;
  }
}

const oldList = loadSwitches(OLD_PATH);
const newList = loadSwitches(NEW_PATH);
const oldCount = oldList ? oldList.length : null;
const newCount = newList ? newList.length : null;

console.log(`前回の型番数: ${oldCount ?? "不明（初回実行など）"}`);
console.log(`今回の型番数: ${newCount ?? "不明（読み込み失敗）"}`);

// 新しいデータが空、または壊れていて読めない場合は問答無用で異常
if (newCount === null || newCount === 0) {
  console.error("異常あり: 新しいデータが空か、正しく読み込めませんでした。");
  process.exit(1);
}

// 前回データと比較できる場合は、減少率をチェック
if (oldCount !== null && oldCount > 0) {
  const dropRatio = (oldCount - newCount) / oldCount;
  if (dropRatio > DROP_THRESHOLD) {
    const newSkus = new Set(newList.map(s => s.sku));
    const lost = oldList.filter(s => !newSkus.has(s.sku)).map(s => s.sku);
    console.error(
      `異常あり: 型番数が前回より${Math.round(dropRatio * 100)}%減少しています` +
      `（${oldCount}件 → ${newCount}件）。消えた型番: ${lost.join(", ")}`
    );
    process.exit(1);
  }
}

// 基本項目の欠け具合をチェック
for (const field of REQUIRED_FIELDS) {
  const missing = newList.filter(s => s[field] === null || s[field] === undefined);
  if (missing.length / newList.length > MISSING_THRESHOLD) {
    console.error(
      `異常あり: 「${field}」が取れていない型番が ${missing.length}/${newList.length} 件あります` +
      `（${missing.map(s => s.sku).join(", ")}）。ページ構造が変わった可能性があります。`
    );
    process.exit(1);
  }
}

console.log("健全性チェック: 問題ありませんでした。");
process.exit(0);
