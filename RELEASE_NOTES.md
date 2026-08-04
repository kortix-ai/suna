Faster project pages, reliable sends, and Next.js 16

### Improved

- **Project pages open faster.** Moving between projects no longer re-reads the maintenance config or checks your sign-in a second time. Both ran on every page-to-page transition. The maintenance read is now cached with a 5-second window, and the duplicate auth round-trip is gone.
- **Next.js 16.2.** The web app moves from Next.js 15.5 to 16.2, with fumadocs 16 and Sentry 10.69.

### Fixed

- **Messages no longer vanish while they are being sent.** A prompt written while another was still in flight — or while a large file was still uploading — could be removed before the server ever received it. Sends are now matched by identity, so a message in flight is never mistaken for a duplicate. With an upload in front of the prompt, the message bubble appears immediately instead of only after the upload finishes.
- **Prompts send one at a time, in the order you wrote them.**
- **An upload that times out is no longer retried,** and its deadline now follows the body rather than the request.
- **Tool results say what actually happened.** A tool row drew its own icon regardless of what the call returned. Calls that fail or throw now render as failures.
- **File paths in messages are honest about what they can open.** An inline path used to be clickable because of its shape alone. Paths are now resolved against the running session: one that cannot be opened is no longer a button, relative paths open correctly, and paths are reachable by keyboard. Nothing is probed until you hover or focus it.
- **Code renders in one palette everywhere** — docs, the file viewer, and the diff viewer now match the rest of the app instead of using separate themes.
- **The code panels on the landing page can be scrolled with a keyboard.** They scrolled sideways for a mouse but could not be reached by keyboard at all.
