import { useState } from 'react';
import { CARD_DB } from '../data';
import type { Guide } from '../engine/guide';
import type { DeckList } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';

interface Props {
  decks: DeckList[];
  /** 既製のデッキの名前（自分で作ったデッキと分けて表示する） */
  builtinNames: string[];
  current: string;
  /** デッキの表示名 */
  nameOf: (name: string) => string;
  /** デッキの名前を変える（変えた後のデッキの名前を返す） */
  onRename: (name: string, newName: string) => string;
  /** 続きから再開できるゲーム（操作がある時だけ） */
  resume: { deckName: string; actions: number } | null;
  guides: Guide[];
  onResume: () => void;
  /** 初手をランダムに引いて始める。navi なら最適ルートの解説付き */
  onRandom: (deckName: string, handSize: 5 | 6, navi: boolean) => void;
  onPickHand: (deckName: string) => void;
  onGuide: (g: Guide) => void;
  /** CPU戦（CPUが先攻・こちらは後攻で手札誘発の練習）。navi なら自分のターンにナビを付ける */
  onCpuDuel: (humanDeck: string, cpuDeck: string, navi: boolean) => void;
  onEditDecks: () => void;
  onImages: () => void;
}

/** デッキの中で多く入っているモンスター（デッキの顔として表示） */
function keyCards(deck: DeckList): string[] {
  const counts = new Map<string, number>();
  for (const id of deck.main) {
    const d = CARD_DB[id];
    if (d?.kind === 'monster' && !isExtraDeckCard(d)) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => n);
}

type Step = 'top' | 'deck' | 'turn' | 'opponent' | 'start';
const STEPS: { id: Step; label: string }[] = [
  { id: 'deck', label: 'デッキ' },
  { id: 'turn', label: '先攻・後攻' },
  { id: 'opponent', label: '相手' },
  { id: 'start', label: '始め方' },
];

/**
 * 起動時に出すメニュー画面。続きから遊ぶか、新しく始める場合は
 * デッキ → 先攻・後攻とナビ → 相手（CPUの有無・CPUのデッキ）→ 始め方（初手・ルートガイド）の順に1つずつ選ぶ
 */
