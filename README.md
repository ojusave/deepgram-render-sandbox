<div align="center">

# Think Aloud

Practice explaining and fixing a small Python bug with a voice coach. Run real checks, then keep your code and conversation in a recap.

[![Deepgram Voice Agent](https://img.shields.io/badge/Deepgram-Voice_Agent-18755b)](https://developers.deepgram.com/docs/voice-agent) [![Render Sandboxes](https://img.shields.io/badge/Render-Sandboxes-4149b7)](https://render.com/docs/sandboxes) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-303846)](https://nodejs.org/)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Deploy](#deploy-on-render) · [Limits and data](#limits-and-data)

</div>

The exercise starts with a function that calculates the average customer wait. Ordinary inputs work, but an empty list causes division by zero. Explain what you notice, edit the function, and run the three checks. The coach asks follow-up questions using your saved code and actual results. It cannot edit your code or mark an answer correct.

Deepgram handles the conversation. Render provides a separate temporary practice computer, called a **sandbox**, that runs your code throughout the session. This is an independent integration demo, not an official partnership or a hiring assessment.

## Quickstart

### Prerequisites

- Node.js 24 or later and access to this repository. It is currently private.
- A Deepgram API key with Voice Agent access.
- A Render API key and a workspace with Sandboxes enabled. Running this example consumes paid provider usage.

In your terminal, download the project and enter its folder:

```sh
# Clone the project. Your GitHub account must have access to this private repository.
git clone https://github.com/ojusave/deepgram-render-sandbox.git
cd deepgram-render-sandbox

# Install the locked dependency versions and create local server settings.
npm ci
cp .env.example .env
```

Open `.env` in your editor and fill in these values:

| Setting | Purpose |
| --- | --- |
| `DEEPGRAM_API_KEY` | Connects the server to the [Deepgram Voice Agent](https://developers.deepgram.com/docs/voice-agent). |
| `RENDER_API_KEY` | Lets the server create and close [Render Sandboxes](https://render.com/docs/sandboxes). |
| `RENDER_WORKSPACE_ID` | Selects your sandbox-enabled workspace. Find it in Render workspace settings. |
| `SESSION_SECRET` | A long random string used to sign browser session cookies. Required for a stable hosted session configuration. |

Keys stay on the web server. They are never supplied to learner code or included in the browser bundle. Do not commit `.env`.

```sh
# Build the browser interface, then start the web server.
npm run build
npm start
```

The server prints `Think Aloud listening on port 4399`. Open [localhost:4399](http://localhost:4399), choose **Start with voice**, and allow microphone access. **Use text instead** is available for a quiet room or when a microphone is unavailable.

Your practice computer starts and the original code runs. You should see:

```text
Several customers: Passed
No customers: Needs a fix
ZeroDivisionError: division by zero
Partial minutes: Passed
```

Explain the bug to the coach. Edit `average_wait` so it returns `0` when there are no customers, while keeping ordinary averages working. Choose **Run checks**, or ask the coach to run them. All three should pass after a correct fix. New edits are explicitly marked as untested until checked again.

Ask for feedback on your explanation. Choose **Finish practice** to close the temporary computer, then **Download recap** to save your code, check results, and conversation as a text file. Closing only the voice connection keeps your exercise open; the ten-minute session limit still closes its computer.

## How it works

1. Your browser connects to the Node web server. The server keeps each visitor's code and conversation separate with a signed cookie.
2. Deepgram listens and speaks. Its managed language model requests `inspect_exercise` to read the latest saved code, or `run_checks` to test it. This request for an action is called a **function call**.
3. The server sends the learner's Python file to that session's Render Sandbox. Each check calls the function with a fixed input in a fresh Python process. The same sandbox is reused during the exercise.
4. The server compares returned numbers with expected values. It shows the results in the browser and returns them to the coach. Every result records which code version was checked.
5. Finish, expiry, cancellation, and shutdown stop the owned environment. The app confirms closure before claiming cleanup is complete.

The server runs locally during development and on a Render web service when deployed. Learner code always runs in a separate Render Sandbox. The voice connection and provider credentials remain on the trusted server.

- [Exercise and expected results](server/exercise.js)
- [Voice prompt and tool definitions](server/settings.js)
- [Sandbox creation, execution, and cleanup](server/sandbox.js)
- [Web routes and session lifecycle](server/index.js)
- [Browser controls](web/app.js) and [interface](web/index.html)

The app uses the existing Express, WebSocket, Render, and Deepgram packages with a small Vite build. The editor is a native text area. There is one file and one exercise, with no project browser or terminal to configure.

## Deploy on Render

Create a paid **Starter** Node web service with one instance:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Build settings | `NODE_ENV=production`, `NPM_CONFIG_INCLUDE=dev` |
| Health check | `/healthz` |
| Server settings | The four settings from the Quickstart |
| Node | 24 or later |

Render supplies `PORT`; the server listens on `0.0.0.0`. Keep one instance because this prototype holds sessions and usage limits in memory. A restart ends active sessions and clears their saved state. For a multi-instance application, move those records and limits into shared storage first.

## Limits and data

- One beginner exercise, three visible checks, a ten-minute practice session, and up to 15 completed check runs. Passing these inputs does not prove a program works for every possible input or predict interview success.
- Two active practice seats. A server process allows up to 20 session starts per hour, 60 per day, and 40 voice connections per hour. Limits reset on restart. This is a bounded demo, not a production access-control or billing system.
- Each practice computer has outbound internet access blocked and a 12-minute hard lifetime as a cleanup backstop. Individual checks have a three-second limit. Standard-library Python only. Stopping checks closes the environment; the next run creates a new one using your saved code.
- Audio, conversation, saved code, and check results can be processed by Deepgram and its configured language-model provider. Code also runs on Render. The web app keeps code and conversation in memory for up to an hour of inactivity, or until restart. No permanent database is configured. Use the included exercise rather than private information.
- Refresh recovers server-saved code and results. Edits still being saved can be lost if you close the page. Download a recap before starting over or leaving. Unknown creation outcomes and unconfirmed cleanup pause new environments instead of creating duplicates.

## References

[Deepgram function calling](https://developers.deepgram.com/docs/voice-agents-function-calling) · [Deepgram cancellation](https://developers.deepgram.com/docs/voice-agent-function-call-cancelled) · [Render Sandbox SDK](https://render.com/docs/sandboxes-sdk-typescript) · [MIT license](LICENSE)
