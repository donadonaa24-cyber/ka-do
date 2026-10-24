# 引き継ぎ書（AIエージェント向け）

遊戯王の一人回しシミュレーター。このファイルは、Codex・Claude などのAIエージェントが作業を引き継ぐための説明です。
作業を始める前に最後まで読んでください。オーナーへの報告は**日本語で、簡潔に要点をまとめて**ください。

## 1. 目的と方針（最優先）

- 目的は「**トゥーンデッキ（と自分の他のデッキ）の回し方を覚えるための練習ツール**」。遊戯王の完全な再現（マスターデュエルの模造品）ではない。
- オーナーが力を入れているのは、自分のオリジナル作品の制作。このシミュレーターには、必要な分だけ手を入れる。
- 友達から細かいルールの指摘が来ることがある。まずは**マニュアル操作モード**（効果は記録だけ・カードは手で動かす）で対応できないか考える。
- **本格的なルールの実装に踏み込みそうな時は、作る前にオーナーに確認する。**
- 求められていない機能は勝手に足さない。

## 2. 絶対に守ること

1. **GitHubのリポジトリ（donadonaa24-cyber/ka-do）は公開されている。**
2. **カード画像（著作権はコナミ）は絶対にコミットしない。**
   - 画像は `private/` に置く（`.gitignore` 済み）。
   - `private/cards/<カードID>.jpg` がカード画像、`private/card-back.jpg` がカードの裏面。
3. 共有版（友達用）には画像を入れない。
4. **通信対戦（PvP）は作ってあるが、表には出さない。**
   - `src/ui/features.ts` の `PVP_ENABLED`（`VITE_PVP=1` の時だけ有効）で隠している。
   - オーナーが「有効にして」と言うまで、有効にしない・作業を進めない。
5. 公開中のページは、オーナーに頼まれない限り削除しない。
6. ライセンスは「自分用は自由・配布は不可」（`LICENSE`）。変えない。

## 3. コマンド

```bash
npm install
npm test                 # vitest（全テストが通ること）
npx tsc --noEmit         # 型チェック
npx prettier --write <変更したファイル>   # .prettierrc：singleQuote, printWidth 120
npm run dev              # http://localhost:5173
npm run build:share      # dist/share.html（共有版・画像なし）
npm run build:artifact   # dist/artifact.html（自分専用・private/ の画像を埋め込む）
npm run build:pages      # pages/index.html（GitHub Pages 用の共有版。通常は GitHub Actions が作る）
```

- `vite build` は `dist/` を空にする。両方のHTMLが欲しい時は、1つ作るたびに別の場所へコピーする。
- `private/` が無い環境（クラウドのCodexなど）では、`build:artifact` でも画像は入らない。共有版だけ作れば良い。
- 生成された `*.generated.ts` は prettier にかけない（差分が大きくなる）。

## 4. 作業の流れ

1. 修正する
2. テストを追加する（バグ報告なら、再現するテストを先に書く）
3. `npx tsc --noEmit` と `npm test` を通す
4. main にコミットして push する
5. HTMLをビルドする

公開ページ（claude.ai の Artifact）は Claude からしか更新できない。

| ページ | 中身 | URL |
| --- | --- | --- |
| 自分専用 | 画像入り | https://claude.ai/artifact/RUResKzsKgtkbD8YHGep82 |
| 共有版 | 画像なし | https://claude.ai/artifact/LQ9FxjRAoyu8ePA3HQ1Hfo |

- Claude 以外で作業した時は「ページへの反映は Claude に頼む」とオーナーに伝える。
- または、ビルドしたHTMLファイルをそのまま渡す。

### GitHub Pages（共有版・自動公開）

- main に push されると、GitHub Actions（`.github/workflows/pages.yml`）がテストを通してから共有版を GitHub Pages に公開する。テストが通らなければ公開しない。
- ビルドは `npm run build:pages`（`pages/index.html`。画像なし・検索エンジンに載せない `noindex` 付き）。
- GitHub Pages は URL を知っていれば誰でも開ける。画像や個人のデータは絶対に入れない。
- 保存データ（デッキ・画像）はページごとに別々。claude.ai のページと行き来する時は「データの書き出し・読み込み」で移す。
- 通信対戦（PvP）は claude.ai のページの共有ストレージを使うので、GitHub Pages では動かない。

## 5. 構成

```
src/engine/   ルールエンジン（UIに依存しない）
  types.ts        盤面・カード・チェーンなどの型
  game.ts         applyAction(state, action, ctx)：操作を1つ適用する純粋な関数（state を複製して reduce）
  scripts.ts      カードの効果の書き方（EffectDef / Step）
  effectRunner.ts 効果の発動〜チェーン〜解決（Running を1ステップずつ進める）
  oppAI.ts        練習用の相手・CPUの妨害（ABILITIES）
  cpu.ts          CPU戦（CPUの展開、プレイヤーの手札誘発・罠の割り込み）
  solver.ts       ルート探索（ナビ・最適ルート）／guide.ts ルートガイドの実行
  pvp.ts          通信対戦（非表示）
src/data/     カードデータ・効果・デッキ・ガイド・テスト
  *Cards.generated.ts  カード名・テキスト・ステータス
  toonScripts.ts / blueScripts.ts / otherScripts.ts  効果（カードID → CardScript）
  index.ts        CARD_DB・CARD_SCRIPTS・既製デッキ（TOON_DECK など）
  *Guides.ts      ルートガイド
  *.test.ts       テスト（blue / toon / cpu / solver / other / pvp）
src/ui/       React の画面（App.tsx が中心）
scripts/build-artifact.mjs  1ファイルのHTMLにまとめる（題名・画像の埋め込み）
```

