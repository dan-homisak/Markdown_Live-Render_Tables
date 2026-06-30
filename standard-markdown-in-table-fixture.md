# Standard Markdown Inside Table Fixture

This file tests standard Markdown and common Markdown extensions when they appear inside Markdown table cells. It is intended as a fixture for Obsidian, VSCode Markdown Preview, and custom live table renderers.

Notes:

- Literal pipe characters inside cells use `&#124;` so the table remains parseable.
- Some Markdown features do not render inside table cells in every engine. Those rows are still useful compatibility tests.
- Multiline-looking content uses `<br>` because raw newlines inside Markdown table cells usually end the row.

| # | Feature | Markdown In Table Cell | Expected Renderer Behavior |
|---:|---|---|---|
| 1 | Plain text | Regular text with numbers 12345 and punctuation ! ? . , : ; | Baseline cell rendering. |
| 2 | Escaped characters | \*not italic\*, \*\*not bold\*\*, \`not code\`, \[not a link\]\(https://example.com\) | Escaped Markdown punctuation should remain visible. |
| 3 | Entities | &amp; &lt; &gt; &quot; &#39; &#124; &copy; &reg; &trade; &rarr; | HTML entities should decode or display consistently. |
| 4 | Emphasis | **bold**, *italic*, ***bold italic***, __bold underscores__, _italic underscores_, ~~strikethrough~~ | Inline emphasis and GFM strikethrough. |
| 5 | Nested emphasis | **bold with `inline code`**, *italic with [a link](https://example.com)*, ***bold italic with ~~strike~~*** | Nested inline Markdown parsing. |
| 6 | Inline code | `npm run compile`, `const value = "markdown";`, ``code with ` backtick`` | Inline code, quotes, and embedded backtick handling. |
| 7 | External link | [Example](https://example.com) | Standard inline link. |
| 8 | Link with title | [Example with title](https://example.com "Example title") | Title attribute support. |
| 9 | Relative link | [README](./README.md) | Relative file link behavior. |
| 10 | Fragment link | [Headings](#headings) | Same-document fragment behavior. |
| 11 | Autolink URL | <https://example.com> | Autolink rendering inside a cell. |
| 12 | Autolink email | <test@example.com> | Email autolink rendering. |
| 13 | Reference link | [Example][example-ref] | Reference links inside tables. Definition is below the table. |
| 14 | Image | ![Markdown placeholder](https://placehold.co/100x50?text=MD) | Markdown image rendering inside a cell. Requires network for external image. |
| 15 | Linked image | [![Clickable image](https://placehold.co/100x50?text=Click)](https://example.com) | Image wrapped in a link. |
| 16 | Reference image | ![Reference image][image-ref] | Reference-style image inside a cell. |
| 17 | Hard line break | First line<br>Second line<br>Third line | Line breaks inside one table cell. |
| 18 | Paragraph-like content | First paragraph text.<br><br>Second paragraph text. | Paragraph spacing simulated inside a table cell. |
| 19 | Unordered list | - Top bullet<br>  - Nested bullet<br>    - Deep nested bullet<br>- Second top bullet | List-like Markdown text inside a table cell. Some engines render it as text unless HTML is used. |
| 20 | Ordered list | 1. First item<br>2. Second item<br>   1. Nested ordered item<br>3. Third item | Ordered list syntax inside a cell. Renderer support varies. |
| 21 | Mixed nested list | 1. Install<br>   - `npm install`<br>   - Verify lockfile<br>2. Compile<br>   - `npm run compile` | Mixed ordered and unordered list syntax inside one cell. |
| 22 | Task list | - [x] Completed<br>- [ ] Incomplete<br>  - [x] Nested complete<br>  - [ ] Nested incomplete | GFM task list parsing inside a table cell. |
| 23 | Blockquote | > Quote line<br>> Continued quote<br>>> Nested quote | Blockquote syntax inside a table cell. Renderer support varies. |
| 24 | Horizontal rule text | Before<br>---<br>After | Tests whether thematic break syntax is parsed inside cells or treated as text. |
| 25 | Inline HTML break | Alpha<br>Beta<br/>Gamma | HTML line breaks as a reliable table-cell multiline fallback. |
| 26 | HTML details | <details><summary>Open details</summary>Hidden detail text with **Markdown-looking** content.</details> | Disclosure widget and Markdown parsing inside HTML. |
| 27 | Basic inline HTML | <strong>strong</strong>, <em>em</em>, <code>code</code>, <mark>mark</mark> | Common inline HTML inside Markdown table cells. |
| 28 | Definition-list syntax | Term<br>: Definition text<br><br>Second term<br>: Second definition | Definition list compatibility inside a table cell. |
| 29 | Simple nested HTML table | <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table> | Nested table rendering inside a Markdown table cell. |
| 30 | Markdown table as escaped code | `&#124; A &#124; B &#124;`<br>`&#124;---&#124;---&#124;`<br>`&#124; 1 &#124; 2 &#124;` | Markdown table source shown inside a cell without breaking the outer table. |
| 31 | Code span with table syntax | `&#124; Column A &#124; Column B &#124;` | Literal pipe-heavy table text in inline code without breaking the outer table. |
| 32 | Code block, no language | <pre><code>No language identifier.&#10;Whitespace should be preserved.</code></pre> | Preformatted code as the table-safe fallback for fenced code. |
| 33 | JavaScript code block | <pre><code class="language-js">const rows = [{ name: &quot;Alpha&quot;, enabled: true }];&#10;for (const row of rows) {&#10;  console.log(row.name);&#10;}</code></pre> | Syntax highlighter may detect `language-js` class. |
| 34 | TypeScript code block | <pre><code class="language-ts">type Row = { id: string; enabled: boolean };&#10;const row: Row = { id: &quot;a&quot;, enabled: true };</code></pre> | TypeScript highlighting compatibility. |
| 35 | HTML code block | <pre><code class="language-html">&lt;table&gt;&#10;  &lt;tr&gt;&lt;td&gt;Cell&lt;/td&gt;&lt;/tr&gt;&#10;&lt;/table&gt;</code></pre> | Escaped HTML source highlighting. |
| 36 | CSS code block | <pre><code class="language-css">.table-cell {&#10;  padding: 8px;&#10;  border: 1px solid #ccc;&#10;}</code></pre> | CSS highlighting compatibility. |
| 37 | JSON code block | <pre><code class="language-json">{&#10;  &quot;name&quot;: &quot;fixture&quot;,&#10;  &quot;enabled&quot;: true&#10;}</code></pre> | JSON highlighting compatibility. |
| 38 | Shell code block | <pre><code class="language-sh">npm install&#10;npm run compile&#10;npm test</code></pre> | Shell highlighting compatibility. |
| 39 | Python code block | <pre><code class="language-python">rows = [&quot;alpha&quot;, &quot;beta&quot;]&#10;for row in rows:&#10;    print(row)</code></pre> | Python highlighting compatibility. |
| 40 | Diff code block | <pre><code class="language-diff">- old renderer&#10;+ live renderer</code></pre> | Diff highlighting compatibility. |
| 41 | Inline math | $a^2 + b^2 = c^2$ | Inline math support inside a table cell. |
| 42 | Block math text | $$<br>\int_0^1 x^2 dx = \frac{1}{3}<br>$$ | Block math syntax forced into one cell with breaks. |
| 43 | Footnote reference | Cell text with footnote.[^simple] | Footnote reference from inside a table cell. |
| 44 | Multiple footnotes | First note.[^simple] Second note.[^long] | Multiple references inside a table cell. |
| 45 | Obsidian wikilink | [[Example Note]] | Obsidian internal note link syntax. |
| 46 | Obsidian wikilink alias | [[Example Note&#124;Example Alias]] | Obsidian alias syntax with escaped pipe. |
| 47 | Obsidian embed | ![[Embedded Note]] and ![[diagram.png]] | Obsidian embed syntax. |
| 48 | Obsidian heading link | [[Example Note#Heading]] | Obsidian heading reference. |
| 49 | Obsidian block link | [[Example Note#^block-id]] | Obsidian block reference link. |
| 50 | Obsidian callout text | > [!NOTE]<br>> Callout body inside a table cell. | Callout syntax inside a Markdown table cell. |
| 51 | Collapsed callout text | > [!INFO]- Collapsed title<br>> Collapsed body text. | Collapsible callout syntax inside a table cell. |
| 52 | Raw URL | https://example.com | Raw URL auto-linking behavior. |
| 53 | Localhost URL | http://localhost:3000/path?query=value#hash | Local URL auto-linking behavior. |
| 54 | Unicode | Accents: cafe, resume, naive, facade.<br>CJK: 中文内容, 日本語の文章, 한국어 문장.<br>Emoji: 😀 ✅ ⚠️ 📌 | Unicode and emoji rendering. |
| 55 | RTL text | English العربية English עברית English | Bidirectional text rendering. |
| 56 | HTML comment | Before <!-- hidden comment --> After | Comment should not render visibly. |
| 57 | Raw special characters | Characters: &amp; &lt; &gt; " ' ` ~ * _ [ ] ( ) { } . ! + - # &#124; | Special character display without breaking the table. |
| 58 | Deep nesting stress | - Level 1<br>  - Level 2<br>    - Level 3<br>      - Level 4<br>        - Level 5<br>          - Level 6 | Deep nested list stress case inside a table cell. |
| 59 | Long wrapping stress | This is a very long table cell with **bold text**, `inline code`, a [link](https://example.com), and a long token: abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz. | Wrapping behavior under dense inline Markdown. |
| 60 | Empty cell |  | Empty Markdown content cell should remain valid. |

[example-ref]: https://example.com "Reference title"
[image-ref]: https://placehold.co/100x50?text=Ref "Reference image title"

[^simple]: A short footnote used by the table fixture.

[^long]: A longer footnote with continuation text.

    Indented continuation text inside the same footnote.

^block-id
