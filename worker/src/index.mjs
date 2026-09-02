// @REDSOFFICIAL の投稿を1分ごとに巡回し、条件に合致したツイートのURLを Discord に投稿する。
//
// 判定ロジックは GitHub Actions 版（../check.mjs）と同一。実データ60件で検証済み。
// 状態は Workers KV に持つが、無料枠の書き込み上限が 1,000回/日 と厳しいため
// 「フィードに変化があったときだけ書く」設計にしている（実際は1日20回程度）。

const ACCOUNT = 'REDSOFFICIAL';
const KV_KEY  = 'seen';
const ALERT_KEY = 'alert';    // 障害通知の状態
const KEEP    = 120;          // 記憶しておく既読ツイートID数

// 障害が続く間、Discordを鳴らし続けないための間引き間隔。
// Nitterが全滅すると毎分失敗するため、これが無いと1日1,440回通知が飛ぶ。
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// インスタンスは直列に試すため、最悪ケースは この値 × 登録数 になる。
// cron周期(60秒)を超えると実行が重なり、両方が古い既読リストを読みうる。
// 4件登録で 8秒 × 4 = 32秒。通常の応答は 0.3秒 程度なので余裕は十分にある。
const FETCH_TIMEOUT_MS = 8_000;

// --- 検知条件（実投稿の書式を 2026/08〜09 の実データで確認済み） ----------------
//   ♦️MATCH DAY♦️
//   ♦️横浜FM戦 スターティングメンバー♦️
// ♦️ は U+2666 + U+FE0F（異体字セレクタ）。FE0F は任意扱い。
const PATTERNS = [
  { name: 'MATCH DAY',        re: /♦️?\s*MATCH\s*DAY\s*♦/i },
  // 「戦」の直後を必須にして、グッズ告知の「人気のスターティングメンバー写真」を除外する
  { name: 'スターティングメンバー', re: /戦\s*スターティングメンバー/ },
];

// トップチームのみ対象。天皇杯は前置きが無いため、ここには含めない（＝通知対象）。
const EXCLUDES = [
  { name: 'U-21/アカデミー', re: /【\s*[UＵ]-?\d+\s*】|[UＵ]-\d{2}(?=[^\d])/ },
  { name: 'レディース',      re: /レディース|WEリーグ|皇后杯/ },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// --- RSS パース --------------------------------------------------------------
const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&amp;/g, '&');

