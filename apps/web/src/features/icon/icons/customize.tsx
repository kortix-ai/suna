/** The Customize row's glyph, shared with the Customize sidebar modal. */
export function CustomizeGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15.37 9.73C15.9 10 16.6 10 18 10C19.4 10 20.1 10 20.64 9.73C21.11 9.49 21.49 9.11 21.73 8.63C22 8.1 22 7.4 22 6C22 4.6 22 3.9 21.73 3.37C21.49 2.89 21.11 2.51 20.64 2.27C20.1 2 19.4 2 18 2C16.6 2 15.9 2 15.37 2.27C14.89 2.51 14.51 2.89 14.27 3.37C14 3.9 14 4.6 14 6C14 7.4 14 8.1 14.27 8.63C14.51 9.11 14.89 9.49 15.37 9.73Z" />
      <path d="M10 14V10C10 8.6 10 7.9 9.73 7.37C9.49 6.89 9.11 6.51 8.63 6.27C8.1 6 7.4 6 6 6C4.6 6 3.9 6 3.37 6.27C2.89 6.51 2.51 6.89 2.27 7.37C2 7.9 2 8.6 2 10V14H10Z" />
      <path d="M10 14H2V17C2 19.36 2 20.54 2.73 21.27C3.46 22 4.64 22 7 22H10V14Z" />
      <path d="M14 14H10V22H14C15.4 22 16.1 22 16.64 21.73C17.11 21.49 17.49 21.11 17.73 20.64C18 20.1 18 19.4 18 18C18 16.6 18 15.9 17.73 15.37C17.49 14.89 17.11 14.51 16.64 14.27C16.1 14 15.4 14 14 14Z" />
    </svg>
  );
}
