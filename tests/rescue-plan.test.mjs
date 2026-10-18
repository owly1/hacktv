import test from 'node:test';
import assert from 'node:assert/strict';
import { rescueSequence, buildRescuePlan } from '../backend/server.mjs';

const lead = (number, over) => ({
  id: `lead-${number}`, number, title: `Candidate — Target ${number}`, closed: false,
  priority: {tier: 4, base_tier: 4, reasons: []}, fire_distance_m: 500, fire_arrival: null,
  at_fire: false, last_seen_age_s: 30, movement: {status: 'moving'}, uncertainty: {major_95_m: 10},
  ...over,
});

test('rescueSequence orders at-fire leads first, then by arrival, distance', () => {
  const ranked = rescueSequence([
    lead(3, {fire_arrival: {minutes: 40}, fire_distance_m: 200}),
    lead(1, {at_fire: true, priority: {tier: 0, base_tier: 0}}),
    lead(2, {fire_arrival: {minutes: 10}, fire_distance_m: 900}),
    lead(4, {fire_arrival: null, fire_distance_m: 50}),
  ]);
  assert.deepEqual(ranked.map(r => r.lead.number), [1, 2, 3, 4]);
});

test('urgency rises when the fire is closer and the sighting is stale', () => {
  const [fresh] = rescueSequence([lead(1, {fire_arrival: {minutes: 60}, last_seen_age_s: 10})]);
  const [stale] = rescueSequence([lead(1, {fire_arrival: {minutes: 5}, last_seen_age_s: 300, fire_distance_m: 30})]);
  assert.ok(stale.urgency > fresh.urgency, `${stale.urgency} !> ${fresh.urgency}`);
});

test('buildRescuePlan honours Gemini order for known leads and appends the rest deterministically', () => {
  const ranked = rescueSequence([lead(1), lead(2), lead(3)]);
  const plan = buildRescuePlan(ranked, {
    summary: 's', first_task: 'f',
    sequence: [{lead_number: 3, reason: 'closest to ground crew'}, {lead_number: 99, reason: 'ghost'}],
    risks: ['wind shift'],
  }, {provenance: 'gemini', model: 'm', nowMs: 0});
  assert.deepEqual(plan.sequence.map(s => s.lead_number), [3, 1, 2]);
  assert.equal(plan.sequence[0].reason, 'closest to ground crew');
  assert.ok(plan.sequence[1].reason.length > 0);
  assert.equal(plan.provenance, 'gemini');
  assert.match(plan.basis, /Urgency 0-100/);
});

test('buildRescuePlan works without Gemini output (deterministic fallback)', () => {
  const ranked = rescueSequence([lead(2, {fire_arrival: {minutes: 8}}), lead(1)]);
  const plan = buildRescuePlan(ranked, null, {provenance: 'deterministic', model: 'm', nowMs: 0});
  assert.equal(plan.sequence.length, 2);
  assert.equal(plan.sequence[0].lead_number, 2);
  assert.match(plan.sequence[0].reason, /8 min/);
});
