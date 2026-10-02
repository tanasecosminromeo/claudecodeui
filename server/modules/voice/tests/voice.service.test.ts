import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceService } from '../voice.service.js';

const defaults = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
};

test('reports whether the server-controlled backend is configured', () => {
  const service = createVoiceService({
    defaults: { ...defaults, baseUrl: '' },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('fetch should not run');
    },
  });

  assert.deepEqual(service.getHealth(), { configured: false });
});

test('transcribes with injected fetch and request-level credential/model overrides', async () => {
  let requestedUrl = '';
  let requestedOptions: RequestInit | undefined;
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    },
  });

  const result = await service.transcribe({
    audio: {
      bytes: Buffer.from('audio'),
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    },
    overrides: { apiKey: 'request-key', sttModel: 'custom-whisper' },
  });

  assert.deepEqual(result, { ok: true, value: { text: 'hello' } });
  assert.equal(requestedUrl, 'https://voice.example/v1/audio/transcriptions');
  assert.ok(requestedOptions, 'fetchBackend should receive request options');
  assert.equal((requestedOptions.headers as Record<string, string>).Authorization, 'Bearer request-key');
  assert.equal((requestedOptions.body as FormData).get('model'), 'custom-whisper');
});

test('forwards the explicit TTS format and maps backend authentication failures', async () => {
  let requestBody = '';
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async (_url, options) => {
      requestBody = String(options.body);
      return new Response('unauthorized', { status: 401 });
    },
  });

  const result = await service.synthesizeSpeech({
    text: 'Read this',
    overrides: { ttsFormat: 'wav' },
  });

  assert.deepEqual(JSON.parse(requestBody), {
    model: 'tts-1',
    voice: 'alloy',
    input: 'Read this',
    response_format: 'wav',
  });
  assert.deepEqual(result, {
    ok: false,
    status: 502,
    error: 'Voice backend rejected the request (check the API key).',
  });
});

test('blocks link-local metadata destinations before calling the fetch adapter', async () => {
  let fetchCalls = 0;
  const service = createVoiceService({
    defaults: { ...defaults, baseUrl: 'http://169.254.169.254/latest' },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });

  const result = await service.synthesizeSpeech({ text: 'hello', overrides: {} });

  assert.deepEqual(result, { ok: false, status: 400, error: 'Invalid voice backend URL.' });
  assert.equal(fetchCalls, 0);
});

test('summarises through the backend summary route and unwraps its errors', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  let reply: Response = new Response(JSON.stringify({
    text: 'Both changes work.', voice: 'en_US-lessac-medium', language: 'en', prepared: 'summary',
  }), { status: 200 });
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async (url, options) => {
      requests.push({ url, body: String(options.body) });
      return reply;
    },
  });

  const ok = await service.summarizeSpeech({ text: '## Report', overrides: {} });
  assert.deepEqual(ok, { ok: true, value: { text: 'Both changes work.', language: 'en', prepared: 'summary' } });
  assert.equal(requests[0].url, 'https://voice.example/v1/audio/speech/summary');
  assert.deepEqual(JSON.parse(requests[0].body), { voice: 'alloy', input: '## Report' });

  reply = new Response(JSON.stringify({ error: { code: 400, message: 'nothing to summarise' } }), { status: 400 });
  assert.deepEqual(await service.summarizeSpeech({ text: 'x', overrides: {} }),
    { ok: false, status: 400, error: 'nothing to summarise' });

  // A plain OpenAI-compatible backend has no such route.
  reply = new Response('not found', { status: 404 });
  const missing = await service.summarizeSpeech({ text: 'x', overrides: {} });
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.status, 501);
});
