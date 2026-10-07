import { describe, it, expect } from 'bun:test';
import { filterArgs, emitActivity, getActivityAfter, getActivityHistory, subscribe } from '../src/activity';

describe('filterArgs — privacy filtering', () => {
  it('redacts fill value for password fields', () => {
    expect(filterArgs('fill', ['#password', 'mysecret123'])).toEqual(['#password', '[REDACTED]']);
    expect(filterArgs('fill', ['input[type=passwd]', 'abc'])).toEqual(['input[type=passwd]', '[REDACTED]']);
  });

  it('preserves fill value for non-password fields', () => {
    expect(filterArgs('fill', ['#email', 'user@test.com'])).toEqual(['#email', 'user@test.com']);
  });

  it('redacts type command args', () => {
    expect(filterArgs('type', ['my password'])).toEqual(['[REDACTED]']);
  });

  it('redacts Authorization header', () => {
    expect(filterArgs('header', ['Authorization:Bearer abc123'])).toEqual(['Authorization:[REDACTED]']);
  });

  it('preserves non-sensitive headers', () => {
    expect(filterArgs('header', ['Content-Type:application/json'])).toEqual(['Content-Type:application/json']);
  });

  it('redacts cookie values', () => {
    expect(filterArgs('cookie', ['session_id=abc123'])).toEqual(['session_id=[REDACTED]']);
  });

  it('redacts sensitive URL query params', () => {
    const result = filterArgs('goto', ['https://example.com?api_key=secret&page=1']);
    expect(result[0]).toContain('api_key=%5BREDACTED%5D');
    expect(result[0]).toContain('page=1');
  });

  it('preserves non-sensitive URL query params', () => {
    const result = filterArgs('goto', ['https://example.com?page=1&sort=name']);
    expect(result[0]).toBe('https://example.com?page=1&sort=name');
  });

  it('handles empty args', () => {
    expect(filterArgs('click', [])).toEqual([]);
  });

  it('handles non-URL non-sensitive args', () => {
    expect(filterArgs('click', ['@e3'])).toEqual(['@e3']);
  });
});

