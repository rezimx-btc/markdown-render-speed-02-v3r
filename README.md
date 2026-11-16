# markdown-render-speed-02-v3r

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/rezimx-btc/markdown-render-speed-02-v3r/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/rezimx-btc/markdown-render-speed-02-v3r/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast CommonMark + GFM renderer written from scratch in plain Node.js
(no dependencies). It reads Markdown from stdin and writes HTML to stdout:

```sh
node --experimental-strip-types main.ts < input.md > output.html
```

`parse.js` holds the whole parser: a block parser (ATX/setext headings,
fenced and indented code, blockquotes, lists, tables, thematic breaks,
link reference definitions, HTML blocks) and an inline parser (emphasis,
links, images, code spans, autolinks, entities, inline HTML). Output
matches the reference renderer on the CommonMark and GFM practice sets.
