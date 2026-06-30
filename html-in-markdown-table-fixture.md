# HTML In Markdown Table Fixture

This file is a renderer test fixture for Markdown tables that contain plain text, Markdown syntax, and inline HTML. It is intended for tools such as Obsidian, VSCode Markdown Preview, and custom live table renderers.

Notes:

- Markdown table cells cannot safely contain unescaped pipe characters, so this fixture uses `&#124;` when a literal pipe is needed.
- Some applications sanitize HTML. Rows marked "sanitized" are expected to differ between renderers.
- Many Markdown engines only support inline HTML reliably inside table cells. Block elements are included where they commonly work but should be treated as compatibility tests.

| # | Category | Markdown / Text Input | HTML In Table Cell | Expected Behavior / Test Purpose |
|---:|---|---|---|---|
| 1 | Plain text | Regular words, numbers 12345, punctuation ! ? . , : ; | Plain text with entities: &amp; &lt; &gt; &quot; &#39; &#124; | Baseline text and entity decoding. |
| 2 | Emphasis | **bold**, *italic*, ***both***, ~~strike~~ | <strong>strong</strong>, <em>em</em>, <b>b</b>, <i>i</i>, <s>s</s>, <del>del</del>, <ins>ins</ins> | Compare Markdown emphasis with equivalent HTML tags. |
| 3 | Inline code | `const value = "table"` | <code>const value = &quot;html&quot;</code>, <kbd>Cmd</kbd> + <kbd>K</kbd>, <samp>sample output</samp>, <var>x</var> | Inline code-like tags and keyboard styling. |
| 4 | Line breaks | First line<br>Second line | Alpha<br>Beta<br/>Gamma<wbr>BreakOpportunity | Hard line breaks and word-break opportunity. |
| 5 | Links | [Example](https://example.com) | <a href="https://example.com">normal link</a>, <a href="https://example.com" title="Title text">title link</a>, <a href="#section-id">fragment link</a> | Anchor rendering, title attributes, and hash links. |
| 6 | Images | ![Placeholder](https://placehold.co/80x40?text=MD) | <img src="https://placehold.co/80x40?text=HTML" alt="HTML placeholder" width="80" height="40"> | Markdown image vs HTML image with sizing. Requires network for external image. |
| 7 | Inline SVG | Text before SVG | <svg width="80" height="32" viewBox="0 0 80 32" role="img" aria-label="Inline SVG"><rect width="80" height="32" rx="4" fill="#14532d"></rect><circle cx="18" cy="16" r="8" fill="#86efac"></circle><text x="34" y="21" font-size="14" fill="white">SVG</text></svg> | Inline SVG rendering and sanitizer behavior. |
| 8 | Colors | ==Highlight in Obsidian== | <span style="color:#b91c1c">red text</span>, <span style="background:#fef08a">highlight</span>, <mark>mark tag</mark> | Inline styles and semantic highlight tag. |
| 9 | Typography | H~2~O, x^2^ where supported | H<sub>2</sub>O, E = mc<sup>2</sup>, <small>small text</small>, <big>big text</big> | Subscript, superscript, and size tags. |
| 10 | Semantic phrase tags | Citation and definition text | <abbr title="HyperText Markup Language">HTML</abbr>, <cite>Example Citation</cite>, <dfn>definition</dfn>, <time datetime="2026-06-30">June 30, 2026</time> | Semantic inline elements and tooltips. |
| 11 | Bidirectional text | English العربية עברית | <bdi>العربية</bdi>, <bdo dir="rtl">left to right text reversed</bdo>, <span dir="rtl">مرحبا بالعالم</span> | Directionality support. |
| 12 | Quotes | "Quoted text" and 'single quotes' | <q cite="https://example.com">short quotation</q>, <blockquote>Block quote inside a cell</blockquote> | Inline quote and blockquote compatibility inside table cells. |
| 13 | Lists | - Markdown list text<br>- second item | <ul><li>unordered one</li><li>unordered two</li></ul><ol><li>ordered one</li><li>ordered two</li></ol> | Nested list rendering inside a table cell. |
| 14 | Task-like content | - [x] Done<br>- [ ] Todo | <input type="checkbox" checked disabled> checked <input type="checkbox" disabled> unchecked | Form controls and sanitizer behavior. |
| 15 | Buttons and inputs | Plain label: Save | <button type="button">Button</button> <input type="text" value="text input"> <input type="range" min="0" max="10" value="6"> | Interactive controls. Many Markdown viewers disable or sanitize them. |
| 16 | Select and textarea | Choice: A | <select><option>Alpha</option><option selected>Beta</option></select> <textarea rows="2" cols="16">textarea text</textarea> | Form element rendering and interaction. |
| 17 | Progress and meter | Progress 60 percent | <progress max="100" value="60">60%</progress> <meter min="0" max="100" low="30" high="80" optimum="90" value="72">72</meter> | Native progress and meter elements. |
| 18 | Details disclosure | Click to expand | <details><summary>More details</summary><p>Hidden detail text inside the table cell.</p></details> | Expandable disclosure inside a table. |
| 19 | Ruby annotation | Japanese ruby example | <ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp>字<rp>(</rp><rt>ji</rt><rp>)</rp></ruby> | Ruby text annotations. |
| 20 | Data tags | Product ABC | <data value="sku-123">SKU 123</data>, <time datetime="14:30">2:30 PM</time> | Machine-readable inline data. |
| 21 | Preformatted text | Indented text may collapse | <pre>line 1&#10;  line 2&#10;    line 3</pre> | Whitespace preservation in table cells. |
| 22 | Code block HTML | ```js const x = 1 ``` | <pre><code>function example() {&#10;  return &quot;table&quot;;&#10;}</code></pre> | HTML pre/code block rendering inside one table cell. |
| 23 | Math-like text | $a^2 + b^2 = c^2$ | <span>Math text: a<sup>2</sup> + b<sup>2</sup> = c<sup>2</sup></span> | Markdown math support varies; HTML fallback should render broadly. |
| 24 | Tables nested as HTML | Nested Markdown tables usually break | <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table> | Nested HTML table compatibility. |
| 25 | Figure | Image with caption | <figure><img src="https://placehold.co/96x48?text=Fig" alt="Figure image" width="96" height="48"><figcaption>Caption text</figcaption></figure> | Figure and figcaption inside table cells. |
| 26 | Audio | Audio placeholder text | <audio controls src=""></audio> | Native audio control rendering. Empty source should show a control but not play. |
| 27 | Video | Video placeholder text | <video controls width="120" height="68"></video> | Native video control rendering without media. |
| 28 | Iframe | Embedded frame may be blocked | <iframe srcdoc="&lt;p&gt;iframe srcdoc&lt;/p&gt;" width="140" height="60" title="srcdoc iframe"></iframe> | Iframe rendering and sanitizer/security behavior. |
| 29 | Canvas | Canvas fallback text | <canvas width="120" height="40">Canvas fallback text</canvas> | Canvas element support. It will be blank unless scripted. |
| 30 | MathML | MathML fallback varies | <math><mrow><mi>x</mi><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow></math> | MathML support across Markdown preview engines. |
| 31 | HTML comments | Comment should not display | Before <!-- hidden comment --> After | Hidden comments should not render visibly. |
| 32 | Escaped HTML | `&lt;strong&gt;not rendered&lt;/strong&gt;` | &lt;strong&gt;escaped strong&lt;/strong&gt; | Escaped tags should display as text. |
| 33 | Raw custom element | Web component-like tag | <custom-badge status="test">custom element text</custom-badge> | Unknown/custom elements may render inline or be stripped. |
| 34 | Attributes | Attribute-heavy span | <span id="section-id" class="fixture-class" title="Tooltip text" aria-label="Accessible label" data-test-id="html-table-fixture">hover me</span> | ID, class, title, ARIA, and data attributes. |
| 35 | Alignment attributes | Centered text target | <div align="center">center aligned via legacy attribute</div><p style="text-align:right">right aligned via style</p> | Legacy attributes and inline style support. |
| 36 | Dimensions | Sized inline block | <span style="display:inline-block;width:96px;height:24px;border:1px solid #555;text-align:center;line-height:24px">96 x 24</span> | Inline layout styles inside a table cell. |
| 37 | Whitespace entities | A&nbsp;&nbsp;B | Nonbreaking spaces: A&nbsp;&nbsp;&nbsp;B, thin&thinsp;space, em&emsp;space | HTML whitespace entities. |
| 38 | Unicode text | Emoji, accents, CJK: cafe, 中文, 😀 | <span lang="fr">cafe</span>, <span lang="zh">中文内容</span>, <span lang="ja">日本語</span> | Multilingual and Unicode rendering. |
| 39 | Horizontal rule | Markdown `---` cannot be used in-cell safely | Text before <hr> text after | Horizontal rule inside table cell. |
| 40 | Deleted and inserted | ~~old~~ new | <del datetime="2026-06-30">removed</del> <ins datetime="2026-06-30">added</ins> | Revision-related semantic elements. |
| 41 | Address/contact | Contact text | <address>Example Org<br>123 Example Street<br>example@example.com</address> | Address block rendering. |
| 42 | Direction plus style | RTL styled text | <p dir="rtl" style="border:1px solid #999;padding:4px">نص عربي بمحاذاة واتجاه من اليمين إلى اليسار</p> | Combined direction, border, and padding styles. |
| 43 | Data URI image | No external network image | <img alt="Inline data URI SVG" width="80" height="32" src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='80'%20height='32'%3E%3Crect%20width='80'%20height='32'%20fill='%230f766e'/%3E%3Ctext%20x='10'%20y='21'%20font-size='14'%20fill='white'%3EData%3C/text%3E%3C/svg%3E"> | Data URI rendering and sanitizer behavior. |
| 44 | Safe sanitized script text | Script should be treated carefully | <code>&lt;script&gt;alert(&quot;do not run&quot;)&lt;/script&gt;</code> | Dangerous script represented as visible code, not executable HTML. |
| 45 | Event handler sanitizer | Unsafe attributes may be removed | <span onclick="alert('blocked')">onclick attribute test</span> | Applications should strip or ignore event handlers. |
| 46 | Style sanitizer | Potentially restricted CSS | <span style="position:relative;display:inline-block;transform:rotate(-2deg);border:1px dashed #7c3aed;padding:2px">styled span</span> | Inline CSS policy and visual style compatibility. |
| 47 | Entities and decimals | Numeric entities | &#169; &#174; &#8482; &#8592; &#8593; &#8594; &#8595; &#9733; | Common named and numeric entities. |
| 48 | Long wrapping text | Supercalifragilisticexpialidocious repeated | <span>Long text should wrap without breaking the table layout: supercalifragilisticexpialidocious-supercalifragilisticexpialidocious-supercalifragilisticexpialidocious</span> | Layout stress test for long content. |
| 49 | Mixed Markdown and HTML | **Bold** plus <em>HTML em</em> | <strong>HTML strong</strong> plus `Markdown code` plus <code>HTML code</code> | Mixed Markdown/HTML parsing inside a single row. |
| 50 | Empty and null-like values | Empty cell follows:  |  | Empty HTML cell should remain a valid table cell. |

## Sanitizer Expectations

Use this checklist when comparing renderers:

| Feature Area | Usually Renders | Often Sanitized Or Blocked |
|---|---|---|
| Text and inline semantics | `strong`, `em`, `code`, `sub`, `sup`, `mark`, `abbr`, `time` | Event handlers, unknown attributes |
| Block elements in cells | `details`, `pre`, `blockquote`, `ul`, `ol` in many renderers | Nested tables, forms, iframes |
| Media | `img`, sometimes `svg` | `iframe`, `audio`, `video`, `canvas`, `data:` images |
| Styling | Basic inline `style` in permissive renderers | Positioning, transforms, scripts, unsafe URLs |
