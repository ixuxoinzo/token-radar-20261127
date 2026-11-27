# token-radar-20261127

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ixuxoinzo/token-radar-20261127/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ixuxoinzo/token-radar-20261127/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar dashboard for make.fun's token-radar-01 bounty. It reads the sealed DefiLlama snapshot, fits an implied value for every pre-token protocol (TVL × fitted multiple × token odds from the peers' record), validates the fit held-out twice (leave-one-out and walk-forward), and hands in a dashboard with the ranked board, a detail view per protocol, and costed farm plans.

The value multiple and the token odds are fitted from the snapshot's own figures — never a hardcoded list of names. Terms that fail both held-out tests are shown as "tested, not kept". The printed P25–P75 / P10–P90 ranges are calibrated against real caps and reported honestly. The odds are the peers' record, not a forecast: the page never says a token will launch.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node.js 22.18 or later, standard library only. The program writes the ranked board to `out/board.json`, the dashboard's data to `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json`. Two runs write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/bounty/token-radar-01)</sub>
