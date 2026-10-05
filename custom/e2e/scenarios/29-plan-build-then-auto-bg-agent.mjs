import fs from 'node:fs';

// Plan → Build (continues in default) → switch to auto while the work runs:
// a background agent started after the switch runs its commands without
// approval prompts, like the main session does.
export const meta = {
  title: 'Plan → Build → switch to auto: a background agent does not ask for approval',
  timeoutMs: 300000,
  mode: 'default',
  // Auto mode is not available on Haiku, the harness default: the CLI refuses the switch.
  model: 'sonnet',
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
  await chat.waitForAssistant(/DONE/, 120000);
}
