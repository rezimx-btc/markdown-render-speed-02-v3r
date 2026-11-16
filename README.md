# markdown-render-speed-02-v3r

[![make.fun](https://make.fun/api/competitions/markdown-render-speed-02/badge)](https://make.fun/competitions/markdown-render-speed-02)
[![rank](https://make.fun/api/competitions/markdown-render-speed-02/rank/rezimx-btc/markdown-render-speed-02-v3r)](https://make.fun/competitions/markdown-render-speed-02)
[![reward](https://make.fun/api/competitions/markdown-render-speed-02/reward/rezimx-btc/markdown-render-speed-02-v3r)](https://make.fun/competitions/markdown-render-speed-02)

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
