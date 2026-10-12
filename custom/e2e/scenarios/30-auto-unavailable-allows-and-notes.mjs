import fs from 'node:fs';

// Same as 29, on Haiku. Requests in auto mode are never prompted. The CLI 2.1.296
// accepts auto mode on this model and runs the command without asking CloudCLI,
// so the "Auto-allowed Bash: …" note appears only when the CLI does ask (live only).
// The note is optional: it is checked if seen, and its absence is logged.
export const meta = {
  title: 'Auto mode on a model without it: requests in auto are never prompted; the note shows only when the CLI asks',
  timeoutMs: 300000,
  mode: 'default',
  model: 'haiku',
};

export async function run({ chat, page, expect, sleep, projectFile, snapshot }) {
  fs.rmSync(projectFile('bg-proof.txt'), { force: true });
  await chat.openNewChat();
  await chat.setMode('plan');
  expect(await chat.currentMode() === 'plan', 'switched to plan mode');

  await chat.send(
    'Present a one-line plan with ExitPlanMode first. The plan: read /etc/hostname, /etc/os-release and /etc/hosts with the Read tool, one at a time; '
    + 'then launch one Agent with run_in_background: true and subagent_type "general-purpose", whose task is to run `echo ok > bg-proof.txt` with the Bash tool '
    + `in ${projectFile('')}; then wait for its notification and reply DONE.`,
  );
  const build = page.getByRole('button', { name: /^Build/ });
  await build.waitFor({ state: 'visible', timeout: 90000 });
  await build.click();
  await chat.setMode('auto');
  expect(await chat.currentMode() === 'auto', 'switched to auto right after Build');

  let prompted = false;
  for (let i = 0; i < 180 && !fs.existsSync(projectFile('bg-proof.txt')); i++) {
    if (!prompted && await chat.hasApprovalPrompt()) {
      prompted = true;
      await snapshot('an approval prompt after switching to auto');
    }
    await sleep(1000);
  }
  expect(fs.existsSync(projectFile('bg-proof.txt')), 'the background agent wrote bg-proof.txt');
  expect(!prompted, 'no approval prompt appeared after switching to auto');
  // The note is optional: CloudCLI writes it only when the CLI asks it for approval.
  const note = page.getByText(/Auto-allowed Bash: .*bg-proof\.txt/).first();
  const noted = await note.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (noted) {
    expect(true, 'the chat notes the auto-allowed command');
    await snapshot('the auto-allowed note');
  } else {
    expect(true, 'no auto-allowed note: the CLI ran it without asking (CLI accepts auto mode on this model)');
  }
  await chat.waitForAssistant(/DONE/, 120000);
}
