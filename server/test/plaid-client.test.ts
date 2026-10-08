import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LinkTokenGetSessionsResponse } from 'plaid';
import { mapLinkSessions } from '../src/plaid/client.ts';

const T = '2026-03-15T12:00:00Z';
const exited: LinkTokenGetSessionsResponse = { link_session_id: 'ls-exit', finished_at: T, exit: { error: null, metadata: null } };
const success: LinkTokenGetSessionsResponse = {
  link_session_id: 'ls-ok', finished_at: T,
  results: {
    item_add_results: [{ public_token: 'public-synthetic', accounts: [], institution: { name: 'Synthetic Bank', institution_id: 'ins_0' } }],
    cra_item_add_results: [], cra_update_results: [], bank_income_results: [], payroll_income_results: [], document_income_results: null,
  },
};
const onSuccess: LinkTokenGetSessionsResponse = { link_session_id: 'ls-cb', finished_at: T, on_success: { public_token: 'public-cb', metadata: null } };
const unfinished: LinkTokenGetSessionsResponse = { link_session_id: 'ls-open', started_at: T };
const updateMode: LinkTokenGetSessionsResponse = { link_session_id: 'ls-upd', finished_at: T };
const complete = { status: 'complete', publicToken: 'public-synthetic', institutionName: 'Synthetic Bank' };

test('a success in any session wins regardless of order', () => {
  assert.deepEqual(mapLinkSessions([exited, success]), complete);
  assert.deepEqual(mapLinkSessions([success, exited]), complete);
  assert.deepEqual(mapLinkSessions([exited, onSuccess]), { status: 'complete', publicToken: 'public-cb', institutionName: null });
});

test('unfinished or no session is pending; only exits is exited', () => {
  assert.deepEqual(mapLinkSessions([unfinished]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([exited, unfinished]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([]), { status: 'pending' });
  assert.deepEqual(mapLinkSessions([exited]), { status: 'exited' });
});

test('a finished update-mode session with no results completes without a token', () => {
  assert.deepEqual(mapLinkSessions([updateMode]), { status: 'complete', publicToken: null, institutionName: null });
});
