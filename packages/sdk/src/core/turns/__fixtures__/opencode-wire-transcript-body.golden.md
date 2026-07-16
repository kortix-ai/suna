## User

Can you check why the login test is flaky and fix it?

---

## Build (glm-5.2 · 9.0s)

I'll start by reading the test.

**Tool: read**

<details>
<summary>Input</summary>

```json
{
  "filePath": "tests/login.test.ts"
}
```

</details>

<details>
<summary>Output</summary>

```
test('login', async () => { await sleep(10); expect(loggedIn).toBe(true); })
```

</details>

**Tool: bash**

<details>
<summary>Input</summary>

```json
{
  "command": "bun test tests/login.test.ts"
}
```

</details>

<details>
<summary>Output</summary>

```
FAIL login.test.ts
<bash_metadata>cwd=/repo</bash_metadata>
<exit_code>1</exit_code>
```

</details>

**Tool: web_search**

<details>
<summary>Input</summary>

```json
{
  "query": "flaky test race condition sleep"
}
```

</details>

<details>
<summary>Output</summary>

```
{"query":"flaky test race condition sleep","success":false,"error":"Insufficient credits"}
```

</details>

---

## Build (glm-5.2 · 4.0s)

Trying to rerun the test...

---

## Build (0.5s)

---

