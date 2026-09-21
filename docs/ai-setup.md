# Setting up the AI assistant

The assistant is not a chat box bolted onto the side of the app — **it is how you drive the editor.**
You say what you want; it places neurons, wires them, edits weights, runs simulations and compiles.
Setting it up costs one API key, or nothing at all if you point it at a local model.

> **A note on the screenshots.** The assistant panel is currently **Chinese-only in the UI**.
> These are real screenshots of that panel, so expect Chinese labels — each control is named and
> located in the text next to the figure.

![NeuroForge](img/ai-setup-1-overview.png)

## Pick a route

|  | Route A · Cloud API | Route B · Local model |
| --- | --- | --- |
| Install | nothing — just sign up for a key | Ollama (or LM Studio, etc.) |
| Cost | pay per use, cheap | free |
| Network | required | not required |
| Data | prompts and replies go to the provider | never leaves your machine |
| Best for | being up and running in two minutes | no spend / data stays local |

Start with A. Move to B later if you want to.

## Step 0 · Open Settings

The panel in the bottom-right corner is the assistant. On first launch it reads
**未配置 · 点「设置」填 API Key** — "not configured, click Settings to enter an API key".

![Open Settings](img/ai-setup-2-settings-button.png)

Click **设置** (Settings) — the right-most item in that bar.

## Route A · Cloud API (one field to fill)

![The three cloud fields](img/ai-setup-3-cloud-fields.png)

DeepSeek's endpoint and model name are already filled in. The only thing missing is a key:

1. **API Key** — sign up at [platform.deepseek.com](https://platform.deepseek.com), create a key under
   API Keys (it looks like `sk-xxxxxxxx`) and paste it in. The key is stored on your own machine
   (in browser storage for the single-file HTML build; the desktop build also writes it next to the
   app). It is never uploaded anywhere.
2. **接口地址** (endpoint) — already `https://api.deepseek.com/v1/chat/completions`. Leave it alone.
3. **模型** (model) — already `deepseek-flash`. It is the default because it accepts images, which is
   what makes the **看画面** ("see the screen") button work — you do not need a second vision endpoint.

> **There is no Save button to press.** It saves as you type.

Any OpenAI-compatible provider works the same way: put its endpoint, model name and key into these
three fields.

## Route B · Local model (free, offline)

![Local model controls](img/ai-setup-4-local.png)

1. Pick your server in the left-most dropdown — Ollama / LM Studio / llama.cpp's llama-server / vLLM /
   Xinference / KoboldCpp / text-generation-webui.
2. Click **填地址** ("fill address") and it writes that server's address into the endpoint field —
   no ports to memorise.
3. Click **拉模型列表** ("list models") and pick one from the dropdown, or just type a model name.
4. Click **测试连接** ("test connection") — it really sends one message and measures how long the
   reply takes.

> Local endpoints **need no API key**, and nothing leaves your machine.
>
> **Browser build only — CORS.** Ollama and LM Studio do not send CORS headers by default, so the
> browser blocks the request and you get "can't connect" even though the server is running. For
> Ollama, set `OLLAMA_ORIGINS=*` and restart it; in LM Studio, enable CORS under Developer.
> The desktop build does not have this problem — it retries through the native shell.
>
> Not sure what to install? Get **Ollama**, then `ollama pull qwen3:8b`. It listens on 11434 by itself.

## Step 1 · Confirm it connected

A line at the top of the settings panel tells you **whether requests leave your machine**:

- Cloud: it shows `云端 api.deepseek.com`; if the key is missing, it says so.
- Local: it shows `本机/内网端点` (local / LAN endpoint) and notes that no key is needed.

The assistant's title bar changes from **未配置** (not configured) to your provider and model name.
If it does not change, you are not connected.

![Clear the key](img/ai-setup-5-save.png)

To start over, **清掉 API Key** ("clear API key") wipes all three copies — browser storage, the
settings file, and the backup.

## Step 2 · Do something

![The prompt box](img/ai-setup-6-input.png)

Type plain language into that box:

- "place 20 neurons along X from (0,0,0), step 10, then chain them in a line"
- "wire these two groups together fully"
- "run a simulation and tell me how many steps the signal takes to reach the output"
- "filter by the p90 of |weight| and hide the weak connections"
- "compile to PyTorch"

Behind it are 126 built-in tools — place, batch-pave, edit weights, simulate, pack weight blocks,
move the camera, compile — plus a fallback that can call any of the ~350 scripting interfaces.
**Every change it makes is a single undo**, so Ctrl+Z is always available.

Before it deletes things, or paves tens of thousands of neurons, it asks first. If that gets in the
way, untick **大改动先问我** ("ask before big changes") in Settings — but note that while it is
ticked, an unanswered dialog blocks the task indefinitely.

## When something goes wrong

Just ask it.

- It errors → "that failed, take a look". It can read the error it received.
- You don't know what a button does → hover for a tooltip, or ask.
- Wrong key → **清掉 API Key** and paste it again.

---

中文版：[ai-setup.zh-CN.md](ai-setup.zh-CN.md)

License and feedback: [README](../README.md) · [open an issue](https://github.com/leeR1ven/neuroforge/issues)