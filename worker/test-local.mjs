// Worker のロジックをローカル検証する。KVとDiscordはメモリ上のモックに差し替える。
// 実行: node test-local.mjs
import worker from './src/index.mjs';

const store = new Map();
let kvWrites = 0;
const posted = [];

const env = {
  STATE: {
    get: async (k, type) => {
      const v = store.get(k);
      return v == null ? null : (type === 'json' ? JSON.parse(v) : v);
    },
    put: async (k, v) => { kvWrites++; store.set(k, v); },
  },
  DRY_RUN: '0',
  LINK_DOMAIN: 'fxtwitter.com',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/MOCK',
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
  const before = kvWrites, n = posted.length;
  await worker.scheduled({}, env, {});
  console.log(`   → KV書込 ${kvWrites - before}回 / Discord投稿 ${posted.length - n}件\n`);
};

console.log('■ 1回目（KV空 = 初回起動。記録のみで投稿しないはず）');
await step();

console.log('■ 2回目（フィード変化なし。KV書込0回になるはず ← 無料枠の前提）');
await step();

console.log('■ 3回目（同上）');
await step();

console.log('■ 4回目（既読から MATCH DAY を1件消して「新着」を再現。投稿されるはず）');
const seen = JSON.parse(store.get('seen'));
store.set('seen', JSON.stringify(seen.filter((id) => id !== '2094938357495423417')));
await step();

console.log('■ 5回目（投稿済みなので再投稿されないはず）');
await step();

console.log('─────────────────────────────');
console.log('Discordに投稿された内容:', posted);
console.log('KV書き込み総数:', kvWrites, '回 / 5回実行');
