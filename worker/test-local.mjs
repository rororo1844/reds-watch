// Worker のロジックをローカル検証する。KVとDiscordはメモリ上のモックに差し替える。
// 実行: node test-local.mjs
import worker from './src/index.mjs';

const LIVE = 'https://nitter.perennialte.ch';
const DEAD = 'https://nitter-does-not-exist.invalid';

const store = new Map();
let kvWrites = 0, kvDeletes = 0;
const posted = [];

const env = {
  STATE: {
    get: async (k, type) => {
      const v = store.get(k);
      return v == null ? null : (type === 'json' ? JSON.parse(v) : v);
    },
    put: async (k, v) => { kvWrites++; store.set(k, v); },
    delete: async (k) => { kvDeletes++; store.delete(k); },
  },
  DRY_RUN: '0',
  LINK_DOMAIN: 'fxtwitter.com',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/MOCK',
  NITTER_INSTANCES: LIVE,
};

// Discordへの送信だけ横取りし、RSS取得は本物を通す
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('discord.com')) {
    posted.push(JSON.parse(init.body).content);
    return new Response(null, { status: 204 });
  }
  return realFetch(url, init);
};

const step = async (label) => {
  const w = kvWrites, d = kvDeletes, n = posted.length;
  console.log(label);
  try {
    await worker.scheduled({}, env, {});
  } catch (e) {
    console.log(`   (例外が投げられた: ${e.message.slice(0, 48)}…)`);
  }
  console.log(`   → KV書込 ${kvWrites - w} / KV削除 ${kvDeletes - d} / Discord投稿 ${posted.length - n}件\n`);
};

console.log('════ 通常時 ════\n');
await step('■ 1回目（KV空 = 初回起動。記録のみで投稿しないはず）');
await step('■ 2回目（変化なし。KV書込0回になるはず ← 無料枠の前提）');

console.log('════ 障害発生 ════\n');
env.NITTER_INSTANCES = DEAD;
await step('■ 3回目（全インスタンス失敗。障害通知が1件飛ぶはず）');
await step('■ 4回目（障害継続。6時間のクールダウン中なので通知しないはず）');
await step('■ 5回目（同上。連投しないことの確認）');

console.log('════ 復旧 ════\n');
env.NITTER_INSTANCES = LIVE;
await step('■ 6回目（復旧。復旧通知が1件飛び、障害状態が消えるはず）');
await step('■ 7回目（平常運転に戻る。何も起きないはず）');

console.log('─────────────────────────────');
console.log('Discordに送られた内容:');
posted.forEach((p, i) => console.log(`  ${i + 1}. ${p.replace(/\n/g, ' / ').slice(0, 110)}`));
console.log(`\nKV書込 ${kvWrites}回 / KV削除 ${kvDeletes}回 / 7回実行`);
