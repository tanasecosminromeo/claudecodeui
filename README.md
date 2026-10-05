<div align="center">
 <img src="public/logo.svg" alt="CloudCLI UI" width="64" height="64">
 <h1>Cloud CLI (aka Claude Code UI)</h1>
 <p>A desktop and mobile UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from everywhere.</p>
</div>

<p align="center">
 <a href="https://cloudcli.ai">CloudCLI Cloud</a> · <a href="https://cloudcli.ai/docs">Documentation</a> · <a href="https://discord.gg/buxwujPNRE">Discord</a> · <a href="https://github.com/siteboon/claudecodeui/issues">Bug Reports</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
 <a href="https://cloudcli.ai"><img src="https://img.shields.io/badge/☁️_CloudCLI_Cloud-Try_Now-0066FF?style=for-the-badge" alt="CloudCLI Cloud"></a>
 <a href="https://discord.gg/buxwujPNRE"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"></a>
 <br><br>
 <a href="https://trendshift.io/repositories/15586" target="_blank"><img src="https://trendshift.io/api/badge/repositories/15586" alt="siteboon%2Fclaudecodeui | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<div align="right"><i><b>English</b> · <a href="./docs/README.ru.md">Русский</a> · <a href="./docs/README.de.md">Deutsch</a> · <a href="./docs/README.ko.md">한국어</a> · <a href="./docs/README.zh-CN.md">简体中文</a> · <a href="./docs/README.zh-TW.md">繁體中文</a> · <a href="./docs/README.ja.md">日本語</a> · <a href="./docs/README.tr.md">Türkçe</a></i></div>

---

## What's different in this fork

This is a personal fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui). Everything below is on top of upstream; fork-only code lives in [`custom/`](custom/) so upstream merges rarely conflict.

**Status:** ✅ Works well · 🧪 Work in progress (works, still changing) · 🚧 MVP (does the basic job, more planned) · 🔬 Experimental (needs root or outside services, may change). *Next:* lists what is planned or known to be missing; the order of work is in [docs/fork-roadmap.md](docs/fork-roadmap.md).

### Chat and sessions

| Feature | Status | What it does |
|---|---|---|
| One live Claude process per session | 🧪 | Sessions survive CloudCLI restarts and crashes (`CLOUDCLI_DETACHED_CLAUDE=1`) and are never duplicated between the terminal and the web UI. |
| `/btw` side questions | 🚧 | Ask a quick question while Claude is busy without interrupting the turn. *Next:* keep the questions and answers, with a history you can open. |
| Plan approval keeps the mode | ✅ | Approving a plan keeps the permission mode you picked. *Next:* background agents don't follow it yet. |
| Last-message stamp | ✅ | Time of the last message at the end of the transcript. |
| Voice shortcut | ✅ | Ctrl+Space (Option+Space on macOS) starts and stops the composer mic; focus stays in the prompt. |
| "Summarised" read-aloud | ✅ | Reads a short summary of a message instead of all of it. Depends on a speech service that will be published at a later date. |

### Sidebar

| Feature | Status | What it does |
|---|---|---|
| Quick archive with Undo | ✅ | Archive a conversation in one click, with an Undo notice. *Next:* the button only shows on hover, where it replaces the row's age; make it visible without hovering. |
| Star colours and project groups | 🧪 | Click a project's star to cycle its colour; put projects into named groups. *Next:* like Gmail, clicking again after a few seconds removes the star instead of changing its colour; starring no longer jumps the project to the top, with a Starred filter instead. |
| Running view ([session-radar](custom/session-radar/README.md)) | 🧪 | Live sessions grouped Needs you / Running / Idle / Ended, with details and a Stop button. |
| Per-session process tree | 🧪 | Expand a live session in the Running view to see the processes it started. |
| "Needs input" badge | 🚧 | While a session waits on you, the favicon pulses and a badge opens that conversation. *Next:* cover every session and keep the marker on the session, so opening a project shows what you need to unblock. |

### Plugins and tools

