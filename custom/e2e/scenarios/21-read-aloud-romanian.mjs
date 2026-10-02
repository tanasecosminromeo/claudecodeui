// The speaker button on a reply reads it aloud through the local speech stack
// (llama.cpp's stt proxy -> Piper), in the reply's own language. Proven by
// playing it and by transcribing the MP3 it got back with Parakeet: a
// Romanian reply must come back as Romanian words. Needs VOICE_API_BASE_URL
// in this checkout's .env, as the live service has it.
export const meta = {
  title: 'Read aloud speaks a Romanian reply in Romanian',
  timeoutMs: 150000,
};

export async function run({ chat, page, app, expect, snapshot, log }) {
  const health = await fetch(`${app.base}/api/voice/health`, {
    headers: { Authorization: `Bearer ${app.token}` },
  }).then((response) => response.json());
  expect(health?.configured === true, 'the instance has a voice backend (VOICE_API_BASE_URL)');

  const saved = await fetch(`${app.base}/api/user/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` },
    body: JSON.stringify({ uiPreferences: { voiceEnabled: true } }),
  });
  expect(saved.ok, `voice turned on in preferences (${saved.status})`);

  await chat.openNewChat();
  await chat.send('Translate into Romanian, and reply with only the translation: '
    + '"The tests pass and the file is saved in the project folder."');
  await chat.waitForAssistant(/teste/i, 60000);
  await chat.waitIdle(30000);
  const reply = (await page.locator('.chat-message.assistant').last().locator('.prose').first().innerText()).trim();
  log(`reply: "${reply}"`);

  const speak = page.locator('.chat-message.assistant').last().getByRole('button', { name: 'Read aloud' });
  await speak.waitFor({ timeout: 10000 });
  const ttsResponse = page.waitForResponse((response) => response.url().includes('/api/voice/tts'), { timeout: 60000 });
  await speak.click();
  const response = await ttsResponse;
  expect(
    response.status() === 200 && (response.headers()['content-type'] || '').startsWith('audio/'),
    `the click got audio back (${response.status()} ${response.headers()['content-type']})`,
  );

  const playing = page.locator('.chat-message.assistant').last().getByRole('button', { name: 'Stop' });
  const played = await playing.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  await snapshot('reading the reply aloud');
  expect(played, 'the browser is playing it (the button turned into Stop)');

  // Back through speech-to-text: what was spoken, and in which language.
  // Playwright cannot read a streamed body, so ask the same route again.
  const again = await fetch(`${app.base}/api/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` },
    body: JSON.stringify({ text: reply }),
  });
  const audio = new Uint8Array(await again.arrayBuffer());
  expect(again.ok && audio.length > 1000, `/api/voice/tts returns the speech (${again.status}, ${audio.length} bytes)`);
  const sttBase = (process.env.VOICE_API_BASE_URL || 'http://127.0.0.1:18791/v1').replace(/\/$/, '');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'speech.mp3');
  form.append('model', 'parakeet');
  const heard = await fetch(`${sttBase}/audio/transcriptions`, { method: 'POST', body: form })
    .then((r) => r.json()).then((body) => String(body.text || ''));
  log(`heard: "${heard}"`);
  const normalise = (text) => text.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '');
  const expected = normalise(reply).split(' ').filter(Boolean);
  const got = new Set(normalise(heard).split(' '));
  const matched = expected.filter((word) => got.has(word)).length;
  expect(matched >= expected.length - 1, `Parakeet hears the Romanian reply back (${matched}/${expected.length} words)`);
}
