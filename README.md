# NeuroForge

**Place neurons in 3D space, wire them up, and compile the result into code that actually runs.**

No Python environment to set up. No training script to write. No code at all, unless you want it.

---

## What it is

NeuroForge is a visual neural-network builder. You drop neurons at arbitrary coordinates in a 3D
space, connect them, set per-neuron and per-connection parameters, and press `F7`. Out comes a real
model — not a picture of one.

| Compile target | What you get | Needs on the target machine |
| --- | --- | --- |
| **PyTorch** | `hand_built_net.py` (+ `model.bin` for large nets) | Python + PyTorch |
| **ONNX** | an export script you run once to produce the `.onnx` | onnxruntime |
| **Standalone** | `model.c` + a build script → a native binary | a C compiler (or ship the compiled binary) |

The standalone target bakes the weights and the topology straight into the binary: **zero
dependencies, millisecond startup, no Python**. Hand it to someone who has never installed a
Python package and it still runs.

Everything runs locally. There is no cloud service, no account, and no upload.

---

## The 10-second version

A network compiled by NeuroForge was wired to a MuJoCo simulation of a Unitree Go2 quadruped.

- Driving nothing: the trunk settles at **0.18**.
- Feeding five cells of each of the 12 muscles: the trunk rises to **0.26** and holds.
- Backing those values out: it drops back to **0.18**.

Same loop, run through the standalone `.exe`, gave identical numbers. That is what "compiles to
something that runs" means here.

---

## Quick start

