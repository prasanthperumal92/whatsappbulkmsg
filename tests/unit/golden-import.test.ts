import { describe, expect, it } from 'vitest';
import golden from '../../evals/golden/phone-normalisation.json';

// T1.1: goldens load through the import shown in evals/README.md.
describe.each(golden.cases.slice(0, 3))('$id', ({ id }) => {
  it('has an id from the PN series', () => expect(id).toMatch(/^PN-\d+$/));
});

it('loads every phone golden', () => {
  expect(golden.cases.length).toBeGreaterThanOrEqual(32);
});