| Feature | Status | What it does |
|---|---|---|
| Usage meter ([claude-usage](custom/claude-usage/README.md)) | ✅ | Header meter for the 5-hour and 7-day limits, plus a Usage tab for every account managed by `claude-swap`. |
| Account auto-switch | 🧪 | Switches to another account at 95% and back to your default account. |
| Codex usage | 🚧 | Codex limits in the same Usage tab. |
| Public share links ([share](custom/share/README.md)) | 🧪 | Ask Claude to "publish the report" and the `publish` skill / `share` CLI return a public link, no login, that expires after 24h. The sidebar's Artefacts tab lists them. Install with `make share-install`. |
| Environment switcher ([env-switcher](custom/env-switcher/README.md)) | 🚧 | If you run CloudCLI on several machines, the logo menu switches between them in the same browser tab. Each one stays loaded, so switching back never reloads it, and the badge shows when another machine has a session waiting on you. Set `ENV_SWITCHER="Dev=https://dev.example.com,Laptop=https://laptop.example.com"`. |
| Read-only folders | ✅ | The file browser can open files outside your projects only from a few read-only folders (upstream: `/tmp` and `~/.claude/projects`). This fork adds `~/.claude/plans`, so the plan links Claude writes in a transcript open, and `CLOUDCLI_READ_ONLY_ROOTS` for your own folders, e.g. one where agents write HTML reports. Separate entries with `:` (`;` on Windows). You can view these files but not edit them. |
| Session guard for the terminal ([claude-guard](custom/claude-guard/claude-guard.sh)) | 🚧 | Running `claude --resume <id>` in a terminal while that session is already open in the CloudCLI chat or another terminal would make both write to it and split the conversation. With the guard, the terminal says where it is open and asks first. Install with `make claude-guard`; skip it once with `command claude`. |
| Process history ([exec-tracer](custom/exec-tracer/README.md)) | 🔬 | The process tree normally only shows what is running right now. This root service (Linux, bpftrace) logs every command Claude starts, such as Bash tool calls, git and MCP servers, so the tree also shows commands that already finished. It logs only processes started under `claude`. Install with `make exec-tracer`. |
| [UI cleanup](custom/ui-cleanup/README.md) | ✅ | Changes the look and layout without editing upstream source, so upgrades don't undo them. It injects CSS and JS into the built page on every service start: system font and square corners; the Report issue / Discord / star / version links removed; Settings next to Refresh; the Running view, usage meter and Needs input badge from the plugins above. |

### Running the fork

| Feature | Status | What it does |
|---|---|---|
| Makefile workflow | 🧪 | `make status / upgrade / sync / rollback / deploy / remote`: merge the latest upstream release, build, test, restart and check, then bring other machines up to date. See the top of the [Makefile](Makefile). *Next:* keeping several machines in step (`make sync`, `make remote`) doesn't work reliably yet. |
| Linux service ([systemd](custom/systemd/)) | ✅ | Runs the server as a systemd user service that starts on boot and re-applies the UI cleanup on each start. |
| macOS service ([launchd](custom/launchd/)) | 🚧 | The same for macOS: a LaunchAgent, macOS's equivalent of a systemd user service. |
| End-to-end tests ([e2e](custom/e2e/README.md)) | ✅ | `make e2e` builds this checkout into a separate instance with its own port and database, then drives it in a real browser (Playwright) against the real Claude CLI, including real restarts. |
| Commit guard ([hooks](custom/hooks/README.md)) | 🚧 | Git hooks that stop a commit or push from publishing secrets (checked with gitleaks) or terms from a private denylist, such as personal or client names. The denylist lives outside the repo. |

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop View</h3>
<img src="public/screenshots/desktop-main.png" alt="Desktop Interface" width="400">
<br>
<em>Main interface showing project overview and chat</em>
</td>
<td align="center">
<h3>Mobile Experience</h3>
<img src="public/screenshots/mobile-chat.png" alt="Mobile Interface" width="250">
<br>
<em>Responsive mobile design with touch navigation</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>CLI Selection</h3>
<img src="public/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Select between Claude Code, Cursor CLI and Codex</em>
</td>
</tr>
</table>



</div>

## Features

