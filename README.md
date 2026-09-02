# reds-watch

@REDSOFFICIAL の投稿を監視し、以下のいずれかに合致したツイートのURLを Discord に貼り付ける。

| 条件 | 判定 | 実例 |
|---|---|---|
| MATCH DAY | `♦️MATCH DAY♦️` | `♦️MATCH DAY♦️ 2026/27明治安田J1リーグ 第5節 vs 福岡` |
| スターティングメンバー | `〜戦 スターティングメンバー` | `♦️横浜FM戦 スターティングメンバー♦️` |

### 対象チーム

トップチームのみ。**天皇杯は対象**、**U-21・アカデミー・レディースは対象外**。

| 投稿 | 通知 | 理由 |
|---|---|---|
| `♦️MATCH DAY♦️ #天皇杯 2回戦 vs 山梨学院大学` | ⭕️ | トップチームの大会。前置きが無い |
| `♦️山梨学院大学戦 スターティングメンバー♦️` | ⭕️ | 同上 |
| `【再掲載】♦️FC東京戦 スターティングメンバー♦️` | ⭕️ | 再掲載もトップチーム |
| `【U-21】♦️MATCH DAY♦️` | ✕ | `【U-21】` を検出して除外 |
| レディース関連 | ✕ | `レディース` `WEリーグ` `皇后杯` で除外 |

レディースは現行書式では `♦️` 付きの投稿をしていないため実質ヒットしないが、
書式変更に備えて除外条件を入れてある。

### 除外される紛らわしい投稿

| 投稿 | 理由 |
|---|---|
| グッズ告知「人気のスターティングメンバー写真を使用したアクリルスタンド」 | `戦` の直後を必須にしているため |
| 選手紹介「川崎フロンターレ戦で今季、初先発」 | 同上 |
| MATCH DAY を引用リツイートしただけの投稿 | 判定を `title` のみに限定しているため |

## セットアップ

1. **このリポジトリを GitHub に Public で作る**（Actions の実行時間が無制限になる）

2. **Discord Webhook を作る**
   投稿したいチャンネル → 編集 → 連携サービス → ウェブフック → 新しいウェブフック → URLをコピー

3. **GitHubに登録**
   - Settings → Secrets and variables → Actions → Secrets
     - `DISCORD_WEBHOOK_URL` … 2でコピーしたURL
   **Variables は登録不要。** 既定値が `check.mjs` に入っているため、
   `DISCORD_WEBHOOK_URL` だけ登録すれば動く。

   既定値を変えたくなったときだけ、Settings → Secrets and variables → Actions → Variables に登録する。

   | Name | Value に入れるもの | 既定値 |
   |---|---|---|
   | `NITTER_INSTANCES` | インスタンスURLをカンマ区切り。`https://` を含め、末尾スラッシュ無し。<br>例: `https://nitter.perennialte.ch,https://lightbrd.com` | `https://nitter.perennialte.ch,https://nitter.tiekoetter.com,https://lightbrd.com,https://nitter.space` |
   | `LINK_DOMAIN` | `fxtwitter.com` または `x.com` のいずれか。ドメイン名のみ（`https://` は不要） | `fxtwitter.com` |

   `LINK_DOMAIN` は投稿されるURLの見た目が変わるだけ。
   - `fxtwitter.com` … Discordに本文と画像のプレビューが出る
   - `x.com` … 素のURL。Discord側でプレビューが出ないことが多い

4. **初回だけ既読を作る**（過去分が一気に流れるのを防ぐ）
   ```bash
   BOOTSTRAP=1 node check.mjs
   git add state.json && git commit -m "chore: bootstrap" && git push
   ```

5. Actions タブ → watch-reds → Run workflow で動作確認

## ローカルでの確認

```bash
DRY_RUN=1 node check.mjs                     # 現在のフィードで判定だけ実行
DRY_RUN=1 FEED_FILE=./sample.xml node check.mjs   # 保存済みRSSで判定ロジックを検証
```

## インスタンスが死んだとき

このプロジェクトで唯一壊れやすいのが Nitter インスタンス。
失敗すると Discord に通知が飛ぶので、生きているものを探して `NITTER_INSTANCES` を差し替える。

```bash
for h in nitter.perennialte.ch nitter.tiekoetter.com lightbrd.com nitter.space nitter.privacydev.net; do
  echo "$h $(curl -sSL -m 15 -A 'Mozilla/5.0' "https://$h/REDSOFFICIAL/rss" | grep -c '<item>')"
done
```

`<item>` の数が20前後なら生きている。0なら死んでいる。

## 検知条件を変えるとき

`check.mjs` の `PATTERNS` を編集する。


---

