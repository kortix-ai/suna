export const MARKDOWN_REFERENCE = String.raw`# 🏆 The Ultimate Markdown Reference

---

## 1. Headings

# H1
## H2
### H3
#### H4
##### H5
###### H6

---

## 2. Text Styling

*Italic*  
**Bold**  
***Bold Italic***  
~~Strikethrough~~  
\`Inline code\`  
<u>Underline via HTML</u>  
<mark>Highlight via HTML</mark>  
<sup>Superscript</sup>  
<sub>Subscript</sub>  
<span style="color:red">Colored text via HTML</span>

---

## 3. Links

[GitHub](https://github.com)  
[Link with title](https://github.com "Go to GitHub")  
<https://autolink.com>  
\`mailto:user@example.com\`

---

## 4. Images

![Alt text](https://via.placeholder.com/150)

![With title](https://via.placeholder.com/150 "Placeholder")

<img src="https://via.placeholder.com/150" alt="HTML image" width="100" height="100">

[![Clickable image](https://via.placeholder.com/150)](https://example.com)

---

## 5. Unordered Lists (UL)

- Item one
- Item two
  - Nested item A
  - Nested item B
    - Deeply nested
- Item three
* Star bullets work too
+ Plus bullets also work

---

## 6. Ordered Lists (OL)

1. First item
2. Second item
   1. Sub-item 2.1
   2. Sub-item 2.2
3. Third item
    - Mixed: unordered under ordered
4. Fourth item

---

## 7. Mixed Nested Lists

- Category A
  1. Step one
  2. Step two
     - Detail A
     - Detail B
- Category B
  1. Do this
  2. Do that
     - Sub-task
       - Sub-sub-task

---

## 8. Code Blocks

### Inline: \`const x = 42\`

### Fenced (triple backtick):

\`\`\`python
def hello(name: str) -> str:
    """Greet someone."""
    print(f"Hello, {name}!")
    return name
\`\`\`

\`\`\`javascript
// JavaScript with syntax highlighting
const greet = (name) => {
    console.log(\`Hello, \${name}!\`);
    return true;
};
\`\`\`

\`\`\`html
<div class="container">
  <h1>Hello World</h1>
</div>
\`\`\`

\`\`\`css
.container {
  display: flex;
  justify-content: center;
  background: #f0f0f0;
}
\`\`\`

\`\`\`json
{
  "name": "Markdown",
  "version": 1.0,
  "features": ["rich", "extensible"]
}
\`\`\`

\`\`\`sql
SELECT u.name, COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.name
HAVING COUNT(o.id) > 5;
\`\`\`

\`\`\`bash
#!/bin/bash
for file in *.md; do
  echo "Processing $file"
done
\`\`\`

### Indented code block (4 spaces):

    this is a code block
    no syntax highlighting
    but works everywhere

---

## 9. Blockquotes

> This is a blockquote.
>
> > Nested blockquote.
>
> - Lists inside blockquotes
> - Second item

> **Note:** You can use *formatting* inside blockquotes too.

---

## 10. Horizontal Rules

---

***

___

---

## 11. Tables

| Left-aligned | Center-aligned | Right-aligned |
| :----------- | :------------: | ------------: |
| Apple        |    Banana      |          $1.99 |
| Orange       |   Grapefruit   |          $2.49 |
| Pear         |    Mango       |          $3.99 |

| Name | Age | City |
|------|:---:|:-----|
| Alice | 30 | NYC |
| Bob | 25 | LA |
| Carol | 35 | Chicago |

---

## 12. LaTeX / Math (KaTeX)

### Inline math: $E = mc^2$

### Display math:

$$
\int_{a}^{b} f(x) \, dx = F(b) - F(a)
$$

### More LaTeX:

$$
\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

$$
\oint_C \mathbf{E} \cdot d\mathbf{l} = -\frac{d}{dt} \iint_S \mathbf{B} \cdot d\mathbf{A}
$$

$$
\begin{pmatrix}
a & b \\
c & d
\end{pmatrix}
\begin{bmatrix}
1 & 0 \\
0 & 1
\end{bmatrix}
$$

$$
f(x) = 
\begin{cases} 
x^2 & \text{if } x > 0 \\
0 & \text{if } x = 0 \\
-x^2 & \text{if } x < 0
\end{cases}
$$

$$
\lim_{h \to 0} \frac{f(x+h) - f(x)}{h}
$$

$$
\vec{F} = m\vec{a}
$$

$$
\nabla \times \mathbf{B} = \mu_0 \left( \mathbf{J} + \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t} \right)
$$

$$
\Psi(x,t) = A e^{i(kx - \omega t)}
$$

$$
\binom{n}{k} = \frac{n!}{k!(n-k)!}
$$

---

## 13. HTML in Markdown

<div align="center">
  <h3>Centered with HTML</h3>
  <p style="color: #6366f1; font-size: 18px;">
    Styled paragraph inside a div
  </p>
  <details>
    <summary>Click to expand</summary>
    <p>Hidden content revealed! Markdown <strong>still works</strong> inside HTML blocks.</p>
    <ul>
      <li>Item 1</li>
      <li>Item 2</li>
    </ul>
  </details>
</div>

<br>

<table border="1" cellpadding="10">
  <tr>
    <th>HTML Table</th>
    <th>Column B</th>
  </tr>
  <tr>
    <td>Row 1</td>
    <td>Data</td>
  </tr>
</table>

<input type="checkbox" checked> Checked  
<input type="checkbox"> Unchecked

<kbd>Ctrl</kbd> + <kbd>C</kbd>

---

## 14. Task Lists

- [x] Buy groceries
- [x] Write markdown reference
- [ ] Learn LaTeX
- [ ] Deploy to production
  - [x] Set up CI/CD
  - [ ] Add monitoring

---

## 15. Definition Lists

Term
: Definition for the term.

Markdown
: A lightweight markup language with plain-text formatting syntax.
: Also supports multiple definitions.

---

## 16. Footnotes

Here is a sentence with a footnote[^1].

[^1]: This is the footnote content.

Another reference[^2].

[^2]: Footnotes work for citations too.  
    They can span multiple lines.

---

## 17. Emoji & Symbols

:smile: :rocket: :fire: :100: :+1: :shipit:

© ® ™ ∞ ½ √ ∆ ∑ π † ‡

---

## 18. Escaping

\*not italic\*  
\`not code\`  
\[not a link\]  
\# not a heading  
\\ backslash

---

## 19. Abbreviations

The HTML specification is maintained by the W3C.

*[W3C]: World Wide Web Consortium

---

## 20. Combined Mega Example

# Finale: Everything at Once

> ## Nested section
> 
> 1. First
> 2. Second
>   
>    \`\`\`rust
>    fn main() {
>        println!("Hello!");
>    }
>    \`\`\`
>   
>   - Mixed content
>   - $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

| Feature | Support |
|:--------|:-------:|
| LaTeX   | ✅ |
| Code    | ✅ |
| Tables  | ✅ |
| HTML    | ✅ |

---

## That's the full spectrum of Markdown 📋

**LaTeX recap** (the part you care about):

| Type | Syntax |
|------|--------|
| **Inline** | \`$E = mc^2$\` → $E = mc^2$ |
| **Display** | \`$$...$$\` or \`\[\]\` |
| **Fractions** | \`\frac{a}{b}\` → $\\frac{a}{b}$ |
| **Integrals** | \`\int_{a}^{b} f(x) dx\` → $\\int_{a}^{b} f(x) dx$ |
| **Summations** | \`\sum_{n=1}^{\infty}\` → $\sum_{n=1}^{\infty}$ |
| **Matrices** | \`\begin{pmatrix} a & b \\ c & d \end{pmatrix}\` |
| **Piecewise** | \`\begin{cases} ... \end{cases}\` |
| **Greek** | \`\alpha \beta \gamma \pi \sigma \omega \Delta \Omega\` |
| **Arrows** | \`\to \rightarrow \leftarrow \Rightarrow \implies\` |
| **Operators** | \`\times \div \pm \sqrt \partial \nabla \infty\` |
| **Accents** | \`\hat{x} \bar{x} \tilde{x} \vec{x}\` |
| **Sets** | \`\in \notin \subset \subseteq \cup \cap \forall \exists\` |
| **Delimiters** | \`\left( \right) \bigl[ \bigr] \lvert \rVert\` |
`;



// export const MARKDOWN_REFERENCE = String.raw`Done. Researched Marko and built a live one-pager.

// **What I found** (sourced from his own site markokraemer.com + LinkedIn/X): 21yo from Frankfurt, CEO & founder of **Kortix** (open-source OS for AGI, ~19.8k★, raised $4M). Earlier: BluePage/GastroPage as a kid, co-founded **Plutus** + **Golixxo** at 14, built **SoftGen** at 19 ($50K MRR, acquired for 7 figures). Based in Belgrade & San Francisco.

// **The site** — a dark, terminal-flavored single page with whoami story section
// - Stats cards ($4M raised, 7-figure exit, GitHub stars)
// - An age-based timeline (8 → now)
// - Scroll-reveal animations and ambient glow

// It's live in the preview above. Files are in \`/workspace/markokraemer-site/\`. Want me to tweak the design (lighter theme, different layout), add more sections, or **ship it as \`[[apps]]\` site** on the project?
// `;