describe('emitActivity', () => {
  it('emits with auto-incremented id', () => {
    const e1 = emitActivity({ type: 'command_start', command: 'goto', args: ['https://example.com'] });
    const e2 = emitActivity({ type: 'command_end', command: 'goto', status: 'ok', duration: 100 });
    expect(e2.id).toBe(e1.id + 1);
  });

  it('truncates long results', () => {
    const longResult = 'x'.repeat(500);
    const entry = emitActivity({ type: 'command_end', command: 'text', result: longResult });
    expect(entry.result!.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('applies privacy filtering', () => {
    const entry = emitActivity({ type: 'command_start', command: 'type', args: ['my secret password'] });
    expect(entry.args).toEqual(['[REDACTED]']);
  });
});

describe('getActivityAfter', () => {
  it('returns entries after cursor', () => {
    const e1 = emitActivity({ type: 'command_start', command: 'test1' });
    const e2 = emitActivity({ type: 'command_start', command: 'test2' });
    const result = getActivityAfter(e1.id);
    expect(result.entries.some(e => e.id === e2.id)).toBe(true);
    expect(result.gap).toBe(false);
  });

  it('returns all entries when cursor is 0', () => {
    emitActivity({ type: 'command_start', command: 'test3' });
    const result = getActivityAfter(0);
    expect(result.entries.length).toBeGreaterThan(0);
  });
});

describe('getActivityHistory', () => {
  it('returns limited entries', () => {
    for (let i = 0; i < 5; i++) {
      emitActivity({ type: 'command_start', command: `history-test-${i}` });
    }
    const result = getActivityHistory(3);
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });
});

describe('subscribe', () => {
  it('receives new events', async () => {
    const received: any[] = [];
    const unsub = subscribe((entry) => received.push(entry));

    emitActivity({ type: 'command_start', command: 'sub-test' });

    // queueMicrotask is async — wait a tick
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[received.length - 1].command).toBe('sub-test');
    unsub();
  });

  it('stops receiving after unsubscribe', async () => {
    const received: any[] = [];
    const unsub = subscribe((entry) => received.push(entry));
    unsub();

    emitActivity({ type: 'command_start', command: 'should-not-see' });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received.filter(e => e.command === 'should-not-see').length).toBe(0);
  });
});

import { CircularBuffer } from '../src/buffers';

/** Count toArray calls around fn — the fast paths must not copy the ring. */
function countToArrayCalls<T>(fn: () => T): { result: T; calls: number } {
  const original = CircularBuffer.prototype.toArray;
  let calls = 0;
  CircularBuffer.prototype.toArray = function (this: CircularBuffer<unknown>) {
    calls++;
    return original.call(this);
  };
  try {
    return { result: fn(), calls };
  } finally {
    CircularBuffer.prototype.toArray = original;
  }
}

describe('getActivityAfter — caught-up fast path (#2973)', () => {
  it('a cursor at the newest id returns empty without copying the ring', () => {
    const last = emitActivity({ type: 'command_start', command: 'caught-up' });
    const { result, calls } = countToArrayCalls(() => getActivityAfter(last.id));
    expect(result.entries).toEqual([]);
    expect(result.gap).toBe(false);
    expect(result.totalAdded).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  it('a future cursor also returns empty without copying', () => {
    const last = emitActivity({ type: 'command_start', command: 'future' });
    const { result, calls } = countToArrayCalls(() => getActivityAfter(last.id + 999));
    expect(result.entries).toEqual([]);
    expect(result.gap).toBe(false);
    expect(calls).toBe(0);
  });

  it('a stale cursor still replays new entries and detects gaps', () => {
    const e1 = emitActivity({ type: 'command_start', command: 'stale-1' });
    const e2 = emitActivity({ type: 'command_start', command: 'stale-2' });
    const { result, calls } = countToArrayCalls(() => getActivityAfter(e1.id));
    expect(result.entries.map(e => e.id)).toContain(e2.id);
    expect(calls).toBe(1);
    // Pre-buffer cursor keeps the gap contract.
    const gap = getActivityAfter(-5);
    expect(gap.gap).toBe(true);
    expect(gap.availableFrom).toBeDefined();
  });

  it('cursor 0 still returns the full buffer via the copy path', () => {
    const { result, calls } = countToArrayCalls(() => getActivityAfter(0));
    expect(result.entries.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });
});

describe('getActivityHistory — tail read for positive integer limits (#2973)', () => {
  it('returns the last N entries in order without copying the ring', () => {
    const a = emitActivity({ type: 'command_start', command: 'tail-a' });
    const b = emitActivity({ type: 'command_start', command: 'tail-b' });
    const { result, calls } = countToArrayCalls(() => getActivityHistory(2));
    expect(result.entries.map(e => e.id)).toEqual([a.id, b.id]);
    expect(calls).toBe(0);
  });

  it('a limit above the size returns everything via the same fast path', () => {
    const first = emitActivity({ type: 'command_start', command: 'small-buffer' });
    const { result, calls } = countToArrayCalls(() => getActivityHistory(5000));
    expect(result.entries.some(e => e.id === first.id)).toBe(true);
    expect(calls).toBe(0);
  });

  it('limit=0 keeps the historical everything-back contract', () => {
    const { result, calls } = countToArrayCalls(() => getActivityHistory(0));
    expect(result.entries.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  it('negative and non-integer limits keep the old slice path', () => {
    emitActivity({ type: 'command_start', command: 'neg-limit' });
    const neg = getActivityHistory(-1);
    expect(neg.entries.length).toBeGreaterThan(0);
    const frac = getActivityHistory(2.7);
    expect(frac.entries.length).toBe(2);
    const nan = getActivityHistory(Number.NaN);
    expect(nan.entries.length).toBeGreaterThan(0);
  });
});