- **Responsive Design** - Works seamlessly across desktop, tablet, and mobile so you can also use Agents from mobile 
- **Interactive Chat Interface** - Built-in chat interface for seamless communication with the Agents
- **Integrated Shell Terminal** - Direct access to the Agents CLI through built-in shell functionality
- **File Explorer** - Interactive file tree with syntax highlighting and live editing
- **Git Explorer** - View, stage and commit your changes. You can also switch branches 
- **Browser Use** - Open browser sessions for web research, testing, and agent-driven browser tasks
- **Session Management** - Resume conversations, manage multiple sessions, and track history
- **Plugin System** - Extend CloudCLI with custom plugins — add new tabs, backend services, and integrations. [Build your own →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **TaskMaster AI Integration** *(Optional)* - Advanced project management with AI-powered task planning, PRD parsing, and workflow automation
- **Model Compatibility** - Works with Claude and GPT model families (the full list of supported models is available at runtime via `GET /api/providers/:provider/models`)


## Quick Start

### CloudCLI Cloud (Recommended)

The fastest way to get started — no local setup required. Get a fully managed, containerized development environment accessible from the web, mobile app, API, or your favorite IDE.

**[Get started with CloudCLI Cloud](https://cloudcli.ai)**

### Self-Hosted (Open source)

#### npm

Try CloudCLI UI instantly with **npx** (requires **Node.js** v22+):

```
npx @cloudcli-ai/cloudcli
```

Or install **globally** for regular use:

```
npm install -g @cloudcli-ai/cloudcli
cloudcli
```

Open `http://localhost:3001` — all your existing sessions are discovered automatically.

Visit the **[documentation →](https://cloudcli.ai/docs)** for full configuration options, PM2, remote server setup and more.

#### Docker Sandboxes (Experimental)

Run agents in isolated sandboxes with hypervisor-level isolation. Starts Claude Code by default. Requires the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/get-started/).

```
npx @cloudcli-ai/cloudcli@latest sandbox ~/my-project
```

Supports Claude Code and Codex. See the [sandbox docs](docker/) for setup and advanced options.

### Desktop Companion App

CloudCLI Desktop is an optional native companion for CloudCLI Cloud and Local CloudCLI. It ships from this repository's GitHub Releases and keeps CloudCLI available from your menu bar or tray.

- **[macOS](https://cloudcli.ai/download/macos)**
- **[Windows](https://cloudcli.ai/download/windows)**
- **[Download page](https://cloudcli.ai/download)** · **[GitHub Releases and checksums](https://github.com/siteboon/claudecodeui/releases)**

Use it to open CloudCLI Cloud environments, switch between local and remote workspaces, and copy mobile/browser URLs. To work locally, choose **Local CloudCLI** in the desktop app; it will use your running local server or start one for you.


---

## Which option is right for you?

CloudCLI UI is the open source UI layer that powers CloudCLI Cloud. You can self-host it on your own machine, run it in a Docker sandbox for isolation, or use CloudCLI Cloud for a fully managed environment.

| | Self-Hosted (npm) | Self-Hosted (Docker Sandbox) *(Experimental)* | CloudCLI Cloud |
|---|---|---|---|
| **Best for** | Local agent sessions on your own machine | Isolated agents with web/mobile IDE | Teams who want agents in the cloud |
| **How you access it** | Browser via `[yourip]:port` | Browser via `localhost:port` | Browser, any IDE, REST API, n8n |
| **Setup** | `npx @cloudcli-ai/cloudcli` | `npx @cloudcli-ai/cloudcli@latest sandbox ~/project` | No setup required |
| **Isolation** | Runs on your host | Hypervisor-level sandbox (microVM) | Full cloud isolation |
| **Machine needs to stay on** | Yes | Yes | No |
| **Mobile access** | Any browser on your network | Any browser on your network | Any device |
| **Desktop companion** | Optional. Choose Local CloudCLI | Optional. Choose Local CloudCLI | Optional. Opens cloud environments |
| **Agents supported** | Claude Code, Cursor CLI, Codex | Claude Code, Codex | Claude Code, Cursor CLI, Codex |
| **File explorer and Git** | Yes | Yes | Yes |
| **MCP configuration** | Synced with `~/.claude` | Managed via UI | Managed via UI |
| **REST API** | Yes | Yes | Yes |
| **Team sharing** | No | No | Yes |
| **Platform cost** | Free, open source | Free, open source | Starts at €7/month |

> All options use your own AI subscriptions (Claude, Cursor, etc.) — CloudCLI provides the environment, not the AI.

---

## Security & Tools Configuration

**🔒 Important Notice**: All Claude Code tools are **disabled by default**. This prevents potentially harmful operations from running automatically.

### Enabling Tools

To use Claude Code's full functionality, you'll need to manually enable tools:

1. **Open Tools Settings** - Click the gear icon in the sidebar
2. **Enable Selectively** - Turn on only the tools you need
3. **Apply Settings** - Your preferences are saved locally

<div align="center">

![Tools Settings Modal](public/screenshots/tools-modal.png)
*Tools Settings interface - enable only what you need*

</div>

**Recommended approach**: Start with basic tools enabled and add more as needed. You can always adjust these settings later.

---

## Plugins

CloudCLI has a plugin system that lets you add custom tabs with their own frontend UI and optional Node.js backend. Install plugins from git repos directly in **Settings > Plugins**, or build your own.

### Available Plugins

| Plugin | Description |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Shows file counts, lines of code, file-type breakdown, largest files, and recently modified files for your current project |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Full xterm.js terminal with multi-tab support |
| **[Claude Watch](https://github.com/satsuki19980613/cloudcli-claude-watch)** | Watches long-running Claude Code sessions for hangs and exposes process controls |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Create workspace-scoped scheduled prompts and execute them through a local CLI such as Codex or Claude Code |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Session intelligence for Claude Code inside CloudCLI, including token burn visibility |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | View, manage, and kill active Claude Code sessions |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | Calculate API costs from model prices and token usage, with preset model pricing support |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Task queue dashboard to view, filter, and launch agent tasks |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban board for GitHub Issues with bidirectional TaskMaster sync and /github-task CLI skill auto-install |

### Build Your Own

**[Plugin Starter Template →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** — fork this repo to create your own plugin. It includes a working example with frontend rendering, live context updates, and RPC communication to a backend server.

**[Plugin Documentation →](https://cloudcli.ai/docs/plugin-overview)** — full guide to the plugin API, manifest format, security model, and more.

---
## FAQ

<details>
<summary>How is this different from Claude Code Remote Control?</summary>

Claude Code Remote Control lets you send messages to a session already running in your local terminal. Your machine has to stay on, your terminal has to stay open, and sessions time out after roughly 10 minutes without a network connection.

CloudCLI UI and CloudCLI Cloud extend Claude Code rather than sit alongside it — your MCP servers, permissions, settings, and sessions are the exact same ones Claude Code uses natively. Nothing is duplicated or managed separately.

Here's what that means in practice:

- **All your sessions, not just one** — CloudCLI UI auto-discovers every session from your `~/.claude` folder. Remote Control only exposes the single active session to make it available in the Claude mobile app.
- **Your settings are your settings** — MCP servers, tool permissions, and project config you change in CloudCLI UI are written directly to your Claude Code config and take effect immediately, and vice versa.
- **Works with more agents** — Claude Code, Cursor CLI and Codex, not just Claude Code.
- **Full UI, not just a chat window** — file explorer, Git integration, MCP management, and a shell terminal are all built in.
- **CloudCLI Cloud runs in the cloud** — close your laptop, the agent keeps running. No terminal to babysit, no machine to keep awake.

</details>

<details>
<summary>Do I need to pay for an AI subscription separately?</summary>

Yes. CloudCLI provides the environment, not the AI. You bring your own Claude, Cursor, or Codex subscription. CloudCLI Cloud starts at €7/month for the hosted environment on top of that.

</details>

<details>
<summary>Can I use CloudCLI UI on my phone?</summary>

Yes. For self-hosted, run the server on your machine and open `[yourip]:port` in any browser on your network. For CloudCLI Cloud, open it from any device — no VPN, no port forwarding, no setup. A native app is also in the works.

</details>

<details>
<summary>Will changes I make in the UI affect my local Claude Code setup?</summary>

Yes, for self-hosted. CloudCLI UI reads from and writes to the same `~/.claude` config that Claude Code uses natively. MCP servers you add via the UI show up in Claude Code immediately and vice versa.

</details>

---

## Community & Support

- **[Documentation](https://cloudcli.ai/docs)** — installation, configuration, features, and troubleshooting
- **[Discord](https://discord.gg/buxwujPNRE)** — get help and connect with other users
- **[GitHub Issues](https://github.com/siteboon/claudecodeui/issues)** — bug reports and feature requests
- **[Contributing Guide](CONTRIBUTING.md)** — how to contribute to the project

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7.

This project is open source and free to use, modify, and distribute under the AGPL-3.0-or-later license. If you modify this software and run it as a network service, you must make your modified source code available to users of that service.

CloudCLI UI - (https://cloudcli.ai).

## Acknowledgments

### Built With
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - Anthropic's official CLI
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - Cursor's official CLI
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - User interface library
- **[Vite](https://vitejs.dev/)** - Fast build tool and dev server
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[CodeMirror](https://codemirror.net/)** - Advanced code editor
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(Optional)* - AI-powered project management and task planning


### Sponsors
- [Siteboon - AI powered website builder](https://siteboon.ai)
---

<div align="center">
 <strong>Made with care for the Claude Code, Cursor and Codex community.</strong>
</div>
