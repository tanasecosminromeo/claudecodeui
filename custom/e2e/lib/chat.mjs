// Browser-side helpers: a Playwright page driven the way a person uses the
// chat. Selectors are role/label based (see README "Selectors") so they
// survive styling changes; the few structural ones are called out.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Loads Playwright from wherever it is installed. The app tree never carries
 * it (`npm ci` would drop it); on this machine it lives in the extra modules
 * folder the service also uses for browser automation.
 */
export function loadPlaywright() {
  const candidates = [
    process.env.E2E_PLAYWRIGHT_DIR,
    path.join(process.env.HOME, '.local/share/cloudcli-extra/node_modules'),
    path.resolve(new URL('../../../node_modules', import.meta.url).pathname),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return createRequire(path.join(dir, 'noop.js'))('playwright');
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`playwright not found in: ${candidates.join(', ')} (set E2E_PLAYWRIGHT_DIR)`);
}

const COMPOSER_PLACEHOLDER = /Type \/ for commands/;
const MODE_MENU_BUTTON = 'How should Claude actions be approved?';

/** Labels of the permission-mode menu, by mode id. */
export const MODES = {
  default: 'Default Mode',
  auto: 'Auto Mode',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass Permissions',
  plan: 'Plan Mode',
};

/**
 * A chat page for one scenario. Every browser dialog (window.confirm/alert)
 * is recorded in `dialogs`; by default it is dismissed, and a scenario that
 * expects one sets `onDialog` to decide. An unexpected dialog is a finding —
 * the runner fails the scenario on it unless the scenario allowed it.
 */
