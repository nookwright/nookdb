import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Component, StrictMode, type ReactNode } from 'react';
import { useLive } from '../index.js';
import type { LiveQuery, NookError } from 'nookdb';

/** Minimal LiveQuery-shaped fake (only what useLive consumes). */
function fakeLive(initial: number[]): {
  lq: LiveQuery<number>;
  emit: (v: number[]) => void;
} {
  let next: ((v: number[]) => void) | undefined;
  const lq = {
    value: initial,
    subscribe(n: (v: number[]) => void) {
      next = n;
      n(initial);
      return () => {
        next = undefined;
      };
    },
    dispose: vi.fn<() => void>(),
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<number[]>> =>
          Promise.resolve({ value: [], done: true as const }),
      };
    },
  } as unknown as LiveQuery<number>;
  return { lq, emit: (v: number[]) => next?.(v) };
}

/** Extended fake that also captures the onError callback. */
function fakeLiveWithError(initial: number[]): {
  lq: LiveQuery<number>;
  triggerError: (e: NookError) => void;
} {
  let onErrorCb: ((e: NookError) => void) | undefined;
  const lq = {
    value: initial,
    subscribe(_n: (v: number[]) => void, err: (e: NookError) => void) {
      onErrorCb = err;
      return () => {
        onErrorCb = undefined;
      };
    },
    dispose: vi.fn<() => void>(),
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<number[]>> =>
          Promise.resolve({ value: [], done: true as const }),
      };
    },
  } as unknown as LiveQuery<number>;
  return {
    lq,
    triggerError: (e: NookError) => {
      onErrorCb?.(e);
    },
  };
}

/** Minimal class error boundary. */
class Boundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { caught: false };
  }
  static getDerivedStateFromError(): { caught: boolean } {
    return { caught: true };
  }
  componentDidCatch(): void {
    // required for React 18 concurrent mode to commit the fallback
  }
  override render(): ReactNode {
    if (this.state.caught) return <div data-testid="err">caught</div>;
    return this.props.children;
  }
}

function List({ make }: { make: () => LiveQuery<number> }): React.ReactElement {
  const data = useLive<number>(make);
  return <div data-testid="n">{data.length}</div>;
}

describe('useLive', () => {
  it('renders the initial snapshot then re-renders on emit, disposes on unmount', () => {
    const { lq, emit } = fakeLive([1, 2]);
    const { unmount } = render(<List make={() => lq} />);
    expect(screen.getByTestId('n').textContent).toBe('2');
    act(() => emit([1, 2, 3]));
    expect(screen.getByTestId('n').textContent).toBe('3');
    unmount();
    expect(lq.dispose).toHaveBeenCalled();
  });

  it('StrictMode double-mount is safe (dispose idempotent, no leak)', () => {
    const { lq } = fakeLive([]);
    const { unmount } = render(
      <StrictMode>
        <List make={() => lq} />
      </StrictMode>,
    );
    unmount();
    expect(lq.dispose).toHaveBeenCalled();
  });

  it('recompute error rethrows during render so an error boundary catches it', () => {
    // Uses @testing-library/react render (React 18 createRoot — the real production
    // path). With errorRef.current left set (not cleared before throw), React 18's
    // concurrent synchronous error-recovery re-render re-reads the still-set ref,
    // throws again, and commits the nearest error boundary's fallback. If errorRef
    // were cleared by the throwing render the recovery re-render would NOT throw and
    // the boundary would never catch the error.
    const { lq, triggerError } = fakeLiveWithError([1, 2]);
    render(
      <Boundary>
        <List make={() => lq} />
      </Boundary>,
    );
    // Initial render: boundary not triggered, snapshot visible
    expect(screen.getByTestId('n').textContent).toBe('2');
    // Trigger a recompute error from the live query; wrapped in act so React
    // flushes the forceRender state update and the re-render that throws.
    act(() => {
      triggerError(new Error('boom') as unknown as NookError);
    });
    // useLive rethrew; React 18 concurrent recovery re-threw (ref still set);
    // the boundary caught it and shows its fallback.
    expect(screen.getByTestId('err')).toBeDefined();
  });
});