function pick(block, tag) {
  const m = block.match(
    new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`)
  );
  return m ? unescapeXml(m[1]).trim() : '';
}

function parse(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const link  = pick(block, 'link');
    const title = pick(block, 'title');
    return {
      id: link.match(/\/status\/(\d+)/)?.[1] ?? null,
      // Nitter はピン留めに "Pinned: "、RTに "RT by @xxx: " を前置する
      text: title.replace(/^(Pinned:|RT by @[\w]+:)\s*/, ''),
      isRetweet: /^RT by @/.test(title),
      isOwn: new RegExp(`/${ACCOUNT}/status/`, 'i').test(link),
    };
  });
}

function instances(env) {
  return (env.NITTER_INSTANCES ||
    'https://nitter.perennialte.ch,https://nitter.tiekoetter.com,https://lightbrd.com,https://nitter.space'
  ).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

async function fetchFeed(env) {
  const errors = [];
  for (const base of instances(env)) {
    const url = `${base}/${ACCOUNT}/rss`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parse(await res.text());
      if (items.length === 0) throw new Error('item が0件（インスタンス側の異常）');
      return { items, source: url };
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(`全インスタンス失敗: ${errors.join(' / ')}`);
}

// --- 判定（KVの読み取りまで。書き込みと投稿は呼び出し側の責務） -----------------
async function evaluate(env) {
  const { items, source } = await fetchFeed(env);
  const seen = (await env.STATE.get(KV_KEY, 'json')) ?? [];

  const hits = items
    .filter((i) => i.id && i.isOwn && !i.isRetweet)
    .map((i) => ({
      ...i,
      hit:     PATTERNS.find((p) => p.re.test(i.text)),
      exclude: EXCLUDES.find((p) => p.re.test(i.text)),
    }))
    .filter((i) => i.hit && !i.exclude && !seen.includes(i.id))
    .reverse();                                   // 古い順に投稿する

  const ids  = items.map((i) => i.id).filter(Boolean);
  const next = [...new Set([...ids, ...seen])].slice(0, KEEP);

  return {
    items, source, seen, hits, next,
    // KVが空＝初回起動。過去分が一気に流れるのを防ぐため、記録だけして投稿しない
    bootstrap: seen.length === 0,
    changed: next.length !== seen.length || next.some((v, i) => v !== seen[i]),
  };
}

const tweetUrl = (env, id) =>
  `https://${env.LINK_DOMAIN || 'fxtwitter.com'}/${ACCOUNT}/status/${id}`;

async function postToDiscord(env, content) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const wait = ((await res.json().catch(() => ({}))).retry_after ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Discord投稿失敗 ${res.status}: ${await res.text()}`);
  }
  throw new Error('Discord投稿失敗: レート制限が解除されませんでした');
}

// --- 障害通知 ----------------------------------------------------------------
// 失敗が続いても通知は間引き、復旧したら1回だけ知らせる。
// 通知自体が失敗しても本来のエラーを握り潰さないよう、送信は try/catch で囲む。
async function notifyFailure(env, error, dry) {
  const now = Date.now();
  const prev = await env.STATE.get(ALERT_KEY, 'json');
  if (prev && now - prev.notifiedAt < ALERT_COOLDOWN_MS) return;   // 通知済み。KVも書かない
  if (dry) return;

  try {
    await postToDiscord(env,
      `⚠️ **reds-watch が停止しています**\n\`${error.message}\`\n` +
      'Nitter インスタンスが全滅した可能性があります。' +
      'wrangler.toml の NITTER_INSTANCES を生きているものに差し替えてください。');
  } catch (e) {
    console.log(`障害通知の送信に失敗: ${e.message}`);
  }
  await env.STATE.put(ALERT_KEY, JSON.stringify({ notifiedAt: now, since: prev?.since ?? now }));
}

async function notifyRecovery(env, dry) {
  const prev = await env.STATE.get(ALERT_KEY, 'json');
  if (!prev || dry) return;                                        // 平常時は書き込み0回

  const minutes = Math.round((Date.now() - prev.since) / 60_000);
  try {
    await postToDiscord(env, `✅ reds-watch が復旧しました（約${minutes}分間停止していました）`);
  } catch (e) {
    console.log(`復旧通知の送信に失敗: ${e.message}`);
  }
  await env.STATE.delete(ALERT_KEY);
}

export default {
  // 1分ごとの巡回本体
  async scheduled(event, env, ctx) {
    const dry = env.DRY_RUN === '1';

    let r;
    try {
      r = await evaluate(env);
    } catch (e) {
      await notifyFailure(env, e, dry);
      throw e;                        // Cloudflare 側のエラー計上とログは残す
    }
    await notifyRecovery(env, dry);

    if (!r.bootstrap && !dry) {
      for (const i of r.hits) await postToDiscord(env, tweetUrl(env, i.id));
    }

    // 変化があったときだけ書く。毎回書くと 1,440回/日 で無料枠(1,000)を超える。
    if (r.changed) await env.STATE.put(KV_KEY, JSON.stringify(r.next));

    const mode = r.bootstrap ? '[初回・記録のみ] ' : dry ? '[DRY RUN] ' : '';
    console.log(
      `${mode}走査 ${r.items.length}件 / 該当 ${r.hits.length}件 / KV書込 ${r.changed ? 'あり' : 'なし'} / ${r.source}`
    );
    for (const i of r.hits) console.log(`  [${i.hit.name}] ${tweetUrl(env, i.id)}`);
  },

  // 動作確認用のHTTPエンドポイント。
  // 誰でも叩ける状態でもDiscordを鳴らさないよう、常にドライランでKVも書き換えない。
  async fetch(request, env) {
    try {
      const r = await evaluate(env);
      return Response.json({
        dryRun: true,
        source: r.source,
        scanned: r.items.length,
        bootstrap: r.bootstrap,
        wouldPost: r.hits.map((i) => ({ pattern: i.hit.name, url: tweetUrl(env, i.id), text: i.text.split('\n')[0] })),
        seenCount: r.seen.length,
      }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
