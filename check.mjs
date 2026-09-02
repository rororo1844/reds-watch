// @REDSOFFICIAL の投稿を監視し、条件に合致したツイートのURLを Discord に投稿する。
// 実行: node check.mjs        （通常）
//       DRY_RUN=1 node check.mjs   （Discordに投げず、判定結果だけ表示）
//       BOOTSTRAP=1 node check.mjs （投稿せず既読だけ記録。初回はこれを1度実行する）
import fs from 'node:fs/promises';

const ACCOUNT = 'REDSOFFICIAL';
const STATE   = 'state.json';
const KEEP    = 120;                       // 記憶しておく既読ツイートID数
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DRY_RUN   = !!process.env.DRY_RUN;
const BOOTSTRAP = !!process.env.BOOTSTRAP;

// Discordの埋め込み（本文・画像プレビュー）が出るドメイン。
// 素の x.com はプレビューが出ないことが多いため fxtwitter を既定にしている。
const LINK_DOMAIN = process.env.LINK_DOMAIN || 'fxtwitter.com';

// 稼働中インスタンスは頻繁に入れ替わるため、上から順に試す。
const INSTANCES = (process.env.NITTER_INSTANCES ||
  'https://nitter.perennialte.ch,https://nitter.tiekoetter.com,https://lightbrd.com,https://nitter.space'
).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// --- 検知条件 ---------------------------------------------------------------
// 実投稿の書式（2026/08〜09 に実データで確認）:
//   ♦️MATCH DAY♦️
//   ♦️横浜FM戦 スターティングメンバー♦️
//   【U-21】♦️U-21清水戦 スターティングメンバー♦️
// ♦️ は U+2666 + U+FE0F（異体字セレクタ）。念のため FE0F は任意扱いにしている。
const PATTERNS = [
  { name: 'MATCH DAY',        re: /♦️?\s*MATCH\s*DAY\s*♦/i },
  // 「戦」直後を必須にして、グッズ告知の「人気のスターティングメンバー写真」を除外する
  { name: 'スターティングメンバー', re: /戦\s*スターティングメンバー/ },
];

// トップチームのみを対象にする。合致した投稿はキーワードが入っていても通知しない。
// ・U-21 / アカデミーは必ず「【U-21】」が前置される（実データで確認）
// ・レディースは現行書式では ♦️ 付きの投稿をしていないが、将来の書式変更に備えて除外しておく
// ・天皇杯はトップチームの大会で前置きが無いため、ここには含めない（＝通知対象）
const EXCLUDES = [
  { name: 'U-21/アカデミー', re: /【\s*[UＵ]-?\d+\s*】|[UＵ]-\d{2}(?=[^\d])/ },
  { name: 'レディース',      re: /レディース|WEリーグ|皇后杯/ },
];

// --- ユーティリティ ---------------------------------------------------------
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
    const link = pick(block, 'link');
    return {
      id:   link.match(/\/status\/(\d+)/)?.[1] ?? null,
      // Nitter はピン留めに "Pinned: "、RTに "RT by @xxx: " を前置する
      text: pick(block, 'title').replace(/^(Pinned:|RT by @[\w]+:)\s*/, ''),
      isRetweet: /^RT by @/.test(pick(block, 'title')),
      // RTは元アカウントのパスになるので、自アカウントの投稿かどうかの判定に使う
      isOwn: new RegExp(`/${ACCOUNT}/status/`, 'i').test(link),
      date: pick(block, 'pubDate'),
    };
  });
}

async function fetchFeed() {
  // 保存済みRSSでの動作確認用（判定ロジックの回帰テストに使う）
  if (process.env.FEED_FILE) {
    const items = parse(await fs.readFile(process.env.FEED_FILE, 'utf8'));
    console.log(`フィード読込: ${process.env.FEED_FILE} (${items.length}件)`);
    return items;
  }

  const errors = [];
  for (const base of INSTANCES) {
    const url = `${base}/${ACCOUNT}/rss`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parse(xml);
      if (items.length === 0) throw new Error('item が0件（インスタンス側の異常）');
      console.log(`フィード取得: ${url} (${items.length}件)`);
      return items;
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(`全インスタンス失敗\n  ${errors.join('\n  ')}`);
}

async function postToDiscord(content) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (res.ok) return;
    if (res.status === 429) {                       // Webhookのレート制限
      const wait = ((await res.json().catch(() => ({}))).retry_after ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Discord投稿失敗 ${res.status}: ${await res.text()}`);
  }
  throw new Error('Discord投稿失敗: レート制限が解除されませんでした');
}

// --- 本体 -------------------------------------------------------------------
const items = await fetchFeed();

const seen = await fs.readFile(STATE, 'utf8')
  .then(JSON.parse).then((s) => s.seen ?? []).catch(() => []);

const hits = items
  .filter((i) => i.id && i.isOwn && !i.isRetweet)
  // 判定は title（＝そのツイート本文の全文）のみで行う。
  // description には引用元ツイートが blockquote で埋め込まれるため、
  // MATCH DAY を引用しただけの投稿まで誤ヒットする。
  .map((i) => ({
    ...i,
    hit:     PATTERNS.find((p) => p.re.test(i.text)),
    exclude: EXCLUDES.find((p) => p.re.test(i.text)),
  }))
  .filter((i) => i.hit && !i.exclude && !seen.includes(i.id))
  .reverse();                                        // 古い順に投稿する

for (const i of hits) {
  const url = `https://${LINK_DOMAIN}/${ACCOUNT}/status/${i.id}`;
  console.log(`[${i.hit.name}] ${url}  ${i.text.split('\n')[0].slice(0, 40)}`);
  if (DRY_RUN || BOOTSTRAP) continue;
  await postToDiscord(url);
  await new Promise((r) => setTimeout(r, 1200));
}

// キーワード不一致の投稿も既読に含める（次回の走査対象から外すため）
const nextSeen = [...new Set([...items.map((i) => i.id).filter(Boolean), ...seen])].slice(0, KEEP);
if (!DRY_RUN) await fs.writeFile(STATE, `${JSON.stringify({ seen: nextSeen }, null, 2)}\n`);

const mode = DRY_RUN ? '[DRY RUN] ' : BOOTSTRAP ? '[BOOTSTRAP] ' : '';
console.log(`${mode}走査 ${items.length}件 / 該当 ${hits.length}件 / 既読 ${nextSeen.length}件`);
