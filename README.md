# スイッチセレクター（試作）

I-O DATA製スイッチングハブ（家庭用・法人用）を、条件で絞り込んで比較できるツールです。
NASセレクター／ISSセレクター／DASセレクターと同じ仕組み（GitHub Pages＋毎日の自動データ更新）で動きます。

- 公開URL（Pages有効化後）：`https://ioplaza02.github.io/<リポジトリ名>/`
- パスワード：`app.js` の `SITE_PASSWORD`（初期値 `switch2026`）

## 構成

```
index.html                    画面本体
style.css
app.js                        絞り込み・カード表示・比較ポップアップ・パスワード
data/switches.json            商品データ（1型番＝1件）
scripts/scrape.mjs            公式サイトからデータを集めるスクレイパー
scripts/health-check.mjs      取得結果の健全性チェック
.github/workflows/scrape.yml  毎日 深夜3:00（日本時間）の自動実行
```

## データの集め方

1. 一覧ページ（`/product/lan/hub/`・`/switch/`・`/poe/`）から、シリーズのページと型番・価格・
   生産終了アイコン・見出し（「10Gigabit対応」「ライトマネージ」など）を拾う
2. シリーズごとに `index.htm`（商品ページ）と `spec.htm`（仕様表）を取得
3. 仕様表を型番ごとの列に分解し、ポート数・速度・PoE・機能・動作温度・保証などを取り出す
4. `data/switches.json` に保存

リクエストは並列にせず1件ずつ2秒間隔、専用User-Agent（SwitchSelectorBot/1.0）を使います。
PoEインジェクター（BINJ-）はスイッチではないため対象外です。

## 手動でデータを更新する

```
node scripts/scrape.mjs
```

最後に型番ごとの取得結果と「取れなかった項目」の一覧が表示されます。

## 自動更新

毎日 深夜3:00（日本時間）にスクレイパーが動き、健全性チェック
（型番数が1割以上減っていないか／基本項目が3割以上の型番で空になっていないか）に
問題が無ければそのまま反映します。異常時は本番に反映せず、PRとIssueを作って知らせます。
