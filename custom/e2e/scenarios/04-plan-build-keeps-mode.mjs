import fs from 'node:fs';

// The bug this pins: approving a plan ("Build") without saying which mode to
// continue in dropped the CLI to `default`, so every edit after it asked for
// approval although the user had picked auto. Build now continues in the mode
// the user was in before plan mode (or the one the selector shows), and the
// selector follows.
export const meta = {
  title: 'Plan in auto mode → Build continues in auto: no approval prompts, selector follows',
  timeoutMs: 180000,
  mode: 'auto',
};

export async function run({ chat, page, expect, sleep, projectFile, snapshot }) {
  await chat.openNewChat();
  expect(await chat.currentMode() === 'auto', 'the session starts in auto mode');
  await chat.setMode('plan');
  expect(await chat.currentMode() === 'plan', 'switched to plan mode');

  await chat.send('Create a file named plan-proof.txt containing the word ok in the current directory. Present a one-line plan with ExitPlanMode first.');
  const build = page.getByRole('button', { name: /^Build/ });
  await build.waitFor({ state: 'visible', timeout: 90000 });
  expect(true, 'the plan is shown with a Build button');
  await snapshot('the plan with its Build button');
  await build.click();

  // Watch for approval prompts while the file gets written.
  let prompted = false;
  for (let i = 0; i < 90 && !fs.existsSync(projectFile('plan-proof.txt')); i++) {
    prompted = prompted || await chat.hasApprovalPrompt();
    await sleep(1000);
  }
  expect(fs.existsSync(projectFile('plan-proof.txt')), 'the file from the plan was created');
  expect(!prompted, 'no approval prompt appeared after Build');
  await chat.waitIdle(60000);
  expect(await chat.currentMode() === 'auto', 'the mode selector went back to auto');
}