export class ChatPage {
  constructor(page, { base, projectName }) {
    this.page = page;
    this.base = base;
    this.projectName = projectName;
    this.dialogs = [];
    this.consoleErrors = [];
    this.onDialog = null;
    page.on('dialog', async (dialog) => {
      const entry = { type: dialog.type(), message: dialog.message(), at: new Date().toISOString() };
      this.dialogs.push(entry);
      // onDialog may return a string: the answer typed into a prompt().
      const accept = this.onDialog ? await this.onDialog(entry) : false;
      entry.accepted = Boolean(accept);
      if (typeof accept === 'string') {
        await dialog.accept(accept);
      } else if (accept) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        this.consoleErrors.push(message.text());
      }
    });
  }

  composer() {
    return this.page.getByPlaceholder(COMPOSER_PLACEHOLDER);
  }

  /** Opens the app on the test project with a brand-new chat. */
  async openNewChat() {
    await this.page.goto(`${this.base}/`);
    await this.page.getByRole('button', { name: new RegExp(`^${this.projectName}`) }).click();
    const newSession = this.page.getByRole('button', { name: 'New Session' });
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click();
    }
    await this.composer().waitFor({ timeout: 20000 });
  }

  /** Types a message and sends it with the Send button (Enter where the button is a Stop control). */
  async send(text) {
    await this.composer().fill(text);
    const sendButton = this.page.getByRole('button', { name: 'Send', exact: true });
    if (await sendButton.isVisible().catch(() => false)) {
      await sendButton.click();
    } else {
      // While Claude works the button is Stop; Enter still submits.
      await this.composer().press('Enter');
    }
  }

  /** The app session id from the URL (/session/<id>), once the first send created it. */
  async sessionId(timeoutMs = 30000) {
    await this.page.waitForURL(/\/session\//, { timeout: timeoutMs });
    return new URL(this.page.url()).pathname.split('/').pop();
  }

  /**
   * The composer's Stop control: its send button turns into Stop exactly
   * while a turn runs. Not any "Stop" — the background-task strip has a Stop
   * per task (which stops that task) and stays while work runs after the turn.
   */
  turnStopButton() {
    return this.page.locator('form button[aria-label="Stop"]');
  }

  /** Whether a turn is running. */
  async isWorking() {
    return this.turnStopButton().isVisible().catch(() => false);
  }

  async waitWorking(timeoutMs = 30000) {
    await this.turnStopButton().waitFor({ state: 'visible', timeout: timeoutMs });
  }

  async waitIdle(timeoutMs = 120000) {
    await this.turnStopButton().waitFor({ state: 'hidden', timeout: timeoutMs });
  }

  /** Presses the composer's Stop (ends the turn, as Esc does). */
  async stopTurn() {
    await this.turnStopButton().click();
  }

  /**
   * Text of Claude's replies only (`.chat-message.assistant`) — the user's own
   * message often contains the word a check looks for.
   */
  async assistantText() {
    return this.page.locator('.chat-message.assistant').allInnerTexts().then((texts) => texts.join('\n'));
  }

  /** How many assistant message rows the transcript shows. */
  async assistantMessageCount() {
    return this.page.locator('.chat-message.assistant').count();
  }

  /**
   * Waits for an assistant message after the first `afterCount` ones to match
   * `pattern`. Use it for "Claude said X later": tool blocks render the
   * commands Claude ran, so a word from a command is already on screen.
   */
  async waitForNewAssistant(pattern, afterCount, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const texts = await this.page.locator('.chat-message.assistant').allInnerTexts();
      last = texts.slice(afterCount).join('\n');
      if (pattern.test(last)) {
        return last;
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error(`no new assistant message matched ${pattern} within ${timeoutMs / 1000}s; new text:\n${last.slice(-1500)}`);
  }

  /** Text of the whole transcript, user messages included. */
  async transcriptText() {
    return this.page.locator('.chat-message').allInnerTexts().then((texts) => texts.join('\n'));
  }

  /** Waits until Claude's replies match `pattern`. */
  async waitForAssistant(pattern, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = await this.assistantText();
      if (pattern.test(last)) {
        return last;
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error(`assistant never matched ${pattern} within ${timeoutMs / 1000}s; last replies:\n${last.slice(-1500)}`);
  }

  /** Picks a permission mode from the composer's mode menu. */
  async setMode(mode) {
    await this.page.getByRole('button', { name: MODE_MENU_BUTTON }).click();
    // Picking an item closes the menu. No Escape: while Claude works, Escape
    // outside a popup is the Stop shortcut.
    await this.page.getByRole('menuitemradio', { name: new RegExp(`^${MODES[mode]}`) }).click();
    const closed = await this.page.getByRole('menuitemradio').first()
      .waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
    if (!closed) {
      await this.page.getByRole('button', { name: MODE_MENU_BUTTON }).click();
    }
  }

  /** The permission mode the selector shows (its checked menu item). */
  async currentMode() {
    await this.page.getByRole('button', { name: MODE_MENU_BUTTON }).click();
    const checked = this.page.locator('[role=menuitemradio][aria-checked=true]');
    const label = (await checked.first().innerText()).split('\n')[0].trim();
    // Close by toggling the button (see setMode on Escape).
    await this.page.getByRole('button', { name: MODE_MENU_BUTTON }).click();
    await this.page.getByRole('menuitemradio').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return Object.keys(MODES).find((mode) => MODES[mode] === label) ?? label;
  }

  /** Whether a tool-approval prompt is showing. */
  async hasApprovalPrompt() {
    return this.page.getByRole('button', { name: 'Allow once' }).first().isVisible().catch(() => false);
  }

  async waitForApprovalPrompt(timeoutMs = 60000) {
    await this.page.getByRole('button', { name: 'Allow once' }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }

  async allowOnce() {
    await this.page.getByRole('button', { name: 'Allow once' }).first().click();
  }

  /** Saves a screenshot and the visible transcript for a failure report. */
  async capture(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    await this.page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
    const transcript = await this.transcriptText().catch(() => '(unavailable)');
    fs.writeFileSync(path.join(dir, `${name}.transcript.txt`), transcript);
  }
}
