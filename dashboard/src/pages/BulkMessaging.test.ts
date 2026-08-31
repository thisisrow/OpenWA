import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageTemplate, Session } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const TEMPLATE: MessageTemplate = {
  id: 'template-1',
  sessionId: SESSION.id,
  name: 'welcome',
  header: 'Hello {{name}}',
  body: 'Your slot is {{slot}}.',
  footer: 'Thanks',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];
let batchCounter = 0;
let holdBatchStatus = false;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetFetchCalls(): void {
  fetchCalls.length = 0;
  batchCounter = 0;
  holdBatchStatus = false;
}

function callsFor(method: string, path: string): FetchCall[] {
  return fetchCalls.filter(call => call.method === method && call.path === path);
}

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ method, path, body });

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION]));
    if (method === 'GET' && path === `/api/sessions/${SESSION.id}/templates`) {
      return Promise.resolve(jsonResponse([TEMPLATE]));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION.id}/messages/send-bulk`) {
      batchCounter += 1;
      const totalMessages = ((body as { messages?: unknown[] } | undefined)?.messages ?? []).length;
      return Promise.resolve(
        jsonResponse(
          {
            batchId: `batch-${batchCounter}`,
            status: 'pending',
            totalMessages,
            statusUrl: `/api/sessions/${SESSION.id}/messages/batch/batch-${batchCounter}`,
          },
          202,
        ),
      );
    }

    const batchMatch = path.match(/^\/api\/sessions\/session-1\/messages\/batch\/([^/]+)$/);
    if (method === 'GET' && batchMatch) {
      const batchId = batchMatch[1];
      const post = fetchCalls
        .filter(call => call.method === 'POST' && call.path === `/api/sessions/${SESSION.id}/messages/send-bulk`)
        [Number(batchId.replace('batch-', '')) - 1] as FetchCall | undefined;
      const messages = ((post?.body as { messages?: Array<{ chatId: string }> } | undefined)?.messages ?? []).map(
        message => message.chatId,
      );
      const status = holdBatchStatus ? 'processing' : 'completed';
      return Promise.resolve(
        jsonResponse({
          batchId,
          status,
          progress:
            status === 'completed'
              ? { total: messages.length, sent: messages.length, failed: 0, pending: 0, cancelled: 0 }
              : { total: messages.length, sent: 0, failed: 0, pending: messages.length, cancelled: 0 },
          results:
            status === 'completed'
              ? messages.map(chatId => ({ chatId, status: 'sent', messageId: `wamid.${chatId}`, sentAt: '2026-01-01T00:00:00.000Z' }))
              : [],
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: status === 'completed' ? '2026-01-01T00:00:01.000Z' : null,
        }),
      );
    }

    const cancelMatch = path.match(/^\/api\/sessions\/session-1\/messages\/batch\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      return Promise.resolve(
        jsonResponse({
          batchId: cancelMatch[1],
          status: 'cancelled',
          progress: { total: 10, sent: 0, failed: 0, pending: 0, cancelled: 10 },
        }),
      );
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

type RTL = typeof import('@testing-library/react');
type BulkMessagingModule = typeof import('./BulkMessaging.tsx');
type RoleModule = typeof import('../components/RoleProvider.tsx');
type ToastModule = typeof import('../components/Toast.tsx');

let rtl: RTL;
let BulkMessaging: BulkMessagingModule['BulkMessaging'];
let RoleProvider: RoleModule['RoleProvider'];
let ToastProvider: ToastModule['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  window.localStorage.setItem('openwa_user_role', 'admin');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ BulkMessaging } = await import('./BulkMessaging.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderBulkMessaging(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(BulkMessaging))),
    ),
  );
}

function recipients(count: number): string {
  return Array.from({ length: count }, (_, index) => `1555000${String(index + 1).padStart(4, '0')}`).join('\n');
}

test('start is disabled until the campaign has recipients and message content', async () => {
  const { screen, fireEvent } = rtl;
  resetFetchCalls();
  renderBulkMessaging();

  const start = (await screen.findByRole('button', { name: 'Start Campaign' })) as HTMLButtonElement;
  assert.equal(start.disabled, true);

  fireEvent.change(screen.getByLabelText('Recipients'), {
    target: { value: recipients(10) },
  });
  assert.equal(start.disabled, true);

  fireEvent.change(screen.getByPlaceholderText('Enter your message here...'), {
    target: { value: 'Hello campaign' },
  });
  assert.equal(start.disabled, false);
});

test('a campaign splits recipients into sequential 10-30 sized backend batches and returns to startable when complete', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  renderBulkMessaging();

  await screen.findByText('Main (15551234567)');
  fireEvent.change(screen.getByLabelText('Recipients'), {
    target: { value: recipients(12) },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter your message here...'), {
    target: { value: 'Hello campaign' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start Campaign' }));

  await waitFor(
    () => {
      assert.equal(callsFor('POST', `/api/sessions/${SESSION.id}/messages/send-bulk`).length, 2);
    },
    { timeout: 6000 },
  );

  const posts = callsFor('POST', `/api/sessions/${SESSION.id}/messages/send-bulk`);
  assert.equal(((posts[0].body as { messages: unknown[] }).messages).length, 10);
  assert.equal(((posts[1].body as { messages: unknown[] }).messages).length, 2);
  assert.deepEqual((posts[0].body as { messages: Array<{ type: string; content: { text: string } }> }).messages[0], {
    chatId: '15550000001@c.us',
    type: 'text',
    content: { text: 'Hello campaign' },
  });

  const start = screen.getByRole('button', { name: 'Start Campaign' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(start.disabled, false), { timeout: 5000 });
});

test('stop cancels the active backend batch and does not start later chunks', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  holdBatchStatus = true;
  renderBulkMessaging();

  await screen.findByText('Main (15551234567)');
  fireEvent.change(screen.getByLabelText('Recipients'), {
    target: { value: recipients(25) },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter your message here...'), {
    target: { value: 'Stop me' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start Campaign' }));

  await waitFor(() => {
    assert.equal(callsFor('POST', `/api/sessions/${SESSION.id}/messages/send-bulk`).length, 1);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop Campaign' }));

  await waitFor(() => {
    assert.equal(callsFor('POST', `/api/sessions/${SESSION.id}/messages/batch/batch-1/cancel`).length, 1);
  });
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(callsFor('POST', `/api/sessions/${SESSION.id}/messages/send-bulk`).length, 1);
});

test('template selection renders the saved template into bulk text messages', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetFetchCalls();
  renderBulkMessaging();

  await screen.findByText('Main (15551234567)');
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Saved Template' }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole('button', { name: 'Saved Template' }));
  fireEvent.change(screen.getByLabelText('Recipients'), {
    target: { value: recipients(10) },
  });
  fireEvent.change(screen.getByLabelText('{{name}}'), { target: { value: 'Alice' } });
  fireEvent.change(screen.getByLabelText('{{slot}}'), { target: { value: '9 AM' } });
  await screen.findByText(/Hello Alice/);

  fireEvent.click(screen.getByRole('button', { name: 'Start Campaign' }));
  await waitFor(() => {
    const post = callsFor('POST', `/api/sessions/${SESSION.id}/messages/send-bulk`)[0];
    assert.ok(post);
    assert.match(
      (post.body as { messages: Array<{ content: { text: string } }> }).messages[0].content.text,
      /Hello Alice/,
    );
  });
});
