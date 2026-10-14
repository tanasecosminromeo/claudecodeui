// The "needs input" chime plays once per new need for input, never when a chat
// is opened, reloaded or revisited. Two AskUserQuestion prompts in one turn:
// each new prompt chimes once, a revisit or reload of a still-open prompt does
// not, and a session that the Session Radar newly reports as waiting (a fake
// one here, in this browser only) chimes once more. Chimes are counted from the
// oscillators the notification sound starts, kept in sessionStorage so they
// survive the reloads.
export const meta = {
  title: 'The needs-input chime plays for each new question, not on open, reload or revisit',
  timeoutMs: 300000,
  mode: 'default',
};

const FAKE = {
  sessionId: 'e2e-fake-waiting-session',
  state: 'waiting',
  title: 'E2E fake session waiting for input (chime test)',
  project: 'e2e-project',
};

/** Groups oscillator start times into chimes: a gap of more than 400 ms starts a new one. */
const countChimes = (starts) => {
  let chimes = 0;
  let last = -Infinity;
  for (const at of starts) {
    if (at - last > 400) chimes += 1;
    last = at;
  }
  return chimes;
};

export async function run({ chat, page, app, expect, snapshot, sleep }) {
  let waitingFake = false;
  // The browser's copy of the Session Radar answer: no sessions unless a step adds the fake one.
  await page.route('**/api/plugins/*/rpc/sessions', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    await route.fulfill({ response, json: { ...body, sessions: waitingFake ? [FAKE] : [] } });
  });

  // Runs before each document of this page, so it also covers the reloads.
  await page.addInitScript(() => {
    localStorage.setItem('notificationSoundEnabled', 'true');
    const read = () => JSON.parse(sessionStorage.getItem('e2e-chimes') || '[]');
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Ctor = window[name];
      if (!Ctor || Ctor.prototype.__e2eChimeWrapped) continue;
      Ctor.prototype.__e2eChimeWrapped = true;
      const createOscillator = Ctor.prototype.createOscillator;
      Ctor.prototype.createOscillator = function (...args) {
        const oscillator = createOscillator.apply(this, args);
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...when) => {
          sessionStorage.setItem('e2e-chimes', JSON.stringify([...read(), Date.now()]));
          return start(...when);
        };
        return oscillator;
      };
    }
  });

  const chimes = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-chimes') || '[]')).then(countChimes);
  const cardCount = () => page.getByText('Claude needs your input', { exact: true }).count();
  const card = (question) => page.getByRole('radiogroup', { name: question, exact: true });
  /** Polls `read` until it returns `want` or the time runs out; returns the last value read. */
  const settle = async (read, want, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (value !== want && Date.now() < deadline) {
      await page.waitForTimeout(250);
      value = await read();
    }
    return value;
  };
  const answer = async (question, option) => {
    await card(question).getByRole('button', { name: new RegExp(option) }).click({ timeout: 10000 });
    await page.getByRole('button', { name: /^Submit/ }).click({ timeout: 5000 });
  };

  try {
    // Step 1: the first turn asks two questions, one after the other.
    await chat.openNewChat();
    await chat.send('Use the AskUserQuestion tool to ask me "First?" with the options "Yes" and "No". '
      + 'After I answer, use the AskUserQuestion tool again to ask me "Second?" with the options "Yes" and "No". '
      + 'After I answer that too, reply with DONE.');

    // Step 2: one chime for "First?", answering it removes its card, and "Second?" chimes once more.
    await card('First?').waitFor({ state: 'visible', timeout: 120000 });
    await sleep(1500);
    const afterFirst = await chimes();
    expect(afterFirst === 1, `"First?" showed: exactly 1 chime (got ${afterFirst})`);

    const sessionUrl = `${app.base}/session/${await chat.sessionId()}`;
    await answer('First?', 'Yes');
    const firstGone = await settle(() => card('First?').count(), 0, 15000);
    expect(firstGone === 0, `answering "First?" removes its card (cards left: ${firstGone})`);

    await card('Second?').waitFor({ state: 'visible', timeout: 120000 });
    await sleep(1500);
    const afterSecond = await chimes();
    expect(afterSecond === 2, `"Second?" showed: exactly 2 chimes in total (got ${afterSecond})`);
    const cardsAtSecond = await settle(cardCount, 1, 10000);
    const firstLeft = await card('First?').count();
    expect(cardsAtSecond === 1 && firstLeft === 0, `"Second?" showed: exactly one question card, none for "First?" (cards: ${cardsAtSecond}, "First?" cards: ${firstLeft})`);
    await snapshot('Second? shown: one card, two chimes');

    // Step 3: open another chat, then come back to this one by its URL. Opening it must not chime.
    await chat.openNewChat();
    await page.goto(sessionUrl);
    await sleep(8000);
    const afterRevisit = await chimes();
    const revisitCards = await settle(cardCount, 1, 10000);
    const revisitFirst = await card('First?').count();
    expect(afterRevisit === 2, `opening the chat again: no new chime (chimes: ${afterRevisit})`);
    expect(revisitCards === 1 && revisitFirst === 0, `opening the chat again: still one card, "Second?" (cards: ${revisitCards}, "First?": ${revisitFirst})`);

    // Step 4: a reload of the same chat must not chime either.
    await page.reload();
    await sleep(8000);
    const afterReload = await chimes();
    const reloadCards = await settle(cardCount, 1, 10000);
    const reloadFirst = await card('First?').count();
    expect(afterReload === 2, `reload: no new chime (chimes: ${afterReload})`);
    expect(reloadCards === 1 && reloadFirst === 0, `reload: still one card, "Second?" (cards: ${reloadCards}, "First?": ${reloadFirst})`);

    // Step 5: the radar newly reports a waiting session: one chime, then none while it keeps waiting.
    waitingFake = true;
    const radarChime = await settle(chimes, 3, 15000);
    expect(radarChime === 3, `a session newly waiting in the radar: one chime (chimes: ${radarChime})`);
    await sleep(8000);
    const stillWaiting = await chimes();
    expect(stillWaiting === 3, `the radar session keeps waiting: no further chime (chimes: ${stillWaiting})`);

    // Step 6: back to empty, answer "Second?", and the turn ends with DONE.
    waitingFake = false;
    await answer('Second?', 'Yes');
    await chat.waitForAssistant(/\bDONE\b/, 120000);
    expect(true, 'Second? answered and Claude replied DONE');
  } finally {
    waitingFake = false;
    await page.unroute('**/api/plugins/*/rpc/sessions');
  }
}
