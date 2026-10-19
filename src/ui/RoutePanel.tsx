import { useCallback, useEffect, useRef, useState } from 'react';
import { type Coach, coachFromRoute } from '../engine/coach';
import type { Action } from '../engine/game';
import type { Guide } from '../engine/guide';
import type { RouteStep } from '../engine/solver';
import type { GameState } from '../engine/types';
import SolverWorker from './solver.worker?worker&inline';

export interface FoundRoute {
  /** 記事などのルートの名前（探索で見つけたものは無し） */
  title?: string;
  score: number;
  summary: string[];
  steps: RouteStep[];
  finalUids: string[];
  /** 最終盤面の妨害（数が妨害数） */
  disruptions: string[];
  /** 最終盤面を表す文字列（選んだ盤面に向かうルートを探し直すため） */
  finalKey: string;
}

export interface RouteSearch {
  searching: boolean;
  progress: number;
  routes: FoundRoute[] | null;
  /** 探索した時点の操作数とログの長さ（盤面が変わったかの判定に使う） */
  baseActions: number;
  baseLog: number;
  search: (state: GameState, actionCount: number, deckName: string) => void;
}

/** ルート探索を別スレッドで動かす */
export function useRouteSearch(onError: (msg: string) => void): RouteSearch {
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [routes, setRoutes] = useState<FoundRoute[] | null>(null);
  const [base, setBase] = useState({ actions: 0, log: 0 });
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const search = useCallback(
    (state: GameState, actionCount: number, deckName: string) => {
      workerRef.current?.terminate();
      setSearching(true);
      setProgress(0);
      setRoutes(null);
      setBase({ actions: actionCount, log: state.log.length });
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
      worker.postMessage({ state, deckName });
    },
    [onError],
  );

  return { searching, progress, routes, baseActions: base.actions, baseLog: base.log, search };
}

interface Props {
  search: RouteSearch;
  state: GameState;
  actionCount: number;
  deckName: string;
  guides: Guide[];
  coach: Coach | null;
  coachDone: number;
  onPractice: (coach: Coach) => void;
  onAutoPlay: (actions: Action[]) => void;
  onStartGuide: (g: Guide) => void;
  onClose: () => void;
}

export function RoutePanel({
  search,
  state,
  actionCount,
  deckName,
  guides,
  coach,
  coachDone,
  onPractice,
  onAutoPlay,
  onStartGuide,
  onClose,
}: Props) {
  const [tab, setTab] = useState<'search' | 'guide'>('search');
  const [open, setOpen] = useState(0);
  const { searching, progress, routes } = search;
  const stale = routes !== null && actionCount !== search.baseActions;
  const route = routes?.[open];

  useEffect(() => setOpen(0), [routes]);

  return (
    <div className="modal route-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h2>ルート</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <div className="seg" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'search'}
          className={tab === 'search' ? 'on' : ''}
          onClick={() => setTab('search')}
        >
          この盤面から探す
        </button>
        <button
          role="tab"
          aria-selected={tab === 'guide'}
          className={tab === 'guide' ? 'on' : ''}
          onClick={() => setTab('guide')}
        >
          ルートガイド
        </button>
      </div>

      {tab === 'search' && (
        <div className="modal-body">
          <button className="primary" onClick={() => search.search(state, actionCount, deckName)} disabled={searching}>
            {searching
              ? `探索中… ${Math.round(progress * 100)}%`
              : routes
                ? 'この盤面からもう一度探す'
                : 'この盤面から最適ルートを探す'}
          </button>
          {searching && (
            <div className="progress" aria-hidden="true">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {!routes && !searching && (
            <p className="note">今の盤面から取れる手を全て試し、妨害の多い最終盤面になる展開を上位3つまで探します。</p>
          )}
          {routes && routes.length === 0 && <p className="note">この盤面から動ける展開は見つかりませんでした。</p>}
          {stale && <p className="note warn">探した後に盤面が変わっています。練習するにはもう一度探してください。</p>}
          {routes && routes.length > 0 && route && (
            <>
              <div className="seg wrap">
                {routes.map((r, i) => (
                  <button key={i} className={open === i ? 'on' : ''} onClick={() => setOpen(i)}>
                    {r.title ? `記事：${r.title}` : `ルート${i + 1}`}（{r.steps.length}手・評価{r.score.toFixed(1)}）
                  </button>
                ))}
              </div>
              <div className="route-final">
                <strong>最終盤面</strong>
                <ul>
                  {route.summary.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
              <ol className="route-steps">
                {route.steps.map((st, i) => (
                  <li key={i}>
                    {st.note && <div className="head">{st.note}</div>}
                    {st.lines.map((l, j) => (
                      <div key={j} className={j === 0 && !st.note ? 'head' : 'sub'}>
                        {l}
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
              <div className="row end">
                <button disabled={stale} onClick={() => onAutoPlay(route.steps.map((s) => s.action))}>
                  最後まで自動で実行
                </button>
                <button
                  className="primary"
                  disabled={stale}
                  onClick={() =>
                    onPractice(
                      coachFromRoute(
                        route.title ?? `ルート${open + 1}`,
                        route.steps,
                        route.summary,
                        search.baseLog,
                        route.finalUids,
                      ),
                    )
                  }
                >
                  このルートを盤面で練習
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'guide' && (
        <div className="modal-body">
          {guides.map((g) => {
            const active = coach?.guideId === g.id;
            return (
              <div key={g.id} className={`guide ${active ? 'active' : ''}`}>
                <strong>{g.name}</strong>
                <p className="note">
                  デッキ：{g.deckName}
                  <br />
                  {g.description}
                </p>
                <ol className="route-steps">
                  {g.steps.map((st, i) => (
                    <li key={i} className={active && i < coachDone ? 'done' : ''}>
                      <div className="head">{st.text}</div>
                    </li>
                  ))}
                </ol>
                <ul className="route-final">
                  {g.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                <button className="primary" onClick={() => onStartGuide(g)}>
                  {active ? 'この初手で最初から練習' : 'この初手で練習する'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