# 低遅延版：Cloudflare Workers（`worker/`）

GitHub Actions のスケジュール実行は待ち行列に入るため、cron を5分にしても実効遅延が
7〜25分ほど残る。Cloudflare の Cron Triggers は1分間隔が指定でき、ほぼ定刻に発火するため
実効遅延が1〜2分になる。判定ロジックは `check.mjs` と同一。

## 無料枠と実使用量（1分間隔＝1日1,440回）

| 項目 | 無料枠 | 実使用 |
|---|---|---|
| リクエスト数 | 100,000/日 | 1,440/日 |
| CPU時間 | 10ms/回 | 実測 0.113ms |
| Cron Triggers | 5個 | 1個 |
| KV 読み取り | 100,000/日 | 1,440/日 |
| KV 書き込み | **1,000/日** | 約20/日 |

KV の書き込みだけ枠が厳しいため、**フィードに変化があったときだけ書く**設計にしてある
(`changed` フラグ)。毎回書くと 1,440回/日 で枠を超える。

無料プランは上限を超えても課金されず、その日の残り時間の操作がエラーになるだけ。
課金は Workers Paid（$5/月〜）に自分で明示的にアップグレードした場合のみ発生する。

## 動作確認用エンドポイントの出し入れ

`wrangler.toml` の `workers_dev` は既定で `false`（cron専用）。
公開URLがあると認証なしで叩けてしまい、1日10万リクエストの枠を消費させられるため。

判定結果をブラウザで見たいときだけ `true` に戻して `deploy` し、確認後また `false` に戻す。

## タイムアウト設計

インスタンスは**直列**に試すため、最悪ケースは `FETCH_TIMEOUT_MS × 登録数`。
これが cron 周期(60秒)を超えると実行が重なり、両方が古い既読リストを読みうる。

| | 値 |
|---|---|
| 実測の応答時間 | 0.17〜0.20 秒 |
| タイムアウト | 8 秒 |
| 最悪ケース | 8秒 × 4件 = **32秒**（60秒に収まる） |

インスタンスを5件以上に増やすときは、`FETCH_TIMEOUT_MS × 件数 < 60秒` を守ること。

## 障害通知

Nitter が全滅して取得に失敗すると、Discord に通知が飛ぶ。復旧したら復旧通知が1回飛ぶ。

障害が続くと毎分失敗するため、**同じ障害の通知は6時間に1回まで**に間引いている
(`ALERT_COOLDOWN_MS`)。これが無いと1日1,440回鳴る。

平常時は KV への追加書き込みが発生しない（障害状態のキーが無いため読むだけ）。

```
⚠️ reds-watch が停止しています
全インスタンス失敗: …
Nitter インスタンスが全滅した可能性があります。…

✅ reds-watch が復旧しました（約42分間停止していました）
```

## デプロイ手順

```bash
cd worker

# 1. Cloudflare にログイン（ブラウザが開く。アカウントは無料・カード不要）
npx wrangler login

# 2. 状態保存用の KV を作成し、出力された id を wrangler.toml に貼る
npx wrangler kv namespace create STATE

# 3. Webhook URL を登録（コードには含めない）
npx wrangler secret put DISCORD_WEBHOOK_URL

# 4. DRY_RUN="1" のままデプロイして動作確認
npx wrangler deploy
npx wrangler tail          # ログを見る。1分ごとに走査ログが出る
```

`wrangler deploy` が表示する `*.workers.dev` の URL を開くと、
**Discordに投稿せず**「いま投稿するとしたら何か」を JSON で確認できる。

## GitHub Actions からの切り替え

両方を同時に動かすと二重投稿になるので、必ずこの順番で行う。

1. `.github/workflows/watch.yml` の `schedule:` をコメントアウトして push
2. `worker/wrangler.toml` の `DRY_RUN` を `"0"` に変更
3. `npx wrangler deploy`

Worker は KV が空の初回起動時、**記録だけして投稿しない**（過去分が一気に流れるのを防ぐ）。
そのため切り替え直後に取りこぼしが出ないよう、試合前後を避けて作業する。

## ローカル検証

```bash
cd worker && node test-local.mjs
```

KV と Discord をメモリ上のモックに差し替え、実フィードに対して7パターンを確認する。

| # | 状況 | 期待する挙動 |
|---|---|---|
| 1 | KV空（初回起動） | 記録のみ。投稿しない |
| 2 | 変化なし | KV書込0回 |
| 3 | 全インスタンス失敗 | 障害通知1件 |
| 4-5 | 障害継続 | 通知しない（クールダウン中） |
| 6 | 復旧 | 復旧通知1件。障害状態を削除 |
| 7 | 平常 | 何も起きない |
