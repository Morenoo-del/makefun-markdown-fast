# makefun-markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/morenoo-del/makefun-markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/morenoo-del/makefun-markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3: `parse(markdown)` returns exactly
the HTML marked returns with its default options (GFM on), byte for byte, for less CPU.

## How it works

- `main.ts` reads the cases from `/input/cases.json`, renders each with `parse()`, and
  writes `/output/html.json`.
- `parse.js` runs marked's own pipeline — block lexer, inline lexer, renderer — but
  scans on indexes into the source with sticky patterns instead of slicing the
  remainder, gates the expensive block rules behind cheap necessary-condition checks,
  dispatches inline tokenizers by first character, and replaces marked's regex
  emphasis pre-masking with small hand-written scans. Nothing is cached between
  `parse()` calls, so every call is deterministic.

## Run it

```sh
node main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=w6xj1ecj&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
