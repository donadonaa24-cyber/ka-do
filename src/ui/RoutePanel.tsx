import { useEffect, useRef, useState } from 'react';
import type { Action, Ctx } from '../engine/game';
import { findGuideAction, type Guide } from '../engine/guide';
import type { RouteStep } from '../engine/solver';
import type { GameState } from '../engine/types';
import SolverWorker from './solver.worker?worker&inline';

interface FoundRoute {
  score: number;
  summary: string[];
  steps: RouteStep[];
}

interface Props {
  state: GameState;
  ctx: Ctx;
  /** 今までの操作の数（盤面が変わったかの判定に使う） */
  actionCount: number;
  guides: Guide[];
  /** 進めているガイドと、何手目まで終わったか */
  guideProgress: { id: string; done: number } | null;
  dispatch: (a: Action) => boolean;
  onStartGuide: (g: Guide) => void;
  onError: (msg: string) => void;
}

export function RoutePanel({ state, ctx, actionCount, guides, guideProgress, dispatch, onStartGuide, onError }: Props) {
  const [tab, setTab] = useState<'search' | 'guide'>('search');
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [routes, setRoutes] = useState<FoundRoute[] | null>(null);
  const [base, setBase] = useState(0);
  const [open, setOpen] = useState(0);
  const [played, setPlayed] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const search = () => {
    workerRef.current?.terminate();
    setSearching(true);
    setProgress(0);
    setRoutes(null);
    setPlayed(0);
    setOpen(0);
    setBase(actionCount);
    let worker: Worker;
    try {
      worker = new SolverWorker();
    } catch {
      setSearching(false);
      onError('この環境ではルート探索を起動できませんでした');
      return;
    }
    workerRef.current = worker;
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(Math.min(1, e.data.ratio));
      else {
        setRoutes(e.data.routes);
        setSearching(false);
        worker.terminate();
      }
    };
    worker.onerror = () => {
      setSearching(false);
      onError('ルート探索中にエラーが起きました');
    };
    worker.postMessage({ state });
  };

  const stale = routes !== null && actionCount !== base + played;
  const route = routes?.[open];

  const playNext = () => {
    if (!route || stale || played >= route.steps.length) return;
    if (dispatch(route.steps[played].action)) setPlayed(played + 1);
  };

  const playAll = () => {
    if (!route || stale) return;
    // まとめて実行（1手ずつ戻せる）
    let n = played;
    const tick = () => {
      if (n >= route.steps.length) return;
      if (!dispatch(route.steps[n].action)) return;
      n++;
      setPlayed(n);
      if (n < route.steps.length) setTimeout(tick, 350);
    };
    tick();
  };

  const activeGuide = guides.find((g) => g.id === guideProgress?.id);

  const guideNext = () => {
    if (!activeGuide || !guideProgress) return;
    const step = activeGuide.steps[guideProgress.done];
    if (!step) return;
    const action = findGuideAction(state, ctx, step);
    if (!action) onError(`今の盤面では「${step.text}」を実行できません`);
    else dispatch(action);
  };

  return (
    <section className="routes-panel">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>
          この手札から探す
        </button>
        <button role="tab" aria-selected={tab === 'guide'} className={tab === 'guide' ? 'on' : ''} onClick={() => setTab('guide')}>
          ルートガイド
        </button>
      </div>

      {tab === 'search' && (
        <div className="tab-body">
          <p className="note">今の盤面から取れる手を全て試し、妨害の多い最終盤面になる展開を上位3つまで探します。</p>
          <button className="primary" onClick={search} disabled={searching}>
            {searching ? `探索中… ${Math.round(progress * 100)}%` : '今の盤面からルートを探す'}
          </button>
          {searching && (
            <div className="progress" aria-hidden="true">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {routes && routes.length === 0 && <p className="note">この盤面から動ける展開は見つかりませんでした。</p>}
          {routes && routes.length > 0 && (
            <>
              <div className="route-tabs">
                {routes.map((r, i) => (
                  <button
                    key={i}
                    className={open === i ? 'on' : ''}
                    onClick={() => {
                      setOpen(i);
                      setPlayed(0);
                    }}
                    disabled={played > 0 && open !== i}
                  >
                    ルート{i + 1}（{r.steps.length}手・評価{r.score.toFixed(1)}）
                  </button>
                ))}
              </div>
              {route && (
                <div className="route">
                  <ul className="route-summary">
                    {route.summary.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  <ol className="route-steps">
                    {route.steps.map((st, i) => (
                      <li key={i} className={i < played ? 'done' : i === played ? 'current' : ''}>
                        {st.lines.map((l, j) => (
                          <div key={j} className={j === 0 ? 'head' : 'sub'}>
                            {l}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ol>
                  {stale ? (
                    <p className="note warn">盤面が変わったので、もう一度探してください。</p>
                  ) : (
                    <div className="btn-row">
                      <button className="primary" onClick={playNext} disabled={played >= route.steps.length}>
                        次の1手を実行
                      </button>
                      <button onClick={playAll} disabled={played >= route.steps.length}>
                        最後まで実行
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'guide' && (
        <div className="tab-body">
          {guides.map((g) => {
            const active = g.id === guideProgress?.id;
            const done = active ? guideProgress!.done : 0;
            return (
              <div key={g.id} className={`guide ${active ? 'active' : ''}`}>
                <strong>{g.name}</strong>
                <p className="note">{g.description}</p>
                <button className={active ? '' : 'primary'} onClick={() => onStartGuide(g)}>
                  {active ? 'この初手で最初から' : 'この初手で練習する'}
                </button>
                {active && (
                  <>
                    <p className="note">
                      自分で操作すると手順が合っているか自動でチェックされます（{done}/{g.steps.length}）。
                    </p>
                    <ol className="route-steps">
                      {g.steps.map((st, i) => (
                        <li key={i} className={i < done ? 'done' : i === done ? 'current' : ''}>
                          <div className="head">{st.text}</div>
                        </li>
                      ))}
                    </ol>
                    {done >= g.steps.length ? (
                      <p className="note ok">完成！</p>
                    ) : (
                      <button onClick={guideNext}>お手本：次の手順を実行</button>
                    )}
                    <ul className="route-summary">
                      {g.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
