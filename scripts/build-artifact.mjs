// vite build の出力（dist/）を1つのHTMLにまとめる。claude.ai の非公開ページ（Artifact）として公開する用。
// 使い方: npm run build && node scripts/build-artifact.mjs [出力先] [--no-images]
// --no-images：カード画像・裏面画像を入れない（友達に共有する用。画像は各自が「画像を設定」で入れる）
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const args = process.argv.slice(2);
const noImages = args.includes('--no-images');
const out = args.find((a) => !a.startsWith('--')) ?? join(dist, 'artifact.html');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const asset = (src) => readFileSync(join(dist, src.replace(/^\.\//, '')), 'utf8');
const scripts = [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)].map((m) =>
  asset(m[1]),
);
const styles = [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)].map((m) => asset(m[1]));
if (scripts.length !== 1 || styles.length !== 1) throw new Error('dist/index.html の形式が想定と違います');

// 自分専用（画像入り）と共有版（画像なし）を、タブ・ギャラリー・メニュー画面の名前で見分けられるようにする
const edition = noImages ? '共有版' : '自分専用';
const title = `<title>遊戯王 一人回しシミュレーター（${edition}）</title>`;
const editionScript = `<script>window.__PAGE_EDITION__=${JSON.stringify(edition)}</script>`;

// カードの裏面画像（private/ は公開リポジトリに入れないフォルダ。あれば非公開ページにだけ埋め込む）
const backPath = 'private/card-back.jpg';
const backCss =
  !noImages && existsSync(backPath)
    ? `.f-back{background:#2b1a0c url(data:image/jpeg;base64,${readFileSync(backPath).toString('base64')}) center/cover no-repeat}`
    : '';
// カード画像（private/cards/<カードID>.jpg）。非公開ページにだけ埋め込み、アプリの初期画像として使う
const cardsDir = 'private/cards';
const cardImages =
  !noImages && existsSync(cardsDir)
    ? Object.fromEntries(
        readdirSync(cardsDir)
          .filter((f) => f.endsWith('.jpg'))
          .map((f) => [
            f.replace(/\.jpg$/, ''),
            `data:image/jpeg;base64,${readFileSync(join(cardsDir, f)).toString('base64')}`,
          ]),
      )
    : {};
// 裏面の画像も、データの書き出しで別のページに移せるように渡しておく
const backDataUrl =
  !noImages && existsSync(backPath) ? `data:image/jpeg;base64,${readFileSync(backPath).toString('base64')}` : '';
const cardImagesScript =
  Object.keys(cardImages).length || backDataUrl
    ? `<script>window.__BUILTIN_CARD_IMAGES__=${JSON.stringify(cardImages)};window.__BUILTIN_CARD_BACK__=${JSON.stringify(backDataUrl || undefined)}</script>`
    : '';

// インラインの <script> を途中で閉じないようにする。
// また、埋め込んだワーカー（base64の長い文字列）を代入する変数名が、圧縮で「Id」などになると
// HTMLの属性（id="…"）と見分けがつかず公開時のチェックで弾かれるので、"" と連結して属性の形にしない
const js = scripts[0]
  .replaceAll('</script', '<\\/script')
  .replace(/([A-Za-z0-9_$])="([A-Za-z0-9+/]{200,}={0,2})"/g, '$1=""+"$2"');

writeFileSync(
  out,
  `${title}
<meta name="claude:viewport-fit-sides" content="cover">
<style>${styles[0]}${backCss}</style>
${editionScript}
${cardImagesScript}
<div id="root"></div>
<script type="module">${js}</script>
`,
);
console.log(`${out} を出力しました`);
