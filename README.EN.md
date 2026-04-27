
<p align="right">
  <b>English</b> | <a href="README.md">中文</a>
</p>

<h1 align="center" id="title">s9y (Singularity)</h1>

<p align="center">
  <b>A Minimally Complete Recursive Delegation Protocol</b><br>
  <i>Two primitives. Infinite leverage.</i>
</p>

<p align="center">
  <a href="#philosophy">Philosophy</a> •
  <a href="#features">Features</a>
</p>

---
## What is the relationship between `open-s9y` and s9y?
The `open-s9y project` is an implementation program of the `s9y protocol`.

## Quick Start open-s9y
1. Ensure [NodeJs](https://nodejs.org/) is installed
2. Clone the repository: `git clone https://github.com/lazier334/open-s9y`
3. Configure your AI information in `.env`, the main configuration item is `API_KEY`
4. Start the program: `npm start`

## What is s9y?

s9y is not another API gateway. It is an **organizational protocol** consisting of exactly two primitives:

- **`register(capabilities)`** — "I exist and can be hired."
- **`push(task)`** — "Execute this."

These two primitives are sufficient to express arbitrary recursive delegation networks: AI agents, human organizations, biological systems, or IoT fleets.

---

## <a id="philosophy" href="#title">Philosophy: Why Singularity? Why Pivot?</a>

### The False Singularity vs. The True Singularity

The AI industry chases a "singularity" of intelligence—AGI surpassing humanity. This is a **phenomenological singularity**: unverifiable, unpredictable.

s9y defines a **structural singularity**:

> When a pair of communication primitives (`register` / `push`) can describe everything from a 1B-parameter model to a 7-billion-person civilization, from a neuron to a car ECU, **descriptive complexity ceases to scale linearly with system size**.

This is the mathematical definition of a singularity: at a critical threshold, the governing equation undergoes a phase transition, unifying previously disparate phenomena.

| Domain                | Before s9y                       | After s9y           |
| --------------------- | -------------------------------- | ------------------- |
| AI Engineering        | OpenAI API / LangChain / AutoGen | `register` + `push` |
| Social Simulation     | NetLogo / MASON DSL              | `register` + `push` |
| IoT Control           | MQTT / CoAP / HTTP mix           | `register` + `push` |
| Distributed Computing | RPC / MQ / Serverless            | `register` + `push` |

**The true singularity is not "one model doing everything." It is "all systems finally speaking the same language."**

### Pivot: Give Me a Leverage Point

Archimedes said: *"Give me a place to stand, and I shall move the earth."*

A physical fulcrum requires three properties:
1. **Rigidity** — No deformation, or force is lost.
2. **Locatability** — You must know where it stands.
3. **Load-bearing capacity** — It must withstand the pressure.

The s9y pivot maps exactly:

| Physical Fulcrum | s9y Pivot                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| **Rigidity**     | Minimal completeness of two primitives—no more, no less. Protocol semantics never deform.                    |
| **Locatability** | Unique identity + capability declaration at `register`. You know where this pivot stands and what it can do. |
| **Load-bearing** | The `push` contract. You can press a task onto it, and it must respond.                                      |

> **Pivot** is the Minimal Employable Unit in an s9y system. It constitutes a leverage point because (1) it rigidly preserves protocol semantics, (2) it is locatable via capability registration, and (3) it can bear delegated tasks without exposing its internal implementation to the employer (recursive opacity).

### Recursive Leverage: Infinite Extension

Archimedes needed a **fixed** fulcrum. s9y allows **recursive fulcra**—every pivot can itself become a lever, hiring smaller pivots.

```
The Problem (Earth)
  │
  └─ Lever ──→ Brain Pivot (Fulcrum)
                 │
                 └─ Lever ──→ Code Pivot (Fulcrum)
                                │
                                └─ Lever ──→ Linter Pivot (Fulcrum)
```

**Every layer is a fulcrum. Every layer moves the next.**

This is not physical infinity. It is **exponential amplification through recursive delegation**:

- A 3B-parameter "brain" pivot coordinates ten 7B expert pivots.
- Each 7B pivot delegates to ten 1B tool pivots.
- Total intelligence coverage: 3B + 10×7B + 100×1B = **173B equivalent capacity**.
- Yet active parameters at any moment: **sum of the longest path only** (far less than 173B).

---

## <a id="features" href="#title">Features</a>

### Variable transport layer

- **Memory-level communication** — Function calls within the same process (zero-copy, zero latency)
- **HTTP** — RESTful delegation across containers or nodes
- **WebSocket** — Bidirectional streaming, progress push, long-lived sessions
- **Other** — Just need to be capable of transmitting

All modes share the **same two primitives**. The transport layer is swappable without touching business logic.

---

### What s9y Is Not

The power of a minimal protocol comes from **restraint**:

1. **No consensus guarantees** — Conflict arbitration is the brain's responsibility.
2. **No hard real-time synchronization** — Nanosecond sync requires an additional timing layer.
3. **No value judgments** — Ethics and legality belong to the organizational layer above.

These boundaries are not defects. They are **design choices** that allow s9y to generalize across scales.

---

## License

MIT License — see [LICENSE](LICENSE) for details.