/** Bun loads a `.wasm` import as a file: the path, embedded in a compiled binary (codemode.ts). */
declare module '*.wasm' {
  const path: string
  export default path
}
