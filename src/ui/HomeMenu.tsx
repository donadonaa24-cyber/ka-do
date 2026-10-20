import { useState } from 'react';
import { CARD_DB } from '../data';
import type { Guide } from '../engine/guide';
import type { DeckList } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';
import { PVP_ENABLED } from './features';

/** このページが自分専用（画像入り）か共有版（画像なし）か（scripts/build-artifact.mjs が入れる） */
const PAGE_EDITION =
  typeof window === 'undefined' ? undefined : (window as unknown as { __PAGE_EDITION__?: string }).__PAGE_EDITION__;

interface Props {
  decks: DeckList[];
  /** 既製のデッキの名前（自分で作ったデッキと分けて表示する） */
  builtinNames: string[];
  current: string;
  /** デッキの表示名 */
  nameOf: (name: string) => string;
  /** デッキの名前を変える（変えた後のデッキの名前を返す） */
  onRename: (name: string, newName: string) => string;
  /** 自分で作ったデッキを削除する */
  onDelete: (name: string) => void;
  /** 続きから再開できるゲーム（操作がある時だけ） */
  resume: { deckName: string; actions: number } | null;
  guides: Guide[];
  onResume: () => void;
  /** 選んだ内容で始める */
  onStart: (c: StartConfig) => void;
  onEditDecks: () => void;
  onImages: () => void;
  /** 最初に出す画面（デッキ選択から始める時は 'deck'） */
  initialStep?: 'top' | 'deck';
}

