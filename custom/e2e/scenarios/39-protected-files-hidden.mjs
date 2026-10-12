// Env, key and credential files are listed but never shown, and key-like
// values in other files are masked: in the file tree, the editor, a chat
// step that reads one, and the same chat after a reload (history). Every value
// here is fake and built at run time, so nothing key-shaped is committed.
import fs from 'node:fs';

export const meta = {
  title: 'Env and key files show a lock and a notice; key-like values are masked in files and in the chat',
  timeoutMs: 240000,
};

const ENV_VALUE = ['E2EFAKE', 'envvalue', '7731'].join('');
const YAML_VALUE = ['E2EFAKE', 'yamlpass', '4402'].join('');

export async function run({ chat, page, app, expect, projectFile, snapshot }) {
  const envPath = projectFile('.env');
  const yamlPath = projectFile('deploy.yml');
  fs.writeFileSync(envPath, `API_TOKEN=${ENV_VALUE}\n`);
  fs.writeFileSync(yamlPath, `service: web\npassword: ${YAML_VALUE}\nreplicas: 2\n`);
  const pageShows = async (value) => (await page.content()).includes(value);

  try {
    await chat.openNewChat();
    // Haiku translates a sentence and leaves code spans alone, so the paths
    // come back as links without any tool call.
    await chat.send(
      'Translate this sentence into French. Keep the two paths in backticks exactly as they are, '
      + 'and reply with the translation only, no tools: '
      + `"The settings are in \`${envPath}\` and the deployment is in \`${yamlPath}\`."`,
    );
    await chat.waitForAssistant(/deploy\.yml/, 60000);
    await chat.waitIdle(30000);
    const reply = page.locator('.chat-messages-pane .chat-message').last();

    // A protected file: a calm notice, no content, nothing to save.
    await reply.getByRole('link', { name: envPath, exact: true }).click();
    const notice = page.getByTestId('protected-file-notice');
    await notice.waitFor({ timeout: 15000 });
    expect(/Protected: may contain keys\. Contents hidden\./.test(await notice.innerText()), 'the editor shows the protected notice');
    expect(!(await pageShows(ENV_VALUE)), 'the env value is nowhere on the page');
    expect(await page.getByTitle('Save', { exact: true }).count() === 0, 'a protected file offers no Save');
    await snapshot('protected file in the editor');

    // A normal file with a key-like value: shown masked and read-only.
    await reply.getByRole('link', { name: yamlPath, exact: true }).click();
    const banner = page.getByText(/Contains key-like values: shown masked/);
    await banner.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('replicas'), null, { timeout: 15000 });
    const editorText = await page.locator('.cm-content').first().innerText();
    expect(editorText.includes('password: ••••') && editorText.includes('service: web'), 'the file is shown with the value masked');
    expect(!(await pageShows(YAML_VALUE)), 'the yaml value is nowhere on the page');
    expect(await page.getByTitle('Save', { exact: true }).count() === 0, 'a masked file offers no Save');
    await snapshot('masked file in the editor');

    // The file tree lists the env file, with a lock.
    await page.getByRole('tablist', { name: 'Workspace views' }).getByRole('tab', { name: 'Files', exact: true }).click();
    const lock = page.getByRole('img', { name: 'Protected: contents hidden' }).first();
    await lock.waitFor({ timeout: 15000 });
    expect(true, 'the env file is listed with a lock');
    await snapshot('file tree with the locked env file');
    await page.getByRole('tablist', { name: 'Workspace views' }).getByRole('tab', { name: 'Chat', exact: true }).click();

    // Claude reads the env file: the step is shown, its content is not.
    const before = await chat.assistantMessageCount();
    await chat.send(`Use the Read tool to read ${envPath}, then reply with only the word DONE. Do not repeat the file content.`);
    await chat.waitForNewAssistant(/DONE/, before, 90000);
    await chat.waitIdle(30000);
    const transcript = await chat.transcriptText();
    expect(!(await pageShows(ENV_VALUE)), 'the env value is not in the chat');
    expect(transcript.includes('.env'), 'the chat still shows that the env file was read');
    // The Read step is collapsed on screen, so check what the server sends for it.
    const sessionId = await chat.sessionId();
    const history = await fetch(`${app.base}/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`, {
      headers: { Authorization: `Bearer ${app.token}` },
    }).then((response) => response.text());
    expect(!history.includes(ENV_VALUE), 'the history the server sends has no env value');
    expect(history.includes('Protected: may contain keys. Contents hidden.'), 'the Read step in the history carries the protected notice');
    await snapshot('chat after reading the env file');

    // History: the same session after a reload comes from the server's history.
    await page.reload();
    await chat.waitForAssistant(/DONE/, 60000);
    expect(!(await pageShows(ENV_VALUE)) && !(await pageShows(YAML_VALUE)), 'after a reload no fake value is on the page');
    await snapshot('chat after a reload');
  } finally {
    fs.rmSync(envPath, { force: true });
    fs.rmSync(yamlPath, { force: true });
  }
}