export function HomeMenu(p: Props) {
  const [step, setStep] = useState<Step>('top');
  const [deckName, setDeckName] = useState(p.current);
  const [handSize, setHandSize] = useState<5 | 6>(5);
  const [navi, setNavi] = useState(true);
  const [cpuOn, setCpuOn] = useState(false);
  const [cpuDeck, setCpuDeck] = useState(p.builtinNames[0]);
  /** 名前を変えている途中のデッキの新しい名前（null は変えていない） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const deck = p.decks.find((d) => d.name === deckName) ?? p.decks[0];
  const guides = p.guides.filter((g) => g.deckName === deck.name);
  const builtin = p.decks.filter((d) => p.builtinNames.includes(d.name));
  const custom = p.decks.filter((d) => !p.builtinNames.includes(d.name));
  const stepIndex = STEPS.findIndex((x) => x.id === step);
  const back = () => setStep(stepIndex <= 0 ? 'top' : STEPS[stepIndex - 1].id);
  const next = () => setStep(STEPS[stepIndex + 1].id);

  const deckButton = (d: DeckList) => (
    <button
      key={d.name}
      className={`deck-tile ${d.name === deck.name ? 'on' : ''}`}
      aria-pressed={d.name === deck.name}
      onClick={() => {
        setDeckName(d.name);
        setRenaming(null);
      }}
    >
      <strong>{p.nameOf(d.name)}</strong>
      <span className="deck-count">
        メイン{d.main.length}・EX{d.extra.length}
        {d.side?.length ? `・サイド${d.side.length}` : ''}
      </span>
      <span className="deck-keys">{keyCards(d).join('・')}</span>
    </button>
  );

  // 選んだ内容（次の画面の上に出す）
  const summary = [
    p.nameOf(deck.name),
    cpuOn ? '後攻（CPUが先攻）' : handSize === 5 ? '先攻' : '後攻',
    navi ? 'ナビあり' : 'ナビなし',
    cpuOn ? `CPU：${p.nameOf(cpuDeck)}` : 'CPUなし',
  ].slice(0, stepIndex + 1);

  if (step === 'top')
    return (
      <div className="home" role="dialog" aria-label="メニュー画面">
        <div className="home-inner">
          <h1>遊戯王 一人回し</h1>
          {p.resume && (
            <button className="primary wide resume" onClick={p.onResume}>
              続きから遊ぶ（{p.resume.deckName}・{p.resume.actions}手）
            </button>
          )}
          <button className={`wide resume ${p.resume ? '' : 'primary'}`} onClick={() => setStep('deck')}>
            新しく始める
          </button>
          <p className="note build-time">
            ページの更新：
            {new Date(__BUILD_TIME__).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        </div>
      </div>
    );

  return (
    <div className="home" role="dialog" aria-label="メニュー画面">
      <div className="home-inner">
        <div className="step-head">
          <button onClick={back} aria-label="戻る">
            ← 戻る
          </button>
          <ol className="step-dots">
            {STEPS.map((x, i) => (
              <li key={x.id} className={i === stepIndex ? 'now' : i < stepIndex ? 'done' : ''}>
                {x.label}
              </li>
            ))}
          </ol>
        </div>
        {stepIndex > 0 && <p className="step-summary">{summary.slice(0, stepIndex).join(' ／ ')}</p>}

        {step === 'deck' && (
          <section className="step-body">
            <h2>保存されたデッキを選ぶ</h2>
            <div className="deck-tiles">{builtin.map(deckButton)}</div>
            {custom.length > 0 && (
              <>
                <h3>自分で作ったデッキ</h3>
                <div className="deck-tiles">{custom.map(deckButton)}</div>
              </>
            )}
            {renaming === null ? (
              <div className="btn-row">
                <button onClick={() => setRenaming(p.nameOf(deck.name))}>
                  「{p.nameOf(deck.name)}」の名前を変える
                </button>
              </div>
            ) : (
              <form
                className="rename-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  setDeckName(p.onRename(deck.name, renaming));
                  setRenaming(null);
                }}
              >
                <input
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                  aria-label="新しいデッキ名"
                  autoFocus
                  maxLength={30}
                />
                <button type="submit" className="primary">
                  変更
                </button>
                <button type="button" onClick={() => setRenaming(null)}>
                  やめる
                </button>
              </form>
            )}
            <div className="btn-grid">
              <button onClick={p.onEditDecks}>デッキ編集・作成</button>
              <button onClick={p.onImages}>カード画像の設定</button>
            </div>
          </section>
        )}

        {step === 'turn' && (
          <section className="step-body">
            <h2>先攻・後攻</h2>
            <div className="seg" role="tablist" aria-label="先攻・後攻">
              <button
                className={handSize === 5 ? 'on' : ''}
                aria-selected={handSize === 5}
                onClick={() => setHandSize(5)}
              >
                先攻（初手5枚）
              </button>
              <button
                className={handSize === 6 ? 'on' : ''}
                aria-selected={handSize === 6}
                onClick={() => setHandSize(6)}
              >
                後攻（6枚）
              </button>
            </div>
            <h2>ナビ</h2>
            <div className="seg" role="tablist" aria-label="ナビ">
              <button className={navi ? 'on' : ''} aria-selected={navi} onClick={() => setNavi(true)}>
                ナビあり
              </button>
              <button className={!navi ? 'on' : ''} aria-selected={!navi} onClick={() => setNavi(false)}>
                ナビなし
              </button>
            </div>
            <p className="note">ナビありなら、妨害が多くなる最終盤面を選んで、そこまでの手順を1手ずつ解説します。</p>
          </section>
        )}

        {step === 'opponent' && (
          <section className="step-body">
            <h2>相手</h2>
            <button className={`choice-option ${!cpuOn ? 'on' : ''}`} onClick={() => setCpuOn(false)}>
              <strong>CPUなし（一人回し）</strong>
              <span>自分の展開を練習します。相手の盤面（妨害）は後からメニューで置けます。</span>
            </button>
            <button className={`choice-option ${cpuOn ? 'on' : ''}`} onClick={() => setCpuOn(true)}>
              <strong>CPUあり（後攻で手札誘発の練習）</strong>
              <span>
                CPUが先攻で最適なルートで展開します。CPUが効果を使うたびに手札誘発を使うか聞きます。CPUのターンの後、CPUの盤面を相手にあなたのターンを続けます（先攻・後攻の選択に関わらず後攻）。
              </span>
            </button>
            {cpuOn && (
              <>
                <h3>CPUのデッキ</h3>
                <div className="seg wrap" role="tablist" aria-label="CPUのデッキ">
                  {builtin.map((d) => (
                    <button
                      key={d.name}
                      className={cpuDeck === d.name ? 'on' : ''}
                      aria-selected={cpuDeck === d.name}
                      onClick={() => setCpuDeck(d.name)}
                    >
                      {p.nameOf(d.name)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {step === 'start' && (
          <section className="step-body">
            <h2>始め方</h2>
            {cpuOn ? (
              <button className="primary wide resume" onClick={() => p.onCpuDuel(deck.name, cpuDeck, navi)}>
                CPU戦を始める
              </button>
            ) : (
              <>
                <div className="btn-grid">
                  <button className="primary wide" onClick={() => p.onRandom(deck.name, handSize, navi)}>
                    ランダムな初手で始める
                  </button>
                  <button onClick={() => p.onPickHand(deck.name)}>初手を選んで始める</button>
                </div>
                {guides.length > 0 && (
                  <>
                    <h3>ルートガイドで練習（記事のルートを初手から順に）</h3>
                    <div className="home-guides">
                      {guides.map((g) => (
                        <button key={g.id} className="guide-tile" onClick={() => p.onGuide(g)}>
                          <strong>{g.name}</strong>
                          <span>{g.description}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        {step !== 'start' && (
          <button className="primary wide resume" onClick={next}>
            次へ
          </button>
        )}
      </div>
    </div>
  );
}
