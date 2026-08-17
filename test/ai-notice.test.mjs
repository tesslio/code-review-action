import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_SYSTEM_NOTICE,
  withAiSystemNotice,
} from '../src/ai-notice.mjs';

test('appends the hidden AI-system notice exactly once', () => {
  const noticed = withAiSystemNotice('Review body.');
  assert.equal(noticed, `Review body.\n\n${AI_SYSTEM_NOTICE}`);
  assert.equal(withAiSystemNotice(noticed), noticed);
  assert.equal(withAiSystemNotice(''), AI_SYSTEM_NOTICE);
});
