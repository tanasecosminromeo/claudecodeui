// A live session row in the Running view expands into the processes it runs:
// the Bash command the agent is executing shows up as a node while it runs and,
// when the exec tracer is installed, stays there finished with its exit code.
export const meta = {
  title: 'Process tree: the command an agent runs shows under its session; finished commands stay when the tracer is on',
  timeoutMs: 150000,
};

export async function run({ chat, page, app, expect, snapshot, log }) {
  await chat.openNewChat();
  // A bare `sleep` is refused by the Bash tool's guard; a compound command is not.
  await chat.send('Use the Bash tool to run exactly `sleep 35; echo SLEPT` in the foreground (not run_in_background), wait for it to finish, then reply with the single word DONE.');
  await chat.sessionId();
  await chat.waitWorking(30000);

  await page.locator('button:has(svg.lucide-activity)').first().click();
  const panel = page.locator('[data-uic-radar]');
  await panel.waitFor({ timeout: 15000 });
  // The test chat's row, found by its working directory in the tooltip: other live sessions of
  // this user are listed too, and the instance's own database is not the one the radar maps
  // app ids through, so the row is not marked current.
  const row = panel.locator(`.sr-row[title*="${app.project.fullPath}"]`).first();
  await row.waitFor({ timeout: 20000 });
  await row.locator('.sr-chev').click();
  const node = panel.locator('.sr-tree .sr-node', { hasText: 'sleep 35' }).first();
  await node.waitFor({ timeout: 30000 });
  log(`tree: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-uic-radar] .sr-tree .sr-node .sr-cmd')].map((el) => el.textContent.slice(0, 50))))}`);
  expect(!(await node.evaluate((el) => el.classList.contains('sr-dead'))), 'the running sleep is a live node');
  expect(await panel.locator('.sr-tree .sr-node').count() >= 2, 'the claude process and its command are both nodes');
  await snapshot('tree while the command runs');

  const history = (await panel.locator('.sr-tree-note', { hasText: 'make exec-tracer' }).count()) === 0;
  log(`exec tracer ${history ? 'installed: finished commands are kept' : 'not installed: live processes only'}`);

  await chat.waitForAssistant(/DONE/, 90000);
  if (history) {
    const dead = panel.locator('.sr-tree .sr-node.sr-dead', { hasText: 'sleep 35' }).first();
    await dead.waitFor({ timeout: 15000 });
    const meta = await dead.locator('.sr-nmeta').innerText();
    expect(/\d+(\.\d+)?s/.test(meta), `the finished command shows its duration: ${meta}`);
    await snapshot('tree after the command finished');
  } else {
    await page.waitForFunction(() => [...document.querySelectorAll('[data-uic-radar] .sr-tree .sr-cmd')].every((el) => !el.textContent.includes('sleep 35')), null, { timeout: 15000 });
    expect(true, 'without the tracer the finished command leaves the live tree');
    await snapshot('tree after the command finished (no history)');
  }
  await page.evaluate(() => localStorage.removeItem('session-radar-trees'));
}
