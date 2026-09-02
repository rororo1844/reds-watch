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
