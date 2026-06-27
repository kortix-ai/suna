# Visual Style and Contrast

## DOM Usage

Ignore any browser warnings about buttons being nested inside of other buttons—it is not a problem.

## Emoji

**Never use emoji.** Not for application UI, not for test/mock data. If you need something like a "reaction" in a social media/chat application, use the proper icon library instead because those can be styled with `--foreground` colors. Do not replace emojis with text—use a proper icon instead.

## Text Color

- **Never** use `text-primary` class for primary colored text unless it is over a hero image or some special branding case.
- Use three levels of text color to convey hierarchy:
  - **Default:** Used for most text
  - **Secondary:** Used for additional information
  - **Tertiary:** Used for the least important information

Text colors must always take into account the surface they're rendered on. Light text should never appear on a light background, and darker text should never appear on a dark background. Double or triple check this requirement.

## Hero Images

Landing pages often have large hero images. The challenge is maintaining readable text in both light and dark modes.

**Solution:** Create a dark "wash" gradient over the image so light text renders well regardless of the hero image color or the current theme mode.

- Always render lighter text over hero images (regardless of dark vs. light mode)
- You can use `variant="primary"` buttons or `variant="outline"` buttons with blurred backgrounds over the image
- This approach works with dark/light toggle features

## Drop Shadows

Use drop shadows sparingly and subtly. Valid use cases:

1. On elements/surfaces that have the same exact background color as the background they sit on
2. To convey a sense of "floating" (e.g., modals or toast notifications)

## Borders and Background Colors

### Border Radius

- Border radii should **always** be small unless creating a perfect circle or perfect "pill" shape (which require border radius to be exactly half the element height).
- If using Tailwind, use `rounded-md` class.

### Border Necessity

- If there's enough contrast between the background and an element, a border is not necessary.
- If you include a border when not necessary, it should be one perceivable shade darker than the darkest color it touches (light mode) or one shade lighter than the lightest color it touches (dark mode).

### Container Styling

Some elements act as "panes," "panels," or "containers" to group child elements. Four approaches:

| Method | Description                                                                       |
|--------|-----------------------------------------------------------------------------------|
| **A**  | White space and font size + headings to convey hierarchy                          |
| **B**  | Background color of the container                                                 |
| **C**  | Borders/shadows around the container with no background color (or same as parent) |
| **D**  | Background color and border around the container                                  |

Guidelines:

- Use the same approach consistently throughout the application, only deviating with good justification or user request.
- **Method B:** Container background should be very subtly "elevated" in contrast—just enough to distinguish a boundary, not enough to draw attention.
- **Method C:** Used when container background matches parent. Border or drop shadow should be very subtle.
- **Method D:** Border color should have barely perceivable contrast to the container background, and the container background should have barely perceivable contrast against its parent.

### Color Selection

- Avoid manually selected background colors like `bg-yellow-400` because these won't look correct in dark mode.
- Use semantic shadcn tokens when possible.
- If you *must* use literal colors, always include dark variants in the class list for all backgrounds, borders, and foregrounds.
- You can still rely on `hover-elevate` etc. to appropriately highlight manually selected colors.