/** メニューで選んだ始め方 */
export interface StartConfig {
  deckName: string;
  /** 5 なら先攻、6 なら後攻 */
  handSize: 5 | 6;
  navi: boolean;
  /** ランダムな初手・初手を選ぶ・ルートガイド */
  method: 'random' | 'pick' | { guide: Guide };
  /** CPU戦のCPUのデッキ（null はCPUなし） */
  cpuDeck: string | null;
  /** 通信対戦（join があれば、その部屋コードの部屋に入る。無ければ部屋を作る） */
  pvp?: { join?: string };
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

type Step = 'top' | 'deck' | 'turn' | 'method' | 'opponent';
const STEPS: { id: Step; label: string }[] = [
  { id: 'deck', label: 'デッキ' },
  { id: 'turn', label: '先攻・後攻' },
  { id: 'method', label: '始め方' },
  { id: 'opponent', label: '相手' },
];

/**
 * 起動時に出すメニュー画面。続きから遊ぶか、新しく始める場合は
 * デッキ → 先攻・後攻とナビ → 始め方（初手・ルートガイド）→ 相手（CPUの有無・CPUのデッキ）の順に1つずつ選ぶ
 */
export function HomeMenu(p: Props) {
  const [step, setStep] = useState<Step>(p.initialStep ?? 'top');
  const [deckName, setDeckName] = useState(p.current);
  const [handSize, setHandSize] = useState<5 | 6>(5);
  const [navi, setNavi] = useState(true);
  const [opponent, setOpponent] = useState<'none' | 'cpu' | 'pvp'>('none');
  const cpuOn = opponent === 'cpu';
  const [pvpJoin, setPvpJoin] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const [cpuDeck, setCpuDeck] = useState(p.builtinNames[0]);
  const [method, setMethod] = useState<StartConfig['method']>('random');
  /** 名前を変えている途中のデッキの新しい名前（null は変えていない） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        setMethod('random');
        setRenaming(null);
        setConfirmDelete(false);
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

  // ルートガイドは先攻（ガイドの初手から）
  const guide = typeof method === 'object' ? method.guide : null;
  // 選んだ内容（次の画面の上に出す）
  const summary = [
    p.nameOf(deck.name),
    `${guide || handSize === 5 ? '先攻' : '後攻'}・${navi ? 'ナビあり' : 'ナビなし'}`,
    guide ? `ルートガイド：${guide.name}` : method === 'pick' ? '初手を選ぶ' : 'ランダムな初手',
  ];

  if (step === 'top')
    return (
      <div className="home" role="dialog" aria-label="メニュー画面">
        <div className="home-inner">
          <h1>
            遊戯王 一人回し
            {PAGE_EDITION && (
              <span className={`edition-badge ${PAGE_EDITION === '共有版' ? 'shared' : ''}`}>{PAGE_EDITION}</span>
            )}
          </h1>
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
                {/* 削除できるのは自分で作ったデッキだけ（既製のデッキは残す） */}
                {!p.builtinNames.includes(deck.name) &&
                  (confirmDelete ? (
                    <>
                      <button
                        className="danger"
                        onClick={() => {
                          p.onDelete(deck.name);
                          setDeckName(p.builtinNames[0]);
                          setConfirmDelete(false);
                        }}
                      >
                        本当に削除
                      </button>
                      <button onClick={() => setConfirmDelete(false)}>やめる</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDelete(true)}>削除</button>
                  ))}
                {p.builtinNames.includes(deck.name) && <span className="note">既製のデッキは削除できません</span>}
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

        {step === 'method' && (
          <section className="step-body">
            <h2>始め方</h2>
            <button className={`choice-option ${method === 'random' ? 'on' : ''}`} onClick={() => setMethod('random')}>
              <strong>ランダムな初手</strong>
              <span>デッキをシャッフルして初手を引きます。</span>
            </button>
            <button className={`choice-option ${method === 'pick' ? 'on' : ''}`} onClick={() => setMethod('pick')}>
              <strong>初手を選ぶ</strong>
              <span>次の画面で初手のカードを選びます（残りはランダム）。</span>
            </button>
            {guides.length > 0 && (
              <>
                <h3>ルートガイドで練習（記事のルートを初手から順に・先攻）</h3>
                <div className="home-guides">
                  {guides.map((g) => (
                    <button
                      key={g.id}
                      className={`guide-tile ${guide?.id === g.id ? 'on' : ''}`}
                      onClick={() => setMethod({ guide: g })}
                    >
                      <strong>{g.name}</strong>
                      <span>{g.description}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {step === 'opponent' && (
          <section className="step-body">
            <h2>相手</h2>
            <button className={`choice-option ${opponent === 'none' ? 'on' : ''}`} onClick={() => setOpponent('none')}>
              <strong>CPUなし（一人回し）</strong>
              <span>
                自分の展開を練習します。{!guide && handSize === 6 ? '後攻は自分のドローフェイズから始まります。' : ''}
                相手の盤面（妨害）は後からメニューで置けます。
              </span>
            </button>
            <button className={`choice-option ${cpuOn ? 'on' : ''}`} onClick={() => setOpponent('cpu')}>
              <strong>CPUあり</strong>
              <span>
                {guide || handSize === 5
                  ? 'あなたが先攻で盤面を作り、ターンを終えるとCPUが後攻で動きます。CPUがまくり札を使うたびに、あなたの盤面の妨害や手札誘発を使うか聞きます。'
                  : 'CPUが先攻で最適なルートで展開します。CPUが効果を使うたびに手札誘発を使うか聞きます。CPUのターンの後、CPUの盤面を相手にあなたのターンを続けます。'}
                止められたCPUは今の盤面からルートを探し直します。
              </span>
            </button>
            {PVP_ENABLED && (
              <>
                <button
                  className={`choice-option ${opponent === 'pvp' ? 'on' : ''}`}
                  onClick={() => setOpponent('pvp')}
                >
                  <strong>通信対戦</strong>
                  <span>
                    友達と対戦します。部屋を作って部屋コードを伝えるか、伝えられたコードで部屋に入ります。相手の効果には、手札誘発を使うか毎回聞きます（初手はランダム・ナビなし）。
                  </span>
                </button>
                {opponent === 'pvp' && (
                  <>
                    <div className="seg" role="tablist" aria-label="部屋">
                      <button
                        className={!pvpJoin ? 'on' : ''}
                        aria-selected={!pvpJoin}
                        onClick={() => setPvpJoin(false)}
                      >
                        部屋を作る（{handSize === 5 ? '自分が先攻' : '自分が後攻'}）
                      </button>
                      <button className={pvpJoin ? 'on' : ''} aria-selected={pvpJoin} onClick={() => setPvpJoin(true)}>
                        部屋に入る
                      </button>
                    </div>
                    {pvpJoin ? (
                      <input
                        className="room-input"
                        value={roomCode}
                        onChange={(e) => setRoomCode(e.target.value)}
                        placeholder="部屋コード（5文字）"
                        aria-label="部屋コード"
                      />
                    ) : (
                      <p className="note">
                        先攻・後攻は前の画面の選択で決まります。部屋に入る人の先攻・後攻は、部屋を作った人の逆になります。
                      </p>
                    )}
                    <p className="note">
                      相手もこのページを開いている必要があります。友達をページの「共有」でメールアドレスから編集者として招待してください（編集できる人だけが対戦のデータを書けます）。
                    </p>
                  </>
                )}
              </>
            )}
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
            <button
              className="primary wide resume"
              disabled={opponent === 'pvp' && pvpJoin && roomCode.trim().length < 5}
              onClick={() =>
                p.onStart({
                  deckName: deck.name,
                  handSize: guide ? 5 : handSize,
                  navi,
                  method,
                  cpuDeck: cpuOn ? cpuDeck : null,
                  ...(opponent === 'pvp' ? { pvp: pvpJoin ? { join: roomCode.trim() } : {} } : {}),
                })
              }
            >
              {opponent === 'pvp'
                ? pvpJoin
                  ? '部屋に入る'
                  : '部屋を作る'
                : method === 'pick'
                  ? '初手を選ぶ画面へ'
                  : cpuOn
                    ? 'CPU戦を始める'
                    : '始める'}
            </button>
          </section>
        )}

        {step !== 'opponent' && (
          <button className="primary wide resume" onClick={next}>
            次へ
          </button>
        )}
      </div>
    </div>
  );
}
