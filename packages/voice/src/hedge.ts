// A request sent again after `after` ms without an answer: the first good answer wins and the other is aborted (Dean &
// Barroso, "The Tail at Scale": large tail cuts for a few percent more requests). `outer` aborts both. With `retry`
// false, a failure before the second request went out is the answer (a hedge against slowness, not errors). With
// `cancel` false the losing request runs to its end, unread (a caller that inspects every response sees no abort).
export function hedged(run: (signal: AbortSignal) => Promise<Response>, after: number, outer?: AbortSignal, retry = true, cancel = true): Promise<Response> {
  const tries: AbortController[] = [] // one each: the winner's body is still to be read
  return new Promise((resolve, reject) => {
    let left = 2, won = false
    const go = () => {
      if (outer?.aborted) return
      const ac = new AbortController()
      outer?.addEventListener('abort', () => ac.abort(), { once: true })
      tries.push(ac)
      run(ac.signal).then(
        (r) => {
          if (won || (!r.ok && (retry || tries.length > 1) && --left)) return
          won = true
          clearTimeout(timer)
          if (cancel) for (const t of tries) if (t !== ac) t.abort()
          resolve(r)
        },
        (e) => won || ((retry || tries.length > 1) && --left) || (clearTimeout(timer), reject(e)),
      )
    }
    const timer = setTimeout(go, after)
    go()
  })
}
