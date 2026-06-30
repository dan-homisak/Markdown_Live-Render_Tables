---
title: Standard Markdown Fixture
tags:
  - markdown
  - fixture
  - renderer-test
created: 2026-06-30
---

# Standard Markdown Fixture

This file is a renderer test fixture for common Markdown, GitHub Flavored Markdown, and application-specific Markdown features commonly seen in Obsidian and VSCode.

It intentionally mixes simple cases with layout stress cases so a live renderer can be tested against ordinary notes, documentation, and edge-case content.

[TOC]

## Headings

# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

## Paragraphs And Line Breaks

This is a normal paragraph with plain text, numbers 12345, punctuation, and a long word: supercalifragilisticexpialidocious-supercalifragilisticexpialidocious-supercalifragilisticexpialidocious.

This paragraph has a hard line break after this line.  
This should appear on the next line in renderers that support two-space hard breaks.

This paragraph uses an explicit HTML line break.<br>
This should also appear on the next line.

## Emphasis

Plain text with **bold**, *italic*, ***bold italic***, __bold underscores__, _italic underscores_, and ~~strikethrough~~.

Mixed emphasis: **bold with `inline code` inside**, *italic with [a link](https://example.com) inside*, and ***bold italic with ~~strike~~ inside***.

Escaped formatting characters: \*not italic\*, \*\*not bold\*\*, \`not code\`, \[not a link\]\(https://example.com\).

## Inline Code

Use `npm run compile`, `const value = "markdown";`, `path/to/file.md`, and ``code with ` backtick`` in a sentence.

## Links

[External link](https://example.com)

[External link with title](https://example.com "Example title")

[Relative README link](./README.md)

[Heading fragment link](#headings)

Autolink: <https://example.com>

Email autolink: <test@example.com>

Reference-style link to [Example][example-ref].

[example-ref]: https://example.com "Reference title"

## Images

Markdown image using an external placeholder:

![Markdown placeholder image](https://placehold.co/160x80?text=Markdown)

Image as a link:

[![Clickable placeholder image](https://placehold.co/120x60?text=Click)](https://example.com)

Reference-style image:

![Reference image][image-ref]

[image-ref]: https://placehold.co/140x70?text=Reference "Reference image title"

## Blockquotes

> Single-level blockquote.
>
> Second paragraph inside the same blockquote.

> Nested quote level 1
>
> > Nested quote level 2
> >
> > > Nested quote level 3

> Blockquote with Markdown:
>
> - quoted bullet
> - quoted **bold text**
> - quoted `inline code`

## Horizontal Rules

Three hyphens:

---

Three asterisks:

***

Three underscores:

___

## Unordered Lists

- Top-level bullet A
- Top-level bullet B
  - Nested bullet B.1
  - Nested bullet B.2
    - Nested bullet B.2.a
    - Nested bullet B.2.b
      - Nested bullet B.2.b.i
- Top-level bullet C

Loose unordered list:

- Item with a paragraph.

  Continuation paragraph for the same item.

- Item with a nested blockquote.

  > Quote inside a list item.

- Item with a nested code block.

  ```txt
  code block inside a list item
  indentation should be preserved
  ```

Mixed marker styles:

* Asterisk bullet
+ Plus bullet
- Hyphen bullet

## Ordered Lists

1. First ordered item
2. Second ordered item
   1. Nested ordered item
   2. Another nested ordered item
      1. Third-level ordered item
3. Third ordered item

Auto-numbered source:

1. Rendered as one
1. Rendered as two
1. Rendered as three

Ordered list starting at five:

5. Five
6. Six
7. Seven

## Mixed Nested Lists

1. Install dependencies
   - Run `npm install`
   - Verify `package-lock.json`
2. Compile
   - Run `npm run compile`
   - Check `dist/`
3. Test
   1. Unit tests
   2. Smoke tests
   3. Manual preview tests

## Task Lists

- [x] Completed task
- [ ] Incomplete task
- [X] Uppercase completed task
- [ ] Parent task
  - [x] Nested completed task
  - [ ] Nested incomplete task

## Definition Lists

Markdown
: A lightweight markup language.

Renderer
: A tool that converts Markdown source into displayed content.

Fixture
: A sample file used to test behavior.

## Tables

Basic table:

| Name | Type | Notes |
|---|---|---|
| Alpha | Text | Simple text |
| Beta | Number | `12345` |
| Gamma | Markdown | **bold**, *italic*, `code` |

Alignment table:

| Left | Center | Right |
|:---|:---:|---:|
| alpha | beta | 100 |
| longer left value | centered value | 2000 |
| short | x | 3 |

Escaped pipe table:

| Expression | Meaning |
|---|---|
| `a &#124; b` | Literal pipe inside inline code using entity |
| `first &#124; second` | Entity-escaped pipe inside inline code |
| `A &amp; B` | Entity inside a table |

Multiline table content with HTML breaks:

| Item | Details |
|---|---|
| One | First line<br>Second line<br>Third line |
| Two | - Markdown-looking bullet text<br>- Second bullet-looking line |

Nested table using HTML:

| Outer Column | Nested HTML Table |
|---|---|
| Parent row | <table><thead><tr><th>Inner A</th><th>Inner B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table> |

## Code Blocks

Plain fenced code:

```
No language identifier.
Whitespace and line breaks should be preserved.
```

JavaScript:

```js
const rows = [
  { name: "Alpha", enabled: true },
  { name: "Beta", enabled: false },
];

for (const row of rows) {
  console.log(`${row.name}: ${row.enabled}`);
}
```

TypeScript:

```ts
type TableRow = {
  id: string;
  label: string;
  enabled: boolean;
};

function renderLabel(row: TableRow): string {
  return row.enabled ? row.label : `Disabled: ${row.label}`;
}
```

HTML:

```html
<table>
  <tr>
    <th>Name</th>
    <th>Status</th>
  </tr>
  <tr>
    <td>Alpha</td>
    <td>Ready</td>
  </tr>
</table>
```

CSS:

```css
.markdown-table {
  border-collapse: collapse;
  width: 100%;
}

.markdown-table th,
.markdown-table td {
  border: 1px solid #ccc;
  padding: 0.5rem;
}
```

JSON:

```json
{
  "name": "markdown-live-render-tables",
  "features": ["tables", "markdown", "html"],
  "enabled": true
}
```

Shell:

```sh
npm install
npm run compile
npm test
```

Python:

```python
rows = ["alpha", "beta", "gamma"]

for index, row in enumerate(rows, start=1):
    print(f"{index}: {row}")
```

Markdown source inside a code block:

```md
| Column A | Column B |
|---|---|
| `code` | **bold** |
```

Diff:

```diff
- old table renderer
+ live table renderer
```

Indented code block:

    This is an indented code block.
    Some renderers treat this differently from fenced code.

## Math

Inline math, when supported: $a^2 + b^2 = c^2$.

Block math, when supported:

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$

Fallback plain text math: a^2 + b^2 = c^2.

## Footnotes

This sentence has a footnote.[^simple]

This sentence has a longer footnote.[^long]

[^simple]: A short footnote.

[^long]: A longer footnote with multiple parts.

    Indented continuation text inside the same footnote.

## Obsidian-Style Wikilinks

Internal note link: [[Example Note]]

Internal note link with alias: [[Example Note|Example Alias]]

Embedded note: ![[Embedded Note]]

Embedded image-style resource: ![[diagram.png]]

Block reference: [[Example Note#Heading]]

Block ID reference: [[Example Note#^block-id]]

^block-id

## Obsidian-Style Callouts

> [!NOTE]
> This is a note callout.

> [!TIP]
> This is a tip callout with **Markdown** inside.

> [!WARNING]
> This is a warning callout.
>
> - Nested bullet
> - Another nested bullet

> [!INFO]- Collapsed callout title
> This body may be collapsed by default in Obsidian.

## HTML Blocks In Markdown

<details>
<summary>Expandable details block</summary>

This details block contains **Markdown-looking text**. Some renderers parse Markdown inside HTML blocks and some do not.

</details>

<table>
  <thead>
    <tr>
      <th>HTML Table A</th>
      <th>HTML Table B</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Cell 1</td>
      <td>Cell 2</td>
    </tr>
  </tbody>
</table>

## Escapes And Special Characters

Escaped punctuation:

\# not a heading

\- not a bullet

\1. not an ordered list

\> not a blockquote

Characters: & < > " ' ` ~ * _ [ ] ( ) { } . ! + - # |

Entities: &amp; &lt; &gt; &quot; &#39; &#124; &copy; &reg; &trade; &rarr;

## Unicode And Directionality

Accents: cafe, resume, naive, facade.

CJK: 中文内容, 日本語の文章, 한국어 문장.

RTL: العربية עברית.

Emoji: 😀 ✅ ⚠️ 📌

Mixed direction text: English العربية English עברית English.

## Raw URLs

https://example.com

http://localhost:3000/path?query=value#hash

www.example.com

## Comments

Visible text before the comment.

<!-- This comment should not render visibly. -->

Visible text after the comment.

## Renderer Stress Cases

Deep nesting:

- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5
          - Level 6

Long table row:

| Key | Value |
|---|---|
| Long | This is a very long cell intended to test wrapping behavior in table renderers. It includes **bold text**, `inline code`, a [link](https://example.com), and a long token: abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz. |

Adjacent blocks with no extra prose:

```txt
code block one
```

```txt
code block two immediately after code block one
```

> Quote immediately after code.

- List immediately after quote.