### 記録と再生

- ゲームは「操作（Action）の列」として保存し、毎回最初から再生して盤面を作る（`session.actions`）。
- **Action の形を変える時は、古い保存データでも再生できるようにする**（足すのは任意のフィールドにする）。

### 効果の書き方（scripts.ts）

効果は `steps` の並び。

- `pick`：カードを選ぶ
  - `cost: true` はコスト。発動時に払い、無効にされても戻らない。
  - `target: true` は対象を取る効果。チェーンに積む前に選び、処理（`then`）は解決時に行う。解決時に対象が同じ場所に無ければ不発。
  - それ以外は解決時に選ぶ。
- `place`：出すゾーンを選ぶ
- `do`：選ばずに処理する

`EffectDef` の主な項目：

| 項目 | 意味 |
| --- | --- |
| `from` | 発動できる場所 |
| `key` / `limit` | 1ターンに◯度 |
| `speed` | スペルスピード |
| `trigger` / `onSummon` | 誘発効果 |
| `condition` | 発動条件（エラー文を返す） |
| `isCardActivation` | 魔法・罠の発動 |

### チェーン（effectRunner.ts の pushToChain）

`chainMode` は次の4つ。

| 値 | 動き |
| --- | --- |
| `auto` | ルールチェックあり。チェーンできる効果があれば止める |
| `reactive` | ルールチェックなし。「対象になった時」など、この発動に反応する効果がある時だけ止める |
| `force` | 必ずチェーンに積む |
| `never` | 止めずに最後まで処理する |

ルール上の決まりごと：

- 発動したら、**相手（練習用の相手・CPU）が先にチェーンするか決める**。
- 相手が間に挟まると、「対象になった時」の効果（白き乙女③）はタイミングを逃す。
- チェーン画面には、使えない効果も理由付きで出す（`chainCandidates().blocked`）。
- 起動効果・通常魔法（スペルスピード1）は、自分のメインフェイズだけ。

### モード

- **ルールチェック**（`session.strict`）：オフにすると制限なし。
- **マニュアル操作**（localStorage `ygo-manual`）：効果は記録だけ。カードは手で動かす。ルールチェックなし。
- **俺ルール**：本来できない操作のボタンも常に出す。

### カード・デッキを足す時

1. `*Cards.generated.ts` にカードデータを足す（`CardDef`）。
2. 効果を自動で動かすなら `*Scripts.ts` に書く。
   - 書かなくても、マニュアル操作なら手で回せる。
   - 効果まで作り込むと大きな作業になるので、オーナーに確認してから。
3. 既製デッキにするなら `index.ts` の `BUILTIN_DECKS` に足す。

### トークンを生成するカード（ＴＧを含む全デッキ共通）

- **生成効果は、カード本文どおりのトークンを実際に生成する。記録のみ・汎用トークンで済ませない。**
- 公式カードデータベースまたは `mycard/ygopro-database` の日本語 `cards.cdb` と照合し、名称・生成数・レベル・チューナー／非チューナー・属性・種族・攻撃力・守備力・カテゴリを正確に設定する。非チューナーも `tuner: false` と明示する。
- 生成する表示形式、コスト、発動条件・回数制限、素材やリリースに使えるかなどの制限も反映する。例：ＴＧトークンはレベル1・非チューナー・地属性・機械族・攻守0・攻撃表示で「ＴＧ」扱い。幻耀トークンはレベル2のチューナーで「ＢＦ」扱いではない。ラディアントークンはＳ素材にできない。
- `src/data/tokens.test.ts` に生成効果を通した検証ケースを追加し、上記の情報・制限と保存・再生を確認する。収録された生成カードの検証漏れを検出するテストも維持する。
- 大きなエンジン変更が必要な制限は、勝手に省略したりテキストを変えたりせず、実装前にオーナーへ具体的に相談する。

### ブラウザの保存データ（localStorage）

- `ygo-solo:*`：デッキ・画像・ルート・続きのゲーム
- `ygo-ore-rule` / `ygo-manual` / `ygo-sound` / `ygo-motion`：設定

保存データはページ（とアプリ・ブラウザ）ごとに別々。引っ越しは「データの書き出し・読み込み」（`src/ui/backup.ts`）で行う。

## 6. よくある落とし穴

- 盤面の state は直接書き換えない。必ず `applyAction` を通す。
- ルート探索（solver）はテストが重い（全体で2分ほど）。
- 画面の確認は Playwright が使える。Chromium の場所は環境による。
