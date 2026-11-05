import { useEffect, useRef, useState } from 'react';
import type { Collision, Op, PlanResult } from '../shared/library-ops';

export interface RunResult { done: number; failed: Array<{ label: string; error: string }> }
export type RunFn = (ops: Op[], signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<RunResult>;

/** What an organize action hands the panel: how to plan it, and (optionally) a custom runner. */
export interface PlanRequest {
  title: string;
  plan(collision: Collision): Promise<PlanResult>;
  collisionChoice?: boolean;
  run?: RunFn;
  cancellable?: boolean; // default true
}

const MAX_SHOWN = 500;
const show = (p?: string[]) => (p && p.length ? p.join('/') : '(library root)');
const VERB: Record<Op['kind'], string> = { mkdir: 'New folder', move: 'Move', rename: 'Rename', trash: 'Trash', restore: 'Restore' };
export const opLabel = (op: Op) => (op.kind === 'mkdir' ? `${VERB.mkdir}: ${show(op.to)}` : `${VERB[op.kind]}: ${show(op.from)} → ${show(op.to)}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props extends PlanRequest {
  run: RunFn;
  queueActive?: boolean;
  onPauseQueue?(): void;
  onClose(ran: boolean): void;
}

/** Shows a plan (ops, skipped, warnings) and runs it only after the user confirms. */
export function OperationPreviewDialog({ title, plan: makePlan, collisionChoice, run, cancellable = true, queueActive, onPauseQueue, onClose }: Props) {
  const [collision, setCollision] = useState<Collision>('rename');
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'preview' | 'running' | 'summary'>('preview');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<RunResult | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    setPlan(null); setPlanError(null);
    makePlan(collision).then((p) => alive && setPlan(p), (e) => alive && setPlanError(errText(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collision]);

  const close = () => onClose(phase === 'summary');
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'running') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const confirm = async () => {
    if (!plan) return;
    const c = new AbortController();
    ctrl.current = c;
    setProgress({ done: 0, total: plan.ops.length });
    setPhase('running');
    try {
      setResult(await run(plan.ops, c.signal, (done, total) => setProgress({ done, total })));
    } catch (e) {
      setResult({ done: 0, failed: [{ label: 'Run', error: errText(e) }] });
    }
    setPhase('summary');
  };

  const notAttempted = result && plan ? Math.max(0, plan.ops.length - result.done - result.failed.length) : 0;

  return (
    <div className="modal-bg" onClick={() => phase !== 'running' && close()} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>

        {phase === 'preview' && (<>
          {queueActive && (
            <div className="notice" role="note">
              Downloads are still running, so new files may arrive while you organize.{' '}
              {onPauseQueue && <button onClick={onPauseQueue}>Pause the queue first</button>}
            </div>
          )}
          {collisionChoice && (
            <div className="row" role="radiogroup" aria-label="If a file with the same name exists">
              <span>If the name is taken:</span>
              <label><input type="radio" checked={collision === 'rename'} onChange={() => setCollision('rename')} /> add a number</label>
              <label><input type="radio" checked={collision === 'skip'} onChange={() => setCollision('skip')} /> skip it</label>
            </div>
          )}
          {planError && <div className="notice bad">Could not plan this: {planError}</div>}
          {!plan && !planError && <div className="muted">Checking…</div>}
          {plan && (<>
            {plan.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
            <strong>{plan.ops.length} planned change{plan.ops.length === 1 ? '' : 's'}</strong>
            {plan.ops.length > 0 && (
              <ul className="oplist" aria-label="Planned changes">
                {plan.ops.slice(0, MAX_SHOWN).map((op, i) => <li key={i}>{opLabel(op)}</li>)}
                {plan.ops.length > MAX_SHOWN && <li className="muted">…and {plan.ops.length - MAX_SHOWN} more</li>}
              </ul>
            )}
            {plan.skipped.length > 0 && (<>
              <strong>{plan.skipped.length} skipped</strong>
              <ul className="oplist" aria-label="Skipped">
                {plan.skipped.slice(0, MAX_SHOWN).map((s, i) => <li key={i}>{show(s.path)} — {s.reason}</li>)}
              </ul>
            </>)}
          </>)}
          <div className="row">
            <span className="grow" />
            <button onClick={close}>Cancel</button>
            <button className="primary" disabled={!plan || plan.ops.length === 0} onClick={confirm}>Confirm</button>
          </div>
        </>)}

        {phase === 'running' && (
          <div className="row">
            <span>{progress.done} / {progress.total}</span>
            <div className="bar grow"><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
            {cancellable && <button onClick={() => ctrl.current?.abort()}>Cancel</button>}
          </div>
        )}

        {phase === 'summary' && result && (<>
          <div className={`notice ${result.failed.length ? 'bad' : 'ok'}`} role="status">
            {result.done} done, {(plan?.skipped.length ?? 0)} skipped, {result.failed.length} failed
            {notAttempted > 0 ? `, ${notAttempted} not attempted (cancelled)` : ''}.
          </div>
          {result.failed.length > 0 && (
            <ul className="oplist" aria-label="Failed">
              {result.failed.slice(0, MAX_SHOWN).map((f, i) => <li key={i}>{f.label} — {f.error}</li>)}
            </ul>
          )}
          <div className="row"><span className="grow" /><button className="primary" onClick={close}>Close</button></div>
        </>)}
      </div>
    </div>
  );
}
