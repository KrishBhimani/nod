import assert from 'node:assert/strict';
import test from 'node:test';
import { currentUserTime } from '../src/runtime/time-context.ts';

test('Lisbon local time keeps the correct date and UTC offset across both DST transitions', () => {
  for (const [utc, local] of [
    ['2026-03-29T00:59:00Z', '2026-03-29T00:59:00+00:00'],
    ['2026-03-29T01:00:00Z', '2026-03-29T02:00:00+01:00'],
    ['2026-09-25T11:39:37Z', '2026-09-25T12:39:37+01:00'],
    ['2026-10-25T00:59:00Z', '2026-10-25T01:59:00+01:00'],
    ['2026-10-25T01:00:00Z', '2026-10-25T01:00:00+00:00'],
  ]) {
    const context = currentUserTime(undefined, new Date(utc!));
    assert.ok(context.includes(`Current local time: ${local}.`), context);
    assert.ok(context.includes(`Current UTC time: ${new Date(utc!).toISOString()}.`));
    assert.ok(context.includes('User time zone: Europe/Lisbon.'));
    assert.equal(new Date(local!).getTime(), new Date(utc!).getTime());
  }
});

test('owner time zones use their own calendar day and fractional offset', () => {
  for (const [timeZone, local] of [
    ['America/Los_Angeles', '2026-09-24T17:15:00-07:00'],
    ['Asia/Kathmandu', '2026-09-25T06:00:00+05:45'],
    ['Pacific/Auckland', '2026-09-25T12:15:00+12:00'],
    ['UTC', '2026-09-25T00:15:00+00:00'],
  ]) {
    const context = currentUserTime(timeZone, new Date('2026-09-25T00:15:00Z'));
    assert.ok(context.includes(`Current local time: ${local}.`), context);
    assert.ok(context.includes(`User time zone: ${timeZone}.`));
  }
});
