# dsh-task-time

Per-task human engagement time for [DeepSeek Harness](https://github.com/deepseek-ai) — measure how long you actually spend **typing** and **reading** in each conversation, with idle cutoffs, tags, and a statistics panel.

Unlike token or model metrics, this tracks the human: it stops when you leave the task, switch windows, or go idle, and never records message content.

**Language: [中文](README.md) ｜ English**

## Features

- **Typing time** — a continuous segment from the first keystroke to the last one; pauses inside the message count, the trailing idle does not.
- **Reading time** — starts on a wheel, click, or touch outside the composer; extended by scrolling, selecting, and pointer movement.
- **Tiered idle cutoffs** — typing stops after 60 s without input, reading after 120 s without activity.
- **Noise filter** — typing segments under 5 s and reading segments under 30 s are discarded.
- **Context stops** — switching task, switching panel, losing window focus, or hiding the page ends the segment immediately.
- **Draft coverage** — typing in a brand-new task before the session exists is kept and adopted once the session is created.
- **Tags** — multiple tags per task, a persistent tag vocabulary shared across all tasks, and one-click selection while editing.
- **Header chip** — today's total for the current task, ticking live, click to open the statistics panel.
- **Statistics panel** — summary cards, tag rollup, grouped detail tables (tag / task / project), and a usage log with start and end times.
- **Local only** — data lives in `$DSH_HOME/task-time`, no network, no message text, CSV export on demand.

## Install

1. Clone this repository somewhere stable:

   ```bash
   git clone https://github.com/priatewang/dsh-task-time.git
   ```

2. Install the bundle into your Harness profile through the plugin manager, pointing it at the checkout directory (`install_bundle` with the absolute path). It installs as a local link, so pulling updates only needs a plugin reload.

3. Reload the page. A clock icon appears in the sidebar panel list; the conversation header gains a small time chip.

No build step: `client.js` is a plain browser module and `index.js` is a plain ESM plugin.

## Usage

| Where | What |
| --- | --- |
| Sidebar → clock icon | Opens the statistics panel |
| Conversation header chip | Today's typing / reading total for this task; click to open the panel |
| Panel → Statistics | Summary cards, tag summary, task tables grouped by tag / task / project |
| Panel → Log | One row per visit with `HH:mm – HH:mm`, duration, task, tags |
| Panel → Tags → Edit | Toggle existing tags, type a new one, save |

Range switch: today / last 7 days / last 30 days / all.

## Configuration

```yaml
- id: task-time
  name: dsh-task-time
  config:
    inputIdleMs: 60000    # typing idle cutoff
    readIdleMs: 120000    # reading idle cutoff
```

Changing the config restarts the plugin row.

## Timing rules

| Event | Typing | Reading |
| --- | --- | --- |
| First keystroke / IME commit / paste in composer | starts | — |
| Wheel, click, or touch outside the composer | ends at the last keystroke | starts |
| Scroll, pointer move, selection | ignored | extends |
| Caret move, auto-scrolling output | never interrupts | extends reading |
| Click inside the composer | — | ends |
| Switch task / panel, blur, hidden page | ends | ends |
| Idle cutoff | 60 s → ends at last keystroke | 120 s → ends at last activity |

A segment ended by an idle cutoff keeps the time up to the **last activity**, so the idle tail is never counted.

## Data

```
$DSH_HOME/task-time/
  intervals.jsonl   # { s: sessionId, c: "input"|"read", a: start, b: end, w: windowId }
  tags.json         # { "<sessionId>": ["work", "project-x"] }
```

Only timestamps, session ids and tags are stored — no message text, no keystrokes, no screenshots.

## HTTP surface (same origin)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/task-time/ingest` | `{ intervals: [{ sid, ch, start, end, w }] }` |
| `POST` | `/task-time/tag` | `{ sid, tags: string[] }` |
| `GET` | `/task-time/state?from&to` | aggregated rows, tags, vocabulary |
| `GET` | `/task-time/log?from&to&gap` | visits with start / end |
| `GET` | `/task-time/session?sid&from&to` | one task's totals (header chip) |
| `GET` | `/task-time/export.csv?from&to` | CSV export |

## Layout

```
index.js              host half: HTTP routes, JSONL store, aggregation
client.js             browser half: tracker state machine + statistics UI
cordis.patch.yml      bundle patch (row id `task-time`)
locale/               plugin meta title/description (en, zh)
icon.svg              sidebar icon
docs/REQUIREMENTS.md  full behaviour contract, written platform-agnostic
```

There is no build pipeline. Syntax check with `node --check client.js` and `node --check index.js` (as ESM).

## License

MIT — see [LICENSE](LICENSE).
