# andreisuslov.com

Source for my personal site — a static, single-page portfolio.

## Structure

- `index.html` — page shell and markup
- `data.js` — all site content (hero, about, projects, experience, contact) in one object
- `script.js` — renders the content into the DOM and handles scroll/hover effects
- `style.css` — styles and responsive layout
- `face-serious.webp` / `face-happy.webp` — hero portrait; the grinning face swaps in on hover

To change copy or add a project, edit `data.js`. No build step.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
