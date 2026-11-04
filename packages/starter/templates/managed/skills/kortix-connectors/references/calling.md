# Calling connectors: paging, attachments, GraphQL

## Paging

Page through everything only when the human needs every record. Write one
file per page and merge once at the end. Take the cursor field names from
the shape `--out` printed:

```sh
i=1; cursor=""
while :; do
  args=$([ -z "$cursor" ] && echo '{"first":250}' || echo "{\"first\":250,\"after\":\"$cursor\"}")
  kortix connectors call <slug> <list_action> "$args" --account "<label>" --out /tmp/page$i.json >/dev/null || break
  [ "$(jq -r '.data.result.page_info.hasNextPage' /tmp/page$i.json)" = true ] || break
  cursor=$(jq -r '.data.result.page_info.endCursor' /tmp/page$i.json); i=$((i+1))
done
jq -s '[.[].data.result.issues[]]' /tmp/page*.json > /tmp/all.json
```

`call` exits 1 on a denial or a `tool_error`, so `|| break` also stops the
loop on a failed page. Read that page's file before you retry.

## Attachments

Write the file under `/workspace/artifacts` (or `output`, `reports`,
`deliverables`), put the JSON args in a file, and pass `--attach`. The CLI
stages the raw bytes and the gateway builds the provider's attachment item
(Microsoft Graph, SendGrid, Postmark, Mailjet, Resend, Brevo, and the Email
channel):

```sh
cat > /tmp/mail.json <<'JSON'
{"user":"sender@example.com","body":{"message":{"subject":"Report",
 "body":{"contentType":"Text","content":"Attached."},
 "toRecipients":[{"emailAddress":{"address":"to@example.com"}}]},
 "saveToSentItems":true}}
JSON
kortix connectors call microsoft-graph sendmail @/tmp/mail.json \
  --attach /workspace/artifacts/report.pdf
```

Leave the attachments array out of the JSON: `--attach` appends to it. When
the CLI cannot find the field, pass `--attach-path <a.b.c>`, or run
`kortix connectors upload <file> --connector <slug>` and put the printed
`ref` (`{"$kortix_attachment":"<id>"}`) where the file belongs: in an
`attachments` array, or as the value of a base64 field such as
`contentBytes`. Pass the body as a JSON object, never as a string. Never put
base64 in args yourself.

## GraphQL field selection

Put the selected fields in `args.__select`:

```sh
kortix connectors call internal_graph query.user \
  '{"id":"1","__select":"id name email"}'
```

## Large results

Tool output above ~50 KB is truncated in your context. `--out <file>` writes
the whole result and prints only `saved_to`, `bytes` and `shape`. Query the
file with `jq` or `bun`, never `cat`.
