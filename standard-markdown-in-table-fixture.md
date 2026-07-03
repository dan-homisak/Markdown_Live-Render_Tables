# Standard Markdown Inside Table Fixture

This file tests standard Markdown and common Markdown extensions when they appear inside Markdown table cells. It is intended as a fixture for Obsidian, VSCode Markdown Preview, and custom live table renderers.

Notes:

- Literal pipe characters inside cells use `&#124;` so the table remains parseable.
- Some Markdown features do not render inside table cells in every engine. Those rows are still useful compatibility tests.
- Multiline-looking content uses `<br>` because raw newlines inside Markdown table cells usually end the row.
- Block Markdown such as fenced code, blockquotes, callouts, and definition lists usually does not parse as block Markdown once placed inside a table row. This fixture uses HTML equivalents where a visibly rendered in-cell result is needed.

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
| 19 | Rendered nested unordered list | <ul><li>Top bullet A<ul><li>Nested bullet A.1<ul><li>Deep nested bullet A.1.a</li><li>Deep nested bullet A.1.b</li></ul></li><li>Nested bullet A.2</li></ul></li><li>Top bullet B</li></ul> | Reliable nested bullets inside a Markdown table cell using HTML list markup. |
| 20 | Rendered nested ordered list | <ol><li>First item<ol><li>Nested ordered item<ol><li>Deep ordered item</li></ol></li><li>Second nested ordered item</li></ol></li><li>Second top-level item</li></ol> | Reliable nested numbering inside a Markdown table cell using HTML list markup. |
| 21 | Rendered mixed nested list | <ol><li>Install<ul><li><code>npm install</code></li><li>Verify lockfile</li></ul></li><li>Compile<ul><li><code>npm run compile</code></li><li>Check output</li></ul></li></ol> | Mixed ordered and unordered nested lists that should visibly indent. |
| 22 | Rendered nested task list | <ul><li><input type="checkbox" checked disabled> Completed parent<ul><li><input type="checkbox" checked disabled> Nested complete</li><li><input type="checkbox" disabled> Nested incomplete</li></ul></li><li><input type="checkbox" disabled> Incomplete parent</li></ul> | Nested checklist-style content; checkbox rendering depends on sanitizer policy. |
| 23 | Rendered blockquote | <blockquote>Quote line<br>Continued quote<blockquote>Nested quote</blockquote></blockquote> | Reliable blockquote rendering inside a table cell using HTML. |
| 24 | Rendered horizontal rule | Before<hr>After | Reliable horizontal rule rendering inside a table cell using HTML. |
| 25 | Inline HTML break | Alpha<br>Beta<br/>Gamma | HTML line breaks as a reliable table-cell multiline fallback. |
| 26 | HTML details | <details><summary>Open details</summary>Hidden detail text with <strong>HTML emphasis</strong> content.</details> | Disclosure widget with explicit HTML formatting inside the table cell. |
| 27 | Basic inline HTML | <strong>strong</strong>, <em>em</em>, <code>code</code>, <mark>mark</mark> | Common inline HTML inside Markdown table cells. |
| 28 | Rendered definition list | <dl><dt>Markdown</dt><dd>A lightweight markup language.</dd><dt>Renderer</dt><dd>A tool that displays Markdown output.</dd></dl> | Reliable definition-list rendering inside a table cell using HTML. |
| 29 | Simple nested HTML table | <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table> | Nested table rendering inside a Markdown table cell. |
| 30 | Markdown table as escaped code | `&#124; A &#124; B &#124;`<br>`&#124;---&#124;---&#124;`<br>`&#124; 1 &#124; 2 &#124;` | Markdown table source shown inside a cell without breaking the outer table. |
| 31 | Code span with table syntax | `&#124; Column A &#124; Column B &#124;` | Literal pipe-heavy table text in inline code without breaking the outer table. |
| 32 | Code block, no language | <pre><code>No language identifier.&#10;Whitespace should be preserved.</code></pre> | Reliable preformatted code display. This does not imply syntax highlighting. |
| 33 | JavaScript highlighted code | <pre><code><span style="color:#7c3aed">const</span> rows = [{ name: <span style="color:#15803d">&quot;Alpha&quot;</span>, enabled: <span style="color:#b45309">true</span> }];&#10;<span style="color:#7c3aed">for</span> (<span style="color:#7c3aed">const</span> row <span style="color:#7c3aed">of</span> rows) {&#10;  console.log(row.name);&#10;}</code></pre> | Visible syntax-color smoke test using explicit inline spans, since fenced-code highlighters usually do not run inside table cells. |
| 34 | TypeScript highlighted code | <pre><code><span style="color:#7c3aed">type</span> Row = { id: <span style="color:#2563eb">string</span>; enabled: <span style="color:#2563eb">boolean</span> };&#10;<span style="color:#7c3aed">const</span> row: Row = { id: <span style="color:#15803d">&quot;a&quot;</span>, enabled: <span style="color:#b45309">true</span> };</code></pre> | Visible TypeScript-like highlighting using explicit inline spans. |
| 35 | HTML highlighted code | <pre><code><span style="color:#2563eb">&lt;table&gt;</span>&#10;  <span style="color:#2563eb">&lt;tr&gt;</span><span style="color:#2563eb">&lt;td&gt;</span>Cell<span style="color:#2563eb">&lt;/td&gt;</span><span style="color:#2563eb">&lt;/tr&gt;</span>&#10;<span style="color:#2563eb">&lt;/table&gt;</span></code></pre> | Visible escaped HTML source with explicit highlighting. |
| 36 | CSS highlighted code | <pre><code><span style="color:#2563eb">.table-cell</span> {&#10;  <span style="color:#b45309">padding</span>: 8px;&#10;  <span style="color:#b45309">border</span>: 1px solid #ccc;&#10;}</code></pre> | Visible CSS-like highlighting using explicit inline spans. |
| 37 | JSON highlighted code | <pre><code>{&#10;  <span style="color:#15803d">&quot;name&quot;</span>: <span style="color:#15803d">&quot;fixture&quot;</span>,&#10;  <span style="color:#15803d">&quot;enabled&quot;</span>: <span style="color:#b45309">true</span>&#10;}</code></pre> | Visible JSON-like highlighting using explicit inline spans. |
| 38 | Shell highlighted code | <pre><code><span style="color:#2563eb">npm</span> install&#10;<span style="color:#2563eb">npm</span> run compile&#10;<span style="color:#2563eb">npm</span> test</code></pre> | Visible shell-like highlighting using explicit inline spans. |
| 39 | Python highlighted code | <pre><code>rows = [<span style="color:#15803d">&quot;alpha&quot;</span>, <span style="color:#15803d">&quot;beta&quot;</span>]&#10;<span style="color:#7c3aed">for</span> row <span style="color:#7c3aed">in</span> rows:&#10;    print(row)</code></pre> | Visible Python-like highlighting using explicit inline spans. |
| 40 | Diff highlighted code | <pre><code><span style="color:#b91c1c">- old renderer</span>&#10;<span style="color:#15803d">+ live renderer</span></code></pre> | Visible diff-like highlighting using explicit inline spans. |
| 41 | Inline math | $a^2 + b^2 = c^2$ | Inline math support inside a table cell. |
| 42 | Block math text | $$<br>\int_0^1 x^2 dx = \frac{1}{3}<br>$$ | Block math syntax forced into one cell with breaks. |
| 43 | Footnote reference | Cell text with footnote.[^simple] | Footnote reference from inside a table cell. |
| 44 | Multiple footnotes | First note.[^simple] Second note.[^long] | Multiple references inside a table cell. |
| 45 | Obsidian wikilink | [[Example Note]] | Obsidian internal note link syntax. |
| 46 | Obsidian wikilink alias | [[Example Note&#124;Example Alias]] | Obsidian alias syntax with escaped pipe. |
| 47 | Obsidian embed | ![[Embedded Note]] and ![[diagram.png]] | Obsidian embed syntax. |
| 48 | Obsidian heading link | [[Example Note#Heading]] | Obsidian heading reference. |
| 49 | Obsidian block link | [[Example Note#^block-id]] | Obsidian block reference link. |
| 50 | Obsidian callout source text | <code>&gt; [!NOTE]&lt;br&gt;&gt; Callout body inside a table cell.</code> | Source-form compatibility case. Obsidian callout syntax usually does not become a callout inside a Markdown table cell. |
| 51 | Rendered callout-style box | <div style="border-left:4px solid #2563eb;padding:0.5rem;background:#eff6ff"><strong>Note</strong><br>Callout-style content rendered with HTML.</div> | Reliable in-cell callout-like rendering using HTML rather than Obsidian block syntax. |
| 52 | Raw URL | https://example.com | Raw URL auto-linking behavior. |
| 53 | Localhost URL | http://localhost:3000/path?query=value#hash | Local URL auto-linking behavior. |
| 54 | Unicode | Accents: cafe, resume, naive, facade.<br>CJK: 中文内容, 日本語の文章, 한국어 문장.<br>Emoji: 😀 ✅ ⚠️ 📌 | Unicode and emoji rendering. |
| 55 | RTL text | English العربية English עברית English | Bidirectional text rendering. |
| 56 | HTML comment | Before <!-- hidden comment --> After | Comment should not render visibly. |
| 57 | Raw special characters | Characters: &amp; &lt; &gt; " ' ` ~ * _ [ ] ( ) { } . ! + - # &#124; | Special character display without breaking the table. |
| 58 | Deep nesting stress | <ul><li>Level 1<ul><li>Level 2<ul><li>Level 3<ul><li>Level 4<ul><li>Level 5<ul><li>Level 6</li></ul></li></ul></li></ul></li></ul></li></ul></li></ul> | Deep nested list stress case that should visibly indent inside a table cell. |
| 59 | Long wrapping stress | This is a very long table cell with **bold text**, `inline code`, a [link](https://example.com), and a long token: abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz. | Wrapping behavior under dense inline Markdown. |
| 60 | Empty cell |  | Empty Markdown content cell should remain valid. |
text
[example-ref]: https://example.com "Reference title"
[image-ref]: https://placehold.co/100x50?text=Ref "Reference image title"

[^simple]: A short footnote used by the table fixture.

[^long]: A longer footnote with continuation text.

    Indented continuation text inside the same footnote.

^block-id
