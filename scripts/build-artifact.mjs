// vite build の出力（dist/）を1つのHTMLにまとめる。claude.ai の非公開ページ（Artifact）として公開する用。
// 使い方: npm run build && node scripts/build-artifact.mjs [出力先]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const out = process.argv[2] ?? join(dist, 'artifact.html');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const asset = (src) => readFileSync(join(dist, src.replace(/^\.\//, '')), 'utf8');
const scripts = [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)].map((m) => asset(m[1]));
const styles = [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)].map((m) => asset(m[1]));
if (scripts.length !== 1 || styles.length !== 1) throw new Error('dist/index.html の形式が想定と違います');

const title = html.match(/<title>.*<\/title>/)[0];

// カードの裏面画像（private/ は公開リポジトリに入れないフォルダ。あれば非公開ページにだけ埋め込む）
const backPath = 'private/card-back.jpg';
const backCss = existsSync(backPath)
  ? `.f-back{background:#2b1a0c url(data:image/jpeg;base64,${readFileSync(backPath).toString('base64')}) center/cover no-repeat}`
  : '';
// カード画像（private/cards/<カードID>.jpg）。非公開ページにだけ埋め込み、アプリの初期画像として使う
const cardsDir = 'private/cards';
const cardImages = existsSync(cardsDir)
  ? Object.fromEntries(
      readdirSync(cardsDir)
        .filter((f) => f.endsWith('.jpg'))
        .map((f) => [f.replace(/\.jpg$/, ''), `data:image/jpeg;base64,${readFileSync(join(cardsDir, f)).toString('base64')}`]),
    )
  : {};
const cardImagesScript = Object.keys(cardImages).length
  ? `<script>window.__BUILTIN_CARD_IMAGES__=${JSON.stringify(cardImages)}</script>`
  : '';

// インラインの <script> を途中で閉じないようにする
const js = scripts[0].replaceAll('</script', '<\\/script');

writeFileSync(
  out,
  `${title}
<meta name="claude:viewport-fit-sides" content="cover">
<style>${styles[0]}${backCss}</style>
${cardImagesScript}
<div id="root"></div>
<script type="module">${js}</script>
`,
);
console.log(`${out} を出力しました`);
