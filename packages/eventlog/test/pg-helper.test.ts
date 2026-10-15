import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTestSchema } from './pg-helper.js';

describe('withTestSchema', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.LOOPWORK_TEST_DATABASE_URL;
    delete process.env.LOOPWORK_TEST_DATABASE_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOPWORK_TEST_DATABASE_URL;
    else process.env.LOOPWORK_TEST_DATABASE_URL = saved;
  });

  it('throws a clear error naming LOOPWORK_TEST_DATABASE_URL when it is unset (never skips)', async () => {
    await expect(withTestSchema()).rejects.toThrow(/LOOPWORK_TEST_DATABASE_URL/);
  });
});
