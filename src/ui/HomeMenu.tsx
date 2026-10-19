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
  /** 続きから再開できるゲーム（操作がある時だけ） */
  resume: { deckName: string; actions: number } | null;
  guides: Guide[];
  onResume: () => void;
  /** 初手をランダムに引いて始める。navi なら最適ルートの解説付き */
  onRandom: (deckName: string, handSize: 5 | 6, navi: boolean) => void;
  onPickHand: (deckName: string) => void;
  onGuide: (g: Guide) => void;
  /** CPU戦（CPUが先攻・こちらは後攻で手札誘発の練習） */
  onCpuDuel: (humanDeck: string, cpuDeck: string) => void;
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

/** 起動時に出すメニュー画面：デッキを選んで、始め方を選ぶ */
export function HomeMenu(p: Props) {
  const [deckName, setDeckName] = useState(p.current);
  const [handSize, setHandSize] = useState<5 | 6>(5);
  const [cpuDeck, setCpuDeck] = useState(p.builtinNames[0]);
  const deck = p.decks.find((d) => d.name === deckName) ?? p.decks[0];
  const guides = p.guides.filter((g) => g.deckName === deck.name);
  const builtin = p.decks.filter((d) => p.builtinNames.includes(d.name));
  const custom = p.decks.filter((d) => !p.builtinNames.includes(d.name));

  const deckButton = (d: DeckList) => (
    <button
      key={d.name}
      className={`deck-tile ${d.name === deck.name ? 'on' : ''}`}
      aria-pressed={d.name === deck.name}
      onClick={() => setDeckName(d.name)}
    >
      <strong>{d.name}</strong>
      <span className="deck-count">
        メイン{d.main.length}・EX{d.extra.length}
        {d.side?.length ? `・サイド${d.side.length}` : ''}
      </span>
      <span className="deck-keys">{keyCards(d).join('・')}</span>
    </button>
  );

  return (
    <div className="home" role="dialog" aria-label="メニュー画面">
      <div className="home-inner">
        <h1>遊戯王 一人回し</h1>

        {p.resume && (
          <button className="primary wide resume" onClick={p.onResume}>
            続きから（{p.resume.deckName}・{p.resume.actions}手）
          </button>
        )}

        <section>
          <h2>デッキを選ぶ</h2>
          <div className="deck-tiles">{builtin.map(deckButton)}</div>
          {custom.length > 0 && (
            <>
              <h3>自分で作ったデッキ</h3>
              <div className="deck-tiles">{custom.map(deckButton)}</div>
            </>
          )}
        </section>

        <section>
          <h2>{deck.name}で始める</h2>
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
          <div className="btn-grid">
            <button className="primary wide" onClick={() => p.onRandom(deck.name, handSize, true)}>
              ナビ付きで始める（最適ルートを1手ずつ解説）
            </button>
            <button onClick={() => p.onRandom(deck.name, handSize, false)}>ランダムな初手で始める</button>
            <button onClick={() => p.onPickHand(deck.name)}>初手を選んで始める</button>
          </div>
        </section>

        <section>
          <h2>CPU戦（後攻で手札誘発の練習）</h2>
          <p className="note">
            CPUが先攻で、ナビと同じように最適なルートで展開します。CPUが効果を使うたびに、あなたの手札誘発を使うか聞きます。止められたCPUは今の盤面からルートを探し直します。CPUのターンが終わったら、CPUの盤面を相手にあなたのターン（後攻）を続けます。
          </p>
          <div className="seg" role="tablist" aria-label="CPUのデッキ">
            {p.decks
              .filter((d) => p.builtinNames.includes(d.name))
              .map((d) => (
                <button
                  key={d.name}
                  className={cpuDeck === d.name ? 'on' : ''}
                  aria-selected={cpuDeck === d.name}
                  onClick={() => setCpuDeck(d.name)}
                >
                  CPU：{d.name}
                </button>
              ))}
          </div>
          <button className="primary wide" onClick={() => p.onCpuDuel(deck.name, cpuDeck)}>
            CPU戦を始める（あなた：{deck.name}・後攻）
          </button>
        </section>

        {guides.length > 0 && (
          <section>
            <h2>ルートガイドで練習</h2>
            <div className="home-guides">
              {guides.map((g) => (
                <button key={g.id} className="guide-tile" onClick={() => p.onGuide(g)}>
                  <strong>{g.name}</strong>
                  <span>{g.description}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="btn-grid">
          <button onClick={p.onEditDecks}>デッキ編集・作成</button>
          <button onClick={p.onImages}>カード画像の設定</button>
        </section>
        <p className="note build-time">
          ページの更新：
          {new Date(__BUILD_TIME__).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      </div>
    </div>
  );
}
