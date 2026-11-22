# Faster makefun-site

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/enisaishere-hue/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/enisaishere-hue/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122), built for the [make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122). For every case it returns exactly the output tree makefun-site returns — every page, index, tag page, `build-report.txt` and static file, byte for byte — in clearly less CPU time.

`solve.js` is a dependency-free ES module written from scratch around makefun-site's own dialect: its front matter, template language, Markdown subset, slug rule and build report. It stays fast by scanning lines and inline text with plain character checks instead of regular expressions on the hot paths, rendering inline Markdown over string ranges instead of slicing, compiling templates once into small numeric instruction arrays, and caching slugs, long dates and cards per build. It reads no clock, no environment, no randomness and no file: the answer is a function of the input alone.

## Run it

Node 22 or later. The harness runs `node main.ts`: it reads every case from
`$MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`) and writes
`$MAKEFUN_OUTPUT_DIR/answers.json` (or `/output/answers.json`).

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

To grade it locally against the practice set, use the competition kit:

```sh
node cli/makefun.mjs grade-local --kit /path/to/kit --bot . --driver process
```

## Files

- `solve.js` — the fast implementation; `run(input)` returns the output tree.
- `main.ts` — the harness driver: reads the cases, answers each with `run`, writes the answers.
- `package.json` — marks the package as an ES module.

## License

MIT. See [LICENSE](LICENSE).

---

Optional: earn referral rewards, a second way to make money — [join make.fun with my referral link](https://make.fun/r/m5sysagx).