**Windows desktop (recommended).** Download `NeuroForge_x.x.x_x64-setup.exe` from
[Releases](../../releases). About 1.5 MB. Installs to `%LOCALAPPDATA%\NeuroForge\` for the current
user — no admin rights. The app itself is 3.5 MB and uses about 22 MB of RAM. It needs the
WebView2 runtime, which ships with Windows 11 and most Windows 10 installs.

**Nothing to install.** The same UI also builds as a single self-contained HTML file (~3 MB,
everything inlined, no network access needed). Download it from Releases and double-click it.

| Action | How |
| --- | --- |
| Orbit / pan / zoom | right-drag / middle-drag / wheel |
| Switch tool | `S` select · `W` wire · `A` place · `D` delete |
| Place by coordinates | `A`, then type XYZ and press `Enter` |
| Select | click; `Shift` adds; drag a box; `Ctrl+A` selects all |
| Mark an external interface | select, then `1` in · `2` out · `3` both · `4` clear |
| Simulate activation | select neurons, then "Simulate" in the right panel |
| **Compile** | `F7` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Save / open | `Ctrl+S` / `Ctrl+O` |

> **Set up the AI assistant before anything else.** It is how you actually drive the editor: you say
> what you want and it places, wires, edits, simulates and compiles for you. It needs one API key,
> or a local model (free, and nothing leaves your machine). Step-by-step with screenshots:
> [`docs/ai-setup.zh-CN.md`](docs/ai-setup.zh-CN.md) — Chinese for now.

---

## What you can do with it

- **Arbitrary topology.** Any DAG you can draw — not restricted to neat layers. Per-neuron
  activation function (11 of them), bias, threshold, freeze, colour, XYZ. Per-connection weight,
  sign colouring, freeze, invert, zero.
- **Batch everything.** Box-select and set activation / threshold / bias / weight across the
  selection, with random or Xavier initialisation. Pave a column, a plane, or a solid block of
  neurons in one action.
- **Watch a signal travel.** Fire a few neurons and the activation propagates wave by wave, with
  a live "wave k of n" readout. Neurons with state step one tick at a time.
- **See the network's state, not just its shape.** Weight histograms, global health checks,
  pruning, connection-width-by-weight, node-size-by-strength. This is the part a model *viewer*
  cannot show you.
- **Scale.** Built to hold 500,000 neurons / 2,000,000 connections in the editor, verified on a
  real network of 16.8 million edges. Large projects stream in from disk — open the summary first,
  and blocks are decompressed only as the camera approaches them.

## Recurrent and spiking networks

Loops are allowed. Feedback connections, recursion and self-loops all compile — edges inside a
strongly-connected component are treated as back-edges that read the previous tick, and the graph
is unrolled over time (`NUM_STEPS`, default 8).

Three of the 11 activation functions carry state across ticks: **Memory**, **Leaky integrator**,
and **LIF spiking** (`s ← k·s + Σw·x`, fire at 1.0, then subtract). PyTorch and the standalone C
target both keep that state for real. ONNX has no implicit state, so the export warns you instead
of quietly computing the wrong thing.

## Bring in a model you already have

`py -3 tools/import_model.py model.onnx` folds an ONNX graph into a NeuroForge project. `Gemm`,
`MatMul` and the usual activations become neurons and weighted edges; convolutions, pooling,
normalisation and `Softmax` come in as **operator nodes** (a 4096×4096 matrix stays a matrix
instead of exploding into 16 million edges). Press `F9` to flip to the operator-graph view and see
what the graph looked like before it was flattened.

Import is one-way — NeuroForge is an authoring format, and does not export back to ONNX.

## Talk to real hardware

Interfaces are not just markers. The runtime wires them to the outside world:

- **Input**: keyboard key, constant, timed pulse.
- **Output**: on-screen log, synthetic in-app key, real system key injection, HTTP POST, or run a
  script.
- **Generic channels**: UDP / TCP / serial / HTTP polling / WebSocket, with JSON, whitespace text,
  CSV, float32 or int16 binary encoding. Point them at a slot list like `12, 13*2, 20*0.5+0.1` and
  the values go straight in and out of the network.
- **MuJoCo closed loop**, one command: the `wire_mujoco` tool tags the observation region and the
  output cells, creates the two UDP channels, and prints the command line to run on the other side.

UDP, TCP, serial and system key injection are desktop-only — the browser build says so plainly
rather than pretending.

## The built-in AI assistant

Describe what you want in a sentence and let the assistant build it. It is not a chat window
bolted onto the side: it drives the actual editor through a tool interface — placing neurons,
rewiring, editing weights, pruning, compiling, opening channels, running the simulation.

- **Bring your own key.** Any OpenAI-compatible endpoint; DeepSeek is the tested default. Your key
  is stored locally and the assistant has no tool that can read it back out.
- **It can extend itself.** Drop a `.js` file into `%APPDATA%\NeuroForge\tools\`, reload, and the
  assistant has a new tool. It can write those tools itself.
- **Everything it does is one undo step**, and every change is inspectable in the 3D view — so you
  can verify what it did rather than trusting it.

---

## Honest limits

- **The editor is a pre-allocated hard ceiling**: 500,000 neurons / 2,000,000 connections. Above
  that it refuses with a clear message rather than truncating. Use chunked load, or pre-slice the
  network with the scripts in `tools/`.
- **The standalone target is C source plus a build script**, not a prebuilt binary. The target
  machine needs a compiler. The C backend also does not support operator nodes (convolutions and
  friends) — use PyTorch or ONNX for those.
- **Model import is one-way.** `.nforge` does not export back to ONNX.
- **The activation threshold is an editor-side simulation feature** and is not written into the
  compiled model; compiled output is a standard weighted sum plus activation.
- **ONNX is a single file and inherits protobuf's 2 GB limit.** Weights will eventually need to be
  sharded.
- **The AI assistant needs your own API key.** The app ships no key and proxies nothing.
- **Interface channels are stored in the project file**, but whether a channel is *open* is not —
  you reopen it once per session.
- The interface and manual are primarily written in Chinese; English coverage is broad but not
  complete.

## Verified, not asserted

The build is exercised by 777 interaction assertions plus cross-language checks (JS against Python
on the project container, the compiled PyTorch against the compiled C target, and the importer
against reference ONNX models). The Go2 numbers above come from a real MuJoCo run, not a mock.

## License

Source-available, non-commercial. You may read, study, modify and compile NeuroForge for your own
personal use. **You may not redistribute it or use it commercially** — that includes internal use
by a for-profit organisation. Commercial licensing is available separately.

See [LICENSE](LICENSE).

---

中文文档见 [README.zh-CN.md](README.zh-CN.md)。
