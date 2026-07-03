# Column Sizing Algorithm Fixture

Use this file in the Markdown Live Editor to inspect the automatic table width behavior. Resize the editor or open the sidebar to see the constrained-width allocator redistribute space.

## 1. Compact Tables Stay Compact

This table should not expand to the full editor width. The `#` column should have enough breathing room for two-digit values.

| # | Status | Owner |
| ---: | --- | --- |
| 1 | OK | DH |
| 2 | OK | ML |
| 9 | Hold | QA |
| 10 | OK | UX |
| 11 | Review | API |
| 12 | Done | UI |

## 2. Narrow Columns Should Not Steal Width

The `#` and `Feature` columns should stay readable but narrow. The long markdown-content column should receive most of the usable table width.

| # | Feature | Markdown In Table Cell |
| ---: | --- | --- |
| 1 | Plain text | Regular text with numbers 12345 and punctuation should stay mostly on the wide content column. |
| 2 | Escaped characters | \*not italic\*, \*\*not bold\*\*, \`not code\`, and escaped link syntax \[Example\]\(https://example.com\). |
| 3 | Entities | &amp; &lt; &gt; &quot; &#39; &#124; &copy; &reg; should remain readable without forcing the small columns wider. |
| 4 | Emphasis | **bold**, *italic*, ***bold italic***, __underscores__, and ~~strikethrough~~ all live in the long column. |
| 5 | Nested emphasis | **bold with `inline code`**, *italic with [a link](https://example.com)*, and ***bold italic with ~~strike~~***. |
| 6 | Inline code | `npm run compile`, `const value = "markdown table sizing";`, and `measureTableColumnSizing(table, width)`. |
| 7 | Link with title | [Example with title](https://example.com "Example title") plus surrounding text to make wrapping visible. |
| 8 | Hard line break | First line<br>Second line<br>Third line |
| 9 | Paragraph-like content | First paragraph text.<br><br>Second paragraph text with enough words to show wrapping in one column. |
| 10 | Rendered nested list | <ul><li>Top bullet A<ul><li>Nested bullet A.1</li><li>Nested bullet A.2</li></ul></li><li>Top bullet B</li></ul> |
| 11 | Reference image | ![Reference image][image-ref] |
| 12 | Autolink URL | <https://example.com/very/long/path/that/should/wrap/inside/the/content/column> |

## 3. Give-And-Take Between Two Long Columns

When the editor is constrained, both long columns compete for width. The allocator should give each extra `0.5ch` step to the column where it reduces wrapping most. If one column can get slightly narrower without adding a line, the other column should get the width if it can drop a wrapped line.

| ID | Column A: tolerant paragraph | Column B: line-count sensitive paragraph |
| --- | --- | --- |
| A | Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. This column has several short words and usually tolerates a small width reduction without changing its visible line count. | A carefully tuned sentence with medium tokens should benefit when it receives just a little more width from the allocator and can drop one wrapped line in constrained layouts. |
| B | Planning notes include status, owner, dependency, rollout window, and fallback steps. The text is intentionally long but mostly flexible. | Regression validation requires compile, install, screenshot review, and table navigation checks, so gaining width here should reduce visual wrapping sooner. |
| C | Customer summary text stays readable even when it gives up a small amount of width because the words are short and evenly spaced. | Markdown table cells with inline code, link syntax, and punctuation often need extra width to avoid a costly additional wrapped row. |

## 4. Long Token Guardrail

The long token should not force the whole table past the editor width. It may wrap inside its own column.

| # | Label | Value |
| ---: | --- | --- |
| 1 | Long token | abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz |
| 2 | URL-like token | https://example.com/path/to/a/really-long-resource-name-that-still-needs-to-wrap |

[image-ref]: https://placehold.co/120x40
